/**
 * Voice pipeline (Phase 3 voice agent, server upgrade) — Deepgram Nova-3
 * STT + Claude Haiku intent parsing.
 *
 * Flow: the Dispatch app records the mic session it already runs for
 * on-device recognition (recordingOptions.persist), uploads the clip
 * here, and gets back { transcript, intent }.
 *   - STT: Nova-3 with numerals=true and Keyterm Prompting seeded with
 *     the org's driver + customer names (voiceContext below).
 *   - NLU: Haiku, tool-forced into the same intent shape as the
 *     on-device parser; null on any failure so the client falls back
 *     to its deterministic grammar. The confirm-card flow is unchanged
 *     — the server proposes, the dispatcher approves, the existing
 *     capability-guarded mutations execute.
 *
 * Deployment env vars: DEEPGRAM_API_KEY (required for this action),
 * ANTHROPIC_API_KEY (optional — without it, intent is always null).
 */
import { v } from 'convex/values';
import { action, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { resolveOrgForRead, orgDrivers } from './dispatchMobile';
import {
  buildDeepgramUrl,
  coerceIntent,
  HAIKU_SYSTEM,
  INTENT_TOOL,
  type CoercedIntent,
} from './lib/voiceStt';

/**
 * Keyterm source: org fleet + customers. Auth rides along from the
 * calling action (canViewOperations — same bar as the reads the voice
 * screen already subscribes to).
 */
export const voiceContext = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ keyterms: string[] }> => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const drivers = await orgDrivers(ctx, resolved);
    const keyterms = drivers.map((d) => `${d.firstName} ${d.lastName}`);
    if (resolved.org.workosOrgId) {
      const customers = await ctx.db
        .query('customers')
        .withIndex('by_organization', (q) => q.eq('workosOrgId', resolved.org.workosOrgId!))
        .collect();
      for (const c of customers) {
        if (c.status === 'Active' && !c.isDeleted) keyterms.push(c.name);
      }
    }
    return { keyterms };
  },
});

async function parseWithHaiku(transcript: string): Promise<CoercedIntent | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: HAIKU_SYSTEM,
        tools: [INTENT_TOOL],
        tool_choice: { type: 'tool', name: INTENT_TOOL.name },
        messages: [{ role: 'user', content: transcript }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: { type: string; input?: unknown }[];
    };
    const block = data.content?.find((b) => b.type === 'tool_use');
    return coerceIntent(block?.input);
  } catch {
    // NLU is best-effort — the client's deterministic parser covers this.
    return null;
  }
}

export const transcribeAndParse = action({
  args: {
    audioBase64: v.string(),
    mimeType: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ transcript: string; intent: CoercedIntent | null }> => {
    // Resolves org + keyterms AND enforces auth before any vendor call.
    const { keyterms } = await ctx.runQuery(internal.voice.voiceContext, {});

    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error('Voice transcription is not configured (DEEPGRAM_API_KEY missing).');

    const binary = atob(args.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const res = await fetch(buildDeepgramUrl(keyterms), {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': args.mimeType },
      body: bytes,
    });
    if (!res.ok) {
      throw new Error(`Transcription failed (${res.status})`);
    }
    const data = (await res.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
    };
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
    if (!transcript) return { transcript: '', intent: null };

    return { transcript, intent: await parseWithHaiku(transcript) };
  },
});
