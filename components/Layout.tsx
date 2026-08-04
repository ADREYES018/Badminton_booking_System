/**
 * Page shell and the floating bottom navigation.
 *
 * The layout follows the Stitch mockups — centred floating pill nav, generous
 * mobile margins, sticky action bar — but the nav links are real, labelled, and
 * mark the current page for screen readers.
 */

import type { ComponentChildren } from "preact";
import type { User } from "../lib/types.ts";
import { LogoHorizontal } from "./LogoHorizontal.tsx";
import { cx } from "./ui.tsx";

export type NavKey = "games" | "checkin" | "stats" | "profile";

interface NavItem {
  key: NavKey;
  href: string;
  label: string;
  icon: ComponentChildren;
}

/** 2px stroke rounded line icons, per the design system. */
const iconProps = {
  width: 26,
  height: 26,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  // Labels come from the adjacent text, so the glyph itself is decorative.
  "aria-hidden": true,
};

const NAV_ITEMS: NavItem[] = [
  {
    key: "games",
    href: "/games",
    label: "Games",
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
      </svg>
    ),
  },
  {
    key: "checkin",
    href: "/checkin",
    label: "Check in",
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <path d="M14 14h3v3h-3zM19 19h2M17 21h4" />
      </svg>
    ),
  },
  {
    key: "stats",
    href: "/stats",
    label: "Stats",
    icon: (
      <svg {...iconProps}>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </svg>
    ),
  },
  {
    key: "profile",
    href: "/profile",
    label: "Profile",
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
    ),
  },
];

/**
 * Keeps navigation inside the club being viewed.
 *
 * The bare paths still work — they redirect — but sending someone from one
 * club's games to another club's stats because that is where a redirect landed
 * them would be its own kind of wrong. Profile is not a club page, so it keeps
 * its single address.
 */
function navHref(item: NavItem, groupSlug?: string): string {
  if (!groupSlug || item.key === "profile") return item.href;
  return `/g/${groupSlug}/${item.key}`;
}

export function BottomNav(props: { active?: NavKey; groupSlug?: string }) {
  return (
    <nav
      aria-label="Main"
      // Tighter on a phone, where `gap-6` and `px-6` squeezed "Check in" onto
      // two lines and pushed the bar wider than the labels needed.
      class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-surface-lowest rounded-full
             shadow-float px-3 sm:px-6 py-3 flex items-center gap-2 sm:gap-6
             max-w-[92vw] pb-safe"
    >
      {NAV_ITEMS.map((item) => {
        const active = props.active === item.key;
        return (
          <a
            key={item.key}
            href={navHref(item, props.groupSlug)}
            aria-current={active ? "page" : undefined}
            class={cx(
              // `whitespace-nowrap` keeps "Check in" on one line; without it a
              // narrow phone breaks it after "Check" and the bar grows a row.
              "flex flex-col items-center justify-center gap-0.5 px-2 py-1",
              "rounded-lg transition-colors whitespace-nowrap",
              active
                ? "text-primary"
                : "text-on-surface-variant hover:text-primary",
            )}
          >
            {item.icon}
            <span class="text-[10px] font-medium">{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function AppHeader(props: { user?: User | null; groupSlug?: string }) {
  const home = props.groupSlug ? `/g/${props.groupSlug}/games` : "/games";
  return (
    <header class="w-full border-b border-outline-variant/40 bg-surface">
      <div class="max-w-[1200px] mx-auto px-5 md:px-10 py-4 flex items-center justify-between">
        <a href={home} class="flex items-center" aria-label="Smash Club home">
          <LogoHorizontal class="h-9 w-auto text-on-surface" />
        </a>
        {props.user && (
          <a
            href="/profile"
            class="text-label font-bold text-on-surface-variant hover:text-primary transition-colors"
          >
            {props.user.name || "Complete profile"}
          </a>
        )}
      </div>
    </header>
  );
}

export function Page(
  props: {
    children: ComponentChildren;
    user?: User | null;
    nav?: NavKey;
    /** Keeps the header and navigation pointing inside this club. */
    groupSlug?: string;
    /** Hides the chrome for focused flows such as login. */
    bare?: boolean;
    class?: string;
  },
) {
  if (props.bare) {
    return (
      <div class="min-h-dvh flex flex-col items-center justify-center px-5 py-10">
        {props.children}
      </div>
    );
  }

  return (
    <div class="min-h-dvh flex flex-col">
      <AppHeader user={props.user} groupSlug={props.groupSlug} />
      {
        /*
        The bottom padding clears the floating nav, which is out of flow and
        would otherwise sit on top of whatever the page ends with. It has to
        cover the bar's height, its `bottom-6` offset and the home indicator
        on a phone, so the safe-area inset is added rather than assumed.
      */
      }
      <main
        class={cx(
          "flex-1 w-full max-w-[1200px] mx-auto px-5 md:px-10 pt-8",
          "pb-[calc(9rem+env(safe-area-inset-bottom))]",
          props.class,
        )}
      >
        {props.children}
      </main>
      <BottomNav active={props.nav} groupSlug={props.groupSlug} />
    </div>
  );
}
