# Field report: Sutradhar on AI Audit Copilot

Date: 2026-10-07. Branch: `sutradhar-integration` (created from `main` today; see "Process notes").
Sutradhar: `~/Desktop/sutradhar` at commit `b86ef929a0a38b657e21c7a212ef13b05109aed3` (2026-10-05, "Backflow: ten Thread-M items..."). HEAD carries no tag; the CI/pre-commit pins use `v0.6.1`, which exists as a tag in that clone. Read-only use; nothing in it was modified.

## What was changed

Issues 1, 2 and 5 from the manual review of `apps/api/app/main.py` were each confirmed by reading the code, then fixed:

1. Blank or scanned PDF: `extract_text()` gave `""`, which was sent to Groq as an empty document and came back as a normal-looking review. Now no model call is made; a review with `completeness_label: "insufficient"` is stored (provider `none`, finish_reason `skipped_no_text`) and "AI analysis skipped" is logged.
2. Silent cut at 20,000 characters: the model could call a partly-read file "complete". Now `apply_coverage_check` caps it at "partial" and adds a missing-sections note. `chars_total`, `chars_reviewed` and `truncated` are stored in `raw_response`.
5. `pytest` could not collect without real secrets, because `app.main` calls `sys.exit(1)` at import. `tests/conftest.py` now sets placeholder env vars with `os.environ.setdefault`.

Logic lives in a pure module, `apps/api/app/review_text.py`. `main.py` wiring follows the existing `apply_placeholder_check` pattern. The refactor extracts `extract_pdf_text()` and `request_groq_review()` with no intended behavior change.

Reported only, not fixed:
- Issue 3: confirmed. Storage upload and the "Evidence uploaded" commit happen before extraction (500) and the Groq call (502). On failure the request status is never advanced and a retry creates a second `evidence_files` row.
- Issue 4: confirmed. `completeness_label` / `confidence_label` from the model are not validated. A related gap found while reading: if the model returns valid JSON that is not an object (e.g. a list), `parsed.get(...)` would raise. I did not test that.

## What I ran

- Tests, with an empty environment (`env -i`, no `.env` present), Python 3.11.4 in a throwaway venv built from `requirements.txt`: 22 passed (`tests/test_smoke.py`, `test_review_text.py` with 16 unit tests, `test_upload_review.py` with 3 end-to-end tests).
- The end-to-end tests call `POST /evidence-requests/{id}/upload` through `TestClient` with Postgres, Supabase Storage and Groq replaced by fakes. The "30k characters" PDF is built in the test. They do not exercise a real database, real storage or the real model.
- Guards, on all of `apps/api` (8 files) and then through `action/run_guards.py` with the same env the Action would use, on `apps/api/app` (3 files): `swallow_lint`, `interpolation_lint` (with and without `--keywords sql`), `conflated_degrade_lint`, `ci_step_lint` on the new workflow. All exit 0, no baselines needed.
- verify_guard.py on commit 2 (`1c57785`, the fix): **VERIFIED**. It reverted `apps/api/app/main.py` and `apps/api/app/review_text.py`, kept both test files, and the named tests `test_blank_pdf_never_calls_the_model` and `test_pdf_over_20k_chars_cannot_come_back_complete` went red by assertion (exit 1), green with the fix. My first attempt was **INCONCLUSIVE**: with the fix reverted, `test_review_text.py` fails to import `apply_coverage_check`, pytest aborts the session on that collection error (exit 2), and no failing test is named. I re-ran with `--continue-on-collection-errors -rf` added to the guard command; that is the VERIFIED run. Note the unit-test file goes red by import error, not by assertion; only the two end-to-end tests prove the behavior.

## What each guard caught or missed

- swallow_lint: caught nothing, and there was nothing for it to catch in the five issues. The one `except Exception: parsed = None` (JSON parse of the model output, `main.py` around the Groq helper) is not flagged. That looks right to me, since the failure is visible afterwards ("AI analysis incomplete" is logged), but I am reporting it because it is the closest thing to a swallow in the file.
- interpolation_lint: clean. I grepped for f-string/`%` SQL by eye and found none, so no miss that I know of. The one f-string HTML email body (`send_magic_link`) is not a query and was not flagged.
- conflated_degrade_lint: clean. None of the five issues is a "failure that looks like an empty result" in the sense this guard detects, except arguably issue 1 (empty text looks like a normal document). It did not flag it, and I did not read the detector's source to say why.
- None of the three guards would have found issues 1-5. All five were found by reading. The fix is protected by tests, not by a guard.
- ci_step_lint: clean on the new workflow (no script references to check).

## False alarms

None from the guards. One of my own: I first passed `--keywords sql` to all three CLIs; `swallow_lint` and `conflated_degrade_lint` rejected it with "unknown flag" and exit 2. That was my mistake, not a guard fault, but the error message was clear.

## Doc friction

- `swallow_lint.py --help` is not a help flag; it is "unknown flag" and then runs the selfcheck and a default-`src/` scan. Reading the docstring was the only way to learn usage.
- Version drift: the header comments in `action.yml` and `.pre-commit-hooks.yaml` still show `v0.6.0`, while the README shows `v0.6.1`. I used `v0.6.1`.
- The pre-commit hooks are `language: script` with entries like `python/sutradhar_guards/swallow_lint.py`; `args:` and `files:` overrides are mine and untested (see below).
- The first `git rev-parse HEAD` in `~/Desktop/sutradhar` failed with "error reading from .git/objects/pack ... Operation timed out"; a retry worked. Likely the Desktop folder being cloud-synced, not a Sutradhar problem.

## Limits of this verification

### Local run, 2026-10-07

The real FastAPI app (`app.main`, served by uvicorn) was run against a throwaway local PostgreSQL 17 database, seeded with `seed.py` and dropped afterwards. Supabase Storage and Groq were replaced by fakes. Two PDFs were uploaded with `curl` to `POST /evidence-requests/req_seed_001/upload`: a blank one (431 bytes) and one with 31,200 characters of text (31,779 bytes).

Blank PDF:
- Response: `document_type: "unreadable document"`, `completeness_label: "insufficient"`, `suggested_controls: []`, `missing_sections: ["No extractable text: upload a text-based PDF, or review this file manually."]`, summary "No text could be extracted from this PDF (it may be a scan or image-only file). No AI analysis was performed."
- Stored `raw_response`: `provider: "none"`, `finish_reason: "skipped_no_text"`, `model_requested: null`, `model_resolved: null`, `chars_total: 0`, `chars_reviewed: 0`, `truncated: false`.
- The fake Groq was not called for this file.

31,200-character PDF:
- The fake Groq was called once, with a 20,077-character prompt.
- Response: `document_type: "access control policy"`, `completeness_label: "partial"`, `missing_sections: ["Only the first 20,000 of 31,200 characters were analysed; the rest of the document was not reviewed."]`.
- Stored `raw_response`: `provider: "groq"`, `finish_reason: "stop"`, `model_requested: "openai/gpt-oss-120b"`, `model_resolved: "fake-model"`, `chars_total: 31200`, `chars_reviewed: 20000`, `truncated: true`.

Other rows: two `evidence_files` rows for `req_seed_001`; the request's status became `pending_review`. `activity_log` rows added, in order: "Evidence uploaded" (`...pdf (431 bytes)`), "AI analysis skipped" ("No extractable text in PDF; the model was not called"), "Evidence uploaded" (`...pdf (31,779 bytes)`), "AI analysis completed" ("Classified as access control policy — completeness: partial, 1 item flagged").

### What this run does not show

- The model was fake and always answered `"completeness_label": "complete"`, so real model output was not tested. The "partial" result shows the code-level cap working on that canned answer, not how a real model behaves on a long document.
- Real Supabase Storage was not exercised; the fake only recorded the object keys and sizes.
- The web app was not run.

### Other limits

- `verify_guard.py` was run only against commit 2 with a pytest guard command; the CI step that reads a `Guard-cmd:` trailer (from Sutradhar's template) is not wired into `guards.yml`.
- `.github/workflows/guards.yml` was not run on GitHub. I checked that it parses as YAML, that `ci_step_lint` accepts it, and that `action/run_guards.py` passes locally with the inputs it sets. The `api-tests` job (pip install on ubuntu, Python 3.11) was not run; I only ran the same tests locally on macOS.
- `.pre-commit-config.yaml` was not run: `pre-commit` is not installed here. The `files:`/`args:` overrides are unverified.
- The `apps/web` UI was not run; I kept the response and `raw_response` fields it reads unchanged but did not render it. The review page's handling of `model_resolved: null` (provider `none`) is unchecked; `mapWireAiReview` falls back through `model_resolved || model_requested || "unknown model"`, which I read but did not execute.
- `load_dotenv(override=True)` in `main.py` means a real `.env` overrides the conftest placeholders when present. Tests still fake all clients, so this should not matter; I only tested with no `.env` (the 2026-10-07 local run also had none).

## Process notes

- You said you were on `sutradhar-integration`. That branch did not exist (local or remote) and the tree was on `main`. I created it from `main`; `main` was not modified.
- Three local commits on `sutradhar-integration`, none pushed: refactor and harness (`d5b63dd`), fix and tests (`1c57785`), and CI/pre-commit/report (this one). Commit 1 holds only the existing truncation behavior in `review_text.py` and a characterization test (the short-text case); I also left the `extract_pdf_text()` and `request_groq_review()` extraction in it. Before each commit I checked `git status` and that no `.env`, `.venv`, `__pycache__` or `uploads/` path was staged.
- My first `git commit` attempt was denied by the permission system; you then explicitly authorized local commits.
