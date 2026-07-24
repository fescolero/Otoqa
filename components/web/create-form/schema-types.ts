/**
 * Create-form schema contract.
 *
 * The shell at `components/web/create-form/` is **schema-driven**: every
 * record type (Carrier, Customer, Driver, Truck, Trailer, Load,
 * Diesel/DEF, …) is described by a `CreateFormSchema` object and
 * rendered through the same `<CreateForm>` chrome. No per-type layout
 * code. See `docs/create-form-rollout.md` for the full design spec.
 *
 * ## Two architectural rules these types enforce
 *
 * 1. **Sections are presentation, not storage.** A "section" is a UI
 *    grouping for the rail and visual cards — it does NOT imply a
 *    separate DB table. Flat storage, grouped UX.
 *
 * 2. **Value-shape translation lives in the PAGE WRAPPER, not the
 *    shell.** The shell stores everything as flat `vals[fieldId]` with
 *    whatever shape each control naturally emits (date kind → ISO
 *    string, select → option `value` string, toggle → boolean). The
 *    page wrapper's `onSaved` is the only code that knows the
 *    mutation's arg shape and does the mapping (date string → number,
 *    `'fuel-card'` → `'FUEL_CARD'`, separate `city`/`state` →
 *    `location: {…}`, string → `Id<…>` cast, etc.).
 *
 *    As a consequence, **this file must never import from
 *    `convex/_generated/api`**. Schemas are pure data.
 */

/** What kind of input a field renders as. */
export type FieldKind =
  | 'text'        // default — wraps <Input>
  | 'mono'        // monospace ID-style — <Input> + optional prefix/suffix via <InputGroup>
  | 'number'      // numeric — wraps <NumberInput>
  | 'currency'    // numeric with $ prefix — wraps <NumberInput>
  | 'date'        // wraps <DatePicker>; control emits YYYY-MM-DD
  | 'select'      // wraps <Select>
  | 'segmented'   // pill switcher (2–4 options) — new
  | 'toggle'      // wraps <Switch>
  | 'textarea'    // wraps <Textarea>
  | 'file'        // wraps an uploader bound to a per-entity generateUploadUrl
  | 'address'     // composite (full row) — wraps <AddressAutocomplete>
  | 'stops-list'  // composite (full row) — repeating pickup/delivery list (Phase 3.6)
  | 'lane-stops'  // composite (full row) — contract-lane stop cards w/ facility binding
  | 'days';       // S M T W T F S weekday toggles — value is number[] (0 = Sunday)

/**
 * Whether the field blocks save when empty. Anything other than
 * `'tier1'` is non-blocking (combine with `recommended: true` to show
 * the amber "Recommended" tag). Omit for purely optional fields — the
 * design intentionally shows no "Optional" tag.
 */
export type RequiredTier = 'tier1';

/** Predicate over the current form values. Used for progressive disclosure. */
export type ShowIfPredicate = (vals: FormValues) => boolean;

/** A single option for `select` or `segmented`. */
export interface FieldOption {
  value: string;
  label: string;
  /** Small helper line under the label (segmented only). */
  hint?: string;
  /** Icon name from our WIcon set (segmented only). */
  icon?: string;
}

/**
 * Async upload action — the page wrapper supplies this for each `file`
 * field by binding the right Convex `generateUploadUrl` mutation. The
 * shell calls it to get a one-time upload URL string (Convex's
 * `ctx.storage.generateUploadUrl()` returns the URL directly), POSTs
 * the blob, then stores the returned `storageId` in `vals[fieldId]`.
 *
 * Shape matches `useMutation(api.<entity>.generateUploadUrl)` exactly,
 * so the page wrapper can pass it straight through with no remap.
 */
export type FileUploader = () => Promise<string>;

/** Generic form values map. Keys are field ids. */
export type FormValues = Record<string, unknown>;

/** Duplicate-check hit shape — see `dupCheck` below. */
export interface DupCheckHit {
  /** Display name of the existing record (e.g. "Pacific Crest Logistics"). */
  label: string;
  /** Secondary detail (e.g. "MC-512447"). */
  detail: string;
}

export interface FormField {
  /** Unique within the schema. Used as the vals key, DOM `id`, scroll anchor. */
  id: string;
  /** Visible label text above the control. */
  label: string;
  /** Control kind. Defaults to `'text'`. */
  kind?: FieldKind;
  /** `'tier1'` blocks save when empty. Omit otherwise. */
  required?: RequiredTier;
  /** Show the amber "Recommended" tag (ignored if `required === 'tier1'`). */
  recommended?: boolean;
  /** Grid track span. `2` widens to two tracks; composites always full-row. */
  span?: 1 | 2;
  /** Placeholder text. */
  placeholder?: string;
  /**
   * Live-format the value as the user types. Currently only
   * `'phone-us'` is implemented — strips non-digits, caps at 10, and
   * renders as `(XXX) XXX-XXXX` progressively. Storage value matches
   * the formatted display string (no separate raw-vs-display state).
   */
  format?: 'phone-us';
  /**
   * `kind: 'number'` only. Apply thousands-separator commas to the
   * display value. Defaults to `true`. Set `false` for ID-shaped
   * numerics where a comma is wrong — years (`2,024` → `2024`),
   * serial numbers, PINs.
   */
  grouping?: boolean;
  /** Helper line shown under the field when there's no error. */
  hint?: string;
  /** Initial value. If omitted, the shell seeds an empty value for the kind. */
  default?: unknown;
  /** mono/text prefix (e.g. "MC-", "$"). */
  prefix?: string;
  /** number suffix (e.g. "gal", "lbs", "°F"). */
  suffix?: string;
  /** textarea row count. Defaults to 3. */
  rows?: number;
  /** toggle: the descriptive label rendered next to the switch. */
  toggleLabel?: string;
  /** select / segmented options. */
  options?: FieldOption[];
  /** address composite — sub-field id mapping. */
  ids?: {
    street: string;
    suite?: string;
    city: string;
    state: string;
    zip: string;
  };
  /** file: MIME / extension hint for the picker. */
  accept?: string;
  /**
   * lane-stops: customer facility rows for the per-stop facility
   * binding dropdown. Injected by the page wrapper through the schema
   * factory (like select `options`) — plain data, no Convex imports.
   */
  facilities?: import('./controls/lane-stops').LaneFacilityOption[];
  /**
   * file: bound by the page wrapper via `bindUploaders(schema, {...})`.
   * Shell-side default is `undefined`; the field renders as disabled
   * until the page wrapper attaches one.
   */
  uploader?: FileUploader;
  /**
   * Conditional visibility. Hidden fields are skipped by `validate()`,
   * so a hidden `tier1` field cannot block save.
   */
  showIf?: ShowIfPredicate;
  /**
   * Per-field validation beyond required/tier1. Return a string message
   * to fail, `null` to pass. Runs only on Save (not on each keystroke).
   */
  validate?: (v: unknown, vals: FormValues) => string | null;
  /**
   * Soft duplicate detection. Runs against existing records (typically
   * a debounced Convex query in the page wrapper). Shown as an amber
   * inset block under the field with "Open existing" / "Continue anyway"
   * affordances. Never blocks save.
   */
  dupCheck?: (v: unknown, vals: FormValues) => DupCheckHit | null;
  /** Override the default "{label} is required to save." message. */
  requiredMsg?: string;
}

export interface FormSection {
  id: string;
  title: string;
  /** Optional helper line under the section title. */
  subtitle?: string;
  /**
   * Render as the "primary / start here" card — blue-tinted border +
   * accent dot. Reserved for the section that gates the rest (e.g. the
   * Owner-Op driver block on a Carrier with `type === 'owner-op'`).
   */
  accent?: boolean;
  /** Conditional whole-section visibility. */
  showIf?: ShowIfPredicate;
  fields: FormField[];
}

export interface CreateFormSchema {
  /** Identifier for telemetry / draft entity key. e.g. `'carrier'`. */
  entity: string;
  /** Header breadcrumb trail. Last item is the current page. */
  breadcrumb: string[];
  /** Page H1. */
  title: string;
  /** One-line description under the title. */
  subtitle?: string;
  sections: FormSection[];
  /**
   * Set on long forms to opt into Convex draft persistence. Omitted →
   * the autosave indicator runs its visual cycle but no write happens.
   * Phase 4 wires this up.
   */
  draftKey?: string;
}

/** Per-field error map. `null` clears the error. */
export type FormErrors = Record<string, string | null | undefined>;

/** Save indicator state — driven by `useFormState`. */
export type SavingState = 'saved' | 'saving' | 'error';
