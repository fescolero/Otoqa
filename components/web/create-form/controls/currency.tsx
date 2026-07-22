/**
 * Currency control — `NumberControl` with a forced `$` prefix. Kept as
 * its own file so schema authors can map `kind: 'currency'` 1:1 to a
 * file without thinking about prefix wiring.
 */

'use client';

import * as React from 'react';
import { NumberControl, type NumberControlProps } from './number';

export function CurrencyControl(props: Omit<NumberControlProps, 'prefix'>) {
  return <NumberControl {...props} prefix="$" />;
}
