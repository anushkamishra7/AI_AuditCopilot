import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { StatusBadge } from "@/components/badges";
import { ControlChip } from "@/components/control-chip";
import { ReviewPanel } from "@/components/review/review-panel";
import { dueLabel } from "@/lib/format";
import { fetchEvidenceReview, fetchRequestDetail, fetchRequestActivity, mapWireAiReview } from "@/lib/api";
import {
  controlByRef,
  evidenceRequests,
  getActivityFor,
  getRequest,
  stakeholderById,
} from "@/lib/mock-data";
import type { ActivityEntry, EvidenceRequest, Stakeholder } from "@/lib/types";

export function generateStaticParams() {
  return evidenceRequests.map((r) => ({
    engagementId: r.engagement_id,
    requestId: r.id,
  }));
}

export default async function ReviewPage(
  props: PageProps<"/engagements/[engagementId]/requests/[requestId]">,
) {
  const { engagementId, requestId } = await props.params;

  // Real backend requests take priority; fall back to the mock-data
  // prototype set for IDs the API doesn't know about (e.g. req_014) so the
  // existing demo routes keep working unchanged.
  const apiDetail = await fetchRequestDetail(requestId);

  let request: EvidenceRequest;
  let stakeholder: Stakeholder;
  let activity: ActivityEntry[];

  if (apiDetail) {
    const [reviewWire, apiActivity] = await Promise.all([
      fetchEvidenceReview(requestId),
      fetchRequestActivity(requestId),
    ]);
    request = {
      ...apiDetail.request,
      ai_review: reviewWire ? mapWireAiReview(reviewWire) : null,
    };
    stakeholder = apiDetail.stakeholder;
    // Real activity_log rows now -- main.py writes to this table on upload
    // and on AI-analysis-complete (it didn't before). Rows logged before
    // that change won't have activity here.
    activity = apiActivity.map((a) => ({
      id: a.id,
      request_id: a.request_id ?? requestId,
      actor: a.actor,
      actor_type: a.actor_type,
      action: a.action,
      detail: a.detail,
      created_at: a.created_at,
    }));
  } else {
    const mockRequest = getRequest(requestId);
    if (!mockRequest) notFound();
    request = mockRequest;
    stakeholder = stakeholderById[request.stakeholder_id];
    activity = getActivityFor(request.id);
  }

  const control = controlByRef[request.control_ref];
  const due = dueLabel(request.due_date);

  const user = await currentUser();
  const decidedByName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.primaryEmailAddress?.emailAddress ||
    "Signed in auditor";

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur">
        <div className="px-7 py-3">
          <Link
            href={`/engagements/${engagementId}`}
            className="text-xs font-medium text-[var(--ink-muted)] hover:text-[var(--ink)]"
          >
            ← Overview
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <ControlChip refCode={request.control_ref} engagementId={engagementId} />
                <h1 className="text-lg leading-tight font-bold tracking-tight text-[var(--ink)]">{request.title}</h1>
                <StatusBadge status={request.status} />
              </div>
              <p className="mt-0.5 text-sm text-[var(--ink-muted)]">
                {control?.title} · Assigned to {stakeholder.full_name} ({stakeholder.role_title}) ·{" "}
                <span className={due.tone === "overdue" ? "font-semibold text-[var(--status-rose-ink)]" : ""}>
                  {due.text}
                </span>
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="bg-[var(--bg)]">
        <p className="border-b border-[var(--border)] bg-[var(--surface)] px-7 py-2 text-sm text-[var(--ink-muted)]">
          <span className="font-medium text-[var(--ink-secondary)]">Request sent to stakeholder:</span>{" "}
          {request.description}
        </p>
        <ReviewPanel request={request} stakeholder={stakeholder} activity={activity} decidedByName={decidedByName} />
      </main>
    </>
  );
}
