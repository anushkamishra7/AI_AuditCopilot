"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { uploadEvidenceFile } from "@/lib/api";
import { formatBytes } from "@/lib/format";

type RequestOption = { id: string; title: string; control_ref: string; status: string };
type Stage = "pick" | "analysing" | "done" | "error";

const STEPS = ["Upload", "Analyse", "Review"] as const;

// What the backend does for each upload, in order. The text ticks forward on
// a timer while the single upload request is in flight -- the server doesn't
// stream progress, so this narrates the work rather than measuring it.
const ANALYSIS_STEPS = ["Reading the document", "Checking what it covers", "Matching it to controls"];

export function ConsoleUploadFlow({
  engagementId,
  requests,
  initialRequestId,
}: {
  engagementId: string;
  requests: RequestOption[];
  initialRequestId: string | null;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [requestId, setRequestId] = useState(
    requests.find((r) => r.id === initialRequestId)?.id ?? requests[0]?.id ?? "",
  );
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<Stage>("pick");
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<{ message: string; received: boolean } | null>(null);

  useEffect(() => {
    if (stage !== "analysing") return;
    const t = setInterval(() => setTick((n) => Math.min(n + 1, ANALYSIS_STEPS.length - 1)), 2200);
    return () => clearInterval(t);
  }, [stage]);

  const activeStep = stage === "pick" || stage === "error" ? 0 : stage === "analysing" ? 1 : 2;
  const selected = requests.find((r) => r.id === requestId);
  const reviewHref = `/engagements/${engagementId}/requests/${requestId}?from=upload`;

  function pick(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    if (f.type !== "application/pdf") {
      setError({ message: "Only PDF files are supported for now.", received: false });
      setStage("error");
      return;
    }
    setFile(f);
    setError(null);
    setStage("pick");
  }

  async function analyse() {
    if (!file || !requestId) return;
    setStage("analysing");
    setTick(0);
    setError(null);
    const result = await uploadEvidenceFile(requestId, file);
    if (result.ok) {
      setStage("done");
      router.push(reviewHref);
      return;
    }
    setError({ message: result.message, received: result.received });
    setStage("error");
  }

  if (requests.length === 0) {
    return (
      <div className="mx-auto max-w-xl text-center">
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--ink)]">Nothing to upload against yet</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          Evidence is attached to a request. Create one first, then come back here.
        </p>
        <Link
          href={`/engagements/${engagementId}/requests`}
          className="mt-6 inline-block rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]"
        >
          Go to requests
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      <ol className="mb-10 flex items-center justify-center gap-3 text-sm" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-3">
            <span
              aria-current={i === activeStep ? "step" : undefined}
              className={`flex items-center gap-2 font-medium transition-colors duration-300 ${
                i <= activeStep ? "text-[var(--ink)]" : "text-[var(--ink-faint)]"
              }`}
            >
              <span
                className={`flex size-6 items-center justify-center rounded-full text-xs transition-colors duration-300 ${
                  i < activeStep
                    ? "bg-[var(--status-emerald-dot)] text-white"
                    : i === activeStep
                      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                      : "bg-[var(--surface-raised)] text-[var(--ink-muted)]"
                }`}
              >
                {i < activeStep ? "✓" : i + 1}
              </span>
              {label}
            </span>
            {i < STEPS.length - 1 && <span className="h-px w-8 bg-[var(--border-strong)]" aria-hidden />}
          </li>
        ))}
      </ol>

      {(stage === "pick" || stage === "error") && (
        <section className="animate-fade-in">
          <h1 className="text-center text-[28px] leading-tight font-bold tracking-tight text-[var(--ink)]">
            Upload evidence
          </h1>
          <p className="mt-2 text-center text-sm text-[var(--ink-muted)]">
            Add a PDF. We&apos;ll read it and show you what it covers.
          </p>

          {requests.length > 1 && (
            <label className="mt-8 block">
              <span className="text-xs font-semibold tracking-wider text-[var(--ink-faint)] uppercase">For request</span>
              <select
                value={requestId}
                onChange={(e) => setRequestId(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--ink-muted)]"
              >
                {requests.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.control_ref} · {r.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {requests.length === 1 && selected && (
            <p className="mt-8 text-sm text-[var(--ink-secondary)]">
              For <span className="font-medium text-[var(--ink)]">{selected.control_ref} · {selected.title}</span>
            </p>
          )}

          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files);
            }}
            className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors duration-150 ${
              dragging
                ? "border-[var(--ink)] bg-[var(--surface-raised)]"
                : "border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-raised)]"
            }`}
          >
            {file ? (
              <>
                <p className="max-w-full truncate text-sm font-medium text-[var(--ink)]">{file.name}</p>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">{formatBytes(file.size)} · click to choose a different file</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-[var(--ink)]">Drop a PDF here</p>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">or click to browse</p>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => pick(e.target.files)}
            />
          </div>

          {stage === "error" && error && (
            <div role="alert" className="mt-4 rounded-lg bg-[var(--status-rose-bg)] px-4 py-3 text-sm text-[var(--status-rose-ink)]">
              {error.received ? (
                <>
                  The file was received, but the analysis didn&apos;t finish.{" "}
                  <Link href={reviewHref} className="font-medium underline">
                    Open the request
                  </Link>
                  .
                </>
              ) : (
                error.message
              )}
            </div>
          )}

          <button
            onClick={analyse}
            disabled={!file || !requestId}
            className="mt-6 w-full rounded-lg bg-[var(--accent)] px-4 py-3 text-sm font-medium text-[var(--accent-ink)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--surface-raised)] disabled:text-[var(--ink-faint)]"
          >
            Analyse document
          </button>
        </section>
      )}

      {(stage === "analysing" || stage === "done") && (
        <section className="animate-fade-in text-center" aria-live="polite">
          <h1 className="text-[28px] leading-tight font-bold tracking-tight text-[var(--ink)]">
            {stage === "done" ? "Done. Opening the analysis…" : "Analysing…"}
          </h1>
          <p className="mt-2 truncate text-sm text-[var(--ink-muted)]">{file?.name}</p>
          <div className="mx-auto mt-8 h-1 w-64 overflow-hidden rounded-full bg-[var(--surface-raised)]">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--accent)]" />
          </div>
          <ul className="mx-auto mt-8 max-w-xs space-y-2 text-left text-sm">
            {ANALYSIS_STEPS.map((label, i) => {
              const state = stage === "done" || i < tick ? "done" : i === tick ? "active" : "todo";
              return (
                <li
                  key={label}
                  className={`flex items-center gap-2.5 transition-colors duration-300 ${
                    state === "todo" ? "text-[var(--ink-faint)]" : "text-[var(--ink)]"
                  }`}
                >
                  <span
                    className={`size-1.5 rounded-full ${
                      state === "done"
                        ? "bg-[var(--status-emerald-dot)]"
                        : state === "active"
                          ? "animate-pulse bg-[var(--accent)]"
                          : "bg-[var(--border-strong)]"
                    }`}
                  />
                  {label}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
