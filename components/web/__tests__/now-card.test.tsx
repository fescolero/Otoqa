import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NowDriverAvailable, NowDriverInTransit } from '../now-card';

describe('<NowDriverInTransit>', () => {
  it('renders load + route + truck/trailer/eta/hos rows', () => {
    render(
      <NowDriverInTransit
        load={{
          id: 'OT-2026-0418',
          from: 'Sacramento, CA',
          to: 'Salt Lake City, UT',
          truck: 'T-204 · Volvo VNL 760',
          trailer: 'TR-118 · 53′ dry van',
          eta: 'Today 18:42 PT',
          hosRemaining: '6h 12m',
        }}
      />,
    );
    expect(screen.getByText('In transit')).toBeInTheDocument();
    expect(screen.getByText('OT-2026-0418')).toBeInTheDocument();
    expect(screen.getByText(/Sacramento, CA/)).toBeInTheDocument();
    expect(screen.getByText(/Salt Lake City, UT/)).toBeInTheDocument();
    expect(screen.getByText('T-204 · Volvo VNL 760')).toBeInTheDocument();
    expect(screen.getByText('Today 18:42 PT')).toBeInTheDocument();
    expect(screen.getByText('6h 12m remaining')).toBeInTheDocument();
  });

  it('omits optional rows when not provided', () => {
    render(
      <NowDriverInTransit
        load={{ id: 'OT-1', from: 'A', to: 'B' }}
      />,
    );
    expect(screen.queryByText('Truck')).not.toBeInTheDocument();
    expect(screen.queryByText('Trailer')).not.toBeInTheDocument();
    expect(screen.queryByText('ETA')).not.toBeInTheDocument();
    expect(screen.queryByText('HOS')).not.toBeInTheDocument();
    expect(screen.queryByText('Next load')).not.toBeInTheDocument();
  });

  it('renders pickup, miles, and a clickable next-load row', () => {
    const onOpen = vi.fn();
    render(
      <NowDriverInTransit
        load={{
          id: 'OT-1',
          from: 'A',
          to: 'B',
          pickup: 'Sep 3, 2026',
          miles: '716 mi',
          nextLoad: { id: 'OT-2', route: 'Ontario → Moreno Valley', pickupWhen: 'Sep 5, 2026', onOpen },
        }}
      />,
    );
    // 'Pickup' labels both the current load's row and the next load's sub-line.
    expect(screen.getAllByText(/^Pickup/)).toHaveLength(2);
    expect(screen.getByText('Sep 3, 2026')).toBeInTheDocument();
    expect(screen.getByText('716 mi')).toBeInTheDocument();
    expect(screen.getByText('Next load')).toBeInTheDocument();
    expect(screen.getByText('Sep 5, 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /OT-2/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('<NowDriverAvailable>', () => {
  it('renders availability chip + status rows', () => {
    render(
      <NowDriverAvailable
        location="Sacramento, CA · home base"
        hosAvailable="38h 00m / 70h cycle"
        lastLoad={{ id: 'OT-2026-0411', deliveredOn: 'Apr 27' }}
        idleSince="3 days"
        equipment="Reefer-cert"
      />,
    );
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Sacramento, CA · home base')).toBeInTheDocument();
    expect(screen.getByText('38h 00m / 70h cycle')).toBeInTheDocument();
    expect(screen.getByText('OT-2026-0411')).toBeInTheDocument();
    expect(screen.getByText('3 days')).toBeInTheDocument();
  });

  it('renders a next-load row for an available driver with one queued', () => {
    render(
      <NowDriverAvailable
        location="Ontario, CA"
        nextLoad={{ id: 'OT-9', route: 'Redding → West Sacramento', pickupWhen: 'Sep 6, 2026' }}
      />,
    );
    expect(screen.getByText('Next load')).toBeInTheDocument();
    expect(screen.getByText('OT-9')).toBeInTheDocument();
    expect(screen.getByText(/Redding → West Sacramento/)).toBeInTheDocument();
    // No onOpen → plain text, not a button.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders matched-loads list with match-pct chips when provided', () => {
    render(
      <NowDriverAvailable
        matchedLoads={[
          { id: 'OT-A', route: 'Sacramento → Boise', pickupWhen: 'Tomorrow 06:30', miles: '583', matchPct: 96 },
          { id: 'OT-B', route: 'Stockton → SLC',     pickupWhen: 'May 06 08:00',   miles: '716', matchPct: 88 },
        ]}
      />,
    );
    expect(screen.getByText('Matched open loads')).toBeInTheDocument();
    expect(screen.getByText('OT-A')).toBeInTheDocument();
    expect(screen.getByText('96%')).toBeInTheDocument();
    expect(screen.getByText('88%')).toBeInTheDocument();
  });
});
