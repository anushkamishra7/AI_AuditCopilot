import dataclasses

import pytest

from app.review_text import (
    apply_coverage_check,
    prepare_review_text,
    unreadable_review,
)

WORDS = "Access control policy requires least privilege. "


def test_empty_text_has_no_text():
    p = prepare_review_text("")
    assert (p.has_text, p.chars_total, p.chars_reviewed, p.truncated) == (False, 0, 0, False)


def test_whitespace_and_punctuation_only_has_no_text():
    assert not prepare_review_text("  \n\t -- 12345 ... [1] " * 20).has_text


def test_alpha_threshold_is_50():
    assert not prepare_review_text("a" * 49).has_text
    assert prepare_review_text("a" * 50).has_text
    assert prepare_review_text("1234 " * 100 + "a" * 50).has_text


def test_short_text_not_truncated():
    p = prepare_review_text(WORDS * 3)
    assert p.has_text and not p.truncated
    assert p.doc_text == WORDS * 3
    assert p.chars_reviewed == p.chars_total == len(WORDS * 3)


def test_long_text_truncated_at_max_chars():
    text = WORDS * 1000
    p = prepare_review_text(text)
    assert p.truncated
    assert p.chars_reviewed == 20000 == len(p.doc_text)
    assert p.chars_total == len(text)


def test_exactly_max_chars_is_not_truncated():
    assert not prepare_review_text("a" * 20000).truncated
    assert prepare_review_text("a" * 20001).truncated


def test_custom_max_chars():
    p = prepare_review_text("a" * 100, max_chars=60)
    assert p.truncated and p.chars_reviewed == 60


def test_prepared_is_frozen():
    with pytest.raises(dataclasses.FrozenInstanceError):
        prepare_review_text("x").has_text = True


def test_unreadable_review_shape():
    r = unreadable_review(prepare_review_text(""))
    assert r["completeness_label"] == "insufficient"
    assert r["suggested_controls"] == []
    assert "No AI analysis was performed" in r["summary"]
    assert "No text was extracted" in r["summary"] or "No text could be extracted" in r["summary"]
    assert r["missing_sections"]
    assert set(r) == {"document_type", "summary", "suggested_controls", "missing_sections", "completeness_label"}


def truncated():
    return prepare_review_text(WORDS * 1000)


def test_coverage_untouched_when_not_truncated():
    parsed = {"completeness_label": "complete", "missing_sections": []}
    assert apply_coverage_check(parsed, prepare_review_text(WORDS)) == {
        "completeness_label": "complete",
        "missing_sections": [],
    }


@pytest.mark.parametrize("label,expected", [
    ("complete", "partial"),
    ("partial", "partial"),
    ("insufficient", "insufficient"),
    ("totally-complete", "partial"),
    (None, "partial"),
])
def test_coverage_caps_label(label, expected):
    out = apply_coverage_check({"completeness_label": label}, truncated())
    assert out["completeness_label"] == expected


def test_coverage_note_text():
    p = prepare_review_text("a " * 15000)
    out = apply_coverage_check({"completeness_label": "complete", "missing_sections": ["x"]}, p)
    assert out["missing_sections"][0] == "x"
    assert out["missing_sections"][1] == (
        f"Only the first 20,000 of {p.chars_total:,} characters were analysed; "
        "the rest of the document was not reviewed."
    )


def test_coverage_note_not_duplicated():
    p = truncated()
    out = apply_coverage_check({"completeness_label": "complete"}, p)
    out = apply_coverage_check(out, p)
    assert len(out["missing_sections"]) == 1


def test_coverage_tolerates_bad_missing_sections():
    out = apply_coverage_check({"completeness_label": "complete", "missing_sections": "oops"}, truncated())
    assert len(out["missing_sections"]) == 1
