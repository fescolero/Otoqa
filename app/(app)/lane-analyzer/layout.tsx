import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Lane Analyzer',
};

export default function LaneAnalyzerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
