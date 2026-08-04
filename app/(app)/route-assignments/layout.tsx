import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Route Assignments',
};

export default function RouteAssignmentsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
