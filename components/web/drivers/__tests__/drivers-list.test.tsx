import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DriversList } from '../drivers-list';
import type { DriverRow } from '../build-driver-details';

// useUserPreferences requires the provider; stub it for the integration test.
vi.mock('@/components/web/shell/use-user-preferences', () => ({
  useUserPreferences: () => ({
    theme: 'light',
    density: 'compact' as const,
    sidebarMode: 'pinned' as const,
    setTheme: vi.fn(),
    setDensity: vi.fn(),
    setSidebarMode: vi.fn(),
    isHydrating: false,
  }),
}));

// CommentsThread reaches Convex; stub it so the slide-over can render.
vi.mock('@/components/web/comments-thread', () => ({
  CommentsThread: () => <div data-testid="comments-thread-stub" />,
}));

const driver = (over: Partial<DriverRow>): DriverRow => ({
  _id: over._id ?? Math.random().toString(36).slice(2),
  firstName: 'Sergio',
  lastName: 'Barba',
  email: 'sergio@example.com',
  phone: '9168243871',
  licenseClass: 'A',
  licenseState: 'CA',
  licenseExpiration: '2027-05-04',
  medicalExpiration: '2027-05-04',
  hireDate: '2024-01-15',
  employmentStatus: 'Active',
  employmentType: 'Full-time',
  ...over,
});

const ROWS: DriverRow[] = [
  driver({ _id: 'd1', firstName: 'Sergio', lastName: 'Barba', employmentStatus: 'Active' }),
  driver({ _id: 'd2', firstName: 'Maria', lastName: 'Khouri', employmentStatus: 'Active', licenseExpiration: '2020-01-01' }),
  driver({ _id: 'd3', firstName: 'Jamal', lastName: 'Reed', employmentStatus: 'On Leave' }),
  driver({ _id: 'd4', firstName: 'Anna', lastName: 'Lim', isDeleted: true }),
];

const noop = () => {};

describe('<DriversList>', () => {
  it('renders the page header with the Drivers title and create action', () => {
    render(
      <DriversList
        drivers={ROWS}
        onCreate={noop}
        onImport={noop}
        onExport={noop}
        onBulkDeactivate={noop}
      />,
    );
    expect(screen.getByText('Drivers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Driver/ })).toBeInTheDocument();
  });

  it('shows saved-views tabs with counts derived from the data', () => {
    render(
      <DriversList
        drivers={ROWS}
        onCreate={noop}
        onImport={noop}
        onExport={noop}
        onBulkDeactivate={noop}
      />,
    );
    const all = screen.getByRole('button', { name: /All Drivers/ });
    expect(within(all).getByText('3')).toBeInTheDocument(); // 4 - 1 deleted
    const deleted = screen.getByRole('button', { name: /Deleted/ });
    expect(within(deleted).getByText('1')).toBeInTheDocument();
  });

  it('switches to a different view on tab click and re-filters', async () => {
    const user = userEvent.setup();
    render(
      <DriversList
        drivers={ROWS}
        onCreate={noop}
        onImport={noop}
        onExport={noop}
        onBulkDeactivate={noop}
      />,
    );
    expect(screen.getByText('Sergio Barba')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /On Leave/ }));
    // Only Jamal should remain.
    expect(screen.getByText('Jamal Reed')).toBeInTheDocument();
    expect(screen.queryByText('Sergio Barba')).not.toBeInTheDocument();
  });

  it('filters via the search input', async () => {
    const user = userEvent.setup();
    render(
      <DriversList
        drivers={ROWS}
        onCreate={noop}
        onImport={noop}
        onExport={noop}
        onBulkDeactivate={noop}
      />,
    );
    await user.type(screen.getByPlaceholderText('Search drivers…'), 'Maria');
    expect(screen.getByText('Maria Khouri')).toBeInTheDocument();
    expect(screen.queryByText('Sergio Barba')).not.toBeInTheDocument();
  });

  it('opens the slide-over when a row is clicked', async () => {
    const user = userEvent.setup();
    render(
      <DriversList
        drivers={ROWS}
        onCreate={noop}
        onImport={noop}
        onExport={noop}
        onBulkDeactivate={noop}
      />,
    );
    await user.click(screen.getByText('Sergio Barba'));
    // Slide-over header repeats the name as an h2.
    const headings = screen.getAllByText('Sergio Barba');
    expect(headings.length).toBeGreaterThan(1);
    expect(screen.getByText('Identity')).toBeInTheDocument(); // Overview card title
  });
});
