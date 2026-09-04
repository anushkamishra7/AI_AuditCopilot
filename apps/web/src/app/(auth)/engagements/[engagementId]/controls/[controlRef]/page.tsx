import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge, CompletenessBadge, severityStyle } from "@/components/badges";
import { ControlChip } from "@/components/control-chip";
import { fetchEngagement, fetchEngagementRequests } from "@/lib/api";
import { groupByControl } from "@/lib/request-status";
import { controlByRef } from "@/lib/mock-data";
import { dueLabel, relativeTime } from "@/lib/format";

// The signature Evidence <-> Control relationship: every ControlChip in the
// app (evidence table, controls table, findings list, request header) now
// links here. There's still no real Controls entity in the database -- this
// page is the same real, control_ref-grouped data as /controls, filtered to
// one ref, not a fabricated control library. `control?.title` below only
// resolves for the handful of refs mock-data.ts happens to define; a
// control_ref created through the real app (anything not in that fixture
// list) just shows the ref itself, honestly, rather than a made-up name.
export default async function ControlDetailPage(
  props: PageProps<"/engagements/[engagementId]/controls/[controlRef]">,
) {
  const { engagementId, controlRef: rawControlRef } = await props.params;
  const controlRef = decodeURIComponent(rawControlRef);

  const engagement = await fetchEngagement(engagementId);
  if (!engagement) notFound();

  const { requests } = await fetchEngagementRequests(engagementId);
  const group = groupByControl(requests).find((g) => g.control_ref === controlRef);
  if (!group) notFound();

  const control = controlByRef[controlRef];
  const readinessLabel = group.ready ? "Ready" : group.overdue > 0 ? "Overdue" : group.needs_review > 0 ? "Needs review" : "Outstanding";
  const readinessStyle = group.ready
    ? "bg-[var(--status-emerald-bg)] text-[var(--status-emerald-ink)] ring-[var(--status-emerald-ring)]"
    : group.overdue > 0
      ? "bg-[var(--status-rose-bg)] text-[var(--status-rose-ink)] ring-[var(--status-rose-ring)]"
      : group.needs_review > 0
        ? "bg-[var(--status-amber-bg)] text-[var(--status-amber-ink)] ring-[var(--status-amber-ring)]"
        : "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-ink)] ring-[var(--status-neutral-ring)]";

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur">
        <div className="px-7 py-3">
          <Link
            href={`/engagements/${engagementId}/controls`}
            className="text-xs font-medium text-[var(--ink-muted)] hover:text-[var(--ink)]"
          >
            ← Controls
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <ControlChip refCode={group.control_ref} />
            <h1 className="text-lg leading-tight font-bold tracking-tight text-[var(--ink)]">
              {control?.title ?? group.control_ref}
            </h1>
            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${readinessStyle}`}>
              {readinessLabel}
            </span>
          </div>
          {control?.category && <p className="mt-0.5 text-sm text-[var(--ink-muted)]">{control.category}</p>}
        </div>
      </header>

      <main className="bg-[var(--bg)] p-7">
        {/* Real counts, same numbers /controls shows for this row -- not
            re-derived differently here. */}
        <div className="mb-6 grid grid-cols-3 gap-4 sm:max-w-md">
          <Stat label="Evidence requests" value={group.requests.length} />
          <Stat label="Needs review" value={group.needs_review} tone={group.needs_review > 0 ? "amber" : undefined} />
          <Stat label="Overdue" value={group.overdue} tone={group.overdue > 0 ? "rose" : undefined} />
        </div>

        <h2 className="mb-3 text-[11px] font-semibold tracking-wider text-[var(--ink-faint)] uppercase">
          Evidence against this control
        </h2>
        <div className="flex flex-col gap-3">
          {group.requests.map((r) => {
            const due = dueLabel(r.due_date);
            const flags = r.ai_review?.flags ?? [];
            const insufficient = r.ai_review?.completeness === "insufficient";
            return (
              <Link
                key={r.id}
                href={`/engagements/${engagementId}/requests/${r.id}`}
                className="group block rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-5 transition-[transform,border-color,box-shadow] duration-[180ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-px hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-hover)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-semibold text-[var(--ink)] group-hover:underline">{r.title}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    {r.ai_review && <CompletenessBadge value={r.ai_review.completeness} />}
                    <StatusBadge status={r.status} />
                  </div>
                </div>
                <p className="mt-1 text-xs text-[var(--ink-faint)]">
                  {r.files.length > 0 ? `${r.files.length} file${r.files.length > 1 ? "s" : ""}` : "No files yet"}
                  {" · "}
                  <span className={due.tone === "overdue" ? "font-medium text-[var(--status-rose-ink)]" : ""}>{due.text}</span>
                  {r.ai_review && ` · reviewed ${relativeTime(r.ai_review.reviewed_at)}`}
                </p>

                {/* The finding, inline -- same data findings-list.tsx shows
                    on its own page, surfaced here because this is exactly
                    where "what does this control still need" is asked. */}
                {(insufficient || flags.length > 0) && (
                  <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--border)] pt-3">
                    {insufficient && (
                      <p className="text-xs font-medium text-[var(--status-rose-ink)]">
                        AI assessed this evidence as incomplete
                      </p>
                    )}
                    {flags.map((f) => {
                      const style = severityStyle(f.severity);
                      return (
                        <p key={f.id} className="flex items-start gap-1.5 text-xs text-[var(--ink-secondary)]">
                          <span className={`mt-1 size-1.5 shrink-0 rounded-full ${style.dot}`} aria-hidden />
                          {f.title}
                        </p>
                      );
                    })}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      </main>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "amber" | "rose" }) {
  const toneClass = tone === "rose" && value > 0 ? "text-[var(--status-rose-ink)]" : tone === "amber" && value > 0 ? "text-[var(--status-amber-ink)]" : "text-[var(--ink)]";
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
      <p className={`text-2xl leading-none font-bold tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-1.5 text-xs font-medium text-[var(--ink-muted)]">{label}</p>
    </div>
  );
}
