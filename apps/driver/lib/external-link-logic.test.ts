/**
 * Tests for the external-link opener (apps/driver/lib/external-link-logic.ts).
 *
 * The incident behind this module: the sign-in screen's Privacy link called
 * `Linking.openURL` without handling the rejection, so on a device that would
 * not open the URL every tap became a fatal unhandled rejection. The two cases
 * that matter most here are therefore the ones that were broken in production
 * — a route that rejects must fall through rather than throw, and repeated
 * taps must not each start their own open.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createExternalLinkOpener,
  type ExternalLinkAttempt,
} from './external-link-logic';

const URL = 'https://otoqa.com/privacy';

const ok = (via: ExternalLinkAttempt['via']): ExternalLinkAttempt => ({
  via,
  open: vi.fn(async () => undefined),
});

const rejects = (via: ExternalLinkAttempt['via']): ExternalLinkAttempt => ({
  via,
  // The exact shape of the production failure: "Unable to open URL: ...".
  open: vi.fn(async () => {
    throw new Error(`Unable to open URL: ${URL}`);
  }),
});

describe('createExternalLinkOpener', () => {
  it('uses the first route that accepts the URL', async () => {
    const first = ok('in-app-browser');
    const second = ok('system');
    const open = createExternalLinkOpener([first, second]);

    await expect(open(URL)).resolves.toEqual({ kind: 'opened', via: 'in-app-browser' });
    expect(first.open).toHaveBeenCalledWith(URL);
    expect(second.open).not.toHaveBeenCalled();
  });

  it('falls through to the next route when one rejects', async () => {
    const first = rejects('in-app-browser');
    const second = ok('system');
    const open = createExternalLinkOpener([first, second]);

    await expect(open(URL)).resolves.toEqual({ kind: 'opened', via: 'system' });
    expect(second.open).toHaveBeenCalledWith(URL);
  });

  it('reports unavailable instead of rejecting when every route fails', async () => {
    const open = createExternalLinkOpener([rejects('in-app-browser'), rejects('system')]);

    // The production bug in one assertion: this must resolve, not reject.
    await expect(open(URL)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('ignores a second tap while an open is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt: ExternalLinkAttempt = {
      via: 'in-app-browser',
      open: vi.fn(() => gate),
    };
    const open = createExternalLinkOpener([attempt]);

    const first = open(URL);
    await expect(open(URL)).resolves.toEqual({ kind: 'busy' });
    expect(attempt.open).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toEqual({ kind: 'opened', via: 'in-app-browser' });
  });

  it('accepts a new open once the previous one settles', async () => {
    const attempt = rejects('system');
    const open = createExternalLinkOpener([attempt]);

    await open(URL);
    // The guard must not latch: a failed open still frees the next tap.
    await expect(open(URL)).resolves.toEqual({ kind: 'unavailable' });
    expect(attempt.open).toHaveBeenCalledTimes(2);
  });
});
