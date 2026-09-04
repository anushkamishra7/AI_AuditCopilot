"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CompletenessBadge, StatusBadge } from "@/components/badges";
import { ControlChip } from "@/components/control-chip";
import { SearchField } from "@/components/search-field";
import { SendRequestButton } from "@/components/requests/send-request-button";
import { dueLabel, relativeTime } from "@/lib/format";
import { OPEN_STATUSES, countRequests, isOverdue } from "@/lib/request-status";
import type { EvidenceRequest, Stakeholder } from "@/lib/types";

type Bucket = "all" | "needs_review" | "overdue" | "outstanding" | "closed";

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "needs_review", label: "Needs your review" },
  { key: "overdue", label: "Overdue" },
  { key: "outstanding", label: "Outstanding" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

function inBucket(r: EvidenceRequest, bucket: Bucket) {
  switch (bucket) {
    case "needs_review":
      return r.status === "pending_review";
    case "overdue":
      return isOverdue(r);
    case "outstanding":
      return OPEN_STATUSES.includes(r.status);
    case "closed":
      return r.status === "approved" || r.status === "rejected";
    default:
      return true;
  }
}

export function RequestsTable({
  requests,
  stakeholders,
  engagementId,
  initialQuery = "",
}: {
  requests: EvidenceRequest[];
  stakeholders: Record<string, Stakeholder>;
  engagementId: string;
  initialQuery?: string;
}) {
  const router = useRouter();
  const [bucket, setBucket] = useState<Bucket>("all");
  const [query, setQuery] = useState(initialQuery);
  const [owner, setOwner] = useState("all");

  const counts = useMemo(() => countRequests(requests), [requests]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return requests
      .filter((r) => inBucket(r, bucket))
      .filter((r) => owner === "all" || r.stakeholder_id === owner)
      .filter(
        (r) =>
          !q ||
          r.title.toLowerCase().includes(q) ||
          r.control_ref.toLowerCase().includes(q) ||
          stakeholders[r.stakeholder_id]?.full_name.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        // Auditor's real priority order: things blocking them, then things running late.
        const rank = (r: EvidenceRequest) =>
          r.status === "pending_review" ? 0 : isOverdue(r) ? 1 : OPEN_STATUSES.includes(r.status) ? 2 : 3;
        return rank(a) - rank(b) || a.due_date.localeCompare(b.due_date);
      });
  }, [requests, bucket, owner, query, stakeholders]);

  return (
    <div className="flex flex-col gap-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1">
          {BUCKETS.map((b) => (
            <button
              key={b.key}
              onClick={() => setBucket(b.key)}
              className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                bucket === b.key
                  ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                  : "text-[var(--ink-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
              }`}
            >
              {b.label}
              <span className={bucket === b.key ? "ml-1.5 text-white/70" : "ml-1.5 text-[var(--ink-faint)]"}>
                {counts[b.key]}
              </span>
            </button>
          ))}
        </div>

        <SearchField value={query} onChange={setQuery} placeholder="Search requests, controls, people…" className="min-w-56 flex-1" />

        <select
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className="h-10 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3.5 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--border-strong)]"
        >
          <option value="all">All stakeholders</option>
          {Object.values(stakeholders).map((s) => (
            <option key={s.id} value={s.id}>
              {s.full_name}
            </option>
          ))}
        </select>
      </div>

      {/* Table -- deliberately tighter radius and padding than dashboard
          cards, so it still reads as a data grid, not another card. */}
      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-4xl text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-raised)] text-left text-xs font-semibold tracking-wide text-[var(--ink-faint)] uppercase">
                <th className="px-4 py-3">Control</th>
                <th className="px-4 py-3">Evidence request</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Due</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">AI assessment</th>
                <th className="px-4 py-3 text-right">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {visible.map((r) => {
                const s = stakeholders[r.stakeholder_id];
                const due = dueLabel(r.due_date);
                const blockers = r.ai_review?.flags.filter((f) => f.severity === "blocker").length ?? 0;
                const href = `/engagements/${engagementId}/requests/${r.id}`;
                return (
                  <tr
                    key={r.id}
                    onClick={() => router.push(href)}
                    className="group cursor-pointer border-l-2 border-l-transparent transition-[transform,background-color,border-color] duration-[180ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:translate-x-[2px] hover:border-l-[var(--accent)] hover:bg-[var(--surface-raised)]"
                  >
                    <td className="px-4 py-3.5 align-top">
                      <ControlChip refCode={r.control_ref} engagementId={engagementId} />
                    </td>
                    <td className="max-w-md px-4 py-3.5 align-top">
                      <Link
                        href={href}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-[var(--ink)] group-hover:underline"
                      >
                        {r.title}
                      </Link>
                      <p className="mt-0.5 text-xs text-[var(--ink-faint)]">
                        {r.files.length > 0
                          ? `${r.files.length} file${r.files.length > 1 ? "s" : ""}`
                          : "No files yet"}
                        {r.reminder_count > 0 && ` · ${r.reminder_count} reminder${r.reminder_count > 1 ? "s" : ""} sent`}
                      </p>
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      <p className="truncate font-medium text-[var(--ink-secondary)]">{s?.full_name}</p>
                      <p className="truncate text-xs text-[var(--ink-faint)]">{s?.role_title}</p>
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      <span
                        className={
                          due.tone === "overdue"
                            ? "font-semibold text-[var(--status-rose-ink)]"
                            : due.tone === "soon"
                              ? "font-semibold text-[var(--status-amber-ink)]"
                              : "text-[var(--ink-muted)]"
                        }
                      >
                        {due.text}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      <div className="flex flex-col items-start gap-1.5">
                        <span className="inline-block transition-[filter] duration-[180ms] group-hover:brightness-105">
                          <StatusBadge status={r.status} />
                        </span>
                        {r.status === "not_sent" && s && <SendRequestButton requestId={r.id} email={s.email} />}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      {r.ai_review ? (
                        <div className="space-y-1">
                          <CompletenessBadge value={r.ai_review.completeness} withBar />
                          <p className="text-xs text-[var(--ink-faint)]">
                            {r.ai_review.doc_type}
                            {blockers > 0 && (
                              <span className="font-semibold text-[var(--status-rose-ink)]">
                                {" "}
                                · {blockers} blocker{blockers > 1 ? "s" : ""}
                              </span>
                            )}
                          </p>
                        </div>
                      ) : (
                        <span className="text-xs text-[var(--ink-faint)]">Not reviewed</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right align-top whitespace-nowrap text-[var(--ink-faint)]">
                      <span className="inline-flex items-center gap-1.5">
                        {relativeTime(r.last_activity_at)}
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden
                          className="size-3 shrink-0 -translate-x-1 text-[var(--ink-faint)] opacity-0 transition-[opacity,transform] duration-[180ms] group-hover:translate-x-0 group-hover:opacity-100"
                        >
                          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {visible.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-[var(--ink-muted)]">
            Nothing here. Try a different filter.
          </p>
        )}
      </div>
    </div>
  );
}
