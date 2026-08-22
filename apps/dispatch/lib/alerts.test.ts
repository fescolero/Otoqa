import { describe, expect, it } from 'vitest';
import {
  ALERT_FILTERS,
  alertActions,
  alertIcon,
  alertLabel,
  formatAge,
  matchesAlertFilter,
  type AlertLike,
} from './alerts';

const withDriver = (kind: string): AlertLike => ({
  kind,
  driver: { firstName: 'Marcus', phone: '+15551234567' },
  loadId: 'load_1',
  assignmentId: 'asg_1',
});

const bare = (kind: string): AlertLike => ({ kind, driver: null, loadId: null, assignmentId: null });

describe('alert labels', () => {
  it('names every kind the sweep can raise', () => {
    for (const kind of [
      'TRACKING_LOST',
      'MISSED_APPOINTMENT',
      'POD_MISSING',
      'LOAD_CANCELED',
      'OFFER_DECLINED',
    ]) {
      expect(alertLabel(kind)).not.toBe(kind);
      expect(alertIcon(kind)).not.toBe('alert-circle-outline');
    }
  });

  it('degrades to the raw kind rather than rendering blank', () => {
    // A kind added server-side before the client ships must still be legible.
    expect(alertLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(alertIcon('SOMETHING_NEW')).toBe('alert-circle-outline');
  });
});

describe('filters', () => {
  it('every filter matches at least one real kind — no dead chips', () => {
    const kinds = [
      'TRACKING_LOST',
      'MISSED_APPOINTMENT',
      'POD_MISSING',
      'LOAD_CANCELED',
      'OFFER_DECLINED',
    ];
    for (const { k } of ALERT_FILTERS) {
      expect(kinds.some((kind) => matchesAlertFilter(kind, k)), `filter ${k}`).toBe(true);
    }
  });

  it('groups both driver-loss kinds under Cancelled', () => {
    expect(matchesAlertFilter('LOAD_CANCELED', 'cancelled')).toBe(true);
    expect(matchesAlertFilter('OFFER_DECLINED', 'cancelled')).toBe(true);
    expect(matchesAlertFilter('POD_MISSING', 'cancelled')).toBe(false);
  });

  it('all matches everything', () => {
    expect(matchesAlertFilter('TRACKING_LOST', 'all')).toBe(true);
    expect(matchesAlertFilter('WHATEVER', 'all')).toBe(true);
  });
});

describe('alertActions — the primary action resolves the alert', () => {
  it('offers the window re-time for a missed appointment', () => {
    const { primary, secondary } = alertActions(withDriver('MISSED_APPOINTMENT'));
    expect(primary).toEqual({ kind: 'adjust', label: 'Move window' });
    expect(secondary?.kind).toBe('call');
  });

  it('offers reassignment for a declined offer — nobody is on that load', () => {
    const { primary, secondary } = alertActions(withDriver('OFFER_DECLINED'));
    expect(primary).toEqual({ kind: 'assign', label: 'Assign someone else' });
    expect(secondary).toEqual({ kind: 'load', label: 'View load' });
  });

  it('leads with the driver when tracking is lost', () => {
    const { primary, secondary } = alertActions(withDriver('TRACKING_LOST'));
    expect(primary).toEqual({ kind: 'call', label: 'Call Marcus' });
    expect(secondary).toEqual({ kind: 'map', label: 'View on map' });
  });

  it('does not offer re-timing or reassignment for a cancelled load', () => {
    const { primary, secondary } = alertActions(withDriver('LOAD_CANCELED'));
    expect(primary?.kind).toBe('load');
    expect(secondary?.kind).toBe('call');
  });
});

describe('alertActions — never offers a button that cannot work', () => {
  it('drops Call when there is no phone number', () => {
    const noPhone: AlertLike = {
      kind: 'TRACKING_LOST',
      driver: { firstName: 'Marcus', phone: null },
      loadId: 'load_1',
      assignmentId: 'asg_1',
    };
    const { primary, secondary } = alertActions(noPhone);
    expect(primary?.kind).not.toBe('call');
    expect(secondary?.kind).not.toBe('call');
  });

  it('falls back off adjust/assign when the assignment is missing', () => {
    const noAsg: AlertLike = {
      kind: 'MISSED_APPOINTMENT',
      driver: { firstName: 'Marcus', phone: '+15551234567' },
      loadId: 'load_1',
      assignmentId: null,
    };
    expect(alertActions(noAsg).primary?.kind).toBe('call');
  });

  it('yields no actions at all rather than dead ones when nothing is known', () => {
    for (const kind of ['TRACKING_LOST', 'POD_MISSING', 'LOAD_CANCELED', 'OFFER_DECLINED']) {
      const { primary, secondary } = alertActions(bare(kind));
      for (const a of [primary, secondary]) {
        // A "call" with no number or a "view load" with no load is a dead end.
        expect(a?.kind).not.toBe('call');
        expect(a?.kind).not.toBe('load');
      }
    }
  });

  it('uses the driver’s name on the call button when known', () => {
    expect(alertActions(withDriver('TRACKING_LOST')).primary?.label).toBe('Call Marcus');
    const anon: AlertLike = {
      kind: 'TRACKING_LOST',
      driver: { firstName: null, phone: '+15551234567' },
      loadId: null,
      assignmentId: null,
    };
    expect(alertActions(anon).primary?.label).toBe('Call driver');
  });
});

describe('formatAge', () => {
  const now = 1_700_000_000_000;
  const ago = (ms: number) => formatAge(now - ms, now);

  it('reads how stale an alert is at a glance', () => {
    expect(ago(30_000)).toBe('just now');
    expect(ago(4 * 60_000)).toBe('4m ago');
    expect(ago(71 * 60_000)).toBe('1h 11m ago');
    expect(ago(2 * 3600_000)).toBe('2h ago');
    expect(ago(50 * 3600_000)).toBe('2d ago');
  });

  it('never renders a negative age from clock skew', () => {
    expect(formatAge(now + 60_000, now)).toBe('just now');
  });
});
