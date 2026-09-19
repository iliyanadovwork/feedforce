'use client';

import { useState, useRef } from 'react';
import type { AppSection } from '../types';
import { Avatar, RAIL_W, RAIL_W_COLLAPSED, HEADER_H } from './ui';
import { FeedForceLogo } from './Logo';
import { usePlan } from './PlanContext';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';

interface SidebarProps {
  active: AppSection;
  onSelect: (s: AppSection) => void;
  signedIn: boolean;
  email?: string | null;
  supportAdmin?: boolean;       // admin accounts only (ADMIN_EMAILS probe) — reveals the Support inbox link to /admin
  supportNeedsReply?: number;   // open support threads awaiting an admin reply — the link's badge
}

const Icon = ({ children, size = 18 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

type NavEntry = { id: AppSection; label: string; icon: React.ReactNode };

// Pro-only sections (FREE_TIER_PLAN.md): shown to free users with a "Pro" chip; clicking opens the
// upgrade prompt instead of navigating. Deep entry is separately gated in page.tsx.
const PRO_SECTIONS: Partial<Record<AppSection, string>> = {
  automations: 'Node automations are a Pro feature.',
  schedule: 'Scheduling and publishing are Pro features.',
  analytics: 'Post analytics is a Pro feature.',
  rewards: 'Creator rewards is a Pro feature.',
};

// Set-up-once sections at the top: Branding + Template editor (making reusable brand assets and
// templates is a setup task you do before creating posts).
const SETUP_NAV: NavEntry[] = [
  { id: 'branding', label: 'Branding', icon: <Icon><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><path d="M12 22a10 10 0 1 1 0-20 10 10 0 0 1 10 10c0 2.21-1.79 4-4 4-1.66 0-3 1.34-3 3" /></Icon> },
  { id: 'automations', label: 'Automations', icon: <Icon><rect x="3" y="9" width="6" height="6" rx="1.5" /><rect x="15" y="4" width="6" height="6" rx="1.5" /><rect x="15" y="14" width="6" height="6" rx="1.5" /><path d="M9 12h3M12 12V7h3M12 12v5h3" /></Icon> },
];

// Create pair — Carousels + Reels. Icons mirror the Carousel/Reels toggle in the editor
// (RailIcons.carousel / RailIcons.reels) so the two formats read the same everywhere.
const CREATE_NAV: NavEntry[] = [
  { id: 'template-editor', label: 'Template editor', icon: <Icon><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></Icon> },
  { id: 'posts', label: 'Carousels', icon: <Icon size={20}><rect x="7" y="5" width="10" height="14" rx="2" /><path d="M4 8v8M20 8v8" /></Icon> },
  { id: 'video-reels', label: 'Reels', icon: <Icon><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M3 8h18M7.5 3 10 8M13 3 15.5 8" /><path d="M10.5 11.5v5l4.5-2.5z" fill="currentColor" stroke="none" /></Icon> },
];

// Post (scheduling/publishing — paper plane) + Analytics (bar chart) + Rewards (trophy — the
// creator rewards program) sit together at the bottom.
const SCHEDULE_NAV: NavEntry[] = [
  { id: 'schedule', label: 'Post', icon: <Icon size={15}><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" /></Icon> },
  { id: 'analytics', label: 'Analytics', icon: <Icon size={16}><path d="M3 3v18h18" /><rect x="7" y="12" width="3" height="5" /><rect x="12" y="8" width="3" height="9" /><rect x="17" y="5" width="3" height="12" /></Icon> },
  { id: 'rewards', label: 'Rewards', icon: <Icon size={16}><path d="M8 21h8" /><path d="M12 17v4" /><path d="M7 3h10v6a5 5 0 0 1-10 0z" /><path d="M17 5h3v1a3.5 3.5 0 0 1-3.5 3.5" /><path d="M7 5H4v1a3.5 3.5 0 0 0 3.5 3.5" /></Icon> },
];

// Admin-only: the support inbox lives in the /admin operator panel; this is the inbox icon reused
// by the sidebar link there (shown only when the /api/support/inbox probe confirms the signed-in
// account is in ADMIN_EMAILS — access is enforced server-side either way).
const SUPPORT_INBOX_ICON = (
  <Icon size={16}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></Icon>
);

// Collapsed-sidebar hover tooltip, styled like the element rail's pill (replaces the native title).
// It's position:fixed (coords measured from the trigger on hover) so it escapes the nav's
// overflow-y-auto, which would otherwise clip a normal absolute pill at the sidebar edge.
function useCollapsedTip<T extends HTMLElement = HTMLButtonElement>(collapsed: boolean) {
  const ref = useRef<T>(null);
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);
  const [shown, setShown] = useState(false);
  function open() {
    const el = ref.current;
    if (!collapsed || !el) return;
    const r = el.getBoundingClientRect();
    setTip({ top: r.top + r.height / 2, left: r.right + 12 });
    setShown(true);
  }
  const close = () => setShown(false);
  return { ref, tip, shown, hover: { onMouseEnter: open, onMouseLeave: close, onFocus: open, onBlur: close } };
}

// The pill itself. Kept mounted while collapsed so opacity can transition (fade) rather than popping.
function CollapsedTip({ label, tip, shown, collapsed }: { label: string; tip: { top: number; left: number } | null; shown: boolean; collapsed: boolean }) {
  if (!collapsed) return null;
  return (
    <span
      role="tooltip"
      style={{ position: 'fixed', top: tip?.top ?? 0, left: tip?.left ?? 0, transform: 'translateY(-50%)' }}
      className={`pointer-events-none z-dropdown whitespace-nowrap rounded-lg bg-surface-overlay border border-line shadow-2 px-2.5 py-1 text-caption text-fg transition-opacity duration-[var(--dur-base)] motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`}
    >
      {label}
    </span>
  );
}

// Admin-only nav row linking to the Support inbox in /admin. Same anatomy as NavRow (hover pill,
// collapsed tooltip, icon nudge) but an anchor — the operator panel is its own route. The badge is
// the needs-reply count: a pill when expanded, a corner dot on the icon when collapsed.
function AdminInboxLink({ collapsed, count }: { collapsed: boolean; count: number }) {
  const { ref, tip, shown, hover } = useCollapsedTip<HTMLAnchorElement>(collapsed);
  const tipLabel = count > 0 ? `Support inbox · ${count} awaiting reply` : 'Support inbox';
  return (
    <a
      ref={ref}
      {...hover}
      href="/admin"
      aria-label={tipLabel}
      className="group relative w-full flex items-center gap-3 px-3 h-9 rounded-md focus-ring transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] text-fg-3 hover:text-fg"
    >
      <span
        aria-hidden
        className={`absolute -z-10 inset-y-0 transition-colors duration-[var(--dur-fast)] group-hover:bg-hover ${collapsed ? 'left-1/2 -translate-x-1/2 w-9 rounded-lg' : 'left-0 right-0 rounded-md'}`}
      />
      <span className={`relative shrink-0 transition-transform duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)] ${collapsed ? 'translate-x-[3px]' : ''}`}>
        {SUPPORT_INBOX_ICON}
        {/* Collapsed: the count pill has no room, so a corner dot carries the "new messages" signal. */}
        {count > 0 && (
          <span
            aria-hidden
            className={`absolute -top-0.5 -right-0.5 size-2 rounded-full bg-accent transition-opacity duration-[var(--dur-base)] ${collapsed ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
      </span>
      <span className={`flex-1 min-w-0 text-left text-label truncate transition-opacity duration-[var(--dur-base)] ease-[var(--ease-standard)] ${collapsed ? 'opacity-0' : 'opacity-100'}`}>
        Support inbox
      </span>
      {count > 0 && (
        <span
          aria-hidden
          className={`shrink-0 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg transition-opacity duration-[var(--dur-base)] ${collapsed ? 'opacity-0' : 'opacity-100'}`}
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
      <CollapsedTip label={tipLabel} tip={tip} shown={shown} collapsed={collapsed} />
    </a>
  );
}

function NavRow({ entry, active, collapsed, onSelect }: { entry: NavEntry; active: AppSection; collapsed: boolean; onSelect: (s: AppSection) => void }) {
  const isActive = active === entry.id;
  const { ref, tip, shown, hover } = useCollapsedTip(collapsed);
  const { plan, openUpgrade } = usePlan();
  const proReason = plan === 'free' ? PRO_SECTIONS[entry.id] : undefined;
  return (
    <button
      ref={ref}
      {...hover}
      onClick={() => (proReason ? openUpgrade(proReason) : onSelect(entry.id))}
      aria-current={isActive ? 'page' : undefined}
      className={`group relative w-full flex items-center gap-3 px-3 h-9 rounded-md focus-ring transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] ${
        isActive ? 'text-fg' : 'text-fg-3 hover:text-fg'
      }`}
    >
      {/* Highlight sits behind the icon: full-width pill when expanded, centred size-9 square when
          collapsed (matches the element rail's icon buttons). */}
      <span
        aria-hidden
        className={`absolute -z-10 inset-y-0 transition-colors duration-[var(--dur-fast)] ${collapsed ? 'left-1/2 -translate-x-1/2 w-9 rounded-lg' : `${isActive ? 'left-1.5' : 'left-0'} right-0 rounded-md`} ${isActive ? 'bg-surface-2' : 'group-hover:bg-hover'}`}
      />
      {/* Nudged 3px right when collapsed to sit dead-centre: 64/2 − (nav px-2 8 + button px-3 12 + icon
          half 9) = 3. Transitioned on the collapse's own duration/easing so the shift glides with the
          width animation instead of jolting at the very end. */}
      <span className={`shrink-0 transition-transform duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)] ${collapsed ? 'translate-x-[3px]' : ''}`}>{entry.icon}</span>
      <span className={`flex-1 min-w-0 text-left text-label truncate transition-opacity duration-[var(--dur-base)] ease-[var(--ease-standard)] ${collapsed ? 'opacity-0' : 'opacity-100'}`}>
        {entry.label}
      </span>
      {proReason && (
        <span className={`shrink-0 text-[9px] font-semibold uppercase tracking-wider rounded-full border border-line px-1.5 py-px text-fg-3 transition-opacity duration-[var(--dur-base)] ${collapsed ? 'opacity-0' : 'opacity-100'}`}>
          Pro
        </span>
      )}
      <CollapsedTip label={entry.label} tip={tip} shown={shown} collapsed={collapsed} />
    </button>
  );
}

export function Sidebar({ active, onSelect, signedIn, email, supportAdmin, supportNeedsReply }: SidebarProps) {
  // Collapsed to icons by default; expands to labels on hover. The rail is position:fixed and
  // overlays the page (z-max — the nav must stay reachable above EVERY editor overlay, incl. the
  // automations template-edit panel), so expanding doesn't reflow the main content — it just slides
  // wider over it. The persisted --rail-w stays pinned at the collapsed width (see page.tsx).
  const [hovered, setHovered] = useState(false);
  const collapsed = !hovered;
  const { ref: accountBtnRef, hover: accountHover, tip: accountTipPos, shown: accountTipShown } = useCollapsedTip(collapsed);

  return (
    <aside
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ width: collapsed ? RAIL_W_COLLAPSED : RAIL_W }}
      className="fixed top-0 left-0 h-screen bg-surface-1 border-r border-line flex flex-col z-max transition-[width] duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)]"
    >
      {/* Brand — logo always visible; the "FeedForce" wordmark reveals on hover-expand. */}
      {/* Static layout: constant padding/gap and ALWAYS left-aligned. We deliberately don't toggle
          justify-content (center↔start) — that flips instantly while padding eases, snapping the logo
          sideways at the start of the width animation (the wobble). Instead the logo glides via a
          transform below, so nothing here animates layout. */}
      <div
        style={{ height: HEADER_H }}
        className="shrink-0 flex items-center gap-1 pl-5 pr-2 border-b border-line"
      >
        {/* The FeedForce logo (single source of truth: components/Logo.tsx). Stays visible collapsed.
            Nudged 3px right when collapsed so it sits dead-centre in the 64px rail, then glides back
            on the width animation's own clock — transform only (composited, no layout snap), mirroring
            the nav-row icons. */}
        <FeedForceLogo className={`shrink-0 h-[15px] w-auto transition-transform duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)] ${collapsed ? 'translate-x-[3px]' : ''}`} />
        {/* Neue Montreal Bold — self-hosted via @font-face in globals.css (file in public/).
            Collapses to zero width (max-w-0 + overflow-hidden) so it takes no space when collapsed and
            wipes in left-anchored as the rail widens; the logo's x stays put, so it never tugs sideways. */}
        <span
          style={{ fontFamily: "'Neue Montreal', var(--font-system)" }}
          className={`min-w-0 overflow-hidden whitespace-nowrap text-[17px] font-bold tracking-tight leading-none text-fg select-none transition-[opacity,max-width] duration-[var(--dur-base)] ease-[var(--ease-standard)] ${collapsed ? 'opacity-0 max-w-0' : 'opacity-100 max-w-[140px]'}`}
        >
          FeedForce
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 flex flex-col gap-1">
        {SETUP_NAV.filter(e => AUTOMATIONS_ENABLED || e.id !== 'automations').map(e => <NavRow key={e.id} entry={e} active={active} collapsed={collapsed} onSelect={onSelect} />)}
        {/* Divider = just more space (no line): separates the setup pair from the create pair. */}
        <div aria-hidden className="h-4" />
        {CREATE_NAV.map(e => <NavRow key={e.id} entry={e} active={active} collapsed={collapsed} onSelect={onSelect} />)}
        {/* Divider: separates the create pair from Post. */}
        <div aria-hidden className="h-4" />
        {SCHEDULE_NAV.map(e => <NavRow key={e.id} entry={e} active={active} collapsed={collapsed} onSelect={onSelect} />)}
        {supportAdmin && <AdminInboxLink collapsed={collapsed} count={supportNeedsReply ?? 0} />}
      </nav>

      {/* Account */}
      {signedIn && (
        <div className="shrink-0 border-t border-line p-2">
          <button
            ref={accountBtnRef}
            {...accountHover}
            onClick={() => onSelect('account')}
            aria-current={active === 'account' ? 'page' : undefined}
            className={`w-full flex items-center justify-start gap-2.5 px-2 h-12 rounded-md focus-ring transition-colors ${active === 'account' ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'}`}
          >
            {/* Avatar pinned left (justify-start + constant gap above) so the text reveal never tugs it
                sideways — and no instant gap flip to snap it. Nudged 2px right when collapsed to sit
                centred in the 64px rail, gliding back on the width animation's clock — transform only,
                mirroring the brand logo. */}
            <span className={`shrink-0 transition-transform duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)] ${collapsed ? 'translate-x-[2px]' : ''}`}>
              {email ? <Avatar fallback={email.charAt(0)} size={28} /> : (
                <span className="grid place-items-center size-7 rounded-full bg-surface-3 text-fg-3 shrink-0"><Icon><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Icon></span>
              )}
            </span>
            <span className={`flex-1 min-w-0 flex items-center gap-2.5 overflow-hidden transition-[max-width,opacity] duration-[var(--dur-base)] ease-[var(--ease-standard)] ${collapsed ? 'max-w-0 opacity-0' : 'max-w-[200px] opacity-100'}`}>
              <span className="flex-1 min-w-0 text-left">
                <span className="block text-label text-fg">Account</span>
                {email && <span className="block text-caption text-fg-3 truncate">{email}</span>}
              </span>
              <span className="shrink-0 text-fg-4"><Icon><path d="m9 6 6 6-6 6" /></Icon></span>
            </span>
            <CollapsedTip label={email ?? 'Account'} tip={accountTipPos} shown={accountTipShown} collapsed={collapsed} />
          </button>
        </div>
      )}
    </aside>
  );
}
