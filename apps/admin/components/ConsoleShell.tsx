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
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '@otoqa/convex-client';

const NAV = [
  { label: 'Overview', href: '/', active: true },
  // Phase 1+ surfaces — listed so the shape of the console is visible,
  // disabled until their pages exist.
  { label: 'Organizations', href: '#', disabled: true },
  { label: 'Billing', href: '#', disabled: true },
  { label: 'Jobs', href: '#', disabled: true },
  { label: 'Health', href: '#', disabled: true },
  { label: 'Errors', href: '#', disabled: true },
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
        {NAV.map((item) => (
          <a
            key={item.label}
            href={item.href}
            className={`console-nav-item${item.active ? ' active' : ''}${item.disabled ? ' disabled' : ''}`}
          >
            {item.label}
          </a>
        ))}
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

class AccessBoundary extends Component<{ children: ReactNode }, { denied: boolean }> {
  state = { denied: false };

  static getDerivedStateFromError() {
    return { denied: true };
  }

  render() {
    if (this.state.denied) return <Denied />;
    return this.props.children;
  }
}

function Denied() {
  return (
    <div className="denied">
      <h1>Access denied</h1>
      <p>
        This console is for Otoqa platform staff. Your session is not on the staff
        allowlist — if it should be, ask an administrator to add your email and sign
        in again.
      </p>
      <a className="button" href="/sign-out">
        Sign out
      </a>
    </div>
  );
}
