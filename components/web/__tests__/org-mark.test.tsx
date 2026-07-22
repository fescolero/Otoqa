import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrgMark, orgMonogram } from '../org-mark';

describe('orgMonogram', () => {
  it('takes the first letters of the first two words', () => {
    expect(orgMonogram('Central Valley Freight LLC')).toBe('CV');
    expect(orgMonogram('Otoqa')).toBe('O');
  });

  it('ignores extra whitespace and falls back for empty names', () => {
    expect(orgMonogram('  Fleet   Test  ')).toBe('FT');
    expect(orgMonogram('')).toBe('?');
    expect(orgMonogram('   ')).toBe('?');
  });
});

describe('<OrgMark>', () => {
  it('renders the monogram when there is no logo', () => {
    render(<OrgMark name="Central Valley Freight" />);
    expect(screen.getByText('CV')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders the uploaded logo instead of the monogram', () => {
    render(<OrgMark name="Central Valley Freight" logoUrl="https://example.com/logo.png" />);
    const img = screen.getByAltText('Central Valley Freight logo');
    expect(img).toHaveAttribute('src', 'https://example.com/logo.png');
    expect(screen.queryByText('CV')).not.toBeInTheDocument();
  });

  it('scales the tile to the requested size', () => {
    render(<OrgMark name="Otoqa" size={56} />);
    expect(screen.getByText('O')).toHaveStyle({ width: '56px', height: '56px' });
  });
});

describe('<OrgMark> adaptive logo background', () => {
  const tile = (name: string) => screen.getByAltText(`${name} logo`).parentElement!;

  it('plates a transparent dark logo on white', () => {
    render(
      <OrgMark
        name="A"
        logoUrl="https://example.com/a.png"
        logoTraits={{ tone: 'dark', hasAlpha: true }}
      />,
    );
    expect(tile('A')).toHaveStyle({ background: '#FFFFFF' });
  });

  it('plates a transparent light logo on a dark surface', () => {
    render(
      <OrgMark
        name="B"
        logoUrl="https://example.com/b.png"
        logoTraits={{ tone: 'light', hasAlpha: true }}
      />,
    );
    expect(tile('B')).toHaveStyle({ background: '#0F172A' });
  });

  it('leaves colorful and self-backgrounded logos on the neutral tile', () => {
    render(
      <OrgMark
        name="C"
        logoUrl="https://example.com/c.png"
        logoTraits={{ tone: 'colorful', hasAlpha: true }}
      />,
    );
    render(
      <OrgMark
        name="D"
        logoUrl="https://example.com/d.png"
        logoTraits={{ tone: 'dark', hasAlpha: false }}
      />,
    );
    expect(tile('C')).toHaveStyle({ background: 'var(--bg-surface-2)' });
    expect(tile('D')).toHaveStyle({ background: 'var(--bg-surface-2)' });
  });
});
