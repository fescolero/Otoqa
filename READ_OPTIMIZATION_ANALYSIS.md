# Read Optimization Analysis - 84GB Reads Investigation

## 🔴 Critical Issues (High Read Volume)

### 1. **`getLoads` Query** - PRIMARY CULPRIT
**Location:** `convex/loads.ts:54`
**Called from:** `components/loads-table.tsx:59` (with `numItems: 1000`)

**Problem:**
- Fetches 1000 loads per page
- For EACH load, queries ALL stops using `.collect()`
- **Read Impact:** 1000 loads × ~3 stops = **~3,000 stop reads per query call**
- Plus 1000 load reads = **~4,000 total reads per call**

**Code:**
```typescript
const loadsWithStops = await Promise.all(
  filteredLoads.map(async (load) => {
    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', load._id))
      .collect(); // ❌ Reads ALL stops for each load
  })
);
```

**Frequency:** Called on every page load/refresh of loads table

---

### 2. **`getUnmappedLoadGroups` Query** - SECONDARY CULPRIT
**Location:** `convex/analytics.ts:14`
**Called from:** `app/(app)/invoices/_components/invoices-dashboard.tsx:72`

**Problem:**
- Reads **ALL UNMAPPED loads** using `.collect()`
- No pagination, no limit
- If you have 4,594 unmapped loads (as mentioned in comment), this reads all of them

**Code:**
```typescript
const unmappedLoads = await ctx.db
  .query("loadInformation")
  .withIndex("by_load_type", (q) => 
    q.eq("workosOrgId", args.workosOrgId).eq("loadType", "UNMAPPED")
  )
  .collect(); // ❌ Reads ALL unmapped loads
```

**Frequency:** Called on every invoices page load (Attention tab)

---

### 3. **`listInvoices` Query** - MODERATE ISSUE
**Location:** `convex/invoices.ts:332`
**Called from:** `app/(app)/invoices/_components/invoices-dashboard.tsx:105-148`

**Problem:**
- Uses `.take(limit)` which is good, BUT:
- Called with `limit: 1000` in invoices-dashboard.tsx
- For EACH invoice, does additional lookups:
  - `ctx.db.get(invoice.loadId)` - 1000 load reads
  - `ctx.db.get(invoice.customerId)` - 1000 customer reads
  - `enrichInvoiceWithCalculatedAmounts()` - may read contract lanes

**Code:**
```typescript
const invoices = await ctx.db
  .query("loadInvoices")
  .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
  .filter((q) => q.eq(q.field("status"), args.status))
  .order("desc")
  .take(limit); // ✅ Has limit, but limit is 1000

// ❌ Then enriches each with additional reads
const enriched = await Promise.all(
  invoices.map(async (invoice) => {
    const load = await ctx.db.get(invoice.loadId); // 1000 reads
    const customer = await ctx.db.get(invoice.customerId); // 1000 reads
    const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice); // May read lanes
  })
);
```

**Frequency:** Called for each tab (draft, pending, paid, void) on invoices page

---

### 4. **`getInvoices` Query (OLD)** - CRITICAL IF STILL USED
**Location:** `convex/invoices.ts:79`
**Status:** ⚠️ Check if still being called

**Problem:**
- Reads **ALL invoices** using `.collect()` with NO pagination
- Then enriches each with load/customer lookups

**Code:**
```typescript
const invoices = await query.order("desc").collect(); // ❌ NO LIMIT!
```

**Frequency:** Unknown - need to check if still used

---

### 5. **`countLoadsByStatus` Query** - CALLED ON EVERY LOADS PAGE
**Location:** `convex/loads.ts:9`
**Called from:** `components/loads-table.tsx:50` and `components/dispatch/planner/trips-table.tsx:40`

**Problem:**
- Reads **ALL loads** using `.collect()` just to count by status
- Called on every loads table page load
- Could use aggregation/index instead

**Code:**
```typescript
const allLoads = await ctx.db
  .query('loadInformation')
  .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
  .collect(); // ❌ Reads ALL loads just to count
```

**Frequency:** Called on every loads/dispatch page load

---

### 6. **`countInvoicesByStatus` Query** - CALLED ON EVERY INVOICES PAGE
**Location:** `convex/invoices.ts:204`
**Called from:** `app/(app)/invoices/_components/invoices-dashboard.tsx:68`

**Problem:**
- Reads **ALL invoices** using `.collect()` just to count by status
- Called on every invoices page load
- Same pattern as `countLoadsByStatus` - should use aggregate table

**Code:**
```typescript
const invoices = await ctx.db
  .query("loadInvoices")
  .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
  .collect(); // ❌ Reads ALL invoices just to count
```

**Frequency:** Called on every invoices page load

---

### 7. **`countLoadsAndStops` Diagnostic Query** - IF CALLED FREQUENTLY
**Location:** `convex/diagnostics.ts:7`

**Problem:**
- Reads **ALL loads, ALL stops, ALL invoices** using `.collect()`
- This is a diagnostic query, but if called frequently, it's catastrophic

**Code:**
```typescript
const loads = await ctx.db.query("loadInformation")...collect(); // ❌ ALL loads
const stops = await ctx.db.query("loadStops")...collect(); // ❌ ALL stops
const invoices = await ctx.db.query("loadInvoices")...collect(); // ❌ ALL invoices
```

**Frequency:** Need to check if this is called in production

---

### 8. **Background Jobs - FourKites Sync** - MODERATE (If Frequent)
**Location:** `convex/fourKitesScheduledSync.ts:10`
**Frequency:** Runs every 15 minutes via cron

**Problem:**
- Reads ALL integrations using `.collect()` (probably fine, but worth noting)
- Then triggers `processOrg` which may read loads/stops during sync

**Code:**
```typescript
const allIntegrations = await ctx.db
  .query("orgIntegrations")
  .collect(); // Probably fine (small table), but worth monitoring
```

**Note:** This is likely fine since integrations table is small, but the sync process itself may read many loads/stops

---

## 📊 Read Impact Calculation

### Per Page Load (Worst Case):

1. **Loads Table Page:**
   - `getLoads`: 1,000 loads + 3,000 stops = **4,000 reads**
   - `countLoadsByStatus`: ALL loads (could be 10,000+) = **10,000+ reads**
   - **Total: ~14,000+ reads per loads page**

2. **Invoices Page (Attention Tab):**
   - `getUnmappedLoadGroups`: 4,594 unmapped loads = **4,594 reads**
   - `countInvoicesByStatus`: Unknown, but likely reads all invoices
   - **Total: ~5,000+ reads per invoices page**

3. **Invoices Page (Other Tabs):**
   - `listInvoices` (4 tabs × 1000 invoices) = **4,000 invoice reads**
   - Plus 4,000 load reads + 4,000 customer reads = **12,000 reads**
   - **Total: ~12,000 reads per invoices page**

### If Auto-Refresh or Multiple Users:
- Convex queries auto-refresh when data changes
- Multiple users viewing same pages = multiplied reads
- **84GB over a period = many thousands of these queries**

---

## ✅ Recommended Fixes (Priority Order)

### Priority 1: Implement Pagination (CRITICAL - 80% Reduction)
**Impact:** Reduces reads by ~95% for main queries

**Industry Standard: "Pagination First" Pattern**
- Never use `.collect()` for table views
- Use Convex's built-in `paginate()` function (not just `.take()`)
- `paginate()` returns a cursor for optimized reactivity across pages
- Frontend uses `usePaginatedQuery` hook for automatic "Load More" handling

**Fixes:**
1. **`getLoads`** - Reduce from 1000 to 30-50 loads per page
   - Change `numItems: 1000` → `numItems: 50` in `components/loads-table.tsx:71`
   - **Backend:** Ensure query uses `.paginate(args.paginationOpts)` (already correct)
   - **Frontend:** Use `usePaginatedQuery` hook (not `useQuery`)
   - **Read Impact:** 4,000 reads → 200 reads (95% reduction)

2. **`listInvoices`** - Reduce limit from 1000 to 50
   - Change `limit: 1000` → `limit: 50` in `app/(app)/invoices/_components/invoices-dashboard.tsx:110,125,140`
   - **Backend:** Convert to use `.paginate()` instead of `.take()`
   - **Frontend:** Use `usePaginatedQuery` hook
   - **Read Impact:** 3,000 reads → 150 reads (95% reduction)

3. **`getUnmappedLoadGroups`** - Add limit or pagination
   - Replace `.collect()` with `.take(100)` (or implement full pagination)
   - **Read Impact:** 4,594 reads → 100 reads (98% reduction)

**Implementation:**
```typescript
// ✅ CORRECT: Backend uses paginate
// convex/loads.ts
export const getLoads = query({
  args: { 
    workosOrgId: v.string(),
    paginationOpts: paginationOptsValidator,
    // ... other filters
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .order("desc")
      .paginate(args.paginationOpts); // ✅ Returns cursor for next page
  },
});

// ✅ CORRECT: Frontend uses usePaginatedQuery
// components/loads-table.tsx
import { usePaginatedQuery } from "convex/react";

const { results, status, loadMore } = usePaginatedQuery(
  api.loads.getLoads,
  { 
    workosOrgId: organizationId,
    // ... filters
  },
  { initialNumItems: 50 } // ✅ Not 1000!
);

// Handle "Load More" button
<Button onClick={() => loadMore(50)} disabled={status !== "CanLoadMore"}>
  Load More
</Button>
```

**Why `paginate()` > `.take()`:**
- Convex optimizes reactivity across pages
- Cursor-based pagination is more efficient than offset-based
- Handles data changes better (doesn't re-run entire query)

---

### Priority 2: Aggregate Table for Count Queries (HIGH - 15% Reduction)
**Impact:** Reduces count queries from 10,000+ reads to 1 read (99% reduction)

**Industry Standard: "Event-Driven Aggregates" Pattern**
- **Rule:** Never count items in a query. Instead, "Maintain a Counter."
- **Principle:** In NoSQL, Storage is cheap, Reads are expensive
- **Pattern:** Use Transaction Pattern - wrap mutations so creating/updating entities also updates counters
- **Drift Protection:** Daily recalculation cron (industry standard - Stripe, Shopify do this)

**Solution:** Create `organizationStats` aggregate table

**Schema:**
```typescript
// convex/schema.ts
organizationStats: defineTable({
  workosOrgId: v.string(),
  loadCounts: v.object({
    Open: v.number(),
    Assigned: v.number(),
    Completed: v.number(),
    Canceled: v.number(),
  }),
  invoiceCounts: v.object({
    MISSING_DATA: v.number(),
    DRAFT: v.number(),
    BILLED: v.number(),
    PENDING_PAYMENT: v.number(),
    PAID: v.number(),
    VOID: v.number(),
  }),
  lastRecalculated: v.optional(v.number()), // For drift detection
  updatedAt: v.number(),
}).index("by_org", ["workosOrgId"]),
```

**Helper Functions (Transaction Pattern):**
```typescript
// convex/stats_helpers.ts
// ✅ Industry Standard: Transaction Pattern - update stats in same transaction as entity change

export const updateLoadCount = async (
  ctx: MutationCtx,
  orgId: string,
  oldStatus: string | undefined,
  newStatus: string,
  amount: number = 1
) => {
  // Use .first() since stats might not exist yet
  let stats = await ctx.db
    .query("organizationStats")
    .withIndex("by_org", (q) => q.eq("workosOrgId", orgId))
    .first();
  
  if (!stats) {
    // Create initial stats with zeros
    const statsId = await ctx.db.insert("organizationStats", {
      workosOrgId: orgId,
      loadCounts: { Open: 0, Assigned: 0, Completed: 0, Canceled: 0 },
      invoiceCounts: { MISSING_DATA: 0, DRAFT: 0, BILLED: 0, PENDING_PAYMENT: 0, PAID: 0, VOID: 0 },
      updatedAt: Date.now(),
    });
    stats = await ctx.db.get(statsId);
    if (!stats) return;
  }

  const newLoadCounts = { ...stats.loadCounts };
  
  // Decrement old status
  if (oldStatus && oldStatus in newLoadCounts) {
    newLoadCounts[oldStatus as keyof typeof newLoadCounts] = 
      Math.max(0, (newLoadCounts[oldStatus as keyof typeof newLoadCounts] || 0) - amount);
  }
  
  // Increment new status
  if (newStatus in newLoadCounts) {
    newLoadCounts[newStatus as keyof typeof newLoadCounts] = 
      (newLoadCounts[newStatus as keyof typeof newLoadCounts] || 0) + amount;
  }

  await ctx.db.patch(stats._id, {
    loadCounts: newLoadCounts,
    updatedAt: Date.now(),
  });
};

// Similar function for updateInvoiceCount

// ✅ Pro Tip: Wrap mutations to ensure stats are always updated
// Example in updateLoadStatus:
export const updateLoadStatus = mutation({
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    const oldStatus = load.status;
    
    // Update load (in transaction)
    await ctx.db.patch(args.loadId, { status: args.status });
    
    // Update stats (in same transaction - atomic!)
    await updateLoadCount(ctx, load.workosOrgId, oldStatus, args.status);
  },
});
```

**Mutation Points to Update:**
1. `convex/loads.ts:updateLoadStatus` - When load status changes
2. `convex/loads.ts:createLoad` - When new load created
3. `convex/fourKitesSyncHelpers.ts:importLoadFromShipment` - When FourKites creates loads
4. `convex/invoices.ts:bulkUpdateStatus` - When invoice status changes
5. `convex/invoices.ts:bulkVoidInvoices` - When invoices voided
6. `convex/fourKitesSyncHelpers.ts:createInvoice` - When invoices created
7. `convex/lanes.ts:createLaneAndBackfill` - When UNMAPPED → DRAFT
8. `convex/lazyLoadPromotion.ts:periodicCleanup` - When loads promoted
9. `convex/lazyLoadPromotion.ts:checkAndPromoteLoad` - When loads promoted

**Updated Queries:**
```typescript
// convex/loads.ts
export const countLoadsByStatus = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    const stats = await ctx.db
      .query("organizationStats")
      .withIndex("by_org", (q) => q.eq("workosOrgId", args.workosOrgId))
      .first(); // Use .first() since stats might not exist yet

    if (!stats) {
      return { Open: 0, Assigned: 0, Delivered: 0, Canceled: 0 };
    }

    return {
      Open: stats.loadCounts.Open,
      Assigned: stats.loadCounts.Assigned,
      Delivered: stats.loadCounts.Completed, // Map for UI
      Canceled: stats.loadCounts.Canceled,
    };
  },
});

// convex/invoices.ts - Similar pattern for countInvoicesByStatus
```

**Daily Recalculation Cron:**
```typescript
// convex/stats.ts
export const recalculateStats = internalMutation({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    // Recalculate from actual data to catch drift
    // ... (see IMPLEMENTATION_REVIEW.md for full code)
  },
});

// convex/crons.ts - Add daily recalculation
crons.interval(
  "recalculate-stats",
  { hours: 24 },
  internal.stats.recalculateAllOrgs
);
```

---

### Priority 3: Lazy Load Stops (MEDIUM - 5% Reduction)
**Impact:** Reduces stop reads by ~75% (only fetch when user expands row)

**Industry Standard: Row-Level Component Pattern**
- Each table row is its own component (`<LoadRow />`)
- Inside component, call `useQuery` with conditional `skip` parameter
- Query doesn't hit network until user clicks "Expand"

**Implementation:**
```typescript
// ✅ CORRECT: Row-level component with conditional query
// components/loads-table.tsx
function LoadRow({ load }: { load: Doc<"loadInformation"> }) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  // ✅ Crucial: Pass skip: !isExpanded to prevent network call
  const stops = useQuery(
    api.stops.getByLoadId, 
    isExpanded ? { loadId: load._id } : "skip" // ✅ Query only runs when expanded
  );

  return (
    <>
      <TableRow onClick={() => setIsExpanded(!isExpanded)}>
        <TableCell>{load.orderNumber}</TableCell>
        {/* Show origin/destination from denormalized data on load record */}
        <TableCell>{load.originCity}, {load.originState}</TableCell>
        <TableCell>{load.destinationCity}, {load.destinationState}</TableCell>
      </TableRow>
      {isExpanded && (
        <TableRow>
          <TableCell colSpan={5}>
            {stops ? <StopsList data={stops} /> : <Spinner />}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
```

**Key Points:**
- Use `"skip"` parameter (not `undefined`) to prevent query execution
- Denormalize origin/destination on load record for list view
- Only fetch full stops when user explicitly expands row
- **Result:** 50 loads = 50 reads (not 200 reads)

---

### Priority 4: Query Debouncing
**Impact:** Prevents read spikes during search

**Implementation:**
```typescript
// hooks/use-debounce.ts
import { useEffect, useState } from 'react';

export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

// Usage in components
const [search, setSearch] = useState('');
const debouncedSearch = useDebounce(search, 300);
const results = useQuery(api.loads.getLoads, { 
  search: debouncedSearch || undefined 
});
```

---

### Priority 5: Controlled Denormalization (RECOMMENDED - 60% Reduction)
**Impact:** Reduces enrichment reads by ~60%

**Industry Standard: "Controlled Denormalization"**
- **Rule of Thumb:** If data is immutable or rarely changes, denormalize it
- **Trade-off:** Write cost (slightly higher) vs Read cost (massively lower)
- **Example:** 2 reads per row → 1 read per row = 50% reduction

**Recommended Denormalization:**

1. **Invoice → Customer Name** (High Value)
   - Copy `customerName` onto `loadInvoices` when invoice created
   - Customer names rarely change
   - **Impact:** Eliminates 1000 customer reads per invoice list query

2. **Invoice → Load Number** (High Value)
   - Copy `orderNumber` onto `loadInvoices` when invoice created
   - Load numbers are immutable
   - **Impact:** Eliminates 1000 load reads per invoice list query

3. **Load → Origin/Destination** (Medium Value)
   - Copy `originCity`, `originState`, `destinationCity`, `destinationState` onto `loadInformation`
   - Stops rarely change after load creation
   - **Impact:** Eliminates 3000 stop reads per loads list query

**Implementation:**
```typescript
// When creating invoice, copy immutable/rarely-changing data
export const createInvoice = internalMutation({
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    const customer = await ctx.db.get(args.customerId);
    
    await ctx.db.insert("loadInvoices", {
      loadId: args.loadId,
      customerId: args.customerId,
      // ✅ Denormalize immutable/rarely-changing data
      customerName: customer.name, // Copy customer name
      orderNumber: load.orderNumber, // Copy load number
      // ... rest of invoice data
    });
  },
});

// When customer name changes (rare), update all invoices
export const updateCustomerName = mutation({
  handler: async (ctx, args) => {
    await ctx.db.patch(args.customerId, { name: args.newName });
    
    // Update denormalized data in invoices
    const invoices = await ctx.db
      .query("loadInvoices")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .collect();
    
    for (const invoice of invoices) {
      await ctx.db.patch(invoice._id, { customerName: args.newName });
    }
  },
});
```

**What NOT to Denormalize:**
- Frequently changing data (load status, invoice status)
- Large objects (full customer record, full load record)
- Data that requires complex calculations

**What TO Denormalize:**
- Immutable identifiers (orderNumber, invoiceNumber)
- Rarely-changing names (customerName, loadNumber)
- Simple derived values (originCity, destinationCity)

---

### Priority 6: Optimize Background Jobs (FourKites Sync)
**Impact:** Prevents "silent killer" read spikes from background jobs

**Industry Standard: "Change Detection" Pattern**
- Before updating a document, compare incoming data to existing data
- If nothing changed, don't patch (prevents unnecessary reactive query triggers)
- Reduces reads AND prevents frontend re-renders

**Implementation:**
```typescript
// ✅ CORRECT: Change detection before patching
// convex/fourKitesPullSyncAction.ts
for (const shipment of shipments) {
  const existingLoad = await ctx.runMutation(
    internal.fourKitesSyncHelpers.findLoadByExternalId,
    { externalLoadId: shipment.id }
  );

  if (existingLoad) {
    // ✅ Compare incoming data to existing data
    const hasChanges = 
      existingLoad.lastExternalUpdatedAt !== shipment.updated_at ||
      existingLoad.weight !== shipment.weight ||
      existingLoad.commodityDescription !== shipment.commodity;
    
    // ✅ Only patch if something actually changed
    if (hasChanges) {
      await ctx.runMutation(internal.fourKitesSyncHelpers.updateLoad, {
        loadId: existingLoad._id,
        data: {
          lastExternalUpdatedAt: shipment.updated_at,
          weight: shipment.weight,
          commodityDescription: shipment.commodity,
          updatedAt: Date.now(),
        },
      });
    } else {
      skipped++; // ✅ No patch = no reactive query trigger = no frontend re-reads
    }
  }
}
```

**Why This Matters:**
- Every patch triggers reactive queries on frontend
- If 1000 loads are "synced" but unchanged, that's 1000 unnecessary frontend re-reads
- Change detection prevents this entirely

---

### Priority 7: Audit & Remove Diagnostic Queries
**Impact:** If called frequently, prevents catastrophic reads

**Actions:**
1. Search for calls to `api.diagnostics.countLoadsAndStops`
2. Remove from production UI (use Convex dashboard instead)
3. Check if `api.invoices.getInvoices` (old) is still used
4. Check for missing `useEffect` dependencies causing excessive re-queries

---

## 📋 Staged Rollout Plan

### Phase 1: Emergency Fixes (Week 1) - Target: 80% Reduction
**Goal:** Get from 84GB to ~10GB immediately

**Final Checklist for Week 1:**

1. ✅ **Change `numItems: 1000` → `numItems: 50`** in frontend
   - `components/loads-table.tsx:71`
   - Ensure using `usePaginatedQuery` (not `useQuery`)

2. ✅ **Replace `.collect()` with `.take(100)`** in `getUnmappedLoadGroups`
   - `convex/analytics.ts:25`

3. ✅ **Add `useDebounce` hook** to search bars (300ms delay)
   - All search inputs in loads, invoices, dispatch tables

4. ✅ **Comment out `api.diagnostics.countLoadsAndStops`** in production code
   - Use Convex dashboard for diagnostics instead

5. ✅ **Convert `listInvoices` to use `.paginate()`** instead of `.take()`
   - Update backend query
   - Update frontend to use `usePaginatedQuery`

6. ✅ **Add change detection** to FourKites sync
   - Only patch if data actually changed

**Expected Result:** ~80% read reduction (84GB → ~10GB)

---

### Phase 2: Aggregate Tables (Week 2) - Target: 15% Additional Reduction
**Goal:** Fix count queries (10GB → 2GB)

1. ✅ Create `organizationStats` schema
2. ✅ Create helper functions (`updateLoadCount`, `updateInvoiceCount`)
3. ✅ Update all 9 mutation points to maintain stats
4. ✅ Update `countLoadsByStatus` query
5. ✅ Update `countInvoicesByStatus` query
6. ✅ Create migration to initialize stats for existing orgs
7. ✅ Add daily recalculation cron job

**Expected Result:** Count queries go from 10,000+ reads to 1 read (99% reduction)

---

### Phase 3: Optimizations (Week 3+) - Target: 5% Additional Reduction
**Goal:** Polish and fine-tune

1. ✅ Implement lazy loading for stops
2. ✅ Consider denormalization for invoice enrichment
3. ✅ Monitor Convex dashboard for remaining hotspots
4. ✅ Optimize background jobs if needed

**Expected Result:** Final optimization pass

---

## 🔍 Pre-Implementation: "Audit Mode"

### Using Convex Dashboard Effectively

1. **Check `journal.read_set` Size**
   - In Convex logs, look at "Read Set" size for queries
   - **Target:** A list page should touch `Documents per page + 1` (for stats)
   - **Red Flag:** If a query touches >200 documents, it's unoptimized
   - **Example:** 50 loads page should read ~51 documents (50 loads + 1 stats)

2. **Monitor Function Executions**
   - Check if count queries are called thousands of times
   - **Red Flag:** Indicates missing `useEffect` dependencies or excessive re-renders
   - **Fix:** Review React component dependencies

3. **Identify Peak Read Times**
   - Check when reads spike (reveals auto-refresh issues)
   - Look for patterns (every 15 minutes = background job, every second = missing debounce)

4. **Verify Query Usage**
   - Search for `api.invoices.getInvoices` (old query)
   - Search for `api.diagnostics.countLoadsAndStops`
   - Confirm all problematic queries are identified

5. **Test Migration Strategy**
   - Plan how to initialize stats for existing organizations
   - Test helper functions in development
   - Verify mutation points are all identified

---

## 📊 Expected Results

### Before Optimization:
- **Loads Table Page:** ~14,000 reads
- **Invoices Page:** ~12,000 reads
- **Total Daily:** ~84GB reads

### After Phase 1 (Pagination):
- **Loads Table Page:** ~200 reads (95% reduction)
- **Invoices Page:** ~150 reads (99% reduction)
- **Total Daily:** ~10GB reads (88% reduction)

### After Phase 2 (Aggregate Tables):
- **Count Queries:** 1 read each (99% reduction)
- **Total Daily:** ~2GB reads (98% reduction)

### After Phase 3 (Optimizations):
- **Total Daily:** ~1-2GB reads (98-99% reduction)

---

## 🚀 Implementation Priority Summary

| Priority | Fix | Impact | Effort | Timeline |
|----------|-----|--------|--------|----------|
| **P0** | Reduce page sizes (1000→50) | 95% reduction | Low | Day 1 |
| **P0** | Add limits to unmapped groups | 98% reduction | Low | Day 1 |
| **P0** | Add query debouncing | Prevents spikes | Low | Day 1 |
| **P1** | Aggregate table for counts | 99% reduction | Medium | Week 2 |
| **P2** | Lazy load stops | 75% reduction | Medium | Week 3 |
| **P3** | Denormalization | 60% reduction | High | Future |

---

## 📝 Implementation Notes

### Key Technical Decisions

1. **`.first()` vs `.unique()`:**
   - Use `.first()` for `organizationStats` - stats might not exist initially
   - Use `.unique()` for core entities that must exist (organizations, users)
   - See `FIRST_VS_UNIQUE_GUIDANCE.md` for detailed comparison

2. **Pagination Pattern:**
   - Always use `paginate()` (not `.take()`) for list queries
   - Use `usePaginatedQuery` hook on frontend (not `useQuery`)
   - Cursor-based pagination is more efficient and handles reactivity better

3. **Transaction Pattern for Aggregates:**
   - Wrap mutations to ensure stats are updated atomically
   - Update entity and stats in same transaction
   - Prevents race conditions and ensures consistency

4. **Migration Strategy:**
   - Create migration to initialize stats for all existing organizations
   - Run recalculation cron to populate initial counts
   - Switch queries to use stats table after migration

5. **Daily Recalculation:**
   - Critical for catching drift from bugs or edge cases
   - Runs once per day to recalculate from source data
   - Industry standard (Stripe, Shopify do this)
   - Ensures stats stay accurate even if mutations miss updates

6. **Controlled Denormalization:**
   - Denormalize immutable data (orderNumber, invoiceNumber)
   - Denormalize rarely-changing data (customerName)
   - Don't denormalize frequently-changing data (status)
   - Trade-off: Slightly higher write cost for massively lower read cost

7. **Monitoring:**
   - Check Convex dashboard regularly for new hotspots
   - Monitor `journal.read_set` size (target: Documents per page + 1)
   - Watch for excessive function executions (indicates missing dependencies)
   - Monitor read usage after each phase

### Files to Create/Modify

**New Files:**
- `convex/stats_helpers.ts` - Helper functions for updating stats
- `convex/stats.ts` - Recalculation logic and cron jobs
- `hooks/use-debounce.ts` - Debounce hook for search
- `convex/migrations/init_organization_stats.ts` - Migration script

**Files to Modify:**
- `convex/schema.ts` - Add `organizationStats` table
- `convex/loads.ts` - Update `countLoadsByStatus`, add stats updates to mutations
- `convex/invoices.ts` - Update `countInvoicesByStatus`, add stats updates to mutations
- `convex/crons.ts` - Add daily recalculation cron
- `components/loads-table.tsx` - Reduce page size, add pagination
- `app/(app)/invoices/_components/invoices-dashboard.tsx` - Reduce limits, add pagination
- `convex/analytics.ts` - Add limit to `getUnmappedLoadGroups`
- All mutation files (9 total) - Add stats update calls

---

## ✅ Ready for Implementation

This analysis is complete and ready to build an implementation plan. All issues have been:
- ✅ Identified with specific file locations
- ✅ Quantified with read impact calculations
- ✅ Prioritized by impact and effort
- ✅ Provided with implementation guidance using industry-standard patterns
- ✅ Organized into staged rollout phases
- ✅ Includes pro tips and best practices

## 🎯 Expected Final Results

**Before Optimization:**
- Loads Table Page: ~14,000 reads
- Invoices Page: ~12,000 reads
- **Total Daily: ~84GB reads**

**After All Phases:**
- Loads Table Page: ~51 reads (50 loads + 1 stats)
- Invoices Page: ~51 reads (50 invoices + 1 stats)
- **Total Daily: <2GB reads (98% reduction)**

**Conclusion:** By moving to Paginated Reads and Pre-computed Counts, you will likely see your 84GB read volume drop to less than 2GB per day for the same amount of user activity.

**Next Step:** Create detailed implementation tickets for Phase 1 (Emergency Fixes) to start immediately.

