import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OnTimeChip, onTimeChipProps } from '../on-time-chip';

const MIN = 60_000;

describe('onTimeChipProps', () => {
  it('is muted when nothing was evaluable', () => {
    expect(onTimeChipProps(null)).toEqual({ status: 'na', label: '—' });
    expect(onTimeChipProps({ evaluated: 0, onTime: 0, maxLateMs: 0 })).toEqual({ status: 'na', label: '—' });
  });
  it('is green "On time" when every delivery made it', () => {
    expect(onTimeChipProps({ evaluated: 2, onTime: 2, maxLateMs: 0 })).toEqual({ status: 'valid', label: 'On time' });
  });
  it('is red with the worst lateness for a single delivery', () => {
    expect(onTimeChipProps({ evaluated: 1, onTime: 0, maxLateMs: 42 * MIN })).toEqual({ status: 'expired', label: 'Late 42m' });
    expect(onTimeChipProps({ evaluated: 1, onTime: 0, maxLateMs: 125 * MIN }).label).toBe('Late 2h 05m');
  });
  it('adds a late/total count for multi-drop loads', () => {
    expect(onTimeChipProps({ evaluated: 3, onTime: 2, maxLateMs: 9 * MIN }).label).toBe('Late 9m · 1/3');
  });
});

describe('<OnTimeChip>', () => {
  it('renders the label', () => {
    render(<OnTimeChip onTime={{ evaluated: 1, onTime: 0, maxLateMs: 30 * MIN }} />);
    expect(screen.getByText('Late 30m')).toBeInTheDocument();
  });
});
