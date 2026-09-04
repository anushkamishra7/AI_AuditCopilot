"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ControlChip } from "@/components/control-chip";
import { dueLabel, relativeTime } from "@/lib/format";
import { countRequests, isOverdue, isUrgent, aiReviewPct, controlReadinessPct, potentialExceptions } from "@/lib/request-status";
import type { ActivityEvent } from "@/lib/api";
import type { EvidenceRequest, Stakeholder } from "@/lib/types";

export function OverviewDashboard({
  requests,
  stakeholders,
  engagementId,
  activity,
  greetingName,
  headerActions,
}: {
  requests: EvidenceRequest[];
  stakeholders: Record<string, Stakeholder>;
  engagementId: string;
  activity: ActivityEvent[];
  greetingName: string;
  headerActions?: React.ReactNode;
}) {
  const counts = countRequests(requests);
  const exceptions = potentialExceptions(requests);
  const evidencePct = counts.all > 0 ? Math.round((counts.approved / counts.all) * 100) : 0;
  const reviewPct = aiReviewPct(requests);
  const readinessPct = controlReadinessPct(requests);

  const urgent = requests
    .filter(isUrgent)
    .sort((a, b) => {
      const rank = (r: EvidenceRequest) => (isOverdue(r) ? 0 : 1);
      return rank(a) - rank(b) || a.due_date.localeCompare(b.due_date);
    });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[28px] leading-tight font-bold tracking-tight text-[var(--ink)]">
          Good {timeOfDay()}, {greetingName}
        </h1>
        {headerActions && <div className="flex items-center gap-2">{headerActions}</div>}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard label="Pending evidence" value={counts.outstanding} tone="neutral" />
        <SummaryCard label="Overdue" value={counts.overdue} tone="rose" />
        <SummaryCard label="Needs review" value={counts.needs_review} tone="amber" />
        <SummaryCard label="Potential exceptions" value={exceptions.length} tone="violet" />
      </div>

      {/* Needs your attention */}
      {urgent.length > 0 && (
        <section className="rounded-[var(--radius-card)] border border-[var(--status-rose-ring)]/60 bg-[var(--surface)] p-6">
          <p className="text-[11px] font-semibold tracking-wider text-[var(--ink-faint)] uppercase">
            Needs your attention
          </p>
          <div className="mt-4 flex flex-col gap-2.5">
            {urgent.slice(0, 5).map((r) => {
              const s = stakeholders[r.stakeholder_id];
              const due = dueLabel(r.due_date);
              const overdue = isOverdue(r);
              const flagDetail = r.ai_review?.flags[0]?.title;
              return (
                <Link
                  key={r.id}
                  href={`/engagements/${engagementId}/requests/${r.id}`}
                  className="group flex flex-wrap items-center gap-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface-raised)] p-4 transition-[border-color,background-color,box-shadow] duration-150 hover:border-[var(--border-strong)] hover:bg-[var(--surface)] hover:shadow-[var(--shadow-hover)]"
                >
                  <ControlChip refCode={r.control_ref} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[var(--ink)] group-hover:underline">{r.title}</p>
                    <p className="mt-0.5 text-xs text-[var(--ink-faint)]">
                      {r.files.length > 0 ? `${r.files.length} file${r.files.length > 1 ? "s" : ""} submitted` : "No files yet"}
                      {s ? ` · ${s.full_name}` : ""}
                      {flagDetail && (
                        <span className="text-[var(--status-amber-ink)]"> · AI flagged: {flagDetail}</span>
                      )}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-xs font-semibold tabular-nums ${
                      overdue ? "text-[var(--status-rose-ink)]" : "text-[var(--status-amber-ink)]"
                    }`}
                  >
                    {due.text}
                  </span>
                  <span className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-ink)] transition-[background-color,transform,box-shadow] duration-[180ms] ease-[cubic-bezier(0.4,0,0.2,1)] group-hover:-translate-y-px group-hover:bg-[var(--accent-hover)] group-hover:shadow-[var(--shadow-hover)]">
                    Review evidence
                  </span>
                </Link>
              );
            })}
          </div>
          {urgent.length > 5 && (
            <Link
              href={`/engagements/${engagementId}/requests`}
              className="mt-3 inline-block text-xs font-medium text-[var(--ink-muted)] hover:text-[var(--ink)] hover:underline"
            >
              +{urgent.length - 5} more →
            </Link>
          )}
        </section>
      )}

      {/* Engagement progress */}
      <section className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base leading-tight font-semibold text-[var(--ink)]">Engagement progress</h2>
        <div className="mt-5 flex flex-col gap-4">
          <ProgressRow label="Evidence collection" pct={evidencePct} />
          <ProgressRow label="AI review" pct={reviewPct} />
          <ProgressRow label="Control readiness" pct={readinessPct} />
        </div>
      </section>

      {/* Recent activity */}
      <section className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base leading-tight font-semibold text-[var(--ink)]">Recent activity</h2>
        {activity.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--ink-muted)]">
            Nothing yet. Once a stakeholder uploads evidence, activity will appear here.
          </p>
        ) : (
          <ol className="mt-4 flex flex-col gap-3">
            {activity.map((a) => (
              <li key={a.id} className="flex items-start gap-3">
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${actorDot(a.actor_type)}`} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm text-[var(--ink)]">
                    <span className="font-medium">{a.actor}</span>: {a.action}
                  </p>
                  {a.detail && <p className="text-xs text-[var(--ink-faint)]">{a.detail}</p>}
                  <p className="mt-0.5 text-xs text-[var(--ink-faint)]">{relativeTime(a.created_at)}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function timeOfDay(): string {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

function actorDot(actorType: string): string {
  switch (actorType) {
    case "ai":
      return "bg-[var(--status-violet-dot)]";
    case "stakeholder":
      return "bg-[var(--status-amber-dot)]";
    case "auditor":
      return "bg-[var(--accent)]";
    default:
      return "bg-[var(--ink-faint)]";
  }
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "rose" | "amber" | "violet";
}) {
  const toneInk =
    tone === "rose"
      ? "text-[var(--status-rose-ink)]"
      : tone === "amber"
        ? "text-[var(--status-amber-ink)]"
        : tone === "violet"
          ? "text-[var(--status-violet-ink)]"
          : "text-[var(--ink)]";
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] px-5 py-4 transition-[border-color,box-shadow] duration-150 hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-subtle)]">
      <p className={`text-[32px] leading-none font-bold tabular-nums ${value > 0 ? toneInk : "text-[var(--ink-faint)]"}`}>{value}</p>
      <p className="mt-2 text-[13px] font-medium text-[var(--ink-muted)]">{label}</p>
    </div>
  );
}

function ProgressRow({ label, pct }: { label: string; pct: number }) {
  // Starts at 0 and animates up to the real value on mount/data load, rather
  // than the bar just appearing already full -- width is normally off-limits
  // for animation (layout cost), but this is exactly the one-time, meaningful
  // case the motion spec calls out explicitly. prefers-reduced-motion still
  // wins (globals.css collapses the transition duration to ~0 either way).
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setWidth(pct));
    return () => cancelAnimationFrame(id);
  }, [pct]);

  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-[var(--ink-secondary)]">{label}</span>
        <span className="font-semibold tabular-nums text-[var(--ink)]">{pct}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface-raised)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
