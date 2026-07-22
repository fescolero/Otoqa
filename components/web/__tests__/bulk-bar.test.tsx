import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BulkAction, BulkBar } from '../bulk-bar';

describe('<BulkBar>', () => {
  it('returns null when count is 0', () => {
    const { container } = render(<BulkBar count={0} onClear={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the selection count and renders actions', () => {
    render(
      <BulkBar
        count={5}
        onClear={() => {}}
        actions={
          <>
            <BulkAction icon="export" label="Export" />
            <BulkAction icon="alert" label="Archive" danger />
          </>
        }
      />,
    );
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Archive/ })).toBeInTheDocument();
  });

  it('calls onClear when the Clear button is clicked', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<BulkBar count={3} onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
