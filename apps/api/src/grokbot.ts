import { createHash } from 'node:crypto';
import type { XMention, XReadCursor, XReadSource, XThread } from '@playroom/x-read';
import {
  screen as classifyText,
  neutralize,
  summarize,
  type ScreeningSummary,
  type ScreenResult,
} from '@playroom/screen';
import {
  scan as scanEgress,
  summarize as summarizeEgress,
  type EgressSummary,
} from '@playroom/egress';

// ═══ THE GOVERNED GROKBOT CYCLE (ADR-015) ═══════════════════════════════════════════════════════════
//
// Grokbot's loop is: read the mentions, read the thread, answer. This is that loop with the fabric in
// the middle — provider-neutral on BOTH ends. The read end is @playroom/x-read (the sole credential
// holder; swap the backend and nothing here changes). The answer end is a GOVERNED action: the drafted
// reply is proposed through the decision constructor and reaches a verdict + receipt, and it is NEVER
// auto-posted. A reply to `@playroom_ai` under a mandate that protects `x.reply` reads CO_SIGN — a human
// signs the exact draft before anything is sent — which is precisely the part grokbot does not have.
//
// This orchestrator is PURE of I/O beyond its injected seams: it reads through `source`, drafts through
// `draftReply` (a model adapter or a canned draft — it never calls a model itself), and proposes through
// `propose` (the /rooms/:id/actions door, or requestActionCommand directly). Keeping those three as
// dependencies is what lets the whole cycle be tested against a mock source, a scripted draft, and the
// real fabric, and what keeps the "never posts" property structural: there is simply no write seam here.

/** The action type a proposed reply is evaluated as. Abstract (not a host op): a mandate grants it through
 *  `scope`, and protecting it in `protected_actions` is what makes every proposed reply pause for a human. */
export const GROKBOT_REPLY_ACTION = 'x.reply';

/** The fabric's answer to a proposed reply — a verdict, never a post. */
export interface GrokbotVerdict {
  decision: string;
  reasonCode: string;
  /** Present for a CO_SIGN/BLOCK (a decision was recorded, and can be polled); null for an ALLOW. */
  decisionId: string | null;
}

/** One reply, drafted and put to the fabric. `posted` is a literal `false`: a reply is PROPOSED and
 *  receipted, never sent — the read seam has no write and the fabric executes nothing (RT-005). */
export interface ProposedReply {
  mention: XMention;
  /** Root + replies, so a reader sees how much context the draft answered. */
  threadSize: number;
  /** What the agent WOULD post — the exact text the co-signature is over. */
  draft: string;
  /** The governed resource: the target post, plus a commitment to THIS draft (see replyResource). */
  resource: string;
  /** What inbound screening (ADR-017) saw across the mention AND every post in its thread — the aggregate
   *  risk and the distinct steer shapes. It rode INTO the draft as inert data and is surfaced here so a
   *  co-signer sees what the input tried to do. It gated nothing; the decision below is the guard. */
  screening: ScreeningSummary;
  /** What egress DLP (ADR-018) saw in the OUTBOUND draft — the reply text about to be put up for signature.
   *  The other half of the exfiltration story: inbound screening flags the manipulation attempt, this
   *  catches a secret that made it into the output. Carries no secret bytes. Informs the co-signer; the
   *  reply is never posted anyway (RT-005). */
  egress: EgressSummary;
  decision: string;
  reasonCode: string;
  decisionId: string | null;
  posted: false;
}

export interface GrokbotCycleDeps {
  /** The credential holder. Read-only: mentions (the trigger) and threads (the context). */
  source: XReadSource;
  /** The `@handle` grokbot watches, without the leading `@`. */
  watchedHandle: string;
  /** The agent drafts a reply from the SCREENED mention and its thread. Injected so a real model adapter
   *  and a canned draft both plug in; the orchestrator never reaches a model directly. */
  draftReply: (input: {
    mention: XMention;
    thread: XThread;
    screenedText: string;
  }) => Promise<string>;
  /** Submit the drafted reply as a GOVERNED action and return the fabric's verdict. This is the only path
   *  a reply takes toward being posted, and it does not post — it reaches a decision + receipt. */
  propose: (input: {
    clientMsgId: string;
    action: string;
    resource: string;
  }) => Promise<GrokbotVerdict>;
  /** Screen untrusted external text before a model sees it. Defaults to {@link screenExternalText}. */
  screen?: (text: string) => string;
  /** Canary tokens (ADR-018): exact strings that must never appear in an outbound draft. A hit is a critical
   *  egress signal a co-signer should never approve. Optional; a room seeds these from its own honeytokens. */
  canaries?: readonly string[];
}

/**
 * Neutralise untrusted external post text before a model sees it — the original grokbot screen, now a thin
 * alias over the shared inbound-screening seam (`@playroom/screen`, ADR-017). Kept under its first name so
 * existing callers do not move. Prefer `neutralize` / `screen` from '@playroom/screen' in new code: the
 * former is this exact function, the latter also returns the classified findings this cycle now records.
 */
export function screenExternalText(text: string, maxLen = 600): string {
  return neutralize(text, maxLen);
}

/**
 * The governed resource for a proposed reply: the target post's URL plus a short commitment to the exact
 * draft. Binding the draft into the resource means the receipt records WHICH text was put up for signature
 * — a co-signature is over this reply, and a later swap for different content is detectable in the log.
 */
export function replyResource(mention: XMention, draft: string): string {
  const commitment = createHash('sha256').update(draft).digest('hex').slice(0, 16);
  return `${mention.url}#reply-${commitment}`;
}

export interface GrokbotCycleResult {
  proposed: ProposedReply[];
  seen: Set<string>;
  /** Mentions whose handling threw (a read, draft, or propose failure). They are NOT marked seen, so a
   *  later run retries them — the failure is surfaced here rather than swallowed or crashing the cycle. */
  errors: { mentionId: string; error: unknown }[];
}

/**
 * Run one grokbot cycle: drain the mentions of the watched handle, and for each one not already seen, read
 * its thread, draft a reply from the SCREENED mention and thread, and PROPOSE that reply to the fabric.
 * Returns the proposed replies with their verdicts, the updated `seen` set, and any per-mention errors —
 * nothing is posted.
 *
 * `seen` is the idempotency boundary: a mention is marked seen only AFTER it is fully proposed, so a mention
 * wakes the cycle at most once across runs and a retry (a poll loop, a transient failure) never re-proposes
 * a reply already put to the fabric. A mention whose handling throws is left unseen and collected in
 * `errors`, so a later run retries just that one; a single bad mention never blocks the rest of the batch.
 * The caller persists `seen` between runs.
 *
 * EVERY external `.text` the draft step sees is screened — the mention AND every post in its thread — so an
 * instruction smuggled into a thread reply is as inert as one in the mention itself. The raw mention is kept
 * for the receipt and the resource (audit fidelity); only the copy handed to the model is neutralised.
 */
export async function runGrokbotCycle(
  deps: GrokbotCycleDeps,
  opts: { seen?: Iterable<string>; maxResults?: number } = {},
): Promise<GrokbotCycleResult> {
  const seen = new Set(opts.seen ?? []);
  // Screen each external text ONCE: the same pass yields the neutralised copy (`.safe`) shown to the model AND
  // the findings rolled into the summary, so the two can never disagree about the text. `deps.screen`, if a
  // caller injects it, overrides only the model-facing neutralisation (a legacy seam); classification is
  // always the shared package, since a finding is a property of the RAW text.
  const neutralizeOverride = deps.screen;
  const modelText = (raw: string, screened: ScreenResult): string =>
    neutralizeOverride ? neutralizeOverride(raw) : screened.safe;
  const cursor: XReadCursor | undefined =
    opts.maxResults !== undefined ? { maxResults: opts.maxResults } : undefined;

  const mentions = await deps.source.getMentions(deps.watchedHandle, cursor);
  const proposed: ProposedReply[] = [];
  const errors: { mentionId: string; error: unknown }[] = [];

  for (const mention of mentions) {
    if (seen.has(mention.id)) continue;

    try {
      const thread = await deps.source.getThread(mention.id);
      // One screen pass per external text — the mention AND every post in its thread.
      const mentionScreen = classifyText(mention.text);
      const rootScreen = classifyText(thread.root.text);
      const replyScreens = thread.replies.map((r) => classifyText(r.text));
      // The audit half: what the raw text TRIED to do, rolled to one summary that rides to the co-signer. It
      // gates nothing; the decision is still the guard.
      const screening = summarize([mentionScreen, rootScreen, ...replyScreens]);
      const screenedText = modelText(mention.text, mentionScreen);
      const draft = await deps.draftReply({
        // A screened COPY reaches the model — the mention and every thread post neutralised.
        mention: { ...mention, text: screenedText },
        thread: {
          root: { ...thread.root, text: modelText(thread.root.text, rootScreen) },
          replies: thread.replies.map((r, i) => ({
            ...r,
            text: modelText(r.text, replyScreens[i]),
          })),
        },
        screenedText,
      });
      // EGRESS DLP (ADR-018): scan the OUTBOUND draft for a secret before it is put up for signature. If the
      // model was steered into echoing a credential, this is where it is caught — and the summary rides to the
      // co-signer. It gates nothing here (the reply is co-signed and never auto-posted anyway).
      const egress = summarizeEgress([scanEgress(draft, { canaries: deps.canaries })]);
      const resource = replyResource(mention, draft);
      const verdict = await deps.propose({
        clientMsgId: `grok-${mention.id}`,
        action: GROKBOT_REPLY_ACTION,
        resource,
      });

      proposed.push({
        mention,
        threadSize: thread.replies.length + 1,
        draft,
        resource,
        screening,
        egress,
        decision: verdict.decision,
        reasonCode: verdict.reasonCode,
        decisionId: verdict.decisionId,
        posted: false,
      });
      // ONLY here, after a full, successful propose: an unhandled mention stays retryable.
      seen.add(mention.id);
    } catch (error) {
      errors.push({ mentionId: mention.id, error });
    }
  }

  return { proposed, seen, errors };
}
