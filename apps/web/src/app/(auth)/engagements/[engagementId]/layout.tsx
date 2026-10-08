import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { fetchEngagement, fetchEngagementRequests } from "@/lib/api";
import { countRequests } from "@/lib/request-status";
import { formatPeriod } from "@/lib/format";

// Every route under /engagements requires a signed-in auditor. This runs for
// this layout and everything nested under it (overview, evidence, requests,
// the review panel) — a resource-based check, not middleware path matching
// (see src/proxy.ts for why).
export default async function EngagementLayout({ children, params }: LayoutProps<"/engagements/[engagementId]">) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const { engagementId } = await params;
  const [user, engagement, { requests }] = await Promise.all([
    currentUser(),
    fetchEngagement(engagementId),
    fetchEngagementRequests(engagementId),
  ]);
  const needsReviewCount = countRequests(requests).needs_review;

  // Real signed-in identity, not the hardcoded "A. Rao" this used to show
  // regardless of who was actually logged in.
  const userName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.primaryEmailAddress?.emailAddress ||
    "Signed in";
  const userInitials =
    [user?.firstName?.[0], user?.lastName?.[0]].filter(Boolean).join("").toUpperCase() ||
    userName.slice(0, 2).toUpperCase();

  return (
    <AppShell
      engagementId={engagementId}
      engagementName={engagement?.client_name ?? null}
      engagementSubtitle={
        engagement ? `${engagement.name} · ${formatPeriod(engagement.period_start, engagement.period_end)}` : null
      }
      userName={userName}
      userInitials={userInitials}
      userEmail={user?.primaryEmailAddress?.emailAddress ?? null}
      needsReviewCount={needsReviewCount}
    >
      {children}
    </AppShell>
  );
}
