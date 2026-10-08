import type { AiReview, CompanySize, ConfidenceLabel, CompletenessLabel, DecisionType, Engagement, EvidenceRequest, Framework, ReviewDecision, Stakeholder, RequestStatus } from "@/lib/types";
import type { AuditorContact } from "@/lib/upload-link";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

declare global {
  interface Window {
    Clerk?: { loaded?: boolean; session?: { getToken: () => Promise<string | null> } | null };
  }
}

/** The signed-in auditor's Clerk session token, or null. On the server it
 * comes from the request's Clerk session; in the browser from the Clerk
 * client (waiting briefly if it hasn't finished loading yet). The server
 * branch is behind a `typeof window` check so it never reaches the browser
 * bundle. */
async function authToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    const { auth } = await import("@clerk/nextjs/server");
    const { getToken } = await auth();
    return getToken();
  }
  for (let i = 0; i < 30 && !window.Clerk?.loaded; i++) await new Promise((r) => setTimeout(r, 100));
  return (await window.Clerk?.session?.getToken()) ?? null;
}

/** fetch() for the auditor-facing API: adds `Authorization: Bearer <token>`.
 * Without a session the call goes out unauthenticated and the API answers
 * 401, which callers already treat like any other failed request. */
async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await authToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

interface WireDecision {
  id: string;
  decision: string;
  note: string | null;
  decided_by: string;
  decided_at: string;
}

// Wire shape actually returned by app/upload_lookup.py today. `ai_review`
// still isn't inlined here (this endpoint doesn't join ai_reviews) --
// `decision` now is, since review_decisions is a real table (see
// submitDecision below).
interface ApiEvidenceRequestWire {
  id: string;
  engagement_id: string;
  control_ref: string;
  title: string;
  description: string;
  stakeholder_id: string;
  status: string;
  due_date: string;
  sent_at: string | null;
  reminder_count: number;
  last_activity_at: string;
  files: Array<{ id: string; filename: string; mime_type: string; size_bytes: number; page_count: number | null; uploaded_at: string; uploaded_by_stakeholder_id: string }>;
  decision?: WireDecision | null;
}

interface ApiLookupWire {
  kind: "active" | "invalid" | "expired";
  request?: ApiEvidenceRequestWire;
  stakeholder?: Stakeholder;
  auditor?: AuditorContact;
}

// Discriminated on `kind` so callers get `request`/`stakeholder`/`auditor` as
// non-optional once they've checked kind === "active". `request` is the full
// app-wide EvidenceRequest shape — see mapWireRequest for how the (currently
// unavailable) ai_review field is filled in.
export type UploadLookupResponse =
  | { kind: "active"; request: EvidenceRequest; stakeholder: Stakeholder; auditor: AuditorContact }
  | { kind: "expired"; auditor?: AuditorContact }
  | { kind: "invalid" };

function mapWireDecision(d: WireDecision | null | undefined): ReviewDecision | null {
  if (!d) return null;
  return { id: d.id, decision: d.decision as DecisionType, note: d.note ?? "", decided_by: d.decided_by, decided_at: d.decided_at };
}

function mapWireRequest(wire: ApiEvidenceRequestWire): EvidenceRequest {
  return {
    ...wire,
    status: wire.status as RequestStatus,
    // Not yet returned by the backend — this endpoint doesn't join
    // ai_reviews. Real elsewhere (fetchEvidenceReview, fetchEngagementRequests).
    ai_review: null,
    decision: mapWireDecision(wire.decision),
  };
}

export async function lookupUploadToken(token: string): Promise<UploadLookupResponse> {
  const response = await fetch(`${API_BASE_URL}/upload/${encodeURIComponent(token)}`);
  if (!response.ok) {
    return { kind: "invalid" };
  }
  const wire: ApiLookupWire = await response.json();

  if (wire.kind !== "active") {
    return { kind: wire.kind, auditor: wire.auditor } as UploadLookupResponse;
  }
  if (!wire.request || !wire.stakeholder || !wire.auditor) {
    // Backend said "active" but didn't send what that implies — treat as
    // invalid rather than crash the page on a malformed response.
    return { kind: "invalid" };
  }
  return {
    kind: "active",
    request: mapWireRequest(wire.request),
    stakeholder: wire.stakeholder,
    auditor: wire.auditor,
  };
}

// --- GET /evidence-requests/{id} — powers the review panel's request detail
// (title, description, status, submitted files). Distinct from the upload
// endpoint above: this one is keyed by request id, not magic-link token, and
// its `files` are the real submitted list (see app/upload_lookup.py's
// get_request_detail vs lookup_upload).
interface RequestDetailWire {
  request: ApiEvidenceRequestWire;
  stakeholder: Stakeholder;
}

export async function fetchRequestDetail(
  requestId: string,
): Promise<{ request: EvidenceRequest; stakeholder: Stakeholder } | null> {
  const response = await apiFetch(`${API_BASE_URL}/evidence-requests/${encodeURIComponent(requestId)}`, {
    cache: "no-store",
  });
  if (!response.ok) return null;
  const wire: RequestDetailWire = await response.json();
  return { request: mapWireRequest(wire.request), stakeholder: wire.stakeholder };
}

// --- GET /evidence-requests/{id}/review — the actual AI output for the
// most recently submitted file. `ai_review` is null when a file was
// uploaded but analysis hasn't produced a row yet (see main.py); the whole
// call 404s when no file has been submitted at all.
interface WireSuggestedControl {
  control_name: string;
  confidence_label: ConfidenceLabel;
  rationale: string;
}

interface WireAiReview {
  id: string;
  document_type: string | null;
  summary: string | null;
  suggested_controls: WireSuggestedControl[] | null;
  missing_sections: string[] | null;
  completeness_label: CompletenessLabel | null;
  raw_response: { model_requested?: string; model_resolved?: string } | null;
  created_at: string;
}

interface EvidenceReviewWire {
  evidence_file: { id: string; filename: string; path: string; uploaded_at: string };
  ai_review: WireAiReview | null;
}

export async function fetchEvidenceReview(requestId: string): Promise<EvidenceReviewWire | null> {
  const response = await apiFetch(`${API_BASE_URL}/evidence-requests/${encodeURIComponent(requestId)}/review`, {
    cache: "no-store",
  });
  // 404 means no file has been submitted yet — same "nothing to show" case
  // as a null ai_review, just one step earlier.
  if (!response.ok) return null;
  return response.json();
}

/** Maps the wire review shape onto the app-wide AiReview type. Fields the
 * real pipeline doesn't produce (doc_type_alternatives, excerpts) are left
 * empty rather than fabricated — the UI already hides those sections when
 * empty, so this doesn't imply capability that isn't there. Shared by the
 * review-panel fetch (fetchEvidenceReview, one request at a time) and the
 * dashboard list fetch (fetchEngagementRequests, ai_review inlined per row)
 * below. */
function mapWireAiReviewInner(r: WireAiReview | null, evidenceFileId: string): AiReview | null {
  if (!r) return null;
  return {
    id: r.id,
    evidence_file_id: evidenceFileId,
    model: r.raw_response?.model_resolved || r.raw_response?.model_requested || "unknown model",
    reviewed_at: r.created_at,
    doc_type: r.document_type ?? "Unclassified document",
    doc_type_alternatives: [],
    summary: r.summary ?? "",
    completeness: r.completeness_label ?? "insufficient",
    suggested_control_refs: (r.suggested_controls ?? []).map((c) => c.control_name),
    suggested_controls: r.suggested_controls ?? undefined,
    flags: (r.missing_sections ?? []).map((section, i) => ({
      id: `missing_${i}`,
      severity: "warning" as const,
      title: section,
      detail: "",
      location: null,
    })),
    excerpts: [],
  };
}

export function mapWireAiReview(wire: EvidenceReviewWire): AiReview | null {
  return mapWireAiReviewInner(wire.ai_review, wire.evidence_file.id);
}

// --- GET /engagements/{id} — engagement header info for the dashboard.
export async function fetchEngagement(engagementId: string): Promise<Engagement | null> {
  const response = await apiFetch(`${API_BASE_URL}/engagements/${encodeURIComponent(engagementId)}`, {
    cache: "no-store",
  });
  if (!response.ok) return null;
  return response.json();
}

// --- POST /engagements — real creation, backs the /engagements/new form.
export interface CreateEngagementInput {
  client_name: string;
  name: string;
  industry: string;
  company_size: CompanySize;
  description?: string;
  frameworks: Framework[];
  period_start: string;
  period_end: string;
  lead_auditor: string;
}

export type CreateEngagementResult = { ok: true; engagement: Engagement } | { ok: false; message: string };

export async function createEngagement(input: CreateEngagementInput): Promise<CreateEngagementResult> {
  let response: Response;
  try {
    response = await apiFetch(`${API_BASE_URL}/engagements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (exc) {
    return { ok: false, message: exc instanceof Error ? exc.message : "Network error" };
  }
  if (response.ok) return { ok: true, engagement: await response.json() };

  let message = `Could not create engagement (HTTP ${response.status})`;
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") message = body.detail;
  } catch {
    // non-JSON error body — keep the generic message
  }
  return { ok: false, message };
}

// --- GET /engagements/{id}/evidence-requests — every real evidence request
// for the engagement, each with its ai_review inlined. Powers the evidence
// dashboard; replaces the old mock-data.ts evidenceRequests/stakeholderById.
interface ApiDashboardRequestWire extends ApiEvidenceRequestWire {
  ai_review: WireAiReview | null;
}

interface ApiDashboardWire {
  requests: ApiDashboardRequestWire[];
  stakeholders: Stakeholder[];
}

export async function fetchEngagementRequests(
  engagementId: string,
): Promise<{ requests: EvidenceRequest[]; stakeholders: Record<string, Stakeholder> }> {
  const response = await apiFetch(
    `${API_BASE_URL}/engagements/${encodeURIComponent(engagementId)}/evidence-requests`,
    { cache: "no-store" },
  );
  if (!response.ok) return { requests: [], stakeholders: {} };

  const wire: ApiDashboardWire = await response.json();
  const stakeholders = Object.fromEntries(wire.stakeholders.map((s) => [s.id, s]));
  const requests: EvidenceRequest[] = wire.requests.map((r) => ({
    ...r,
    status: r.status as RequestStatus,
    ai_review: mapWireAiReviewInner(r.ai_review, r.files[0]?.id ?? ""),
    decision: mapWireDecision(r.decision),
  }));
  return { requests, stakeholders };
}

// --- POST /evidence-requests/{id}/upload — the stakeholder's actual file
// submission. One file per call (that's what the backend accepts); the
// upload form calls this once per selected file, sequentially.
export type UploadEvidenceFileResult =
  | { ok: true }
  | { ok: false; received: boolean; message: string };

/** Uploads one file. The stakeholder page passes the request's magic-link
 * token (the only credential a stakeholder has); the auditor console passes
 * none and the signed-in session token is used instead. */
export async function uploadEvidenceFile(
  requestId: string,
  file: File,
  uploadToken?: string,
): Promise<UploadEvidenceFileResult> {
  const formData = new FormData();
  formData.append("file", file);

  const url = `${API_BASE_URL}/evidence-requests/${encodeURIComponent(requestId)}/upload`;
  let response: Response;
  try {
    response = uploadToken
      ? await fetch(url, { method: "POST", body: formData, headers: { "X-Upload-Token": uploadToken } })
      : await apiFetch(url, { method: "POST", body: formData });
  } catch (exc) {
    return { ok: false, received: false, message: exc instanceof Error ? exc.message : "Network error" };
  }

  if (response.ok) return { ok: true };

  let message = `Upload failed (HTTP ${response.status})`;
  if (response.status === 401) message = "Your session has expired. Sign in again to upload.";
  if (response.status === 403) message = "This upload link is not valid for this request.";
  let received = false;
  try {
    const body = await response.json();
    const detail = body?.detail;
    const detailMessage = typeof detail === "string" ? detail : detail?.message;
    if (detailMessage) message = detailMessage;
    // main.py rejects bad uploads (not a PDF, too large, unreadable) before
    // storing anything, and saves the file and advances the request before it
    // calls the review model -- so the only failure where the evidence was
    // still received is the model call itself ("Groq API request failed").
    // The file is saved and the auditor can still see it; only the AI review
    // is missing.
    received = detailMessage === "Groq API request failed";
  } catch {
    // non-JSON error body — keep the generic HTTP-status message
  }
  return { ok: false, received, message };
}

// --- GET /engagements/{id}/activity and /evidence-requests/{id}/activity —
// real activity_log rows (main.py now actually writes to this table on
// upload + AI-analysis-complete; it didn't before).
export interface ActivityEvent {
  id: string;
  request_id?: string;
  request_title?: string;
  actor: string;
  actor_type: "auditor" | "stakeholder" | "system" | "ai";
  action: string;
  detail: string | null;
  created_at: string;
}

export async function fetchEngagementActivity(engagementId: string, limit = 20): Promise<ActivityEvent[]> {
  const response = await apiFetch(
    `${API_BASE_URL}/engagements/${encodeURIComponent(engagementId)}/activity?limit=${limit}`,
    { cache: "no-store" },
  );
  if (!response.ok) return [];
  return response.json();
}

export async function fetchRequestActivity(requestId: string): Promise<ActivityEvent[]> {
  const response = await apiFetch(`${API_BASE_URL}/evidence-requests/${encodeURIComponent(requestId)}/activity`, {
    cache: "no-store",
  });
  if (!response.ok) return [];
  return response.json();
}

// --- GET /engagements/{id}/evidence-files — flattened file list for the
// Evidence page.
export interface EvidenceFileRow {
  id: string;
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  request_id: string;
  request_title: string;
  control_ref: string;
  ai_review: { document_type: string | null; completeness_label: string | null; flag_count: number } | null;
}

export async function fetchEngagementEvidenceFiles(engagementId: string): Promise<EvidenceFileRow[]> {
  const response = await apiFetch(`${API_BASE_URL}/engagements/${encodeURIComponent(engagementId)}/evidence-files`, {
    cache: "no-store",
  });
  if (!response.ok) return [];
  const wire = await response.json();
  return wire.files ?? [];
}

// --- GET /evidence-files/{id}/preview-url — short-lived signed URL so the
// browser can render the original PDF directly from Supabase Storage.
export async function fetchFilePreviewUrl(fileId: string): Promise<string | null> {
  const response = await apiFetch(`${API_BASE_URL}/evidence-files/${encodeURIComponent(fileId)}/preview-url`, {
    cache: "no-store",
  });
  if (!response.ok) return null;
  const wire = await response.json();
  return wire.url ?? null;
}

// --- GET/POST /engagements/{id}/stakeholders — the engagement's contact
// list. Stakeholders used to be one untouched global table (fine for a
// single seeded engagement); this is the real per-engagement list.
export async function fetchEngagementStakeholders(engagementId: string): Promise<Stakeholder[]> {
  const response = await apiFetch(`${API_BASE_URL}/engagements/${encodeURIComponent(engagementId)}/stakeholders`, {
    cache: "no-store",
  });
  if (!response.ok) return [];
  return response.json();
}

export interface CreateStakeholderInput {
  full_name: string;
  email: string;
  role_title: string;
}

export type CreateStakeholderResult = { ok: true; stakeholder: Stakeholder } | { ok: false; message: string };

export async function createStakeholder(
  engagementId: string,
  input: CreateStakeholderInput,
): Promise<CreateStakeholderResult> {
  let response: Response;
  try {
    response = await apiFetch(`${API_BASE_URL}/engagements/${encodeURIComponent(engagementId)}/stakeholders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (exc) {
    return { ok: false, message: exc instanceof Error ? exc.message : "Network error" };
  }
  if (response.ok) return { ok: true, stakeholder: await response.json() };
  return { ok: false, message: await errorMessage(response, "Could not add stakeholder") };
}

// --- POST /evidence-requests — real creation, starts life at "not_sent"
// until someone calls sendEvidenceRequest below.
export interface CreateEvidenceRequestInput {
  engagement_id: string;
  stakeholder_id: string;
  control_ref: string;
  title: string;
  description: string;
  due_date: string;
}

export type CreateEvidenceRequestResult = { ok: true; request: EvidenceRequest } | { ok: false; message: string };

export async function createEvidenceRequest(
  input: CreateEvidenceRequestInput,
): Promise<CreateEvidenceRequestResult> {
  let response: Response;
  try {
    response = await apiFetch(`${API_BASE_URL}/evidence-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (exc) {
    return { ok: false, message: exc instanceof Error ? exc.message : "Network error" };
  }
  if (response.ok) {
    const wire: ApiEvidenceRequestWire = await response.json();
    return { ok: true, request: mapWireRequest(wire) };
  }
  return { ok: false, message: await errorMessage(response, "Could not create request") };
}

// --- POST /evidence-requests/{id}/send — generates (or reuses) the upload
// token, emails the stakeholder via Resend, and flips status from
// "not_sent" to "awaiting_upload".
export type SendEvidenceRequestResult = { ok: true; uploadUrl: string } | { ok: false; message: string };

export async function sendEvidenceRequest(requestId: string, toEmail: string): Promise<SendEvidenceRequestResult> {
  let response: Response;
  try {
    response = await apiFetch(`${API_BASE_URL}/evidence-requests/${encodeURIComponent(requestId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_email: toEmail }),
    });
  } catch (exc) {
    return { ok: false, message: exc instanceof Error ? exc.message : "Network error" };
  }
  if (response.ok) {
    const wire = await response.json();
    return { ok: true, uploadUrl: wire.upload_url };
  }
  return { ok: false, message: await errorMessage(response, "Could not send request") };
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  let message = `${fallback} (HTTP ${response.status})`;
  if (response.status === 401) message = "Your session has expired. Sign in again.";
  try {
    const body = await response.json();
    const detail = body?.detail;
    const detailMessage = typeof detail === "string" ? detail : detail?.message;
    if (detailMessage) message = detailMessage;
  } catch {
    // non-JSON error body — keep the generic message
  }
  return message;
}

// --- POST /evidence-files/{id}/analyse — re-runs the AI review for a stored
// file that has none (the model was down, or returned something unusable).
export type ReanalyseResult = { ok: true } | { ok: false; message: string };

export async function reanalyseEvidenceFile(fileId: string): Promise<ReanalyseResult> {
  let response: Response;
  try {
    response = await apiFetch(`${API_BASE_URL}/evidence-files/${encodeURIComponent(fileId)}/analyse`, { method: "POST" });
  } catch (exc) {
    return { ok: false, message: exc instanceof Error ? exc.message : "Network error" };
  }
  if (response.ok) return { ok: true };
  return { ok: false, message: await errorMessage(response, "Could not run the analysis") };
}

// --- POST /evidence-requests/{id}/decision — real persistence for the
// review panel's Approve / Reject / Request more evidence buttons. Used to
// be local component state only ("prototype — nothing was saved").
export type SubmitDecisionResult = { ok: true; decision: ReviewDecision } | { ok: false; message: string };

export async function submitDecision(
  requestId: string,
  input: { decision: DecisionType; note: string; decided_by: string },
): Promise<SubmitDecisionResult> {
  let response: Response;
  try {
    response = await apiFetch(`${API_BASE_URL}/evidence-requests/${encodeURIComponent(requestId)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (exc) {
    return { ok: false, message: exc instanceof Error ? exc.message : "Network error" };
  }
  if (response.ok) {
    const wire: WireDecision = await response.json();
    const decision = mapWireDecision(wire);
    if (!decision) return { ok: false, message: "Malformed response from server" };
    return { ok: true, decision };
  }
  return { ok: false, message: await errorMessage(response, "Could not record decision") };
}

// --- GET /engagements — every engagement that exists, most recent first.
// Powers the post-sign-in landing redirect (see app/(auth)/engagements/page.tsx):
// there's no per-user scoping yet (single-engagement-prototype era), so this
// is "does at least one engagement exist" rather than "this user's engagements".
export async function fetchEngagements(): Promise<Engagement[]> {
  const response = await apiFetch(`${API_BASE_URL}/engagements`, { cache: "no-store" });
  if (!response.ok) return [];
  return response.json();
}
