"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { reanalyseEvidenceFile } from "@/lib/api";

/** Shown when a file is stored but has no AI review. Re-runs the analysis on
 * the stored file; the button is disabled while it runs so a double click
 * can't start two (the API also refuses a second review for the same file). */
export function RetryAnalysisButton({ fileId }: { fileId: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setState("running");
    setError(null);
    const result = await reanalyseEvidenceFile(fileId);
    if (result.ok) {
      router.refresh();
      return;
    }
    setState("error");
    setError(result.message);
  }

  return (
    <div className="mt-4">
      <button
        onClick={run}
        disabled={state === "running"}
        className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] transition hover:bg-[var(--accent-hover)] disabled:cursor-wait disabled:opacity-60"
      >
        {state === "running" ? "Analysing…" : "Run analysis again"}
      </button>
      {state === "error" && error && (
        <p role="alert" className="mt-2 text-sm text-[var(--status-rose-ink)]">
          {error}
        </p>
      )}
    </div>
  );
}
