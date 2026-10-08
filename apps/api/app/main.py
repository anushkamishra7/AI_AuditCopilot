import io
import os
import secrets
import ssl
import sys
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any

import psycopg
import resend
from resend.emails._emails import Emails
from resend.exceptions import ResendError
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi import UploadFile, File
from supabase import create_client
from storage3.exceptions import StorageApiError
import uuid
import json
import logging
import re
from datetime import datetime
from pypdf import PdfReader
from groq import Groq

dotenv_path = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(dotenv_path, override=True)

from app.auth import AuthError, AuthUnavailable, bearer_token, make_jwks_signing_key_getter, verify_clerk_token
from app.report import build_report
from app.review_text import apply_coverage_check, prepare_review_text, unreadable_review, validate_model_review
from app.upload_lookup import (
    RequestDetailResponse,
    UploadLookupResponse,
    get_request_detail,
    list_evidence_files_for_engagement,
    list_requests_for_engagement,
    lookup_upload,
)

DATABASE_URL = os.getenv("DATABASE_URL")
UPLOAD_BASE_URL = os.getenv("UPLOAD_BASE_URL", "http://localhost:3000/upload")
# The stakeholder upload page calls this API directly from the browser (see
# apps/web/src/lib/api.ts's uploadEvidenceFile) -- every other frontend call
# is a server-side fetch, which isn't subject to CORS, so this went
# undiscovered until an actual browser submitted a real file.
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
RESEND_API_KEY = os.getenv("RESEND_API_KEY")
RESEND_FROM = os.getenv("RESEND_FROM", "onboarding@resend.dev")
# Was GEMINI_API_KEY -- Gemini's free tier is a hard 20 requests/day cap
# per Google Cloud project, confirmed exhausted across multiple fresh
# projects (rotating keys doesn't help; it's a project-level quota, not a
# key-level one). Groq's free tier is materially higher and needs no
# billing info, for the same "one JSON completion per uploaded document"
# job -- see the review pipeline below.
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
SUPABASE_STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET")
# Public values only (the instance's published signing keys and its issuer);
# the Clerk secret key is deliberately not read. CLERK_AUTHORIZED_PARTIES is an
# optional comma-separated list of web origins whose tokens are accepted.
CLERK_JWKS_URL = os.getenv("CLERK_JWKS_URL")
CLERK_ISSUER = os.getenv("CLERK_ISSUER")
CLERK_AUTHORIZED_PARTIES = tuple(p.strip() for p in os.getenv("CLERK_AUTHORIZED_PARTIES", "").split(",") if p.strip())

# Fail immediately and clearly if required config is missing, rather than
# limping along and surfacing it later as an opaque 500 on whichever request
# happens to touch the missing piece first (e.g. psycopg.connect() failing
# deep inside get_db_connection, or a 502 from Groq/Resend/Supabase on
# first use). DATABASE_URL in particular used to silently fall back to
# "postgresql://anushka@127.0.0.1:5432/ai_audit_copilot" -- hardcoding the
# original developer's own machine username, which is wrong for literally
# any other environment. No more silent fallback: set it explicitly.
REQUIRED_ENV_VARS = {
    "DATABASE_URL": DATABASE_URL,
    "GROQ_API_KEY": GROQ_API_KEY,
    "RESEND_API_KEY": RESEND_API_KEY,
    "SUPABASE_URL": SUPABASE_URL,
    "SUPABASE_SERVICE_ROLE_KEY": SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_STORAGE_BUCKET": SUPABASE_STORAGE_BUCKET,
    "CLERK_JWKS_URL": CLERK_JWKS_URL,
    "CLERK_ISSUER": CLERK_ISSUER,
}


def _check_required_env_vars() -> None:
    missing = [name for name, value in REQUIRED_ENV_VARS.items() if not value]
    if not missing:
        return
    print("=" * 72, file=sys.stderr)
    print("FATAL: missing required environment variable(s):", file=sys.stderr)
    for name in missing:
        print(f"  - {name}", file=sys.stderr)
    print(file=sys.stderr)
    print(f"Set them in {dotenv_path} and restart. See apps/api/README.md.", file=sys.stderr)
    print("=" * 72, file=sys.stderr)
    sys.exit(1)


_check_required_env_vars()

resend.api_key = RESEND_API_KEY
groq_client = Groq(api_key=GROQ_API_KEY)
# service-role key -- server-side only, bypasses bucket RLS. Never expose
# this to the frontend; the web app never talks to Supabase directly.
supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast if the database is unreachable, rather than on the first request.
    with psycopg.connect(DATABASE_URL):
        pass
    yield


# One database connection per request, closed when the request ends.
#
# This used to be a single connection shared by every request. Two failures
# came from that: one failed statement left it in "current transaction is
# aborted" so every later request returned 500 until a restart, and
# concurrent requests interleaved their transactions. A per-thread connection
# fixed the first but not the second: read-only handlers never end their
# transaction, so each worker thread's connection sat "idle in transaction"
# holding table locks, and the handlers' lazy `ALTER TABLE ... IF NOT EXISTS`
# migrations (which need an exclusive lock even when they change nothing)
# queued behind them and hung every request. Closing the connection at the
# end of the request releases everything, committed or not.
_request_db: ContextVar[dict | None] = ContextVar("request_db", default=None)


async def db_request_scope():
    holder: dict = {"conn": None}
    token = _request_db.set(holder)
    try:
        yield
    finally:
        _request_db.reset(token)
        conn = holder["conn"]
        if conn is not None and not conn.closed:
            await run_in_threadpool(conn.close)


_signing_key = make_jwks_signing_key_getter(CLERK_JWKS_URL)

# Routes that do not need an auditor token. Every other route does -- a route
# added later is protected by default. The upload route is listed because it
# authorises itself (auditor token OR the request's own magic-link token, see
# _authorize_upload); the lookup is keyed by that magic-link token.
PUBLIC_ROUTES = {
    ("GET", "/health"),
    ("GET", "/upload/{token}"),
    ("POST", "/evidence-requests/{request_id}/upload"),
}


def verify_request_token(token: str) -> dict:
    try:
        return verify_clerk_token(
            token,
            signing_key_getter=_signing_key,
            issuer=CLERK_ISSUER,
            authorized_parties=CLERK_AUTHORIZED_PARTIES,
        )
    except AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc), headers={"WWW-Authenticate": "Bearer"})
    except AuthUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))


def require_auditor(request: Request) -> None:
    route = request.scope.get("route")
    if (request.method, getattr(route, "path", None)) in PUBLIC_ROUTES:
        return
    token = bearer_token(request.headers.get("authorization"))
    if token is None:
        raise HTTPException(status_code=401, detail="Authentication required", headers={"WWW-Authenticate": "Bearer"})
    request.state.auditor = verify_request_token(token)


app = FastAPI(title="AI Audit Copilot API", lifespan=lifespan, dependencies=[Depends(require_auditor), Depends(db_request_scope)])

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db_connection():
    """The current request's connection (opened on first use). Callers don't
    close it; db_request_scope does when the request ends."""
    holder = _request_db.get()
    if holder is None:  # outside a request: the caller owns the connection
        return psycopg.connect(DATABASE_URL)
    conn = holder["conn"]
    if conn is None or conn.closed or conn.broken:
        conn = holder["conn"] = psycopg.connect(DATABASE_URL)
    return conn


class SendEvidenceRequestPayload(BaseModel):
    to_email: str


class SendEvidenceRequestResponse(BaseModel):
    id: str
    token: str
    upload_url: str
    resend_response: dict[str, Any] | None = None


class EngagementResponse(BaseModel):
    id: str
    name: str
    client_name: str
    industry: str | None = None
    company_size: str | None = None
    description: str | None = None
    frameworks: list[str] = []
    period_start: str
    period_end: str
    lead_auditor: str


VALID_FRAMEWORKS = {"SOC2", "ISO27001"}
VALID_COMPANY_SIZES = {"startup", "smb", "mid_market", "enterprise"}


class CreateEngagementPayload(BaseModel):
    client_name: str
    name: str
    industry: str
    company_size: str
    description: str | None = None
    frameworks: list[str]
    period_start: str
    period_end: str
    lead_auditor: str


def ensure_engagement_schema(cur) -> None:
    """Idempotent, lazy DDL -- same pattern as upload_evidence_file's table
    creation. `framework` (singular) predates multi-framework engagements
    and is now nullable/unused for new rows; `engagement_frameworks` is the
    real source of truth. Backfills any pre-existing engagement (eng_001)
    into the new table from its legacy `framework` value so it keeps
    working without a manual migration step."""
    cur.execute("ALTER TABLE engagements ADD COLUMN IF NOT EXISTS industry TEXT")
    cur.execute("ALTER TABLE engagements ADD COLUMN IF NOT EXISTS company_size TEXT")
    cur.execute("ALTER TABLE engagements ADD COLUMN IF NOT EXISTS description TEXT")
    # engagement ids are random hex (f"eng_{uuid.uuid4().hex}"), not
    # sequential -- ORDER BY id can't stand in for creation order the way it
    # does for a couple of the other tables. Needed once list_engagements()
    # (the post-sign-in redirect target) has more than one row to sort.
    cur.execute("ALTER TABLE engagements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()")
    cur.execute("ALTER TABLE engagements ALTER COLUMN framework DROP NOT NULL")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS engagement_frameworks (
            engagement_id TEXT NOT NULL REFERENCES engagements(id),
            framework TEXT NOT NULL CHECK (framework IN ('SOC2', 'ISO27001')),
            PRIMARY KEY (engagement_id, framework)
        )
        """
    )
    cur.execute(
        """
        INSERT INTO engagement_frameworks (engagement_id, framework)
        SELECT id, framework FROM engagements WHERE framework IN ('SOC2', 'ISO27001')
        ON CONFLICT DO NOTHING
        """
    )


@app.get("/health")
def healthcheck() -> dict[str, Any]:
    return {"status": "ok"}


@app.post("/engagements", response_model=EngagementResponse, status_code=201)
def create_engagement(payload: CreateEngagementPayload) -> EngagementResponse:
    bad_frameworks = set(payload.frameworks) - VALID_FRAMEWORKS
    if bad_frameworks:
        raise HTTPException(status_code=400, detail=f"Unsupported framework(s): {sorted(bad_frameworks)}")
    if not payload.frameworks:
        raise HTTPException(status_code=400, detail="At least one framework is required")
    if payload.company_size not in VALID_COMPANY_SIZES:
        raise HTTPException(status_code=400, detail=f"company_size must be one of {sorted(VALID_COMPANY_SIZES)}")

    engagement_id = f"eng_{uuid.uuid4().hex}"
    db = get_db_connection()
    with db.cursor() as cur:
        ensure_engagement_schema(cur)
        cur.execute(
            """
            INSERT INTO engagements (id, name, client_name, industry, company_size, description, period_start, period_end, lead_auditor)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                engagement_id,
                payload.name,
                payload.client_name,
                payload.industry,
                payload.company_size,
                payload.description,
                payload.period_start,
                payload.period_end,
                payload.lead_auditor,
            ),
        )
        for fw in payload.frameworks:
            cur.execute(
                "INSERT INTO engagement_frameworks (engagement_id, framework) VALUES (%s, %s)",
                (engagement_id, fw),
            )
        db.commit()

    return EngagementResponse(
        id=engagement_id,
        name=payload.name,
        client_name=payload.client_name,
        industry=payload.industry,
        company_size=payload.company_size,
        description=payload.description,
        frameworks=payload.frameworks,
        period_start=payload.period_start,
        period_end=payload.period_end,
        lead_auditor=payload.lead_auditor,
    )


class CreateStakeholderPayload(BaseModel):
    full_name: str
    email: str
    role_title: str


class StakeholderResponse(BaseModel):
    id: str
    full_name: str
    email: str
    role_title: str


def ensure_stakeholder_schema(cur) -> None:
    """Lazy DDL, same pattern as ensure_engagement_schema. stakeholders
    predates multi-engagement support and was a single global list with no
    engagement_id at all -- fine for a one-engagement prototype, wrong the
    moment a second engagement exists (every engagement would see every
    other engagement's contacts). Nullable so any pre-existing rows don't
    break; new rows always set it."""
    cur.execute("ALTER TABLE stakeholders ADD COLUMN IF NOT EXISTS engagement_id TEXT REFERENCES engagements(id)")


@app.post("/engagements/{engagement_id}/stakeholders", response_model=StakeholderResponse, status_code=201)
def create_stakeholder(engagement_id: str, payload: CreateStakeholderPayload) -> StakeholderResponse:
    stakeholder_id = f"stk_{uuid.uuid4().hex}"
    db = get_db_connection()
    with db.cursor() as cur:
        ensure_stakeholder_schema(cur)
        cur.execute("SELECT id FROM engagements WHERE id = %s", (engagement_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="Engagement not found")
        cur.execute(
            "INSERT INTO stakeholders (id, full_name, email, role_title, engagement_id) VALUES (%s, %s, %s, %s, %s)",
            (stakeholder_id, payload.full_name, payload.email, payload.role_title, engagement_id),
        )
        db.commit()
    return StakeholderResponse(
        id=stakeholder_id, full_name=payload.full_name, email=payload.email, role_title=payload.role_title
    )


@app.get("/engagements/{engagement_id}/stakeholders")
def list_stakeholders(engagement_id: str) -> list[StakeholderResponse]:
    db = get_db_connection()
    with db.cursor() as cur:
        ensure_stakeholder_schema(cur)
        cur.execute(
            "SELECT id, full_name, email, role_title FROM stakeholders WHERE engagement_id = %s ORDER BY full_name",
            (engagement_id,),
        )
        rows = cur.fetchall()
        db.commit()
    return [StakeholderResponse(id=r[0], full_name=r[1], email=r[2], role_title=r[3]) for r in rows]


class CreateEvidenceRequestPayload(BaseModel):
    engagement_id: str
    stakeholder_id: str
    control_ref: str
    title: str
    description: str
    due_date: str


@app.post("/evidence-requests", status_code=201)
def create_evidence_request(payload: CreateEvidenceRequestPayload) -> dict[str, Any]:
    db = get_db_connection()
    with db.cursor() as cur:
        cur.execute("SELECT id FROM engagements WHERE id = %s", (payload.engagement_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="Engagement not found")
        cur.execute("SELECT id FROM stakeholders WHERE id = %s", (payload.stakeholder_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="Stakeholder not found")

        request_id = f"req_{uuid.uuid4().hex}"
        cur.execute(
            """
            INSERT INTO evidence_requests
                (id, engagement_id, stakeholder_id, control_ref, title, description, status, due_date, sent_at, reminder_count, token, last_activity_at)
            VALUES (%s, %s, %s, %s, %s, %s, 'not_sent', %s, NULL, 0, NULL, NOW())
            """,
            (request_id, payload.engagement_id, payload.stakeholder_id, payload.control_ref, payload.title, payload.description, payload.due_date),
        )
        log_activity(cur, request_id, "You", "auditor", "Request created", payload.title)
        db.commit()

    return {
        "id": request_id,
        "engagement_id": payload.engagement_id,
        "control_ref": payload.control_ref,
        "title": payload.title,
        "description": payload.description,
        "stakeholder_id": payload.stakeholder_id,
        "status": "not_sent",
        "due_date": payload.due_date,
        "sent_at": None,
        "reminder_count": 0,
        "last_activity_at": datetime.now().isoformat(),
        "files": [],
    }


@app.post("/evidence-requests/{request_id}/send", response_model=SendEvidenceRequestResponse)
def send_magic_link(request_id: str, payload: SendEvidenceRequestPayload) -> SendEvidenceRequestResponse:
    db = get_db_connection()
    with db.cursor() as cur:
        cur.execute(
            "SELECT id, token, engagement_id, stakeholder_id FROM evidence_requests WHERE id = %s",
            (request_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Evidence request not found")

        request_row_id, existing_token, engagement_id, stakeholder_id = row

        token = existing_token or secrets.token_urlsafe(24)
        upload_url = f"{UPLOAD_BASE_URL}/{token}"

        if not existing_token:
            cur.execute(
                "UPDATE evidence_requests SET token = %s WHERE id = %s",
                (token, request_id),
            )
            db.commit()

        resend_response = None
        if RESEND_API_KEY:
            try:
                email_response = Emails.send(
                    {
                        "from": RESEND_FROM,
                        "to": [payload.to_email],
                        "subject": "Your evidence upload link",
                        "html": f"<p>Open your upload link:</p><p><a href=\"{upload_url}\">{upload_url}</a></p>",
                    }
                )
                resend_response = dict(email_response)
            except ResendError as exc:
                error_detail = {
                    "message": "Resend API request failed",
                    "error": str(exc),
                }
                if hasattr(exc, "headers"):
                    error_detail["headers"] = exc.headers
                raise HTTPException(status_code=502, detail=error_detail)
            except Exception as exc:
                raise HTTPException(
                    status_code=502,
                    detail={
                        "message": "Could not contact Resend API",
                        "error": str(exc),
                    },
                )

        # Every pre-existing caller of this endpoint was a seeded request
        # that started life already at "awaiting_upload", so this update
        # never mattered before. Requests created via POST /evidence-requests
        # start at "not_sent" -- this is the transition out of that state,
        # and the only place "sent_at" and "reminder_count" get touched at
        # all right now (a real "send reminder" action would increment
        # reminder_count from here too; not built yet).
        cur.execute(
            "UPDATE evidence_requests SET status = 'awaiting_upload', sent_at = NOW(), last_activity_at = NOW() WHERE id = %s AND status = 'not_sent'",
            (request_id,),
        )
        log_activity(cur, request_id, "You", "auditor", "Request sent", f"Sent to {payload.to_email}")
        db.commit()

    return SendEvidenceRequestResponse(
        id=request_row_id,
        token=token,
        upload_url=upload_url,
        resend_response=resend_response,
    )


VALID_DECISIONS = {"approve", "reject", "request_more"}
DECISION_STATUS = {"approve": "approved", "reject": "rejected", "request_more": "changes_requested"}
DECISION_ACTION = {
    "approve": "Evidence approved",
    "reject": "Evidence rejected",
    "request_more": "More evidence requested",
}


class SubmitDecisionPayload(BaseModel):
    decision: str
    note: str = ""
    decided_by: str


def ensure_review_decisions_schema(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS review_decisions (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL REFERENCES evidence_requests(id),
            decision TEXT NOT NULL CHECK (decision IN ('approve','reject','request_more')),
            note TEXT,
            decided_by TEXT NOT NULL,
            decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )


# The review panel's Approve / Reject / Request more evidence buttons used to
# only set local component state ("prototype — nothing was saved") -- no
# review_decisions table existed, and this is the endpoint that writes to
# it. Real persistence: the decision row, the request's status flip, and an
# activity_log entry, all in one commit.
@app.post("/evidence-requests/{request_id}/decision")
def submit_decision(request_id: str, payload: SubmitDecisionPayload) -> dict[str, Any]:
    if payload.decision not in VALID_DECISIONS:
        raise HTTPException(status_code=400, detail=f"decision must be one of {sorted(VALID_DECISIONS)}")

    db = get_db_connection()
    with db.cursor() as cur:
        ensure_review_decisions_schema(cur)
        cur.execute("SELECT id FROM evidence_requests WHERE id = %s", (request_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="Evidence request not found")

        decision_id = f"dec_{uuid.uuid4().hex}"
        cur.execute(
            "INSERT INTO review_decisions (id, request_id, decision, note, decided_by) VALUES (%s, %s, %s, %s, %s)",
            (decision_id, request_id, payload.decision, payload.note or None, payload.decided_by),
        )
        cur.execute(
            "UPDATE evidence_requests SET status = %s, last_activity_at = NOW() WHERE id = %s",
            (DECISION_STATUS[payload.decision], request_id),
        )
        log_activity(cur, request_id, payload.decided_by, "auditor", DECISION_ACTION[payload.decision], payload.note or None)
        cur.execute("SELECT decided_at FROM review_decisions WHERE id = %s", (decision_id,))
        decided_at = cur.fetchone()[0]
        db.commit()

    return {
        "id": decision_id,
        "decision": payload.decision,
        "note": payload.note,
        "decided_by": payload.decided_by,
        "decided_at": decided_at.isoformat() if decided_at else "",
    }


@app.get("/engagements", response_model=list[EngagementResponse])
def list_engagements() -> list[EngagementResponse]:
    """Powers the post-sign-in landing redirect (see /engagements/page.tsx):
    no per-user scoping exists yet (lead_auditor is a plain display name,
    not a Clerk user id -- a real multi-tenant fix, not done here), so this
    is every engagement in the database, most recent first."""
    db = get_db_connection()
    with db.cursor() as cur:
        ensure_engagement_schema(cur)
        cur.execute(
            """
            SELECT e.id, e.name, e.client_name, e.industry, e.company_size, e.description,
                   e.period_start, e.period_end, e.lead_auditor,
                   COALESCE(array_agg(f.framework) FILTER (WHERE f.framework IS NOT NULL), '{}')
            FROM engagements e
            LEFT JOIN engagement_frameworks f ON f.engagement_id = e.id
            GROUP BY e.id, e.created_at
            ORDER BY e.created_at DESC NULLS LAST
            """
        )
        rows = cur.fetchall()
        db.commit()
    return [
        EngagementResponse(
            id=r[0], name=r[1], client_name=r[2], industry=r[3], company_size=r[4], description=r[5],
            period_start=r[6].isoformat() if r[6] else "", period_end=r[7].isoformat() if r[7] else "",
            lead_auditor=r[8], frameworks=r[9] or [],
        )
        for r in rows
    ]


@app.get("/engagements/{engagement_id}", response_model=EngagementResponse)
def get_engagement(engagement_id: str) -> EngagementResponse:
    db = get_db_connection()
    with db.cursor() as cur:
        ensure_engagement_schema(cur)
        db.commit()
        cur.execute(
            "SELECT id, name, client_name, industry, company_size, description, period_start, period_end, lead_auditor FROM engagements WHERE id = %s",
            (engagement_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Engagement not found")

        cur.execute(
            "SELECT framework FROM engagement_frameworks WHERE engagement_id = %s ORDER BY framework",
            (engagement_id,),
        )
        frameworks = [r[0] for r in cur.fetchall()]

        return EngagementResponse(
            id=row[0],
            name=row[1],
            client_name=row[2],
            industry=row[3],
            company_size=row[4],
            description=row[5],
            frameworks=frameworks,
            # bug: these come back as datetime.date from psycopg, not str —
            # EngagementResponse.period_start/end are typed str, so this 500'd
            # on every call until now.
            period_start=row[6].isoformat() if row[6] else "",
            period_end=row[7].isoformat() if row[7] else "",
            lead_auditor=row[8],
        )


def _iso(value):
    return value.isoformat() if value is not None else None


@app.get("/engagements/{engagement_id}/report")
def get_engagement_report(engagement_id: str):
    """Everything the printable report shows, in one response: the engagement,
    each request with its files, the AI review of each file (labelled as
    AI-generated), the auditor's decision and the activity trail, plus a
    coverage summary of what was not reviewed or only partly reviewed."""
    db = get_db_connection()
    with db.cursor() as cur:
        ensure_engagement_schema(cur)
        ensure_evidence_schema(cur)
        ensure_review_decisions_schema(cur)
        db.commit()

        cur.execute(
            "SELECT id, name, client_name, period_start, period_end, lead_auditor FROM engagements WHERE id = %s",
            (engagement_id,),
        )
        e = cur.fetchone()
        if e is None:
            raise HTTPException(status_code=404, detail="Engagement not found")
        cur.execute("SELECT framework FROM engagement_frameworks WHERE engagement_id = %s ORDER BY framework", (engagement_id,))
        engagement = {
            "id": e[0],
            "name": e[1],
            "client_name": e[2],
            "frameworks": [r[0] for r in cur.fetchall()],
            "period_start": _iso(e[3]),
            "period_end": _iso(e[4]),
            "lead_auditor": e[5],
        }

        cur.execute(
            """
            SELECT r.id, r.control_ref, r.title, r.description, r.status, r.due_date, s.full_name, s.role_title
            FROM evidence_requests r LEFT JOIN stakeholders s ON s.id = r.stakeholder_id
            WHERE r.engagement_id = %s ORDER BY r.due_date, r.control_ref, r.id
            """,
            (engagement_id,),
        )
        requests = [
            {
                "id": r[0],
                "control_ref": r[1],
                "title": r[2],
                "description": r[3],
                "status": r[4],
                "due_date": _iso(r[5]),
                "stakeholder": {"full_name": r[6], "role_title": r[7]} if r[6] else None,
            }
            for r in cur.fetchall()
        ]
        request_ids = [r["id"] for r in requests]

        cur.execute(
            """
            SELECT f.id, f.evidence_request_id, f.filename, f.size_bytes, f.uploaded_at
            FROM evidence_files f JOIN evidence_requests r ON r.id = f.evidence_request_id
            WHERE r.engagement_id = %s
            """,
            (engagement_id,),
        )
        files = [
            {"id": f[0], "evidence_request_id": f[1], "filename": f[2], "size_bytes": f[3], "uploaded_at": _iso(f[4])}
            for f in cur.fetchall()
        ]

        # newest review per file
        cur.execute(
            """
            SELECT DISTINCT ON (a.evidence_file_id)
                a.evidence_file_id, a.document_type, a.summary, a.suggested_controls,
                a.missing_sections, a.completeness_label, a.raw_response, a.created_at
            FROM ai_reviews a
            JOIN evidence_files f ON f.id = a.evidence_file_id
            JOIN evidence_requests r ON r.id = f.evidence_request_id
            WHERE r.engagement_id = %s
            ORDER BY a.evidence_file_id, a.created_at DESC
            """,
            (engagement_id,),
        )
        reviews_by_file = {
            a[0]: {
                "document_type": a[1],
                "summary": a[2],
                "suggested_controls": a[3],
                "missing_sections": a[4],
                "completeness_label": a[5],
                "raw_response": a[6],
                "created_at": _iso(a[7]),
            }
            for a in cur.fetchall()
        }

        cur.execute(
            """
            SELECT DISTINCT ON (request_id) request_id, decision, note, decided_by, decided_at
            FROM review_decisions WHERE request_id = ANY(%s)
            ORDER BY request_id, decided_at DESC
            """,
            (request_ids,),
        )
        decisions_by_request = {
            d[0]: {"decision": d[1], "note": d[2], "decided_by": d[3], "decided_at": _iso(d[4])} for d in cur.fetchall()
        }

        cur.execute(
            "SELECT request_id, actor, actor_type, action, detail, created_at FROM activity_log WHERE request_id = ANY(%s) ORDER BY created_at",
            (request_ids,),
        )
        activity = [
            {"request_id": a[0], "actor": a[1], "actor_type": a[2], "action": a[3], "detail": a[4], "created_at": _iso(a[5])}
            for a in cur.fetchall()
        ]

    return build_report(
        engagement=engagement,
        requests=requests,
        files=files,
        reviews_by_file=reviews_by_file,
        decisions_by_request=decisions_by_request,
        activity=activity,
        generated_at=datetime.now().astimezone().isoformat(),
    )


@app.get("/engagements/{engagement_id}/evidence-requests")
def get_engagement_requests(engagement_id: str):
    return list_requests_for_engagement(engagement_id)


@app.get("/engagements/{engagement_id}/evidence-files")
def get_engagement_evidence_files(engagement_id: str):
    return list_evidence_files_for_engagement(engagement_id)


@app.get("/engagements/{engagement_id}/activity")
def get_engagement_activity(engagement_id: str, limit: int = 20):
    db = get_db_connection()
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT a.id, a.request_id, r.title, a.actor, a.actor_type, a.action, a.detail, a.created_at
            FROM activity_log a
            JOIN evidence_requests r ON a.request_id = r.id
            WHERE r.engagement_id = %s
            ORDER BY a.created_at DESC
            LIMIT %s
            """,
            (engagement_id, limit),
        )
        rows = cur.fetchall()
    return [
        {
            "id": row[0],
            "request_id": row[1],
            "request_title": row[2],
            "actor": row[3],
            "actor_type": row[4],
            "action": row[5],
            "detail": row[6],
            "created_at": row[7].isoformat() if row[7] else "",
        }
        for row in rows
    ]


@app.get("/evidence-requests/{request_id}/activity")
def get_request_activity(request_id: str):
    db = get_db_connection()
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT id, actor, actor_type, action, detail, created_at
            FROM activity_log
            WHERE request_id = %s
            ORDER BY created_at DESC
            """,
            (request_id,),
        )
        rows = cur.fetchall()
    return [
        {
            "id": row[0],
            "actor": row[1],
            "actor_type": row[2],
            "action": row[3],
            "detail": row[4],
            "created_at": row[5].isoformat() if row[5] else "",
        }
        for row in rows
    ]


@app.get("/evidence-files/{file_id}/preview-url")
def get_evidence_file_preview_url(file_id: str):
    """A short-lived signed URL for the browser to render the original PDF
    directly from Supabase Storage. Nothing in the app could show a file's
    actual content before this -- see SECURITY.md, which needs updating now
    that this exists."""
    db = get_db_connection()
    with db.cursor() as cur:
        cur.execute("SELECT path FROM evidence_files WHERE id = %s", (file_id,))
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Evidence file not found")

    try:
        result = supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).create_signed_url(row[0], 300)
    except StorageApiError as exc:
        raise HTTPException(status_code=502, detail={"message": "Could not sign file URL", "error": str(exc)})
    return {"url": result["signedUrl"], "expires_in": 300}


@app.get("/upload/{token}", response_model=UploadLookupResponse)
def get_upload_lookup(token: str):
    return lookup_upload(token)


@app.get("/evidence-requests/{request_id}", response_model=RequestDetailResponse)
def get_request_detail_route(request_id: str):
    detail = get_request_detail(request_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Evidence request not found")
    return detail


# Catches unfilled template fields like "[DD-MM-YYYY]" or "[Organization
# Name]". Deliberately code-based, not AI judgment — the model will happily
# call a document "complete" even with visible placeholder brackets still in
# it, so this acts as a hard floor underneath whatever it concludes.
PLACEHOLDER_PATTERN = re.compile(r"\[[^\[\]\n]{1,50}\]")

COMPLETENESS_RANK = {"insufficient": 0, "partial": 1, "complete": 2}


def find_unfilled_placeholders(text: str) -> list[str]:
    """Unique bracketed spans that look like unfilled template placeholders.
    Skips brackets containing only digits/punctuation (e.g. "[1]", "[12]")
    since those are almost always citation/footnote refs, not placeholders —
    a real placeholder has at least one letter in it."""
    seen: dict[str, None] = {}
    for match in PLACEHOLDER_PATTERN.findall(text):
        inner = match[1:-1].strip()
        if inner and re.search(r"[A-Za-z]", inner):
            seen.setdefault(match, None)
    return list(seen.keys())


def apply_placeholder_check(parsed: dict, full_text: str) -> dict:
    """Caps completeness_label at "partial" and appends a missing_sections
    note if the document still has unfilled template placeholders — this
    overrides the AI's own completeness judgment, it doesn't just advise it."""
    placeholders = find_unfilled_placeholders(full_text)
    if not placeholders:
        return parsed

    current_label = parsed.get("completeness_label")
    if COMPLETENESS_RANK.get(current_label, COMPLETENESS_RANK["complete"]) > COMPLETENESS_RANK["partial"]:
        parsed["completeness_label"] = "partial"

    missing = parsed.get("missing_sections")
    missing = list(missing) if isinstance(missing, list) else []
    shown = ", ".join(placeholders[:5])
    if len(placeholders) > 5:
        shown += f", +{len(placeholders) - 5} more"
    note = f"Document contains unfilled template fields: {shown}."
    if not any("unfilled template field" in str(m).lower() for m in missing):
        missing.append(note)
    parsed["missing_sections"] = missing
    return parsed


def log_activity(cur, request_id: str, actor: str, actor_type: str, action: str, detail: str | None = None) -> None:
    """Appends one row to activity_log. activity_log has existed as a table
    since seed.py's DDL, but nothing ever wrote to it until now -- the
    dashboard's "recent activity" and each request's activity timeline both
    read real rows from here now instead of showing nothing."""
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS activity_log (
            id TEXT PRIMARY KEY,
            request_id TEXT REFERENCES evidence_requests(id),
            actor TEXT NOT NULL,
            actor_type TEXT NOT NULL,
            action TEXT NOT NULL,
            detail TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cur.execute(
        "INSERT INTO activity_log (id, request_id, actor, actor_type, action, detail) VALUES (%s, %s, %s, %s, %s, %s)",
        (f"act_{uuid.uuid4().hex}", request_id, actor, actor_type, action, detail),
    )


def extract_pdf_text(contents: bytes) -> str:
    try:
        reader = PdfReader(io.BytesIO(contents))
        text_parts = []
        for p in reader.pages:
            page_text = p.extract_text() or ""
            text_parts.append(page_text)
        return "\n".join(text_parts)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "This PDF couldn't be read. It may be corrupt or password-protected.",
                "error": str(exc),
            },
        )


def request_groq_review(doc_text: str) -> tuple[dict, dict | None]:
    # Prepare the review prompt. No missing-key check here -- _check_required_env_vars()
    # already guarantees GROQ_API_KEY is set for the lifetime of the process,
    # or the app never started.
    system_msg = (
        "You are a compliance reviewer. Given the raw extracted text of a policy document, "
        "return ONLY a JSON object with the following keys: document_type, summary, suggested_controls, missing_sections, completeness_label. "
        "- document_type: short label like \"access control policy\"\n"
        "- summary: 3-5 sentence summary\n"
        "- suggested_controls: array of objects {control_name, confidence_label, rationale} where confidence_label is one of strong_match/partial_match/weak_match\n"
        "- missing_sections: array of strings\n"
        "- completeness_label: one of complete/partial/insufficient\n"
        "Ensure the JSON parses cleanly; do not include any extra commentary."
    )

    prompt = f"Analyze the following document text:\n---\n{doc_text}\n---\nRespond as JSON per the schema."

    # llama-3.3-70b-versatile (originally requested) isn't in this account's
    # model catalog -- confirmed via client.models.list(), not assumed;
    # Groq's lineup turns over. openai/gpt-oss-120b is the largest
    # instruction-following chat model actually available, and JSON mode
    # verified working against it directly before wiring it in here.
    GROQ_MODEL = "openai/gpt-oss-120b"
    try:
        # Groq's chat-completions API is OpenAI-shaped (messages array,
        # response_format for JSON mode) rather than Gemini's
        # system_instruction/generation_config split -- same prompt, same
        # schema, different envelope.
        completion = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": system_msg},
                {"role": "user", "content": prompt},
            ],
            temperature=0.0,
            max_tokens=4096,
            response_format={"type": "json_object"},
        )
        assistant_text = completion.choices[0].message.content
        # Same "raw_response JSONB" shape downstream expects (mapWireAiReview
        # in apps/web/src/lib/api.ts reads model_resolved/model_requested off
        # this) -- sourced from Groq now instead of Gemini.
        body = {
            "provider": "groq",
            "model_requested": GROQ_MODEL,
            "model_resolved": completion.model,
            "text": assistant_text,
            "finish_reason": completion.choices[0].finish_reason,
        }
        parsed = None
        if assistant_text:
            try:
                parsed = json.loads(assistant_text)
            except Exception:
                parsed = None
    except Exception as exc:
        raise HTTPException(status_code=502, detail={"message": "Groq API request failed", "error": str(exc)})
    return body, parsed


def ensure_evidence_schema(cur) -> None:
    """evidence_files / ai_reviews are created lazily (there are no
    migrations), so anything that reads them must make sure they exist."""
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS evidence_files (
            id TEXT PRIMARY KEY,
            evidence_request_id TEXT,
            filename TEXT,
            path TEXT,
            size_bytes BIGINT,
            uploaded_at TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )
    # Lazy migration for a table created before size_bytes existed, and
    # before `path` was repurposed to hold a Supabase Storage object key
    # instead of a local filesystem path.
    cur.execute("ALTER TABLE evidence_files ADD COLUMN IF NOT EXISTS size_bytes BIGINT")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_reviews (
            id TEXT PRIMARY KEY,
            evidence_file_id TEXT REFERENCES evidence_files(id),
            document_type TEXT,
            summary TEXT,
            suggested_controls JSONB,
            missing_sections JSONB,
            completeness_label TEXT,
            raw_response JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )


MAX_UPLOAD_BYTES = 15 * 1024 * 1024


def _authorize_upload(db, request: Request, request_id: str) -> None:
    """An upload is allowed for a signed-in auditor, or for whoever holds the
    request's own magic-link token (sent as X-Upload-Token). A bearer token, if
    present, is judged on its own: an invalid one is 401 even if an upload
    token is also supplied. An unknown request is 403 to a token holder (it
    must not reveal which request ids exist) and 404 to an auditor."""
    bearer = bearer_token(request.headers.get("authorization"))
    supplied = request.headers.get("x-upload-token")
    if bearer is None and not supplied:
        raise HTTPException(status_code=401, detail="Authentication required", headers={"WWW-Authenticate": "Bearer"})
    if bearer is not None:
        request.state.auditor = verify_request_token(bearer)

    with db.cursor() as cur:
        cur.execute("SELECT token FROM evidence_requests WHERE id = %s", (request_id,))
        row = cur.fetchone()
    if bearer is not None:
        if row is None:
            raise HTTPException(status_code=404, detail="Evidence request not found")
        return
    stored = row[0] if row else None
    if not stored or not secrets.compare_digest(stored.encode(), supplied.encode()):
        raise HTTPException(status_code=403, detail="This upload link is not valid for this request")
logger = logging.getLogger("audit_copilot")


def _record_analysis_failure(db, request_id: str, detail: str, action: str = "AI analysis failed") -> None:
    with db.cursor() as cur:
        log_activity(cur, request_id, "AI review", "ai", action, detail)
        db.commit()


def analyse_and_store(db, request_id: str, file_id: str, full_text: str, prepared) -> dict | None:
    """Runs the review for one stored file and records the outcome. Shared by
    the upload and by re-analysis. Returns the review dict, or None when the
    model answered with something that is not a usable review (nothing is
    stored then, so the UI shows "no analysis" instead of a made-up verdict).
    Raises 502, after logging it, when the model call itself fails."""
    if prepared.has_text:
        try:
            body, parsed = request_groq_review(prepared.doc_text)
        except HTTPException as exc:
            # The file is saved and visible to the auditor; only the analysis
            # is missing. Say so in the activity log and in the response.
            detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
            _record_analysis_failure(db, request_id, str(detail.get("error") or detail.get("message")))
            raise HTTPException(status_code=exc.status_code, detail={**detail, "evidence_file_id": file_id})
        # Validate the model's JSON against the review schema before it is
        # stored or shown; None means it wasn't a JSON object at all.
        parsed = validate_model_review(parsed) if parsed is not None else None
        if parsed is None:
            logger.warning("Model returned no usable review for %s: %.500s", file_id, body.get("text"))
            _record_analysis_failure(db, request_id, "Model response was not a valid review object", action="AI analysis incomplete")
            return None
    else:
        # Scanned / image-only PDF: nothing to send. Don't ask the model to
        # review an empty document -- it returns a normal-looking review.
        body = {
            "provider": "none",
            "model_requested": None,
            "model_resolved": None,
            "text": None,
            "finish_reason": "skipped_no_text",
        }
        parsed = unreadable_review(prepared)

    # Code-based floors on completeness_label — run regardless of what the
    # model concluded. See apply_placeholder_check / apply_coverage_check.
    parsed = apply_placeholder_check(parsed, full_text)
    parsed = apply_coverage_check(parsed, prepared)
    body["chars_total"] = prepared.chars_total
    body["chars_reviewed"] = prepared.chars_reviewed
    body["truncated"] = prepared.truncated

    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO ai_reviews (id, evidence_file_id, document_type, summary, suggested_controls, missing_sections, completeness_label, raw_response) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                f"ai_{uuid.uuid4().hex}",
                file_id,
                parsed["document_type"],
                parsed["summary"],
                json.dumps(parsed["suggested_controls"]),
                json.dumps(parsed["missing_sections"]),
                parsed["completeness_label"],
                json.dumps(body),
            ),
        )
        if not prepared.has_text:
            log_activity(cur, request_id, "AI review", "ai", "AI analysis skipped", "No extractable text in PDF; the model was not called")
        else:
            flags = len(parsed["missing_sections"])
            detail = f"Classified as {parsed['document_type']} — completeness: {parsed['completeness_label']}"
            if flags:
                detail += f", {flags} item{'s' if flags != 1 else ''} flagged"
            log_activity(cur, request_id, "AI review", "ai", "AI analysis completed", detail)
        db.commit()
    return parsed


@app.post("/evidence-requests/{request_id}/upload")
def upload_evidence_file(request_id: str, request: Request, file: UploadFile = File(...)):
    # Everything that can be rejected is rejected BEFORE the first side
    # effect (storage, database), so a bad upload leaves nothing behind and a
    # retry can't create a duplicate.
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDF uploads are supported")

    db = get_db_connection()
    _authorize_upload(db, request, request_id)

    contents = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    if not contents:
        raise HTTPException(status_code=400, detail="The file is empty")
    # The content type is whatever the client claimed; check the bytes.
    if b"%PDF-" not in contents[:1024]:
        raise HTTPException(status_code=400, detail="This file doesn't look like a PDF")
    size_bytes = len(contents)

    # Extract text from the in-memory bytes first: a corrupt or encrypted PDF
    # is rejected (422) with nothing stored.
    full_text = extract_pdf_text(contents)
    prepared = prepare_review_text(full_text)

    file_id = f"file_{uuid.uuid4().hex}"
    storage_key = f"{file_id}.pdf"

    # Uploaded to Supabase Storage, not local disk -- local disk doesn't
    # survive a redeploy and isn't shared across instances/hosts. Nothing is
    # written to apps/api/uploads/ anymore; that directory is legacy.
    try:
        supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).upload(
            storage_key,
            contents,
            {"content-type": "application/pdf"},
        )
    except StorageApiError as exc:
        raise HTTPException(
            status_code=502,
            detail={"message": "Supabase Storage upload failed", "error": str(exc)},
        )

    with db.cursor() as cur:
        ensure_evidence_schema(cur)

        cur.execute(
            "INSERT INTO evidence_files (id, evidence_request_id, filename, path, size_bytes) VALUES (%s, %s, %s, %s, %s)",
            (file_id, request_id, storage_key, storage_key, size_bytes),
        )

        cur.execute(
            """
            SELECT s.full_name FROM evidence_requests r
            JOIN stakeholders s ON r.stakeholder_id = s.id
            WHERE r.id = %s
            """,
            (request_id,),
        )
        stakeholder_row = cur.fetchone()
        uploader_name = stakeholder_row[0] if stakeholder_row else "Stakeholder"
        log_activity(
            cur,
            request_id,
            uploader_name,
            "stakeholder",
            "Evidence uploaded",
            f"{storage_key} ({size_bytes:,} bytes)",
        )
        # The request's status moves with the file, in the same commit. It
        # used to move only after the model call, so a model failure left a
        # stored file on a request still reading "awaiting_upload" -- and the
        # retry then stored a second copy.
        cur.execute(
            "UPDATE evidence_requests SET status = %s, last_activity_at = NOW() WHERE id = %s",
            ("pending_review", request_id),
        )
        db.commit()

    parsed = analyse_and_store(db, request_id, file_id, full_text, prepared)

    return {
        "evidence_file": {"id": file_id, "filename": storage_key, "path": storage_key, "size_bytes": size_bytes},
        "ai_review": parsed if parsed else {"raw_response": None},
    }


@app.post("/evidence-files/{file_id}/analyse")
def reanalyse_evidence_file(file_id: str):
    """Re-runs the AI review for a stored file that has none (the model was
    down, or returned something unusable). Refuses if a review already exists,
    so a double click can't create two."""
    db = get_db_connection()
    with db.cursor() as cur:
        cur.execute("SELECT evidence_request_id, path FROM evidence_files WHERE id = %s", (file_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Evidence file not found")
        request_id, storage_key = row
        cur.execute("SELECT 1 FROM ai_reviews WHERE evidence_file_id = %s", (file_id,))
        if cur.fetchone() is not None:
            raise HTTPException(status_code=409, detail="This file already has an AI review")

    try:
        contents = supabase_client.storage.from_(SUPABASE_STORAGE_BUCKET).download(storage_key)
    except StorageApiError as exc:
        raise HTTPException(status_code=502, detail={"message": "Could not read the stored file", "error": str(exc)})

    full_text = extract_pdf_text(contents)
    prepared = prepare_review_text(full_text)
    parsed = analyse_and_store(db, request_id, file_id, full_text, prepared)
    return {"ai_review": parsed}


@app.get("/evidence-requests/{request_id}/review")
def get_evidence_review(request_id: str):
    db = get_db_connection()
    with db.cursor() as cur:
        cur.execute(
            "SELECT id, filename, path, uploaded_at FROM evidence_files WHERE evidence_request_id = %s ORDER BY uploaded_at DESC LIMIT 1",
            (request_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No evidence file found for request")
        # `path` is a Supabase Storage object key now, not a filesystem path
        # -- passed through as-is, the frontend doesn't currently render it.
        file_row = {"id": row[0], "filename": row[1], "path": row[2], "uploaded_at": row[3]}

        cur.execute(
            "SELECT id, document_type, summary, suggested_controls, missing_sections, completeness_label, raw_response, created_at FROM ai_reviews WHERE evidence_file_id = %s ORDER BY created_at DESC LIMIT 1",
            (file_row["id"],),
        )
        r = cur.fetchone()
        review = None
        if r:
            review = {
                "id": r[0],
                "document_type": r[1],
                "summary": r[2],
                "suggested_controls": r[3],
                "missing_sections": r[4],
                "completeness_label": r[5],
                "raw_response": r[6],
                "created_at": r[7],
            }

    return {"evidence_file": file_row, "ai_review": review}
