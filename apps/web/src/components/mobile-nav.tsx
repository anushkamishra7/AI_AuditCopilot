"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SidebarNav, type NavItem } from "@/components/sidebar-nav";
import { EngagementSwitcher } from "@/components/engagement-switcher";
import { LogoMotion } from "@/components/logo-motion";

// Below `lg`, AppShell's <aside> is `hidden` outright with nothing standing
// in for it -- there was no way to reach Requests/Controls/Findings/etc. on
// any window narrower than 1024px at all. This is that fallback: a hamburger
// button (itself only shown below `lg`, since the real sidebar already
// covers `lg` and up) that opens the same nav content as a slide-in drawer.
export function MobileNav({
  engagementId,
  engagementName,
  userName,
  userInitials,
  userEmail,
  nav,
}: {
  engagementId: string;
  engagementName: string | null;
  userName: string;
  userInitials: string;
  userEmail: string | null;
  nav: { primary: NavItem[]; secondary: NavItem[] };
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // The trigger button lives wherever this component is rendered (inside
  // Topbar's <header>, so it sits in the header's own flex row) -- but the
  // drawer and backdrop below are `fixed`, and Topbar's <header> has
  // `backdrop-blur`. backdrop-filter (like filter/transform/perspective)
  // creates a new containing block for fixed-positioned descendants per
  // spec, so without this portal the drawer would size itself against the
  // 64px-tall header instead of the viewport -- confirmed by measuring it
  // at 63px tall instead of the full screen before this fix. Portalling to
  // <body> sidesteps that regardless of what filter/transform properties
  // any future ancestor ends up with.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // There's no way to detect "we're on the client, post-hydration"
    // other than an effect -- that's exactly what effects are for, and
    // this is the same client-mount idiom Radix/Headless UI use ahead of
    // any portal. Intentionally empty deps: fires once, doesn't need to
    // react to `mounted` itself changing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // Close on navigation -- otherwise the drawer would still be open
  // covering the new page after tapping a link. Adjusted during render
  // (React's documented pattern for "reset state when a prop changes"),
  // not inside an effect -- an unconditional setState in an effect body
  // triggers a cascading extra render every time and is the exact case
  // react-hooks/set-state-in-effect exists to catch.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    if (open) setOpen(false);
  }

  // Close on Escape, and stop the page scrolling behind the drawer while
  // it's open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const overlay = (
    <>
      {/* Backdrop -- also closes the drawer on click, mirrors how the
          rest of the app treats overlays (review-panel's file preview,
          etc.): click-outside-to-dismiss, not a dead-end modal. */}
      <div
        aria-hidden={!open}
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-[var(--duration-base)] lg:hidden ${
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)] lg:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4">
          <Link href={`/engagements/${engagementId}`} className="flex items-center">
            <LogoMotion className="text-[22px] leading-none" />
          </Link>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="flex size-8 items-center justify-center rounded-lg text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-raised)]"
          >
            <MenuIcon open />
          </button>
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
          <div className="flex items-center gap-2 rounded-[10px] px-1.5 py-1.5">
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
    </>
  );

  return (
    <>
      <button
        type="button"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-raised)] lg:hidden"
      >
        <MenuIcon open={open} />
      </button>
      {mounted && createPortal(overlay, document.body)}
    </>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="size-5" aria-hidden>
        <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="size-5" aria-hidden>
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
    </svg>
  );
}
