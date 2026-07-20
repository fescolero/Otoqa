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
