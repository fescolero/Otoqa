# Phase 2: Aggregate Tables - Implementation Progress

## ✅ Completed Tasks

### 1. Schema Update
**File:** `convex/schema.ts`
- ✅ Added `organizationStats` table with load and invoice counts
- ✅ Added index `by_org` on `workosOrgId`
- ✅ Included drift detection field (`lastRecalculated`)

### 2. Helper Functions
**File:** `convex/stats_helpers.ts` (NEW)
- ✅ Created `updateLoadCount()` - Updates load stats when status changes
- ✅ Created `updateInvoiceCount()` - Updates invoice stats when status changes
- ✅ Created `decrementLoadCount()` - For deletions
- ✅ Created `decrementInvoiceCount()` - For deletions
- ✅ Created internal `getOrCreateStats()` - Auto-creates stats if missing

### 3. Count Queries Optimized
**File:** `convex/loads.ts`
- ✅ Updated `countLoadsByStatus` to read from stats (1 read instead of 10,000+)
- ✅ Added graceful fallback if stats don't exist

**File:** `convex/invoices.ts`
- ✅ Updated `countInvoicesByStatus` to read from stats (1 read instead of 10,000+)
- ✅ Returns all invoice status counts
- ✅ Added graceful fallback if stats don't exist

### 4. Mutations Updated to Maintain Stats

#### ✅ updateLoadStatus
**File:** `convex/loads.ts:634`
- ✅ Added stats update call after status change
- ✅ Properly handles old status → new status transition

---

## 🚧 Remaining Mutations to Update

All remaining mutations need to call the appropriate stats helper functions. Here's the complete list:

### Load Mutations

#### 1. createLoad (if exists)
**Action:** Search for load creation and add:
```typescript
await updateLoadCount(ctx, workosOrgId, undefined, "Open", 1);
```

#### 2. deleteLoad (if exists)
**Action:** Add decrement call:
```typescript
await decrementLoadCount(ctx, load.workosOrgId, load.status, 1);
```

#### 3. importLoadFromShipment
**File:** `convex/fourKitesSyncHelpers.ts`
**Action:** Add stats update when creating loads

#### 4. createLaneAndBackfill
**File:** `convex/lanes.ts`
**Action:** Add stats update when promoting UNMAPPED loads

#### 5. checkAndPromoteLoad & periodicCleanup
**File:** `convex/lazyLoadPromotion.ts`
**Action:** Add stats update when promoting loads

### Invoice Mutations

#### 6. createInvoice
**File:** `convex/fourKitesSyncHelpers.ts`
**Action:** Add stats update when creating invoices

#### 7. bulkUpdateStatus
**File:** `convex/invoices.ts`
**Action:** Add stats update for each invoice status change

#### 8. bulkVoidInvoices
**File:** `convex/invoices.ts`
**Action:** Add stats update for each invoice voided

---

## 📋 Remaining Implementation Tasks

### Critical Tasks
1. ⏳ Update remaining 8 mutations to maintain stats
2. ⏳ Create `convex/stats.ts` with recalculation logic
3. ⏳ Create migration script to initialize stats for existing orgs
4. ⏳ Add daily recalculation cron job

### Implementation Pattern

For all mutations, use this pattern:

```typescript
// At the top of the file
import { updateLoadCount, updateInvoiceCount } from "./stats_helpers";

// In mutation handler, after the actual data change:
// For load creation:
await updateLoadCount(ctx, workosOrgId, undefined, "Open");

// For load status change:
await updateLoadCount(ctx, workosOrgId, oldStatus, newStatus);

// For invoice creation:
await updateInvoiceCount(ctx, workosOrgId, undefined, "DRAFT");

// For invoice status change:
await updateInvoiceCount(ctx, workosOrgId, oldStatus, newStatus);
```

---

## 📊 Expected Results After Phase 2

### Before Phase 2:
- Count queries: 10,000+ reads each
- Total daily: ~10GB (after Phase 1)

### After Phase 2:
- Count queries: 1 read each (99% reduction)
- Total daily: ~2GB (80% additional reduction from Phase 1)
- **Overall improvement: 98% reduction from original 84GB**

---

## 🔄 Migration Strategy

1. **Deploy Phase 2 code** (stats table, helpers, updated queries)
2. **Run migration** to initialize stats for all existing organizations
3. **Monitor** stats accuracy via Convex dashboard
4. **Enable cron job** for daily recalculation (drift protection)

---

## Status: In Progress

**Next Steps:**
1. Continue updating remaining mutations
2. Create recalculation logic
3. Create migration script
4. Test and deploy

