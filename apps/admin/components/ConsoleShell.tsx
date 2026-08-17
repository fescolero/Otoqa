'use client';

/**
 * The console gate + shell. Renders an access-denied screen unless
 * api.platform.access.me succeeds — that query runs requirePlatformStaff
 * server-side, so the UI can't be tricked into rendering for a non-staff
 * session (and even if it were, every platform query/mutation re-checks
 * independently). A non-staff caller makes `me` THROW a ConvexError, which
 * Convex surfaces through React's error boundary mechanism — hence the
 * boundary below rather than a null check.
 */

import { Component, ReactNode, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '@otoqa/convex-client';
import {
  Activity,
  Building2,
  LayoutDashboard,
  LifeBuoy,
  Receipt,
  ScrollText,
  Timer,
  ToggleLeft,
  type LucideIcon,
} from 'lucide-react';

type NavCounts = {
  alerts: number;
  alertsHigh: number;
  tickets: number;
  jobsBad: number;
  billingOverdue: number;
  billingDrafts: number;
};

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Count and dot shown on the item. Absent = nothing to say about it. */
  signal?: (c: NavCounts) => { count?: number; tone?: 'ok' | 'warn' | 'danger' } | null;
};

/**
 * Grouped so the sidebar reads as three jobs rather than eight pages: who we
 * serve, what the machine is doing, and the record of what we did to it.
 */
const NAV: { label: string | null; items: NavItem[] }[] = [
  {
    label: null,
    items: [
      {
        label: 'Overview',
        href: '/',
        icon: LayoutDashboard,
        signal: (c) =>
          c.alerts > 0 ? { count: c.alerts, tone: c.alertsHigh > 0 ? 'danger' : 'warn' } : null,
      },
    ],
  },
  {
    label: 'Customers',
    items: [
      { label: 'Organizations', href: '/organizations', icon: Building2 },
      {
        label: 'Billing',
        href: '/billing',
        icon: Receipt,
        signal: (c) =>
          c.billingOverdue > 0
            ? { count: c.billingOverdue, tone: 'danger' }
            : c.billingDrafts > 0
              ? { count: c.billingDrafts, tone: 'warn' }
              : null,
      },
      {
        label: 'Tickets',
        href: '/tickets',
        icon: LifeBuoy,
        signal: (c) => (c.tickets > 0 ? { count: c.tickets, tone: 'warn' } : null),
      },
    ],
  },
  {
    label: 'Platform',
    items: [
      {
        label: 'Jobs',
        href: '/jobs',
        icon: Timer,
        signal: (c) => (c.jobsBad > 0 ? { count: c.jobsBad, tone: 'danger' } : null),
      },
      { label: 'Health', href: '/health', icon: Activity },
      { label: 'Flags', href: '/flags', icon: ToggleLeft },
    ],
  },
  {
    label: 'Record',
    items: [{ label: 'Audit', href: '/audit', icon: ScrollText }],
  },
];

export function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <AccessBoundary>
      <GatedShell>{children}</GatedShell>
    </AccessBoundary>
  );
}

function GatedShell({ children }: { children: ReactNode }) {
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  // Throws (→ AccessBoundary → Denied) when the caller is not platform staff.
  const me = useQuery(api.platform.access.me, isAuthenticated ? {} : 'skip');
  const recordSessionStart = useMutation(api.platform.access.recordSessionStart);
  const sessionRecorded = useRef(false);

  // One audit row per console load, only after the gate passes.
  useEffect(() => {
    if (me && !sessionRecorded.current) {
      sessionRecorded.current = true;
      recordSessionStart({}).catch(() => {
        // Audit write failing must not take the console down; the access
        // itself was already authorized server-side.
      });
    }
  }, [me, recordSessionStart]);

  if (authLoading || !isAuthenticated || me === undefined) {
    return <div className="loading">Loading console…</div>;
  }

  return (
    <div className="console-shell">
      <aside className="console-sidebar">
        <div className="console-brand">
          {/* The mark, inline rather than <img>: it must render before any
              network round-trip, because this shell is what an operator sees
              when everything else is broken. */}
          <svg className="console-brand-mark" viewBox="0 0 64 64" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="#2E5CFF" />
            <circle cx="32" cy="32" r="14.5" fill="none" stroke="#FFFFFF" strokeWidth="7" />
          </svg>
          <span className="console-brand-word">otoqa</span>
          <span className="console-brand-suffix">console</span>
        </div>
        <ShellNav />
        <div className="console-sidebar-footer">
          <span>{me.email}</span>
          <a href="/sign-out">Sign out</a>
        </div>
      </aside>
      <main className="console-main">{children}</main>
    </div>
  );
}

function ShellNav() {
  const pathname = usePathname();
  // Counts are advisory chrome: if this query fails or is still in flight the
  // nav still renders, just without its signals.
  const counts = useQuery(api.platform.navCounts.navCounts, {});
  return (
    <nav className="console-nav">
      {NAV.map((section, i) => (
        <div className="nav-section" key={section.label ?? i}>
          {section.label ? <div className="nav-eyebrow">{section.label}</div> : null}
          {section.items.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            const signal = counts && item.signal ? item.signal(counts) : null;
            return (
              <Link
                key={item.label}
                href={item.href}
                className={`console-nav-item${active ? ' active' : ''}`}
              >
                <item.icon strokeWidth={1.75} aria-hidden="true" />
                <span className="nav-label">{item.label}</span>
                {signal?.count != null ? <span className="nav-count">{signal.count}</span> : null}
                {signal?.tone ? <span className={`nav-dot nav-dot-${signal.tone}`} /> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

class AccessBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.error !== null) {
      // Only genuine authorization rejections render the access-denied
      // screen. Anything else (e.g. "Could not find public function" when
      // the Convex deploy lags the console deploy) gets an honest error
      // screen instead of a misleading denial.
      const isAuthRejection = /Not platform staff|Unauthenticated|not enabled on this deployment/i.test(
        this.state.error,
      );
      return isAuthRejection ? (
        <Denied detail={this.state.error} />
      ) : (
        <ConsoleError message={this.state.error} />
      );
    }
    return this.props.children;
  }
}

function ConsoleError({ message }: { message: string }) {
  const looksUndeployed = /could not find/i.test(message);
  return (
    <div className="denied">
      <h1>Console error</h1>
      <p>{message}</p>
      {looksUndeployed ? (
        <p>
          This usually means the Convex backend hasn&apos;t been deployed with the
          console&apos;s latest functions yet — run <code>npx convex deploy</code> and reload.
        </p>
      ) : null}
      <Link className="button" href="/">
        Reload
      </Link>
    </div>
  );
}

function TokenClaims() {
  // Shows the caller's OWN token claims as Convex sees them, so a denial
  // screenshot includes everything needed to fix the config: the issuer
  // the token actually carries and whether an email claim survived the
  // JWT template.
  const claims = useQuery(api.platform.access.debugIdentity, {});
  if (claims === undefined) return null;
  if (claims === null) {
    return <p className="muted">Your token: not recognized by Convex (no identity).</p>;
  }
  return (
    <p className="muted">
      Your token — issuer: <code>{claims.issuer}</code> · email:{' '}
      <code>{claims.email ?? '(no email claim)'}</code> · verified:{' '}
      <code>{claims.emailVerified === null ? '(no claim)' : String(claims.emailVerified)}</code>
    </p>
  );
}

function Denied({ detail }: { detail?: string }) {
  // The three rejection reasons are deliberately distinguishable so a
  // screenshot of this page is a complete diagnosis:
  //   "Unauthenticated"          → Convex didn't recognize the JWT at all
  //                                (staff provider missing from auth config,
  //                                or no token reached the backend)
  //   "…not enabled…"            → STAFF_ISSUER env var missing on the
  //                                Convex deployment
  //   "Not platform staff"       → token recognized but wrong issuer, or
  //                                email absent/not on the allowlist
  return (
    <div className="denied">
      <h1>Access denied</h1>
      <p>
        This console is for Otoqa platform staff. Your session is not on the staff
        allowlist — if it should be, ask an administrator to add your email and sign
        in again.
      </p>
      {detail ? <p className="muted">Reason: {detail}</p> : null}
      <TokenClaims />
      <a className="button" href="/sign-out">
        Sign out
      </a>
    </div>
  );
}
