import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../command-palette';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/dashboard',
}));

describe('<CommandPalette>', () => {
  beforeEach(() => pushMock.mockReset());

  it('does not render when closed', () => {
    render(<CommandPalette open={false} onOpenChange={() => {}} />);
    expect(screen.queryByPlaceholderText('Search & jump…')).not.toBeInTheDocument();
  });

  it('renders the search input and grouped nav items when open', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.getByPlaceholderText('Search & jump…')).toBeInTheDocument();
    // First-level (no items) entries land in "Navigate".
    expect(screen.getByText('Navigate')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    // Sub-items land under their parent label.
    expect(screen.getByText('Fleet Management')).toBeInTheDocument();
    expect(screen.getByText('Drivers')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
  });

  it('filters items as the user types', async () => {
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={() => {}} />);
    await user.type(screen.getByPlaceholderText('Search & jump…'), 'sched');
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.queryByText('Drivers')).not.toBeInTheDocument();
  });

  it('navigates and closes on selection', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);
    await user.click(screen.getByText('Drivers'));
    expect(pushMock).toHaveBeenCalledWith('/fleet/drivers');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the empty state when nothing matches', async () => {
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={() => {}} />);
    await user.type(screen.getByPlaceholderText('Search & jump…'), 'zzzzzzz');
    expect(screen.getByText('No results.')).toBeInTheDocument();
  });
});
