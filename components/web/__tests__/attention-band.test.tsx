import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AttentionBand } from '../attention-band';

describe('<AttentionBand>', () => {
  it('renders the headline alone when items is empty', () => {
    render(<AttentionBand headline="Sergio is available." items={[]} />);
    expect(screen.getByText('Sergio is available.')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders one button per item with title and detail', () => {
    render(
      <AttentionBand
        headline="x"
        items={[
          { tone: 'info', icon: 'truck', tab: 'loads', title: 'On OT-2026-0418', detail: 'ETA 18:42 PT' },
          { tone: 'warn', icon: 'shield', tab: 'documents', title: 'License expiring', detail: 'May 2, 2026' },
        ]}
      />,
    );
    expect(screen.getByText('On OT-2026-0418')).toBeInTheDocument();
    expect(screen.getByText('ETA 18:42 PT')).toBeInTheDocument();
    expect(screen.getByText('License expiring')).toBeInTheDocument();
  });

  it('emits onJump(tab) when an item with a tab is clicked', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(
      <AttentionBand
        headline="x"
        items={[{ tone: 'warn', tab: 'documents', title: 'License expiring' }]}
        onJump={onJump}
      />,
    );
    await user.click(screen.getByRole('button', { name: /License expiring/ }));
    expect(onJump).toHaveBeenCalledWith('documents');
  });

  it('disables items that have no `tab`', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(
      <AttentionBand
        headline="x"
        items={[{ tone: 'info', title: '4 documents on file' }]}
        onJump={onJump}
      />,
    );
    const btn = screen.getByRole('button', { name: /4 documents on file/ });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onJump).not.toHaveBeenCalled();
  });
});
