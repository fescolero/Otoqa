import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StatusPicker } from '../status-picker';

describe('<StatusPicker entity="driver">', () => {
  it('renders the current state as a clickable chip', () => {
    render(<StatusPicker entity="driver" currentId="active" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Active/ })).toBeInTheDocument();
  });

  it('opens a popover with valid next states grouped Active/Paused/Terminal on click', async () => {
    const user = userEvent.setup();
    render(<StatusPicker entity="driver" currentId="active" onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Active/ }));
    // Popover renders into a portal; query the document body.
    expect(await screen.findByText('Change status')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    // The "Terminal" category heading + per-state "Terminal" badges all
    // share the same text; we just need at least one.
    expect(screen.getAllByText('Terminal').length).toBeGreaterThanOrEqual(1);
    // Some states from the driver machine
    expect(screen.getByRole('button', { name: /On leave/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Suspended/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Terminated/ })).toBeInTheDocument();
  });

  it('disables disallowed transitions (Onboarding from Active)', async () => {
    const user = userEvent.setup();
    render(<StatusPicker entity="driver" currentId="active" onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Active/ }));
    // From Active, transitions = ['on_leave','suspended','ooo','terminated','retired'] —
    // 'onboarding' is NOT allowed and should be disabled.
    const onboardingBtn = await screen.findByRole('button', { name: /Onboarding/ });
    expect(onboardingBtn).toBeDisabled();
  });

  it('opens the confirmation modal when picking a new state', async () => {
    const user = userEvent.setup();
    render(<StatusPicker entity="driver" currentId="active" onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Active/ }));
    await user.click(await screen.findByRole('button', { name: /On leave/ }));
    // Confirmation modal lands.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Confirm status change')).toBeInTheDocument();
    expect(screen.getByText('Effective date')).toBeInTheDocument();
    expect(screen.getByText('Reason')).toBeInTheDocument();
  });

  it('disables the submit until a reason is picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StatusPicker entity="driver" currentId="active" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Active/ }));
    await user.click(await screen.findByRole('button', { name: /On leave/ }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: /Change to On leave/ });
    expect(submit).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    // Picking a reason re-enables it.
    await user.click(within(dialog).getByRole('button', { name: 'Medical' }));
    expect(submit).toBeEnabled();
  });

  it('commits with the chosen reason + effective date', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StatusPicker entity="driver" currentId="active" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Active/ }));
    await user.click(await screen.findByRole('button', { name: /On leave/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Medical' }));
    await user.click(within(dialog).getByRole('button', { name: /Change to On leave/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [payload] = onChange.mock.calls[0];
    expect(payload.from.id).toBe('active');
    expect(payload.to.id).toBe('on_leave');
    expect(payload.reason).toBe('Medical');
    // effectiveDate defaults to today (ISO yyyy-mm-dd).
    expect(payload.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows a Terminal warning callout for terminal transitions', async () => {
    const user = userEvent.setup();
    render(<StatusPicker entity="driver" currentId="active" onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Active/ }));
    await user.click(await screen.findByRole('button', { name: /Terminated/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Terminal status\./)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Set Terminated/ })).toBeInTheDocument();
  });
});
