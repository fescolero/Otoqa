import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ComplianceMicroBars } from '../compliance-micro-bars';

describe('<ComplianceMicroBars>', () => {
  it('renders one row per item with label, number, and expiry', () => {
    render(
      <ComplianceMicroBars
        items={[
          { label: 'License', number: 'A1234567', expires: 'May 2, 2026', status: 'expiring' },
          { label: 'Medical', number: 'M-441',    expires: 'Sep 28, 2026', status: 'valid' },
        ]}
      />,
    );
    expect(screen.getByText('License')).toBeInTheDocument();
    expect(screen.getByText('A1234567')).toBeInTheDocument();
    expect(screen.getByText('May 2, 2026')).toBeInTheDocument();
    expect(screen.getByText('Medical')).toBeInTheDocument();
  });

  it('shows "Not tracked yet" copy + "Not tracked" chip for placeholder rows', () => {
    render(<ComplianceMicroBars items={[{ label: 'Background', untracked: true }]} />);
    expect(screen.getByText('Not tracked yet')).toBeInTheDocument();
    expect(screen.getByText('Not tracked')).toBeInTheDocument();
  });
});
