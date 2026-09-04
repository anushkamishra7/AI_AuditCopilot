"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ControlChip } from "@/components/control-chip";
import { SearchField } from "@/components/search-field";
import { formatBytes, relativeTime } from "@/lib/format";
import type { EvidenceFileRow } from "@/lib/api";

const COMPLETENESS_STYLE: Record<string, string> = {
  complete: "bg-[var(--status-emerald-bg)] text-[var(--status-emerald-ink)] ring-[var(--status-emerald-ring)]",
  partial: "bg-[var(--status-amber-bg)] text-[var(--status-amber-ink)] ring-[var(--status-amber-ring)]",
  insufficient: "bg-[var(--status-rose-bg)] text-[var(--status-rose-ink)] ring-[var(--status-rose-ring)]",
};

export function EvidenceFilesTable({ files, engagementId }: { files: EvidenceFileRow[]; engagementId: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) =>
        f.filename.toLowerCase().includes(q) ||
        f.request_title.toLowerCase().includes(q) ||
        f.control_ref.toLowerCase().includes(q),
    );
  }, [files, query]);

  return (
    <div className="flex flex-col gap-5">
      <SearchField value={query} onChange={setQuery} placeholder="Search evidence, controls, requests…" className="max-w-md" />

      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-3xl text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-raised)] text-left text-xs font-semibold tracking-wide text-[var(--ink-faint)] uppercase">
                <th className="px-4 py-3">Evidence</th>
                <th className="px-4 py-3">Control</th>
                <th className="px-4 py-3">Request</th>
                <th className="px-4 py-3">AI review</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3 text-right">Uploaded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {visible.map((f) => {
                const href = `/engagements/${engagementId}/requests/${f.request_id}`;
                return (
                  <tr
                    key={f.id}
                    onClick={() => router.push(href)}
                    className="group cursor-pointer border-l-2 border-l-transparent transition-[transform,background-color,border-color] duration-[180ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:translate-x-[2px] hover:border-l-[var(--accent)] hover:bg-[var(--surface-raised)]"
                  >
                    <td className="px-4 py-3.5 align-top font-medium text-[var(--ink)] group-hover:underline">
                      {f.filename}
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      <ControlChip refCode={f.control_ref} engagementId={engagementId} />
                    </td>
                    <td className="max-w-xs truncate px-4 py-3.5 align-top text-[var(--ink-secondary)]">
                      <Link
                        href={href}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline"
                      >
                        {f.request_title}
                      </Link>
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      {f.ai_review ? (
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap transition-[filter] duration-[180ms] group-hover:brightness-105 ${
                            COMPLETENESS_STYLE[f.ai_review.completeness_label ?? ""] ?? COMPLETENESS_STYLE.partial
                          }`}
                        >
                          {f.ai_review.document_type ?? "Reviewed"}
                          {f.ai_review.flag_count > 0 ? ` · ${f.ai_review.flag_count} flagged` : ""}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--ink-faint)]">Not yet reviewed</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 align-top text-[var(--ink-muted)]">{formatBytes(f.size_bytes)}</td>
                    <td className="px-4 py-3.5 text-right align-top whitespace-nowrap text-[var(--ink-faint)]">
                      <span className="inline-flex items-center gap-1.5">
                        {relativeTime(f.uploaded_at)}
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
          <div className="px-4 py-10 text-center text-sm text-[var(--ink-muted)]">
            {files.length === 0 ? (
              <>
                <p className="font-medium text-[var(--ink-secondary)]">No evidence submitted yet.</p>
                <p className="mt-1">Once a stakeholder uploads evidence, it will appear here.</p>
              </>
            ) : (
              "Nothing matches that search."
            )}
          </div>
        )}
      </div>
    </div>
  );
}
