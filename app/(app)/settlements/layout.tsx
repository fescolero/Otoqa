import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Settlements',
};

export default function SettlementsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
