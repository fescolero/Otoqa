import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { Id } from './_generated/dataModel';

// Count customers by status
export const countCustomersByStatus = query({
  args: {},
  handler: async (ctx) => {
    const customers = await ctx.db.query('customers').collect();

    const counts = {
      all: 0,
      active: 0,
      inactive: 0,
      prospect: 0,
      deleted: 0,
    };

    for (const customer of customers) {
      if (customer.isDeleted) {
        counts.deleted++;
      } else {
        counts.all++;
        if (customer.status === 'Active') counts.active++;
        if (customer.status === 'Inactive') counts.inactive++;
        if (customer.status === 'Prospect') counts.prospect++;
      }
    }

    return counts;
  },
});

// List all customers for an organization
export const list = query({
  args: {
    workosOrgId: v.optional(v.string()),
    includeDeleted: v.optional(v.boolean()),
    status: v.optional(v.union(v.literal('Active'), v.literal('Inactive'), v.literal('Prospect'))),
    searchQuery: v.optional(v.string()),
    companyType: v.optional(v.union(v.literal('Shipper'), v.literal('Broker'), v.literal('Manufacturer'), v.literal('Distributor'))),
    state: v.optional(v.string()),
    loadingType: v.optional(v.union(v.literal('Live Load'), v.literal('Drop & Hook'), v.literal('Appointment'))),
  },
  handler: async (ctx, args) => {
    let customers = await ctx.db.query('customers').collect();

    // Filter by organization if provided
    if (args.workosOrgId) {
      customers = customers.filter((c) => c.workosOrgId === args.workosOrgId);
    }

    // Filter out deleted customers unless explicitly requested
    if (args.includeDeleted) {
      customers = customers.filter((c) => c.isDeleted === true);
    } else {
      customers = customers.filter((c) => !c.isDeleted);
    }

    // Filter by status
    if (args.status) {
      customers = customers.filter((c) => c.status === args.status);
    }

    // Filter by company type
    if (args.companyType) {
      customers = customers.filter((c) => c.companyType === args.companyType);
    }

    // Filter by state
    if (args.state) {
      customers = customers.filter((c) => c.state === args.state);
    }

    // Filter by loading type
    if (args.loadingType) {
      customers = customers.filter((c) => c.loadingType === args.loadingType);
    }

    // Search filter
    if (args.searchQuery) {
      const query = args.searchQuery.toLowerCase();
      customers = customers.filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          (c.city?.toLowerCase().includes(query) || false) ||
          (c.primaryContactName?.toLowerCase().includes(query) || false) ||
          (c.primaryContactEmail?.toLowerCase().includes(query) || false)
      );
    }

    return customers;
  },
});

// Alias for convenience
export const getCustomers = list;

// Get a single customer by ID
export const get = query({
  args: {
    id: v.id('customers'),
  },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.id);
    return customer;
  },
});

// Alias for invoice preview (accepts customerId instead of id)
export const getById = query({
  args: {
    customerId: v.id('customers'),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.customerId);
  },
});

// Create a new customer
export const create = mutation({
  args: {
    // Customer Information
    name: v.string(),
    companyType: v.union(v.literal('Shipper'), v.literal('Broker'), v.literal('Manufacturer'), v.literal('Distributor')),
    status: v.union(v.literal('Active'), v.literal('Inactive'), v.literal('Prospect')),
    office: v.optional(v.string()),
    
    // Address
    addressLine1: v.string(),
    addressLine2: v.optional(v.string()),
    city: v.string(),
    state: v.string(),
    zip: v.string(),
    country: v.string(),
    
    // Primary Contact
    primaryContactName: v.optional(v.string()),
    primaryContactTitle: v.optional(v.string()),
    primaryContactEmail: v.optional(v.string()),
    primaryContactPhone: v.optional(v.string()),
    
    // Secondary Contact
    secondaryContactName: v.optional(v.string()),
    secondaryContactEmail: v.optional(v.string()),
    secondaryContactPhone: v.optional(v.string()),
    
    // Operations
    loadingType: v.optional(v.union(v.literal('Live Load'), v.literal('Drop & Hook'), v.literal('Appointment'))),
    locationScheduleType: v.optional(v.union(v.literal('24/7'), v.literal('Business Hours'), v.literal('Appointment Only'), v.literal('Specific Hours'))),
    instructions: v.optional(v.string()),
    
    // Internal
    internalNotes: v.optional(v.string()),
    
    // WorkOS Integration
    workosOrgId: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const customerId = await ctx.db.insert('customers', {
      // Customer Information
      name: args.name,
      companyType: args.companyType,
      status: args.status,
      office: args.office,
      
      // Address
      addressLine1: args.addressLine1,
      addressLine2: args.addressLine2,
      city: args.city,
      state: args.state,
      zip: args.zip,
      country: args.country,
      
      // Primary Contact
      primaryContactName: args.primaryContactName,
      primaryContactTitle: args.primaryContactTitle,
      primaryContactEmail: args.primaryContactEmail,
      primaryContactPhone: args.primaryContactPhone,
      
      // Secondary Contact
      secondaryContactName: args.secondaryContactName,
      secondaryContactEmail: args.secondaryContactEmail,
      secondaryContactPhone: args.secondaryContactPhone,
      
      // Operations
      loadingType: args.loadingType,
      locationScheduleType: args.locationScheduleType,
      instructions: args.instructions,
      
      // Internal
      internalNotes: args.internalNotes,
      
      // WorkOS Integration
      workosOrgId: args.workosOrgId,
      createdBy: args.createdBy,
      
      // Timestamps
      createdAt: now,
      updatedAt: now,
      
      // Soft Delete
      isDeleted: false,
    });

    return customerId;
  },
});

// Update an existing customer
export const update = mutation({
  args: {
    id: v.id('customers'),
    
    // Customer Information
    name: v.optional(v.string()),
    companyType: v.optional(v.union(v.literal('Shipper'), v.literal('Broker'), v.literal('Manufacturer'), v.literal('Distributor'))),
    status: v.optional(v.union(v.literal('Active'), v.literal('Inactive'), v.literal('Prospect'))),
    office: v.optional(v.string()),
    
    // Address
    addressLine1: v.optional(v.string()),
    addressLine2: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    country: v.optional(v.string()),
    
    // Primary Contact
    primaryContactName: v.optional(v.string()),
    primaryContactTitle: v.optional(v.string()),
    primaryContactEmail: v.optional(v.string()),
    primaryContactPhone: v.optional(v.string()),
    
    // Secondary Contact
    secondaryContactName: v.optional(v.string()),
    secondaryContactEmail: v.optional(v.string()),
    secondaryContactPhone: v.optional(v.string()),
    
    // Operations
    loadingType: v.optional(v.union(v.literal('Live Load'), v.literal('Drop & Hook'), v.literal('Appointment'))),
    locationScheduleType: v.optional(v.union(v.literal('24/7'), v.literal('Business Hours'), v.literal('Appointment Only'), v.literal('Specific Hours'))),
    instructions: v.optional(v.string()),
    
    // Internal
    internalNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    
    await ctx.db.patch(id, {
      ...updates,
      updatedAt: Date.now(),
    });

    return id;
  },
});

// Soft delete a customer
export const deactivate = mutation({
  args: {
    id: v.id('customers'),
    userId: v.string(),
    userName: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: args.userId,
      updatedAt: Date.now(),
    });

    return args.id;
  },
});

// Restore a soft-deleted customer
export const restore = mutation({
  args: {
    id: v.id('customers'),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      isDeleted: false,
      deletedAt: undefined,
      deletedBy: undefined,
      updatedAt: Date.now(),
    });

    return args.id;
  },
});

// Permanently delete a customer (hard delete)
export const permanentDelete = mutation({
  args: {
    id: v.id('customers'),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// Bulk deactivate multiple customers
export const bulkDeactivate = mutation({
  args: {
    customerIds: v.array(v.id('customers')),
    userId: v.string(),
    userName: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    
    for (const customerId of args.customerIds) {
      await ctx.db.patch(customerId, {
        isDeleted: true,
        deletedAt: now,
        deletedBy: args.userId,
        updatedAt: now,
      });
    }

    return args.customerIds;
  },
});
