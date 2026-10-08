"""Assembles the engagement report. Pure: takes rows already read from the
database and returns the structure the printable page renders, so the coverage
logic (what was and was not actually reviewed) can be tested without a database.

Everything the model produced is under `review` with `ai_generated: True`;
nothing the model said is mixed into the facts about the files or the
auditor's decision.
"""

COVERAGE_FULL = "fully_reviewed"
COVERAGE_PARTIAL = "partly_reviewed"
COVERAGE_NONE = "not_reviewed"
COVERAGE_UNKNOWN = "coverage_not_recorded"


def classify_coverage(review: dict | None) -> dict:
    """How much of one file the AI actually read. `review` is the stored
    review row (with its raw_response), or None if there is no review."""
    if review is None:
        return {
            "status": COVERAGE_NONE,
            "detail": "No AI review was recorded for this file (the analysis failed, or has not run).",
        }
    raw = review.get("raw_response") if isinstance(review.get("raw_response"), dict) else {}
    if raw.get("provider") == "none" or raw.get("finish_reason") == "skipped_no_text":
        return {
            "status": COVERAGE_NONE,
            "detail": "No text could be extracted from this file (it may be a scan or image-only PDF), so the model was not run.",
        }
    total, reviewed = raw.get("chars_total"), raw.get("chars_reviewed")
    if not isinstance(total, int) or not isinstance(reviewed, int):
        return {
            "status": COVERAGE_UNKNOWN,
            "detail": "This review was created before coverage was recorded, so how much of the file was read is not known.",
        }
    if raw.get("truncated") or reviewed < total:
        return {
            "status": COVERAGE_PARTIAL,
            "detail": f"Only the first {reviewed:,} of {total:,} characters were analysed; the rest of the file was not reviewed.",
            "chars_total": total,
            "chars_reviewed": reviewed,
        }
    return {
        "status": COVERAGE_FULL,
        "detail": f"All {total:,} extracted characters were analysed by the model.",
        "chars_total": total,
        "chars_reviewed": reviewed,
    }


def _review_view(review: dict | None) -> dict | None:
    if review is None:
        return None
    raw = review.get("raw_response") if isinstance(review.get("raw_response"), dict) else {}
    return {
        "ai_generated": True,
        "document_type": review.get("document_type"),
        "summary": review.get("summary"),
        "completeness_label": review.get("completeness_label"),
        "suggested_controls": review.get("suggested_controls") or [],
        "missing_sections": review.get("missing_sections") or [],
        "provider": raw.get("provider"),
        "model": raw.get("model_resolved") or raw.get("model_requested"),
        "reviewed_at": review.get("created_at"),
    }


def build_report(
    *,
    engagement: dict,
    requests: list[dict],
    files: list[dict],
    reviews_by_file: dict[str, dict],
    decisions_by_request: dict[str, dict],
    activity: list[dict],
    generated_at: str,
) -> dict:
    files_by_request: dict[str, list[dict]] = {}
    for f in sorted(files, key=lambda f: (f.get("uploaded_at") or "", f["id"])):
        files_by_request.setdefault(f["evidence_request_id"], []).append(f)
    activity_by_request: dict[str, list[dict]] = {}
    for a in sorted(activity, key=lambda a: a.get("created_at") or ""):
        activity_by_request.setdefault(a["request_id"], []).append(a)

    buckets: dict[str, list[dict]] = {COVERAGE_PARTIAL: [], COVERAGE_NONE: [], COVERAGE_UNKNOWN: []}
    full = 0
    total_files = 0
    without_files: list[dict] = []
    out_requests = []

    for r in requests:
        out_files = []
        for f in files_by_request.get(r["id"], []):
            review = reviews_by_file.get(f["id"])
            coverage = classify_coverage(review)
            out_files.append(
                {
                    "id": f["id"],
                    "filename": f["filename"],
                    "size_bytes": f.get("size_bytes"),
                    "uploaded_at": f.get("uploaded_at"),
                    "review": _review_view(review),
                    "coverage": coverage,
                }
            )
            total_files += 1
            if coverage["status"] == COVERAGE_FULL:
                full += 1
            else:
                buckets[coverage["status"]].append(
                    {
                        "request_id": r["id"],
                        "request_title": r["title"],
                        "control_ref": r["control_ref"],
                        "file_id": f["id"],
                        "filename": f["filename"],
                        "detail": coverage["detail"],
                    }
                )
        if not out_files:
            without_files.append({"request_id": r["id"], "request_title": r["title"], "control_ref": r["control_ref"], "status": r["status"]})
        out_requests.append(
            {
                **r,
                "files": out_files,
                "decision": decisions_by_request.get(r["id"]),
                "activity": activity_by_request.get(r["id"], []),
            }
        )

    return {
        "generated_at": generated_at,
        "engagement": engagement,
        "requests": out_requests,
        "coverage": {
            "files_total": total_files,
            "fully_reviewed": full,
            "partly_reviewed": buckets[COVERAGE_PARTIAL],
            "not_reviewed": buckets[COVERAGE_NONE],
            "coverage_not_recorded": buckets[COVERAGE_UNKNOWN],
            "requests_without_files": without_files,
        },
    }
