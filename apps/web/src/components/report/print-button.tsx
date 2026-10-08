"use client";

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] transition hover:bg-[var(--accent-hover)]"
    >
      Print / Save as PDF
    </button>
  );
}
