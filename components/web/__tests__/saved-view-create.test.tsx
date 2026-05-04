import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SavedViewCreatePopover } from '../saved-view-create';
import { SavedViewsAddButton } from '../saved-views';

const createMock = vi.fn(async () => 'view_abc');

vi.mock('convex/react', () => ({
  useMutation: () => createMock,
}));

describe('<SavedViewCreatePopover>', () => {
  beforeEach(() => createMock.mockClear());

  it('renders the trigger and stays closed by default', () => {
    render(
      <SavedViewCreatePopover entity="drivers">
        <SavedViewsAddButton />
      </SavedViewCreatePopover>,
    );
    expect(screen.queryByText('Save current view')).not.toBeInTheDocument();
  });

  it('opens the popover on trigger click and shows scope choices', async () => {
    const user = userEvent.setup();
    render(
      <SavedViewCreatePopover entity="drivers">
        <SavedViewsAddButton />
      </SavedViewCreatePopover>,
    );
    await user.click(screen.getByTitle('Save current view'));
    expect(screen.getByText('Save current view')).toBeInTheDocument();
    expect(screen.getByText('Just me')).toBeInTheDocument();
    expect(screen.getByText('Whole team')).toBeInTheDocument();
  });

  it('blocks save when name is empty and shows an error', async () => {
    const user = userEvent.setup();
    render(
      <SavedViewCreatePopover entity="drivers">
        <SavedViewsAddButton />
      </SavedViewCreatePopover>,
    );
    await user.click(screen.getByTitle('Save current view'));
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('persists name + scope + supplied snapshot via the mutation', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <SavedViewCreatePopover
        entity="drivers"
        filters={[{ propId: 'state', op: 'is', values: ['CA'] }]}
        sort={{ key: 'name', dir: 'asc' }}
        visibleColumns={['name', 'state']}
        onCreated={onCreated}
      >
        <SavedViewsAddButton />
      </SavedViewCreatePopover>,
    );
    await user.click(screen.getByTitle('Save current view'));
    await user.type(screen.getByPlaceholderText('My drivers (West Coast)'), 'CA Drivers');
    await user.click(screen.getByText('Whole team'));
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    expect(createMock).toHaveBeenCalledWith({
      entity: 'drivers',
      name: 'CA Drivers',
      scope: 'org',
      filters: [{ propId: 'state', op: 'is', values: ['CA'] }],
      sort: { key: 'name', dir: 'asc' },
      visibleColumns: ['name', 'state'],
    });
    expect(onCreated).toHaveBeenCalledWith('view_abc');
  });
});
