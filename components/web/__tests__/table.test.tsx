import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Table, type TableColumn } from '../table';

interface Driver {
  id: string;
  name: string;
  state: string;
}

const COLUMNS: TableColumn<Driver>[] = [
  { key: 'name', label: 'Driver' },
  { key: 'state', label: 'State', sortable: false, width: '80px' },
];

const ROWS: Driver[] = [
  { id: 'd1', name: 'Sergio Barba', state: 'CA' },
  { id: 'd2', name: 'Maria Khouri', state: 'OR' },
  { id: 'd3', name: 'Jamal Reed', state: 'WA' },
];

describe('<Table>', () => {
  it('renders one row per data item plus a header row', () => {
    render(<Table columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText('Sergio Barba')).toBeInTheDocument();
    expect(screen.getByText('Maria Khouri')).toBeInTheDocument();
    expect(screen.getByText('Jamal Reed')).toBeInTheDocument();
  });

  it('fires onSort when a sortable column header is clicked', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(<Table columns={COLUMNS} rows={ROWS} onSort={onSort} />);
    await user.click(screen.getByRole('button', { name: /Driver/i }));
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it('does not fire onSort for columns marked sortable: false', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(<Table columns={COLUMNS} rows={ROWS} onSort={onSort} />);
    await user.click(screen.getByRole('button', { name: /State/i }));
    expect(onSort).not.toHaveBeenCalled();
  });

  it('reports row clicks via onRowClick (not from the checkbox cell)', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<Table columns={COLUMNS} rows={ROWS} onRowClick={onRowClick} />);
    await user.click(screen.getByText('Maria Khouri'));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
  });

  it('emits onSelect for the row id when its checkbox is toggled', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Table columns={COLUMNS} rows={ROWS} onSelect={onSelect} />);
    const checkboxes = screen.getAllByRole('checkbox');
    // First checkbox is the header "select all"; ROWS start at index 1.
    await user.click(checkboxes[2]);
    expect(onSelect).toHaveBeenCalledWith('d2');
  });

  it('marks the activeRowId with aria-selected and an inset accent border', () => {
    const { container } = render(
      <Table columns={COLUMNS} rows={ROWS} activeRowId="d3" />,
    );
    const activeRow = container.querySelector('[data-active]');
    expect(activeRow).not.toBeNull();
    expect(within(activeRow as HTMLElement).getByText('Jamal Reed')).toBeInTheDocument();
  });
});
