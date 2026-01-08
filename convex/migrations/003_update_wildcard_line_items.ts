import { internalMutation } from "../_generated/server";

/**
 * Migration: Update wildcard/spot invoice line items
 * 
 * Changes:
 * 1. Remove "Freight:" prefix from all freight line item descriptions
 * 2. For SPOT loads, replace contract name with HCR - TRIP format
 * 
 * Run with: npx convex run migrations/003_update_wildcard_line_items:updateWildcardLineItems
 */

export const updateWildcardLineItems = internalMutation({
  args: {},
  handler: async (ctx) => {
    console.log("Starting migration: Update wildcard line items...");
    
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Get all invoices
    const allInvoices = await ctx.db.query("loadInvoices").collect();
    
    for (const invoice of allInvoices) {
      try {
        // Get the load to check if it's SPOT
        const load = await ctx.db.get(invoice.loadId);
        if (!load) {
          skippedCount++;
          continue;
        }

        const isSpot = load.loadType === "SPOT";

        // Get all line items for this invoice
        const lineItems = await ctx.db
          .query("invoiceLineItems")
          .withIndex("by_invoice", (q) => q.eq("invoiceId", invoice._id))
          .collect();

        for (const lineItem of lineItems) {
          // Only update FREIGHT line items
          if (lineItem.type !== "FREIGHT") {
            continue;
          }

          let newDescription = lineItem.description;
          let needsUpdate = false;

          // Step 1: Remove "Freight:" prefix if it exists
          if (newDescription.startsWith("Freight: ")) {
            newDescription = newDescription.replace(/^Freight: /, "");
            needsUpdate = true;
          }

          // Step 2: For SPOT loads, replace contract name with HCR - TRIP
          if (isSpot) {
            // Check if description contains "Wildcard" or looks like a contract name
            // (doesn't already have HCR - TRIP format)
            const hasHcrTripFormat = /\w+\s*-\s*\w+/.test(newDescription);
            
            if (!hasHcrTripFormat && (newDescription.includes("Wildcard") || newDescription.length < 50)) {
              // Replace with HCR - TRIP format
              const hcr = load.parsedHcr || "Unknown HCR";
              const trip = load.parsedTripNumber || "Unknown TRIP";
              newDescription = `${hcr} - ${trip}`;
              needsUpdate = true;
            }
          }

          // Update if changes were made
          if (needsUpdate) {
            await ctx.db.patch(lineItem._id, {
              description: newDescription,
            });
            updatedCount++;
            console.log(`Updated line item ${lineItem._id}: "${lineItem.description}" -> "${newDescription}"`);
          } else {
            skippedCount++;
          }
        }
      } catch (error) {
        errorCount++;
        console.error(`Error processing invoice ${invoice._id}:`, error);
      }
    }

    const summary = {
      totalInvoices: allInvoices.length,
      lineItemsUpdated: updatedCount,
      lineItemsSkipped: skippedCount,
      errors: errorCount,
    };

    console.log("Migration complete:", summary);
    return summary;
  },
});

/**
 * Dry run version - see what would be changed without actually updating
 */
export const previewWildcardLineItems = internalMutation({
  args: {},
  handler: async (ctx) => {
    console.log("Preview mode: Checking what would be updated...");
    
    const changes: Array<{
      invoiceId: string;
      lineItemId: string;
      loadType: string;
      currentDescription: string;
      newDescription: string;
    }> = [];

    const allInvoices = await ctx.db.query("loadInvoices").collect();
    
    for (const invoice of allInvoices) {
      try {
        const load = await ctx.db.get(invoice.loadId);
        if (!load) continue;

        const isSpot = load.loadType === "SPOT";

        const lineItems = await ctx.db
          .query("invoiceLineItems")
          .withIndex("by_invoice", (q) => q.eq("invoiceId", invoice._id))
          .collect();

        for (const lineItem of lineItems) {
          if (lineItem.type !== "FREIGHT") continue;

          let newDescription = lineItem.description;
          let needsUpdate = false;

          if (newDescription.startsWith("Freight: ")) {
            newDescription = newDescription.replace(/^Freight: /, "");
            needsUpdate = true;
          }

          if (isSpot) {
            const hasHcrTripFormat = /\w+\s*-\s*\w+/.test(newDescription);
            
            if (!hasHcrTripFormat && (newDescription.includes("Wildcard") || newDescription.length < 50)) {
              const hcr = load.parsedHcr || "Unknown HCR";
              const trip = load.parsedTripNumber || "Unknown TRIP";
              newDescription = `${hcr} - ${trip}`;
              needsUpdate = true;
            }
          }

          if (needsUpdate) {
            changes.push({
              invoiceId: invoice._id,
              lineItemId: lineItem._id,
              loadType: load.loadType || "UNKNOWN",
              currentDescription: lineItem.description,
              newDescription,
            });
          }
        }
      } catch (error) {
        console.error(`Error processing invoice ${invoice._id}:`, error);
      }
    }

    console.log(`Found ${changes.length} line items that would be updated`);
    console.log("Sample changes:", changes.slice(0, 10));
    
    return {
      totalChanges: changes.length,
      sampleChanges: changes.slice(0, 10),
    };
  },
});
