import { describe, it, expect } from 'vitest';
import {
  CHARGE_COMPONENT_TEMPLATES,
  validateCatalog,
  type ChargeComponentTemplate,
} from './chargeComponentsCatalog';

describe('chargeComponents catalog — invariants', () => {
  it('catalog passes validation', () => {
    const result = validateCatalog(CHARGE_COMPONENT_TEMPLATES);
    if (!result.ok) {
      throw new Error(`Catalog failed validation:\n${result.errors.join('\n')}`);
    }
    expect(result.ok).toBe(true);
  });

  it('every template has a unique code', () => {
    const codes = CHARGE_COMPONENT_TEMPLATES.map(t => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every template has a unique templateId', () => {
    const ids = CHARGE_COMPONENT_TEMPLATES.map(t => t.templateId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every templateId follows stdlib.{bucket}.{code} convention', () => {
    for (const t of CHARGE_COMPONENT_TEMPLATES) {
      expect(t.templateId).toMatch(/^stdlib\.[A-Z_]+\.[A-Z_0-9]+$/);
    }
  });

  it('debit-bucket templates have sign=DEBIT', () => {
    const debitBuckets = new Set(['DEDUCTION', 'TAX_WITHHOLDING', 'GARNISHMENT']);
    for (const t of CHARGE_COMPONENT_TEMPLATES) {
      if (debitBuckets.has(t.bucket)) {
        expect(t.sign, `${t.code} (${t.bucket})`).toBe('DEBIT');
      }
    }
  });

  it('credit-bucket templates have sign=CREDIT', () => {
    const debitBuckets = new Set(['DEDUCTION', 'TAX_WITHHOLDING', 'GARNISHMENT']);
    for (const t of CHARGE_COMPONENT_TEMPLATES) {
      if (!debitBuckets.has(t.bucket)) {
        expect(t.sign, `${t.code} (${t.bucket})`).toBe('CREDIT');
      }
    }
  });

  it('garnishments have priority=1 and are legally protected', () => {
    for (const t of CHARGE_COMPONENT_TEMPLATES) {
      if (t.bucket === 'GARNISHMENT') {
        expect(t.deductionPriority, t.code).toBe(1);
        expect(t.isLegallyProtected, t.code).toBe(true);
      }
    }
  });

  it('tax withholdings have priority=2 and are legally protected', () => {
    for (const t of CHARGE_COMPONENT_TEMPLATES) {
      if (t.bucket === 'TAX_WITHHOLDING') {
        expect(t.deductionPriority, t.code).toBe(2);
        expect(t.isLegallyProtected, t.code).toBe(true);
      }
    }
  });

  it('PAY/BILL pairs back-reference each other and are on opposite sides', () => {
    const byCode = new Map(CHARGE_COMPONENT_TEMPLATES.map(t => [t.code, t]));
    for (const t of CHARGE_COMPONENT_TEMPLATES) {
      if (!t.pairCode) continue;
      const partner = byCode.get(t.pairCode);
      expect(partner, `pair for ${t.code}`).toBeDefined();
      expect(partner!.pairCode, `${t.code} pair back-ref`).toBe(t.code);
      const tSide = t.appliesTo.includes('PAY') ? 'PAY' : 'BILL';
      const pSide = partner!.appliesTo.includes('PAY') ? 'PAY' : 'BILL';
      expect(tSide).not.toBe(pSide);
    }
  });

  it('every appliesTo array is non-empty', () => {
    for (const t of CHARGE_COMPONENT_TEMPLATES) {
      expect(t.appliesTo.length, t.code).toBeGreaterThan(0);
    }
  });

  it('every required bucket is represented at least once', () => {
    const buckets = new Set(CHARGE_COMPONENT_TEMPLATES.map(t => t.bucket));
    const required = [
      'BASE_WAGE',
      'BASE_FRINGE',
      'ACCESSORIAL',
      'BONUS',
      'REIMBURSEMENT',
      'DEDUCTION',
      'TAX_WITHHOLDING',
      'GARNISHMENT',
    ];
    for (const r of required) {
      expect(buckets.has(r as ChargeComponentTemplate['bucket']), `missing bucket: ${r}`).toBe(true);
    }
  });

  it('Davis-Bacon fringe components exist (H&W, pension, vacation, training)', () => {
    const codes = new Set(CHARGE_COMPONENT_TEMPLATES.map(t => t.code));
    expect(codes.has('HEALTH_WELFARE')).toBe(true);
    expect(codes.has('PENSION_CONTRIBUTION')).toBe(true);
    expect(codes.has('VACATION_FUND')).toBe(true);
    expect(codes.has('TRAINING_FUND')).toBe(true);
  });

  it('post-calc adjustment components exist', () => {
    const codes = new Set(CHARGE_COMPONENT_TEMPLATES.map(t => t.code));
    expect(codes.has('MINIMUM_GUARANTEE_MAKEUP')).toBe(true);
    expect(codes.has('OVERTIME_PREMIUM')).toBe(true);
  });

  it('backup withholding component exists for 1099 payees without TIN', () => {
    const codes = new Set(CHARGE_COMPONENT_TEMPLATES.map(t => t.code));
    expect(codes.has('BACKUP_WITHHOLDING_24PCT')).toBe(true);
  });

  it('PER_DIEM_DAILY has PER_DIEM_NONTAXABLE taxability', () => {
    const perDiem = CHARGE_COMPONENT_TEMPLATES.find(t => t.code === 'PER_DIEM_DAILY');
    expect(perDiem).toBeDefined();
    expect(perDiem!.taxability).toBe('PER_DIEM_NONTAXABLE');
  });

  it('legacy bridge components exist for migration', () => {
    const codes = new Set(CHARGE_COMPONENT_TEMPLATES.map(t => t.code));
    expect(codes.has('LEGACY_BASE')).toBe(true);
    expect(codes.has('LEGACY_ACCESSORIAL')).toBe(true);
    expect(codes.has('LEGACY_DEDUCTION')).toBe(true);
    expect(codes.has('LEGACY_MANUAL')).toBe(true);
  });

  it('all accessorial pairs are matched (no orphans)', () => {
    const accessorials = CHARGE_COMPONENT_TEMPLATES.filter(t => t.bucket === 'ACCESSORIAL');
    const paired = accessorials.filter(t => t.pairCode);
    // Every paired accessorial we ship is on a pair — count is even
    expect(paired.length % 2).toBe(0);
  });

  it('NEGOTIATED_CARRIER_RATE exists for flat-rate carrier path', () => {
    const codes = new Set(CHARGE_COMPONENT_TEMPLATES.map(t => t.code));
    expect(codes.has('NEGOTIATED_CARRIER_RATE')).toBe(true);
  });
});

describe('validateCatalog — failure modes', () => {
  it('detects duplicate templateId', () => {
    const broken: ChargeComponentTemplate[] = [
      { ...CHARGE_COMPONENT_TEMPLATES[0] },
      { ...CHARGE_COMPONENT_TEMPLATES[0], code: 'DIFFERENT' },
    ];
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => /Duplicate templateId/.test(e))).toBe(true);
    }
  });

  it('detects duplicate code', () => {
    const broken: ChargeComponentTemplate[] = [
      { ...CHARGE_COMPONENT_TEMPLATES[0] },
      { ...CHARGE_COMPONENT_TEMPLATES[0], templateId: 'stdlib.X.Y' },
    ];
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => /Duplicate code/.test(e))).toBe(true);
    }
  });

  it('detects sign-bucket mismatch', () => {
    const broken: ChargeComponentTemplate[] = [{
      code: 'BROKEN_DEDUCT',
      displayName: 'Broken Deduction',
      bucket: 'DEDUCTION',
      sign: 'CREDIT',
      taxability: 'POST_TAX_DEDUCTION',
      appliesTo: ['PAY'],
      templateId: 'stdlib.X.BROKEN_DEDUCT',
      isActive: true,
    }];
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
  });

  it('detects unresolved pair reference', () => {
    const broken: ChargeComponentTemplate[] = [{
      code: 'A',
      displayName: 'A',
      bucket: 'ACCESSORIAL',
      sign: 'CREDIT',
      taxability: 'TAXABLE_WAGE',
      appliesTo: ['PAY'],
      pairCode: 'NONEXISTENT',
      templateId: 'stdlib.X.A',
      isActive: true,
    }];
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
  });

  it('detects pair on same side (both PAY)', () => {
    const broken: ChargeComponentTemplate[] = [
      {
        code: 'A', displayName: 'A', bucket: 'ACCESSORIAL', sign: 'CREDIT',
        taxability: 'TAXABLE_WAGE', appliesTo: ['PAY'], pairCode: 'B',
        templateId: 'stdlib.X.A', isActive: true,
      },
      {
        code: 'B', displayName: 'B', bucket: 'ACCESSORIAL', sign: 'CREDIT',
        taxability: 'TAXABLE_WAGE', appliesTo: ['PAY'], pairCode: 'A',
        templateId: 'stdlib.X.B', isActive: true,
      },
    ];
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => /same side/.test(e))).toBe(true);
    }
  });

  it('detects garnishment with wrong priority', () => {
    const broken: ChargeComponentTemplate[] = [{
      code: 'GARN_WRONG',
      displayName: 'Garnishment',
      bucket: 'GARNISHMENT',
      sign: 'DEBIT',
      taxability: 'GARNISHMENT',
      deductionPriority: 5,
      isLegallyProtected: true,
      appliesTo: ['PAY'],
      templateId: 'stdlib.X.GARN_WRONG',
      isActive: true,
    }];
    const result = validateCatalog(broken);
    expect(result.ok).toBe(false);
  });
});
