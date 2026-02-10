import { v } from 'convex/values';
import { mutation, query, internalMutation, internalAction, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';
import {
  addDaysToUtcDateString,
  getUtcDateStringFromMs,
  isTimeOnOrAfterUtc,
} from './_helpers/cronUtils';

/**
 * Recurring Load Templates
 * Blueprints for automatically generating loads on a schedule
 */

// Stop template validator for recurring loads
const stopTemplateValidator = v.object({
  stopType: v.union(v.literal('PICKUP'), v.literal('DELIVERY')),
  address: v.string(),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  timeOfDay: v.string(), // "08:00" - fixed time (HH:MM)
  loadingType: v.optional(v.string()),
  commodityDescription: v.optional(v.string()),
  commodityUnits: v.optional(v.string()),
  pieces: v.optional(v.number()),
  weight: v.optional(v.number()),
  instructions: v.optional(v.string()),
});

// Template validator for returns
const templateValidator = v.object({
  _id: v.id('recurringLoadTemplates'),
  _creationTime: v.number(),
  workosOrgId: v.string(),
  routeAssignmentId: v.optional(v.id('routeAssignments')),
  // Direct assignment fields
  driverId: v.optional(v.id('drivers')),
  carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
  sourceLoadId: v.id('loadInformation'),
  name: v.string(),
  customerId: v.id('customers'),
  hcr: v.optional(v.string()),
  tripNumber: v.optional(v.string()),
  stops: v.array(stopTemplateValidator),
  equipmentType: v.optional(v.string()),
  weight: v.optional(v.number()),
  weightUnit: v.optional(v.string()),
  fleet: v.optional(v.string()),
  generalInstructions: v.optional(v.string()),
  activeDays: v.array(v.number()),
  excludeFederalHolidays: v.boolean(),
  customExclusions: v.array(v.string()),
  generationTime: v.string(),
  advanceDays: v.number(),
  deliveryDayOffset: v.number(),
  endDate: v.optional(v.string()),
  isActive: v.boolean(),
  lastGeneratedAt: v.optional(v.number()),
  lastGeneratedLoadId: v.optional(v.id('loadInformation')),
  createdBy: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

// List all recurring templates for an organization
export const list = query({
  args: {
    workosOrgId: v.string(),
    isActive: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      _id: v.id('recurringLoadTemplates'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      name: v.string(),
      hcr: v.optional(v.string()),
      tripNumber: v.optional(v.string()),
      customerId: v.id('customers'),
      customerName: v.optional(v.string()),
      activeDays: v.array(v.number()),
      isActive: v.boolean(),
      lastGeneratedAt: v.optional(v.number()),
      endDate: v.optional(v.string()),
      routeAssignmentId: v.optional(v.id('routeAssignments')),
      driverName: v.optional(v.string()),
      carrierName: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    let templates = await ctx.db
      .query('recurringLoadTemplates')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    if (args.isActive !== undefined) {
      templates = templates.filter((t) => t.isActive === args.isActive);
    }

    // Enrich with customer name and assignment info
    const enriched = await Promise.all(
      templates.map(async (template) => {
        const customer = await ctx.db.get(template.customerId);
        let driverName: string | undefined;
        let carrierName: string | undefined;

        // First check direct assignment on template
        if (template.driverId) {
          const driver = await ctx.db.get(template.driverId);
          if (driver) {
            driverName = `${driver.firstName} ${driver.lastName}`;
          }
        }
        if (template.carrierPartnershipId) {
          const carrier = await ctx.db.get(template.carrierPartnershipId);
          if (carrier) {
            carrierName = carrier.carrierName;
          }
        }

        // Fall back to route assignment if no direct assignment
        if (!driverName && !carrierName && template.routeAssignmentId) {
          const routeAssignment = await ctx.db.get(template.routeAssignmentId);
          if (routeAssignment?.driverId) {
            const driver = await ctx.db.get(routeAssignment.driverId);
            if (driver) {
              driverName = `${driver.firstName} ${driver.lastName}`;
            }
          }
          if (routeAssignment?.carrierPartnershipId) {
            const carrier = await ctx.db.get(routeAssignment.carrierPartnershipId);
            if (carrier) {
              carrierName = carrier.carrierName;
            }
          }
        }

        return {
          _id: template._id,
          _creationTime: template._creationTime,
          workosOrgId: template.workosOrgId,
          name: template.name,
          hcr: template.hcr,
          tripNumber: template.tripNumber,
          customerId: template.customerId,
          customerName: customer?.name,
          activeDays: template.activeDays,
          isActive: template.isActive,
          lastGeneratedAt: template.lastGeneratedAt,
          endDate: template.endDate,
          routeAssignmentId: template.routeAssignmentId,
          driverName,
          carrierName,
        };
      })
    );

    return enriched;
  },
});

// Get a single template by ID
export const get = query({
  args: {
    id: v.id('recurringLoadTemplates'),
  },
  returns: v.union(templateValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Create a recurring template from an existing load
export const createFromLoad = mutation({
  args: {
    sourceLoadId: v.id('loadInformation'),
    name: v.string(),
    activeDays: v.array(v.number()), // 0=Sun, 1=Mon, ... 6=Sat
    excludeFederalHolidays: v.boolean(),
    customExclusions: v.optional(v.array(v.string())),
    generationTime: v.string(), // "06:00"
    advanceDays: v.number(),
    deliveryDayOffset: v.number(),
    endDate: v.optional(v.string()),
    routeAssignmentId: v.optional(v.id('routeAssignments')),
    // Direct assignment (passed from create-load-form)
    driverId: v.optional(v.id('drivers')),
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
    createdBy: v.string(),
  },
  returns: v.id('recurringLoadTemplates'),
  handler: async (ctx, args) => {
    // 1. Get the source load
    const sourceLoad = await ctx.db.get(args.sourceLoadId);
    if (!sourceLoad) {
      throw new Error('Source load not found');
    }

    // 2. Get the stops for the source load
    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.sourceLoadId))
      .collect();

    if (stops.length === 0) {
      throw new Error('Source load has no stops');
    }

    // Sort stops by sequence
    const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    // 3. Extract time of day from each stop's windowBeginTime
    const stopTemplates = sortedStops.map((stop) => {
      // Extract HH:mm from the time string
      let timeOfDay = '08:00'; // Default
      if (stop.windowBeginTime) {
        // Handle both "HH:mm" and full ISO formats
        const timeMatch = stop.windowBeginTime.match(/(\d{2}):(\d{2})/);
        if (timeMatch) {
          timeOfDay = `${timeMatch[1]}:${timeMatch[2]}`;
        }
      }

      return {
        stopType: stop.stopType,
        address: stop.address,
        city: stop.city,
        state: stop.state,
        postalCode: stop.postalCode,
        timeOfDay,
        loadingType: stop.loadingType,
        commodityDescription: stop.commodityDescription,
        commodityUnits: stop.commodityUnits,
        pieces: stop.pieces,
        weight: stop.weight,
        instructions: stop.instructions,
      };
    });

    // 4. Determine HCR/Trip from route assignment if provided
    let hcr = sourceLoad.parsedHcr;
    let tripNumber = sourceLoad.parsedTripNumber;

    if (args.routeAssignmentId) {
      const routeAssignment = await ctx.db.get(args.routeAssignmentId);
      if (routeAssignment) {
        hcr = routeAssignment.hcr;
        tripNumber = routeAssignment.tripNumber;
      }
    }

    const now = Date.now();

    // 5. Create the template
    return await ctx.db.insert('recurringLoadTemplates', {
      workosOrgId: sourceLoad.workosOrgId,
      routeAssignmentId: args.routeAssignmentId,
      // Direct assignment for recurring loads
      driverId: args.driverId,
      carrierPartnershipId: args.carrierPartnershipId,
      sourceLoadId: args.sourceLoadId,
      name: args.name,
      customerId: sourceLoad.customerId,
      hcr,
      tripNumber,
      stops: stopTemplates,
      equipmentType: sourceLoad.equipmentType,
      weight: sourceLoad.weight,
      weightUnit: sourceLoad.units,
      fleet: sourceLoad.fleet,
      generalInstructions: sourceLoad.generalInstructions,
      activeDays: args.activeDays,
      excludeFederalHolidays: args.excludeFederalHolidays,
      customExclusions: args.customExclusions ?? [],
      generationTime: args.generationTime,
      advanceDays: args.advanceDays,
      deliveryDayOffset: args.deliveryDayOffset,
      endDate: args.endDate,
      isActive: true,
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Toggle template active status
export const toggleActive = mutation({
  args: {
    id: v.id('recurringLoadTemplates'),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const template = await ctx.db.get(args.id);
    if (!template) {
      throw new Error('Template not found');
    }

    const newStatus = !template.isActive;

    await ctx.db.patch(args.id, {
      isActive: newStatus,
      updatedAt: Date.now(),
    });

    return newStatus;
  },
});

// Delete a recurring template
export const remove = mutation({
  args: {
    id: v.id('recurringLoadTemplates'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const template = await ctx.db.get(args.id);
    if (!template) {
      throw new Error('Template not found');
    }

    await ctx.db.delete(args.id);

    return null;
  },
});

// Internal mutation to generate a load from a template
export const generateLoadFromTemplate = internalMutation({
  args: {
    templateId: v.id('recurringLoadTemplates'),
    targetDate: v.string(), // "2026-03-10" - the pickup date
  },
  returns: v.union(v.id('loadInformation'), v.null()),
  handler: async (ctx, args) => {
    // 1. Get the template
    const template = await ctx.db.get(args.templateId);
    if (!template || !template.isActive) {
      return null;
    }

    // 2. Get customer info
    const customer = await ctx.db.get(template.customerId);
    if (!customer) {
      console.error(`Customer ${template.customerId} not found for template ${template.name}`);
      return null;
    }

    const now = Date.now();
    const targetDateObj = new Date(args.targetDate);

    // Generate internal ID
    const dateStr = args.targetDate.replace(/-/g, '');
    const internalId = `REC-${dateStr}-${template._id.slice(-6)}`;

    // 3. Create the load
    const loadId = await ctx.db.insert('loadInformation', {
      workosOrgId: template.workosOrgId,
      createdBy: 'recurring-generator',
      internalId,
      orderNumber: internalId,
      status: 'Open',
      trackingStatus: 'Pending',
      parsedHcr: template.hcr,
      parsedTripNumber: template.tripNumber,
      customerId: template.customerId,
      customerName: customer.name,
      fleet: template.fleet ?? 'Default',
      equipmentType: template.equipmentType,
      weight: template.weight,
      units: (template.weightUnit as 'Pallets' | 'Boxes' | 'Pieces' | 'Lbs' | 'Kg') ?? 'Lbs',
      generalInstructions: template.generalInstructions,
      createdAt: now,
      updatedAt: now,
    });

    // 4. Create stops with date-adjusted times
    for (let i = 0; i < template.stops.length; i++) {
      const stop = template.stops[i];
      
      // Calculate the stop date based on deliveryDayOffset
      // Pickup stops use targetDate, delivery stops use targetDate + offset
      let stopDate = args.targetDate;
      if (stop.stopType === 'DELIVERY' && template.deliveryDayOffset > 0) {
        const deliveryDate = new Date(targetDateObj);
        deliveryDate.setDate(deliveryDate.getDate() + template.deliveryDayOffset);
        stopDate = deliveryDate.toISOString().split('T')[0];
      }

      await ctx.db.insert('loadStops', {
        workosOrgId: template.workosOrgId,
        createdBy: 'recurring-generator',
        loadId,
        internalId,
        sequenceNumber: i + 1,
        stopType: stop.stopType,
        loadingType: (stop.loadingType as 'APPT' | 'FCFS' | 'Live') ?? 'APPT',
        address: stop.address,
        city: stop.city,
        state: stop.state,
        postalCode: stop.postalCode,
        windowBeginDate: stopDate,
        windowBeginTime: stop.timeOfDay,
        windowEndDate: stopDate,
        windowEndTime: stop.timeOfDay,
        commodityDescription: stop.commodityDescription ?? 'General Freight',
        commodityUnits: (stop.commodityUnits as 'Pallets' | 'Boxes' | 'Pieces' | 'Lbs' | 'Kg') ?? 'Pallets',
        pieces: stop.pieces ?? 1,
        weight: stop.weight,
        instructions: stop.instructions,
        status: 'Pending',
        createdAt: now,
        updatedAt: now,
      });
    }

    // 5. Update organization stats
    const { updateLoadCount } = await import('./stats_helpers');
    await updateLoadCount(ctx, template.workosOrgId, undefined, 'Open');

    // 6. Update template with last generated info
    await ctx.db.patch(args.templateId, {
      lastGeneratedAt: now,
      lastGeneratedLoadId: loadId,
      updatedAt: now,
    });

    // 7. Sync firstStopDate
    const firstStop = await ctx.db
      .query('loadStops')
      .withIndex('by_sequence', (q) => q.eq('loadId', loadId).eq('sequenceNumber', 1))
      .first();
    
    if (firstStop) {
      await ctx.db.patch(loadId, {
        firstStopDate: firstStop.windowBeginDate,
      });
    }

    // 8. Trigger auto-assignment
    try {
      await ctx.runMutation(internal.autoAssignment.triggerAutoAssignmentForLoad, {
        loadId,
        workosOrgId: template.workosOrgId,
        userId: 'recurring-generator',
        userName: 'Recurring Load Generator',
      });
    } catch (error) {
      console.error('Auto-assignment failed for recurring load:', error);
    }

    return loadId;
  },
});

// Internal action to process all templates for a given date
export const processRecurringTemplates = internalAction({
  args: {
    workosOrgId: v.string(),
    targetDate: v.string(), // "2026-03-10"
  },
  handler: async (ctx, args): Promise<{
    processed: number;
    generated: number;
    skipped: number;
    errors: number;
  }> => {
    // 1. Get active templates for this org
    const templates = await ctx.runQuery(internal.recurringLoads.getActiveTemplates, {
      workosOrgId: args.workosOrgId,
    });

    const now = Date.now();
    const generationDate = args.targetDate;
    const holidayCache = new Map<string, boolean>();

    let generated = 0;
    let skipped = 0;
    let errors = 0;

    for (const template of templates) {
      try {
        if (!isTimeOnOrAfterUtc(now, template.generationTime)) {
          skipped++;
          continue;
        }

        const lastGeneratedDate =
          template.lastGeneratedAt != null
            ? getUtcDateStringFromMs(template.lastGeneratedAt)
            : null;

        if (lastGeneratedDate === generationDate) {
          skipped++;
          continue;
        }

        const pickupDate = addDaysToUtcDateString(generationDate, template.advanceDays);
        const dayOfWeek = new Date(`${pickupDate}T00:00:00.000Z`).getUTCDay();

        // Check if template has expired
        if (template.endDate && template.endDate < pickupDate) {
          skipped++;
          continue;
        }

        // Check if this day of week is active
        if (!template.activeDays.includes(dayOfWeek)) {
          skipped++;
          continue;
        }

        // Check federal holiday exclusion
        if (template.excludeFederalHolidays) {
          let isFederalHoliday = holidayCache.get(pickupDate);
          if (isFederalHoliday === undefined) {
            isFederalHoliday = await ctx.runQuery(internal.holidays.isFederalHoliday, {
              date: pickupDate,
            });
            holidayCache.set(pickupDate, isFederalHoliday);
          }

          if (isFederalHoliday) {
            skipped++;
            continue;
          }
        }

        // Check custom exclusions
        if (template.customExclusions.includes(pickupDate)) {
          skipped++;
          continue;
        }

        // Generate the load
        const loadId = await ctx.runMutation(internal.recurringLoads.generateLoadFromTemplate, {
          templateId: template._id,
          targetDate: pickupDate,
        });

        if (loadId) {
          generated++;
        } else {
          skipped++;
        }
      } catch (error) {
        console.error(`Error generating load from template ${template._id}:`, error);
        errors++;
      }
    }

    return {
      processed: templates.length,
      generated,
      skipped,
      errors,
    };
  },
});

// Internal query to get active templates
export const getActiveTemplates = internalQuery({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const templates = await ctx.db
      .query('recurringLoadTemplates')
      .withIndex('by_org_active', (q) => q.eq('workosOrgId', args.workosOrgId).eq('isActive', true))
      .collect();

    return templates.map((t) => ({
      _id: t._id,
      activeDays: t.activeDays,
      excludeFederalHolidays: t.excludeFederalHolidays,
      customExclusions: t.customExclusions,
      endDate: t.endDate,
      advanceDays: t.advanceDays,
      generationTime: t.generationTime,
      lastGeneratedAt: t.lastGeneratedAt,
    }));
  },
});
