import { fireEvent, render, screen } from '@testing-library/react';
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

  it('sorts expired first, then expiring, then valid, keeping ties in input order', () => {
    render(
      <ComplianceMicroBars
        maxVisible={Infinity}
        items={[
          { label: 'Drug screen', status: 'valid' },
          { label: 'MVR', status: 'expiring' },
          { label: 'Badge', status: 'expired' },
          { label: 'Hazmat', status: 'expiring' },
          { label: 'Background', untracked: true },
          { label: 'Medical', status: 'expired' },
        ]}
      />,
    );
    const labels = screen.getAllByText(/^(Drug screen|MVR|Badge|Hazmat|Background|Medical)$/).map((el) => el.textContent);
    expect(labels).toEqual(['Badge', 'Medical', 'MVR', 'Hazmat', 'Drug screen', 'Background']);
  });

  it('collapses past maxVisible with a "Show N more" toggle', () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ label: `Doc ${i}`, status: 'valid' as const }));
    render(<ComplianceMicroBars items={items} maxVisible={4} />);
    expect(screen.getAllByText(/^Doc \d+$/)).toHaveLength(4);
    const toggle = screen.getByRole('button', { name: 'Show 7 more' });
    fireEvent.click(toggle);
    expect(screen.getAllByText(/^Doc \d+$/)).toHaveLength(11);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getAllByText(/^Doc \d+$/)).toHaveLength(4);
  });

  it('shows no toggle when everything fits', () => {
    render(<ComplianceMicroBars items={[{ label: 'License', status: 'valid' }]} maxVisible={4} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
