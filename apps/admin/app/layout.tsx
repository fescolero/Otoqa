import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Geist, Geist_Mono, Instrument_Serif } from 'next/font/google';
import { ConvexClientProvider } from '@/components/ConvexClientProvider';
import './globals.css';

/**
 * Typefaces. `next/font` fetches these at BUILD time and serves them from our
 * own origin, so the running console never calls Google — which matters for a
 * staff tool that has to work during an incident, and for one whose page views
 * shouldn't be visible to a third party.
 */
const display = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
  fallback: ['Iowan Old Style', 'Georgia', 'serif'],
});

const sans = Geist({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
});

const mono = Geist_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
});

export const metadata: Metadata = {
  title: 'Otoqa Platform Console',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
