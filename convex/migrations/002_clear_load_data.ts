import { mutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * Migration: Clear all load data from dev database
 * 
 * This prepares the database for the two-table architecture refactor.
 * Run with: npx convex run migrations/002_clear_load_data:clearLoadData '{"workosOrgId": "org_01KAEYJHZNV9KQCXF9FN9N3CCY"}'
 */
export const clearLoadData = mutation({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    console.log(`🧹 Clearing all load data for org: ${args.workosOrgId}`);
    
    // 1. Delete all loads
    const loads = await ctx.db
      .query("loadInformation")
      .filter((q) => q.eq(q.field("workosOrgId"), args.workosOrgId))
      .collect();
    
    for (const load of loads) {
      await ctx.db.delete(load._id);
    }
    console.log(`✅ Deleted ${loads.length} loads`);
    
    // 2. Delete all invoices
    const invoices = await ctx.db
      .query("loadInvoices")
      .filter((q) => q.eq(q.field("workosOrgId"), args.workosOrgId))
      .collect();
    
    for (const invoice of invoices) {
      // Delete line items first
      const lineItems = await ctx.db
        .query("invoiceLineItems")
        .withIndex("by_invoice", (q) => q.eq("invoiceId", invoice._id))
        .collect();
      
      for (const lineItem of lineItems) {
        await ctx.db.delete(lineItem._id);
      }
      
      // Then delete invoice
      await ctx.db.delete(invoice._id);
    }
    console.log(`✅ Deleted ${invoices.length} invoices`);
    
    return {
      success: true,
      deletedLoads: loads.length,
      deletedInvoices: invoices.length,
    };
  },
});
