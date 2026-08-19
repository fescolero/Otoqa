'use client';

import { Component, ReactNode } from 'react';
import { Panel } from './ui';

/**
 * Failure isolation for one section of a page.
 *
 * ConsoleShell's AccessBoundary wraps the WHOLE page, so before this existed a
 * single failing query — one bad index, one undeployed function — replaced the
 * entire console with an error screen. During an incident that's exactly
 * backwards: the panels that still work are the ones you need.
 *
 * Authorization rejections are deliberately re-thrown so they still reach
 * AccessBoundary and render the access-denied screen, rather than being
 * swallowed into a panel-sized error box.
 */

const AUTH_REJECTION = /Not platform staff|Unauthenticated|not enabled on this deployment/i;

export class PanelBoundary extends Component<
  { children: ReactNode; label: string },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (AUTH_REJECTION.test(message)) throw error; // belongs to AccessBoundary
    return { error: message };
  }

  render() {
    if (this.state.error !== null) {
      return (
        <Panel
          title={`${this.props.label} — unavailable`}
          tone="danger"
          actions={
            <button className="button button-sm" onClick={() => this.setState({ error: null })}>
              Retry
            </button>
          }
        >
          <p className="danger-text mono" style={{ margin: 0, overflowWrap: 'anywhere' }}>
            {this.state.error}
          </p>
          <p className="empty-hint">
            The rest of the console is unaffected. If this persists, check that the Convex backend
            is deployed with the console&apos;s current functions.
          </p>
        </Panel>
      );
    }
    return this.props.children;
  }
}
