'use client';

import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Package, DollarSign, Calendar, MapPin, Truck, Fuel } from 'lucide-react';
import type { ExtractionConfig } from './schedule-import-types';

interface ScheduleConfigureStepProps {
  config: ExtractionConfig;
  onChange: (config: ExtractionConfig) => void;
}

export function ScheduleConfigureStep({ config, onChange }: ScheduleConfigureStepProps) {
  const update = (partial: Partial<ExtractionConfig>) => {
    onChange({ ...config, ...partial });
  };

  const dataType =
    config.includeLogistics && config.includeFinancial
      ? 'both'
      : config.includeLogistics
        ? 'logistics'
        : 'financial';

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Configure Extraction</h2>
        <p className="text-sm text-muted-foreground">
          Tell us what data is in your schedule document so we can extract it
          accurately.
        </p>
      </div>

      {/* Question 1: Data type */}
      <Card className="p-5">
        <div className="flex items-start gap-3 mb-4">
          <Package className="h-5 w-5 text-primary mt-0.5" />
          <div>
            <Label className="text-base font-medium">
              What data does this schedule contain?
            </Label>
            <p className="text-sm text-muted-foreground mt-0.5">
              This controls which fields we extract from the document.
            </p>
          </div>
        </div>
        <RadioGroup
          value={dataType}
          onValueChange={(val) => {
            if (val === 'logistics') {
              update({ includeLogistics: true, includeFinancial: false, includeFuelSurcharge: false });
            } else if (val === 'financial') {
              update({
                includeLogistics: false,
                includeFinancial: true,
                stopDetailLevel: 'none',
                includeEquipment: false,
              });
            } else {
              update({ includeLogistics: true, includeFinancial: true });
            }
          }}
          className="grid grid-cols-3 gap-3"
        >
          {[
            { value: 'logistics', label: 'Logistics only', desc: 'Routes, stops, equipment' },
            { value: 'financial', label: 'Financial only', desc: 'Rates, surcharges' },
            { value: 'both', label: 'Both', desc: 'Logistics + financial' },
          ].map((opt) => (
            <label
              key={opt.value}
              className={`flex flex-col items-center gap-1 rounded-lg border-2 p-3 cursor-pointer transition-colors ${
                dataType === opt.value
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/30'
              }`}
            >
              <RadioGroupItem value={opt.value} className="sr-only" />
              <span className="text-sm font-medium">{opt.label}</span>
              <span className="text-xs text-muted-foreground">{opt.desc}</span>
            </label>
          ))}
        </RadioGroup>
      </Card>

      {/* Question 2: Dates */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-start gap-3">
            <Calendar className="h-5 w-5 text-primary mt-0.5" />
            <div>
              <Label className="text-base font-medium">
                Does the document include effective/expiration dates?
              </Label>
              <p className="text-sm text-muted-foreground mt-0.5">
                If not, you&apos;ll need to fill them in during review (they are
                required).
              </p>
            </div>
          </div>
          <Switch
            checked={config.extractDates}
            onCheckedChange={(checked) => update({ extractDates: checked })}
          />
        </div>
      </Card>

      {/* Question 3: Stop details (conditional) */}
      {config.includeLogistics && (
        <Card className="p-5">
          <div className="flex items-start gap-3 mb-4">
            <MapPin className="h-5 w-5 text-primary mt-0.5" />
            <div>
              <Label className="text-base font-medium">
                Does the document include stop/address details?
              </Label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Addresses will be verified against Google Maps.
              </p>
            </div>
          </div>
          <RadioGroup
            value={config.stopDetailLevel}
            onValueChange={(val) =>
              update({
                stopDetailLevel: val as 'full' | 'partial' | 'none',
              })
            }
            className="space-y-2"
          >
            {[
              {
                value: 'full',
                label: 'Yes, full addresses',
                desc: 'Street, city, state, zip',
              },
              {
                value: 'partial',
                label: 'Partial',
                desc: 'City and state only',
              },
              {
                value: 'none',
                label: 'No stop details',
                desc: 'Stops will be left empty',
              },
            ].map((opt) => (
              <label
                key={opt.value}
                className={`flex items-center gap-3 rounded-lg border-2 p-3 cursor-pointer transition-colors ${
                  config.stopDetailLevel === opt.value
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/30'
                }`}
              >
                <RadioGroupItem value={opt.value} />
                <div>
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {opt.desc}
                  </span>
                </div>
              </label>
            ))}
          </RadioGroup>
        </Card>
      )}

      {/* Question 4: Equipment (conditional) */}
      {config.includeLogistics && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <Truck className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <Label className="text-base font-medium">
                  Does the document include equipment requirements?
                </Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Trailer type and size (e.g. Dry Van 53ft).
                </p>
              </div>
            </div>
            <Switch
              checked={config.includeEquipment}
              onCheckedChange={(checked) =>
                update({ includeEquipment: checked })
              }
            />
          </div>
        </Card>
      )}

      {/* Question 5: Fuel surcharge (conditional) */}
      {config.includeFinancial && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <Fuel className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <Label className="text-base font-medium">
                  Does the document include fuel surcharge information?
                </Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  FSC percentage, flat amount, or DOE index reference.
                </p>
              </div>
            </div>
            <Switch
              checked={config.includeFuelSurcharge}
              onCheckedChange={(checked) =>
                update({ includeFuelSurcharge: checked })
              }
            />
          </div>
        </Card>
      )}
    </div>
  );
}
