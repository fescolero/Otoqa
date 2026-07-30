import { describe, it, expect } from 'vitest';
import { displayLoadId } from './format';

describe('displayLoadId', () => {
  it('strips the FourKites prefix, case-insensitive, any separator', () => {
    expect(displayLoadId('FK-109589035')).toBe('109589035');
    expect(displayLoadId('fk_12345')).toBe('12345');
    expect(displayLoadId('FK9')).toBe('9');
  });
  it('leaves native ids and placeholders alone', () => {
    expect(displayLoadId('M-483920')).toBe('M-483920');
    expect(displayLoadId('L-1001')).toBe('L-1001');
    expect(displayLoadId(null)).toBe('—');
    expect(displayLoadId(undefined)).toBe('—');
  });
});
