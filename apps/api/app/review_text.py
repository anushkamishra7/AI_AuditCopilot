"""Pure helpers that decide what the AI reviewer is allowed to claim about a
document, based on how much of it was actually read.

No FastAPI, Groq, Supabase or DB imports on purpose: these are code-level
floors that override the model (same idea as apply_placeholder_check in
main.py), so they have to be testable with nothing but strings.
"""
from dataclasses import dataclass

MAX_REVIEW_CHARS = 20000
MIN_ALPHA_CHARS = 50

COMPLETENESS_RANK = {"insufficient": 0, "partial": 1, "complete": 2}


@dataclass(frozen=True)
class PreparedText:
    doc_text: str
    chars_total: int
    chars_reviewed: int
    truncated: bool
    has_text: bool


def prepare_review_text(full_text: str, max_chars: int = MAX_REVIEW_CHARS) -> PreparedText:
    """What goes to the model, and how much of the document that covers.
    has_text is False for scanned/image-only PDFs, where extraction yields
    nothing (or only stray characters): there is nothing to review."""
    doc_text = full_text[:max_chars]
    alpha = sum(1 for c in full_text if c.isalpha())
    return PreparedText(
        doc_text=doc_text,
        chars_total=len(full_text),
        chars_reviewed=len(doc_text),
        truncated=len(full_text) > max_chars,
        has_text=alpha >= MIN_ALPHA_CHARS,
    )


def unreadable_review(prepared: PreparedText) -> dict:
    """The review returned when no model call is made because the PDF had no
    extractable text. Same keys as a model review."""
    return {
        "document_type": "unreadable document",
        "summary": (
            "No text could be extracted from this PDF (it may be a scan or "
            "image-only file). No AI analysis was performed."
        ),
        "suggested_controls": [],
        "missing_sections": [
            "No extractable text: upload a text-based PDF, or review this file manually."
        ],
        "completeness_label": "insufficient",
    }


def apply_coverage_check(parsed: dict, prepared: PreparedText) -> dict:
    """If the model only saw part of the document, it cannot call the whole
    thing "complete": caps completeness_label at "partial" (an unknown label
    is capped too) and says which part was not reviewed."""
    if not prepared.truncated:
        return parsed

    current = parsed.get("completeness_label")
    if COMPLETENESS_RANK.get(current, COMPLETENESS_RANK["complete"]) >= COMPLETENESS_RANK["complete"]:
        parsed["completeness_label"] = "partial"

    missing = parsed.get("missing_sections")
    missing = list(missing) if isinstance(missing, list) else []
    note = (
        f"Only the first {prepared.chars_reviewed:,} of {prepared.chars_total:,} "
        "characters were analysed; the rest of the document was not reviewed."
    )
    if not any("were analysed; the rest of the document was not reviewed" in str(m) for m in missing):
        missing.append(note)
    parsed["missing_sections"] = missing
    return parsed
