import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Organization Settings',
};

export default function OrgSettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
