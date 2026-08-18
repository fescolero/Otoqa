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
import { ConvexError, v } from 'convex/values';
import { action, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { resolveOrgForRead, orgDrivers } from './dispatchMobile';
import type { ActionCtx } from './_generated/server';
import { trackedFetch } from './lib/externalHealth';
import {
  buildDeepgramUrl,
  buildNluInput,
  coerceIntent,
  coerceLoadDraft,
  haikuCommandSystem,
  haikuLoadSystem,
  INTENT_TOOL,
  LOAD_DRAFT_TOOL,
  type CoercedIntent,
  type LoadDraft,
} from './lib/voiceStt';

/**
 * Keyterm source: org fleet + customers + HCR facet values. Auth rides
 * along from the calling action (canViewOperations — same bar as the
 * reads the voice screen already subscribes to). The SAME set goes with
 * every request (org vocabulary, not per-utterance) — buildDeepgramUrl
 * caps at Nova-3's 100-term limit, so order = priority: drivers first,
 * then HCRs (small set, alphanumerics recognize worst), then customers.
 */
export const voiceContext = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ keyterms: string[] }> => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const drivers = await orgDrivers(ctx, resolved);
    const keyterms = drivers.map((d) => `${d.firstName} ${d.lastName}`);
    if (resolved.org.workosOrgId) {
      const hcrs = await ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) =>
          q.eq('workosOrgId', resolved.org.workosOrgId!).eq('facetKey', 'HCR'),
        )
        .collect();
      for (const h of hcrs) keyterms.push(h.value);
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

/** Tool-forced Haiku call returning the raw tool input; null on any failure. */
async function haikuToolCall(
  ctx: Pick<ActionCtx, 'runMutation'>,
  system: string,
  tool: typeof INTENT_TOOL | typeof LOAD_DRAFT_TOOL,
  transcript: string,
): Promise<unknown | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.warn('[voice] ANTHROPIC_API_KEY not set — falling back to the on-device grammar');
    return null;
  }
  try {
    const res = await trackedFetch(ctx, 'llm', 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: transcript }],
      }),
    });
    if (!res.ok) {
      console.error(`[voice] Anthropic API error ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as {
      content?: { type: string; input?: unknown }[];
    };
    const input = data.content?.find((b) => b.type === 'tool_use')?.input ?? null;
    console.log(`[voice] Haiku (${tool.name}) parsed:`, JSON.stringify(input));
    return input;
  } catch (e) {
    // NLU is best-effort — callers fall back to deterministic parsing.
    console.error('[voice] Anthropic call failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** Shared STT leg: keyterm-seeded Nova-3 over the uploaded clip. */
async function deepgramTranscribe(
  ctx: Pick<ActionCtx, 'runMutation'>,
  keyterms: string[],
  audioBase64: string,
  mimeType: string,
): Promise<string> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    console.error('[voice] DEEPGRAM_API_KEY not set on the deployment');
    throw new ConvexError('Voice transcription is not configured (DEEPGRAM_API_KEY missing).');
  }

  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  console.log(
    `[voice] Deepgram request: ${bytes.length} bytes ${mimeType}, ${Math.min(keyterms.length, 100)} keyterms`,
  );

  const res = await trackedFetch(ctx, 'deepgram', buildDeepgramUrl(keyterms), {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': mimeType },
    body: bytes,
  });
  if (!res.ok) {
    console.error(`[voice] Deepgram error ${res.status}: ${await res.text()}`);
    throw new ConvexError(`Transcription failed (${res.status})`);
  }
  const data = (await res.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
  console.log(`[voice] Deepgram transcript: "${transcript}"`);
  return transcript;
}

export const transcribeAndParse = action({
  args: {
    audioBase64: v.string(),
    mimeType: v.string(),
    /**
     * Clarification continuation: the original command whose clarify
     * question this utterance answers. Included in the NLU input so
     * "3 pm" after "What time should load 1001 move to?" completes the
     * original move command. Transcription itself is unaffected.
     */
    contextText: v.optional(v.string()),
    /**
     * Conversational context (NLU v4): the last few on-screen turns.
     * Used ONLY for reference resolution ("what about Sam", "assign it
     * to Marcus") — the prompt forbids re-executing past actions, and
     * the server caps/truncates regardless of what the client sends.
     */
    history: v.optional(
      v.array(
        v.object({
          role: v.union(v.literal('you'), v.literal('agent')),
          text: v.string(),
        }),
      ),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ transcript: string; intent: CoercedIntent | null }> => {
    // Resolves org + keyterms AND enforces auth before any vendor call.
    const { keyterms } = await ctx.runQuery(internal.voice.voiceContext, {});
    const transcript = await deepgramTranscribe(ctx, keyterms, args.audioBase64, args.mimeType);
    if (!transcript) return { transcript: '', intent: null };
    const todayISO = new Date().toISOString().slice(0, 10);
    const nluInput = buildNluInput(transcript, args.history, args.contextText);
    if (nluInput !== transcript) {
      console.log(`[voice] NLU context: ${args.history?.length ?? 0} turns${args.contextText ? ' + clarify bridge' : ''}`);
    }
    const raw = await haikuToolCall(ctx, haikuCommandSystem(todayISO), INTENT_TOOL, nluInput);
    return { transcript, intent: coerceIntent(raw) };
  },
});

/**
 * Load dictation (§5.6 Phase 3): "Acme load, pickup in Fresno tomorrow
 * at 8, deliver Reno at 4, produce" → structured draft for the create
 * form. PRE-FILL ONLY — the dispatcher reviews/edits and submits
 * through the existing createLoad mutation; nothing commits from
 * speech. Same STT leg (keyterms carry customer names), Haiku with the
 * load-draft tool; draft null when extraction fails (client shows the
 * transcript and leaves the form untouched).
 */
export const transcribeLoadDraft = action({
  args: {
    audioBase64: v.string(),
    mimeType: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ transcript: string; draft: LoadDraft | null }> => {
    const { keyterms } = await ctx.runQuery(internal.voice.voiceContext, {});
    const transcript = await deepgramTranscribe(ctx, keyterms, args.audioBase64, args.mimeType);
    if (!transcript) return { transcript: '', draft: null };
    const todayISO = new Date().toISOString().slice(0, 10);
    const raw = await haikuToolCall(ctx, haikuLoadSystem(todayISO), LOAD_DRAFT_TOOL, transcript);
    return { transcript, draft: coerceLoadDraft(raw) };
  },
});
