"use client";

import Link from "next/link";
import { ControlChip } from "@/components/control-chip";
import type { ControlGroup } from "@/lib/request-status";

// There's no Controls entity/library in the database -- this table is built
// entirely by grouping real evidence requests by their real control_ref, the
// same string already shown everywhere else in the app. A control with zero
// requests against it (i.e. genuinely not in scope yet) simply doesn't
// appear here; this isn't a fabricated full control catalog.
export function ControlsTable({ groups, engagementId }: { groups: ControlGroup[]; engagementId: string }) {
  if (groups.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--ink-muted)]">
        No evidence requests reference a control yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-xs font-semibold tracking-wide text-[var(--ink-muted)] uppercase">
            <th className="px-4 py-3">Control</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Requests</th>
            <th className="px-4 py-3 text-right">Needs review</th>
            <th className="px-4 py-3 text-right">Overdue</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {groups.map((g) => (
            <tr key={g.control_ref} className="transition-colors hover:bg-[var(--surface-raised)]">
              <td className="px-4 py-3.5 align-top">
                <ControlChip refCode={g.control_ref} engagementId={engagementId} />
              </td>
              <td className="px-4 py-3.5 align-top">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${
                    g.ready
                      ? "bg-[var(--status-emerald-bg)] text-[var(--status-emerald-ink)] ring-[var(--status-emerald-ring)]"
                      : g.overdue > 0
                        ? "bg-[var(--status-rose-bg)] text-[var(--status-rose-ink)] ring-[var(--status-rose-ring)]"
                        : g.needs_review > 0
                          ? "bg-[var(--status-amber-bg)] text-[var(--status-amber-ink)] ring-[var(--status-amber-ring)]"
                          : "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-ink)] ring-[var(--status-neutral-ring)]"
                  }`}
                >
                  {g.ready ? "Ready" : g.overdue > 0 ? "Overdue" : g.needs_review > 0 ? "Needs review" : "Outstanding"}
                </span>
              </td>
              <td className="px-4 py-3.5 text-right align-top tabular-nums text-[var(--ink-secondary)]">
                <Link
                  href={`/engagements/${engagementId}/requests?q=${encodeURIComponent(g.control_ref)}`}
                  className="hover:text-[var(--accent)] hover:underline"
                >
                  {g.requests.length}
                </Link>
              </td>
              <td className="px-4 py-3.5 text-right align-top tabular-nums text-[var(--ink-secondary)]">
                {g.needs_review}
              </td>
              <td className="px-4 py-3.5 text-right align-top tabular-nums">
                {g.overdue > 0 ? (
                  <span className="font-semibold text-[var(--status-rose-ink)]">{g.overdue}</span>
                ) : (
                  <span className="text-[var(--ink-faint)]">0</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
