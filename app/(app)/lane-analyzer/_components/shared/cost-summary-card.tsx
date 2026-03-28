'use client';

import { Card, CardContent } from '@/components/ui/card';
import { type LucideIcon } from 'lucide-react';

interface CostSummaryCardProps {
  title: string;
  value: number;
  icon: LucideIcon;
  format: 'currency' | 'number' | 'percent';
  subtitle?: string;
}

export function CostSummaryCard({ title, value, icon: Icon, format, subtitle }: CostSummaryCardProps) {
  const formatted =
    format === 'currency'
      ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
      : format === 'percent'
        ? `${value.toFixed(1)}%`
        : value.toLocaleString();

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{title}</span>
        </div>
        <div className="mt-1 text-2xl font-bold">{formatted}</div>
        {subtitle && <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>}
      </CardContent>
    </Card>
  );
}
