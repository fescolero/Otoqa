# Bulk Update Reactivity Fix

## Problem
When performing bulk status updates (e.g., changing 48 loads to "Open"), the table didn't update properly and the badge counts remained incorrect. The UI required a manual refresh to see the changes.

## Root Causes

### 1. Race Condition in Aggregate Stats
The primary issue was a **race condition in the aggregate stats updates**:

1. The frontend used `Promise.all()` to call `updateLoadStatus` 48 times simultaneously
2. Each mutation:
   - Read the current `organizationStats` document
   - Calculated new counts based on what it just read
   - Patched the stats document
3. All 48 mutations read the **same initial state**, then each wrote their own version
4. The last write won, resulting in only +1/-1 instead of +48/-48

### Example of the Race Condition
```
Initial state: { Open: 100, Assigned: 2331 }

Mutation 1 reads: { Open: 100, Assigned: 2331 }
Mutation 2 reads: { Open: 100, Assigned: 2331 }  ← Same state!
...
Mutation 48 reads: { Open: 100, Assigned: 2331 } ← Same state!

Mutation 1 writes: { Open: 101, Assigned: 2330 }
Mutation 2 writes: { Open: 101, Assigned: 2330 } ← Overwrites mutation 1!
...
Mutation 48 writes: { Open: 101, Assigned: 2330 } ← Only +1/-1 instead of +48/-48!
```

### 2. Stale Pagination Cursor
After bulk updates completed, the pagination cursor wasn't being reset:
- Loads changed status (Assigned → Open)
- Query should refetch with new data
- But cursor pointed to old result set
- Table showed stale data until manual refresh

### 3. Query Subscription Not Refreshing
Convex queries are reactive, but when using manual pagination with `useQuery`, the query subscription wasn't being properly refreshed after bulk updates:
- Convex tracks query dependencies and reruns queries when data changes
- However, with manual pagination and filters, the subscription may serve cached results
- The query subscription needs to be completely torn down and recreated
- Simply changing the cursor or args doesn't guarantee a fresh fetch from the server

## Solution

### Backend: New `bulkUpdateLoadStatus` Mutation
Created a dedicated bulk mutation (`convex/loads.ts`) that:

1. **Validates all loads first** (single pass)
2. **Performs all updates** while tracking status changes per organization
3. **Aggregates the changes** (e.g., -48 from Assigned, +48 to Open)
4. **Applies stats update once** per organization with the accumulated delta

```typescript
// Track status changes by organization
const orgStatusChanges = new Map<string, Map<string, number>>();

// For each load update:
orgChanges.set(oldStatus, (orgChanges.get(oldStatus) || 0) - 1);
orgChanges.set(newStatus, (orgChanges.get(newStatus) || 0) + 1);

// Apply all changes at once:
for (const [orgId, statusChanges] of orgStatusChanges.entries()) {
  const stats = await ctx.db.query('organizationStats')...;
  const newLoadCounts = { ...stats.loadCounts };
  
  for (const [status, delta] of statusChanges.entries()) {
    newLoadCounts[status] = Math.max(0, newLoadCounts[status] + delta);
  }
  
  await ctx.db.patch(stats._id, { loadCounts: newLoadCounts });
}
```

### Frontend: Use Bulk Mutation + Force Query Refresh
Updated `components/loads-table.tsx` to:
1. Use the new bulk mutation
2. Reset pagination cursor after updates
3. **Use the skip/re-enable pattern to force a complete query refresh**

```typescript
// ❌ OLD: Race condition + stale cursor + subscription not refreshing
await Promise.all(
  loadIds.map((loadId) =>
    updateLoadStatus({ loadId, status })
  )
);
// No cursor reset! No subscription refresh!

// ✅ NEW: Skip query pattern for forced refresh
const [skipQuery, setSkipQuery] = useState(false);

// ✅ Pass "skip" to temporarily unsubscribe from query
const loadsData = useQuery(
  api.loads.getLoads,
  skipQuery ? "skip" : {
    // ...normal params
  }
);

// ✅ After bulk update: atomic operation + forced refresh
const result = await bulkUpdateLoadStatus({ loadIds, status });
setPaginationCursor(null);              // Reset to first page
setSkipQuery(true);                     // Unsubscribe from query
setTimeout(() => setSkipQuery(false), 0); // Re-subscribe on next tick (fresh data!)
```

## Benefits

1. **Atomic stats updates** - No more race conditions
2. **Accurate badge counts** - Always reflects the true state
3. **Automatic reactivity** - UI updates immediately without refresh
4. **Better error handling** - Returns `{ success, failed }` counts
5. **Performance** - Single stats write instead of N writes
6. **Guaranteed fresh data** - Skip/re-enable pattern ensures table always shows latest state

## How the Skip/Re-enable Pattern Works

According to Convex documentation:
- **Queries are reactive** - They automatically re-run when dependent data changes
- **Query subscriptions** - `useQuery` establishes a WebSocket subscription to the backend
- **"skip" parameter** - Passing `"skip"` completely tears down the subscription

The Skip/Re-enable Pattern:
```typescript
// Step 1: Query is active and subscribed
useQuery(api.loads.getLoads, { orgId: "123", cursor: null })

// Step 2: User performs bulk update
await bulkUpdateLoadStatus({ loadIds, status });

// Step 3: Tear down subscription
setSkipQuery(true);  // → useQuery sees "skip" and unsubscribes

// Step 4: Re-establish subscription on next tick
setTimeout(() => setSkipQuery(false), 0);  // → Creates NEW subscription with fresh data!
```

### Why This Works

1. **Complete teardown** - `"skip"` tells Convex to completely disconnect and clean up the subscription
2. **Fresh subscription** - When re-enabled, Convex creates a brand new subscription from scratch
3. **No caching** - The new subscription fetches fresh data from the server, bypassing any cached results
4. **Guaranteed refresh** - This is a hard refresh that always gets the latest data

This is a standard React + Convex pattern for forcing query refreshes when automatic reactivity isn't sufficient.

## Changes Made

### Backend (`convex/loads.ts`)
- ✅ Added `bulkUpdateLoadStatus` mutation with proper status change tracking
- ✅ Handles all status transitions (Open, Assigned, Canceled, Completed)
- ✅ Manages dispatch legs and payables for Canceled/Open transitions
- ✅ Aggregates stats changes per organization

### Frontend (`components/loads-table.tsx`)
- ✅ Added `useMutation(api.loads.bulkUpdateLoadStatus)`
- ✅ Added `skipQuery` state for subscription control
- ✅ Pass `skipQuery ? "skip" : { params }` to `getLoads` query
- ✅ Updated `executeBulkStatusUpdate` to use bulk mutation + skip/re-enable pattern
- ✅ Updated `handleUpdateStatus` (non-validated updates) to use bulk mutation + skip/re-enable pattern
- ✅ Updated `handleCancellationConfirm` to use bulk mutation + skip/re-enable pattern
- ✅ Enhanced toast notifications to show success/failed counts

## Testing
1. Select multiple loads (e.g., 48 loads)
2. Change their status (e.g., Assigned → Open)
3. Verify:
   - Badge counts update immediately (e.g., Assigned: 2331 → 2283, Open: 100 → 148)
   - Table refreshes automatically
   - No manual refresh needed
   - Toast shows accurate count (e.g., "Updated 48 loads to Open")

## Industry Pattern
This fix implements the **Event Sourcing / Aggregate Pattern** for maintaining counts:
- Collect all changes in a transaction
- Aggregate the deltas
- Apply once atomically

This is the standard approach for maintaining aggregate statistics in distributed systems (used by Stripe, Shopify, etc.) to avoid race conditions.

