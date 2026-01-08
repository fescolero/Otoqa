# First Stop Date Denormalization - Implementation Plan

## Executive Summary

**Problem**: Filtering loads by first stop date requires expensive N+1 queries that hit Convex's 4,096 document read limit.

**Solution**: Denormalize `firstStopDate` onto the `loadInformation` table with an index for efficient querying.

**Expected Outcome**: 
- Date filtering becomes instant (indexed query vs. scanning thousands of documents)
- No more read limit errors
- Simpler, more maintainable code

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Target State Architecture](#2-target-state-architecture)
3. [Schema Changes](#3-schema-changes)
4. [Sync Helper Implementation](#4-sync-helper-implementation)
5. [Code Paths to Update](#5-code-paths-to-update)
6. [Migration Strategy](#6-migration-strategy)
7. [Query Optimization](#7-query-optimization)
8. [Reconciliation Cron](#8-reconciliation-cron)
9. [Testing Plan](#9-testing-plan)
10. [Rollback Plan](#10-rollback-plan)
11. [Implementation Checklist](#11-implementation-checklist)

---

## 1. Current State Analysis

### Data Model (Current)

```
┌─────────────────────────┐         ┌─────────────────────────┐
│   loadInformation       │         │      loadStops          │
├─────────────────────────┤         ├─────────────────────────┤
│ _id                     │◄────────│ loadId (FK)             │
│ orderNumber             │         │ sequenceNumber (1,2,3)  │
│ status                  │         │ windowBeginDate ◄─────────── SOURCE OF TRUTH
│ workosOrgId             │         │ windowBeginTime         │
│ customerId              │         │ stopType                │
│ ... (no date field!)    │         │ city, state, etc.       │
└─────────────────────────┘         └─────────────────────────┘
        5,454 docs                        15,258 docs
```

### Current Query Flow (Inefficient)

```
1. Query loadInformation (paginate 100-500 at a time)
   └── For EACH load:
       └── Query loadStops WHERE loadId = ? AND sequenceNumber = 1
           └── Check windowBeginDate against filter
           
Total reads: loads + (loads × 1 stop query each) = N + N = 2N reads
With 5,454 loads: 10,908+ reads → EXCEEDS 4,096 LIMIT
```

### Current Workaround Issues

- Batching through loads in chunks of 200
- May miss matching loads if they're distributed throughout the dataset
- Complex, fragile code
- Slow performance

---

## 2. Target State Architecture

### Data Model (After Denormalization)

```
┌─────────────────────────┐         ┌─────────────────────────┐
│   loadInformation       │         │      loadStops          │
├─────────────────────────┤         ├─────────────────────────┤
│ _id                     │◄────────│ loadId (FK)             │
│ orderNumber             │         │ sequenceNumber (1,2,3)  │
│ status                  │         │ windowBeginDate ◄─────────── SOURCE OF TRUTH
│ workosOrgId             │         │ windowBeginTime         │
│ customerId              │         │ stopType                │
│ firstStopDate ◄─────────────────────── DENORMALIZED COPY    │
│ ...                     │         │ city, state, etc.       │
└─────────────────────────┘         └─────────────────────────┘
     INDEX: by_org_first_stop_date
     (workosOrgId, firstStopDate)
```

### Target Query Flow (Efficient)

```
1. Query loadInformation with INDEX
   WHERE workosOrgId = ? 
   AND firstStopDate >= startDate 
   AND firstStopDate <= endDate
   └── Paginate results directly (no N+1!)
   
Total reads: Just the matching loads (typically 50-100)
```

---

## 3. Schema Changes

### File: `convex/schema.ts`

```typescript
// ADD to loadInformation table definition:

loadInformation: defineTable({
  // ... existing fields ...
  
  // === NEW: Denormalized First Stop Date ===
  // Copied from loadStops[sequenceNumber=1].windowBeginDate
  // Format: "YYYY-MM-DD" (e.g., "2026-01-06")
  // Updated by: syncFirstStopDate helper
  // Used for: Efficient date range filtering
  firstStopDate: v.optional(v.string()),
})
  // ... existing indexes ...
  
  // === NEW INDEX for date filtering ===
  .index('by_org_first_stop_date', ['workosOrgId', 'firstStopDate']),
```

### Index Design Rationale

| Index | Fields | Purpose |
|-------|--------|---------|
| `by_org_first_stop_date` | `[workosOrgId, firstStopDate]` | Filter by org + date range |

**Why this order?**
- `workosOrgId` first for multi-tenant isolation (always filtered)
- `firstStopDate` second for range queries (>=, <=)
- Convex indexes support range queries on the last field

---

## 4. Sync Helper Implementation

### File: `convex/_helpers/syncFirstStopDate.ts` (NEW FILE)

```typescript
import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

/**
 * Syncs the denormalized firstStopDate field on loadInformation
 * with the actual first stop's windowBeginDate.
 * 
 * INCLUDES SANITIZATION (Section 12-C):
 * - Handles "TBD" values → undefined
 * - Extracts YYYY-MM-DD from ISO strings (e.g., "2026-01-06T12:00:00Z" → "2026-01-06")
 * - Validates format for consistent lexicographical sorting
 * 
 * @param ctx - Mutation context
 * @param loadId - The load to sync
 * @returns The new firstStopDate value (or undefined if no valid date)
 */
export async function syncFirstStopDate(
  ctx: MutationCtx,
  loadId: Id<"loadInformation">
): Promise<string | undefined> {
  // Get the first stop (sequence number 1)
  const firstStop = await ctx.db
    .query("loadStops")
    .withIndex("by_sequence", (q) => 
      q.eq("loadId", loadId).eq("sequenceNumber", 1)
    )
    .first();
  
  // Sanitization Logic (Section 12-C)
  const rawDate = firstStop?.windowBeginDate;
  
  let newFirstStopDate: string | undefined = undefined;
  
  if (rawDate && rawDate !== 'TBD') {
    // Extract YYYY-MM-DD from potential ISO string
    newFirstStopDate = rawDate.split('T')[0];
    
    // Validate format (must be YYYY-MM-DD for proper index sorting)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newFirstStopDate)) {
      newFirstStopDate = undefined;
    }
  }
  
  // Update the load
  await ctx.db.patch(loadId, {
    firstStopDate: newFirstStopDate,
  });
  
  return newFirstStopDate;
}

/**
 * Batch sync for multiple loads (used in migrations/reconciliation)
 * Processes in chunks to avoid read limits
 */
export async function syncFirstStopDateBatch(
  ctx: MutationCtx,
  loadIds: Id<"loadInformation">[]
): Promise<{ synced: number; errors: number }> {
  let synced = 0;
  let errors = 0;
  
  for (const loadId of loadIds) {
    try {
      await syncFirstStopDate(ctx, loadId);
      synced++;
    } catch (error) {
      console.error(`Failed to sync firstStopDate for load ${loadId}:`, error);
      errors++;
    }
  }
  
  return { synced, errors };
}
```

---

## 5. Code Paths to Update

### Files That Create/Modify Stops

| File | Function | Action Required |
|------|----------|-----------------|
| `convex/loads.ts` | `createLoad` | Add sync after creating stops |
| `convex/loads.ts` | `updateStopTimes` | Add sync after updating stop |
| `convex/fourKitesSyncHelpers.ts` | `upsertLoad` | Add sync after upserting stops |
| `convex/fourKitesSyncHelpers.ts` | `createNewLoadWithStops` | Add sync after creating stops |
| `convex/fourKitesPullSyncAction.ts` | Stop updates | Add sync after updating stops |

### Detailed Changes

#### 5.1 `convex/loads.ts` - `createLoad` mutation

```typescript
// AFTER the for loop that creates stops (around line 625):

// Sync the denormalized firstStopDate
await syncFirstStopDate(ctx, loadId);

return loadId;
```

#### 5.2 `convex/loads.ts` - `updateStopTimes` mutation

```typescript
// AFTER patching the stop (around line 1017):

await ctx.db.patch(stopId, updateData);

// Sync firstStopDate if this might be the first stop
// or if window dates changed
if (updates.windowBeginDate !== undefined) {
  await syncFirstStopDate(ctx, stop.loadId);
}
```

#### 5.3 `convex/fourKitesSyncHelpers.ts` - After stop upserts

```typescript
// After creating/updating stops for a load:
await syncFirstStopDate(ctx, loadId);
```

#### 5.4 `convex/fourKitesPullSyncAction.ts` - After stop updates

```typescript
// After updating stop times:
await syncFirstStopDate(ctx, loadId);
```

---

## 6. Migration Strategy

### Phase 1: Deploy Schema Change

1. Add `firstStopDate` field to schema (optional field, no breaking change)
2. Add new index `by_org_first_stop_date`
3. Deploy to Convex (index will be empty initially)

### Phase 2: Backfill Existing Data

Create a migration that runs in batches to avoid timeouts:

#### File: `convex/migrations/backfillFirstStopDate.ts`

```typescript
import { internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

/**
 * Backfill a batch of loads with their firstStopDate
 * Called repeatedly until all loads are processed
 */
export const backfillBatch = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
    updated: v.number(),
    skipped: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;
    
    // Get batch of loads
    const result = await ctx.db
      .query("loadInformation")
      .paginate({ numItems: batchSize, cursor: args.cursor });
    
    let updated = 0;
    let skipped = 0;
    
    for (const load of result.page) {
      // Skip if already has firstStopDate
      if (load.firstStopDate) {
        skipped++;
        continue;
      }
      
      // Get first stop
      const firstStop = await ctx.db
        .query("loadStops")
        .withIndex("by_sequence", (q) => 
          q.eq("loadId", load._id).eq("sequenceNumber", 1)
        )
        .first();
      
      if (firstStop?.windowBeginDate) {
        await ctx.db.patch(load._id, {
          firstStopDate: firstStop.windowBeginDate,
        });
        updated++;
      } else {
        skipped++;
      }
    }
    
    return {
      processed: result.page.length,
      updated,
      skipped,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/**
 * Run the full backfill migration
 * Orchestrates multiple batches
 */
export const runBackfill = internalAction({
  args: {},
  returns: v.object({
    totalProcessed: v.number(),
    totalUpdated: v.number(),
    totalSkipped: v.number(),
  }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    
    console.log("Starting firstStopDate backfill migration...");
    
    while (true) {
      const result = await ctx.runMutation(internal.migrations.backfillFirstStopDate.backfillBatch, {
        cursor,
        batchSize: 100,
      });
      
      totalProcessed += result.processed;
      totalUpdated += result.updated;
      totalSkipped += result.skipped;
      
      console.log(`Batch complete: ${result.processed} processed, ${result.updated} updated, ${result.skipped} skipped`);
      
      if (result.isDone) {
        break;
      }
      
      cursor = result.nextCursor;
      
      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`Migration complete! Total: ${totalProcessed} processed, ${totalUpdated} updated, ${totalSkipped} skipped`);
    
    return { totalProcessed, totalUpdated, totalSkipped };
  },
});
```

### Phase 3: Deploy Sync Logic

1. Add `syncFirstStopDate` helper
2. Update all code paths to call the sync helper
3. Deploy

### Phase 4: Update Query Logic

1. Simplify `getLoads` to use the new index
2. Remove the complex batching logic
3. Deploy and test

---

## 7. Query Optimization

### File: `convex/loads.ts` - Updated `getLoads` handler

```typescript
export const getLoads = query({
  args: {
    workosOrgId: v.string(),
    status: v.optional(v.string()),
    trackingStatus: v.optional(v.string()),
    customerId: v.optional(v.id('customers')),
    hcr: v.optional(v.string()),
    tripNumber: v.optional(v.string()),
    startDate: v.optional(v.string()), // YYYY-MM-DD format
    endDate: v.optional(v.string()),   // YYYY-MM-DD format
    requiresManualReview: v.optional(v.boolean()),
    loadType: v.optional(v.string()),
    search: v.optional(v.string()),
    mileRange: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const hasDateFilter = args.startDate || args.endDate;
    
    // Choose the appropriate index based on filters
    let loadsQuery;
    
    if (hasDateFilter) {
      // Use the date-optimized index
      loadsQuery = ctx.db
        .query('loadInformation')
        .withIndex('by_org_first_stop_date', (q) => {
          let indexQuery = q.eq('workosOrgId', args.workosOrgId);
          
          // Apply date range to index (efficient!)
          if (args.startDate) {
            indexQuery = indexQuery.gte('firstStopDate', args.startDate);
          }
          if (args.endDate) {
            indexQuery = indexQuery.lte('firstStopDate', args.endDate);
          }
          
          return indexQuery;
        });
    } else {
      // Use the standard org index
      loadsQuery = ctx.db
        .query('loadInformation')
        .withIndex('by_organization', (q) => 
          q.eq('workosOrgId', args.workosOrgId)
        );
    }
    
    // Apply additional filters (these use .filter(), not index)
    if (args.status) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('status'), args.status));
    }
    if (args.trackingStatus) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('trackingStatus'), args.trackingStatus));
    }
    if (args.customerId) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('customerId'), args.customerId));
    }
    if (args.hcr) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('parsedHcr'), args.hcr));
    }
    if (args.tripNumber) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('parsedTripNumber'), args.tripNumber));
    }
    if (args.requiresManualReview !== undefined) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('requiresManualReview'), args.requiresManualReview));
    }
    if (args.loadType) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('loadType'), args.loadType));
    }

    // Paginate efficiently
    const paginatedResult = await loadsQuery.order('desc').paginate(args.paginationOpts);

    let filteredLoads = paginatedResult.page;

    // Client-side search filtering (after pagination)
    if (args.search) {
      const searchLower = args.search.toLowerCase();
      filteredLoads = filteredLoads.filter((load) => {
        return (
          load.orderNumber?.toLowerCase().includes(searchLower) ||
          load.customerName?.toLowerCase().includes(searchLower) ||
          load.internalId?.toLowerCase().includes(searchLower) ||
          load.parsedHcr?.toLowerCase().includes(searchLower) ||
          load.parsedTripNumber?.toLowerCase().includes(searchLower)
        );
      });
    }

    // Enrich with stop details (only for the paginated results - efficient!)
    const loadsWithStops = await Promise.all(
      filteredLoads.map(async (load) => {
        const stops = await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();

        stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

        const firstPickup = stops.find((s) => s.stopType === 'PICKUP');
        const lastDelivery = stops.filter((s) => s.stopType === 'DELIVERY').pop();

        return {
          ...load,
          origin: firstPickup
            ? { city: firstPickup.city, state: firstPickup.state, address: firstPickup.address }
            : null,
          destination: lastDelivery
            ? { city: lastDelivery.city, state: lastDelivery.state, address: lastDelivery.address }
            : null,
          stopsCount: stops.length,
          // firstStopDate already on the load from denormalization!
        };
      }),
    );

    // Apply mile range filter after enrichment
    let finalLoads = loadsWithStops;
    if (args.mileRange && args.mileRange !== 'all') {
      finalLoads = finalLoads.filter((load) => {
        const miles = load.effectiveMiles;
        if (!miles) return false;

        switch (args.mileRange) {
          case '0-100':
            return miles >= 0 && miles <= 100;
          case '100-250':
            return miles > 100 && miles <= 250;
          case '250-500':
            return miles > 250 && miles <= 500;
          case '500+':
            return miles > 500;
          default:
            return true;
        }
      });
    }

    return {
      ...paginatedResult,
      page: finalLoads,
    };
  },
});
```

---

## 8. Reconciliation Cron

### File: `convex/crons.ts` - Add reconciliation job

```typescript
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// ... existing crons ...

// Reconcile firstStopDate daily to catch any drift
crons.interval(
  "reconcile-first-stop-dates",
  { hours: 24 },
  internal.maintenance.reconcileFirstStopDates,
  {}
);

export default crons;
```

### File: `convex/maintenance.ts` (NEW FILE)

```typescript
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Reconcile firstStopDate field with actual stop data
 * Runs daily to detect and fix any drift
 */
export const reconcileFirstStopDates = internalMutation({
  args: {},
  returns: v.object({
    checked: v.number(),
    fixed: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx) => {
    // Process in batches to stay under read limits
    const batchSize = 200;
    let cursor: string | null = null;
    let totalChecked = 0;
    let totalFixed = 0;
    const errors: string[] = [];
    
    // Process up to 1000 loads per run (5 batches)
    for (let i = 0; i < 5; i++) {
      const result = await ctx.db
        .query("loadInformation")
        .paginate({ numItems: batchSize, cursor });
      
      for (const load of result.page) {
        totalChecked++;
        
        try {
          const firstStop = await ctx.db
            .query("loadStops")
            .withIndex("by_sequence", (q) => 
              q.eq("loadId", load._id).eq("sequenceNumber", 1)
            )
            .first();
          
          const expectedDate = firstStop?.windowBeginDate;
          
          if (load.firstStopDate !== expectedDate) {
            await ctx.db.patch(load._id, { firstStopDate: expectedDate });
            totalFixed++;
            console.log(
              `[Reconcile] Fixed load ${load.orderNumber}: ` +
              `"${load.firstStopDate}" → "${expectedDate}"`
            );
          }
        } catch (error) {
          errors.push(`Load ${load._id}: ${error}`);
        }
      }
      
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    
    if (totalFixed > 0) {
      console.log(`[Reconcile] Complete: ${totalChecked} checked, ${totalFixed} fixed`);
    }
    
    return { checked: totalChecked, fixed: totalFixed, errors };
  },
});

/**
 * Manual trigger for reconciliation (for testing/debugging)
 */
export const manualReconcile = internalMutation({
  args: {
    loadId: v.optional(v.id("loadInformation")),
  },
  returns: v.object({
    oldValue: v.union(v.string(), v.null()),
    newValue: v.union(v.string(), v.null()),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (!args.loadId) {
      throw new Error("loadId is required for manual reconcile");
    }
    
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error("Load not found");
    
    const firstStop = await ctx.db
      .query("loadStops")
      .withIndex("by_sequence", (q) => 
        q.eq("loadId", args.loadId!).eq("sequenceNumber", 1)
      )
      .first();
    
    const oldValue = load.firstStopDate ?? null;
    const newValue = firstStop?.windowBeginDate ?? null;
    const changed = oldValue !== newValue;
    
    if (changed) {
      await ctx.db.patch(args.loadId, { firstStopDate: newValue ?? undefined });
    }
    
    return { oldValue, newValue, changed };
  },
});
```

---

## 9. Testing Plan

### Unit Tests

| Test Case | Expected Result |
|-----------|-----------------|
| Create load with stops | `firstStopDate` populated correctly |
| Update first stop date | `firstStopDate` synced |
| Delete first stop | `firstStopDate` updates to new first stop |
| Reorder stops | `firstStopDate` reflects new first stop |
| Filter by date range | Returns correct loads |
| Filter with no matches | Returns empty array |

### Integration Tests

1. **Migration Test**
   - Run backfill on test data
   - Verify all loads have `firstStopDate`
   - Verify values match actual first stops

2. **Sync Test**
   - Create load via UI
   - Verify `firstStopDate` populated
   - Update stop via FourKites sync
   - Verify `firstStopDate` updated

3. **Query Performance Test**
   - Filter by date range
   - Verify response time < 500ms
   - Verify no read limit errors

4. **Reconciliation Test**
   - Manually corrupt `firstStopDate`
   - Run reconciliation
   - Verify fixed

### Manual Testing Checklist

- [ ] Create load manually → firstStopDate populated
- [ ] Edit stop time → firstStopDate updated
- [ ] FourKites sync → firstStopDate updated
- [ ] Date filter on Loads page → Returns correct results
- [ ] Date filter on Dispatch Planner → Returns correct results
- [ ] Quick filters (24h/48h/72h) → Work correctly

---

## 10. Rollback Plan

### If Issues Arise

1. **Query Issues**: Revert `getLoads` to use old batching logic (code preserved in git)

2. **Sync Issues**: Disable sync calls temporarily, run reconciliation after fixing

3. **Migration Issues**: 
   - `firstStopDate` is optional, so partial migration is safe
   - Can re-run migration to fix incomplete data

4. **Full Rollback**:
   - Revert all code changes
   - Remove index (Convex handles this automatically)
   - Field can remain (unused) or be cleaned up later

### Monitoring During Rollout

- Watch Convex logs for errors
- Monitor query performance
- Check for drift in reconciliation logs

---

## 11. Implementation Checklist

### Phase 1: Schema & Infrastructure
- [ ] Update `convex/schema.ts` with new field and index
- [ ] Create `convex/_helpers/syncFirstStopDate.ts`
- [ ] Create `convex/maintenance.ts` with reconciliation
- [ ] Deploy schema changes

### Phase 2: Migration
- [ ] Create `convex/migrations/backfillFirstStopDate.ts`
- [ ] Deploy migration code
- [ ] Run backfill via Convex dashboard
- [ ] Verify all loads have `firstStopDate`

### Phase 3: Sync Logic
- [ ] Update `convex/loads.ts` - `createLoad`
- [ ] Update `convex/loads.ts` - `updateStopTimes`
- [ ] Update `convex/fourKitesSyncHelpers.ts`
- [ ] Update `convex/fourKitesPullSyncAction.ts`
- [ ] Deploy sync changes

### Phase 4: Query Optimization
- [ ] Update `convex/loads.ts` - `getLoads` query
- [ ] Remove old batching code
- [ ] Deploy query changes
- [ ] Test date filtering

### Phase 5: Cron Setup
- [ ] Update `convex/crons.ts` with reconciliation job
- [ ] Deploy cron changes
- [ ] Verify cron runs successfully

### Phase 6: Validation
- [ ] Test Loads page date filtering
- [ ] Test Dispatch Planner date filtering
- [ ] Verify no read limit errors
- [ ] Monitor for 24 hours

---

## Appendix: File Changes Summary

| File | Action | Changes |
|------|--------|---------|
| `convex/schema.ts` | Modify | Add `firstStopDate` field + index |
| `convex/_helpers/syncFirstStopDate.ts` | Create | Sync helper function |
| `convex/migrations/backfillFirstStopDate.ts` | Create | Migration script |
| `convex/maintenance.ts` | Create | Reconciliation functions |
| `convex/crons.ts` | Modify | Add reconciliation cron |
| `convex/loads.ts` | Modify | Update `createLoad`, `updateStopTimes`, `getLoads` |
| `convex/fourKitesSyncHelpers.ts` | Modify | Add sync calls |
| `convex/fourKitesPullSyncAction.ts` | Modify | Add sync calls |

---

---

## 12. Edge Case Analysis (Reviewed Jan 6, 2026)

Based on codebase audit, here are the findings for each potential edge case:

### A. Stop Deletions

**Finding**: No standalone `deleteStop` mutation exists.

**Code Path**: 
- `deleteLoad` in `loads.ts` (line 1022-1035) deletes all stops, then the load itself
- When the load is deleted, `firstStopDate` is also deleted - no sync needed

**Action Required**: ❌ None

### B. Stop Resequencing  

**Finding**: No mutation exists for reordering stops.

**Code Path**:
- `sequenceNumber` is set during stop creation and never modified
- Searched all files in `/convex` - no `patch` calls that modify `sequenceNumber`

**Action Required**: ❌ None

### C. Date String Consistency

**Finding**: `windowBeginDate` can be in different formats:
- Standard: `"2026-01-06"` (YYYY-MM-DD)
- ISO with time: `"2026-01-06T12:00:00Z"` (from FourKites)
- TBD marker: `"TBD"` (when no appointment time available)

**Code Evidence** (from `fourKitesSyncHelpers.ts` line 314):
```typescript
windowBeginDate: appointmentTime?.split("T")[0] || "TBD"
```

**Action Required**: ✅ Sanitize in `syncFirstStopDate`:
```typescript
// Extract YYYY-MM-DD, handle TBD
const rawDate = firstStop.windowBeginDate;
if (!rawDate || rawDate === 'TBD') return undefined;
return rawDate.split('T')[0];
```

### D. Zero Stops Case

**Finding**: If a load has zero stops, `firstStopDate` will be `undefined`.

**Query Impact**: 
- `q.gte('firstStopDate', startDate)` excludes documents where field is undefined
- Users filtering by date will not see loads without stops

**Action Required**: ❌ None - this is the desired behavior

### E. Sorting Behavior Change

**Finding**: Current `getLoads` sorts by `_creationTime` (desc).

**New Behavior**: When using `by_org_first_stop_date` index, results will be sorted by `firstStopDate`.

**Impact**:
- Users filtering by date will see loads sorted by that date (logical)
- Users NOT filtering will still see loads sorted by creation time (no change)

**Action Required**: ❌ None - behavior is contextually appropriate

---

## 13. Updated Implementation Checklist

Based on the edge case analysis, here is the refined checklist:

### Phase 1: Schema & Infrastructure
- [ ] Update `convex/schema.ts` with new field and index
- [ ] Create sync helper function in `convex/loads.ts`

### Phase 2: Migration
- [ ] Create `convex/migrations/backfillFirstStopDate.ts`
- [ ] Deploy and run migration

### Phase 3: Sync Logic
- [ ] Update `convex/loads.ts` - `createLoad`
- [ ] Update `convex/loads.ts` - `updateStopTimes`  
- [ ] Update `convex/fourKitesSyncHelpers.ts` - `importLoadFromShipment`
- [ ] Update `convex/fourKitesSyncHelpers.ts` - `updateStop`
- [ ] Update `convex/fourKitesPullSyncAction.ts` - stop updates

### Phase 4: Query Optimization
- [ ] Update `convex/loads.ts` - `getLoads` query to use index
- [ ] Remove old batching workaround code

### Phase 5: Reconciliation
- [ ] Add daily reconciliation cron job

### Validations Confirmed NOT Needed:
- ✅ No `deleteStop` mutation to audit
- ✅ No "reorder stops" logic to audit

---

*Document Version: 1.1*
*Created: January 6, 2026*
*Updated: January 6, 2026 (Edge case analysis added)*
*Author: Claude (AI Assistant)*

