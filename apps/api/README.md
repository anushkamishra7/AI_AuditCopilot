# apps/api — FastAPI backend

Real backend, running against a local Postgres database. Not yet deployed
(target: Railway/Render).

```
app/
  main.py               # FastAPI app; engagement lookup, magic-link send,
                         # PDF upload → AI review pipeline, startup config check
  upload_lookup.py       # token/id → request/stakeholder/auditor resolution,
                          # and the dashboard's list-all-requests query
seed.py                  # local test data (1 engagement, 1 evidence request)
tests/                   # smoke tests
uploads/                 # LEGACY — pre-Supabase-migration local test files.
                          # Nothing is written here anymore; gitignored.
```

## What's actually built

- `GET /health` — healthcheck
- `GET /engagements/{engagement_id}` — engagement lookup
- `GET /engagements/{engagement_id}/report` — everything the printable
  report shows: requests, files, AI reviews (labelled `ai_generated`), the
  auditor's decision, the activity trail, and a coverage summary of files that
  were not reviewed or only partly reviewed
- `POST /evidence-files/{file_id}/analyse` — re-run the AI review for a stored
  file that has none (409 if it already has one)
- `GET /engagements/{engagement_id}/evidence-requests` — every real evidence
  request for the engagement, each with its files and latest AI review
  inlined, plus the distinct stakeholders touched. Powers the evidence
  dashboard.
- `GET /upload/{token}` — resolves a magic-link token to the evidence
  request/stakeholder/auditor, or `{"kind": "invalid"}` if the token doesn't
  match. (Note: doesn't yet distinguish an *expired* token from an *approved*
  one — the DB doesn't track those states here yet.)
- `GET /evidence-requests/{request_id}` — request detail for the review panel
- `POST /evidence-requests/{request_id}/send` — generates (or reuses) a
  magic-link token, emails it via Resend
- `POST /evidence-requests/{request_id}/upload` — accepts a PDF, uploads it
  to Supabase Storage, extracts text with `pypdf`, sends it to Groq
  (`openai/gpt-oss-120b`) with a compliance-reviewer prompt, applies a
  code-based placeholder-detection floor on top of the model's own
  completeness judgment, and persists the result (`document_type`,
  `summary`, `suggested_controls`, `missing_sections`,
  `completeness_label`) to the `ai_reviews` table. Also flips the request's
  `status` to `pending_review`.
- `GET /evidence-requests/{request_id}/review` — latest uploaded file + its
  AI review for a request

## Postgres

Local DB `ai_audit_copilot`, 6 tables: `engagements`, `evidence_requests`,
`stakeholders`, `evidence_files`, `ai_reviews`, `activity_log`. `seed.py`
populates one engagement (`eng_001`) and one evidence request
(`req_seed_001`) for local testing.

`review_decisions` does **not** exist yet — auditor approve/reject/request-more
decisions aren't persisted anywhere on the backend yet. The frontend's
`EvidenceRequest.decision` field is always `null` when populated from the
real API as a result.

## File storage

Evidence PDFs are uploaded straight into memory and sent to **Supabase
Storage** (a private bucket) — nothing is written to local disk. The
`evidence_files.path` column holds the Supabase object key (not a
filesystem path, despite the column name — repurposed rather than migrated,
since renaming it wasn't worth the risk for no behavior change).
`apps/api/uploads/` is a dead directory from before this migration; it's
still gitignored but nothing reads or writes it anymore.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`.env` (gitignored) needs **all** of the following — the app checks for
them at startup and refuses to boot (clear message, exit 1) if any are
missing:

```bash
DATABASE_URL=postgresql://<user>@127.0.0.1:5432/ai_audit_copilot
GROQ_API_KEY=...
RESEND_API_KEY=...
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...          # service_role secret, not anon
SUPABASE_STORAGE_BUCKET=...            # a private bucket you've created
CLERK_JWKS_URL=https://<frontend-api>/.well-known/jwks.json   # public
CLERK_ISSUER=https://<frontend-api>                           # public

# optional, have defaults:
CLERK_AUTHORIZED_PARTIES=http://localhost:3000   # comma-separated web origins; unset = not checked
RESEND_FROM=onboarding@resend.dev
UPLOAD_BASE_URL=http://localhost:3000/upload
```

Seed the DB (this script doesn't load `.env` itself):

```bash
export $(grep -v '^#' .env | xargs)
python seed.py
```

Run it:

```bash
uvicorn app.main:app --reload --port 8000
```

## Authentication

Every endpoint except three requires `Authorization: Bearer <Clerk session
JWT>`; the token is verified (RS256, issuer, expiry) against the Clerk
instance's public JWKS. Only the public JWKS URL and issuer are configured --
the Clerk secret key is not used by the API.
`<frontend-api>` is your Clerk instance's Frontend API domain (it is encoded in
the publishable key, and shown in the Clerk dashboard under API keys).

Public: `GET /health`, `GET /upload/{token}` (stakeholder lookup, keyed by the
magic-link token), and `POST /evidence-requests/{id}/upload`, which accepts
either an auditor token or the request's own magic-link token in an
`X-Upload-Token` header. A wrong link token is 403; no credentials is 401.
Not yet done: per-engagement authorization (any signed-in auditor can read any
engagement).

## Known constraints

- **Groq free tier**: materially higher than Gemini's 20/day (which is why
  the review pipeline moved off it), but still a real ceiling — there's no
  retry/backoff or paid-tier fallback yet.
- **N+1 queries** in `list_requests_for_engagement` (one query per request
  for files/AI review) — fine at the current scale of a handful of requests
  per engagement, revisit with a real join if that stops being true.

## Two rules worth locking in early

1. **Every state change should go through a single activity-log writer.**
   `activity_log` exists as a table but nothing writes to it yet — this is
   still a TODO, not implemented.
2. **`ai_reviews` rows are immutable suggestions.** Once `review_decisions`
   exists, auditor decisions should live there, never overwriting an AI
   output — defensibility depends on being able to show what the model said
   and what the auditor did about it.
