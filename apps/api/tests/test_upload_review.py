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
        sql = self.db.statements[-1][0] if self.db.statements else ""
        if sql.startswith("SELECT 1 FROM evidence_requests") and not self.db.request_exists:
            return None
        if sql.startswith("SELECT evidence_request_id, path FROM evidence_files"):
            return ("req_1", "file_stored.pdf") if self.db.file_exists else None
        if sql.startswith("SELECT 1 FROM ai_reviews"):
            return (1,) if self.db.has_review else None
        return ("Test Stakeholder",)


class FakeDb:
    def __init__(self):
        self.statements = []
        self.commits = 0
        self.request_exists = True
        self.file_exists = True
        self.has_review = False

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
        if isinstance(self._reply, Exception):
            raise self._reply
        self.last_prompt = kwargs["messages"][-1]["content"]
        message = SimpleNamespace(content=json.dumps(self._reply))
        return SimpleNamespace(
            model="fake-model",
            choices=[SimpleNamespace(message=message, finish_reason="stop")],
        )


class FakeStorage:
    def __init__(self):
        self.uploads = []
        self.stored_pdf = b""

    def from_(self, bucket):
        return self

    def upload(self, key, contents, opts):
        self.uploads.append(key)

    def download(self, key):
        return self.stored_pdf


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
    storage = FakeStorage()
    monkeypatch.setattr(main, "supabase_client", SimpleNamespace(storage=storage))
    # No `with`: TestClient then skips the lifespan, which would open a real
    # Postgres connection.
    return SimpleNamespace(client=TestClient(main.app), db=db, groq=groq, storage=storage)


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
    raw = stored_raw_response(harness.db)
    assert raw["truncated"] is False
    assert raw["chars_reviewed"] == raw["chars_total"]


def test_blank_pdf_never_calls_the_model(harness):
    response = upload(harness, make_pdf(None))

    assert response.status_code == 200
    review = response.json()["ai_review"]
    assert harness.groq.calls == 0
    assert review["completeness_label"] == "insufficient"
    assert review["suggested_controls"] == []
    assert "No AI analysis was performed" in review["summary"]
    assert review["missing_sections"]

    raw = stored_raw_response(harness.db)
    assert raw["provider"] == "none"
    assert raw["finish_reason"] == "skipped_no_text"
    assert raw["chars_total"] == 0
    assert "AI analysis skipped" in harness.db.activity_actions()
    assert "AI analysis completed" not in harness.db.activity_actions()


def test_pdf_over_20k_chars_cannot_come_back_complete(harness):
    # 30,000+ characters of real words; the fake model says "complete".
    text = "Access control policy requires least privilege. " * 650
    response = upload(harness, make_pdf(text))

    assert response.status_code == 200
    review = response.json()["ai_review"]
    assert harness.groq.calls == 1
    assert len(harness.groq.last_prompt) < 21000
    assert review["completeness_label"] == "partial"
    assert any("not reviewed" in m for m in review["missing_sections"])

    raw = stored_raw_response(harness.db)
    assert raw["truncated"] is True
    assert raw["chars_reviewed"] == 20000
    assert raw["chars_total"] > 20000


def test_upload_to_unknown_request_is_404_and_stores_nothing(harness):
    harness.db.request_exists = False
    response = upload(harness, make_pdf("Access control policy. " * 10))

    assert response.status_code == 404
    assert harness.storage.uploads == []
    assert harness.groq.calls == 0
    assert harness.db.inserted("evidence_files") == []
    assert harness.db.commits == 0


GOOD_TEXT = "Access control policy requires least privilege. " * 5


def status_updates(db):
    return [p for s, p in db.statements if s.startswith("UPDATE evidence_requests SET status")]


def test_non_pdf_bytes_are_rejected_before_anything_is_stored(harness):
    response = upload(harness, b"MZ\x90\x00 this is an executable, not a pdf" * 20)

    assert response.status_code == 400
    assert harness.storage.uploads == [] and harness.groq.calls == 0
    assert harness.db.inserted("evidence_files") == []


def test_empty_file_is_rejected(harness):
    response = upload(harness, b"")
    assert response.status_code == 400
    assert harness.storage.uploads == []


def test_oversized_file_is_rejected_with_413(harness, monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 100)
    response = upload(harness, make_pdf(GOOD_TEXT))
    assert response.status_code == 413
    assert harness.storage.uploads == []


def test_corrupt_pdf_is_422_and_leaves_nothing_behind(harness):
    response = upload(harness, b"%PDF-1.4\nthis is not a real pdf body at all\n%%EOF")

    assert response.status_code == 422
    assert "couldn't be read" in response.json()["detail"]["message"]
    assert harness.storage.uploads == []
    assert harness.db.inserted("evidence_files") == []
    assert harness.db.commits == 0


def test_model_failure_keeps_the_file_advances_status_and_is_logged(harness):
    harness.groq._reply = RuntimeError("groq is down")
    response = upload(harness, make_pdf(GOOD_TEXT))

    assert response.status_code == 502
    detail = response.json()["detail"]
    assert detail["message"] == "Groq API request failed"
    assert detail["evidence_file_id"].startswith("file_")
    # the file is stored and recorded, and the request moved on
    assert len(harness.storage.uploads) == 1
    assert len(harness.db.inserted("evidence_files")) == 1
    assert status_updates(harness.db) == [("pending_review", "req_1")]
    assert harness.db.inserted("ai_reviews") == []
    actions = harness.db.activity_actions()
    assert actions == ["Evidence uploaded", "AI analysis failed"]


def test_unrecognised_completeness_label_from_the_model_is_not_trusted(harness):
    harness.groq._reply = {**MODEL_SAYS_COMPLETE, "completeness_label": "totally done"}
    review = upload(harness, make_pdf(GOOD_TEXT)).json()["ai_review"]

    assert review["completeness_label"] == "insufficient"
    assert any("unrecognised completeness rating" in m for m in review["missing_sections"])


def test_bad_confidence_label_is_corrected_before_storing(harness):
    harness.groq._reply = {
        **MODEL_SAYS_COMPLETE,
        "suggested_controls": [{"control_name": "AC-1", "confidence_label": "definitely", "rationale": "x"}],
    }
    upload(harness, make_pdf(GOOD_TEXT))

    stored = json.loads(harness.db.inserted("ai_reviews")[0][4])
    assert stored[0]["confidence_label"] == "weak_match"


def test_model_returning_a_json_list_is_handled_not_a_crash(harness):
    harness.groq._reply = [{"completeness_label": "complete"}]
    response = upload(harness, make_pdf(GOOD_TEXT))

    assert response.status_code == 200
    # no review row is stored: the UI shows "no analysis" (and offers a retry)
    # rather than a verdict the model never gave
    assert harness.db.inserted("ai_reviews") == []
    assert "AI analysis incomplete" in harness.db.activity_actions()
    assert status_updates(harness.db) == [("pending_review", "req_1")]


def test_successful_upload_advances_status_exactly_once(harness):
    upload(harness, make_pdf(GOOD_TEXT))
    assert status_updates(harness.db) == [("pending_review", "req_1")]


def analyse(harness):
    return harness.client.post("/evidence-files/file_stored/analyse")


def test_reanalyse_runs_the_review_for_a_file_with_none(harness):
    harness.storage.stored_pdf = make_pdf(GOOD_TEXT)
    response = analyse(harness)

    assert response.status_code == 200
    assert response.json()["ai_review"]["completeness_label"] == "complete"
    assert harness.groq.calls == 1
    assert len(harness.db.inserted("ai_reviews")) == 1
    assert harness.db.inserted("ai_reviews")[0][1] == "file_stored"
    assert harness.storage.uploads == []  # nothing is re-stored
    assert harness.db.inserted("evidence_files") == []


def test_reanalyse_refuses_when_a_review_already_exists(harness):
    harness.db.has_review = True
    harness.storage.stored_pdf = make_pdf(GOOD_TEXT)
    response = analyse(harness)

    assert response.status_code == 409
    assert harness.groq.calls == 0
    assert harness.db.inserted("ai_reviews") == []


def test_reanalyse_unknown_file_is_404(harness):
    harness.db.file_exists = False
    assert analyse(harness).status_code == 404
    assert harness.groq.calls == 0


def test_reanalyse_model_failure_is_502_and_logged(harness):
    harness.storage.stored_pdf = make_pdf(GOOD_TEXT)
    harness.groq._reply = RuntimeError("still down")
    response = analyse(harness)

    assert response.status_code == 502
    assert harness.db.inserted("ai_reviews") == []
    assert harness.db.activity_actions() == ["AI analysis failed"]
