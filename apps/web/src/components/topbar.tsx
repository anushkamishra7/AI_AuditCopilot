"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { SearchField } from "@/components/search-field";
import { MobileNav } from "@/components/mobile-nav";
import type { NavItem } from "@/components/sidebar-nav";

export function Topbar({
  engagementId,
  engagementName,
  engagementSubtitle,
  userName,
  userInitials,
  userEmail,
  nav,
}: {
  engagementId: string;
  engagementName: string | null;
  engagementSubtitle: string | null;
  userName: string;
  userInitials: string;
  userEmail: string | null;
  nav: { primary: NavItem[]; secondary: NavItem[] };
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/engagements/${engagementId}/requests?q=${encodeURIComponent(q)}` : `/engagements/${engagementId}/requests`);
  }

  return (
    <header className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b border-[var(--border)] bg-[var(--surface)]/95 px-4 backdrop-blur sm:px-7">
      {/* Only rendered visually below `lg` -- see MobileNav; AppShell's
          desktop <aside> already covers `lg` and up, this stands in for it
          below that, it doesn't duplicate it. */}
      <MobileNav
        engagementId={engagementId}
        engagementName={engagementName}
        userName={userName}
        userInitials={userInitials}
        userEmail={userEmail}
        nav={nav}
      />
      <div className="min-w-0">
        <p className="truncate text-[15px] font-semibold tracking-tight text-[var(--ink)]">{engagementName ?? "Untitled engagement"}</p>
        {engagementSubtitle && <p className="truncate text-xs text-[var(--ink-muted)]">{engagementSubtitle}</p>}
      </div>

      <form onSubmit={submitSearch} className="ml-auto min-w-0 flex-1 max-w-sm">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search requests, controls, people…"
          aria-label="Global search"
        />
      </form>

      {/* No notification bell here -- there was no notification system
          behind it, so it could only ever show "No notifications yet".
          Removed rather than left as permanent dead weight in the header. */}
      <div className="shrink-0">
        <UserButton
          appearance={{
            elements: {
              userButtonAvatarBox: "size-8",
            },
          }}
        />
      </div>
    </header>
  );
}
