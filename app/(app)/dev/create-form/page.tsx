'use client';

/**
 * Dev-only smoke test for `<CreateForm>`. Mounted at
 * `/_dev/create-form`. Not linked from the nav. Delete or
 * gate behind an env flag before shipping.
 *
 * Exercises every field kind that doesn't require a Convex mutation:
 * text, mono, number, currency, date, select, segmented, toggle,
 * textarea, address. Adds a `showIf` and a `validate` so progressive
 * disclosure + per-field error rendering can be inspected by hand.
 *
 * `file` and `stops-list` are omitted here — file needs a real
 * `generateUploadUrl`, and stops-list is a Phase 3.6 stub.
 */

import * as React from 'react';
import { CreateForm } from '@/components/web/create-form';
import type { CreateFormSchema } from '@/components/web/create-form';

const SMOKE_SCHEMA: CreateFormSchema = {
  entity: 'smoke',
  breadcrumb: ['Dev', 'Create form', 'Smoke test'],
  title: 'Create-form smoke test',
  subtitle:
    'Every non-Convex field kind is exercised. Pick the Owner-Op type to see a section appear; submit empty to see the error summary + jump-to-error.',
  sections: [
    {
      id: 'type',
      title: 'Choose a path',
      subtitle: 'Owner Op reveals the conditional driver block below.',
      fields: [
        {
          id: 'type',
          label: 'Carrier type',
          kind: 'segmented',
          required: 'tier1',
          default: 'fleet',
          options: [
            { value: 'fleet', label: 'Fleet', icon: 'handshake', hint: 'multi-truck' },
            { value: 'owner-op', label: 'Owner Op', icon: 'id-card', hint: 'single driver' },
          ],
        },
      ],
    },
    {
      id: 'identity',
      title: 'Identity',
      fields: [
        {
          id: 'name',
          label: 'Legal name',
          kind: 'text',
          required: 'tier1',
          span: 2,
          placeholder: 'e.g. Pacific Crest Logistics',
          hint: 'As shown on the W-9.',
        },
        {
          id: 'dba',
          label: 'DBA / Trade name',
          kind: 'text',
          placeholder: 'Leave blank if same as legal',
        },
        {
          id: 'mc',
          label: 'Operating Auth (MC#)',
          kind: 'mono',
          required: 'tier1',
          placeholder: '000000',
          prefix: 'MC-',
        },
        {
          id: 'authority',
          label: 'Authority type',
          kind: 'select',
          recommended: true,
          options: [
            { value: 'common', label: 'Common · for-hire' },
            { value: 'contract', label: 'Contract · dedicated' },
            { value: 'both', label: 'Both' },
          ],
        },
      ],
    },
    {
      id: 'driver',
      title: 'Owner Operator — driver',
      subtitle: 'Shows only when Carrier type = Owner Op.',
      accent: true,
      showIf: (v) => v.type === 'owner-op',
      fields: [
        {
          id: 'driverName',
          label: 'Driver name',
          kind: 'text',
          required: 'tier1',
          placeholder: 'First Last',
        },
        {
          id: 'driverPhone',
          label: 'Phone',
          kind: 'text',
          required: 'tier1',
          placeholder: '(555) 555-0123',
          validate: (v) =>
            v && String(v).replace(/\D/g, '').length < 10
              ? 'Phone needs 10 digits.'
              : null,
        },
      ],
    },
    {
      id: 'capacity',
      title: 'Capacity',
      fields: [
        {
          id: 'fleetSize',
          label: 'Fleet size',
          kind: 'number',
          recommended: true,
          suffix: 'trucks',
          placeholder: '0',
        },
        {
          id: 'cargoLimit',
          label: 'Cargo insurance',
          kind: 'currency',
          recommended: true,
          placeholder: '100,000',
        },
        {
          id: 'effectiveDate',
          label: 'Onboard date',
          kind: 'date',
          required: 'tier1',
        },
        {
          id: 'sameMail',
          label: 'Mailing address',
          kind: 'toggle',
          toggleLabel: 'Same as physical',
          default: true,
        },
      ],
    },
    {
      id: 'address',
      title: 'Address',
      fields: [
        {
          id: 'physicalAddr',
          label: 'Physical address',
          kind: 'address',
          required: 'tier1',
          ids: {
            street: 'addrStreet',
            suite: 'addrSuite',
            city: 'addrCity',
            state: 'addrState',
            zip: 'addrZip',
          },
        },
      ],
    },
    {
      id: 'notes',
      title: 'Notes',
      fields: [
        {
          id: 'notes',
          label: 'Internal notes',
          kind: 'textarea',
          span: 2,
          rows: 3,
          placeholder: 'Optional · not shown to the carrier.',
        },
      ],
    },
  ],
};

export default function CreateFormSmokeTest() {
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <CreateForm
        schema={SMOKE_SCHEMA}
        onCancel={() => alert('Cancel clicked')}
        onSaved={(vals, andNew) => {
          console.log('saved', { vals, andNew });
          alert(
            (andNew ? 'Save & New: ' : 'Saved: ') +
              JSON.stringify(vals, null, 2),
          );
        }}
      />
    </div>
  );
}
