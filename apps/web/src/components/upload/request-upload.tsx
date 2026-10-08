"use client";

import { useRef, useState } from "react";
import { formatBytes, formatDate, dueLabel } from "@/lib/format";
import { uploadEvidenceFile } from "@/lib/api";
import type { AuditorContact } from "@/lib/upload-link";
import type { EvidenceRequest, Stakeholder } from "@/lib/types";

type FileStatus = "pending" | "uploading" | "done" | "error";

interface PickedFile {
  id: string;
  name: string;
  size: number;
  file: File;
  status: FileStatus;
  errorMessage?: string;
  /** true when the backend confirms the file was actually saved even
   * though the overall request errored (PDF extraction / the review model
   * failed after storage — see uploadEvidenceFile's `received` flag). */
  received?: boolean;
}

let fileCounter = 0;
function nextId() {
  fileCounter += 1;
  return `f${fileCounter}`;
}

export function RequestUpload({
  token,
  request,
  stakeholder,
  auditor,
}: {
  /** The request's magic-link token: the stakeholder's only credential. */
  token: string;
  request: EvidenceRequest;
  stakeholder: Stakeholder;
  auditor: AuditorContact;
}) {
  if (request.status === "approved") {
    return <AlreadyDone request={request} auditor={auditor} />;
  }

  return <UploadForm token={token} request={request} stakeholder={stakeholder} auditor={auditor} />;
}

function Header({ auditor }: { auditor: AuditorContact }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-slate-100 px-6 py-4 sm:px-8">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
        {auditor.name
          .split(" ")
          .map((p) => p[0])
          .join("")}
      </span>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-medium text-slate-900">{auditor.name}</p>
        <p className="truncate text-xs text-slate-500">{auditor.firm}</p>
      </div>
    </div>
  );
}

function AlreadyDone({ request, auditor }: { request: EvidenceRequest; auditor: AuditorContact }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <Header auditor={auditor} />
        <div className="px-6 py-10 text-center sm:px-8">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-50">
            <CheckIcon className="size-6 text-emerald-600" />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-slate-900">Already taken care of</h1>
          <p className="mt-2 text-sm text-slate-600">
            &ldquo;{request.title}&rdquo; was reviewed and accepted. There&apos;s nothing further needed
            from you here. Thanks again for sending it over.
          </p>
        </div>
      </div>
    </div>
  );
}

function UploadForm({
  token,
  request,
  stakeholder,
  auditor,
}: {
  token: string;
  request: EvidenceRequest;
  stakeholder: Stakeholder;
  auditor: AuditorContact;
}) {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);
  // "done" isn't a stage value anymore -- whether everything succeeded is
  // derived from each file's own status (see allDone/anyFailed below), since
  // a submit pass can now genuinely partially fail per file.
  const [stage, setStage] = useState<"form" | "submitting">("form");
  const inputRef = useRef<HTMLInputElement>(null);

  const askedForMore =
    request.decision?.decision === "request_more" || request.decision?.decision === "reject";
  const due = dueLabel(request.due_date);
  const sentFiles = request.files ?? [];

  function addFiles(list: FileList | null) {
    if (!list) return;
    const picked = Array.from(list).map((f) => ({
      id: nextId(),
      name: f.name,
      size: f.size,
      file: f,
      status: "pending" as FileStatus,
    }));
    setFiles((prev) => [...prev, ...picked]);
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  // Sequential, one request per file — the backend only accepts one file
  // per call. Files already "done" from a previous pass are skipped, so
  // clicking submit again after a partial failure only retries what failed.
  async function submit() {
    if (files.length === 0) return;
    setStage("submitting");

    for (const f of files) {
      if (f.status === "done") continue;
      setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, status: "uploading" } : x)));
      const result = await uploadEvidenceFile(request.id, f.file, token);
      setFiles((prev) =>
        prev.map((x) =>
          x.id === f.id
            ? result.ok
              ? { ...x, status: "done", errorMessage: undefined }
              : { ...x, status: "error", errorMessage: result.message, received: result.received }
            : x,
        ),
      );
    }

    setStage("form");
  }

  const allDone = files.length > 0 && files.every((f) => f.status === "done");
  const anyFailed = files.some((f) => f.status === "error");

  if (allDone) {
    return (
      <Shell auditor={auditor}>
        <div className="px-6 py-10 text-center sm:px-8">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-50">
            <CheckIcon className="size-6 text-emerald-600" />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-slate-900">Thanks, we&apos;ve got it</h1>
          <p className="mt-2 text-sm text-slate-600">
            {files.length} file{files.length > 1 ? "s" : ""} sent to {auditor.name.split(" ")[0]}.
            You&apos;ll hear back if anything else is needed.
          </p>
          <ul className="mx-auto mt-5 max-w-xs space-y-1.5 text-left">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700"
              >
                <FileIcon className="size-4 shrink-0 text-slate-400" />
                <span className="truncate">{f.name}</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-xs text-slate-400">You can close this tab now.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell auditor={auditor}>
      <div className="px-6 py-6 sm:px-8">
        <h1 className="text-xl font-semibold text-slate-900">{request.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">{request.description}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
              due.tone === "overdue"
                ? "bg-rose-50 text-rose-700 ring-rose-200"
                : due.tone === "soon"
                  ? "bg-amber-50 text-amber-800 ring-amber-200"
                  : "bg-slate-50 text-slate-600 ring-slate-200"
            }`}
          >
            {due.tone === "overdue" ? "Was due" : "Due"} {formatDate(request.due_date)}
            {due.tone === "overdue" && ` · ${due.text}`}
          </span>
          <span className="text-xs text-slate-400">Requested for {stakeholder.full_name}</span>
        </div>

        {askedForMore && request.decision && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3.5">
            <p className="text-xs font-semibold tracking-wide text-amber-800 uppercase">
              {auditor.name.split(" ")[0]} asked for a bit more
            </p>
            <p className="mt-1 text-sm text-amber-900">{request.decision.note}</p>
          </div>
        )}

        {sentFiles.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-medium text-slate-500">Already sent</p>
            <ul className="mt-1.5 space-y-1">
              {sentFiles.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-500"
                >
                  <FileIcon className="size-4 shrink-0 text-slate-400" />
                  <span className="truncate">{f.filename}</span>
                  <span className="ml-auto shrink-0 text-xs text-slate-400">
                    {formatBytes(f.size_bytes)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="border-t border-slate-100 px-6 py-6 sm:px-8">
        <label
          htmlFor="file-input"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
            dragging ? "border-slate-400 bg-slate-50" : "border-slate-200 hover:border-slate-300"
          }`}
        >
          <UploadIcon className="size-7 text-slate-400" />
          <p className="mt-2 text-sm font-medium text-slate-700">
            Drop files here, or <span className="text-slate-900 underline">browse</span>
          </p>
          <p className="mt-1 text-xs text-slate-400">PDF files only</p>
          <input
            ref={inputRef}
            id="file-input"
            type="file"
            accept="application/pdf"
            multiple
            className="sr-only"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>

        {files.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {files.map((f) => (
              <li key={f.id}>
                <div
                  className={`flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm ${
                    f.status === "error" ? "border-rose-200" : "border-slate-200"
                  }`}
                >
                  <FileIcon className="size-4 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate text-slate-800">{f.name}</span>
                  <span className="shrink-0 text-xs text-slate-400">{formatBytes(f.size)}</span>
                  {f.status === "uploading" && <Spinner className="size-4 shrink-0 text-slate-400" />}
                  {f.status === "done" && <CheckIcon className="size-4 shrink-0 text-emerald-600" />}
                  {f.status !== "uploading" && (
                    <button
                      onClick={() => removeFile(f.id)}
                      aria-label={`Remove ${f.name}`}
                      className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  )}
                </div>
                {f.status === "error" && (
                  <p className="mt-1 pl-1 text-xs text-rose-600">
                    {f.received
                      ? "Received, but automatic review didn't finish. An auditor will still see this file."
                      : `Didn't go through: ${f.errorMessage}`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Not persisted anywhere yet -- the upload endpoint has no field
            for a stakeholder note. Left in as a UI placeholder rather than
            removed; wire it up if/when the backend gains one. */}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder={`Add a note for ${auditor.name.split(" ")[0]} (optional)`}
          className="mt-3 w-full resize-none rounded-lg border border-slate-200 p-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-slate-400"
        />

        <button
          onClick={submit}
          disabled={files.length === 0 || stage === "submitting"}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          {stage === "submitting" ? (
            <>
              <Spinner className="size-4" /> Sending…
            </>
          ) : anyFailed ? (
            `Retry ${files.filter((f) => f.status !== "done").length} file${files.filter((f) => f.status !== "done").length > 1 ? "s" : ""}`
          ) : (
            `Submit ${files.length > 0 ? `${files.length} file${files.length > 1 ? "s" : ""}` : ""}`
          )}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ auditor, children }: { auditor: AuditorContact; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-slate-50 px-4 py-10 sm:items-center">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <Header auditor={auditor} />
        {children}
      </div>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} aria-hidden>
      <path
        d="M12 16V4m0 0L7 9m5-5l5 5M5 20h14"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} aria-hidden>
      <path
        d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={3} className="opacity-25" />
      <path
        d="M21 12a9 9 0 00-9-9"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        className="opacity-90"
      />
    </svg>
  );
}
