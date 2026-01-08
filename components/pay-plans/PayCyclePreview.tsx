'use client';

import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Calendar, CalendarCheck, Banknote } from 'lucide-react';

interface PayCyclePreviewProps {
  frequency: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';
  periodStartDayOfWeek?: 'SUNDAY' | 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY';
  periodStartDayOfMonth?: number;
  paymentLagDays: number;
}

export function PayCyclePreview({
  frequency,
  periodStartDayOfWeek,
  periodStartDayOfMonth,
  paymentLagDays,
}: PayCyclePreviewProps) {
  // Fetch period preview from the backend
  const periods = useQuery(api.payPlans.previewPeriods, {
    frequency,
    periodStartDayOfWeek,
    periodStartDayOfMonth,
    paymentLagDays,
  });

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };

  const formatFullDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <Card className="sticky top-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          Pay Cycle Preview
        </CardTitle>
      </CardHeader>
      <CardContent>
        {periods === undefined ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading preview...
          </div>
        ) : periods.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Configure settings to see preview
          </div>
        ) : (
          <div className="space-y-4">
            {periods.map((period, index) => (
              <div
                key={index}
                className={`relative rounded-lg border p-3 ${
                  index === 0
                    ? 'bg-primary/5 border-primary/20'
                    : 'bg-muted/30'
                }`}
              >
                {index === 0 && (
                  <div className="absolute -top-2 left-3 px-2 bg-primary text-primary-foreground text-[10px] font-medium rounded-full">
                    Current Period
                  </div>
                )}
                
                <div className="space-y-2 pt-1">
                  {/* Period Range */}
                  <div className="flex items-center gap-2">
                    <CalendarCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium">
                      {formatDate(period.periodStart)} – {formatDate(period.periodEnd)}
                    </span>
                  </div>

                  {/* Pay Date */}
                  <div className="flex items-center gap-2">
                    <Banknote className="h-3.5 w-3.5 text-green-600 shrink-0" />
                    <span className="text-sm text-muted-foreground">
                      Pay Date:{' '}
                      <span className="font-medium text-foreground">
                        {formatFullDate(period.payDate)}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            ))}

            <p className="text-xs text-muted-foreground text-center pt-2">
              Next 3 pay periods based on current settings
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

