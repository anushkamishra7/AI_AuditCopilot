"""Pure helpers that decide what text goes to the AI reviewer, and how much
of the document that covers.

No FastAPI, Groq, Supabase or DB imports on purpose, so they are testable
with nothing but strings.
"""
from dataclasses import dataclass

MAX_REVIEW_CHARS = 20000
MIN_ALPHA_CHARS = 50


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
