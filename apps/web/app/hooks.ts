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
} as const;

export type HookName = (typeof HOOK)[keyof typeof HOOK];

/** Spread onto an element: `<ul {...pr(HOOK.transcript)}>`. */
export function pr(name: HookName): { 'data-pr': HookName } {
  return { 'data-pr': name };
}
