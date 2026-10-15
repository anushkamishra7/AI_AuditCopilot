"""Eval harness for the review guardrails.

The model's JSON is one input; the code-level floors (validate_model_review,
apply_placeholder_check, apply_coverage_check) decide what the auditor sees.
This replays labelled cases through the same sequence analyse_and_store runs
and scores it:

  - placeholder detection: precision / recall over (case, placeholder) pairs
  - guardrail outcome: final completeness_label, notes, truncation, controls
  - cases tagged known_gap are reported separately and do not fail the gate

Offline by default (no API key, no network): the model output is part of the
case, so the run is deterministic. `--live` sends each case's text to the real
model instead and checks invariants that must hold whatever it answers.

    python evals/run_evals.py                # offline, exits 1 on a regression
    python evals/run_evals.py --live         # needs GROQ_API_KEY
    python evals/run_evals.py --json out.json
"""
import argparse
import copy
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# app.main exits at import without these (see tests/conftest.py).
for _name, _value in {
    "DATABASE_URL": "postgresql://test:test@127.0.0.1:5432/test",
    "GROQ_API_KEY": "test-groq-key",
    "RESEND_API_KEY": "re_test_key",
    "SUPABASE_URL": "https://placeholder.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "test-service-role-key",
    "SUPABASE_STORAGE_BUCKET": "test-bucket",
    "CLERK_JWKS_URL": "https://clerk.test.example/.well-known/jwks.json",
    "CLERK_ISSUER": "https://clerk.test.example",
}.items():
    os.environ.setdefault(_name, _value)

from app import main  # noqa: E402
from app.review_text import apply_coverage_check, prepare_review_text, validate_model_review  # noqa: E402

CASES_PATH = Path(__file__).with_name("cases.jsonl")
RESULTS_DIR = Path(__file__).with_name("results")


def load_cases(path: Path = CASES_PATH) -> list[dict]:
    cases = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        if "text_repeat" in case:
            r = case["text_repeat"]
            case["text"] = r["unit"] * r["times"] + r.get("suffix", "")
        cases.append(case)
    return cases


def run_guardrails(model_output, full_text: str) -> dict:
    """The post-model half of analyse_and_store, in the same order."""
    prepared = prepare_review_text(full_text)
    parsed = validate_model_review(copy.deepcopy(model_output))
    if parsed is None:
        return {"review": None, "prepared": prepared, "placeholders": []}
    parsed = main.apply_placeholder_check(parsed, full_text)
    parsed = apply_coverage_check(parsed, prepared)
    return {"review": parsed, "prepared": prepared, "placeholders": main.find_unfilled_placeholders(full_text)}


def check_case(case: dict, outcome: dict) -> list[str]:
    """Reasons this case failed; empty when it passed."""
    expect, review = case["expect"], outcome["review"]
    if review is None:
        return ["model output rejected as not a review object"]
    failures = []
    if sorted(outcome["placeholders"]) != sorted(expect["placeholders"]):
        failures.append(f"placeholders {outcome['placeholders']} != {expect['placeholders']}")
    if review["completeness_label"] != expect["final_label"]:
        failures.append(f"label {review['completeness_label']!r} != {expect['final_label']!r}")
    if "truncated" in expect and outcome["prepared"].truncated != expect["truncated"]:
        failures.append(f"truncated {outcome['prepared'].truncated} != {expect['truncated']}")
    if "note" in expect and not any(expect["note"] in m for m in review["missing_sections"]):
        failures.append(f"missing note containing {expect['note']!r}")
    if "controls" in expect:
        got = [[c["control_name"], c["confidence_label"]] for c in review["suggested_controls"]]
        if got != expect["controls"]:
            failures.append(f"controls {got} != {expect['controls']}")
    return failures


def score_offline(cases: list[dict]) -> dict:
    rows, tp, fp, fn = [], 0, 0, 0
    for case in cases:
        outcome = run_guardrails(case["model_output"], case["text"])
        failures = check_case(case, outcome)
        known_gap = case.get("known_gap")
        got, want = set(outcome["placeholders"]), set(case["expect"]["placeholders"])
        if not known_gap:
            tp, fp, fn = tp + len(got & want), fp + len(got - want), fn + len(want - got)
        rows.append({"id": case["id"], "passed": not failures, "known_gap": known_gap, "failures": failures})
    gated = [r for r in rows if not r["known_gap"]]
    return {
        "mode": "offline",
        "cases": rows,
        "gated_total": len(gated),
        "gated_passed": sum(r["passed"] for r in gated),
        "known_gaps": [r for r in rows if r["known_gap"]],
        "placeholder_precision": tp / (tp + fp) if tp + fp else 1.0,
        "placeholder_recall": tp / (tp + fn) if tp + fn else 1.0,
    }


def live_invariants(outcome: dict) -> list[str]:
    """What must be true of the final review whatever the model said."""
    review, prepared = outcome["review"], outcome["prepared"]
    if review is None:
        return ["response was not a usable review"]
    problems = []
    if review["completeness_label"] not in ("complete", "partial", "insufficient"):
        problems.append("label outside schema")
    if (outcome["placeholders"] or prepared.truncated) and review["completeness_label"] == "complete":
        problems.append("labelled complete despite placeholders/truncation")
    if outcome["placeholders"] and not any("unfilled template field" in m for m in review["missing_sections"]):
        problems.append("placeholders found but not reported in missing_sections")
    return problems


def score_live(cases: list[dict]) -> dict:
    rows = []
    RESULTS_DIR.mkdir(exist_ok=True)
    trace_path = RESULTS_DIR / f"live-trace-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    with trace_path.open("w") as trace:
        for case in cases:
            prepared = prepare_review_text(case["text"])
            started = time.time()
            body, parsed = main.request_groq_review(prepared.doc_text)
            latency = round(time.time() - started, 2)
            outcome = run_guardrails(parsed, case["text"])
            problems = live_invariants(outcome)
            row = {"id": case["id"], "passed": not problems, "failures": problems, "latency_s": latency,
                   "model": body.get("model_resolved"), "finish_reason": body.get("finish_reason"),
                   "raw_label": (parsed or {}).get("completeness_label") if isinstance(parsed, dict) else None,
                   "final_label": outcome["review"]["completeness_label"] if outcome["review"] else None}
            trace.write(json.dumps(row) + "\n")
            rows.append(row)
    return {"mode": "live", "cases": rows, "trace": str(trace_path),
            "gated_total": len(rows), "gated_passed": sum(r["passed"] for r in rows)}


def print_report(report: dict) -> None:
    print(f"mode: {report['mode']}")
    for row in report["cases"]:
        mark = "PASS" if row["passed"] else ("GAP " if row.get("known_gap") else "FAIL")
        print(f"  [{mark}] {row['id']}" + (f"  ({row['known_gap']})" if row.get("known_gap") else ""))
        if not row["passed"]:
            for f in row["failures"]:
                print(f"         - {f}")
    print(f"gated cases: {report['gated_passed']}/{report['gated_total']} passed")
    if report["mode"] == "offline":
        print(f"placeholder precision: {report['placeholder_precision']:.2f}  recall: {report['placeholder_recall']:.2f}  (known gaps excluded)")
        print(f"known gaps: {len(report['known_gaps'])} (documented, not gating)")
    else:
        print(f"trace: {report['trace']}")


def main_cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", action="store_true", help="call the real model (needs GROQ_API_KEY)")
    parser.add_argument("--json", metavar="PATH", help="also write the report as JSON")
    args = parser.parse_args()
    cases = load_cases()
    if args.live:
        if os.environ.get("GROQ_API_KEY") == "test-groq-key":
            sys.exit("--live needs a real GROQ_API_KEY in the environment")
        cases = [c for c in cases if not c.get("known_gap")]
        report = score_live(cases)
    else:
        report = score_offline(cases)
    print_report(report)
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2, default=str))
    return 0 if report["gated_passed"] == report["gated_total"] else 1


if __name__ == "__main__":
    sys.exit(main_cli())
