"""End-to-end tests of POST /evidence-requests/{id}/upload with Postgres,
Supabase Storage and Groq replaced by fakes."""
import io
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

import app.main as main


def make_pdf(text: str | None) -> bytes:
    """A one-page PDF. text=None gives a blank page (what a scan looks like
    to a text extractor: pages exist, no text layer)."""
    if text is None:
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        out = io.BytesIO()
        writer.write(out)
        return out.getvalue()
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 10 700 Td ({escaped}) Tj ET".encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref)
    return out


class FakeCursor:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.db.statements.append((" ".join(sql.split()), params))

    def fetchone(self):
        return ("Test Stakeholder",)


class FakeDb:
    def __init__(self):
        self.statements = []
        self.commits = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def inserted(self, table):
        return [p for s, p in self.statements if s.startswith(f"INSERT INTO {table}")]

    def activity_actions(self):
        return [p[4] for p in self.inserted("activity_log")]


class FakeGroq:
    """Replies with `reply` (a dict, serialised) and counts calls."""

    def __init__(self, reply: dict):
        self.calls = 0
        self.last_prompt = None
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))
        self._reply = reply

    def _create(self, **kwargs):
        self.calls += 1
        self.last_prompt = kwargs["messages"][-1]["content"]
        message = SimpleNamespace(content=json.dumps(self._reply))
        return SimpleNamespace(
            model="fake-model",
            choices=[SimpleNamespace(message=message, finish_reason="stop")],
        )


class FakeStorage:
    def __init__(self):
        self.uploads = []

    def from_(self, bucket):
        return self

    def upload(self, key, contents, opts):
        self.uploads.append(key)


MODEL_SAYS_COMPLETE = {
    "document_type": "access control policy",
    "summary": "Defines access control.",
    "suggested_controls": [
        {"control_name": "AC-1", "confidence_label": "strong_match", "rationale": "x"}
    ],
    "missing_sections": [],
    "completeness_label": "complete",
}


@pytest.fixture
def harness(monkeypatch):
    db = FakeDb()
    groq = FakeGroq(MODEL_SAYS_COMPLETE)
    monkeypatch.setattr(main, "get_db_connection", lambda: db)
    monkeypatch.setattr(main, "groq_client", groq)
    monkeypatch.setattr(main, "supabase_client", SimpleNamespace(storage=FakeStorage()))
    # No `with`: TestClient then skips the lifespan, which would open a real
    # Postgres connection.
    return SimpleNamespace(client=TestClient(main.app), db=db, groq=groq)


def upload(harness, pdf: bytes):
    return harness.client.post(
        "/evidence-requests/req_1/upload",
        files={"file": ("policy.pdf", pdf, "application/pdf")},
    )


def stored_raw_response(db) -> dict:
    return json.loads(db.inserted("ai_reviews")[0][7])


def test_short_text_pdf_is_reviewed_normally(harness):
    text = "Access Control Policy. Users must be granted least privilege access. " * 3
    response = upload(harness, make_pdf(text))

    assert response.status_code == 200
    review = response.json()["ai_review"]
    assert harness.groq.calls == 1
    assert "Access Control Policy" in harness.groq.last_prompt
    assert review["completeness_label"] == "complete"
    assert review["suggested_controls"]
    assert stored_raw_response(harness.db)["provider"] == "groq"
    assert "AI analysis completed" in harness.db.activity_actions()
