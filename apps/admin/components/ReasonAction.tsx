'use client';

import { FormEvent, ReactNode, useState } from 'react';

/**
 * Inline confirm-with-reason control used by every support action. Expands
 * to a small form; the submit handler runs the mutation and surfaces any
 * ConvexError (including the step-up message) inline instead of crashing
 * to the boundary.
 */
export function ReasonAction({
  label,
  danger,
  requireReason = true,
  confirmText,
  children,
  onSubmit,
}: {
  label: string;
  danger?: boolean;
  requireReason?: boolean;
  /** When set, the user must type this string exactly (e.g. the org name). */
  confirmText?: string;
  /** Extra fields rendered inside the form (selects etc.). */
  children?: ReactNode;
  onSubmit: (reason: string, form: HTMLFormElement) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const reason = String(data.get('reason') ?? '').trim();
    if (requireReason && !reason) {
      setError('A reason is required.');
      return;
    }
    if (confirmText && String(data.get('confirm') ?? '') !== confirmText) {
      setError(`Type "${confirmText}" to confirm.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason, form);
      form.reset();
      setDone(true);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Collapse back to the button after a success, with the confirmation beside
  // it. Several of these actions are legitimately repeatable — recording three
  // payments, issuing more than one credit, adding rate steps — and replacing
  // the control with a permanent "done" chip made the second one impossible
  // without reloading the page. Where an action genuinely shouldn't run twice,
  // the row it belongs to changes state and the control stops rendering on its
  // own, because every list here is a live query.
  if (!open) {
    return (
      <>
        {done ? <span className="chip chip-ok">done</span> : null}
        <button
          className={`button button-sm${danger ? ' button-danger' : ''}`}
          onClick={() => {
            setDone(false);
            setError(null);
            setOpen(true);
          }}
        >
          {label}
        </button>
      </>
    );
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      {children}
      {confirmText ? (
        <input className="input" name="confirm" placeholder={`Type "${confirmText}"`} />
      ) : null}
      {requireReason ? <input className="input" name="reason" placeholder="Reason (audited)" /> : null}
      <button className={`button button-sm${danger ? ' button-danger' : ''}`} disabled={busy} type="submit">
        {busy ? '…' : 'Confirm'}
      </button>
      <button className="button button-sm" type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error ? <div className="danger-text form-error">{error}</div> : null}
    </form>
  );
}
