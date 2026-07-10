/**
 * Driver create schema.
 *
 * Maps 1:1 to `api.drivers.create`. The mutation persists most fields
 * into the `drivers` table and the sensitive subset
 * (`licenseNumber`, `ssn`, `dateOfBirth`) into the parallel
 * `drivers_sensitive_info` table — that split happens server-side, so
 * the schema author can treat all driver fields uniformly here.
 *
 * Sections:
 *   - Identity            — first/middle/last + DOB + gender
 *   - Contact             — email/phone + home address (composite)
 *   - License             — class/CDL/state/exp/endorsements
 *   - Medical & security  — medical card + TWIC + badge
 *   - Employment          — hire date, type, status
 *   - Emergency contact   — optional contact-on-file
 *
 * SSN and DOB are kept simple (`kind: 'text'` for SSN, `'date'` for
 * DOB). They land in the sensitive table on the server. The schema
 * does NOT mask or encrypt — that's the persistence layer's job.
 *
 * Note: `licenseClass` is `kind: 'select'` with three CDL classes
 * (A / B / C). Schema authors adding edge cases like CDL+P can
 * extend the option list without changing the control shape.
 */

import type {
  CreateFormSchema,
  FieldOption,
} from '@/components/web/create-form';
import { US_STATE_OPTIONS } from '@/lib/forms/options/us-states';

const LICENSE_CLASS_OPTIONS: FieldOption[] = [
  { value: 'A', label: 'Class A' },
  { value: 'B', label: 'Class B' },
  { value: 'C', label: 'Class C' },
];

const EMPLOYMENT_STATUS_OPTIONS: FieldOption[] = [
  { value: 'Active', label: 'Active' },
  { value: 'On Leave', label: 'On leave' },
  { value: 'Suspended', label: 'Suspended' },
  { value: 'Terminated', label: 'Terminated' },
];

// Schedule-commitment axis — matches the canonical column comment in
// `convex/schema.ts` (`Full-time, Part-time, Contract`). The earlier
// list (Company Driver / Owner Operator / 1099 Contractor) described
// driver-relationship instead and has been retired here. Note: the
// Carrier Owner-Op bootstrap flow still writes
// `employmentType: 'Owner Operator'` on `carrierOrg.ts:~200`; that's
// a follow-up to align with this list (or move that flag onto a
// dedicated `driverRelationship` column).
const EMPLOYMENT_TYPE_OPTIONS: FieldOption[] = [
  { value: 'Full Time', label: 'Full Time' },
  { value: 'Part Time', label: 'Part Time' },
  { value: 'Contract', label: 'Contract' },
];

const CITIZENSHIP_OPTIONS: FieldOption[] = [
  { value: 'US Citizen', label: 'US citizen' },
  { value: 'Permanent Resident', label: 'Permanent resident' },
  { value: 'Work Visa', label: 'Work visa' },
  { value: 'Other', label: 'Other' },
];

const GENDER_OPTIONS: FieldOption[] = [
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
  { value: 'Other', label: 'Other' },
  { value: 'Prefer not to say', label: 'Prefer not to say' },
];

export const DRIVER_FIELD_IDS = {
  firstName: 'firstName',
  middleName: 'middleName',
  lastName: 'lastName',
  dateOfBirth: 'dateOfBirth',
  ssn: 'ssn',
  gender: 'gender',
  citizenship: 'citizenship',
  email: 'email',
  phone: 'phone',
  // Address sub-fields (kind: 'address' composite reads/writes these by id)
  addrStreet: 'address',
  addrSuite: 'address2',
  addrCity: 'city',
  addrState: 'state',
  addrZip: 'zipCode',
  licenseClass: 'licenseClass',
  licenseNumber: 'licenseNumber',
  licenseState: 'licenseState',
  licenseExpiration: 'licenseExpiration',
  medicalExpiration: 'medicalExpiration',
  twicExpiration: 'twicExpiration',
  badgeExpiration: 'badgeExpiration',
  hireDate: 'hireDate',
  employmentStatus: 'employmentStatus',
  employmentType: 'employmentType',
  preEmploymentCheckDate: 'preEmploymentCheckDate',
  emergencyContactName: 'emergencyContactName',
  emergencyContactRelationship: 'emergencyContactRelationship',
  emergencyContactPhone: 'emergencyContactPhone',
} as const;

export function buildDriverSchema(): CreateFormSchema {
  const ids = DRIVER_FIELD_IDS;
  return {
    entity: 'driver',
    // ⚠️ Bump on breaking changes. See docs/schema-evolution.md.
    draftKey: 'driver-create-v1',
    breadcrumb: ['Fleet Management', 'Drivers', 'New driver'],
    title: 'New driver',
    subtitle:
      'Hire info, license, medical card. Sensitive fields (DOB, SSN, DL #) are stored separately on the server.',
    sections: [
      {
        id: 'identity',
        title: 'Identity',
        fields: [
          {
            id: ids.firstName,
            label: 'First name',
            kind: 'text',
            required: 'tier1',
            placeholder: 'First',
          },
          {
            id: ids.middleName,
            label: 'Middle name',
            kind: 'text',
            placeholder: 'Optional',
          },
          {
            id: ids.lastName,
            label: 'Last name',
            kind: 'text',
            required: 'tier1',
            placeholder: 'Last',
          },
          {
            id: ids.dateOfBirth,
            label: 'Date of birth',
            kind: 'date',
            recommended: true,
            hint: 'Used for FMCSA reporting.',
          },
          {
            id: ids.gender,
            label: 'Gender',
            kind: 'select',
            options: GENDER_OPTIONS,
          },
          {
            id: ids.citizenship,
            label: 'Citizenship',
            kind: 'select',
            options: CITIZENSHIP_OPTIONS,
          },
          {
            id: ids.ssn,
            label: 'SSN',
            kind: 'mono',
            span: 2,
            placeholder: '000-00-0000',
            hint:
              'Stored in the sensitive-info table separately from the rest of the record.',
          },
        ],
      },
      {
        id: 'contact',
        title: 'Contact',
        fields: [
          {
            id: ids.phone,
            label: 'Phone',
            kind: 'text',
            required: 'tier1',
            placeholder: '(555) 555-0123',
            format: 'phone-us',
          },
          {
            id: ids.email,
            label: 'Email',
            kind: 'text',
            required: 'tier1',
            placeholder: 'driver@example.com',
            validate: (v) =>
              typeof v === 'string' && v && !v.includes('@')
                ? 'Looks like an incomplete email — did you mean to include @?'
                : null,
          },
          {
            id: 'address-composite',
            label: 'Home address',
            kind: 'address',
            recommended: true,
            ids: {
              street: ids.addrStreet,
              suite: ids.addrSuite,
              city: ids.addrCity,
              state: ids.addrState,
              zip: ids.addrZip,
            },
          },
        ],
      },
      {
        id: 'license',
        title: 'License',
        fields: [
          {
            // Was segmented (A / B / C pills with descriptive
            // sublines). Dropping to a select keeps the License row
            // tidy alongside DL # / State / Expires and matches the
            // visual weight of those neighbors. Option `value`
            // strings unchanged ('A' / 'B' / 'C'), so existing rows
            // continue to deserialize identically.
            id: ids.licenseClass,
            label: 'Class',
            kind: 'select',
            required: 'tier1',
            default: 'A',
            options: LICENSE_CLASS_OPTIONS,
          },
          {
            id: ids.licenseNumber,
            label: 'DL #',
            kind: 'mono',
            required: 'tier1',
            placeholder: '00000000',
            hint: 'Stored in the sensitive-info table.',
          },
          {
            id: ids.licenseState,
            label: 'State',
            kind: 'select',
            required: 'tier1',
            options: US_STATE_OPTIONS,
          },
          {
            id: ids.licenseExpiration,
            label: 'Expires',
            kind: 'date',
            required: 'tier1',
          },
        ],
      },
      {
        id: 'medical-security',
        title: 'Medical & security',
        subtitle: 'We’ll remind you 30 days before each expiration.',
        fields: [
          {
            id: ids.medicalExpiration,
            label: 'Medical card expires',
            kind: 'date',
            recommended: true,
          },
          {
            id: ids.twicExpiration,
            label: 'TWIC expires',
            kind: 'date',
            hint: 'Transportation Worker ID Card. Skip if not applicable.',
          },
          {
            id: ids.badgeExpiration,
            label: 'Site badge expires',
            kind: 'date',
            hint:
              'Customer-issued badges (port, distribution center, etc.).',
          },
        ],
      },
      {
        id: 'employment',
        title: 'Employment',
        fields: [
          {
            id: ids.employmentType,
            label: 'Type',
            // Was segmented (Company Driver / Owner Op / 1099). Now
            // a dropdown across schedule-commitment values
            // (Full Time / Part Time / Contract) to match the
            // Convex column's canonical contract. Dropping `span: 2`
            // since a select doesn't need the extra width.
            kind: 'select',
            required: 'tier1',
            default: 'Full Time',
            options: EMPLOYMENT_TYPE_OPTIONS,
          },
          {
            id: ids.employmentStatus,
            label: 'Status',
            kind: 'select',
            required: 'tier1',
            default: 'Active',
            options: EMPLOYMENT_STATUS_OPTIONS,
          },
          {
            id: ids.hireDate,
            label: 'Hire date',
            kind: 'date',
            required: 'tier1',
            default: todayYmd(),
          },
          {
            id: ids.preEmploymentCheckDate,
            label: 'Pre-employment check',
            kind: 'date',
            hint: 'DOT pre-employment drug + alcohol screen date.',
          },
        ],
      },
      {
        id: 'emergency',
        title: 'Emergency contact',
        subtitle: 'Optional but recommended — used if dispatch can’t reach the driver.',
        fields: [
          {
            id: ids.emergencyContactName,
            label: 'Name',
            kind: 'text',
            placeholder: 'First Last',
          },
          {
            id: ids.emergencyContactRelationship,
            label: 'Relationship',
            kind: 'text',
            placeholder: 'Spouse · parent · sibling',
          },
          {
            id: ids.emergencyContactPhone,
            label: 'Phone',
            kind: 'text',
            placeholder: '(555) 555-0123',
            format: 'phone-us',
          },
        ],
      },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Value-shape translator
 * ──────────────────────────────────────────────────────────────── */

export interface DriverCreateArgs {
  firstName: string;
  middleName?: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth?: string;
  ssn?: string;
  citizenship?: string;
  licenseNumber: string;
  licenseState: string;
  licenseExpiration: string;
  licenseClass: string;
  gender?: string;
  medicalExpiration?: string;
  badgeExpiration?: string;
  twicExpiration?: string;
  hireDate: string;
  employmentStatus: string;
  employmentType: string;
  terminationDate?: string;
  preEmploymentCheckDate?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  emergencyContactName?: string;
  emergencyContactRelationship?: string;
  emergencyContactPhone?: string;
}

export function mapValsToDriverArgs(
  vals: Record<string, unknown>,
): DriverCreateArgs {
  const ids = DRIVER_FIELD_IDS;
  return {
    firstName: String(vals[ids.firstName] ?? '').trim(),
    middleName: optionalStr(vals[ids.middleName]),
    lastName: String(vals[ids.lastName] ?? '').trim(),
    email: String(vals[ids.email] ?? '').trim(),
    phone: String(vals[ids.phone] ?? '').trim(),
    dateOfBirth: optionalStr(vals[ids.dateOfBirth]),
    ssn: optionalStr(vals[ids.ssn]),
    citizenship: optionalStr(vals[ids.citizenship]),
    licenseNumber: String(vals[ids.licenseNumber] ?? '').trim(),
    licenseState: String(vals[ids.licenseState] ?? ''),
    licenseExpiration: String(vals[ids.licenseExpiration] ?? ''),
    licenseClass: String(vals[ids.licenseClass] ?? 'A'),
    gender: optionalStr(vals[ids.gender]),
    medicalExpiration: optionalStr(vals[ids.medicalExpiration]),
    twicExpiration: optionalStr(vals[ids.twicExpiration]),
    badgeExpiration: optionalStr(vals[ids.badgeExpiration]),
    hireDate: String(vals[ids.hireDate] ?? todayYmd()),
    employmentStatus: String(vals[ids.employmentStatus] ?? 'Active'),
    employmentType: String(vals[ids.employmentType] ?? 'Full Time'),
    preEmploymentCheckDate: optionalStr(vals[ids.preEmploymentCheckDate]),
    address: optionalStr(vals[ids.addrStreet]),
    address2: optionalStr(vals[ids.addrSuite]),
    city: optionalStr(vals[ids.addrCity]),
    state: optionalStr(vals[ids.addrState]),
    zipCode: optionalStr(vals[ids.addrZip]),
    emergencyContactName: optionalStr(vals[ids.emergencyContactName]),
    emergencyContactRelationship: optionalStr(
      vals[ids.emergencyContactRelationship],
    ),
    emergencyContactPhone: optionalStr(vals[ids.emergencyContactPhone]),
  };
}

function optionalStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
