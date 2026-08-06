import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ConvexClientProvider } from '@/components/ConvexClientProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Otoqa Platform Console',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
