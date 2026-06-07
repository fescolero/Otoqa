/**
 * Public surface for the create-form shell. Page wrappers should
 * import only from this barrel — never reach into individual
 * controls.
 */

export { CreateForm } from './create-form';
export type { CreateFormDraft } from './create-form';
export { useFormState } from './use-form-state';
export { bindUploaders } from './bind-uploaders';
export type {
  CreateFormSchema,
  FormSection,
  FormField,
  FieldKind,
  RequiredTier,
  FieldOption,
  ShowIfPredicate,
  FileUploader,
  FormValues,
  FormErrors,
  SavingState,
  DupCheckHit,
} from './schema-types';
