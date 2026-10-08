import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/report/print-button";
import { fetchEngagementReport, type ReportCoverageItem, type ReportFile } from "@/lib/api";
import { COMPLETENESS_LABEL, DECISION_LABEL, STATUS_LABEL, formatBytes } from "@/lib/format";
import type { RequestStatus } from "@/lib/types";

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const FRAMEWORKS: Record<string, string> = { SOC2: "SOC 2", ISO27001: "ISO 27001" };

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-10 mb-3 border-b border-[var(--border-strong)] pb-1.5 text-xs font-semibold tracking-wider text-[var(--ink-muted)] uppercase">
      {children}
    </h2>
  );
}

function CoverageGroup({ title, items }: { title: string; items: ReportCoverageItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 break-inside-avoid">
      <h3 className="text-sm font-semibold text-[var(--ink)]">
        {title} ({items.length})
      </h3>
      <ul className="mt-1.5 space-y-2 text-sm">
        {items.map((i) => (
          <li key={i.file_id} className="pl-3 text-[var(--ink-secondary)]">
            <span className="font-medium text-[var(--ink)]">
              {i.control_ref} · {i.request_title}
            </span>{" "}
            — {i.filename}
            <br />
            <span className="text-[var(--ink-muted)]">{i.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FileBlock({ file }: { file: ReportFile }) {
  const review = file.review;
  return (
    <li className="break-inside-avoid border-t border-[var(--border)] py-4 first:border-t-0">
      <p className="text-sm font-medium text-[var(--ink)]">
        {file.filename}
        <span className="ml-2 font-normal text-[var(--ink-muted)]">
          {file.size_bytes != null ? `${formatBytes(file.size_bytes)} · ` : ""}uploaded {when(file.uploaded_at)}
        </span>
      </p>
      <p className="mt-1 text-sm text-[var(--ink-secondary)]">
        <span className="font-medium">Coverage:</span> {file.coverage.detail}
      </p>

      {review ? (
        <div className="mt-3 border-l-2 border-[var(--ink-faint)] bg-[var(--surface-raised)] px-4 py-3 text-sm print:bg-transparent">
          <p className="text-[11px] font-semibold tracking-wider text-[var(--ink-muted)] uppercase">
            AI-generated review · not verified by an auditor
          </p>
          <p className="mt-2 text-[var(--ink)]">
            <span className="font-medium">{review.document_type ?? "Unclassified document"}</span>
            {review.completeness_label && (
              <>
                {" "}· Completeness: <span className="font-medium">{COMPLETENESS_LABEL[review.completeness_label]}</span>
              </>
            )}
          </p>
          {review.summary && <p className="mt-2 leading-relaxed text-[var(--ink-secondary)]">{review.summary}</p>}
          {review.suggested_controls.length > 0 && (
            <p className="mt-2 text-[var(--ink-secondary)]">
              <span className="font-medium text-[var(--ink)]">Controls the AI matched:</span>{" "}
              {review.suggested_controls.map((c) => `${c.control_name} (${c.confidence_label.replace("_", " ")})`).join(", ")}
            </p>
          )}
          {review.missing_sections.length > 0 && (
            <div className="mt-2 text-[var(--ink-secondary)]">
              <p className="font-medium text-[var(--ink)]">Items the AI flagged:</p>
              <ul className="mt-1 list-disc pl-5">
                {review.missing_sections.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2 text-xs text-[var(--ink-muted)]">
            {review.model ? `Model: ${review.model}` : review.provider === "none" ? "No model was run" : "Model unknown"}
            {review.reviewed_at ? ` · ${when(review.reviewed_at)}` : ""}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-[var(--ink-muted)]">There is no AI review for this file.</p>
      )}
    </li>
  );
}

export default async function ReportPage(props: PageProps<"/engagements/[engagementId]/report">) {
  const { engagementId } = await props.params;
  const report = await fetchEngagementReport(engagementId);
  if (!report) notFound();

  const { engagement, coverage, requests } = report;
  const gaps =
    coverage.not_reviewed.length +
    coverage.partly_reviewed.length +
    coverage.coverage_not_recorded.length +
    coverage.requests_without_files.length;

  return (
    <main className="bg-[var(--bg)] px-7 py-8 print:bg-white print:p-0">
      <div className="mx-auto mb-6 flex max-w-4xl items-center justify-between print:hidden">
        <Link href={`/engagements/${engagementId}`} className="text-xs font-medium text-[var(--ink-muted)] hover:text-[var(--ink)]">
          ← Overview
        </Link>
        <PrintButton />
      </div>

      <article className="mx-auto max-w-4xl bg-[var(--surface)] px-10 py-10 print:max-w-none print:px-0 print:py-0">
        <header>
          <p className="text-xs font-semibold tracking-wider text-[var(--ink-muted)] uppercase">Evidence review report</p>
          <h1 className="mt-1 text-[28px] leading-tight font-bold tracking-tight text-[var(--ink)]">{engagement.name}</h1>
          <p className="mt-1 text-sm text-[var(--ink-secondary)]">
            {engagement.client_name}
            {engagement.frameworks.length > 0 && ` · ${engagement.frameworks.map((f) => FRAMEWORKS[f] ?? f).join(", ")}`}
            {engagement.period_start && engagement.period_end && ` · ${day(engagement.period_start)} – ${day(engagement.period_end)}`}
          </p>
          <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
            {engagement.lead_auditor && `Lead auditor: ${engagement.lead_auditor} · `}Generated {when(report.generated_at)}
          </p>
          <p className="mt-4 text-sm text-[var(--ink-muted)]">
            Reviews marked <em>AI-generated</em> were produced by a language model from the extracted text of each file. They
            are an aid to the auditor&apos;s judgement, not evidence in themselves, and have not been verified unless an
            auditor decision is shown.
          </p>
        </header>

        <H2>Coverage</H2>
        <p className="text-sm text-[var(--ink-secondary)]">
          {requests.length} request{requests.length === 1 ? "" : "s"} · {coverage.files_total} file
          {coverage.files_total === 1 ? "" : "s"} · {coverage.fully_reviewed} fully reviewed by the AI
        </p>
        {gaps === 0 ? (
          <p className="mt-2 text-sm text-[var(--ink-secondary)]">
            {coverage.files_total > 0
              ? "Every uploaded file was read in full by the AI, and every request has at least one file."
              : "No files have been uploaded yet."}
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm font-medium text-[var(--ink)]">
              The following were not reviewed, or were only partly reviewed, by the AI:
            </p>
            <CoverageGroup title="Not reviewed" items={coverage.not_reviewed} />
            <CoverageGroup title="Only partly reviewed" items={coverage.partly_reviewed} />
            <CoverageGroup title="Coverage not recorded" items={coverage.coverage_not_recorded} />
            {coverage.requests_without_files.length > 0 && (
              <div className="mt-4 break-inside-avoid">
                <h3 className="text-sm font-semibold text-[var(--ink)]">
                  Requests with no files ({coverage.requests_without_files.length})
                </h3>
                <ul className="mt-1.5 space-y-1 text-sm">
                  {coverage.requests_without_files.map((r) => (
                    <li key={r.request_id} className="pl-3 text-[var(--ink-secondary)]">
                      <span className="font-medium text-[var(--ink)]">
                        {r.control_ref} · {r.request_title}
                      </span>{" "}
                      — {STATUS_LABEL[r.status as RequestStatus] ?? r.status}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        <H2>Requests</H2>
        {requests.length === 0 && <p className="text-sm text-[var(--ink-muted)]">This engagement has no requests yet.</p>}
        {requests.map((r) => (
          <section key={r.id} className="mb-10">
            <h3 className="text-base font-semibold text-[var(--ink)]">
              {r.control_ref} · {r.title}
            </h3>
            <p className="mt-0.5 text-sm text-[var(--ink-secondary)]">
              {STATUS_LABEL[r.status as RequestStatus] ?? r.status}
              {r.stakeholder && ` · Assigned to ${r.stakeholder.full_name}${r.stakeholder.role_title ? ` (${r.stakeholder.role_title})` : ""}`}
              {r.due_date && ` · Due ${day(r.due_date)}`}
            </p>
            {r.description && <p className="mt-1 text-sm text-[var(--ink-muted)]">{r.description}</p>}

            <h4 className="mt-5 text-xs font-semibold tracking-wider text-[var(--ink-muted)] uppercase">Files and AI review</h4>
            {r.files.length === 0 ? (
              <p className="mt-1 text-sm text-[var(--ink-muted)]">No files have been uploaded for this request.</p>
            ) : (
              <ul className="mt-1">
                {r.files.map((f) => (
                  <FileBlock key={f.id} file={f} />
                ))}
              </ul>
            )}

            <h4 className="mt-5 text-xs font-semibold tracking-wider text-[var(--ink-muted)] uppercase">Auditor decision</h4>
            {r.decision ? (
              <p className="mt-1 text-sm text-[var(--ink)]">
                <span className="font-medium">{DECISION_LABEL[r.decision.decision]}</span> by {r.decision.decided_by} on{" "}
                {when(r.decision.decided_at)}
                {r.decision.note && <span className="block whitespace-pre-line text-[var(--ink-secondary)]">{r.decision.note}</span>}
              </p>
            ) : (
              <p className="mt-1 text-sm text-[var(--ink-muted)]">No decision has been recorded.</p>
            )}

            <h4 className="mt-5 text-xs font-semibold tracking-wider text-[var(--ink-muted)] uppercase">Activity</h4>
            {r.activity.length === 0 ? (
              <p className="mt-1 text-sm text-[var(--ink-muted)]">No activity recorded.</p>
            ) : (
              <table className="mt-1 w-full text-left text-xs">
                <tbody>
                  {r.activity.map((a, i) => (
                    <tr key={i} className="break-inside-avoid border-t border-[var(--border)] align-top">
                      <td className="w-36 py-1.5 pr-3 whitespace-nowrap text-[var(--ink-muted)]">{when(a.created_at)}</td>
                      <td className="w-32 py-1.5 pr-3 text-[var(--ink-secondary)]">{a.actor}</td>
                      <td className="py-1.5 text-[var(--ink)]">
                        {a.action}
                        {a.detail && <span className="text-[var(--ink-muted)]"> — {a.detail}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </article>
    </main>
  );
}
