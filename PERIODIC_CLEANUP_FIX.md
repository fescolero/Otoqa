# Periodic Cleanup Fix - Eliminating Excessive Reads

## Problem
`lazyLoadPromotion.periodicCleanup` was causing 15GB+ reads per day due to a self-scheduling infinite loop:

```
Every 60 seconds:
1. Read 10 UNMAPPED/SPOT loads (from potentially thousands)
2. For each load, query contractLanes table
3. If 10+ loads remain, schedule another run → LOOP FOREVER
```

With FourKites importing loads continuously and the cleanup never stopping, this created a massive read amplification problem that scales with data growth.

## Root Cause Analysis

### The Self-Scheduling Loop
```typescript
// OLD CODE - DANGEROUS!
if (loadsToCheck.length === SMALL_BATCH) {
  await ctx.scheduler.runAfter(60000, internal.lazyLoadPromotion.periodicCleanup, {
    workosOrgId: args.workosOrgId,
  });
}
```

### Multiple Triggers
The loop was started from multiple places:
- `fourKitesPullSyncAction.ts` - After every FourKites sync (every 15 min)
- `contractLanes.ts` - After importing lanes
- `manualCleanup.ts` - Manual trigger

This meant multiple overlapping loops could run simultaneously.

## Solution: Event-Driven Promotion

**POLLING → EVENT-DRIVEN**

Instead of continuously scanning for promotable loads, only promote when:

### 1. Lane Creation (createLaneAndBackfill)
When a contract lane is created, it already backfills matching loads. This is a **one-time operation** that happens immediately when a user creates a lane.

### 2. Load Access (checkAndPromoteLoad)
When a user views an UNMAPPED/SPOT load, check if a matching lane now exists. If yes, promote it. This is **on-demand** and only reads what the user is looking at.

## Changes Made

### 1. Disabled periodicCleanup (`convex/lazyLoadPromotion.ts`)
```typescript
// NOW: Just logs a deprecation warning and returns immediately
export const periodicCleanup = internalMutation({
  handler: async (ctx, args) => {
    console.warn("⚠️ lazyLoadPromotion.periodicCleanup is DEPRECATED.");
    return { processed: 0, promoted: 0, deprecated: true };
  },
});
```

### 2. Removed Triggers
- **`convex/fourKitesPullSyncAction.ts`** - Removed scheduler call
- **`convex/contractLanes.ts`** - Removed scheduler call after imports

### 3. Updated Manual Cleanup (`convex/manualCleanup.ts`)
Changed from loop-starter to one-time batch operation:
- Processes a fixed batch (default 50, max 100)
- **NO self-scheduling**
- Returns results and stops

### 4. Added Compound Index (`convex/schema.ts`)
```typescript
.index('by_org_hcr_trip', ['workosOrgId', 'hcr', 'tripNumber'])
```
Makes lane lookups O(1) instead of O(n) table scans.

### 5. Updated Lane Lookup
Both `checkAndPromoteLoad` and `manualCleanup` now use the efficient compound index.

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Reads from periodicCleanup | 15-33 GB/day | ~0 GB/day |
| Lane lookup efficiency | O(n) scan | O(1) index |
| Promotion timing | Delayed (up to 60s) | Instant (on access) |
| Resource usage | Continuous | On-demand |

## New Promotion Flow

```
BEFORE (Polling):
┌─────────────────────────────────────────────────┐
│ FourKites Sync → Start Loop                     │
│       ↓                                         │
│ Every 60s: Read 10 loads, query lanes, repeat   │
│       ↓                                         │
│ NEVER STOPS (if loads exist)                    │
└─────────────────────────────────────────────────┘

AFTER (Event-Driven - 3 Pathways):

1. DURING SYNC (New!):
┌─────────────────────────────────────────────────┐
│ FourKites Sync runs                             │
│       ↓                                         │
│ For each shipment, check if lane exists         │
│       ↓                                         │
│ If UNMAPPED load exists + lane now exists →     │
│ Promote immediately via promoteUnmappedLoad     │
│       ↓                                         │
│ DONE (happens naturally during sync)            │
└─────────────────────────────────────────────────┘

2. ON LANE CREATION:
┌─────────────────────────────────────────────────┐
│ User creates lane → createLaneAndBackfill       │
│       ↓                                         │
│ Immediately promotes ALL matching UNMAPPED loads│
│       ↓                                         │
│ DONE (one-time operation)                       │
└─────────────────────────────────────────────────┘

3. ON LOAD ACCESS (Fallback):
┌─────────────────────────────────────────────────┐
│ User Views Load → checkAndPromoteLoad           │
│       ↓                                         │
│ Check if lane exists (O(1) index lookup)        │
│       ↓                                         │
│ Promote if match found                          │
│       ↓                                         │
│ DONE (only reads what user looks at)            │
└─────────────────────────────────────────────────┘
```

## Why No Load Is Left Behind

| Scenario | How It's Handled |
|----------|------------------|
| Lane exists → Load imported | FourKites creates as CONTRACT/SPOT |
| Load imported → Lane created later | `createLaneAndBackfill` promotes all matching |
| Load is UNMAPPED → Lane created → Next sync | `promoteUnmappedLoad` promotes during sync |
| Edge case: Load never synced again | `checkAndPromoteLoad` catches on user access |

## Manual Cleanup (If Needed)

If you have a backlog of loads that need promotion, you can run a one-time cleanup:

```typescript
// From Convex Dashboard or API
await api.manualCleanup.triggerCleanup({
  workosOrgId: "org_xxx",
  batchSize: 100 // Optional, max 100
});
```

This processes ONE batch and stops. Run it multiple times if needed, but it won't start a loop.

## Monitoring

After deploy, check:
1. **Reads should drop significantly** - No more continuous cleanup loop
2. **No more periodicCleanup in logs** - Should only see deprecation warning if called
3. **Promotion still works** - When lanes are created, loads should promote
4. **On-access promotion works** - Viewing SPOT loads should trigger check

## Future Considerations

If you need bulk promotion:
1. Use `manualCleanup.triggerCleanup` with explicit batch size
2. Or enhance `createLaneAndBackfill` to find more matching loads
3. Consider a scheduled job that runs once daily instead of every 60 seconds

