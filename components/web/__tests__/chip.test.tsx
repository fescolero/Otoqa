import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Chip, STATUS_PRESETS } from '../chip';

describe('<Chip>', () => {
  it('renders the preset label when no override is given', () => {
    render(<Chip status="active" />);
    expect(screen.getByText(STATUS_PRESETS.active.label)).toBeInTheDocument();
  });

  it('renders an explicit label override', () => {
    render(<Chip status="warning" label="Needs review" />);
    expect(screen.getByText('Needs review')).toBeInTheDocument();
  });

  it('falls back to the inactive preset for unknown statuses', () => {
    // @ts-expect-error verifying runtime fallback
    render(<Chip status="bogus" />);
    expect(screen.getByText(STATUS_PRESETS.inactive.label)).toBeInTheDocument();
  });
});
