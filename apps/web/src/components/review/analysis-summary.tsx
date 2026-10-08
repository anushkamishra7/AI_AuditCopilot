import { RetryAnalysisButton } from "@/components/review/retry-analysis-button";
import { COMPLETENESS_LABEL } from "@/lib/format";
import type { AiReview, CompletenessLabel, EvidenceRequest } from "@/lib/types";

const TONE: Record<CompletenessLabel, { dot: string; bar: string; width: string }> = {
  complete: { dot: "bg-[var(--status-emerald-dot)]", bar: "bg-[var(--status-emerald-dot)]", width: "w-full" },
  partial: { dot: "bg-[var(--status-amber-dot)]", bar: "bg-[var(--status-amber-dot)]", width: "w-1/2" },
  insufficient: { dot: "bg-[var(--status-rose-dot)]", bar: "bg-[var(--status-rose-dot)]", width: "w-1/6" },
};

function nextStep(request: EvidenceRequest, review: AiReview): string | null {
  if (request.status !== "pending_review") return null;
  if (review.completeness === "insufficient") return "The AI couldn't assess this file. Look at it yourself, or ask for a better copy.";
  if (review.completeness === "partial") return "Some items are flagged. Check them below, then approve or ask for more evidence.";
  return "Nothing flagged. Check the document below, then approve it.";
}

/** The answer first: what the AI concluded about the latest upload, in one
 * glance, above the full review. */
export function AnalysisSummary({ request, justUploaded }: { request: EvidenceRequest; justUploaded: boolean }) {
  const review = request.ai_review;

  if (!review) {
    return (
      <section className="border-b border-[var(--border)] bg-[var(--surface)] px-7 py-8">
        <p className="text-sm text-[var(--ink-muted)]">
          {request.files.length > 0
            ? "A file is attached, but it hasn't been analysed. The AI step failed or returned nothing usable."
            : "No file has been uploaded for this request yet."}
        </p>
        {request.files.length > 0 && <RetryAnalysisButton fileId={request.files[0].id} />}
      </section>
    );
  }

  const tone = TONE[review.completeness];
  const controls = review.suggested_controls?.length ?? review.suggested_control_refs.length;
  const next = nextStep(request, review);

  return (
    <section className="animate-fade-in border-b border-[var(--border)] bg-[var(--surface)] px-7 py-8">
      <div className="mx-auto max-w-3xl">
        {justUploaded && (
          <p className="mb-4 text-xs font-semibold tracking-wider text-[var(--status-emerald-ink)] uppercase">
            ✓ Upload analysed
          </p>
        )}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-2xl font-bold tracking-tight text-[var(--ink)]">{COMPLETENESS_LABEL[review.completeness]}</h2>
          <span className="text-sm text-[var(--ink-muted)]">{review.doc_type}</span>
        </div>

        <div className="mt-3 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-[var(--surface-raised)]" aria-hidden>
          <div className={`h-full rounded-full ${tone.bar} ${tone.width}`} />
        </div>

        {review.summary && <p className="mt-5 text-[15px] leading-relaxed text-[var(--ink-secondary)]">{review.summary}</p>}

        <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-3 text-sm">
          <div>
            <dt className="text-xs text-[var(--ink-faint)]">Controls matched</dt>
            <dd className="mt-0.5 font-semibold text-[var(--ink)]">{controls}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--ink-faint)]">Items flagged</dt>
            <dd className="mt-0.5 font-semibold text-[var(--ink)]">{review.flags.length}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--ink-faint)]">Reviewed by</dt>
            <dd className="mt-0.5 font-semibold text-[var(--ink)]">
              {review.model === "unknown model" ? "No model (skipped)" : review.model}
            </dd>
          </div>
        </dl>

        {next && (
          <p className="mt-6 flex items-start gap-2 rounded-lg bg-[var(--surface-raised)] px-4 py-3 text-sm text-[var(--ink-secondary)]">
            <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
            <span>
              <span className="font-medium text-[var(--ink)]">Next: </span>
              {next}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}
