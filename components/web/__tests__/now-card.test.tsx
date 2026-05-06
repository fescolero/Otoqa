import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
