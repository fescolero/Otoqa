import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditableField } from '../editable-field';

describe('<EditableField type="text">', () => {
  it('renders the value as a clickable display', () => {
    render(<EditableField type="text" value="(916) 824-3871" onCommit={() => {}} />);
    // The value itself is the clickable affordance (no separate "Edit" button).
    expect(screen.getByRole('button', { name: '(916) 824-3871' })).toBeInTheDocument();
  });

  it('enters edit mode on click and commits the new value on Enter', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<EditableField type="text" value="old" onCommit={onCommit} />);
    await user.click(screen.getByText('old'));
    const input = screen.getByDisplayValue('old');
    await user.clear(input);
    await user.type(input, 'new');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith('new');
  });

  it('reverts on Escape and never calls onCommit', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<EditableField type="text" value="original" onCommit={onCommit} />);
    await user.click(screen.getByText('original'));
    const input = screen.getByDisplayValue('original');
    await user.clear(input);
    await user.type(input, 'changed');
    await user.keyboard('{Escape}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('original')).toBeInTheDocument();
  });

  it('renders a placeholder when readOnly with no value', () => {
    render(<EditableField type="text" value="" readOnly placeholder="Not set" />);
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });
});

describe('<EditableField type="select">', () => {
  it('renders the option label, not the raw value', () => {
    render(
      <EditableField
        type="select"
        value="ca"
        onCommit={() => {}}
        options={[
          { value: 'ca', label: 'California' },
          { value: 'or', label: 'Oregon' },
        ]}
      />,
    );
    expect(screen.getByText('California')).toBeInTheDocument();
  });
});

describe('<EditableField type="multiselect">', () => {
  it('joins selected option labels with " · "', () => {
    render(
      <EditableField
        type="multiselect"
        value={['H', 'N', 'T']}
        onCommit={() => {}}
        options={[
          { value: 'H', label: 'H — Hazardous materials' },
          { value: 'N', label: 'N — Tank vehicles' },
          { value: 'T', label: 'T — Double/triple trailers' },
        ]}
      />,
    );
    expect(
      screen.getByText('H — Hazardous materials · N — Tank vehicles · T — Double/triple trailers'),
    ).toBeInTheDocument();
  });
});
