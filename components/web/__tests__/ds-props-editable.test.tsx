import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DSPropsEditable, type DSPropsEditableItem } from '../ds-card';

describe('<DSPropsEditable>', () => {
  const items: DSPropsEditableItem[] = [
    {
      key: 'phone',
      label: 'Phone',
      value: '(916) 824-3871',
      editor: { type: 'phone' },
    },
    {
      key: 'cls',
      label: 'Class',
      value: 'A',
      editor: {
        type: 'select',
        options: [
          { value: 'A', label: 'Class A' },
          { value: 'B', label: 'Class B' },
        ],
      },
    },
    {
      key: 'id',
      label: 'Driver ID',
      value: 'DR-7218',
      readOnly: true,
    },
  ];

  it('renders one row per item with the field label and current value', () => {
    render(<DSPropsEditable items={items} />);
    expect(screen.getByText('Phone')).toBeInTheDocument();
    expect(screen.getByText('Class')).toBeInTheDocument();
    expect(screen.getByText('Driver ID')).toBeInTheDocument();
    expect(screen.getByText('(916) 824-3871')).toBeInTheDocument();
    expect(screen.getByText('Class A')).toBeInTheDocument();
    expect(screen.getByText('DR-7218')).toBeInTheDocument();
  });

  it('drops null/false items so callers can use conditional rows', () => {
    render(
      <DSPropsEditable
        items={[
          items[0],
          null,
          false,
          items[2],
        ]}
      />,
    );
    expect(screen.getByText('Phone')).toBeInTheDocument();
    expect(screen.getByText('Driver ID')).toBeInTheDocument();
    expect(screen.queryByText('Class')).not.toBeInTheDocument();
  });

  it('forwards committed values back keyed by the row key', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DSPropsEditable items={items} onCommit={onCommit} />);
    await user.click(screen.getByText('(916) 824-3871'));
    const input = screen.getByDisplayValue('(916) 824-3871');
    await user.clear(input);
    await user.type(input, '(530) 555-1212');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith('phone', '(530) 555-1212');
  });

  it('skips edit affordance for readOnly rows', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DSPropsEditable items={items} onCommit={onCommit} />);
    // readOnly rows render their value as plain text — no edit affordance.
    const driverIdEl = screen.getByText('DR-7218');
    await user.click(driverIdEl);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
