"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// `badge` is a count shown beside the label when greater than zero (e.g.
// requests waiting on the auditor's review).
export type NavItem = { label: string; href: string; badge?: number };

function isActiveItem(item: NavItem, pathname: string) {
  // Overview's own href has no trailing segment, so it must match exactly --
  // otherwise it would light up on every nested route (evidence, requests,
  // a specific request) too.
  const isOverview = item.label === "Overview";
  return isOverview ? pathname === item.href : pathname.startsWith(item.href);
}

export function SidebarNav({ primary, secondary }: { primary: NavItem[]; secondary: NavItem[] }) {
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  // One shared indicator, positioned by measuring the active <li> and
  // translating to it -- real motion between arbitrary list items (which
  // can be in either the primary or secondary group) without a layout-
  // animation library. transform-only, so it's cheap and reduced-motion-safe.
  const [indicator, setIndicator] = useState({ top: 0, height: 0, visible: false });

  const activeHref = [...primary, ...secondary].find((item) => isActiveItem(item, pathname))?.href;

  useLayoutEffect(() => {
    const containerEl = containerRef.current;
    const activeEl = activeHref ? itemRefs.current.get(activeHref) : undefined;
    if (!containerEl || !activeEl) {
      setIndicator((prev) => ({ ...prev, visible: false }));
      return;
    }
    const containerRect = containerEl.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    setIndicator({ top: activeRect.top - containerRect.top, height: activeRect.height, visible: true });
  }, [activeHref]);

  return (
    <div ref={containerRef} className="relative">
      <div
        aria-hidden
        className="absolute left-0 w-[3px] bg-[var(--accent)] transition-[transform,height,opacity] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{
          height: indicator.height,
          transform: `translateY(${indicator.top}px)`,
          opacity: indicator.visible ? 1 : 0,
        }}
      />
      <NavGroup label="Engagement" items={primary} pathname={pathname} itemRefs={itemRefs} />
      <div className="my-3 border-t border-[var(--border)]" />
      <NavGroup items={secondary} pathname={pathname} itemRefs={itemRefs} />
    </div>
  );
}

function NavGroup({
  label,
  items,
  pathname,
  itemRefs,
}: {
  label?: string;
  items: NavItem[];
  pathname: string;
  itemRefs: React.RefObject<Map<string, HTMLLIElement>>;
}) {
  return (
    <div>
      {label && (
        <p className="px-2 pb-2 text-[11px] font-semibold tracking-wider text-[var(--ink-faint)] uppercase">
          {label}
        </p>
      )}
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = isActiveItem(item, pathname);
          return (
            <li
              key={item.label}
              ref={(el) => {
                if (el) itemRefs.current.set(item.href, el);
                else itemRefs.current.delete(item.href);
              }}
            >
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                // Fixed pl-3 regardless of active state (was a 3px border +
                // 9px padding trick to reserve the same space) -- the real
                // indicator is the absolutely-positioned bar above now, not
                // a border on the link itself, so text no longer needs to
                // shift when the border used to appear/disappear.
                className={`flex items-center justify-between gap-2 rounded-md py-1.5 pr-2.5 pl-3 text-sm font-medium transition-colors duration-150 ${
                  active
                    ? "bg-[var(--surface-raised)] text-[var(--accent)]"
                    : "text-[var(--ink-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
                }`}
              >
                <span>{item.label}</span>
                {item.badge ? (
                  <span
                    aria-label={`${item.badge} need${item.badge === 1 ? "s" : ""} review`}
                    className="min-w-5 rounded-full bg-[var(--status-amber-bg)] px-1.5 text-center text-[11px] leading-5 font-semibold text-[var(--status-amber-ink)] ring-1 ring-[var(--status-amber-ring)]"
                  >
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
