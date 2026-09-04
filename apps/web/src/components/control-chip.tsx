"use client";

import Link from "next/link";

// The signature Evidence <-> Control relationship: every place a control_ref
// is shown, it's the same clickable chip -- pass `engagementId` to link to
// that control's real, derived detail page (/controls/[controlRef]). Without
// it, renders as the original plain, non-interactive chip.
//
// A Client Component (needs an onClick, to stop a click from also bubbling
// into a parent row's own row-level navigation) -- kept separate from
// badges.tsx on purpose, since that file's severityStyle/confidenceStyle are
// called directly from Server Components elsewhere, which stops working the
// moment that module is "use client".
export function ControlChip({ refCode, engagementId }: { refCode: string; engagementId?: string }) {
  const chip = (
    <span className="rounded border border-[var(--border-strong)] bg-[var(--surface-raised)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--ink-secondary)]">
      {refCode}
    </span>
  );
  if (!engagementId) return chip;
  return (
    <Link
      href={`/engagements/${engagementId}/controls/${encodeURIComponent(refCode)}`}
      className="transition-[transform,border-color] duration-150 hover:-translate-y-px [&>span]:hover:border-[var(--accent)] [&>span]:hover:text-[var(--ink)]"
      onClick={(e) => e.stopPropagation()}
    >
      {chip}
    </Link>
  );
}
