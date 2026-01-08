# `.first()` vs `.unique()` - Which to Use for organizationStats

## The Difference

### `.unique()`
- **Returns:** Single document
- **If 0 documents:** Throws error
- **If 1 document:** Returns it
- **If 2+ documents:** Throws error
- **Use case:** When you expect exactly one document and want to fail fast if that's not true

### `.first()`
- **Returns:** First document or `null`
- **If 0 documents:** Returns `null`
- **If 1 document:** Returns it
- **If 2+ documents:** Returns the first one (silently ignores duplicates)
- **Use case:** When document might not exist yet, or you want graceful handling

## For organizationStats: Use `.first()`

### Why `.first()` is Better Here

1. **Initial State Handling**
   - Stats might not exist yet (before migration or first mutation)
   - `.first()` returns `null` → we can create stats
   - `.unique()` throws error → breaks the flow

2. **Graceful Degradation in Queries**
   - If stats don't exist, return zeros (better UX than error)
   - Users can still see the page, just with zero counts

3. **Migration Safety**
   - During rollout, some orgs might not have stats yet
   - `.first()` handles this gracefully
   - `.unique()` would cause errors

4. **Data Integrity (Trade-off)**
   - `.unique()` would catch duplicate stats (data corruption)
   - `.first()` silently uses first one
   - **But:** You can add explicit checks if needed

## Recommended Pattern

### In Mutations/Helpers (Updating Stats)
```typescript
// ✅ Use .first() - stats might not exist yet
let stats = await ctx.db
  .query("organizationStats")
  .withIndex("by_org", (q) => q.eq("workosOrgId", orgId))
  .first();

if (!stats) {
  // Create initial stats
  const statsId = await ctx.db.insert("organizationStats", {
    workosOrgId: orgId,
    loadCounts: { Open: 0, Assigned: 0, Completed: 0, Canceled: 0 },
    invoiceCounts: { MISSING_DATA: 0, DRAFT: 0, BILLED: 0, PENDING_PAYMENT: 0, PAID: 0, VOID: 0 },
    updatedAt: Date.now(),
  });
  stats = await ctx.db.get(statsId);
}
// Now update stats...
```

### In Queries (Reading Stats)
```typescript
// ✅ Use .first() - return zeros if stats don't exist yet
export const countLoadsByStatus = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    const stats = await ctx.db
      .query("organizationStats")
      .withIndex("by_org", (q) => q.eq("workosOrgId", args.workosOrgId))
      .first(); // ✅ Returns null if doesn't exist

    if (!stats) {
      // Graceful fallback - return zeros
      return {
        Open: 0,
        Assigned: 0,
        Delivered: 0, // Maps to Completed
        Canceled: 0,
      };
    }

    return {
      Open: stats.loadCounts.Open,
      Assigned: stats.loadCounts.Assigned,
      Delivered: stats.loadCounts.Completed,
      Canceled: stats.loadCounts.Canceled,
    };
  },
});
```

## When to Use `.unique()`

Use `.unique()` when:
- Document **must** exist (data integrity critical)
- You want to **fail fast** if duplicates exist
- Missing document is a **programming error**, not expected state

Example:
```typescript
// ✅ Good use of .unique() - organization MUST exist
const org = await ctx.db
  .query("organizations")
  .withIndex("by_organization", (q) => q.eq("workosOrgId", workosOrgId))
  .unique(); // Throws if org doesn't exist (data corruption)
```

## Optional: Add Explicit Duplicate Check

If you want to catch duplicates while still using `.first()`:

```typescript
const stats = await ctx.db
  .query("organizationStats")
  .withIndex("by_org", (q) => q.eq("workosOrgId", orgId))
  .first();

// Optional: Check for duplicates
if (stats) {
  const allStats = await ctx.db
    .query("organizationStats")
    .withIndex("by_org", (q) => q.eq("workosOrgId", orgId))
    .collect();
  
  if (allStats.length > 1) {
    console.error(`Duplicate stats found for org ${orgId}! Using first one.`);
    // Could also clean up duplicates here
  }
}
```

## Final Recommendation

**Use `.first()` everywhere for organizationStats:**
- ✅ Handles initial state (stats don't exist yet)
- ✅ Graceful degradation in queries
- ✅ Migration-safe
- ✅ Better UX (no errors for missing stats)

**Use `.unique()` for:**
- Core entities that must exist (organizations, users)
- When missing = programming error
- When duplicates = data corruption that should fail fast

