import Link from "next/link";
import { severityStyle } from "@/components/badges";
import { ControlChip } from "@/components/control-chip";
import { relativeTime } from "@/lib/format";
import type { EvidenceRequest, Stakeholder } from "@/lib/types";

// There's no standalone Findings entity in the database -- this page lists
// the real AI review output (flags + an "insufficient" completeness
// judgment) already stored per request, the same data the review panel
// shows one request at a time, gathered into one queue.
export function FindingsList({
  requests,
  stakeholders,
  engagementId,
}: {
  requests: EvidenceRequest[];
  stakeholders: Record<string, Stakeholder>;
  engagementId: string;
}) {
  if (requests.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--ink-muted)]">
        No AI review has flagged anything yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {requests.map((r) => {
        const review = r.ai_review!;
        const s = stakeholders[r.stakeholder_id];
        const href = `/engagements/${engagementId}/requests/${r.id}`;
        return (
          <section key={r.id} className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <ControlChip refCode={r.control_ref} engagementId={engagementId} />
                <Link href={href} className="truncate font-semibold text-[var(--ink)] hover:underline">
                  {r.title}
                </Link>
              </div>
              <span className="shrink-0 text-xs text-[var(--ink-faint)]">
                {s ? `${s.full_name} · ` : ""}
                {relativeTime(review.reviewed_at)}
              </span>
            </div>

            <div className="mt-3.5 flex flex-col gap-2">
              {review.completeness === "insufficient" && (
                <FindingRow
                  chip="border-[var(--status-rose-ring)] bg-[var(--status-rose-bg)]"
                  dot="bg-[var(--status-rose-dot)]"
                  label="Insufficient"
                  title="AI assessed this evidence as incomplete"
                  detail={review.summary}
                />
              )}
              {review.flags.map((f) => {
                const style = severityStyle(f.severity);
                return (
                  <FindingRow
                    key={f.id}
                    chip={style.chip}
                    dot={style.dot}
                    label={style.label}
                    title={f.title}
                    detail={f.detail}
                    location={f.location}
                  />
                );
              })}
            </div>

            <Link
              href={href}
              className="mt-3.5 inline-block text-xs font-semibold text-[var(--accent)] hover:underline"
            >
              Review evidence →
            </Link>
          </section>
        );
      })}
    </div>
  );
}

function FindingRow({
  chip,
  dot,
  label,
  title,
  detail,
  location,
}: {
  chip: string;
  dot: string;
  label: string;
  title: string;
  detail: string;
  location?: string | null;
}) {
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${chip}`}>
      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--ink)]">
          {title} <span className="ml-1 text-[11px] font-normal text-[var(--ink-muted)]">{label}</span>
        </p>
        <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">{detail}</p>
        {location && <p className="mt-0.5 font-mono text-[11px] text-[var(--ink-faint)]">{location}</p>}
      </div>
    </div>
  );
}
