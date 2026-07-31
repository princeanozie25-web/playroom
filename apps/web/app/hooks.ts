/**
 * STABLE SELECTOR HOOKS — a contract the app owns, not test ids bolted on.
 *
 * S06-N1: the capture harness selected on structural CSS classes, and when S-UI rewrote
 * the room those selectors matched NOTHING rather than failing. `ul.messages` became
 * `ul.transcript`, the streaming caret changed glyph, the status dot lost its `title` —
 * three silent zero-matches, in a harness that lives outside the repo and outside CI, so
 * nothing could notice. That is RT-001's shape in an instrument: the silent path looked
 * identical to the passing one.
 *
 * These names are therefore part of the app's surface. `data-pr` marks them as such —
 * they are read by the film harness and by the hook test below, and renaming one is a
 * change to a contract, not a refactor. A class name is free to change; a hook is not.
 *
 * THE GUARANTEE LIVES IN TWO PLACES, because neither is sufficient alone:
 *   1. `hooks.test.ts` in this repo asserts every hook is still referenced by a
 *      component. That catches deletion and rename in CI, where the harness cannot run.
 *   2. The harness itself fails a take on a zero-match selector. That catches a hook
 *      that is still in the source but no longer reaches the DOM — a condition no
 *      source-level check can see.
 */
export const HOOK = {
  /** The room shell. */
  room: 'room',
  /** The connection state badge. Its `data-pr-state` carries connected|reconnecting|refused. */
  conn: 'conn',
  /** The roster strip at the top of the room. */
  roster: 'roster',
  /** One roster entry. Carries `data-pr-member`. */
  rosterMember: 'roster-member',
  /** The compact mandate summary inside a roster entry. Also the disclosure trigger. */
  mandateSummary: 'mandate-summary',
  /** The full mandate detail, revealed on demand from a roster entry. */
  mandateDetail: 'mandate-detail',
  /** The transcript list. */
  transcript: 'transcript',
  /** The "load earlier messages" control at the top of a windowed transcript (S16b). */
  loadOlder: 'load-older',
  /** A human message row. */
  message: 'message',
  /** An agent turn row. Carries `data-pr-member`. */
  turn: 'turn',
  /** The author/member name on a row. */
  author: 'author',
  /** The body text of a message or turn. */
  body: 'body',
  /** The streaming caret. Present only while a turn is streaming. */
  caret: 'caret',
  /** The quiet spend + token line on a completed turn. */
  spend: 'spend',
  /** The ambient per-room spend meter in the header (§18, S1.6). Distinct from the daily ceiling. */
  roomSpend: 'room-spend',
  /** The DECISION card. */
  decision: 'decision',
  /** The decision verdict (ALLOW | CO_SIGN | BLOCK). */
  decisionVerdict: 'decision-verdict',
  /** The action the decision is about. */
  decisionAction: 'decision-action',
  /** The human sentence explaining the refusal. */
  decisionReason: 'decision-reason',
  /** The reason code, as a small tag. */
  decisionCode: 'decision-code',
  /** Who must co-sign. */
  decisionSigner: 'decision-signer',
  /** The effective mandate hash. */
  decisionHash: 'decision-hash',
  /** The (disabled) co-sign controls. */
  decisionActions: 'decision-actions',
  /** A task chip. Carries `data-pr-state` — working | input-required | held | done. */
  task: 'task',
  /** The task's state, in words. */
  taskState: 'task-state',
  /** The action a task names, once a handoff has said what the work is. */
  taskAction: 'task-action',
  /** The mandate the current assignee acts under, after a handoff. */
  taskMandate: 'task-mandate',
  /** A handoff row — the act of moving a task. Carries `data-pr-to`. */
  handoff: 'handoff',
  /** A summon row — one agent summoned another through the channel (S1.8). Carries `data-pr-to`. */
  summon: 'summon',
  /** A standing-order chip — recurring work a human authorised (S-LOOP). Carries `data-pr-status`. */
  order: 'order',
  /** An interrupt chip. Carries `data-pr-urgency` — BLOCKER | DECISION | FYI. */
  interrupt: 'interrupt',
  /** The urgency, in words. */
  interruptUrgency: 'interrupt-urgency',
  /** The raiser's remaining interrupt budget, ambient (§18). */
  interruptBudget: 'interrupt-budget',
  /** The one-tap downgrade control, shown only to the member the interrupt addresses. */
  interruptDowngrade: 'interrupt-downgrade',
  /** The kind glyph inside a member's marker. Carries `data-pr-kind` — human | agent. */
  memberGlyph: 'member-glyph',
  /** The one-screen welcome panel, shown once after redeeming a code. */
  welcome: 'welcome',
  /** Its single dismiss control. */
  welcomeDismiss: 'welcome-dismiss',
  /** The join form — a room code and a first name, the only screen before the room. */
  join: 'join',
  /** The room-code field. */
  joinCode: 'join-code',
  /** The first-name field. */
  joinName: 'join-name',
  /** The submit control. */
  joinSubmit: 'join-submit',
  /** The refusal, when a code does not work. */
  joinError: 'join-error',
  /** A promotion row — somebody moved a private note into the room. Carries `data-pr-representation`. */
  promotion: 'promotion',
  /** The quiet sentence: who shared, and how much. */
  promotionHead: 'promotion-head',
  /** WHY it was shared, in the promoter's words. */
  promotionPurpose: 'promotion-purpose',
  /** The disclosed text itself, quoted and inset. */
  promotionBody: 'promotion-body',
  /** The composer form. */
  composer: 'composer',
  /** The room refusal banner (RT-001). */
  refusal: 'refusal',
  // ── THE LOOPS SCREEN (S-UI3) — orders as a form, not a bash script ─────────────────
  /** The link FROM the room TO the loops screen. */
  loopsLink: 'loops-link',
  /** The loops screen shell. */
  loops: 'loops',
  /** The link back to the room. */
  loopsBack: 'loops-back',
  /** The honest empty state, shown when a room has no standing orders. */
  loopsEmpty: 'loops-empty',
  /** One order row in the list. Carries `data-pr-status`. */
  loopRow: 'loop-row',
  /** An order row's status word. */
  loopStatus: 'loop-status',
  /** An order row's cycle count. */
  loopCycles: 'loop-cycles',
  /** When an order last fired, or "never". */
  loopFired: 'loop-fired',
  /** Why an order is paused/terminal, when it is. */
  loopReason: 'loop-reason',
  /** Pause — any human. */
  loopPause: 'loop-pause',
  /** Resume — the creator only; rendered disabled-with-reason for a non-creator. */
  loopResume: 'loop-resume',
  /** Revoke — the creator only. */
  loopRevoke: 'loop-revoke',
  /** The edit toggle — the creator only; reveals the edit form. */
  loopEdit: 'loop-edit',
  /** The per-row edit form: dial, cap, expiry, save. */
  loopEditForm: 'loop-edit-form',
  /** Save an edit. */
  loopEditSave: 'loop-edit-save',
  /** The create form. */
  loopCreate: 'loop-create',
  /** The trigger-member picker. */
  loopTriggerMember: 'loop-trigger-member',
  /** The action-member picker. */
  loopActionMember: 'loop-action-member',
  /** The attendance-dial field (default 3). */
  loopDial: 'loop-dial',
  /** The cycle-cap field (optional). */
  loopCap: 'loop-cap',
  /** The expiry field (optional). */
  loopExpiry: 'loop-expiry',
  /** Submit the create form. */
  loopSubmit: 'loop-submit',
  /** A refusal or error, shown in place — never a silent failure. */
  loopError: 'loop-error',
  // ── THE MANDATE SURFACE (UI3-3) — read-only, every control disabled in its true position ──
  /** The mandate surface container, revealed inside a roster entry's detail. */
  mandateSurface: 'mandate-surface',
  /** Expiry as a STATE. Carries `data-pr-state` — live | expired | undisclosed. */
  mandateStatus: 'mandate-status',
  /** The co-signature requirement: disabled checkboxes in their true (checked) position, or none/undisclosed. */
  mandateCoSign: 'mandate-cosign',
  /** The declared (not-enforced) limits, or none/undisclosed. */
  mandateLimits: 'mandate-limits',
  /** The policy version the mandate was written against. */
  mandatePolicy: 'mandate-policy',
  /** The document hash — truncated for the screen, the full value copyable. */
  mandateHash: 'mandate-hash',
} as const;

export type HookName = (typeof HOOK)[keyof typeof HOOK];

/** Spread onto an element: `<ul {...pr(HOOK.transcript)}>`. */
export function pr(name: HookName): { 'data-pr': HookName } {
  return { 'data-pr': name };
}
