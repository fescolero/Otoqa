// Seeded chargeComponents catalog — the standard library of pay/bill components.
// Each org receives a copy of these templates on org creation; orgs can clone,
// customize, or extend. The `templateId` field on each row preserves lineage
// so we can recognize seeded rows vs org-custom rows in reports.
//
// Template-id namespace: "stdlib.{bucket}.{code}" — stable identifier that
// survives display-name changes. Existing seeded rows are detected by
// templateId before insertion, making the seeder idempotent.
//
// Reporting fields (w2Box, wh347Column, glAccount) are best-effort defaults;
// orgs override per their actual GL and certified-payroll requirements.
//
// PAY/BILL paired components carry the `pairCode` field; the seeder uses it
// in a second pass to populate `pairedComponentId` after all rows are inserted.

import type { Doc } from '../_generated/dataModel';

type ChargeComponentDoc = Doc<'chargeComponents'>;

export type ChargeComponentTemplate = Omit<
  ChargeComponentDoc,
  '_id' | '_creationTime' | 'workosOrgId' | 'createdAt' | 'updatedAt' | 'createdBy' | 'pairedComponentId'
> & {
  pairCode?: string; // resolved to pairedComponentId after seed-pass-1
};

export const CHARGE_COMPONENT_TEMPLATES: ChargeComponentTemplate[] = [
  // ==========================================================================
  // BASE_WAGE — primary wage components
  // ==========================================================================
  {
    code: 'WAGE_HOURLY',
    displayName: 'Hourly Wage',
    description: 'Per-hour wage for time worked',
    bucket: 'BASE_WAGE',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', wh347Column: 'gross_pay', glAccount: '5100-WAGES' },
    templateId: 'stdlib.BASE_WAGE.WAGE_HOURLY',
    isActive: true,
  },
  {
    code: 'WAGE_MILEAGE',
    displayName: 'Mileage Pay',
    description: 'Per-mile wage for dispatched miles',
    bucket: 'BASE_WAGE',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', wh347Column: 'gross_pay', glAccount: '5100-WAGES' },
    templateId: 'stdlib.BASE_WAGE.WAGE_MILEAGE',
    isActive: true,
  },
  {
    code: 'WAGE_PERCENT',
    displayName: 'Percentage of Load',
    description: 'Percentage of load gross revenue',
    bucket: 'BASE_WAGE',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5100-WAGES' },
    templateId: 'stdlib.BASE_WAGE.WAGE_PERCENT',
    isActive: true,
  },
  {
    code: 'WAGE_FLAT',
    displayName: 'Flat Rate Pay',
    description: 'Fixed amount per load or leg',
    bucket: 'BASE_WAGE',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5100-WAGES' },
    templateId: 'stdlib.BASE_WAGE.WAGE_FLAT',
    isActive: true,
  },
  {
    code: 'NEGOTIATED_CARRIER_RATE',
    displayName: 'Negotiated Carrier Rate',
    description: 'Flat negotiated rate paid to carrier per load assignment',
    bucket: 'BASE_WAGE',
    sign: 'CREDIT',
    taxability: 'CONTRACTOR_1099',
    appliesTo: ['PAY'],
    reporting: { form1099Box: '1', glAccount: '5200-CARRIER-PAY' },
    templateId: 'stdlib.BASE_WAGE.NEGOTIATED_CARRIER_RATE',
    isActive: true,
  },
  {
    code: 'WAGE_CONTRACTOR_PERCENT',
    displayName: 'Owner-Operator % Share',
    description: 'Contractor revenue share — 1099 reportable',
    bucket: 'BASE_WAGE',
    sign: 'CREDIT',
    taxability: 'CONTRACTOR_1099',
    appliesTo: ['PAY'],
    reporting: { form1099Box: '1', glAccount: '5200-CARRIER-PAY' },
    templateId: 'stdlib.BASE_WAGE.WAGE_CONTRACTOR_PERCENT',
    isActive: true,
  },

  // ==========================================================================
  // BASE_FRINGE — parallel base components (Davis-Bacon, union, etc.)
  // ==========================================================================
  {
    code: 'HEALTH_WELFARE',
    displayName: 'Health & Welfare',
    description: 'H&W fringe benefit — typically per hour worked',
    bucket: 'BASE_FRINGE',
    sign: 'CREDIT',
    taxability: 'FRINGE_NON_TAXABLE',
    appliesTo: ['PAY'],
    reporting: { wh347Column: 'fringe_hw', glAccount: '5210-FRINGE-HW' },
    templateId: 'stdlib.BASE_FRINGE.HEALTH_WELFARE',
    isActive: true,
  },
  {
    code: 'PENSION_CONTRIBUTION',
    displayName: 'Pension Contribution',
    description: 'Employer pension/retirement contribution',
    bucket: 'BASE_FRINGE',
    sign: 'CREDIT',
    taxability: 'FRINGE_NON_TAXABLE',
    appliesTo: ['PAY'],
    reporting: { wh347Column: 'fringe_pension', glAccount: '5220-FRINGE-PENSION' },
    templateId: 'stdlib.BASE_FRINGE.PENSION_CONTRIBUTION',
    isActive: true,
  },
  {
    code: 'VACATION_FUND',
    displayName: 'Vacation Fund',
    description: 'Vacation pay accrual to fund or escrow',
    bucket: 'BASE_FRINGE',
    sign: 'CREDIT',
    taxability: 'FRINGE_NON_TAXABLE',
    appliesTo: ['PAY'],
    reporting: { wh347Column: 'fringe_vacation', glAccount: '5230-FRINGE-VAC' },
    templateId: 'stdlib.BASE_FRINGE.VACATION_FUND',
    isActive: true,
  },
  {
    code: 'TRAINING_FUND',
    displayName: 'Training Fund',
    description: 'Apprenticeship/training fund contribution',
    bucket: 'BASE_FRINGE',
    sign: 'CREDIT',
    taxability: 'FRINGE_NON_TAXABLE',
    appliesTo: ['PAY'],
    reporting: { wh347Column: 'fringe_training', glAccount: '5240-FRINGE-TRAIN' },
    templateId: 'stdlib.BASE_FRINGE.TRAINING_FUND',
    isActive: true,
  },
  {
    code: 'DENTAL_VISION',
    displayName: 'Dental & Vision',
    description: 'Dental/vision insurance employer contribution',
    bucket: 'BASE_FRINGE',
    sign: 'CREDIT',
    taxability: 'FRINGE_NON_TAXABLE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5250-FRINGE-DENTAL' },
    templateId: 'stdlib.BASE_FRINGE.DENTAL_VISION',
    isActive: true,
  },
  {
    code: 'LIFE_INSURANCE_EMPLOYER',
    displayName: 'Employer-Paid Life Insurance',
    description: 'Group term life premium (non-taxable up to $50k coverage)',
    bucket: 'BASE_FRINGE',
    sign: 'CREDIT',
    taxability: 'FRINGE_NON_TAXABLE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '12-C', glAccount: '5260-FRINGE-LIFE' },
    templateId: 'stdlib.BASE_FRINGE.LIFE_INSURANCE_EMPLOYER',
    isActive: true,
  },

  // ==========================================================================
  // ACCESSORIAL — paid + billed pairs share a `pairCode`
  // ==========================================================================
  {
    code: 'DETENTION_PAY',
    displayName: 'Detention (Pay)',
    description: 'Driver compensation for time at dock past free time',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5300-ACC-DETENTION' },
    pairCode: 'DETENTION_BILL',
    templateId: 'stdlib.ACCESSORIAL.DETENTION_PAY',
    isActive: true,
  },
  {
    code: 'DETENTION_BILL',
    displayName: 'Detention (Bill)',
    description: 'Customer charge for driver time at dock past free time',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'NONE',
    appliesTo: ['BILL'],
    reporting: { revenueRecognitionCategory: 'accessorial', glAccount: '4300-REV-DETENTION' },
    pairCode: 'DETENTION_PAY',
    templateId: 'stdlib.ACCESSORIAL.DETENTION_BILL',
    isActive: true,
  },
  {
    code: 'LAYOVER_PAY',
    displayName: 'Layover (Pay)',
    description: 'Driver compensation for overnight/extended layover',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5310-ACC-LAYOVER' },
    pairCode: 'LAYOVER_BILL',
    templateId: 'stdlib.ACCESSORIAL.LAYOVER_PAY',
    isActive: true,
  },
  {
    code: 'LAYOVER_BILL',
    displayName: 'Layover (Bill)',
    description: 'Customer charge for overnight/extended layover',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'NONE',
    appliesTo: ['BILL'],
    reporting: { revenueRecognitionCategory: 'accessorial', glAccount: '4310-REV-LAYOVER' },
    pairCode: 'LAYOVER_PAY',
    templateId: 'stdlib.ACCESSORIAL.LAYOVER_BILL',
    isActive: true,
  },
  {
    code: 'STOP_PAY',
    displayName: 'Extra Stop (Pay)',
    description: 'Driver compensation per additional pickup/delivery stop',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5320-ACC-STOPS' },
    pairCode: 'STOP_BILL',
    templateId: 'stdlib.ACCESSORIAL.STOP_PAY',
    isActive: true,
  },
  {
    code: 'STOP_BILL',
    displayName: 'Extra Stop (Bill)',
    description: 'Customer charge per additional pickup/delivery stop',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'NONE',
    appliesTo: ['BILL'],
    reporting: { revenueRecognitionCategory: 'accessorial', glAccount: '4320-REV-STOPS' },
    pairCode: 'STOP_PAY',
    templateId: 'stdlib.ACCESSORIAL.STOP_BILL',
    isActive: true,
  },
  {
    code: 'HAZMAT_PREMIUM_PAY',
    displayName: 'Hazmat Premium (Pay)',
    description: 'Driver premium for hazardous-materials loads',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5330-ACC-HAZMAT' },
    pairCode: 'HAZMAT_PREMIUM_BILL',
    templateId: 'stdlib.ACCESSORIAL.HAZMAT_PREMIUM_PAY',
    isActive: true,
  },
  {
    code: 'HAZMAT_PREMIUM_BILL',
    displayName: 'Hazmat Premium (Bill)',
    description: 'Customer charge for hazmat handling',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'NONE',
    appliesTo: ['BILL'],
    reporting: { revenueRecognitionCategory: 'accessorial', glAccount: '4330-REV-HAZMAT' },
    pairCode: 'HAZMAT_PREMIUM_PAY',
    templateId: 'stdlib.ACCESSORIAL.HAZMAT_PREMIUM_BILL',
    isActive: true,
  },
  {
    code: 'TARP_PREMIUM_PAY',
    displayName: 'Tarp Premium (Pay)',
    description: 'Driver premium for loads requiring tarping',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5340-ACC-TARP' },
    pairCode: 'TARP_PREMIUM_BILL',
    templateId: 'stdlib.ACCESSORIAL.TARP_PREMIUM_PAY',
    isActive: true,
  },
  {
    code: 'TARP_PREMIUM_BILL',
    displayName: 'Tarp Premium (Bill)',
    description: 'Customer charge for tarp service',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'NONE',
    appliesTo: ['BILL'],
    reporting: { revenueRecognitionCategory: 'accessorial', glAccount: '4340-REV-TARP' },
    pairCode: 'TARP_PREMIUM_PAY',
    templateId: 'stdlib.ACCESSORIAL.TARP_PREMIUM_BILL',
    isActive: true,
  },
  {
    code: 'FUEL_SURCHARGE_PAY',
    displayName: 'Fuel Surcharge (Pay)',
    description: 'Fuel cost recovery passed to driver/carrier',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5350-FSC' },
    pairCode: 'FUEL_SURCHARGE_BILL',
    templateId: 'stdlib.ACCESSORIAL.FUEL_SURCHARGE_PAY',
    isActive: true,
  },
  {
    code: 'FUEL_SURCHARGE_BILL',
    displayName: 'Fuel Surcharge (Bill)',
    description: 'Customer fuel cost recovery',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'NONE',
    appliesTo: ['BILL'],
    reporting: { revenueRecognitionCategory: 'fuel_surcharge', glAccount: '4350-REV-FSC' },
    pairCode: 'FUEL_SURCHARGE_PAY',
    templateId: 'stdlib.ACCESSORIAL.FUEL_SURCHARGE_BILL',
    isActive: true,
  },
  {
    code: 'BORDER_CROSSING_PAY',
    displayName: 'Border Crossing (Pay)',
    description: 'Driver premium for cross-border movements',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5360-ACC-BORDER' },
    pairCode: 'BORDER_CROSSING_BILL',
    templateId: 'stdlib.ACCESSORIAL.BORDER_CROSSING_PAY',
    isActive: true,
  },
  {
    code: 'BORDER_CROSSING_BILL',
    displayName: 'Border Crossing (Bill)',
    description: 'Customer charge for cross-border handling',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'NONE',
    appliesTo: ['BILL'],
    reporting: { revenueRecognitionCategory: 'accessorial', glAccount: '4360-REV-BORDER' },
    pairCode: 'BORDER_CROSSING_PAY',
    templateId: 'stdlib.ACCESSORIAL.BORDER_CROSSING_BILL',
    isActive: true,
  },

  // ==========================================================================
  // BONUS — discretionary and post-calc earnings
  // ==========================================================================
  {
    code: 'SAFETY_BONUS',
    displayName: 'Safety Bonus',
    description: 'Safety performance bonus',
    bucket: 'BONUS',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5400-BONUS-SAFETY' },
    templateId: 'stdlib.BONUS.SAFETY_BONUS',
    isActive: true,
  },
  {
    code: 'PERFORMANCE_BONUS',
    displayName: 'Performance Bonus',
    description: 'Discretionary performance bonus',
    bucket: 'BONUS',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5410-BONUS-PERF' },
    templateId: 'stdlib.BONUS.PERFORMANCE_BONUS',
    isActive: true,
  },
  {
    code: 'REFERRAL_BONUS',
    displayName: 'Referral Bonus',
    description: 'Driver/carrier referral bonus',
    bucket: 'BONUS',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5420-BONUS-REFERRAL' },
    templateId: 'stdlib.BONUS.REFERRAL_BONUS',
    isActive: true,
  },
  {
    code: 'SIGN_ON_BONUS',
    displayName: 'Sign-On Bonus',
    description: 'New-hire bonus, often paid in installments',
    bucket: 'BONUS',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5430-BONUS-SIGNON' },
    templateId: 'stdlib.BONUS.SIGN_ON_BONUS',
    isActive: true,
  },
  {
    code: 'MINIMUM_GUARANTEE_MAKEUP',
    displayName: 'Minimum Guarantee Makeup',
    description: 'Post-calc adjustment to meet weekly/daily minimum',
    bucket: 'BONUS',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5440-GUARANTEE-MAKEUP' },
    templateId: 'stdlib.BONUS.MINIMUM_GUARANTEE_MAKEUP',
    isActive: true,
  },
  {
    code: 'OVERTIME_PREMIUM',
    displayName: 'Overtime Premium',
    description: 'Premium portion of overtime pay (0.5x of base × OT hours)',
    bucket: 'BONUS',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { w2Box: '1', glAccount: '5450-OT-PREMIUM' },
    templateId: 'stdlib.BONUS.OVERTIME_PREMIUM',
    isActive: true,
  },

  // ==========================================================================
  // REIMBURSEMENT — accountable expenses paid back to driver
  // ==========================================================================
  {
    code: 'TOLL_REIMB',
    displayName: 'Toll Reimbursement',
    description: 'Reimbursement for driver-paid tolls',
    bucket: 'REIMBURSEMENT',
    sign: 'CREDIT',
    taxability: 'REIMBURSEMENT_ACCOUNTABLE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5500-REIMB-TOLLS' },
    templateId: 'stdlib.REIMBURSEMENT.TOLL_REIMB',
    isActive: true,
  },
  {
    code: 'FUEL_REIMB',
    displayName: 'Fuel Reimbursement',
    description: 'Reimbursement for authorized fuel purchases',
    bucket: 'REIMBURSEMENT',
    sign: 'CREDIT',
    taxability: 'REIMBURSEMENT_ACCOUNTABLE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5510-REIMB-FUEL' },
    templateId: 'stdlib.REIMBURSEMENT.FUEL_REIMB',
    isActive: true,
  },
  {
    code: 'LODGING_REIMB',
    displayName: 'Lodging Reimbursement',
    description: 'Reimbursement for authorized hotel/lodging',
    bucket: 'REIMBURSEMENT',
    sign: 'CREDIT',
    taxability: 'REIMBURSEMENT_ACCOUNTABLE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5520-REIMB-LODGING' },
    templateId: 'stdlib.REIMBURSEMENT.LODGING_REIMB',
    isActive: true,
  },
  {
    code: 'SCALE_TICKET_REIMB',
    displayName: 'Scale Ticket Reimbursement',
    description: 'Reimbursement for scale fees',
    bucket: 'REIMBURSEMENT',
    sign: 'CREDIT',
    taxability: 'REIMBURSEMENT_ACCOUNTABLE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5530-REIMB-SCALE' },
    templateId: 'stdlib.REIMBURSEMENT.SCALE_TICKET_REIMB',
    isActive: true,
  },
  {
    code: 'PARKING_REIMB',
    displayName: 'Parking Reimbursement',
    description: 'Reimbursement for authorized parking',
    bucket: 'REIMBURSEMENT',
    sign: 'CREDIT',
    taxability: 'REIMBURSEMENT_ACCOUNTABLE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5540-REIMB-PARKING' },
    templateId: 'stdlib.REIMBURSEMENT.PARKING_REIMB',
    isActive: true,
  },
  {
    code: 'PER_DIEM_DAILY',
    displayName: 'Per Diem (Daily)',
    description: 'IRS standard rate per qualifying day away from home',
    bucket: 'REIMBURSEMENT',
    sign: 'CREDIT',
    taxability: 'PER_DIEM_NONTAXABLE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5550-PER-DIEM' },
    templateId: 'stdlib.REIMBURSEMENT.PER_DIEM_DAILY',
    isActive: true,
  },

  // ==========================================================================
  // DEDUCTION — voluntary and recurring deductions (priority 5+)
  // ==========================================================================
  {
    code: 'TRUCK_LEASE',
    displayName: 'Truck Lease Payment',
    description: 'Truck lease per period — typically recurring',
    bucket: 'DEDUCTION',
    sign: 'DEBIT',
    taxability: 'POST_TAX_DEDUCTION',
    deductionPriority: 6,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { glAccount: '5600-DEDUCT-LEASE' },
    templateId: 'stdlib.DEDUCTION.TRUCK_LEASE',
    isActive: true,
  },
  {
    code: 'INSURANCE_DEDUCTION',
    displayName: 'Insurance Deduction',
    description: 'Driver share of insurance premium',
    bucket: 'DEDUCTION',
    sign: 'DEBIT',
    taxability: 'PRE_TAX_DEDUCTION',
    deductionPriority: 3,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { w2Box: '12-DD', glAccount: '5610-DEDUCT-INS' },
    templateId: 'stdlib.DEDUCTION.INSURANCE_DEDUCTION',
    isActive: true,
  },
  {
    code: 'FUEL_CARD_DEDUCTION',
    displayName: 'Fuel Card Deduction',
    description: 'Recovery of driver fuel card charges',
    bucket: 'DEDUCTION',
    sign: 'DEBIT',
    taxability: 'POST_TAX_DEDUCTION',
    deductionPriority: 5,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { glAccount: '5620-DEDUCT-FUEL' },
    templateId: 'stdlib.DEDUCTION.FUEL_CARD_DEDUCTION',
    isActive: true,
  },
  {
    code: 'ADVANCE_PAYBACK',
    displayName: 'Advance Repayment',
    description: 'Recovery of prior cash/fuel advance',
    bucket: 'DEDUCTION',
    sign: 'DEBIT',
    taxability: 'POST_TAX_DEDUCTION',
    deductionPriority: 5,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { glAccount: '5630-DEDUCT-ADVANCE' },
    templateId: 'stdlib.DEDUCTION.ADVANCE_PAYBACK',
    isActive: true,
  },
  {
    code: 'DAMAGE_CHARGE',
    displayName: 'Damage Charge',
    description: 'Charge for documented damage to equipment or cargo',
    bucket: 'DEDUCTION',
    sign: 'DEBIT',
    taxability: 'POST_TAX_DEDUCTION',
    deductionPriority: 7,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { glAccount: '5640-DEDUCT-DAMAGE' },
    templateId: 'stdlib.DEDUCTION.DAMAGE_CHARGE',
    isActive: true,
  },
  {
    code: 'ELD_SUBSCRIPTION',
    displayName: 'ELD Subscription',
    description: 'Electronic logging device subscription',
    bucket: 'DEDUCTION',
    sign: 'DEBIT',
    taxability: 'POST_TAX_DEDUCTION',
    deductionPriority: 6,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { glAccount: '5650-DEDUCT-ELD' },
    templateId: 'stdlib.DEDUCTION.ELD_SUBSCRIPTION',
    isActive: true,
  },
  {
    code: 'ADMIN_FEE',
    displayName: 'Admin Fee',
    description: 'Per-settlement administrative fee',
    bucket: 'DEDUCTION',
    sign: 'DEBIT',
    taxability: 'POST_TAX_DEDUCTION',
    deductionPriority: 8,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { glAccount: '5660-DEDUCT-ADMIN' },
    templateId: 'stdlib.DEDUCTION.ADMIN_FEE',
    isActive: true,
  },
  {
    code: 'DISPATCH_FEE',
    displayName: 'Dispatch Fee',
    description: 'Per-load or per-period dispatch service fee',
    bucket: 'DEDUCTION',
    sign: 'DEBIT',
    taxability: 'POST_TAX_DEDUCTION',
    deductionPriority: 8,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { glAccount: '5670-DEDUCT-DISPATCH' },
    templateId: 'stdlib.DEDUCTION.DISPATCH_FEE',
    isActive: true,
  },

  // ==========================================================================
  // TAX_WITHHOLDING — populated by tax engine integration
  // ==========================================================================
  {
    code: 'FIT_WITHHOLDING',
    displayName: 'Federal Income Tax Withholding',
    description: 'Federal income tax withheld from wages',
    bucket: 'TAX_WITHHOLDING',
    sign: 'DEBIT',
    taxability: 'TAX_WITHHOLDING',
    deductionPriority: 2,
    isLegallyProtected: true,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { w2Box: '2', glAccount: '2100-PAYROLL-LIAB-FIT' },
    templateId: 'stdlib.TAX_WITHHOLDING.FIT_WITHHOLDING',
    isActive: true,
  },
  {
    code: 'FICA_SS_EMPLOYEE',
    displayName: 'Social Security (Employee)',
    description: 'Employee portion of Social Security tax',
    bucket: 'TAX_WITHHOLDING',
    sign: 'DEBIT',
    taxability: 'TAX_WITHHOLDING',
    deductionPriority: 2,
    isLegallyProtected: true,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { w2Box: '4', glAccount: '2110-PAYROLL-LIAB-SS' },
    templateId: 'stdlib.TAX_WITHHOLDING.FICA_SS_EMPLOYEE',
    isActive: true,
  },
  {
    code: 'FICA_MEDICARE_EMPLOYEE',
    displayName: 'Medicare (Employee)',
    description: 'Employee portion of Medicare tax',
    bucket: 'TAX_WITHHOLDING',
    sign: 'DEBIT',
    taxability: 'TAX_WITHHOLDING',
    deductionPriority: 2,
    isLegallyProtected: true,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { w2Box: '6', glAccount: '2120-PAYROLL-LIAB-MED' },
    templateId: 'stdlib.TAX_WITHHOLDING.FICA_MEDICARE_EMPLOYEE',
    isActive: true,
  },
  {
    code: 'SIT_WITHHOLDING',
    displayName: 'State Income Tax Withholding',
    description: 'State income tax withheld — per-state instances created at runtime',
    bucket: 'TAX_WITHHOLDING',
    sign: 'DEBIT',
    taxability: 'TAX_WITHHOLDING',
    deductionPriority: 2,
    isLegallyProtected: true,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { w2Box: '17', glAccount: '2130-PAYROLL-LIAB-SIT' },
    templateId: 'stdlib.TAX_WITHHOLDING.SIT_WITHHOLDING',
    isActive: true,
  },
  {
    code: 'SDI_WITHHOLDING',
    displayName: 'State Disability Insurance',
    description: 'State disability insurance withholding (e.g. CA SDI)',
    bucket: 'TAX_WITHHOLDING',
    sign: 'DEBIT',
    taxability: 'TAX_WITHHOLDING',
    deductionPriority: 2,
    isLegallyProtected: true,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { w2Box: '14', glAccount: '2140-PAYROLL-LIAB-SDI' },
    jurisdiction: { states: ['US-CA', 'US-NJ', 'US-NY', 'US-RI', 'US-HI'] },
    templateId: 'stdlib.TAX_WITHHOLDING.SDI_WITHHOLDING',
    isActive: true,
  },
  {
    code: 'BACKUP_WITHHOLDING_24PCT',
    displayName: '24% Backup Withholding',
    description: 'IRS 24% backup withholding for 1099 payees without valid TIN',
    bucket: 'TAX_WITHHOLDING',
    sign: 'DEBIT',
    taxability: 'TAX_WITHHOLDING',
    deductionPriority: 2,
    isLegallyProtected: true,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { form1099Box: '4', glAccount: '2150-PAYROLL-LIAB-BACKUP' },
    templateId: 'stdlib.TAX_WITHHOLDING.BACKUP_WITHHOLDING_24PCT',
    isActive: true,
  },

  // ==========================================================================
  // GARNISHMENT — highest deduction priority, legally protected
  // ==========================================================================
  {
    code: 'CHILD_SUPPORT_GARNISHMENT',
    displayName: 'Child Support',
    description: 'Court-ordered child support garnishment',
    bucket: 'GARNISHMENT',
    sign: 'DEBIT',
    taxability: 'GARNISHMENT',
    deductionPriority: 1,
    isLegallyProtected: true,
    countsTowardCcpaLimit: true,
    appliesTo: ['PAY'],
    reporting: { glAccount: '2200-GARNISH-CHILD-SUPP' },
    templateId: 'stdlib.GARNISHMENT.CHILD_SUPPORT_GARNISHMENT',
    isActive: true,
  },
  {
    code: 'IRS_TAX_LEVY',
    displayName: 'IRS Tax Levy',
    description: 'IRS levy on wages for unpaid taxes',
    bucket: 'GARNISHMENT',
    sign: 'DEBIT',
    taxability: 'GARNISHMENT',
    deductionPriority: 1,
    isLegallyProtected: true,
    countsTowardCcpaLimit: true,
    appliesTo: ['PAY'],
    reporting: { glAccount: '2210-GARNISH-IRS-LEVY' },
    templateId: 'stdlib.GARNISHMENT.IRS_TAX_LEVY',
    isActive: true,
  },
  {
    code: 'COURT_ORDER_GARNISHMENT',
    displayName: 'Court-Ordered Garnishment',
    description: 'General creditor garnishment by court order',
    bucket: 'GARNISHMENT',
    sign: 'DEBIT',
    taxability: 'GARNISHMENT',
    deductionPriority: 1,
    isLegallyProtected: true,
    countsTowardCcpaLimit: true,
    appliesTo: ['PAY'],
    reporting: { glAccount: '2220-GARNISH-COURT' },
    templateId: 'stdlib.GARNISHMENT.COURT_ORDER_GARNISHMENT',
    isActive: true,
  },

  // ==========================================================================
  // LEGACY_BRIDGE — for migrating historical loadPayables rows
  //                 whose category can't be cleanly mapped to a real component
  // ==========================================================================
  {
    code: 'LEGACY_BASE',
    displayName: 'Legacy Base Pay (Migrated)',
    description: 'Historical BASE category from legacy rateRules; pre-migration data',
    bucket: 'BASE_WAGE',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5100-WAGES' },
    templateId: 'stdlib.LEGACY_BRIDGE.LEGACY_BASE',
    isActive: true,
  },
  {
    code: 'LEGACY_ACCESSORIAL',
    displayName: 'Legacy Accessorial (Migrated)',
    description: 'Historical ACCESSORIAL category from legacy rateRules',
    bucket: 'ACCESSORIAL',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5300-ACC-LEGACY' },
    templateId: 'stdlib.LEGACY_BRIDGE.LEGACY_ACCESSORIAL',
    isActive: true,
  },
  {
    code: 'LEGACY_DEDUCTION',
    displayName: 'Legacy Deduction (Migrated)',
    description: 'Historical DEDUCTION category from legacy rateRules',
    bucket: 'DEDUCTION',
    sign: 'DEBIT',
    taxability: 'POST_TAX_DEDUCTION',
    deductionPriority: 9,
    countsTowardCcpaLimit: false,
    appliesTo: ['PAY'],
    reporting: { glAccount: '5600-DEDUCT-LEGACY' },
    templateId: 'stdlib.LEGACY_BRIDGE.LEGACY_DEDUCTION',
    isActive: true,
  },
  {
    code: 'LEGACY_MANUAL',
    displayName: 'Legacy Manual Adjustment (Migrated)',
    description: 'Historical manual payable from legacy loadPayables.sourceType=MANUAL',
    bucket: 'BONUS',
    sign: 'CREDIT',
    taxability: 'TAXABLE_WAGE',
    appliesTo: ['PAY'],
    reporting: { glAccount: '5400-BONUS-LEGACY' },
    templateId: 'stdlib.LEGACY_BRIDGE.LEGACY_MANUAL',
    isActive: true,
  },
];

// ============================================================================
// Catalog validation — invariants the catalog itself must satisfy.
// Tested in chargeComponentsCatalog.test.ts; also asserted at seed time.
// ============================================================================

export function validateCatalog(
  templates: ReadonlyArray<ChargeComponentTemplate>,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  // Unique templateId
  const ids = new Set<string>();
  for (const t of templates) {
    if (!t.templateId) {
      errors.push(`Template missing templateId: ${t.code}`);
      continue;
    }
    if (ids.has(t.templateId)) {
      errors.push(`Duplicate templateId: ${t.templateId}`);
    }
    ids.add(t.templateId);
  }

  // Unique code
  const codes = new Set<string>();
  for (const t of templates) {
    if (codes.has(t.code)) errors.push(`Duplicate code: ${t.code}`);
    codes.add(t.code);
  }

  // Sign matches bucket convention
  for (const t of templates) {
    const debitBuckets = ['DEDUCTION', 'TAX_WITHHOLDING', 'GARNISHMENT'];
    const expectedDebit = debitBuckets.includes(t.bucket);
    if (expectedDebit && t.sign !== 'DEBIT') {
      errors.push(`${t.code}: bucket ${t.bucket} requires sign=DEBIT, got ${t.sign}`);
    }
    if (!expectedDebit && t.sign !== 'CREDIT') {
      errors.push(`${t.code}: bucket ${t.bucket} requires sign=CREDIT, got ${t.sign}`);
    }
  }

  // Pair references resolve mutually
  const byCode = new Map(templates.map(t => [t.code, t]));
  for (const t of templates) {
    if (!t.pairCode) continue;
    const partner = byCode.get(t.pairCode);
    if (!partner) {
      errors.push(`${t.code}: pairCode=${t.pairCode} not found in catalog`);
      continue;
    }
    if (partner.pairCode !== t.code) {
      errors.push(`${t.code}: pair ${t.pairCode} does not back-reference (got ${partner.pairCode ?? 'undefined'})`);
    }
    // Pair must be opposite side
    const tSide = t.appliesTo.includes('PAY') ? 'PAY' : 'BILL';
    const pSide = partner.appliesTo.includes('PAY') ? 'PAY' : 'BILL';
    if (tSide === pSide) {
      errors.push(`${t.code}: pair ${t.pairCode} on same side (${tSide}); should be opposite`);
    }
  }

  // Garnishments and tax must have priority + protected
  for (const t of templates) {
    if (t.bucket === 'GARNISHMENT') {
      if (t.deductionPriority !== 1) {
        errors.push(`${t.code}: garnishment must have deductionPriority=1`);
      }
      if (!t.isLegallyProtected) {
        errors.push(`${t.code}: garnishment must be legally protected`);
      }
    }
    if (t.bucket === 'TAX_WITHHOLDING') {
      if (t.deductionPriority !== 2) {
        errors.push(`${t.code}: tax withholding must have deductionPriority=2`);
      }
      if (!t.isLegallyProtected) {
        errors.push(`${t.code}: tax withholding must be legally protected`);
      }
    }
  }

  // appliesTo non-empty
  for (const t of templates) {
    if (t.appliesTo.length === 0) {
      errors.push(`${t.code}: appliesTo must be non-empty`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
