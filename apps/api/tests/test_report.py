from app.report import (
    COVERAGE_FULL,
    COVERAGE_NONE,
    COVERAGE_PARTIAL,
    COVERAGE_UNKNOWN,
    build_report,
    classify_coverage,
)


def review(**raw):
    base = {"provider": "groq", "model_resolved": "m", "finish_reason": "stop", "chars_total": 100, "chars_reviewed": 100, "truncated": False}
    return {
        "document_type": "policy",
        "summary": "s",
        "suggested_controls": [{"control_name": "AC-1"}],
        "missing_sections": [],
        "completeness_label": "complete",
        "raw_response": {**base, **raw},
        "created_at": "2026-10-08T10:00:00+05:30",
    }


# --- classify_coverage -------------------------------------------------------

def test_no_review_is_not_reviewed():
    c = classify_coverage(None)
    assert c["status"] == COVERAGE_NONE and "No AI review was recorded" in c["detail"]


def test_skipped_for_no_text_is_not_reviewed_and_says_why():
    c = classify_coverage(review(provider="none", finish_reason="skipped_no_text", chars_total=0, chars_reviewed=0))
    assert c["status"] == COVERAGE_NONE and "No text could be extracted" in c["detail"]


def test_truncated_is_partly_reviewed_with_the_numbers():
    c = classify_coverage(review(chars_total=31200, chars_reviewed=20000, truncated=True))
    assert c["status"] == COVERAGE_PARTIAL
    assert "first 20,000 of 31,200" in c["detail"]
    assert (c["chars_reviewed"], c["chars_total"]) == (20000, 31200)


def test_reviewed_less_than_total_is_partial_even_if_the_flag_is_missing():
    assert classify_coverage(review(chars_total=500, chars_reviewed=100, truncated=False))["status"] == COVERAGE_PARTIAL


def test_full_coverage():
    c = classify_coverage(review(chars_total=5765, chars_reviewed=5765))
    assert c["status"] == COVERAGE_FULL and "5,765" in c["detail"]


def test_review_from_before_coverage_was_recorded_is_unknown_not_assumed_full():
    old = review()
    old["raw_response"] = {"provider": "groq", "model_resolved": "m"}
    assert classify_coverage(old)["status"] == COVERAGE_UNKNOWN


def test_missing_or_non_dict_raw_response_is_unknown_or_none_never_full():
    odd = review()
    odd["raw_response"] = None
    assert classify_coverage(odd)["status"] == COVERAGE_UNKNOWN


# --- build_report ------------------------------------------------------------

def make(files, reviews, decisions=None, activity=None, requests=None):
    requests = requests or [
        {"id": "r1", "control_ref": "CC6.2", "title": "Access policy", "status": "pending_review"},
        {"id": "r2", "control_ref": "CC7.1", "title": "Monitoring", "status": "awaiting_upload"},
    ]
    return build_report(
        engagement={"id": "eng_1", "name": "FY26 SOC 2"},
        requests=requests,
        files=files,
        reviews_by_file=reviews,
        decisions_by_request=decisions or {},
        activity=activity or [],
        generated_at="2026-10-08T12:00:00+05:30",
    )


FILES = [
    {"id": "f1", "evidence_request_id": "r1", "filename": "a.pdf", "size_bytes": 10, "uploaded_at": "2026-10-08T09:00:00"},
    {"id": "f2", "evidence_request_id": "r1", "filename": "b.pdf", "size_bytes": 20, "uploaded_at": "2026-10-08T08:00:00"},
    {"id": "f3", "evidence_request_id": "r1", "filename": "c.pdf", "size_bytes": 30, "uploaded_at": "2026-10-08T10:00:00"},
]


def test_generation_time_and_engagement_are_carried_through():
    r = make(FILES, {})
    assert r["generated_at"] == "2026-10-08T12:00:00+05:30" and r["engagement"]["name"] == "FY26 SOC 2"


def test_coverage_section_lists_exactly_what_was_not_fully_reviewed():
    reviews = {
        "f1": review(chars_total=100, chars_reviewed=100),                              # full
        "f2": review(chars_total=31200, chars_reviewed=20000, truncated=True),          # partial
        # f3: no review at all
    }
    cov = make(FILES, reviews)["coverage"]
    assert cov["files_total"] == 3 and cov["fully_reviewed"] == 1
    assert [x["filename"] for x in cov["partly_reviewed"]] == ["b.pdf"]
    assert [x["filename"] for x in cov["not_reviewed"]] == ["c.pdf"]
    assert cov["coverage_not_recorded"] == []
    assert [x["request_id"] for x in cov["requests_without_files"]] == ["r2"]
    assert cov["not_reviewed"][0]["control_ref"] == "CC6.2" and cov["not_reviewed"][0]["request_title"] == "Access policy"


def test_every_review_is_labelled_ai_generated_and_files_are_not():
    out = make(FILES, {"f1": review()})
    f1 = out["requests"][0]["files"][-1]  # sorted by upload time
    reviewed = [f for f in out["requests"][0]["files"] if f["review"]][0]
    assert reviewed["review"]["ai_generated"] is True
    assert all("ai_generated" not in f for f in out["requests"][0]["files"])
    assert reviewed["review"]["model"] == "m"
    assert f1  # sanity


def test_files_are_in_upload_order_and_activity_is_chronological():
    out = make(
        FILES,
        {},
        activity=[
            {"request_id": "r1", "actor": "x", "actor_type": "ai", "action": "second", "detail": None, "created_at": "2026-10-08T10:00:00"},
            {"request_id": "r1", "actor": "x", "actor_type": "ai", "action": "first", "detail": None, "created_at": "2026-10-08T09:00:00"},
        ],
    )
    assert [f["filename"] for f in out["requests"][0]["files"]] == ["b.pdf", "a.pdf", "c.pdf"]
    assert [a["action"] for a in out["requests"][0]["activity"]] == ["first", "second"]


def test_decision_is_attached_only_to_its_own_request():
    d = {"decision": "approve", "note": "ok", "decided_by": "A", "decided_at": "2026-10-08T11:00:00"}
    out = make(FILES, {}, decisions={"r1": d})
    assert out["requests"][0]["decision"] == d and out["requests"][1]["decision"] is None


def test_an_engagement_with_nothing_uploaded_reports_zero_files_not_an_error():
    out = make([], {})
    assert out["coverage"]["files_total"] == 0 and out["coverage"]["fully_reviewed"] == 0
    assert len(out["coverage"]["requests_without_files"]) == 2
