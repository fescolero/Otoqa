/**
 * ASectionCard — uniform full-width container for one schema section.
 *
 * Layout Rule 2 enforced here: every card is the same width, fills the
 * content column, and never resizes section-to-section. Short sections
 * leave trailing empty space inside the card rather than shrinking.
 *
 * The accent variant — used for the "primary / start here" card
 * (typically gated by a `showIf` like Carrier's Owner-Op driver block)
 * — adds a blue-tinted border, a soft halo shadow, an accent dot
 * before the title, and an accent-tinted header background.
 *
 * The grid that lays out the fields inside (Rule 3 — auto-FILL fixed
 * tracks) lives in `field-grid.ts` and is applied by the parent;
 * `ASectionCard` is just the chrome.
 */

'use client';

import * as React from 'react';

interface ASectionCardProps {
  id: string;
  title: string;
  subtitle?: string;
  accent?: boolean;
  children: React.ReactNode;
}

export function ASectionCard({
  id,
  title,
  subtitle,
  accent,
  children,
}: ASectionCardProps) {
  return (
    <section
      id={id}
      // `data-form-section` is what the scroll-spy IntersectionObserver
      // hooks onto — see scroll-spy.ts. Don't drop this attribute.
      data-form-section={id}
      style={{
        background: 'var(--bg-surface)',
        border: accent
          ? '1px solid rgba(46, 92, 255, 0.30)'
          : '1px solid var(--border-hairline)',
        borderRadius: 10,
        // We deliberately do NOT clip overflow here. A previous version
        // used `overflow: hidden` to keep the header's bg-surface-2
        // tone inside the rounded corners, but that clipping also
        // trimmed every absolutely-positioned popover rendered by
        // fields inside the section — the AddressAutocomplete
        // suggestions dropdown was the most visible casualty: it
        // disappeared mid-list because the section's border-box ate
        // the bottom half. Instead we leave overflow visible and
        // shape the header's own corners (see below) so the bg tone
        // still sits flush inside the rounded section frame.
        scrollMarginTop: 24,
        boxShadow: accent ? '0 0 0 3px rgba(46, 92, 255, 0.06)' : 'none',
      }}
    >
      <header
        style={{
          padding: subtitle ? '10px 16px 9px' : '10px 16px',
          borderBottom: '1px solid var(--border-hairline)',
          background: accent ? 'rgba(46, 92, 255, 0.05)' : 'var(--bg-surface-2)',
          // Match the section's top corners so the bg tone reads as
          // flush with the rounded frame even though the section no
          // longer clips. `borderRadius: 10` on the section minus 1px
          // border = 9px inside corner radius for the header.
          borderTopLeftRadius: 9,
          borderTopRightRadius: 9,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {accent && (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--accent)',
                boxShadow: '0 0 0 4px rgba(46, 92, 255, 0.12)',
              }}
            />
          )}
          <h2
            style={{
              fontSize: 12,
              fontWeight: 600,
              margin: 0,
              letterSpacing: '0.02em',
              color: 'var(--text-primary)',
            }}
          >
            {title}
          </h2>
        </div>
        {subtitle && (
          <p
            style={{
              fontSize: 11.5,
              color: 'var(--text-secondary)',
              margin: '3px 0 0',
              lineHeight: 1.45,
            }}
          >
            {subtitle}
          </p>
        )}
      </header>
      <div style={{ padding: 16 }}>{children}</div>
    </section>
  );
}
