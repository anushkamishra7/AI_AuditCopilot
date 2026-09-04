import type { CompletenessLabel, ConfidenceLabel, FlagSeverity, RequestStatus } from "@/lib/types";
import { COMPLETENESS_LABEL, STATUS_LABEL } from "@/lib/format";

// Dark-surface-tuned equivalents of the original light-mode badge palette --
// same hue per status/severity, re-tuned for contrast against --surface
// instead of white. See globals.css for the token values.
const STATUS_STYLE: Record<RequestStatus, string> = {
  not_sent: "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-ink)] ring-[var(--status-neutral-ring)]",
  awaiting_upload: "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-ink)] ring-[var(--status-neutral-ring)]",
  ai_processing: "bg-[var(--status-violet-bg)] text-[var(--status-violet-ink)] ring-[var(--status-violet-ring)]",
  pending_review: "bg-[var(--status-amber-bg)] text-[var(--status-amber-ink)] ring-[var(--status-amber-ring)]",
  changes_requested: "bg-[var(--status-orange-bg)] text-[var(--status-orange-ink)] ring-[var(--status-orange-ring)]",
  approved: "bg-[var(--status-emerald-bg)] text-[var(--status-emerald-ink)] ring-[var(--status-emerald-ring)]",
  rejected: "bg-[var(--status-rose-bg)] text-[var(--status-rose-ink)] ring-[var(--status-rose-ring)]",
};

export function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span
      className={`animate-fade-in inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${STATUS_STYLE[status]}`}
    >
      {status === "ai_processing" && (
        <span className="size-1.5 animate-pulse rounded-full bg-[var(--status-violet-dot)]" aria-hidden />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

const COMPLETENESS_STYLE: Record<CompletenessLabel, string> = {
  complete: "bg-[var(--status-emerald-bg)] text-[var(--status-emerald-ink)] ring-[var(--status-emerald-ring)]",
  partial: "bg-[var(--status-amber-bg)] text-[var(--status-amber-ink)] ring-[var(--status-amber-ring)]",
  insufficient: "bg-[var(--status-rose-bg)] text-[var(--status-rose-ink)] ring-[var(--status-rose-ring)]",
};

const COMPLETENESS_BAR: Record<CompletenessLabel, string> = {
  complete: "w-full bg-[var(--status-emerald-dot)]",
  partial: "w-1/2 bg-[var(--status-amber-dot)]",
  insufficient: "w-1/6 bg-[var(--status-rose-dot)]",
};

export function CompletenessBadge({
  value,
  withBar = false,
}: {
  value: CompletenessLabel;
  withBar?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      {withBar && (
        <span className="h-1.5 w-10 overflow-hidden rounded-full bg-[var(--surface-raised)]" aria-hidden>
          <span className={`block h-full rounded-full ${COMPLETENESS_BAR[value]}`} />
        </span>
      )}
      <span
        className={`animate-fade-in rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${COMPLETENESS_STYLE[value]}`}
      >
        {COMPLETENESS_LABEL[value]}
      </span>
    </span>
  );
}

const SEVERITY_STYLE: Record<FlagSeverity, { chip: string; dot: string; label: string }> = {
  blocker: { chip: "border-[var(--status-rose-ring)] bg-[var(--status-rose-bg)]", dot: "bg-[var(--status-rose-dot)]", label: "Blocker" },
  warning: { chip: "border-[var(--status-amber-ring)] bg-[var(--status-amber-bg)]", dot: "bg-[var(--status-amber-dot)]", label: "Warning" },
  info: { chip: "border-[var(--border)] bg-[var(--surface-raised)]", dot: "bg-[var(--ink-faint)]", label: "Info" },
};

export function severityStyle(severity: FlagSeverity) {
  return SEVERITY_STYLE[severity];
}

const CONFIDENCE_STYLE: Record<ConfidenceLabel, { chip: string; label: string }> = {
  strong_match: { chip: "bg-[var(--status-emerald-bg)] text-[var(--status-emerald-ink)] ring-[var(--status-emerald-ring)]", label: "Strong match" },
  partial_match: { chip: "bg-[var(--status-amber-bg)] text-[var(--status-amber-ink)] ring-[var(--status-amber-ring)]", label: "Partial match" },
  weak_match: { chip: "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-ink)] ring-[var(--status-neutral-ring)]", label: "Weak match" },
};

export function confidenceStyle(confidence: ConfidenceLabel) {
  return CONFIDENCE_STYLE[confidence];
}

// ControlChip moved to its own file (control-chip.tsx) -- its optional link
// variant needs an onClick, which can't be passed as a prop from a Server
// Component, so it has to be a Client Component. This file stays server-safe
// on purpose: findings-list.tsx (a Server Component) calls severityStyle()
// above directly, not just renders it, and that stops working the moment
// this module is "use client".

// No longer called anywhere -- the dashboard's Owner column now shows
// name/role as text only, per the "no avatars" direction. Left defined
// rather than deleted in case a future screen wants an initials badge.
export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-600"
      aria-hidden
    >
      {initials}
    </span>
  );
}
