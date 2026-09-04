import { describe, expect, it } from 'vitest';
import {
  ON_TIME_GRACE_MS,
  evaluateDeliveryOnTime,
  onTimePercent,
  stopArrivalMs,
  summarizeLegOnTime,
  type OnTimeStopLike,
} from './onTime';

const WINDOW_END = Date.UTC(2026, 5, 10, 17, 0, 0); // 2026-06-10T17:00Z
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const delivery = (over: Partial<OnTimeStopLike> = {}): OnTimeStopLike => ({
  stopType: 'DELIVERY',
  sequenceNumber: 2,
  windowEndDate: '2026-06-10',
  windowEndTime: iso(WINDOW_END),
  ...over,
});

describe('stopArrivalMs', () => {
  it('uses the earlier of the driver tap and the geofence arrival', () => {
    const fence = WINDOW_END - 5 * MIN;
    const tap = WINDOW_END + 40 * MIN;
    expect(stopArrivalMs({ stopType: 'DELIVERY', checkedInAt: iso(tap), autoArrivedAt: fence })).toBe(fence);
    expect(stopArrivalMs({ stopType: 'DELIVERY', checkedInAt: iso(fence), autoArrivedAt: tap })).toBe(fence);
  });
  it('returns null with no arrival evidence or an unparsable tap', () => {
    expect(stopArrivalMs({ stopType: 'DELIVERY' })).toBeNull();
    expect(stopArrivalMs({ stopType: 'DELIVERY', checkedInAt: 'not a date' })).toBeNull();
  });
});

describe('evaluateDeliveryOnTime', () => {
  it('is on time up to window end + 15 min grace, late one ms after', () => {
    expect(ON_TIME_GRACE_MS).toBe(15 * MIN);
    expect(evaluateDeliveryOnTime(delivery({ checkedInAt: iso(WINDOW_END + 15 * MIN) }))).toEqual({ onTime: true, lateMs: 0 });
    expect(evaluateDeliveryOnTime(delivery({ checkedInAt: iso(WINDOW_END + 15 * MIN + 1) }))).toEqual({ onTime: false, lateMs: 1 });
  });
  it('lets an on-time geofence arrival rescue a late tap', () => {
    const r = evaluateDeliveryOnTime(delivery({ checkedInAt: iso(WINDOW_END + 60 * MIN), autoArrivedAt: WINDOW_END - MIN }));
    expect(r).toEqual({ onTime: true, lateMs: 0 });
  });
  it('is not evaluable for pickups, detours, windowless stops, or stops never arrived at', () => {
    expect(evaluateDeliveryOnTime(delivery({ stopType: 'PICKUP', checkedInAt: iso(WINDOW_END) }))).toBeNull();
    expect(evaluateDeliveryOnTime(delivery({ stopType: 'DETOUR', checkedInAt: iso(WINDOW_END) }))).toBeNull();
    expect(evaluateDeliveryOnTime(delivery({ windowEndTime: undefined, windowEndDate: undefined, checkedInAt: iso(WINDOW_END) }))).toBeNull();
    expect(evaluateDeliveryOnTime(delivery())).toBeNull();
  });
});

describe('summarizeLegOnTime', () => {
  it('counts only delivery stops inside the leg sequence range', () => {
    const stops: OnTimeStopLike[] = [
      { stopType: 'PICKUP', sequenceNumber: 1, windowEndDate: '2026-06-10', windowEndTime: iso(WINDOW_END), checkedInAt: iso(WINDOW_END + 60 * MIN) },
      delivery({ sequenceNumber: 2, checkedInAt: iso(WINDOW_END) }),                 // on time
      delivery({ sequenceNumber: 3, checkedInAt: iso(WINDOW_END + 30 * MIN) }),      // late
      delivery({ sequenceNumber: 4 }),                                               // no arrival → excluded
      delivery({ sequenceNumber: 9, checkedInAt: iso(WINDOW_END) }),                 // outside leg → excluded
      delivery({ sequenceNumber: undefined, checkedInAt: iso(WINDOW_END) }),         // unplaceable → excluded
    ];
    expect(summarizeLegOnTime(stops, 1, 4)).toEqual({ deliveriesEvaluated: 2, deliveriesOnTime: 1 });
  });
  it('accepts a reversed sequence range', () => {
    expect(summarizeLegOnTime([delivery({ checkedInAt: iso(WINDOW_END) })], 3, 1)).toEqual({ deliveriesEvaluated: 1, deliveriesOnTime: 1 });
  });
});

describe('onTimePercent', () => {
  it('rounds and returns null when nothing was evaluable', () => {
    expect(onTimePercent(0, 0)).toBeNull();
    expect(onTimePercent(3, 2)).toBe(67);
    expect(onTimePercent(4, 4)).toBe(100);
  });
});
