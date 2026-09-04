/**
 * NowCard — the "what's happening right now" card on the Overview
 * composer. Two driver variants:
 *
 *   <NowDriverInTransit
 *     load={{ id: 'OT-2026-0418', from: 'Sacramento, CA',
 *             to: 'Salt Lake City, UT', truck: 'T-204 · Volvo VNL 760',
 *             trailer: 'TR-118 · 53′ dry van', eta: 'Today 18:42 PT',
 *             hosRemaining: '6h 12m' }} />
 *
 *   <NowDriverAvailable
 *     location="Sacramento, CA · home base"
 *     hosAvailable="38h 00m / 70h cycle"
 *     lastLoad={{ id: 'OT-2026-0411', deliveredOn: 'Apr 27' }}
 *     idleSince="3 days"
 *     equipment="Reefer-cert · Hazmat (H, N, T)"
 *     matchedLoads={[…]} />
 *
 * NowCard delegates to one of the two variants. The wrapping <DSCard
 * title="Now"> + action button is composed at the call-site so it can
 * route the action to the right tab.
 */

'use client';

import * as React from 'react';
import { Chip } from './chip';
import { cn } from '@/lib/utils';

/** The load queued after the current one (or, for an available driver,
 *  the first one on the board). Rendered as a "Next load" row. */
export interface DriverNextLoad {
  id: string;
  route: string;
  pickupWhen?: string;
  onOpen?: () => void;
}

export interface DriverActiveLoad {
  id: string;
  from: string;
  to: string;
  truck?: string;
  trailer?: string;
  /** Scheduled pickup, when the ETA is unknown or separate. */
  pickup?: string;
  eta?: string;
  miles?: string;
  hosRemaining?: string;
  nextLoad?: DriverNextLoad;
}

function NextLoadRow({ next }: { next: DriverNextLoad }) {
  const body = (
    <>
      <span className="num text-[var(--accent)] font-medium">{next.id}</span>
      <span className="text-[var(--text-tertiary)]"> · {next.route}</span>
    </>
  );
  return (
    <>
      <div className="text-[var(--text-tertiary)]">Next load</div>
      <div className="min-w-0">
        <div className="truncate">
          {next.onOpen ? (
            <button
              type="button"
              onClick={next.onOpen}
              className="focus-ring hover:underline bg-transparent border-0 p-0 cursor-pointer text-left text-inherit"
            >
              {body}
            </button>
          ) : (
            body
          )}
        </div>
        {next.pickupWhen && (
          <div className="text-[11px] text-[var(--text-tertiary)]">
            Pickup <span className="num">{next.pickupWhen}</span>
          </div>
        )}
      </div>
    </>
  );
}

export function NowDriverInTransit({ load }: { load: DriverActiveLoad }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-[12.5px] text-[var(--text-secondary)] min-w-0 truncate">
          Current load{' '}
          <span className="num text-[var(--accent)] font-medium">{load.id}</span>
        </span>
        <Chip status="active" label="In transit" />
      </div>
      <div className="text-[12.5px] text-foreground leading-[18px] mb-2.5">
        {load.from} <span className="text-[var(--text-tertiary)]">→</span> {load.to}
      </div>
      <div
        className="grid text-[12.5px] leading-[18px] items-baseline"
        style={{ gridTemplateColumns: 'auto 1fr', rowGap: 6, columnGap: 12 }}
      >
        {load.truck && (
          <>
            <div className="text-[var(--text-tertiary)]">Truck</div>
            <div className="num truncate">{load.truck}</div>
          </>
        )}
        {load.trailer && (
          <>
            <div className="text-[var(--text-tertiary)]">Trailer</div>
            <div className="num truncate">{load.trailer}</div>
          </>
        )}
        {load.pickup && (
          <>
            <div className="text-[var(--text-tertiary)]">Pickup</div>
            <div className="num">{load.pickup}</div>
          </>
        )}
        {load.eta && (
          <>
            <div className="text-[var(--text-tertiary)]">ETA</div>
            <div className="num">{load.eta}</div>
          </>
        )}
        {load.miles && (
          <>
            <div className="text-[var(--text-tertiary)]">Miles</div>
            <div className="num">{load.miles}</div>
          </>
        )}
        {load.hosRemaining && (
          <>
            <div className="text-[var(--text-tertiary)]">HOS</div>
            <div className="num" style={{ color: '#0F8C5F' }}>{load.hosRemaining} remaining</div>
          </>
        )}
        {load.nextLoad && <NextLoadRow next={load.nextLoad} />}
      </div>
    </div>
  );
}

export interface DriverMatchedLoad {
  id: string;
  route: string;
  pickupWhen: string;
  miles: string;
  matchPct: number;
}

interface NowDriverAvailableProps {
  location?: string;
  hosAvailable?: string;
  lastLoad?: { id: string; deliveredOn: string };
  idleSince?: string;
  equipment?: string;
  /** Assigned but not yet started — what the driver rolls on next. */
  nextLoad?: DriverNextLoad;
  matchedLoads?: DriverMatchedLoad[];
}

export function NowDriverAvailable({
  location,
  hosAvailable,
  lastLoad,
  idleSince,
  equipment,
  nextLoad,
  matchedLoads,
}: NowDriverAvailableProps) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-[12.5px] text-[var(--text-secondary)] min-w-0 truncate">Ready to dispatch</span>
        <Chip status="valid" label="Available" />
      </div>
      <div
        className="grid text-[12.5px] leading-[18px] items-baseline"
        style={{ gridTemplateColumns: 'auto 1fr', rowGap: 6, columnGap: 12 }}
      >
        {location && (
          <>
            <div className="text-[var(--text-tertiary)]">Location</div>
            <div>{location}</div>
          </>
        )}
        {hosAvailable && (
          <>
            <div className="text-[var(--text-tertiary)]">HOS available</div>
            <div className="num" style={{ color: '#0F8C5F' }}>{hosAvailable}</div>
          </>
        )}
        {lastLoad && (
          <>
            <div className="text-[var(--text-tertiary)]">Last load</div>
            <div className="num">
              <span className="text-[var(--accent)] font-medium">{lastLoad.id}</span>
              <span className="text-[var(--text-tertiary)]"> · delivered {lastLoad.deliveredOn}</span>
            </div>
          </>
        )}
        {idleSince && (
          <>
            <div className="text-[var(--text-tertiary)]">Idle since</div>
            <div className="num">{idleSince}</div>
          </>
        )}
        {equipment && (
          <>
            <div className="text-[var(--text-tertiary)]">Equipment</div>
            <div>{equipment}</div>
          </>
        )}
        {nextLoad && <NextLoadRow next={nextLoad} />}
      </div>

      {matchedLoads && matchedLoads.length > 0 && (
        <>
          <div className="my-3 h-px bg-[var(--border-hairline)]" />
          <div className="tw-label text-[var(--text-tertiary)] mb-1.5">Matched open loads</div>
          {matchedLoads.map((l, i) => (
            <div
              key={l.id}
              className={cn('flex items-center gap-2 py-1.5')}
              style={{ borderTop: i === 0 ? 0 : '1px solid var(--border-hairline)' }}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-foreground">
                  <span className="num text-[var(--accent)] font-medium">{l.id}</span>
                  <span className="text-[var(--text-tertiary)]"> · {l.route}</span>
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)]">
                  {l.pickupWhen} · <span className="num">{l.miles}</span>
                </div>
              </div>
              <div
                className="text-[11px] font-semibold rounded px-1.5 py-0.5"
                style={{
                  background: l.matchPct >= 90 ? 'rgba(16,185,129,0.10)' : 'rgba(46,92,255,0.08)',
                  color:      l.matchPct >= 90 ? '#0F8C5F'              : '#1A47E6',
                }}
              >
                {l.matchPct}%
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
