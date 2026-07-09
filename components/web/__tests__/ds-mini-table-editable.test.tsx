import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DSMiniTable, type DSMiniColumn } from '../ds-mini-table';

interface DocRow {
  id: string;
  name: string;
  category: string;
  expires: string;
  status: 'valid' | 'expired';
}

const cols: DSMiniColumn<DocRow>[] = [
  { key: 'name', label: 'Document', width: '1.4fr' },
  {
    key: 'category',
    label: 'Category',
    width: '110px',
    editor: {
      type: 'select',
      options: [
        { value: 'License', label: 'License' },
        { value: 'Medical', label: 'Medical' },
      ],
    },
  },
  {
    key: 'status',
    label: 'Status',
    width: '100px',
    render: (r) => <span data-testid={`status-${r.id}`}>{r.status}</span>,
    readOnly: true,
  },
];

const rows: DocRow[] = [
  { id: 'r1', name: 'CDL Class C', category: 'License', expires: '2026-04-30', status: 'expired' },
  { id: 'r2', name: 'Medical card', category: 'Medical', expires: '2026-09-30', status: 'valid' },
];

describe('<DSMiniTable> per-cell editing', () => {
  it('keeps every cell read-only when editable is off', () => {
    render(<DSMiniTable columns={cols} rows={rows} />);
    expect(screen.queryByRole('button', { name: 'Choose option' })).not.toBeInTheDocument();
  });

  it('wraps cells in an editor only when both editable AND a column.editor are present', () => {
    render(<DSMiniTable columns={cols} rows={rows} editable onCellCommit={() => {}} />);
    // Two select cells (Category × 2 rows). Status stays read-only via
    // explicit readOnly flag; Document has no editor config.
    expect(screen.getAllByRole('button', { name: 'Choose option' })).toHaveLength(2);
  });

  it('forwards committed values keyed by row + column', async () => {
    const user = userEvent.setup();
    const onCellCommit = vi.fn();
    render(<DSMiniTable columns={cols} rows={rows} editable onCellCommit={onCellCommit} />);
    // Open row 2's category popover (Medical → switch to License). We pick
    // row 2 so the "License" option in the popover is unambiguous (row 1's
    // display value is also "License", but its popover stays closed).
    await user.click(screen.getAllByRole('button', { name: 'Choose option' })[1]);
    // The portaled popover renders into document.body; with row 1's cell
    // also showing "License", we resolve by finding the button-role list
    // item.
    const licenseOption = await screen.findByRole('button', { name: 'License' });
    await user.click(licenseOption);
    expect(onCellCommit).toHaveBeenCalledTimes(1);
    const [committedRow, key, next] = onCellCommit.mock.calls[0];
    expect(committedRow).toEqual(rows[1]);
    expect(key).toBe('category');
    expect(next).toBe('License');
  });

  it('still respects column.readOnly even when the table is editable', () => {
    render(<DSMiniTable columns={cols} rows={rows} editable onCellCommit={() => {}} />);
    // Status renders the chip, never an editor.
    expect(screen.getByTestId('status-r1')).toHaveTextContent('expired');
    expect(screen.getByTestId('status-r2')).toHaveTextContent('valid');
  });
});
