// Pay engine schema fragment — new architecture, lives alongside the legacy
// pay tables (rateProfiles, rateRules, loadPayables, driverSettlements, etc.)
// during migration. Tables here are imported into the main schema.ts.
// New tables that would collide with legacy names use the `pay*` prefix
// (payProfiles, payRules) instead of `rate*` — semantically clearer too.
//
// Money fields use v.int64() representing the smallest unit of the stored
// currency. AMOUNTS are *Cents; RATES are *MicroCents (1/1000 cent) to handle
// sub-cent precision common in trucking ($0.555/mi). See convex/lib/money.ts
// for conversion helpers and the rationale.
//
// payeeType is a polymorphic string discriminator over named entities. Current
// values: 'DRIVER' (→ drivers._id), 'CARRIER' (→ carrierPartnerships._id).
// Designed to extend to 'VENDOR', 'RECRUITER', 'BROKER_PARTNER' later.

import { defineTable } from 'convex/server';
import { v } from 'convex/values';

// ============================================================================
// SHARED VALIDATORS — used across multiple pay engine tables
// ============================================================================

export const currencyValidator = v.union(
  v.literal('USD'),
  v.literal('CAD'),
  v.literal('MXN'),
);

export const chargeComponentBucketValidator = v.union(
  v.literal('BASE_WAGE'),
  v.literal('BASE_FRINGE'),
  v.literal('ACCESSORIAL'),
  v.literal('BONUS'),
  v.literal('REIMBURSEMENT'),
  v.literal('DEDUCTION'),
  v.literal('TAX_WITHHOLDING'),
  v.literal('GARNISHMENT'),
);

export const chargeComponentTaxabilityValidator = v.union(
  v.literal('TAXABLE_WAGE'),
  v.literal('FRINGE_TAXABLE'),
  v.literal('FRINGE_NON_TAXABLE'),
  v.literal('PER_DIEM_NONTAXABLE'),
  v.literal('REIMBURSEMENT_ACCOUNTABLE'),
  v.literal('REIMBURSEMENT_NONACCOUNTABLE'),
  v.literal('CONTRACTOR_1099'),
  v.literal('PRE_TAX_DEDUCTION'),
  v.literal('POST_TAX_DEDUCTION'),
  v.literal('TAX_WITHHOLDING'),
  v.literal('GARNISHMENT'),
  v.literal('NONE'),
);

export const chargeComponentAppliesToValidator = v.union(
  v.literal('PAY'),
  v.literal('BILL'),
);

// ============================================================================
// chargeComponents — catalog of WHAT a line item counts as
// ============================================================================
//
// Org-scoped catalog. Seeded with standard templates on org creation; orgs
// can clone, customize, or add their own. Components are referenced by:
//   - payRules.componentId (drives bucketing of rule-derived earnings)
//   - payItems.componentId (every ledger line carries a component)
//   - recurringItemDefinitions.componentId
//   - billing-side rules (when applicable)
//
// The bucket determines where the component appears on the paycheck and how
// it groups in reporting. The taxability drives W2/1099/payroll engine input.
// PAY+BILL applicability lets one component definition serve both sides of
// the money flow (driver detention paid AND customer detention charged), so
// the two sides can never drift in name, reporting, or categorization.

export const chargeComponents = defineTable({
  workosOrgId: v.string(),

  code: v.string(),                              // unique per org; e.g. "HEALTH_WELFARE"
  displayName: v.string(),
  description: v.optional(v.string()),

  bucket: chargeComponentBucketValidator,
  sign: v.union(v.literal('CREDIT'), v.literal('DEBIT')),

  taxability: chargeComponentTaxabilityValidator,

  // Deduction ordering — applied lowest priority first.
  // 1=garnishment, 2=tax, 3=pre-tax benefit, 4=post-tax mandatory, 5+=voluntary.
  // CCPA disposable-earnings cap checked between garnishment and other deductions.
  deductionPriority: v.optional(v.number()),
  isLegallyProtected: v.optional(v.boolean()),
  countsTowardCcpaLimit: v.optional(v.boolean()),

  // Reporting fan-out for W2/1099/WH-347/GL export
  reporting: v.optional(v.object({
    w2Box: v.optional(v.string()),               // "1", "12-DD", "14-..."
    form1099Box: v.optional(v.string()),
    wh347Column: v.optional(v.string()),         // certified payroll
    glAccount: v.optional(v.string()),
    payrollCode: v.optional(v.string()),
    revenueRecognitionCategory: v.optional(v.string()),
  })),

  // Remittance — for components paid to a third-party vendor
  remittance: v.optional(v.object({
    vendorName: v.optional(v.string()),
    cadence: v.optional(v.union(
      v.literal('WEEKLY'),
      v.literal('BIWEEKLY'),
      v.literal('MONTHLY'),
      v.literal('QUARTERLY'),
    )),
    externalAccountRef: v.optional(v.string()),
  })),

  // PAY/BILL applicability — one component can serve both sides
  appliesTo: v.array(chargeComponentAppliesToValidator),

  // Link pay-side and bill-side definitions of the same concept
  pairedComponentId: v.optional(v.id('chargeComponents')),

  // Advisory jurisdiction — UI warns, calc never silently skips
  jurisdiction: v.optional(v.object({
    countries: v.optional(v.array(v.string())),
    states: v.optional(v.array(v.string())),
    contractTags: v.optional(v.array(v.string())),
  })),

  currency: v.optional(currencyValidator),       // null = inherit from profile/payItem

  templateId: v.optional(v.string()),            // lineage from seeded template
  isActive: v.boolean(),

  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
})
  .index('by_org_active', ['workosOrgId', 'isActive'])
  .index('by_org_code', ['workosOrgId', 'code'])
  .index('by_org_bucket', ['workosOrgId', 'bucket', 'isActive'])
  .index('by_org_template', ['workosOrgId', 'templateId']);

// ============================================================================
// More shared validators used by the rest of the pay engine
// ============================================================================

export const paymentMethodValidator = v.union(
  v.literal('ACH'),
  v.literal('CHECK'),
  v.literal('WIRE'),
  v.literal('QUICKPAY'),
);

export const externalReferenceValidator = v.object({
  system: v.string(),                            // "QUICKBOOKS", "SYMMETRY", "MODERN_TREASURY"
  refType: v.string(),                           // "JOURNAL_ENTRY_ID", "ACH_TRACE", etc.
  refValue: v.string(),
  recordedAt: v.number(),
});

// ============================================================================
// fuelSurchargeCalculators — shared FSC calc, consumed by pay AND billing
// ============================================================================

export const fuelSurchargeCalculators = defineTable({
  workosOrgId: v.string(),
  name: v.string(),                              // "DOE National, $1.20 base, $0.04 step"

  indexSource: v.union(
    v.literal('DOE_NATIONAL'),
    v.literal('DOE_REGIONAL'),
    v.literal('CUSTOM'),
  ),
  regionCode: v.optional(v.string()),            // for DOE_REGIONAL

  // Diesel price values are quoted with sub-cent precision (e.g. $4.099/gal),
  // so these use micro-cents (1/1000 cent). See convex/lib/money.ts.
  basePriceMicroCents: v.int64(),
  stepIncrementMicroCents: v.int64(),
  stepSurchargeMicroCents: v.int64(),            // $/mile per step

  payApplicability: v.optional(v.object({
    percentOfBilledBps: v.number(),              // 10000 = 100%
    componentId: v.id('chargeComponents'),       // typically FUEL_SURCHARGE_PAY
  })),
  billApplicability: v.optional(v.object({
    componentId: v.id('chargeComponents'),       // typically FUEL_SURCHARGE_BILL
  })),

  isActive: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
})
  .index('by_org_active', ['workosOrgId', 'isActive']);

// ============================================================================
// payeeBankAccounts — encrypted bank info for ACH/wire
// ============================================================================
//
// Account/routing numbers are encrypted application-side with a per-org KMS
// key (the encryption step lives in the application layer; this table just
// stores the ciphertext). The *Last4 fields are queryable for display.

export const payeeBankAccounts = defineTable({
  workosOrgId: v.string(),
  payeeType: v.string(),
  payeeId: v.string(),

  routingNumberEncrypted: v.string(),
  accountNumberEncrypted: v.string(),
  routingNumberLast4: v.string(),
  accountNumberLast4: v.string(),

  accountType: v.union(v.literal('CHECKING'), v.literal('SAVINGS')),
  accountHolderName: v.string(),
  bankName: v.optional(v.string()),
  currency: currencyValidator,

  verificationStatus: v.union(
    v.literal('UNVERIFIED'),
    v.literal('MICRO_DEPOSIT_PENDING'),
    v.literal('VERIFIED'),
    v.literal('FAILED'),
  ),
  verifiedAt: v.optional(v.number()),

  isDefault: v.boolean(),
  isActive: v.boolean(),

  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
})
  .index('by_payee_active', ['payeeType', 'payeeId', 'isActive', 'isDefault']);

// ============================================================================
// payeeTaxStatus — W-9/W-8 status, backup withholding, classification
// ============================================================================

export const payeeTaxStatus = defineTable({
  workosOrgId: v.string(),
  payeeType: v.string(),
  payeeId: v.string(),

  // W-9 / W-8 status
  tinOnFile: v.boolean(),
  tinLast4: v.optional(v.string()),
  tinType: v.optional(v.union(
    v.literal('SSN'), v.literal('EIN'), v.literal('ITIN'),
  )),
  w9CollectedAt: v.optional(v.number()),
  w9StorageId: v.optional(v.string()),

  // Backup withholding
  backupWithholdingRequired: v.boolean(),
  backupWithholdingReason: v.optional(v.union(
    v.literal('NO_TIN'),
    v.literal('IRS_B_NOTICE'),
    v.literal('IRS_C_NOTICE'),
  )),
  irsNoticeReceivedAt: v.optional(v.number()),

  // Domicile (default work jurisdiction)
  domicileCountry: v.optional(v.string()),
  domicileState: v.optional(v.string()),

  // Employment classification
  classification: v.optional(v.union(
    v.literal('W2_EMPLOYEE'),
    v.literal('1099_CONTRACTOR'),
    v.literal('CARRIER_VENDOR'),
  )),

  createdAt: v.number(),
  updatedAt: v.number(),
  updatedBy: v.string(),
})
  .index('by_payee', ['payeeType', 'payeeId'])
  .index('by_org_backupReq', ['workosOrgId', 'backupWithholdingRequired']);

// ============================================================================
// payProfiles — jurisdiction-tagged rule bundles
// ============================================================================
//
// Named `payProfiles` (not `rateProfiles`) to avoid collision with the legacy
// rateProfiles table during migration, AND because "pay profile" is the more
// semantic name — it describes HOW WE PAY a payee, not just rates. Same goes
// for `payRules` (vs legacy `rateRules`).

export const payProfiles = defineTable({
  workosOrgId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),

  payeeType: v.string(),                         // 'DRIVER' | 'CARRIER' | ...

  // Advisory display category — profiles can mix triggers via rules
  payBasis: v.union(
    v.literal('MILEAGE'),
    v.literal('HOURLY'),
    v.literal('PERCENTAGE'),
    v.literal('FLAT'),
    v.literal('HYBRID'),
  ),

  // Jurisdiction tagging — drives JURISDICTION selection strategy
  country: v.optional(v.string()),               // "US", "CA", "MX"
  state: v.optional(v.string()),                 // "US-CA", "CA-QC", "MX-NL"
  contractTag: v.optional(v.string()),           // "DAVIS_BACON", "UNION_70"

  currency: currencyValidator,                   // REQUIRED — locks profile currency

  // Post-calc rules fire at settlement-build time, after per-leg calcs.
  // Used for minimum guarantees, OT premiums, maximum caps.
  postCalcRules: v.optional(v.array(v.object({
    name: v.string(),
    kind: v.union(
      v.literal('MINIMUM_GUARANTEE_PERIOD'),
      v.literal('MINIMUM_GUARANTEE_DAILY'),
      v.literal('MAXIMUM_CAP_PERIOD'),
      v.literal('OVERTIME_PREMIUM'),             // hours > threshold at multiplier
      v.literal('SHIFT_DIFFERENTIAL'),
    ),
    componentId: v.id('chargeComponents'),
    thresholdCents: v.optional(v.int64()),
    thresholdQty: v.optional(v.number()),        // e.g. 40 hours for OT
    multiplierBps: v.optional(v.number()),       // 15000 = 1.5x
    sortOrder: v.number(),
  }))),

  isDefault: v.optional(v.boolean()),
  isActive: v.boolean(),
  templateId: v.optional(v.string()),

  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
  // Last actor who touched the profile — stamped by every profile mutation,
  // including rule edits that bump updatedAt. Optional for pre-existing rows;
  // readers fall back to createdBy.
  updatedBy: v.optional(v.string()),
})
  .index('by_org_active', ['workosOrgId', 'isActive'])
  .index('by_org_payeeType', ['workosOrgId', 'payeeType', 'isActive'])
  .index('by_org_jurisdiction', ['workosOrgId', 'country', 'state', 'contractTag', 'isActive']);

// ============================================================================
// payRules — individual rules inside a payProfile
// ============================================================================

export const payRules = defineTable({
  profileId: v.id('payProfiles'),
  name: v.string(),
  componentId: v.id('chargeComponents'),

  // Trigger as expression object — extensible without engine changes.
  // `source` is a dotted path resolved against (leg, load, stops, driver, days)
  // context at calc time. `filter` is an optional predicate. `transform` shapes
  // the raw value (e.g. minutes → hours for TIME_WAITING).
  trigger: v.object({
    source: v.string(),                          // "leg.legLoadedMiles", "stops.dwellMinutes"
    transform: v.optional(v.union(
      v.literal('IDENTITY'),
      v.literal('HOURS_FROM_MINUTES'),
      v.literal('COUNT'),                        // .length on array sources
      v.literal('SUM'),                          // sum across array sources
      v.literal('PERCENT'),                      // rate reinterpreted as micro-pct-points
                                                  // (100% = 100,000,000); see money.ts
    )),
    filter: v.optional(v.string()),              // optional predicate, e.g.
                                                 // "load.isHazmat === true"
                                                 // "stops.index > 2"
                                                 // "leg.workState === 'CA'"
  }),

  // Rate is either flat or tiered. Engine uses tieredRate when present.
  // Rates use MicroCents (1/1000 cent) for sub-cent precision.
  rateAmountMicroCents: v.optional(v.int64()),
  tieredRate: v.optional(v.array(v.object({
    minQty: v.number(),                          // inclusive lower bound
    maxQty: v.optional(v.number()),              // inclusive; null = open-ended top
    rateMicroCents: v.int64(),
  }))),

  minThreshold: v.optional(v.number()),          // skip rule if qty < threshold
  maxCap: v.optional(v.number()),                // cap qty at this value
  minAmountCents: v.optional(v.int64()),         // floor for resulting amount
  maxAmountCents: v.optional(v.int64()),         // cap for resulting amount

  equipmentTypeCondition: v.optional(v.string()),
  customerCondition: v.optional(v.string()),     // customer _id as string; cross-table

  isActive: v.boolean(),
  sortOrder: v.number(),

  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
})
  .index('by_profile_active', ['profileId', 'isActive', 'sortOrder'])
  .index('by_component', ['componentId']);

// ============================================================================
// payeeProfileAssignments — links payees to rate profiles (new, unified)
// ============================================================================

export const payeeProfileAssignments = defineTable({
  workosOrgId: v.string(),
  payeeType: v.string(),
  payeeId: v.string(),
  profileId: v.id('payProfiles'),

  isDefault: v.optional(v.boolean()),
  selectionStrategy: v.union(
    v.literal('ALWAYS_ACTIVE'),
    v.literal('DISTANCE_THRESHOLD'),
    v.literal('JURISDICTION'),                   // match load.contractTag + leg.workState
    v.literal('MANUAL_ONLY'),
  ),

  thresholdValue: v.optional(v.number()),        // for DISTANCE_THRESHOLD
  matchState: v.optional(v.string()),            // for JURISDICTION
  matchContractTag: v.optional(v.string()),      // for JURISDICTION

  effectiveStart: v.optional(v.number()),
  effectiveEnd: v.optional(v.number()),
  isActive: v.boolean(),

  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
})
  .index('by_payee_active', ['payeeType', 'payeeId', 'isActive'])
  .index('by_profile', ['profileId'])
  .index('by_org_payee', ['workosOrgId', 'payeeType', 'payeeId']);

// ============================================================================
// recurringItemDefinitions — templates that emit payItems each period
// ============================================================================
//
// The TEMPLATE lives here; the materialized payItem lives in payItems with
// kind='RECURRING'. Materialization happens at settlement-build time.

export const recurringItemDefinitions = defineTable({
  workosOrgId: v.string(),
  payeeType: v.string(),
  payeeId: v.string(),

  componentId: v.id('chargeComponents'),
  description: v.string(),                       // "Truck lease — Volvo 2022 #4521"

  amountCents: v.int64(),
  currency: currencyValidator,

  frequency: v.union(
    v.literal('PER_PERIOD'),
    v.literal('WEEKLY'),
    v.literal('BIWEEKLY'),
    v.literal('MONTHLY'),
    v.literal('QUARTERLY'),
    v.literal('ANNUALLY'),
  ),

  effectiveStart: v.number(),
  effectiveEnd: v.optional(v.number()),

  // Installment tracking — for finite-balance items like truck leases
  totalInstallments: v.optional(v.number()),
  installmentsCompleted: v.optional(v.number()),
  originalBalanceCents: v.optional(v.int64()),
  remainingBalanceCents: v.optional(v.int64()),

  // Idempotency — tracks last application so regenerate doesn't double-charge
  lastAppliedPeriodEnd: v.optional(v.number()),
  lastAppliedPayItemId: v.optional(v.id('payItems')),

  isActive: v.boolean(),
  pausedReason: v.optional(v.string()),

  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
})
  .index('by_payee_active', ['payeeType', 'payeeId', 'isActive'])
  .index('by_org_active', ['workosOrgId', 'isActive']);

// ============================================================================
// payItems — UNIFIED LEDGER. Every pay-side transaction lives here.
// ============================================================================
//
// This is the core of the pay engine. Every line that affects a settlement —
// earnings, expenses, advances, recurring deductions, withholdings, manual
// adjustments — is a payItem. Discriminator is `kind`. Operational lifecycle
// (pending → applied → settled) lives on the row via `lifecycleStatus`, so
// money codes and trip expenses don't need separate tables.
//
// Append-only: edits void prior rows (isVoided=true, supersededByPayItemId
// pointing forward) and insert replacements. Queries filter isVoided=false
// by default. Audit trail preserved forever.

export const payItems = defineTable({
  workosOrgId: v.string(),

  payeeType: v.string(),
  payeeId: v.string(),

  kind: v.union(
    v.literal('EARNING'),                        // rule-derived from work
    v.literal('NEGOTIATED'),                     // flat carrier rate
    v.literal('TRIP_EXPENSE'),                   // toll, hotel, etc.
    v.literal('MONEY_CODE'),                     // advance, lumper, comcheck
    v.literal('RECURRING'),                      // lease, insurance per period
    v.literal('TAX_WITHHOLDING'),                // from tax engine
    v.literal('GARNISHMENT'),
    v.literal('POST_CALC_ADJUSTMENT'),           // guarantee makeup, OT premium
    v.literal('MANUAL_ADJUSTMENT'),
    v.literal('REVERSAL'),                       // explicit reversal of a prior row
  ),

  componentId: v.id('chargeComponents'),

  // Lifecycle — items with operational stages before settlement (money codes,
  // trip expenses) traverse PENDING_* states; EARNING/NEGOTIATED jump direct
  // to APPLIED when written.
  lifecycleStatus: v.union(
    v.literal('PENDING_APPROVAL'),               // trip expense awaiting approval
    v.literal('PENDING_APPLICATION'),            // approved/issued, not yet on settlement
    v.literal('APPLIED'),                        // attached to a settlement
    v.literal('REJECTED'),
    v.literal('CANCELLED'),
  ),

  description: v.string(),
  quantity: v.number(),
  rateMicroCents: v.int64(),                     // rate in 1/1000 of a cent
  amountCents: v.int64(),                        // qty × rate, signed per component
  currency: currencyValidator,                   // frozen at write time

  periodAnchorAt: v.number(),                    // delivery/completion/approval/issue ts
  settlementId: v.optional(v.id('settlements')),

  // Work jurisdiction — for multi-state tax allocation
  workJurisdiction: v.optional(v.object({
    country: v.string(),
    state: v.optional(v.string()),
    allocation: v.optional(v.array(v.object({
      state: v.string(),
      portionBps: v.number(),                    // basis points; sums to 10000
    }))),
  })),

  // Source traceability — points back to whatever produced this row
  sourceRef: v.object({
    kind: v.union(
      v.literal('RATE_RULE'),
      v.literal('NEGOTIATED_RATE'),
      v.literal('TRIP_EXPENSE_MANUAL'),
      v.literal('MONEY_CODE_ISSUED'),
      v.literal('RECURRING_DEFINITION'),
      v.literal('TAX_ENGINE'),
      v.literal('GARNISHMENT_ORDER'),
      v.literal('POST_CALC_RULE'),
      v.literal('MANUAL'),
      v.literal('REVERSAL_OF'),
      v.literal('LEGACY_IMPORT'),                // for migrating historical rows
    ),
    id: v.optional(v.string()),                  // FK to source row (table varies by kind)
    loadId: v.optional(v.id('loadInformation')),
    legId: v.optional(v.id('dispatchLegs')),
    // Shift-based driver pay: one payItem per session (no legId — a shift spans
    // 0..N legs). Mirrors legacy loadPayables.sessionId. Idempotency key for the
    // session-pay path (see by_session index).
    sessionId: v.optional(v.id('driverSessions')),
  }),

  // Kind-specific payload. Each variant carries `_variant` as discriminator
  // for safe TS narrowing; redundant with `kind` but prevents structural
  // ambiguity in Convex's v.union matching.
  sourceData: v.optional(v.union(
    v.object({
      _variant: v.literal('MONEY_CODE'),
      type: v.union(
        v.literal('CASH_ADVANCE'),
        v.literal('FUEL_ADVANCE'),
        v.literal('COMCHECK'),
        v.literal('LUMPER_FEE'),
        v.literal('ADVANCE_PAYBACK'),
        v.literal('BONUS_PAYMENT'),
        v.literal('TOOL_SUPPLY'),
        v.literal('OTHER'),
      ),
      codeNumber: v.string(),
      issuedAt: v.number(),
      issuedBy: v.string(),
      recoversPayItemId: v.optional(v.id('payItems')),
    }),
    v.object({
      _variant: v.literal('TRIP_EXPENSE'),
      category: v.union(
        v.literal('TOLL'),
        v.literal('FUEL'),
        v.literal('SCALE'),
        v.literal('MEAL'),
        v.literal('LODGING'),
        v.literal('PARKING'),
        v.literal('REPAIR'),
        v.literal('DAMAGE'),
        v.literal('OTHER'),
      ),
      incurredAt: v.number(),
      receiptStorageId: v.optional(v.string()),
      approvedBy: v.optional(v.string()),
      approvedAt: v.optional(v.number()),
      rejectionReason: v.optional(v.string()),
      isRebillable: v.boolean(),
      rebilledToCustomerId: v.optional(v.id('customers')),
      rebilledOnInvoiceId: v.optional(v.id('loadInvoices')),
    }),
    v.object({
      _variant: v.literal('RECURRING'),
      definitionId: v.id('recurringItemDefinitions'),
      installmentNumber: v.optional(v.number()),
      remainingBalanceCents: v.optional(v.int64()),
    }),
    v.object({
      _variant: v.literal('EARNING'),
      ruleId: v.id('payRules'),
      profileIdSnapshot: v.id('payProfiles'),
      triggerSnapshot: v.string(),               // JSON of trigger at calc time
    }),
    v.object({
      _variant: v.literal('NEGOTIATED'),
      carrierAssignmentId: v.id('loadCarrierAssignments'),
    }),
    v.object({
      _variant: v.literal('TAX_WITHHOLDING'),
      taxEngineRunId: v.optional(v.id('taxEngineRuns')),
      jurisdictionCode: v.string(),              // "US-FED", "US-CA", "US-CA-LA"
      withholdingType: v.optional(v.string()),   // "FIT", "SS", "MEDICARE", "SDI"
      garnishmentOrderId: v.optional(v.string()),
    }),
    v.object({
      _variant: v.literal('POST_CALC_ADJUSTMENT'),
      postCalcRuleName: v.string(),
      profileIdSnapshot: v.id('payProfiles'),
    }),
    v.object({
      _variant: v.literal('MANUAL_ADJUSTMENT'),
      reason: v.string(),
      createdViaTemplate: v.optional(v.string()),
    }),
    v.object({
      _variant: v.literal('REVERSAL'),
      reversedPayItemId: v.id('payItems'),
      reversalReason: v.string(),
    }),
    v.object({
      _variant: v.literal('LEGACY_IMPORT'),
      legacyTable: v.string(),                   // "loadPayables", "driverSettlements"
      legacyRowId: v.string(),
      legacyCategory: v.optional(v.string()),
      legacyCalcSnapshot: v.string(),            // JSON of original row
      backfillRunId: v.string(),
      backfilledAt: v.number(),
    }),
  )),

  // Edit protection
  isLocked: v.boolean(),                         // recalc respects locked rows

  // Append-only — void prior rows instead of deleting
  isVoided: v.boolean(),
  voidedAt: v.optional(v.number()),
  voidedByRunId: v.optional(v.string()),         // recalc run id or user action id
  voidReason: v.optional(v.string()),
  supersededByPayItemId: v.optional(v.id('payItems')),

  // Partial holdback — pay item exists but a portion is held pending dispute
  holdback: v.optional(v.object({
    amountCents: v.int64(),
    reason: v.string(),
    holdUntil: v.optional(v.number()),
    relatedDisputeId: v.optional(v.id('settlementDisputes')),
  })),

  warning: v.optional(v.string()),

  // Reviewer edit (append-only): a review-time correction VOIDS the system row
  // and inserts a locked replacement carrying this block. Mirrors legacy
  // loadPayables.editedAt / originalTotalAmount / overrideStartAt, but honors
  // the immutable ledger — the pre-edit row survives as the voided predecessor
  // (supersedesPayItemId). This block is a denormalized convenience for the
  // review UI PLUS the drift ("rules changed") flag: when a later recalc would
  // compute a different amount than the human correction, the edit WINS (no
  // duplicate row) and engineAmountCents/engineDivergedAt record the divergence
  // so the reviewer can adopt the engine value (see adoptEngineAmount).
  reviewerEdit: v.optional(v.object({
    editedAt: v.number(),
    editedBy: v.string(),
    reason: v.optional(v.string()),
    // shift-hours correction span (mirrors legacy overrideStartAt/EndAt/breakMinutes)
    overrideStartAt: v.optional(v.number()),
    overrideEndAt: v.optional(v.number()),
    breakMinutes: v.optional(v.number()),
    // pre-edit snapshot (also recoverable by walking supersedesPayItemId)
    supersedesPayItemId: v.id('payItems'),
    originalQuantity: v.number(),
    originalRateMicroCents: v.int64(),
    originalAmountCents: v.int64(),
    // drift flag: what a later recalc computed, if it diverged from this edit
    engineAmountCents: v.optional(v.int64()),
    engineDivergedAt: v.optional(v.number()),
  })),

  externalReferences: v.optional(v.array(externalReferenceValidator)),

  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
  lastEditedBy: v.optional(v.string()),
})
  .index('by_settlement', ['settlementId', 'isVoided'])
  .index('by_payee_lifecycle', ['payeeType', 'payeeId', 'lifecycleStatus', 'isVoided'])
  .index('by_payee_unsettled', ['payeeType', 'payeeId', 'settlementId', 'isVoided'])
  .index('by_payee_period', ['payeeType', 'payeeId', 'periodAnchorAt', 'isVoided'])
  .index('by_load_payee', ['sourceRef.loadId', 'payeeType', 'payeeId'])
  .index('by_session', ['sourceRef.sessionId', 'isVoided'])
  .index('by_kind_org', ['workosOrgId', 'kind', 'periodAnchorAt'])
  .index('by_component', ['componentId', 'periodAnchorAt'])
  .index('by_org_lifecycle', ['workosOrgId', 'lifecycleStatus', 'isVoided']);

// ============================================================================
// settlements — period statements (new shape, parallel to legacy)
// ============================================================================

export const settlements = defineTable({
  workosOrgId: v.string(),
  statementNumber: v.string(),                   // "SET-2026-001"

  payeeType: v.string(),
  payeeId: v.string(),

  // Period source. Drivers settle on a pay plan; carriers have no plan and
  // settle on a Net-X payment term off the partnership. `payPlanId` stays for
  // the driver path (and back-compat with existing rows), but is now optional
  // so carriers can omit it. `periodSource` is the discriminated truth.
  payPlanId: v.optional(v.id('payPlans')),
  periodSource: v.optional(v.union(
    v.object({ kind: v.literal('PAY_PLAN'), payPlanId: v.id('payPlans') }),
    v.object({
      kind: v.literal('CARRIER_TERMS'),
      paymentTerms: v.optional(v.string()),        // e.g. "Net15" from carrierPartnerships.defaultPaymentTerms
      cadence: v.optional(v.string()),             // cadenceFromPaymentTerms() output, for display
    }),
  )),
  periodStart: v.number(),
  periodEnd: v.number(),

  currency: currencyValidator,

  status: v.union(
    v.literal('OPEN'),
    v.literal('IN_REVIEW'),
    v.literal('VERIFIED'),
    v.literal('SENT'),
    v.literal('PAID'),
    v.literal('CLOSED'),
    v.literal('VOID'),
  ),

  // Concurrent-edit lock for IN_REVIEW state
  reviewLock: v.optional(v.object({
    lockedBy: v.string(),
    lockedAt: v.number(),
    lockExpiresAt: v.number(),
  })),

  totals: v.object({
    earningsCents: v.int64(),
    bonusesCents: v.int64(),
    creditsCents: v.int64(),
    deductionsCents: v.int64(),                  // stored positive; subtracted at display
    taxWithholdingCents: v.int64(),
    garnishmentsCents: v.int64(),
    adjustmentsCents: v.int64(),
    grossCents: v.int64(),                       // earnings + bonuses + credits
    netCents: v.int64(),                         // gross - debits ± adjustments
    holdbackTotalCents: v.int64(),
    itemCount: v.number(),
  }),

  // Per-component rollup — materialized for fast PDF/statement render
  componentTotals: v.array(v.object({
    componentId: v.id('chargeComponents'),
    componentCode: v.string(),                   // cached for export rendering
    bucket: v.string(),
    quantity: v.number(),
    amountCents: v.int64(),
    payItemCount: v.number(),
  })),

  // Per-state work allocation — feeds tax engine for multi-state withholding
  jurisdictionTotals: v.optional(v.array(v.object({
    country: v.string(),
    state: v.optional(v.string()),
    workQuantity: v.number(),                    // miles or hours
    earningsCents: v.int64(),
  }))),

  variances: v.optional(v.array(v.object({
    level: v.union(v.literal('INFO'), v.literal('WARNING'), v.literal('FLAG')),
    code: v.string(),                            // "MILES_VARIANCE", "MISSING_STOP_TIME"
    message: v.string(),
    payItemId: v.optional(v.id('payItems')),
  }))),

  // Reviewer-acknowledged blockers — a hard blocker with an ack no longer gates
  // the ready bucket (mirrors legacy driverSettlements.acknowledgedBlockers).
  acknowledgedBlockers: v.optional(v.array(v.object({
    key: v.string(),
    by: v.string(),
    at: v.number(),
    note: v.optional(v.string()),
  }))),

  // Lifecycle audit trail
  reviewStartedAt: v.optional(v.number()),
  reviewedBy: v.optional(v.string()),
  verifiedAt: v.optional(v.number()),
  verifiedBy: v.optional(v.string()),
  // Reopen audit — set when a VERIFIED settlement is unlocked back to OPEN to
  // correct a mistake (cleared again on the next verification/approval).
  reopenedAt: v.optional(v.number()),
  reopenedBy: v.optional(v.string()),
  reopenReason: v.optional(v.string()),
  sentAt: v.optional(v.number()),
  sentTo: v.optional(v.string()),
  statementPdfStorageId: v.optional(v.string()),
  paidAt: v.optional(v.number()),
  paidBy: v.optional(v.string()),
  closedAt: v.optional(v.number()),
  closedBy: v.optional(v.string()),
  voidedAt: v.optional(v.number()),
  voidedBy: v.optional(v.string()),
  voidReason: v.optional(v.string()),

  payoutBatchId: v.optional(v.id('payoutBatches')),
  paymentMethod: v.optional(paymentMethodValidator),
  paymentReference: v.optional(v.string()),

  // Integrations
  glExportRunId: v.optional(v.id('glExportRuns')),
  taxEngineRunId: v.optional(v.id('taxEngineRuns')),
  externalReferences: v.optional(v.array(externalReferenceValidator)),

  notes: v.optional(v.string()),

  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
})
  .index('by_payee_period', ['payeeType', 'payeeId', 'periodStart'])
  .index('by_org_status', ['workosOrgId', 'status', 'periodStart'])
  // Payee-scoped status reads (settlements dashboard): a driver query must not
  // page the org's carrier statements and vice versa. Sorted by periodStart so
  // `.order('desc')` on the settled lists yields most-recent-first pages that
  // are already filtered to one party — no post-filter, no diluted pages.
  .index('by_org_payee_status', ['workosOrgId', 'payeeType', 'status', 'periodStart'])
  .index('by_payoutBatch', ['payoutBatchId'])
  .index('by_org_statementNumber', ['workosOrgId', 'statementNumber'])
  .index('by_org_glPending', ['workosOrgId', 'glExportRunId']);

// Statuses at/after which a settlement is FROZEN — the single source of truth for
// that boundary across the pay engine: the aggregator no longer re-runs it, the
// write layer blocks edits/acks/adjustments, the read adapter reads its stamped
// membership instead of the live period window, and manual-sync rolls new lines
// forward past it. Keep this in sync with the `settlements.status` union above.
export const FINALIZED_SETTLEMENT_STATUSES: ReadonlySet<string> = new Set([
  'VERIFIED', 'SENT', 'PAID', 'CLOSED', 'VOID',
]);

// ============================================================================
// settlementDisputes — payee-raised disputes on a settlement
// ============================================================================

export const settlementDisputes = defineTable({
  workosOrgId: v.string(),
  settlementId: v.id('settlements'),

  raisedBy: v.string(),                          // payee user id
  raisedAt: v.number(),

  disputedPayItemIds: v.array(v.id('payItems')),
  reason: v.string(),
  evidenceStorageIds: v.optional(v.array(v.string())),

  status: v.union(
    v.literal('OPEN'),
    v.literal('UNDER_REVIEW'),
    v.literal('RESOLVED_IN_FAVOR'),
    v.literal('RESOLVED_AGAINST'),
    v.literal('PARTIAL_RESOLUTION'),
    v.literal('WITHDRAWN'),
  ),

  resolution: v.optional(v.object({
    adjustmentPayItemId: v.optional(v.id('payItems')),
    resolvedBy: v.string(),
    resolvedAt: v.number(),
    notes: v.string(),
  })),

  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_settlement', ['settlementId'])
  .index('by_org_status', ['workosOrgId', 'status', 'raisedAt']);

// ============================================================================
// payoutBatches — groups VERIFIED settlements for a single payment run
// ============================================================================

export const payoutBatches = defineTable({
  workosOrgId: v.string(),
  batchNumber: v.string(),                       // "PB-2026-001"

  paymentMethod: paymentMethodValidator,
  currency: currencyValidator,                   // all settlements in batch share currency

  status: v.union(
    v.literal('DRAFT'),
    v.literal('READY'),                          // locked, ready for export
    v.literal('EXPORTED'),                       // ACH file generated / checks printed
    v.literal('SUBMITTED'),                      // sent to bank / processor
    v.literal('COMPLETED'),                      // funds confirmed moved
    v.literal('PARTIALLY_FAILED'),               // some settlements failed individually
    v.literal('FAILED'),                         // batch-level failure
    v.literal('CANCELLED'),
  ),

  settlementCount: v.number(),
  totalAmountCents: v.int64(),

  // Export artifacts
  achFileStorageId: v.optional(v.string()),
  checkPdfStorageId: v.optional(v.string()),
  exportedAt: v.optional(v.number()),
  exportedBy: v.optional(v.string()),

  submittedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  failureReason: v.optional(v.string()),

  // Per-settlement results for partial failures
  perSettlementResults: v.optional(v.array(v.object({
    settlementId: v.id('settlements'),
    status: v.union(
      v.literal('SUCCESS'),
      v.literal('FAILED'),
      v.literal('PENDING'),
    ),
    failureReason: v.optional(v.string()),
    externalReference: v.optional(v.string()),
  }))),

  scheduledFor: v.optional(v.number()),          // effective date for ACH

  externalReferences: v.optional(v.array(externalReferenceValidator)),

  createdAt: v.number(),
  updatedAt: v.number(),
  createdBy: v.string(),
})
  .index('by_org_status', ['workosOrgId', 'status', 'createdAt'])
  .index('by_org_method', ['workosOrgId', 'paymentMethod', 'status']);

// ============================================================================
// taxEngineRuns — idempotent record of tax-engine invocations
// ============================================================================

export const taxEngineRuns = defineTable({
  workosOrgId: v.string(),

  settlementId: v.id('settlements'),
  engineVendor: v.string(),                      // "SYMMETRY", "GUSTO_EMBEDDED", "CHECK"
  engineVersion: v.string(),

  // Idempotency: same input fingerprint = same expected output. If the
  // settlement changes, fingerprint differs, and a fresh run is required.
  inputFingerprint: v.string(),
  resultFingerprint: v.optional(v.string()),

  status: v.union(
    v.literal('PENDING'),
    v.literal('SUCCESS'),
    v.literal('FAILED'),
    v.literal('SUPERSEDED'),                     // re-run with new input
  ),

  // Materialized output → payItems with sourceRef.kind=TAX_ENGINE
  emittedPayItemIds: v.optional(v.array(v.id('payItems'))),

  errorMessage: v.optional(v.string()),
  ranAt: v.number(),
  durationMs: v.optional(v.number()),
  externalRunId: v.optional(v.string()),

  createdAt: v.number(),
  createdBy: v.string(),
})
  .index('by_settlement', ['settlementId', 'status'])
  .index('by_org_ranAt', ['workosOrgId', 'ranAt']);

// ============================================================================
// glExportRuns — idempotent record of GL exports (QuickBooks/NetSuite/etc.)
// ============================================================================

export const glExportRuns = defineTable({
  workosOrgId: v.string(),
  exportNumber: v.string(),

  destination: v.string(),                       // "QUICKBOOKS_ONLINE", "NETSUITE", "CSV"
  periodStart: v.number(),
  periodEnd: v.number(),

  status: v.union(
    v.literal('PENDING'),
    v.literal('EXPORTED'),
    v.literal('CONFIRMED'),                      // remote acknowledged receipt
    v.literal('FAILED'),
    v.literal('SUPERSEDED'),                     // explicit re-export
  ),

  exportedSettlementIds: v.array(v.id('settlements')),
  exportedPayItemCount: v.number(),
  totalDebitsCents: v.int64(),
  totalCreditsCents: v.int64(),

  fileStorageId: v.optional(v.string()),

  externalReferences: v.optional(v.array(externalReferenceValidator)),

  errorMessage: v.optional(v.string()),

  createdAt: v.number(),
  createdBy: v.string(),
})
  .index('by_org_period', ['workosOrgId', 'periodStart'])
  .index('by_org_status', ['workosOrgId', 'status', 'createdAt']);
