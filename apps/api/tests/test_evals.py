"""Runs the guardrail eval set as a regression gate, and checks the harness
itself can fail (a gate that cannot fail proves nothing)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "evals"))

import run_evals  # noqa: E402
from app import main  # noqa: E402


def test_guardrail_eval_set_passes():
    report = run_evals.score_offline(run_evals.load_cases())
    failed = [r for r in report["cases"] if not r["passed"] and not r["known_gap"]]
    assert not failed, failed
    assert report["placeholder_precision"] == 1.0 and report["placeholder_recall"] == 1.0


def test_known_gaps_still_reproduce():
    """If one of these starts passing, the gap was fixed: move the case out of known_gap."""
    report = run_evals.score_offline(run_evals.load_cases())
    assert report["known_gaps"] and all(not r["passed"] for r in report["known_gaps"])


def test_harness_catches_a_broken_guardrail(monkeypatch):
    monkeypatch.setattr(main, "apply_placeholder_check", lambda parsed, text: parsed)
    report = run_evals.score_offline(run_evals.load_cases())
    assert report["gated_passed"] < report["gated_total"]


def test_live_invariants_flag_an_overconfident_review():
    cases = {c["id"]: c for c in run_evals.load_cases()}
    case = cases["template-fields"]
    outcome = run_evals.run_guardrails(case["model_output"], case["text"])
    assert run_evals.live_invariants(outcome) == []
    outcome["review"]["completeness_label"] = "complete"
    assert run_evals.live_invariants(outcome)
