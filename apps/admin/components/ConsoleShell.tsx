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

const NAV = [
  { label: 'Overview', href: '/' },
  { label: 'Organizations', href: '/organizations' },
  { label: 'Billing', href: '/billing' },
  { label: 'Jobs', href: '/jobs' },
  { label: 'Health', href: '/health' },
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
          otoqa <span>console</span>
        </div>
        <ShellNav />
        <div className="console-sidebar-footer">
          {me.email}
          <br />
          <a href="/sign-out">Sign out</a>
        </div>
      </aside>
      <main className="console-main">{children}</main>
    </div>
  );
}

function ShellNav() {
  const pathname = usePathname();
  return (
    <>
      {NAV.map((item) => {
        const active =
          item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.label}
            href={item.href}
            className={`console-nav-item${active ? ' active' : ''}`}
          >
            {item.label}
          </Link>
        );
      })}
    </>
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
      <a className="button" href="/">
        Reload
      </a>
    </div>
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
      <a className="button" href="/sign-out">
        Sign out
      </a>
    </div>
  );
}
