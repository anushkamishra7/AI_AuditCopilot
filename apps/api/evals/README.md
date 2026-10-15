# Guardrail evals

The model's review is not what the auditor sees. `validate_model_review`,
`apply_placeholder_check` and `apply_coverage_check` sit under it. These evals
replay labelled cases (`cases.jsonl`) through that same sequence.

```
python evals/run_evals.py          # offline, deterministic, exits 1 on a regression
python evals/run_evals.py --live   # real model; checks invariants, writes a JSONL trace
pytest tests/test_evals.py         # the same set as a CI gate
```

Each case holds the document text (or `text_repeat` for long ones), the model
output to simulate, and the expected placeholders, final label and notes.

Reported: precision/recall of placeholder detection, pass rate per case, and
`known_gap` cases (real limitations, listed but not gating; none today). The
first run of this set found two: placeholders over 50 characters were missed,
and `[link text]` in Markdown links was flagged. Both are fixed in
`PLACEHOLDER_PATTERN` (cap raised to 80, links skipped) and the cases now gate.

Add a case whenever a document produces a wrong review.
