/**
 * bindUploaders — page-wrapper helper that attaches Convex
 * `generateUploadUrl` mutations to the schema's `file` fields by id.
 *
 * Usage:
 *
 *   const generateUploadUrl = useMutation(api.fuelEntries.generateUploadUrl);
 *   const schema = React.useMemo(
 *     () => bindUploaders(DIESEL_SCHEMA, { attachment: generateUploadUrl }),
 *     [generateUploadUrl],
 *   );
 *   <CreateForm schema={schema} onSaved={…} />
 *
 * The map keys are field ids; values are anything callable that returns
 * a Promise<string> (the upload URL) — `useMutation()`'s return
 * satisfies that natively.
 *
 * Returns a NEW schema object so React's referential equality stays
 * meaningful for `React.useMemo` deps in the page wrapper. Schemas are
 * shallow data; we shallow-copy sections and fields where needed.
 */

import type { CreateFormSchema, FileUploader } from './schema-types';

export function bindUploaders(
  schema: CreateFormSchema,
  uploaders: Record<string, FileUploader>,
): CreateFormSchema {
  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: (section.fields ?? []).map((field) =>
        field.kind === 'file' && uploaders[field.id]
          ? { ...field, uploader: uploaders[field.id] }
          : field,
      ),
    })),
  };
}
