/**
 * Avatar — initials in a circle, hue derived from a hash of `name`.
 *
 * Pass a `color` to override the hashed hue (e.g. for system-tinted entities
 * like trucks). Initials are the first letter of the first two words.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

interface AvatarProps {
  name?: string;
  size?: number;
  color?: string;
  className?: string;
}

function hashHue(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

export function Avatar({ name, size = 24, color, className }: AvatarProps) {
  const initials = (name ?? '??')
    .split(' ')
    .map((s) => s[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const hue = hashHue(name ?? '');

  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-full shrink-0 font-semibold tracking-[0.02em]', className)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: color ?? `hsl(${hue}, 36%, 92%)`,
        color: color ? '#fff' : `hsl(${hue}, 38%, 30%)`,
      }}
    >
      {initials}
    </span>
  );
}
