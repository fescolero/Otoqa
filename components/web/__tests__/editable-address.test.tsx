import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditableAddress } from '../editable-address';

// AddressAutocomplete makes runtime calls to the Google Places service via
// lib/googlePlaces; stub it so the editor mounts without a network call.
vi.mock('@/lib/googlePlaces', () => ({
  getAddressPredictions: vi.fn().mockResolvedValue([]),
  getPlaceDetails: vi.fn().mockResolvedValue(null),
  createISOStringWithTimezone: vi.fn(),
}));

describe('<EditableAddress>', () => {
  const value = {
    address: '4825 Florin Rd',
    city: 'Sacramento',
    state: 'CA',
    postalCode: '95823',
    country: 'US',
  };

  it('renders idle multi-line display from value', () => {
    render(<EditableAddress value={value} onCommit={() => {}} />);
    expect(screen.getByText('4825 Florin Rd')).toBeInTheDocument();
    expect(screen.getByText('Sacramento, CA 95823')).toBeInTheDocument();
    // Country line is suppressed for US — ensures we don't clutter the
    // common case.
    expect(screen.queryByText('US')).not.toBeInTheDocument();
  });

  it('renders the placeholder when value is empty', () => {
    render(<EditableAddress value={{}} onCommit={() => {}} placeholder="Add address" />);
    expect(screen.getByText('Add address')).toBeInTheDocument();
  });

  it('swaps to the autocomplete input on click', async () => {
    const user = userEvent.setup();
    render(<EditableAddress value={value} onCommit={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Edit address' }));
    expect(screen.getByPlaceholderText('Add address')).toBeInTheDocument();
    expect(screen.getByText(/esc to cancel/)).toBeInTheDocument();
  });

  it('reverts on Escape without calling onCommit', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<EditableAddress value={value} onCommit={onCommit} />);
    await user.click(screen.getByRole('button', { name: 'Edit address' }));
    await user.keyboard('{Escape}');
    // Idle display is back.
    expect(screen.getByText('4825 Florin Rd')).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not switch to edit mode when readOnly', async () => {
    const user = userEvent.setup();
    render(<EditableAddress value={value} onCommit={() => {}} readOnly />);
    // readOnly hides the pencil button entirely; only the main button remains.
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(1);
    await user.click(buttons[0]);
    expect(screen.queryByPlaceholderText('Add address')).not.toBeInTheDocument();
  });
});
