import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Loads',
};

export default function LoadsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
