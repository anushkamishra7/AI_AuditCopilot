import { notFound } from "next/navigation";
import { ConsoleUploadFlow } from "@/components/upload/console-upload-flow";
import { fetchEngagement, fetchEngagementRequests } from "@/lib/api";

// Statuses where a file is still expected (or wanted again).
const UPLOADABLE = ["not_sent", "awaiting_upload", "changes_requested", "pending_review"];

export default async function UploadPage(props: PageProps<"/engagements/[engagementId]/upload">) {
  const { engagementId } = await props.params;
  const searchParams = await props.searchParams;
  const preselected = typeof searchParams.request === "string" ? searchParams.request : null;

  const engagement = await fetchEngagement(engagementId);
  if (!engagement) notFound();

  const { requests } = await fetchEngagementRequests(engagementId);
  const options = requests
    .filter((r) => UPLOADABLE.includes(r.status))
    .map((r) => ({ id: r.id, title: r.title, control_ref: r.control_ref, status: r.status }));

  return (
    <main className="bg-[var(--bg)] px-7 py-10">
      <ConsoleUploadFlow engagementId={engagementId} requests={options} initialRequestId={preselected} />
    </main>
  );
}
