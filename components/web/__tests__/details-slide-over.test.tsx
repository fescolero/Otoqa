import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DetailsSlideOver, type DetailsSection } from '../details-slide-over';

const SECTIONS: DetailsSection[] = [
  { id: 'overview', label: 'Overview', content: <div>Overview body</div> },
  { id: 'docs', label: 'Documents', count: 4, attention: 2, content: <div>Docs body</div> },
  { id: 'trips', label: 'Trips', count: 12, content: <div>Trips body</div> },
];

describe('<DetailsSlideOver>', () => {
  it('does not render content when closed', () => {
    render(
      <DetailsSlideOver
        open={false}
        onClose={() => {}}
        header={<div>Sergio Barba</div>}
        sections={SECTIONS}
      />,
    );
    expect(screen.queryByText('Overview body')).not.toBeInTheDocument();
  });

  it('renders the header and the first section by default in tabs layout', () => {
    render(
      <DetailsSlideOver
        open
        onClose={() => {}}
        header={<div>Sergio Barba</div>}
        sections={SECTIONS}
      />,
    );
    expect(screen.getByText('Sergio Barba')).toBeInTheDocument();
    expect(screen.getByText('Overview body')).toBeInTheDocument();
    expect(screen.queryByText('Trips body')).not.toBeInTheDocument();
  });

  it('switches sections when a tab is clicked', async () => {
    const user = userEvent.setup();
    render(
      <DetailsSlideOver
        open
        onClose={() => {}}
        header={<div>Sergio Barba</div>}
        sections={SECTIONS}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Trips/ }));
    expect(screen.getByText('Trips body')).toBeInTheDocument();
    expect(screen.queryByText('Overview body')).not.toBeInTheDocument();
  });

  it('shows an attention badge on the Documents tab', () => {
    render(
      <DetailsSlideOver
        open
        onClose={() => {}}
        header={<div>Sergio Barba</div>}
        sections={SECTIONS}
      />,
    );
    const tab = screen.getByRole('button', { name: /Documents/ });
    expect(tab).toHaveTextContent('2');
  });

  it('renders all sections stacked in scroll layout', () => {
    render(
      <DetailsSlideOver
        open
        onClose={() => {}}
        layout="scroll"
        header={<div>Sergio Barba</div>}
        sections={SECTIONS}
      />,
    );
    expect(screen.getByText('Overview body')).toBeInTheDocument();
    expect(screen.getByText('Docs body')).toBeInTheDocument();
    expect(screen.getByText('Trips body')).toBeInTheDocument();
  });

  it('exposes an Open full page button when onOpenFull is provided', async () => {
    const user = userEvent.setup();
    const onOpenFull = vi.fn();
    render(
      <DetailsSlideOver
        open
        onClose={() => {}}
        header={<div>Sergio Barba</div>}
        sections={SECTIONS}
        onOpenFull={onOpenFull}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Open full page/ }));
    expect(onOpenFull).toHaveBeenCalledTimes(1);
  });
});
