import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { SidebarNav, type NavItem } from "@/components/sidebar-nav";
import { EngagementSwitcher } from "@/components/engagement-switcher";
import { LogoMotion } from "@/components/logo-motion";
import { PageTransition } from "@/components/page-transition";

function navFor(engagementId: string): { primary: NavItem[]; secondary: NavItem[] } {
  const base = `/engagements/${engagementId}`;
  return {
    // Every item here is a real page backed by real data. Workpapers,
    // Reports, Integrations, and a notifications bell used to live here as
    // "not built yet" placeholders -- removed rather than dressed up, since
    // there's no API behind them and a page that can never do anything real
    // is worse than no page at all.
    primary: [
      { label: "Overview", href: base },
      { label: "Evidence", href: `${base}/evidence` },
      { label: "Requests", href: `${base}/requests` },
      { label: "Controls", href: `${base}/controls` },
      { label: "Findings", href: `${base}/findings` },
    ],
    secondary: [
      { label: "Activity", href: `${base}/activity` },
      { label: "Settings", href: `${base}/settings` },
    ],
  };
}

export function AppShell({
  engagementId,
  engagementName,
  engagementSubtitle,
  userName,
  userInitials,
  userEmail,
  children,
}: {
  engagementId: string;
  engagementName: string | null;
  engagementSubtitle: string | null;
  userName: string;
  userInitials: string;
  userEmail: string | null;
  children: React.ReactNode;
}) {
  const nav = navFor(engagementId);

  return (
    <div className="flex min-h-screen bg-[var(--bg)]">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
        <div className="flex h-14 items-center border-b border-[var(--border)] px-4">
          <Link href={`/engagements/${engagementId}`} className="flex items-center">
            <LogoMotion className="text-[22px] leading-none" />
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          <SidebarNav primary={nav.primary} secondary={nav.secondary} />
        </nav>

        <div className="border-t border-[var(--border)] p-3">
          <EngagementSwitcher engagementName={engagementName} />
          <Link
            href="/engagements/new"
            className="mb-3 flex items-center justify-center gap-1.5 rounded-[10px] border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
          >
            + New engagement
          </Link>

          <div className="flex items-center gap-2 rounded-[10px] px-1.5 py-1.5 transition-colors duration-150 hover:bg-[var(--surface-raised)]">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-raised)] text-[11px] font-semibold text-[var(--ink-secondary)]">
              {userInitials}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[var(--ink)]">{userName}</p>
              {userEmail && <p className="truncate text-xs text-[var(--ink-muted)]">{userEmail}</p>}
            </div>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <Topbar
          engagementId={engagementId}
          engagementName={engagementName}
          engagementSubtitle={engagementSubtitle}
          userName={userName}
          userInitials={userInitials}
          userEmail={userEmail}
          nav={nav}
        />
        <PageTransition>{children}</PageTransition>
      </div>
    </div>
  );
}
