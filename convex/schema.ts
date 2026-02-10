import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // Organization settings for multi-tenant configuration
  // Unified for both Brokers and Carriers (distinguished by orgType)
  organizations: defineTable({
    // Auth provider linking
    workosOrgId: v.optional(v.string()), // For web TMS access (brokers, upgraded carriers)
    clerkOrgId: v.optional(v.string()), // For mobile access (carriers)

    // Organization type - determines capabilities
    // Optional for backward compatibility - defaults to BROKER for existing orgs with workosOrgId
    orgType: v.optional(v.union(
      v.literal('BROKER'), // Web TMS only (WorkOS)
      v.literal('CARRIER'), // Mobile only (Clerk)
      v.literal('BROKER_CARRIER') // Both (upgraded carrier)
    )),

    name: v.string(),
    industry: v.optional(v.string()),
    domain: v.optional(v.string()),
    logoStorageId: v.optional(v.id('_storage')), // Company Logo from Convex Storage

    // Billing Information
    billingEmail: v.string(),
    billingPhone: v.optional(v.string()),
    billingAddress: v.object({
      addressLine1: v.string(),
      addressLine2: v.optional(v.string()),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
      country: v.string(),
    }),

    // Subscription info (per UI)
    subscriptionPlan: v.string(), // e.g. "Enterprise"
    subscriptionStatus: v.string(), // e.g. "Active"
    billingCycle: v.string(), // e.g. "Annual"
    nextBillingDate: v.optional(v.string()),

    // Default timezone for payroll calculations
    // IANA format: "America/New_York", "America/Los_Angeles", etc.
    defaultTimezone: v.optional(v.string()),

    // === CARRIER-SPECIFIC FIELDS ===
    // Only populated when orgType = CARRIER or BROKER_CARRIER
    mcNumber: v.optional(v.string()), // MC-123456
    usdotNumber: v.optional(v.string()), // DOT number
    operatingAuthorityActive: v.optional(v.boolean()),
    safetyRating: v.optional(v.string()), // Satisfactory, Conditional, Unsatisfactory, Not Rated

    // Insurance (non-sensitive - provider/expiration)
    insuranceProvider: v.optional(v.string()),
    insuranceCoverage: v.optional(v.boolean()),
    insuranceExpiration: v.optional(v.string()), // YYYY-MM-DD format

    // Upgrade tracking (CARRIER -> BROKER_CARRIER)
    upgradedAt: v.optional(v.number()),
    upgradedBy: v.optional(v.string()),

    // === OWNER-OPERATOR FIELDS ===
    // Only relevant when orgType = CARRIER or BROKER_CARRIER
    // Distinguishes single-driver owner-operators from fleet carriers
    isOwnerOperator: v.optional(v.boolean()), // True if owner is also the primary driver
    ownerDriverId: v.optional(v.id('drivers')), // Link to the owner's driver record

    createdAt: v.number(),
    updatedAt: v.number(),

    // === SOFT DELETE ===
    // Allows graceful deactivation without losing historical data
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()), // User ID who performed deletion
    deletionReason: v.optional(v.string()), // Why org was deleted/deactivated
  })
    .index('by_organization', ['workosOrgId'])
    .index('by_clerk_org', ['clerkOrgId'])
    .index('by_mc', ['mcNumber'])
    .index('by_type', ['orgType'])
    .index('by_deleted', ['isDeleted']),

  // Sensitive organization data (separate table for security)
  // Following pattern of drivers_sensitive_info
  organizations_sensitive: defineTable({
    // Reference to organization
    organizationId: v.id('organizations'),

    // === TAX & LEGAL ===
    ein: v.optional(v.string()), // Federal Tax ID
    stateRegistrationNumber: v.optional(v.string()),

    // === BANKING (for receiving payments) ===
    bankName: v.optional(v.string()),
    bankAccountType: v.optional(
      v.union(v.literal('CHECKING'), v.literal('SAVINGS'))
    ),
    bankRoutingNumber: v.optional(v.string()), // Should be encrypted
    bankAccountNumber: v.optional(v.string()), // Should be encrypted
    bankAccountVerified: v.optional(v.boolean()),

    // === INSURANCE DETAILS ===
    insurancePolicyNumber: v.optional(v.string()),
    insuranceCertificateStorageId: v.optional(v.id('_storage')),
    cargoInsuranceAmount: v.optional(v.number()),
    liabilityInsuranceAmount: v.optional(v.number()),
    autoInsuranceAmount: v.optional(v.number()),

    // === PLATFORM BILLING (Future - Otoqa billing) ===
    stripeCustomerId: v.optional(v.string()), // For platform subscriptions
    stripeSubscriptionId: v.optional(v.string()),
    platformBillingEmail: v.optional(v.string()),

    // === PAYMENT PREFERENCES ===
    preferredPaymentMethod: v.optional(
      v.union(
        v.literal('ACH'),
        v.literal('CHECK'),
        v.literal('WIRE'),
        v.literal('QUICKPAY')
      )
    ),
    paymentTerms: v.optional(v.string()), // Net15, Net30, etc.
    factoringCompany: v.optional(v.string()), // If they use factoring
    factoringStatus: v.optional(v.boolean()),
    remitToAddress: v.optional(v.string()), // Where to send checks

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_org', ['organizationId'])
    .index('by_stripe', ['stripeCustomerId']),

  // ==========================================
  // CARRIER MARKETPLACE
  // ==========================================

  // Broker-Carrier partnerships
  // Links broker organizations to carrier organizations
  // carrierOrgId is OPTIONAL - allows storing carrier info without carrier having an account
  carrierPartnerships: defineTable({
    // The broker who added this carrier
    brokerOrgId: v.string(), // Broker's org ID (workosOrgId)

    // The carrier's organization (OPTIONAL)
    // null = carrier has no Otoqa account (reference only)
    // set = carrier has account, partnership is linked
    carrierOrgId: v.optional(v.string()),

    // === CARRIER IDENTIFICATION ===
    mcNumber: v.string(), // Always required (primary identifier)
    usdotNumber: v.optional(v.string()),

    // === CARRIER INFO (used when carrierOrgId is null) ===
    // When carrierOrgId is set, this is cached/synced from carrier's org
    carrierName: v.string(), // Company name
    carrierDba: v.optional(v.string()),
    contactFirstName: v.optional(v.string()),
    contactLastName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),

    // Insurance (broker's record - may differ from carrier's actual)
    insuranceProvider: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    insuranceCoverageVerified: v.optional(v.boolean()),

    // Address
    addressLine: v.optional(v.string()),
    addressLine2: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    country: v.optional(v.string()),

    // === PARTNERSHIP STATUS ===
    status: v.union(
      v.literal('ACTIVE'), // Ready to assign loads
      v.literal('INVITED'), // Invite sent, awaiting carrier signup
      v.literal('PENDING'), // Carrier has account, awaiting acceptance
      v.literal('SUSPENDED'), // Temporarily paused
      v.literal('TERMINATED') // Ended
    ),

    // === BROKER'S PREFERENCES FOR THIS CARRIER ===
    defaultPaymentTerms: v.optional(v.string()), // Net15, Net30, QuickPay
    internalNotes: v.optional(v.string()), // Broker's private notes
    preferredLanes: v.optional(v.array(v.string())), // Regions/lanes this carrier is good for
    rating: v.optional(v.number()), // Broker's internal rating (1-5)

    // === CONTRACT RATE DEFAULTS ===
    // Pre-negotiated rates for direct assignment (skips offer/accept flow)
    defaultRate: v.optional(v.number()), // Base rate amount
    defaultRateType: v.optional(
      v.union(v.literal('FLAT'), v.literal('PER_MILE'), v.literal('PERCENTAGE'))
    ),
    defaultCurrency: v.optional(
      v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN'))
    ),

    // === OWNER-OPERATOR FIELDS ===
    // Broker's categorization - this carrier is a single-driver owner-operator
    isOwnerOperator: v.optional(v.boolean()),
    
    // Owner-operator driver details (for unlinked carriers or broker override)
    ownerDriverFirstName: v.optional(v.string()),
    ownerDriverLastName: v.optional(v.string()),
    ownerDriverPhone: v.optional(v.string()),
    ownerDriverEmail: v.optional(v.string()),
    ownerDriverDOB: v.optional(v.string()), // YYYY-MM-DD
    ownerDriverLicenseNumber: v.optional(v.string()),
    ownerDriverLicenseState: v.optional(v.string()),
    ownerDriverLicenseClass: v.optional(v.string()),
    ownerDriverLicenseExpiration: v.optional(v.string()), // YYYY-MM-DD
    // Legacy field - some documents may have this from old code (not used in new code)
    ownerDriverId: v.optional(v.id('drivers')),

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: v.string(),
    linkedAt: v.optional(v.number()), // When carrierOrgId was linked
  })
    .index('by_broker', ['brokerOrgId', 'status'])
    .index('by_carrier', ['carrierOrgId'])
    .index('by_broker_mc', ['brokerOrgId', 'mcNumber']) // Unique per broker
    .index('by_mc', ['mcNumber']), // Find all partnerships for an MC#

  // Load assignments to carriers
  // Connects broker's loads to carriers with negotiated rates
  loadCarrierAssignments: defineTable({
    // Broker's load
    loadId: v.id('loadInformation'),
    brokerOrgId: v.string(),

    // Assigned carrier (can be linked or reference-only)
    carrierOrgId: v.optional(v.string()), // null if carrier has no account
    partnershipId: v.optional(v.id('carrierPartnerships')), // null for one-off

    // Carrier info (cached/manual when carrierOrgId is null)
    carrierName: v.optional(v.string()),
    carrierMcNumber: v.optional(v.string()),

    // The negotiated rate (what carrier gets paid - NOT visible to carrier's customer)
    // Optional when usePayProfile is true
    carrierRate: v.optional(v.number()),
    carrierRateType: v.optional(v.union(
      v.literal('FLAT'),
      v.literal('PER_MILE'),
      v.literal('PERCENTAGE')
    )),
    currency: v.optional(v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN'))),

    // Accessorials for carrier
    carrierFuelSurcharge: v.optional(v.number()),
    carrierAccessorials: v.optional(v.number()),
    carrierTotalAmount: v.optional(v.number()), // Calculated total (optional when using pay profile)

    // If true, carrier pay will be auto-calculated using their pay profile
    usePayProfile: v.optional(v.boolean()),

    // Status (supports multi-carrier offers)
    status: v.union(
      v.literal('OFFERED'), // Sent to carrier (can have multiple)
      v.literal('ACCEPTED'), // Carrier accepted (still pending broker choice)
      v.literal('AWARDED'), // Broker selected this carrier (winner)
      v.literal('DECLINED'), // Carrier declined
      v.literal('WITHDRAWN'), // Broker withdrew offer (chose another carrier)
      v.literal('IN_PROGRESS'), // Load is being executed
      v.literal('COMPLETED'), // Delivered
      v.literal('CANCELED') // Canceled after award
    ),

    // === DRIVER ASSIGNMENT ===
    // When carrierOrgId is set: assignedDriverId references real driver record
    // When carrierOrgId is null: just store name/phone as text
    assignedDriverId: v.optional(v.id('drivers')), // Real reference if carrier has account
    assignedDriverName: v.optional(v.string()), // Cached/manual for display
    assignedDriverPhone: v.optional(v.string()), // Cached/manual for communication

    // === PAYMENT TRACKING (payments happen outside platform) ===
    paymentStatus: v.optional(
      v.union(
        v.literal('PENDING'), // Load completed, awaiting payment
        v.literal('INVOICED'), // Carrier sent invoice
        v.literal('SCHEDULED'), // Payment scheduled
        v.literal('PAID'), // Payment sent
        v.literal('DISPUTED') // Payment dispute
      )
    ),
    paymentMethod: v.optional(
      v.union(
        v.literal('ACH'),
        v.literal('CHECK'),
        v.literal('WIRE'),
        v.literal('QUICKPAY')
      )
    ),
    paymentReference: v.optional(v.string()), // Check #, ACH ref, etc.
    paymentDate: v.optional(v.number()), // When payment was made
    paymentAmount: v.optional(v.number()), // Actual amount paid (may differ)
    paymentNotes: v.optional(v.string()),

    // === CANCELLATION TRACKING ===
    canceledAt: v.optional(v.number()),
    canceledBy: v.optional(v.string()), // User ID who canceled
    canceledByParty: v.optional(
      v.union(v.literal('BROKER'), v.literal('CARRIER'))
    ),
    cancellationReason: v.optional(
      v.union(
        v.literal('DRIVER_UNAVAILABLE'),
        v.literal('EQUIPMENT_ISSUE'),
        v.literal('RATE_DISPUTE'),
        v.literal('LOAD_CANCELED_BY_CUSTOMER'),
        v.literal('WEATHER'),
        v.literal('OTHER')
      )
    ),
    cancellationNotes: v.optional(v.string()),

    // Timestamps
    offeredAt: v.number(),
    acceptedAt: v.optional(v.number()),
    awardedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),

    createdBy: v.string(),
  })
    .index('by_load', ['loadId'])
    .index('by_broker', ['brokerOrgId', 'status'])
    .index('by_carrier', ['carrierOrgId', 'status'])
    .index('by_carrier_payment', ['carrierOrgId', 'paymentStatus'])
    .index('by_assigned_driver', ['assignedDriverId', 'status']),

  // User identity linking (Clerk <-> WorkOS)
  // Links mobile auth (Clerk) to web auth (WorkOS) via immutable user IDs
  userIdentityLinks: defineTable({
    // PRIMARY LINK: Immutable user IDs (stable even if email/phone changes)
    clerkUserId: v.string(), // Clerk user ID (immutable)
    workosUserId: v.optional(v.string()), // WorkOS user ID (added on upgrade)
    workosOrgId: v.optional(v.string()), // WorkOS org ID

    // METADATA: Contact info (can change, stored for reference only)
    phone: v.optional(v.string()), // Current phone (snapshot)
    email: v.optional(v.string()), // Current email (snapshot)

    // Organization
    organizationId: v.id('organizations'),

    // Role in org
    role: v.union(v.literal('OWNER'), v.literal('ADMIN'), v.literal('MEMBER')),

    // Upgrade tracking
    upgradedAt: v.optional(v.number()), // When WorkOS was provisioned

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_clerk', ['clerkUserId'])
    .index('by_workos', ['workosUserId'])
    .index('by_org', ['organizationId']),

  // Notification preferences for organizations
  notificationPreferences: defineTable({
    organizationId: v.id('organizations'),
    userId: v.optional(v.string()), // For future multi-user support

    // Channel preferences
    pushEnabled: v.boolean(),
    smsEnabled: v.boolean(),
    emailEnabled: v.boolean(),

    // What to notify
    newLoadOffers: v.boolean(),
    loadStatusChanges: v.boolean(),
    paymentUpdates: v.boolean(),

    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_org', ['organizationId']),

  // Carrier documents per load assignment
  // Separate from broker documents - each party has their own
  loadCarrierDocuments: defineTable({
    assignmentId: v.id('loadCarrierAssignments'),
    carrierOrgId: v.string(),

    documentType: v.union(
      v.literal('RATE_CONFIRMATION'), // Carrier's rate con
      v.literal('BOL'), // Bill of lading
      v.literal('POD'), // Proof of delivery
      v.literal('LUMPER_RECEIPT'), // Lumper fees
      v.literal('SCALE_TICKET'), // Weight ticket
      v.literal('OTHER')
    ),

    storageId: v.id('_storage'),
    fileName: v.string(),
    uploadedBy: v.string(),
    uploadedAt: v.number(),
  })
    .index('by_assignment', ['assignmentId'])
    .index('by_carrier', ['carrierOrgId']),

  // User preferences for individual UI/UX settings
  userPreferences: defineTable({
    userId: v.string(), // WorkOS User ID from identity.subject
    workosOrgId: v.string(),
    language: v.string(), // e.g. "English"
    unitSystem: v.union(v.literal('Imperial'), v.literal('Metric')),
    theme: v.union(v.literal('light'), v.literal('dark'), v.literal('system')),
    timezone: v.string(),
    updatedAt: v.number(),
  }).index('by_user_org', ['userId', 'workosOrgId']),

  // Universal audit log for tracking all actions across the entire project
  auditLog: defineTable({
    // Multi-tenant Organization (WorkOS)
    organizationId: v.string(), // WorkOS organization ID for multi-tenant isolation

    // Entity Information
    entityType: v.string(), // 'driver', 'vehicle', 'trip', 'load', 'company', 'user', etc.
    entityId: v.string(), // ID of the entity being acted upon
    entityName: v.optional(v.string()), // Display name for UI (e.g., "Carlos Gonzalez", "Truck #402")

    // Action Details
    action: v.string(), // 'created', 'updated', 'deleted', 'deactivated', 'restored', 'assigned', 'approved', etc.
    description: v.optional(v.string()), // Human-readable description of what happened

    // User Information (WorkOS User)
    performedBy: v.string(), // WorkOS user ID who performed the action
    performedByName: v.optional(v.string()), // User's full name
    performedByEmail: v.optional(v.string()), // User's email

    // Change Tracking
    changesBefore: v.optional(v.string()), // JSON string of old values
    changesAfter: v.optional(v.string()), // JSON string of new values
    changedFields: v.optional(v.array(v.string())), // Array of field names that changed

    // Context & Metadata
    ipAddress: v.optional(v.string()), // User's IP address for security
    userAgent: v.optional(v.string()), // Browser/device information
    metadata: v.optional(v.string()), // Additional context as JSON string

    // Timestamp
    timestamp: v.number(), // Unix timestamp in milliseconds
  })
    // Primary indices for common queries
    .index('by_organization', ['organizationId', 'timestamp']) // List all org activity
    .index('by_entity', ['entityType', 'entityId', 'timestamp']) // Get history for specific entity
    .index('by_user', ['organizationId', 'performedBy', 'timestamp']) // User activity within org
    .index('by_action', ['organizationId', 'action', 'timestamp']) // Filter by action type
    .index('by_entity_type', ['organizationId', 'entityType', 'timestamp']), // All drivers, vehicles, etc.

  drivers: defineTable({
    // Personal Information
    firstName: v.string(),
    middleName: v.optional(v.string()),
    lastName: v.string(),
    email: v.string(),
    phone: v.string(),
    dateOfBirth: v.optional(v.string()), // Date of birth (YYYY-MM-DD)

    // License Information (non-sensitive)
    licenseNumber: v.optional(v.string()), // Driver's license number
    licenseState: v.string(),
    licenseExpiration: v.string(),
    licenseClass: v.string(), // Class A, B, C

    // Medical
    medicalExpiration: v.optional(v.string()),

    // Security Access
    badgeExpiration: v.optional(v.string()),
    twicExpiration: v.optional(v.string()),

    // Employment
    hireDate: v.string(),
    employmentStatus: v.string(), // Active, Inactive, On Leave
    employmentType: v.string(), // Full-time, Part-time, Contract
    terminationDate: v.optional(v.string()),
    preEmploymentCheckDate: v.optional(v.string()),

    // Address
    address: v.optional(v.string()),
    address2: v.optional(v.string()), // Apt, Suite, Unit, etc.
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zipCode: v.optional(v.string()),
    country: v.optional(v.string()),

    // Emergency Contact
    emergencyContactName: v.optional(v.string()),
    emergencyContactRelationship: v.optional(v.string()),
    emergencyContactPhone: v.optional(v.string()),

    // Current Equipment Assignment (for dispatch planning)
    currentTruckId: v.optional(v.id('trucks')),

    // Pay Plan Assignment (for payroll timing/schedule)
    payPlanId: v.optional(v.id('payPlans')),

    // WorkOS Integration
    organizationId: v.string(),
    createdBy: v.string(), // WorkOS user ID

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),

    // Soft Delete
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index('by_organization', ['organizationId'])
    .index('by_email', ['email'])
    .index('by_status', ['employmentStatus'])
    .index('by_deleted', ['isDeleted']),

  drivers_sensitive_info: defineTable({
    // Reference to driver
    driverInternalId: v.string(), // References drivers._id

    // Sensitive Information
    ssn: v.optional(v.string()),
    licenseNumber: v.string(),
    dateOfBirth: v.optional(v.string()),

    // Multi-tenant Organization
    organizationId: v.string(),

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_driver', ['driverInternalId'])
    .index('by_organization', ['organizationId'])
    .index('by_license', ['licenseNumber']),

  trucks: defineTable({
    // Identity & Basic Info
    unitId: v.string(), // User-entered, required
    vin: v.string(), // Required, unique
    plate: v.optional(v.string()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    status: v.string(), // Active, Out of Service, In Repair, Maintenance, Sold, Lost

    // Specifications
    bodyType: v.optional(v.string()), // Semi, Bobtail
    fuelType: v.optional(v.string()), // Diesel, Gas, Electric, CNG, Hybrid
    gvwr: v.optional(v.number()), // Gross Vehicle Weight Rating
    gcwr: v.optional(v.number()), // Gross Combination Weight Rating

    // Registration & Compliance
    registrationExpiration: v.optional(v.string()),
    arb: v.optional(v.boolean()), // Air Resources Board certification
    ifta: v.optional(v.boolean()), // International Fuel Tax Agreement
    comments: v.optional(v.string()),

    // Insurance
    insuranceFirm: v.optional(v.string()),
    insurancePolicyNumber: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    insuranceComments: v.optional(v.string()),

    // Financial
    purchaseDate: v.optional(v.string()),
    purchasePrice: v.optional(v.number()),
    ownershipType: v.optional(v.string()), // Owned, Leased, Financed, Renting
    lienholder: v.optional(v.string()),

    // Engine Information
    engineModel: v.optional(v.string()),
    engineFamilyName: v.optional(v.string()),
    engineModelYear: v.optional(v.number()),
    engineSerialNumber: v.optional(v.string()),
    engineManufacturer: v.optional(v.string()),

    // WorkOS Integration
    organizationId: v.string(),
    createdBy: v.string(), // WorkOS user ID

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),

    // Soft Delete
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),

    // Last Known Location (for deadhead/dispatch planning)
    lastLocationLat: v.optional(v.float64()),
    lastLocationLng: v.optional(v.float64()),
    lastLocationUpdatedAt: v.optional(v.float64()),
  })
    .index('by_organization', ['organizationId'])
    .index('by_unit_id', ['unitId'])
    .index('by_vin', ['vin'])
    .index('by_status', ['status'])
    .index('by_deleted', ['isDeleted']),

  trailers: defineTable({
    // Identity & Basic Info
    unitId: v.string(), // User-entered, required
    vin: v.string(), // Required, unique
    plate: v.optional(v.string()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    status: v.string(), // Active, Out of Service, In Repair, Maintenance, Sold, Lost

    // Specifications
    size: v.optional(v.string()), // 53ft, 48ft, 40ft, etc.
    bodyType: v.optional(v.string()), // Dry Van, Refrigerated, Flatbed, Tanker, etc.
    gvwr: v.optional(v.number()), // Gross Vehicle Weight Rating

    // Registration & Compliance
    registrationExpiration: v.optional(v.string()),
    comments: v.optional(v.string()),

    // Insurance
    insuranceFirm: v.optional(v.string()),
    insurancePolicyNumber: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    insuranceComments: v.optional(v.string()),

    // Financial
    purchaseDate: v.optional(v.string()),
    purchasePrice: v.optional(v.number()),
    ownershipType: v.optional(v.string()), // Owned, Leased, Financed, Renting
    lienholder: v.optional(v.string()),

    // WorkOS Integration
    organizationId: v.string(),
    createdBy: v.string(), // WorkOS user ID

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),

    // Soft Delete
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index('by_organization', ['organizationId'])
    .index('by_unit_id', ['unitId'])
    .index('by_vin', ['vin'])
    .index('by_status', ['status'])
    .index('by_deleted', ['isDeleted']),

  customers: defineTable({
    // Customer Information
    name: v.string(),
    companyType: v.union(
      v.literal('Shipper'),
      v.literal('Broker'),
      v.literal('Manufacturer'),
      v.literal('Distributor'),
    ),
    status: v.union(v.literal('Active'), v.literal('Inactive'), v.literal('Prospect')),
    office: v.optional(v.string()), // Location identifier

    // Address
    addressLine1: v.string(),
    addressLine2: v.optional(v.string()),
    city: v.string(),
    state: v.string(), // Full state/province name, international
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
    loadingType: v.optional(
      v.union(v.literal('Live Load'), v.literal('Drop & Hook'), v.literal('Appointment')),
    ),
    locationScheduleType: v.optional(
      v.union(
        v.literal('24/7'),
        v.literal('Business Hours'),
        v.literal('Appointment Only'),
        v.literal('Specific Hours'),
      ),
    ),
    instructions: v.optional(v.string()),

    // Internal
    internalNotes: v.optional(v.string()),

    // WorkOS Integration
    workosOrgId: v.string(),
    createdBy: v.string(),

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),

    // Soft Delete
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index('by_organization', ['workosOrgId'])
    .index('by_status', ['status'])
    .index('by_deleted', ['isDeleted']),

  contractLanes: defineTable({
    // Contract Information
    contractName: v.string(),
    contractPeriodStart: v.string(), // YYYY-MM-DD format
    contractPeriodEnd: v.string(), // YYYY-MM-DD format
    hcr: v.optional(v.string()), // Contract value like '917DK'
    tripNumber: v.optional(v.string()),
    lanePriority: v.optional(v.union(v.literal('Primary'), v.literal('Secondary'))),
    notes: v.optional(v.string()),

    // Customer Reference
    customerCompanyId: v.id('customers'),

    // Lane Details
    stops: v.array(
      v.object({
        address: v.string(),
        city: v.string(),
        state: v.string(),
        zip: v.string(),
        stopOrder: v.number(),
        stopType: v.union(v.literal('Pickup'), v.literal('Delivery')),
        type: v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live')),
        arrivalTime: v.string(), // HH:MM format
      }),
    ),
    miles: v.optional(v.number()),
    loadCommodity: v.optional(v.string()),

    // Equipment Requirements
    equipmentClass: v.optional(
      v.union(
        v.literal('Bobtail'),
        v.literal('Dry Van'),
        v.literal('Refrigerated'),
        v.literal('Flatbed'),
        v.literal('Tanker'),
      ),
    ),
    equipmentSize: v.optional(v.union(v.literal('53ft'), v.literal('48ft'), v.literal('45ft'))),

    // Rate Information
    rate: v.number(),
    rateType: v.union(v.literal('Per Mile'), v.literal('Flat Rate'), v.literal('Per Stop')),
    currency: v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN')), // Required, strict typing
    minimumRate: v.optional(v.number()),
    minimumQuantity: v.optional(v.number()),
    
    // Accessorials (NEW)
    stopOffRate: v.optional(v.number()),          // e.g., 50.00 for $50 per stop
    includedStops: v.optional(v.number()),        // Default 2 (pickup + delivery)
    
    // Fuel Surcharge (NEW)
    fuelSurchargeType: v.optional(v.union(
      v.literal('PERCENTAGE'),     // % of base rate
      v.literal('FLAT'),          // Fixed amount
      v.literal('DOE_INDEX')      // Based on DOE diesel index
    )),
    fuelSurchargeValue: v.optional(v.number()),   // 22 (for 22%) or 150 (for $150)

    // Additional Info
    subsidiary: v.optional(v.string()),
    isActive: v.optional(v.boolean()), // defaults to true

    // WorkOS Integration
    workosOrgId: v.string(),
    createdBy: v.string(),

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),

    // Soft Delete
    isDeleted: v.boolean(),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index('by_customer', ['customerCompanyId'])
    .index('by_organization', ['workosOrgId'])
    .index('by_hcr', ['hcr'])
    .index('by_trip', ['tripNumber'])
    .index('by_deleted', ['isDeleted'])
    // ✅ Compound index for efficient HCR+Trip lane lookup (used in promotion)
    .index('by_org_hcr_trip', ['workosOrgId', 'hcr', 'tripNumber']),

  // ==========================================
  // AUTO-ASSIGNMENT SYSTEM
  // Maps recurring routes (HCR+Trip) to drivers/carriers
  // ==========================================
  routeAssignments: defineTable({
    workosOrgId: v.string(),

    // Route Identifier (HCR + Trip combination)
    hcr: v.string(),
    tripNumber: v.optional(v.string()), // Optional for HCR-only matching

    // Assignment Target (one of these must be set)
    driverId: v.optional(v.id('drivers')),
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),

    // Assignment Config
    priority: v.number(), // For multiple matches, lower = higher priority
    isActive: v.boolean(),

    // Metadata
    name: v.optional(v.string()), // Friendly name like "John's Amazon Route"
    notes: v.optional(v.string()),

    // Audit
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_organization', ['workosOrgId'])
    .index('by_org_hcr', ['workosOrgId', 'hcr'])
    .index('by_org_hcr_trip', ['workosOrgId', 'hcr', 'tripNumber'])
    .index('by_driver', ['driverId'])
    .index('by_carrier', ['carrierPartnershipId'])
    .index('by_org_active', ['workosOrgId', 'isActive']),

  // ==========================================
  // RECURRING LOAD TEMPLATES
  // Blueprints for automatically generating loads on a schedule
  // ==========================================
  recurringLoadTemplates: defineTable({
    workosOrgId: v.string(),

    // Link to route assignment (for auto-assign after generation)
    routeAssignmentId: v.optional(v.id('routeAssignments')),

    // Direct assignment (for loads created with explicit driver/carrier)
    driverId: v.optional(v.id('drivers')),
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),

    // Template Source
    sourceLoadId: v.id('loadInformation'), // Original load cloned from
    name: v.string(), // "Amazon Daily Route"

    // Template Data (snapshot of source load)
    customerId: v.id('customers'),
    hcr: v.optional(v.string()),
    tripNumber: v.optional(v.string()),
    stops: v.array(
      v.object({
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
      })
    ),
    equipmentType: v.optional(v.string()),
    weight: v.optional(v.number()),
    weightUnit: v.optional(v.string()),
    fleet: v.optional(v.string()),
    generalInstructions: v.optional(v.string()),

    // Recurrence Rules
    activeDays: v.array(v.number()), // 0=Sun, 1=Mon, ... 6=Sat
    excludeFederalHolidays: v.boolean(),
    customExclusions: v.array(v.string()), // ["2026-12-25"]

    // Generation Config
    generationTime: v.string(), // "06:00" - when cron creates load (HH:MM)
    advanceDays: v.number(), // Create load N days before pickup (0 = same day)

    // Multi-day Load Support
    deliveryDayOffset: v.number(), // 0 = same day, 1 = next day, 2 = day after, etc.

    // Template Lifecycle
    endDate: v.optional(v.string()), // "2026-12-31" - stop generating after this date

    // Status
    isActive: v.boolean(),
    lastGeneratedAt: v.optional(v.number()),
    lastGeneratedLoadId: v.optional(v.id('loadInformation')),

    // Audit
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_organization', ['workosOrgId'])
    .index('by_route_assignment', ['routeAssignmentId'])
    .index('by_org_active', ['workosOrgId', 'isActive']),

  // ==========================================
  // AUTO-ASSIGNMENT SETTINGS (Organization-level)
  // ==========================================
  autoAssignmentSettings: defineTable({
    workosOrgId: v.string(),

    // Master toggle
    enabled: v.boolean(),

    // Trigger options
    triggerOnCreate: v.boolean(), // Auto-assign when load is created
    scheduledEnabled: v.boolean(), // Run on schedule
    scheduleIntervalMinutes: v.optional(v.number()), // Minutes between scheduled runs
    lastScheduledRunAt: v.optional(v.number()), // Last scheduled run timestamp (ms)

    // Audit
    updatedBy: v.string(),
    updatedAt: v.number(),
  }).index('by_organization', ['workosOrgId']),

  orgIntegrations: defineTable({
    // WorkOS Organization
    workosOrgId: v.string(),

    // Integration Provider
    provider: v.string(), // 'fourkites', 'project44', etc.

    // Credentials (stored as JSON string - will be encrypted later)
    credentials: v.string(), // JSON string of { apiKey: string, etc. }

    // Integration Metadata
    integrationMetadata: v.optional(
      v.object({
        distanceUnit: v.string(), // 'meters', 'miles', 'km' - what unit the API returns
      }),
    ),

    // Sync Settings
    syncSettings: v.object({
      isEnabled: v.boolean(),
      pull: v.optional(
        v.object({
          loadsEnabled: v.boolean(),
          intervalMinutes: v.number(),
          lookbackWindowHours: v.number(),
        }),
      ),
      push: v.optional(
        v.object({
          gpsTrackingEnabled: v.boolean(),
          driverAssignmentsEnabled: v.boolean(),
        }),
      ),
    }),

    // Last Sync Statistics
    lastSyncStats: v.object({
      lastSyncTime: v.optional(v.number()),
      lastSyncStatus: v.optional(v.string()), // 'success', 'failed', 'partial'
      recordsProcessed: v.optional(v.number()),
      errorMessage: v.optional(v.string()),
    }),

    // Metadata
    createdBy: v.string(), // WorkOS user ID

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_organization', ['workosOrgId'])
    .index('by_provider', ['workosOrgId', 'provider']),

  loadInformation: defineTable({
    // External Integration
    externalSource: v.optional(v.string()), // null for manual, 'FOURKITES' for FourKites
    externalLoadId: v.optional(v.string()), // FourKites shipment ID
    lastExternalUpdatedAt: v.optional(v.string()), // ISO 8601 string from FourKites

    // Basic Information
    internalId: v.string(), // User-friendly load ID
    orderNumber: v.string(),
    poNumber: v.optional(v.string()),
    status: v.union(
      v.literal('Open'),
      v.literal('Assigned'),
      v.literal('Canceled'),
      v.literal('Completed'),
    ),
    trackingStatus: v.union(
      v.literal('Pending'),
      v.literal('In Transit'),
      v.literal('Completed'),
      v.literal('Delayed'),
      v.literal('Canceled'),
    ),

    // Customer Information
    customerId: v.id('customers'),
    customerName: v.optional(v.string()),

    // Fleet & Route
    fleet: v.string(), // Free text for now

    // Miles Calculation
    contractMiles: v.optional(v.number()),
    importedMiles: v.optional(v.number()),  // Miles from external integration (FourKites, etc.)
    googleMiles: v.optional(v.number()),
    manualMiles: v.optional(v.number()),
    effectiveMiles: v.optional(v.number()), // Calculated: manual > contract > imported > google
    lastMilesUpdate: v.optional(v.string()), // ISO 8601 timestamp

    // Equipment
    equipmentType: v.optional(v.string()),
    equipmentLength: v.optional(v.number()),

    // Commodity (Physical Data Only)
    commodityDescription: v.optional(v.string()),
    weight: v.optional(v.number()),
    units: v.union(v.literal('Pallets'), v.literal('Boxes'), v.literal('Pieces'), v.literal('Lbs'), v.literal('Kg')),
    temperature: v.optional(v.number()), // For refrigerated loads
    maxTemperature: v.optional(v.number()),

    // Contact
    contactPersonName: v.optional(v.string()),
    contactPersonPhone: v.optional(v.string()),
    contactPersonEmail: v.optional(v.string()),

    // Instructions
    generalInstructions: v.optional(v.string()),

    // Parsed Contract Lane Data (from FourKites)
    parsedHcr: v.optional(v.string()),
    parsedTripNumber: v.optional(v.string()),

    // Load Classification (Ops needs to know type even if billing is separate)
    loadType: v.optional(v.union(
      v.literal('CONTRACT'), // Exact match (high confidence)
      v.literal('SPOT'),     // Wildcard match (low confidence)
      v.literal('UNMAPPED')  // No match (GPS active, billing review needed)
    )),

    // Operational Flags
    requiresManualReview: v.optional(v.boolean()), // True if wildcard match or validation fails
    isTracking: v.optional(v.boolean()),           // GPS tracking status
    
    // Stop Count (Physical Data)
    stopCount: v.optional(v.number()),             // Total stops (pickup + deliveries)

    // Driver Pay Engine
    primaryDriverId: v.optional(v.id('drivers')),  // Read-only cache, updated by dispatchLegs
    primaryCarrierPartnershipId: v.optional(v.id('carrierPartnerships')), // Read-only cache, updated by dispatchLegs
    // Legacy field - existing data may have this from old carriers table (deprecated)
    primaryCarrierId: v.optional(v.string()),
    isHazmat: v.optional(v.boolean()),             // Triggers ATTR_HAZMAT pay rule
    requiresTarp: v.optional(v.boolean()),         // Triggers ATTR_TARP pay rule

    // Denormalized First Stop Date (for efficient date range filtering)
    // Source of truth: loadStops where sequenceNumber = 1, windowBeginDate
    // Format: YYYY-MM-DD string (undefined if no stops or TBD)
    firstStopDate: v.optional(v.string()),

    // Cancellation Tracking (when status = 'Canceled')
    cancellationReason: v.optional(v.union(
      v.literal('DRIVER_BREAKDOWN'),
      v.literal('CUSTOMER_CANCELLED'),
      v.literal('EQUIPMENT_ISSUE'),
      v.literal('RATE_DISPUTE'),
      v.literal('WEATHER_CONDITIONS'),
      v.literal('CAPACITY_ISSUE'),
      v.literal('SCHEDULING_CONFLICT'),
      v.literal('OTHER'),
    )),
    cancellationNotes: v.optional(v.string()),
    canceledAt: v.optional(v.number()),            // Timestamp when canceled
    canceledBy: v.optional(v.string()),            // WorkOS user ID who canceled

    // Settlement & Hold Logic
    isHeld: v.optional(v.boolean()),               // Hold from current settlement (missing paperwork)
    heldReason: v.optional(v.string()),            // Why is this load held?
    heldAt: v.optional(v.float64()),
    heldBy: v.optional(v.string()),

    // POD (Proof of Delivery) Tracking
    podStorageId: v.optional(v.id('_storage')),   // Uploaded POD document
    podUploadedAt: v.optional(v.float64()),
    hasSignedPod: v.optional(v.boolean()),         // Quick flag for auditing

    // WorkOS Integration
    workosOrgId: v.string(),
    createdBy: v.string(), // WorkOS user ID

    // Timestamps (System Time - Numbers)
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_organization', ['workosOrgId'])
    .index('by_customer', ['customerId'])
    .index('by_status', ['workosOrgId', 'status'])
    .index('by_load_type', ['workosOrgId', 'loadType'])
    .index('by_external_id', ['externalSource', 'externalLoadId'])
    .index('by_org_external_id', ['workosOrgId', 'externalSource', 'externalLoadId'])
    .index('by_internal_id', ['workosOrgId', 'internalId'])
    .index('by_order_number', ['workosOrgId', 'orderNumber'])
    .index('by_hcr_trip', ['workosOrgId', 'parsedHcr', 'parsedTripNumber'])
    .index('by_org_first_stop_date', ['workosOrgId', 'firstStopDate'])
    .index('by_org_tracking_status', ['workosOrgId', 'trackingStatus']),

  loadStops: defineTable({
    // Load Reference
    loadId: v.id('loadInformation'),
    internalId: v.string(), // Load internal ID for quick reference
    externalStopId: v.optional(v.string()), // From FourKites only, undefined for manual

    // Sequence
    sequenceNumber: v.number(), // 1, 2, 3...

    // Stop Type
    stopType: v.union(v.literal('PICKUP'), v.literal('DELIVERY')),
    loadingType: v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live')),

    // Status
    status: v.optional(
      v.union(
        v.literal('Pending'),
        v.literal('In Transit'),
        v.literal('Completed'),
        v.literal('Delayed'),
        v.literal('Canceled'),
      ),
    ),

    // Location
    address: v.string(),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    postalCode: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    timeZone: v.optional(v.string()), // IANA timezone e.g., "America/Los_Angeles"

    // Reference
    referenceName: v.optional(v.string()),
    referenceValue: v.optional(v.string()),

    // Schedule (Business Time - ISO Strings)
    windowBeginDate: v.string(), // ISO 8601
    windowBeginTime: v.string(), // ISO 8601 with timezone offset
    windowEndDate: v.string(), // ISO 8601
    windowEndTime: v.string(), // ISO 8601 with timezone offset

    // Commodity
    commodityDescription: v.string(),
    commodityUnits: v.union(
      v.literal('Pallets'),
      v.literal('Boxes'),
      v.literal('Pieces'),
      v.literal('Lbs'),
      v.literal('Kg'),
    ),
    pieces: v.number(),
    weight: v.optional(v.number()),

    // Instructions & Requirements
    instructions: v.optional(v.string()),
    photoRequired: v.optional(v.boolean()),
    signatureRequired: v.optional(v.boolean()),

    // Check-in/out (Business Time - ISO Strings)
    checkedInAt: v.optional(v.string()),
    checkedOutAt: v.optional(v.string()),
    checkinLatitude: v.optional(v.number()),
    checkinLongitude: v.optional(v.number()),
    checkoutLatitude: v.optional(v.number()),
    checkoutLongitude: v.optional(v.number()),
    dwellTime: v.optional(v.number()), // Minutes

    // Status Tracking
    lastStatusChangeTimestamp: v.optional(v.string()),
    lastStatusChangeLatitude: v.optional(v.number()),
    lastStatusChangeLongitude: v.optional(v.number()),
    statusUpdatedAt: v.optional(v.string()),
    statusUpdatedBy: v.optional(v.string()),

    // Exceptions
    exceptionReason: v.optional(v.string()),
    skipReason: v.optional(v.string()),

    // Media
    deliveryPhotos: v.optional(v.array(v.string())),
    signatureImage: v.optional(v.string()),
    driverNotes: v.optional(v.string()),

    // WorkOS Integration
    workosOrgId: v.string(),
    createdBy: v.string(), // WorkOS user ID

    // Timestamps (System Time - Numbers)
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_load', ['loadId'])
    .index('by_organization', ['workosOrgId'])
    .index('by_sequence', ['loadId', 'sequenceNumber'])
    .index('by_stop_type', ['loadId', 'stopType']),

  // ==========================================
  // ACCOUNTING (Financial Data Separation)
  // ==========================================
  loadInvoices: defineTable({
    // Linkage
    loadId: v.id('loadInformation'),
    customerId: v.id('customers'),
    contractLaneId: v.optional(v.id('contractLanes')), // Reference to contract lane for dynamic calculation
    workosOrgId: v.string(),

    // The Financial Workflow
    // MISSING_DATA: No contract lane match found (was "Unmapped")
    // DRAFT: Lane matched, awaiting review/approval
    // BILLED: Sent to ERP/Customer
    // PENDING_PAYMENT: Awaiting payment
    // PAID: Payment received
    // VOID: Canceled/voided
    status: v.union(
      v.literal('MISSING_DATA'),
      v.literal('DRAFT'),
      v.literal('BILLED'),
      v.literal('PENDING_PAYMENT'),
      v.literal('PAID'),
      v.literal('VOID')
    ),

    // Invoice Details
    invoiceNumber: v.optional(v.string()), // Generated when status -> BILLED
    invoiceDate: v.optional(v.string()),   // ISO 8601
    dueDate: v.optional(v.string()),       // ISO 8601
    currency: v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN')),

    // The Numbers (Optional - only stored when invoice is finalized/billed)
    // For DRAFT/MISSING_DATA: calculated on-the-fly from load + contract lane
    // For BILLED/PAID: frozen snapshot
    subtotal: v.optional(v.number()),                  // Freight base amount
    fuelSurcharge: v.optional(v.number()), // FSC amount
    accessorialsTotal: v.optional(v.number()), // Stop-offs, detention, etc.
    taxAmount: v.optional(v.number()),     // Sales tax
    totalAmount: v.optional(v.number()),   // Grand total

    // Metadata
    missingDataReason: v.optional(v.string()), // e.g., "No Contract Lane found for HCR 925L0"
    erpInvoiceId: v.optional(v.string()),      // QuickBooks/Wave ID

    // WorkOS Integration
    createdBy: v.string(), // WorkOS user ID
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_load', ['loadId'])
    .index('by_customer', ['customerId'])
    .index('by_organization', ['workosOrgId'])
    .index('by_status', ['workosOrgId', 'status']),

  invoiceLineItems: defineTable({
    invoiceId: v.id('loadInvoices'),

    type: v.union(
      v.literal('FREIGHT'),     // Base freight charge
      v.literal('FUEL'),        // Fuel surcharge
      v.literal('ACCESSORIAL'), // Detention, Lumper, Stop-off
      v.literal('TAX')          // Sales tax
    ),

    description: v.string(), // "Freight: Chicago to Denver", "Stop-off charge (3 stops)"
    quantity: v.number(),    // e.g., 1, 3 (for 3 stops)
    rate: v.number(),        // Unit rate
    amount: v.number(),      // quantity * rate

    createdAt: v.number(),
  })
    .index('by_invoice', ['invoiceId']),

  // ==========================================
  // DRIVER PAY ENGINE
  // ==========================================

  /**
   * Rate Profiles - Pay package definitions
   * e.g., "Standard OTR", "City Hourly", "Owner Op %"
   */
  rateProfiles: defineTable({
    workosOrgId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    
    // Who is this profile for?
    profileType: v.union(
      v.literal('DRIVER'),    // Company drivers (W2)
      v.literal('CARRIER')    // Owner operators / external carriers (1099)
    ),
    
    payBasis: v.union(
      v.literal('MILEAGE'),
      v.literal('HOURLY'),
      v.literal('PERCENTAGE'),
      v.literal('FLAT')          // Flat rate per load
    ),
    
    // Org-level default for this profileType
    // Only ONE profile per type can be the org default
    // Used when driver/carrier has no explicit assignment
    isDefault: v.optional(v.boolean()),
    isActive: v.boolean(),
    createdAt: v.float64(),
    createdBy: v.string(),
  })
    .index('by_org', ['workosOrgId'])
    .index('by_org_type', ['workosOrgId', 'profileType']),

  /**
   * Rate Rules - Logic engine rules
   * "IF Trigger matches, THEN apply Rate"
   */
  rateRules: defineTable({
    profileId: v.id('rateProfiles'),
    workosOrgId: v.string(),             // Denormalized for RLS queries
    name: v.string(),                    // e.g., "Base Loaded Mile", "Detention"

    // Category: Base pay vs Add-ons vs Deductions vs Manual Templates
    category: v.union(
      v.literal('BASE'),
      v.literal('ACCESSORIAL'),
      v.literal('DEDUCTION'),
      v.literal('MANUAL_TEMPLATE')  // Quick-add templates for accountants
    ),

    // What data triggers this rule?
    triggerEvent: v.union(
      v.literal('MILE_LOADED'),
      v.literal('MILE_EMPTY'),
      v.literal('TIME_DURATION'),  // Total hours
      v.literal('TIME_WAITING'),   // Detention
      v.literal('COUNT_STOPS'),
      v.literal('FLAT_LOAD'),      // Flat rate per entire load
      v.literal('FLAT_LEG'),       // Flat rate per leg segment
      v.literal('ATTR_HAZMAT'),
      v.literal('ATTR_TARP'),
      v.literal('PCT_OF_LOAD')     // % of Load Revenue
    ),

    rateAmount: v.float64(),             // The $, %, or Multiplier

    // Optional Constraints
    minThreshold: v.optional(v.float64()), // e.g., "Only applies after 2 hours"
    maxCap: v.optional(v.float64()),       // e.g., "Max $150 detention"

    isActive: v.boolean(),
  })
    .index('by_profile', ['profileId'])
    .index('by_org', ['workosOrgId']),

  /**
   * Driver Profile Assignments
   * Links Drivers to Profiles
   * Distance-based selection uses minThreshold on the profile's BASE rule
   */
  driverProfileAssignments: defineTable({
    driverId: v.id('drivers'),
    profileId: v.id('rateProfiles'),
    workosOrgId: v.string(),

    // Is this the driver's DEFAULT profile?
    // Only ONE assignment per driver can be true.
    // Overrides org-level default when set.
    isDefault: v.optional(v.boolean()),

    // Profile selection strategy
    selectionStrategy: v.optional(
      v.union(
        v.literal('ALWAYS_ACTIVE'),      // Always use this profile
        v.literal('DISTANCE_THRESHOLD'), // Use when miles exceed threshold
        v.literal('MANUAL_ONLY')         // Only when explicitly selected
      )
    ),
    thresholdValue: v.optional(v.number()), // Miles threshold for DISTANCE_THRESHOLD
    effectiveDate: v.optional(v.string()),  // When this assignment becomes active
  })
    .index('by_driver', ['driverId'])
    .index('by_org', ['workosOrgId']),

  /**
   * Carrier Profile Assignments
   * Links Carrier Partnerships to Rate Profiles for pay calculation
   * Distance-based selection uses minThreshold on the profile's BASE rule
   */
  carrierProfileAssignments: defineTable({
    carrierPartnershipId: v.id('carrierPartnerships'),
    profileId: v.id('rateProfiles'),
    workosOrgId: v.string(),

    // Is this the carrier's DEFAULT profile?
    isDefault: v.optional(v.boolean()),

    // Profile selection strategy
    selectionStrategy: v.optional(
      v.union(
        v.literal('ALWAYS_ACTIVE'),      // Always use this profile
        v.literal('DISTANCE_THRESHOLD'), // Use when miles exceed threshold
        v.literal('MANUAL_ONLY')         // Only when explicitly selected
      )
    ),
    thresholdValue: v.optional(v.number()), // Miles threshold for DISTANCE_THRESHOLD
    effectiveDate: v.optional(v.string()),  // When this assignment becomes active
  })
    .index('by_carrier_partnership', ['carrierPartnershipId'])
    .index('by_org', ['workosOrgId']),

  /**
   * Pay Plans - Payroll Timing & Schedule Templates
   * Defines WHEN to pay (separate from Rate Profiles which define HOW MUCH)
   * Reusable: many drivers can share the same Pay Plan
   */
  payPlans: defineTable({
    workosOrgId: v.string(),
    name: v.string(),                    // "Weekly - Monday Start"
    description: v.optional(v.string()),

    // === Timing & Schedule (The "When") ===
    frequency: v.union(
      v.literal('WEEKLY'),
      v.literal('BIWEEKLY'),
      v.literal('SEMIMONTHLY'),          // Fixed: 1st-15th, 16th-end
      v.literal('MONTHLY')
    ),

    // Anchor configuration (varies by frequency)
    periodStartDayOfWeek: v.optional(v.union(  // For WEEKLY/BIWEEKLY only
      v.literal('SUNDAY'), v.literal('MONDAY'), v.literal('TUESDAY'),
      v.literal('WEDNESDAY'), v.literal('THURSDAY'), v.literal('FRIDAY'),
      v.literal('SATURDAY')
    )),
    periodStartDayOfMonth: v.optional(v.number()), // For MONTHLY: 1-28 (avoid 29-31 edge cases)
    // SEMIMONTHLY is always 1st and 16th (industry standard, no config needed)

    // Timezone (optional - inherits from organization.defaultTimezone if not set)
    timezone: v.optional(v.string()),   // IANA timezone: "America/New_York" (overrides org default)
    cutoffTime: v.string(),             // "17:00" (5PM in the resolved timezone)
    paymentLagDays: v.number(),         // Days after period ends for pay date

    // === Calculation Logic (The "What") ===
    payableTrigger: v.union(
      v.literal('DELIVERY_DATE'),       // Maps to: dispatchLegs.endStop.checkedOutAt
      v.literal('COMPLETION_DATE'),     // Maps to: dispatchLegs.completedAt
      v.literal('APPROVAL_DATE')        // Maps to: loadPayables.approvedAt
    ),
    autoCarryover: v.boolean(),         // Auto-move held items to next period
    includeStandaloneAdjustments: v.boolean(), // Pull in unassigned bonuses/deductions

    // === Metadata ===
    isActive: v.boolean(),
    createdAt: v.float64(),
    createdBy: v.string(),
    updatedAt: v.optional(v.float64()),
  })
    .index('by_org', ['workosOrgId'])
    .index('by_org_active', ['workosOrgId', 'isActive']),

  /**
   * Dispatch Legs - The atomic unit of work
   * A Load can have multiple Legs (for splits/repowers)
   */
  dispatchLegs: defineTable({
    loadId: v.id('loadInformation'),
    driverId: v.optional(v.id('drivers')),
    // Carrier assignment - references carrierPartnerships for external carriers
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
    // Legacy field - existing data may have this from old carriers table (deprecated)
    carrierId: v.optional(v.string()),
    truckId: v.optional(v.id('trucks')),
    trailerId: v.optional(v.id('trailers')),

    sequence: v.float64(),               // 1, 2, 3...

    // Where does this leg start/end? (References loadStops)
    startStopId: v.id('loadStops'),
    endStopId: v.id('loadStops'),

    // Miles for THIS leg (may differ from total load)
    legLoadedMiles: v.float64(),
    legEmptyMiles: v.float64(),          // Default 0 in V1

    status: v.union(
      v.literal('PENDING'),
      v.literal('ACTIVE'),
      v.literal('COMPLETED'),
      v.literal('CANCELED')
    ),

    workosOrgId: v.string(),
    createdAt: v.float64(),
    updatedAt: v.float64(),
  })
    .index('by_load', ['loadId'])
    .index('by_driver', ['driverId', 'status'])
    .index('by_carrier_partnership', ['carrierPartnershipId', 'status'])
    .index('by_org', ['workosOrgId']),

  /**
   * Load Payables - Calculated pay line items
   * The actual money lines displayed in UI
   * SINGLE SOURCE OF TRUTH for all driver payments
   */
  loadPayables: defineTable({
    loadId: v.optional(v.id('loadInformation')),  // Optional - allows standalone bonuses
    legId: v.optional(v.id('dispatchLegs')),
    driverId: v.id('drivers'),

    description: v.string(),             // e.g., "Base Line Haul", "Manual Bonus"

    // The Math
    quantity: v.float64(),               // Miles, Hours, or 1 (Flat)
    rate: v.float64(),
    totalAmount: v.float64(),

    // Source of Truth flags
    sourceType: v.union(
      v.literal('SYSTEM'),               // Calculated by Rules
      v.literal('MANUAL')                // Added/Edited by User
    ),

    // If TRUE, Rules Engine will NEVER delete/overwrite this row
    isLocked: v.boolean(),

    // Settlement Assignment
    settlementId: v.optional(v.id('driverSettlements')), // Which pay period this belongs to
    
    // Rebillable to Customer (for manual accessorials)
    isRebillable: v.optional(v.boolean()),        // Should this be added to customer invoice?
    rebilledToCustomerId: v.optional(v.id('customers')), // If rebilled, which customer?
    rebilledAmount: v.optional(v.float64()),      // Amount charged to customer (may differ from driver pay)

    // Receipt/Proof for Manual Items
    receiptStorageId: v.optional(v.id('_storage')), // Lumper receipts, etc.
    receiptUploadedAt: v.optional(v.float64()),

    // Traceability
    ruleId: v.optional(v.id('rateRules')),
    warningMessage: v.optional(v.string()), // e.g., "Missing stop times"

    // Approval timestamp (for APPROVAL_DATE payable trigger in Pay Plans)
    approvedAt: v.optional(v.float64()),  // Set when settlement moves to APPROVED

    workosOrgId: v.string(),
    createdAt: v.float64(),
    createdBy: v.string(),
    updatedAt: v.optional(v.float64()),
  })
    .index('by_load', ['loadId'])
    .index('by_driver', ['driverId'])
    .index('by_leg', ['legId'])
    .index('by_org', ['workosOrgId'])
    .index('by_settlement', ['settlementId'])
    .index('by_driver_unassigned', ['driverId', 'settlementId']), // For gathering unassigned payables

  /**
   * Load Documents - Attachments for loads (e.g., extra documentation images)
   */
  loadDocuments: defineTable({
    loadId: v.id('loadInformation'),
    type: v.union(
      v.literal('EXTRA_DOC')
    ),
    storageId: v.id('_storage'),
    fileName: v.optional(v.string()),
    contentType: v.optional(v.string()),
    uploadedAt: v.float64(),
    uploadedBy: v.string(), // WorkOS user ID
    workosOrgId: v.string(),
  })
    .index('by_load', ['loadId'])
    .index('by_load_type', ['loadId', 'type'])
    .index('by_org', ['workosOrgId']),

  /**
   * Load Carrier Payables - Calculated carrier pay line items
   * SINGLE SOURCE OF TRUTH for all carrier payments
   * Mirrors loadPayables structure but for carrier partnerships
   */
  loadCarrierPayables: defineTable({
    loadId: v.optional(v.id('loadInformation')),  // Optional - allows standalone adjustments
    legId: v.optional(v.id('dispatchLegs')),
    carrierPartnershipId: v.id('carrierPartnerships'),

    description: v.string(),             // e.g., "Base Line Haul", "Fuel Surcharge"

    // The Math
    quantity: v.float64(),               // Miles, Hours, or 1 (Flat)
    rate: v.float64(),
    totalAmount: v.float64(),

    // Source of Truth flags
    sourceType: v.union(
      v.literal('SYSTEM'),               // Calculated by Rules
      v.literal('MANUAL')                // Added/Edited by User
    ),

    // If TRUE, Rules Engine will NEVER delete/overwrite this row
    isLocked: v.boolean(),

    // Settlement Assignment
    settlementId: v.optional(v.id('carrierSettlements')), // Which pay period this belongs to

    // Traceability
    ruleId: v.optional(v.id('rateRules')),
    warningMessage: v.optional(v.string()), // e.g., "Missing stop times"

    // Approval timestamp
    approvedAt: v.optional(v.float64()),

    workosOrgId: v.string(),
    createdAt: v.float64(),
    createdBy: v.string(),
    updatedAt: v.optional(v.float64()),
  })
    .index('by_load', ['loadId'])
    .index('by_carrier_partnership', ['carrierPartnershipId'])
    .index('by_leg', ['legId'])
    .index('by_org', ['workosOrgId'])
    .index('by_settlement', ['settlementId'])
    .index('by_carrier_unassigned', ['carrierPartnershipId', 'settlementId']),

  /**
   * Carrier Settlements - Pay Period Statements for Carriers
   * Groups carrier payables into pay periods for approval workflow
   */
  carrierSettlements: defineTable({
    carrierPartnershipId: v.id('carrierPartnerships'),
    workosOrgId: v.string(),

    // Pay Period
    periodStart: v.float64(),           // Unix timestamp
    periodEnd: v.float64(),

    // Settlement Status
    status: v.union(
      v.literal('DRAFT'),               // Building statement
      v.literal('PENDING'),             // Awaiting approval
      v.literal('APPROVED'),            // Locked for payment processing
      v.literal('PAID'),                // Payment completed
      v.literal('DISPUTED')             // Carrier disputed
    ),

    // Totals (denormalized for quick display)
    totalGross: v.float64(),            // Sum of all payables
    totalDeductions: v.optional(v.float64()),
    totalNet: v.float64(),

    // Payment Info
    paidAt: v.optional(v.float64()),
    paidBy: v.optional(v.string()),
    paymentMethod: v.optional(v.string()),     // Check, ACH, Wire
    paymentReference: v.optional(v.string()),  // Check #, Transaction ID

    // Carrier Info (denormalized for historical record)
    carrierName: v.optional(v.string()),
    carrierMcNumber: v.optional(v.string()),

    createdAt: v.float64(),
    createdBy: v.string(),
    updatedAt: v.optional(v.float64()),
    approvedAt: v.optional(v.float64()),
    approvedBy: v.optional(v.string()),
  })
    .index('by_carrier_partnership', ['carrierPartnershipId'])
    .index('by_org', ['workosOrgId'])
    .index('by_status', ['status'])
    .index('by_period', ['periodStart', 'periodEnd']),

  /**
   * Driver Settlements - Pay Period Statements
   * Groups payables into pay periods for approval workflow
   */
  driverSettlements: defineTable({
    driverId: v.id('drivers'),
    workosOrgId: v.string(),

    // Pay Period
    periodStart: v.float64(),           // Unix timestamp
    periodEnd: v.float64(),

    // Pay Plan Link (for auto-calculated periods)
    payPlanId: v.optional(v.id('payPlans')),
    periodNumber: v.optional(v.number()),   // e.g., Week 1, Period 2
    payPlanName: v.optional(v.string()),    // Denormalized for display

    // Settlement Status
    status: v.union(
      v.literal('DRAFT'),               // Accountant building statement
      v.literal('PENDING'),             // Driver can view, awaiting approval
      v.literal('APPROVED'),            // Locked for payment processing
      v.literal('PAID'),                // Payment completed
      v.literal('VOID')                 // Cancelled/reversed
    ),

    // Frozen Totals (calculated when APPROVED)
    grossTotal: v.optional(v.float64()),        // Total gross pay
    totalMiles: v.optional(v.float64()),        // Total miles driven
    totalLoads: v.optional(v.number()),         // Number of loads
    totalManualAdjustments: v.optional(v.float64()), // Sum of manual items

    // Statement Identification
    statementNumber: v.string(),        // e.g., "SET-2025-001"

    // Approval Workflow
    approvedBy: v.optional(v.string()),
    approvedAt: v.optional(v.float64()),

    // Payment Tracking
    paidAt: v.optional(v.float64()),
    paidMethod: v.optional(v.string()), // ACH, Check, Wire, etc.
    paidReference: v.optional(v.string()), // Check number, transaction ID

    // Audit Trail
    notes: v.optional(v.string()),
    voidedBy: v.optional(v.string()),
    voidedAt: v.optional(v.float64()),
    voidReason: v.optional(v.string()),

    // Timestamps
    createdAt: v.float64(),
    createdBy: v.string(),
    updatedAt: v.float64(),
  })
    .index('by_driver', ['driverId'])
    .index('by_driver_status', ['driverId', 'status'])
    .index('by_org_status', ['workosOrgId', 'status'])
    .index('by_period', ['driverId', 'periodStart', 'periodEnd'])
    .index('by_statement_number', ['workosOrgId', 'statementNumber'])
    .index('by_pay_plan', ['payPlanId', 'periodStart']),

  // Organization statistics for fast count queries (aggregate table pattern)
  organizationStats: defineTable({
    workosOrgId: v.string(),
    
    // Load counts by status
    loadCounts: v.object({
      Open: v.number(),
      Assigned: v.number(),
      Completed: v.number(),
      Canceled: v.number(),
    }),
    
    // Invoice counts by status
    invoiceCounts: v.object({
      MISSING_DATA: v.number(),
      DRAFT: v.number(),
      BILLED: v.number(),
      PENDING_PAYMENT: v.number(),
      PAID: v.number(),
      VOID: v.number(),
    }),
    
    // Drift detection
    lastRecalculated: v.optional(v.number()), // Last time counts were recalculated from source
    
    // Timestamps
    updatedAt: v.number(),
  }).index('by_org', ['workosOrgId']),

  // ==========================================
  // DRIVER LOCATION TRACKING
  // For helicopter view and route history polylines
  // ==========================================
  driverLocations: defineTable({
    // References
    driverId: v.id('drivers'),
    loadId: v.id('loadInformation'), // Required - always tracking for a specific load
    organizationId: v.string(), // Same pattern as workosOrgId

    // GPS Data
    latitude: v.float64(),
    longitude: v.float64(),
    accuracy: v.optional(v.float64()), // GPS accuracy in meters
    speed: v.optional(v.float64()), // Speed in m/s
    heading: v.optional(v.float64()), // Direction 0-360 degrees

    // Tracking Context
    trackingType: v.literal('LOAD_ROUTE'), // Continuous from first checkout to last checkout

    // Timestamps
    recordedAt: v.float64(), // Device timestamp (when GPS captured)
    createdAt: v.float64(), // Server timestamp (when synced)
  })
    .index('by_driver_time', ['driverId', 'recordedAt'])
    .index('by_org_time', ['organizationId', 'recordedAt'])
    .index('by_load', ['loadId', 'recordedAt'])
    .index('by_org_created', ['organizationId', 'createdAt']),

  // ==========================================
  // EXTERNAL TRACKING API
  // Partner API keys, webhooks, audit logs
  // ==========================================

  partnerApiKeys: defineTable({
    workosOrgId: v.string(),
    partnerName: v.string(),

    // Key material (never store raw keys - hash only)
    keyPrefix: v.string(),             // First 12 chars for identification (e.g., "otq_live_a1b2")
    keyHash: v.string(),               // SHA-256 hash of full key

    // Scoping
    permissions: v.array(v.string()),  // ["tracking:read", "tracking:subscribe", "tracking:events"]
    allowedLoadSources: v.optional(v.array(v.string())), // Restrict to specific externalSource values
    ipAllowlist: v.optional(v.array(v.string())),        // CIDR ranges

    // Rate limiting (configurable per partner)
    rateLimitTier: v.union(
      v.literal('low'),     // 60/min
      v.literal('medium'),  // 300/min
      v.literal('high'),    // 1000/min
      v.literal('custom')
    ),
    customRateLimit: v.optional(v.number()), // requests/min if tier = "custom"

    // Environment
    environment: v.union(v.literal('sandbox'), v.literal('production')),

    // Lifecycle
    status: v.union(v.literal('ACTIVE'), v.literal('REVOKED'), v.literal('EXPIRED')),
    expiresAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),   // Updated at most once per minute (debounced)

    // Metadata
    createdBy: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.string()),
  })
    .index('by_org', ['workosOrgId', 'status'])
    .index('by_key_prefix', ['keyPrefix'])
    .index('by_key_hash', ['keyHash']),

  webhookSubscriptions: defineTable({
    workosOrgId: v.string(),
    partnerKeyId: v.id('partnerApiKeys'),

    // Webhook config
    url: v.string(),                        // HTTPS only (validated on creation)
    events: v.array(v.string()),            // ["position.update", "status.changed", "tracking.started", "tracking.ended"]
    encryptedSecret: v.string(),            // AES-256-GCM encrypted signing secret

    // Delivery settings
    intervalMinutes: v.number(),            // Default 5
    batchSize: v.optional(v.number()),      // Max positions per payload (default 100)

    // Filter (optional)
    loadSourceFilter: v.optional(v.string()), // Only deliver for specific externalSource

    // Status
    status: v.union(v.literal('ACTIVE'), v.literal('PAUSED'), v.literal('DISABLED')),
    consecutiveFailures: v.number(),         // Auto-disable after 50
    lastDeliveredAt: v.optional(v.number()),
    lastFailureReason: v.optional(v.string()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_org', ['workosOrgId', 'status'])
    .index('by_partner_key', ['partnerKeyId']),

  webhookDeliveryQueue: defineTable({
    subscriptionId: v.id('webhookSubscriptions'),
    workosOrgId: v.string(),

    // Idempotency (partner uses this to deduplicate)
    deliveryId: v.string(),              // Unique per delivery: "dlv_<ulid>"

    // Payload reference
    loadId: v.id('loadInformation'),
    eventType: v.string(),               // "position.update" | "status.changed" | ...
    positionsFrom: v.optional(v.number()), // recordedAt range start
    positionsTo: v.optional(v.number()),   // recordedAt range end

    // Delivery status
    status: v.union(
      v.literal('PENDING'),
      v.literal('DELIVERING'),
      v.literal('DELIVERED'),
      v.literal('FAILED'),
      v.literal('DEAD_LETTER')
    ),
    attempts: v.number(),
    maxAttempts: v.number(),             // Default 5
    nextAttemptAt: v.optional(v.number()), // Exponential backoff with jitter

    // Response tracking
    lastHttpStatus: v.optional(v.number()),
    lastErrorMessage: v.optional(v.string()),
    deliveredAt: v.optional(v.number()),

    createdAt: v.number(),
  })
    .index('by_status_next', ['status', 'nextAttemptAt'])
    .index('by_subscription', ['subscriptionId', 'status'])
    .index('by_delivery_id', ['deliveryId']),

  apiAuditLog: defineTable({
    workosOrgId: v.string(),
    partnerKeyId: v.id('partnerApiKeys'),

    // Request identification
    requestId: v.string(),               // "req_<random>" - propagated in X-Request-Id header

    // Request info
    endpoint: v.string(),
    method: v.string(),
    statusCode: v.number(),

    // Context
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),

    // Performance
    responseTimeMs: v.optional(v.number()),

    // Rate limit state at time of request
    rateLimitRemaining: v.optional(v.number()),

    timestamp: v.number(),
  })
    .index('by_org_time', ['workosOrgId', 'timestamp'])
    .index('by_key_time', ['partnerKeyId', 'timestamp'])
    .index('by_request_id', ['requestId']),

  // ==========================================
  // SANDBOX DATA (isolated from production)
  // ==========================================

  sandboxLoads: defineTable({
    workosOrgId: v.string(),
    internalId: v.string(),
    orderNumber: v.string(),
    externalLoadId: v.optional(v.string()),
    trackingStatus: v.union(
      v.literal('Pending'),
      v.literal('In Transit'),
      v.literal('Completed'),
    ),
    stopCount: v.number(),
    firstStopDate: v.optional(v.string()),
    // Simplified stop data for sandbox
    stops: v.array(v.object({
      sequenceNumber: v.number(),
      stopType: v.union(v.literal('PICKUP'), v.literal('DELIVERY')),
      city: v.string(),
      state: v.string(),
      latitude: v.number(),
      longitude: v.number(),
      status: v.union(v.literal('Pending'), v.literal('Completed')),
      scheduledWindowBegin: v.string(),
      scheduledWindowEnd: v.string(),
      checkedInAt: v.optional(v.string()),
      checkedOutAt: v.optional(v.string()),
    })),
    createdAt: v.number(),
  })
    .index('by_org', ['workosOrgId'])
    .index('by_org_tracking_status', ['workosOrgId', 'trackingStatus'])
    .index('by_internal_id', ['workosOrgId', 'internalId']),

  sandboxPositions: defineTable({
    sandboxLoadId: v.id('sandboxLoads'),
    workosOrgId: v.string(),
    latitude: v.float64(),
    longitude: v.float64(),
    speed: v.optional(v.float64()),
    heading: v.optional(v.float64()),
    accuracy: v.optional(v.float64()),
    recordedAt: v.float64(),
  })
    .index('by_load', ['sandboxLoadId', 'recordedAt'])
    .index('by_org', ['workosOrgId', 'recordedAt']),
});
