import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar, type FilterChipValue, type FilterProperty } from '../filter-bar';

const PROPERTIES: FilterProperty[] = [
  {
    id: 'state',
    label: 'State',
    kind: 'enum',
    options: [
      { value: 'CA', label: 'California' },
      { value: 'OR', label: 'Oregon' },
      { value: 'WA', label: 'Washington' },
    ],
  },
  {
    id: 'license',
    label: 'License class',
    kind: 'enum',
    options: [
      { value: 'A', label: 'Class A' },
      { value: 'B', label: 'Class B' },
    ],
  },
];

describe('<FilterBar>', () => {
  it('shows only the trigger when value is empty', () => {
    render(<FilterBar properties={PROPERTIES} value={[]} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Filter/ })).toBeInTheDocument();
    expect(screen.queryByText('California')).not.toBeInTheDocument();
  });

  it('renders one chip per active filter', () => {
    const value: FilterChipValue[] = [{ propId: 'state', op: 'is', values: ['CA'] }];
    render(<FilterBar properties={PROPERTIES} value={value} onChange={() => {}} />);
    expect(screen.getByText('State')).toBeInTheDocument();
    expect(screen.getByText('is')).toBeInTheDocument();
    expect(screen.getByText('California')).toBeInTheDocument();
  });

  it('summarises multi-value chips with a +N tail', () => {
    const value: FilterChipValue[] = [
      { propId: 'state', op: 'is any of', values: ['CA', 'OR', 'WA'] },
    ];
    render(<FilterBar properties={PROPERTIES} value={value} onChange={() => {}} />);
    expect(screen.getByText('California, Oregon +1')).toBeInTheDocument();
  });

  it('removes the chip when the ✕ button is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: FilterChipValue[] = [{ propId: 'state', op: 'is', values: ['CA'] }];
    render(<FilterBar properties={PROPERTIES} value={value} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Remove filter' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('returns null in chips slot when there is nothing to render', () => {
    const { container } = render(
      <FilterBar properties={PROPERTIES} value={[]} onChange={() => {}} slot="chips" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('returns null in trigger slot when chips already exist', () => {
    const value: FilterChipValue[] = [{ propId: 'state', op: 'is', values: ['CA'] }];
    const { container } = render(
      <FilterBar properties={PROPERTIES} value={value} onChange={() => {}} slot="trigger" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
