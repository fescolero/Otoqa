# Phase 2: Complete Implementation Guide

## Summary
Phase 2 is implementing aggregate tables to reduce count queries from 10,000+ reads to 1 read (99% reduction).

---

## ✅ COMPLETED: Core Infrastructure (5/15 tasks)

### 1. Schema Updated ✅
**File:** `convex/schema.ts`
```typescript
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
  lastRecalculated: v.optional(v.number()),
  updatedAt: v.number(),
}).index('by_org', ['workosOrgId']),
```

### 2. Helper Functions Created ✅
**File:** `convex/stats_helpers.ts` (NEW)
- `updateLoadCount(ctx, orgId, oldStatus, newStatus, amount)`
- `updateInvoiceCount(ctx, orgId, oldStatus, newStatus, amount)`
- `decrementLoadCount(ctx, orgId, status, amount)`
- `decrementInvoiceCount(ctx, orgId, status, amount)`
- Internal: `getOrCreateStats(ctx, orgId)`

### 3. Count Queries Optimized ✅
**Files:** `convex/loads.ts`, `convex/invoices.ts`
- `countLoadsByStatus` - Now reads from stats (1 read vs 10,000+)
- `countInvoicesByStatus` - Now reads from stats (1 read vs 10,000+)

### 4. First Mutation Updated ✅
**File:** `convex/loads.ts:634`
```typescript
// Added at end of updateLoadStatus mutation:
const { updateLoadCount } = await import("./stats_helpers");
await updateLoadCount(ctx, load.workosOrgId, load.status, args.status);
```

---

## 🚧 REMAINING: Mutation Updates (10/15 tasks)

All remaining mutations need similar updates. Here's the complete guide:

### Pattern for All Mutations:

```typescript
// Step 1: Import at top of file (or use dynamic import in mutation)
import { updateLoadCount, updateInvoiceCount } from "./stats_helpers";

// Step 2: After db.insert() or db.patch() call:
await updateLoadCount(ctx, workosOrgId, oldStatus, newStatus);
// OR
await updateInvoiceCount(ctx, workosOrgId, oldStatus, newStatus);
```

---

## Detailed Mutation Updates Needed

### Load Mutations

#### 1. createLoad Helper (fourKitesSyncHelpers.ts:114)
```typescript
export const createLoad = internalMutation({
  args: { data: v.any() },
  handler: async (ctx, args) => {
    const loadId = await ctx.db.insert("loadInformation", args.data);
    
    // ✅ ADD THIS:
    const { updateLoadCount } = await import("./stats_helpers");
    await updateLoadCount(ctx, args.data.workosOrgId, undefined, args.data.status);
    
    return loadId;
  },
});
```

#### 2. importLoadFromShipment (fourKitesSyncHelpers.ts:182)
**Two load creation points in this function:**

**Point A (line 249):** CONTRACT/SPOT load creation
```typescript
const loadId = await ctx.db.insert("loadInformation", {
  workosOrgId,
  // ... other fields
  status: "Assigned",
  loadType: isWildcard ? "SPOT" : "CONTRACT",
  // ... more fields
});

// ✅ ADD THIS after insert:
const { updateLoadCount } = await import("./stats_helpers");
await updateLoadCount(ctx, workosOrgId, undefined, "Assigned");

// Then create invoice immediately:
const invoiceId = await ctx.db.insert("loadInvoices", {
  // ...
  status: isWildcard ? "MISSING_DATA" : "DRAFT",
});

// ✅ ADD THIS after invoice insert:
const { updateInvoiceCount } = await import("./stats_helpers");
await updateInvoiceCount(ctx, workosOrgId, undefined, isWildcard ? "MISSING_DATA" : "DRAFT");
```

**Point B (line 405):** UNMAPPED load creation
```typescript
const loadId = await ctx.db.insert("loadInformation", {
  workosOrgId,
  // ... other fields
  status: "Assigned",
  loadType: "UNMAPPED",
  // ... more fields
});

// ✅ ADD THIS after insert:
const { updateLoadCount } = await import("./stats_helpers");
await updateLoadCount(ctx, workosOrgId, undefined, "Assigned");

// Then create MISSING_DATA invoice:
const invoiceId = await ctx.db.insert("loadInvoices", {
  // ...
  status: "MISSING_DATA",
});

// ✅ ADD THIS after invoice insert:
const { updateInvoiceCount } = await import("./stats_helpers");
await updateInvoiceCount(ctx, workosOrgId, undefined, "MISSING_DATA");
```

#### 3. importUnmappedLoad (fourKitesSyncHelpers.ts:~370)
Similar to above - needs stats update after load and invoice creation.

---

### Lane/Promotion Mutations

#### 4. createLaneAndBackfill (convex/lanes.ts)
**When promoting UNMAPPED loads to DRAFT:**
```typescript
// After updating invoice status:
await ctx.db.patch(invoice._id, {
  status: 'DRAFT',
  // ... other updates
});

// ✅ ADD THIS:
const { updateInvoiceCount } = await import("./stats_helpers");
await updateInvoiceCount(ctx, invoice.workosOrgId, "MISSING_DATA", "DRAFT");
```

#### 5. checkAndPromoteLoad (convex/lazyLoadPromotion.ts)
**When promoting SPOT → CONTRACT:**
```typescript
// After updating load:
await ctx.db.patch(loadId, {
  loadType: 'CONTRACT',
  requiresManualReview: false,
  // ... other updates
});

// ✅ Note: loadType change doesn't affect status counts
// Only update if actual status changes (not shown in current code)
```

#### 6. periodicCleanup (convex/lazyLoadPromotion.ts)
Similar to checkAndPromoteLoad - update if status changes.

---

### Invoice Mutations

#### 7. createInvoice Helper (fourKitesSyncHelpers.ts:32)
```typescript
export const createInvoice = internalMutation({
  args: {
    loadId: v.id("loadInformation"),
    customerId: v.id("customers"),
    workosOrgId: v.string(),
    status: v.union(/* all statuses */),
    // ... other args
  },
  handler: async (ctx, args) => {
    const invoiceId = await ctx.db.insert("loadInvoices", {
      ...args,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    
    // ✅ ADD THIS:
    const { updateInvoiceCount } = await import("./stats_helpers");
    await updateInvoiceCount(ctx, args.workosOrgId, undefined, args.status);
    
    return invoiceId;
  },
});
```

#### 8. bulkUpdateStatus (convex/invoices.ts)
**File location:** Search for "bulkUpdateStatus"
```typescript
// Inside loop where invoices are updated:
for (const invoiceId of args.invoiceIds) {
  const invoice = await ctx.db.get(invoiceId);
  if (!invoice) continue;
  
  const oldStatus = invoice.status;
  
  await ctx.db.patch(invoiceId, {
    status: args.newStatus,
    updatedAt: Date.now(),
  });
  
  // ✅ ADD THIS:
  const { updateInvoiceCount } = await import("./stats_helpers");
  await updateInvoiceCount(ctx, invoice.workosOrgId, oldStatus, args.newStatus);
}
```

#### 9. bulkVoidInvoices (convex/invoices.ts)
**File location:** Search for "bulkVoidInvoices"
```typescript
// Inside loop where invoices are voided:
for (const invoiceId of args.invoiceIds) {
  const invoice = await ctx.db.get(invoiceId);
  if (!invoice) continue;
  
  const oldStatus = invoice.status;
  
  await ctx.db.patch(invoiceId, {
    status: 'VOID',
    // ... other updates
  });
  
  // ✅ ADD THIS:
  const { updateInvoiceCount } = await import("./stats_helpers");
  await updateInvoiceCount(ctx, invoice.workosOrgId, oldStatus, "VOID");
}
```

---

## 🔄 Recalculation Logic & Cron Job

### Create convex/stats.ts

```typescript
import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Recalculate organization stats from source data
 * Run this daily to catch any drift from bugs or edge cases
 */
export const recalculateOrgStats = internalMutation({
  args: {
    workosOrgId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Count loads by status
    const allLoads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    const loadCounts = {
      Open: allLoads.filter(l => l.status === "Open").length,
      Assigned: allLoads.filter(l => l.status === "Assigned").length,
      Completed: allLoads.filter(l => l.status === "Completed").length,
      Canceled: allLoads.filter(l => l.status === "Canceled").length,
    };

    // Count invoices by status
    const allInvoices = await ctx.db
      .query("loadInvoices")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    const invoiceCounts = {
      MISSING_DATA: allInvoices.filter(i => i.status === "MISSING_DATA").length,
      DRAFT: allInvoices.filter(i => i.status === "DRAFT").length,
      BILLED: allInvoices.filter(i => i.status === "BILLED").length,
      PENDING_PAYMENT: allInvoices.filter(i => i.status === "PENDING_PAYMENT").length,
      PAID: allInvoices.filter(i => i.status === "PAID").length,
      VOID: allInvoices.filter(i => i.status === "VOID").length,
    };

    // Update or create stats
    const existingStats = await ctx.db
      .query("organizationStats")
      .withIndex("by_org", (q) => q.eq("workosOrgId", args.workosOrgId))
      .first();

    if (existingStats) {
      await ctx.db.patch(existingStats._id, {
        loadCounts,
        invoiceCounts,
        lastRecalculated: Date.now(),
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("organizationStats", {
        workosOrgId: args.workosOrgId,
        loadCounts,
        invoiceCounts,
        lastRecalculated: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

/**
 * Recalculate stats for all organizations
 * Called by cron job daily
 */
export const recalculateAllOrgs = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx, args) => {
    const orgs = await ctx.db.query("organizations").collect();
    
    for (const org of orgs) {
      await ctx.runMutation(internal.stats.recalculateOrgStats, {
        workosOrgId: org.workosOrgId,
      });
    }
    
    console.log(`Recalculated stats for ${orgs.length} organizations`);
    return null;
  },
});
```

### Update convex/crons.ts

```typescript
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Existing crons...

// ✅ ADD THIS: Daily stats recalculation (drift protection)
crons.interval(
  "recalculate-org-stats",
  { hours: 24 }, // Run once per day
  internal.stats.recalculateAllOrgs,
  {}
);

export default crons;
```

---

## 📝 Migration Script

### Create convex/migrations/initializeOrgStats.ts

```typescript
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

/**
 * Initialize organizationStats for all existing organizations
 * Run this once after deploying Phase 2
 */
export const initialize = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx, args) => {
    const orgs = await ctx.db.query("organizations").collect();
    
    console.log(`Initializing stats for ${orgs.length} organizations...`);
    
    for (const org of orgs) {
      // Recalculate from source data
      await ctx.runMutation(internal.stats.recalculateOrgStats, {
        workosOrgId: org.workosOrgId,
      });
    }
    
    console.log("✅ Stats initialization complete");
    return null;
  },
});
```

**To run migration:**
1. Deploy Phase 2 code
2. Open Convex dashboard
3. Go to Functions
4. Run `internal.migrations.initializeOrgStats.initialize({})`

---

## 🎯 Testing Checklist

After completing all updates:

1. ✅ Deploy all changes
2. ✅ Run migration to initialize stats
3. ✅ Test count queries return correct values
4. ✅ Create new load - verify stats increment
5. ✅ Change load status - verify stats update
6. ✅ Create new invoice - verify stats increment
7. ✅ Change invoice status - verify stats update
8. ✅ Check Convex dashboard - should see 1 read for count queries
9. ✅ Monitor for 24 hours - ensure cron runs successfully
10. ✅ Compare stats to actual counts - ensure no drift

---

## 📊 Expected Results

**Before Phase 2:**
- Count queries: 10,000+ reads each
- Called on every page load
- Total: ~10GB daily (after Phase 1)

**After Phase 2:**
- Count queries: 1 read each (99% reduction)
- Mutations: +1 write per status change (negligible cost)
- Total: ~2GB daily (80% additional reduction)

**Overall Improvement:** 98% reduction from original 84GB

---

## 🚀 Deployment Order

1. Deploy schema update + helpers + updated queries
2. Run migration to initialize stats
3. Deploy mutation updates (can be done gradually)
4. Enable cron job
5. Monitor for accuracy

---

## Status: 5/15 Complete

**Core infrastructure is ready.** Remaining work is adding stats update calls to mutations.

This is straightforward but requires careful attention to ensure all mutation points are covered.

