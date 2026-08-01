import type { ReactNode } from 'react';
import { pr, type HookName } from './hooks';

// THE CHIP — the kicker-led row that Task, Interrupt, Order, Handoff and Summon each hand-rolled
// (SHELL-A1). It owns the ONE structure they share: a flex row opened by an uppercase "kicker" label
// and wired to a stable `data-pr` hook. It owns nothing else — and deliberately not their LOOK.
//
// `.task-chip` and `.order-chip` differ ON PURPOSE (font size, baseline vs centre alignment): an order
// reads a step stronger than a task-state chip. So `variant` selects the existing class pair rather
// than merging them, and the DOM this emits is byte-for-byte what each caller emitted before. This is
// extraction, not a restyle — a before/after screenshot is identical, which is the whole point of the
// slice. `modifier` layers a caller's own decoration class (`interrupt-chip`, `handoff-row`,
// `summon-row`) on top, exactly as the hand-rolled markup did.
//
// NOT this family, established in SHELL-A Phase 0 and left alone: PromotionRow is a system-line block
// with no kicker, and MemberChip is a pill. Neither is a kicker-row, so neither is migrated here — a
// primitive is the structure that actually repeats, not every element that happens to be small.

type ChipVariant = 'task' | 'order';

const CONTAINER: Record<ChipVariant, string> = { task: 'task-chip', order: 'order-chip' };
const KICKER: Record<ChipVariant, string> = { task: 'task-kicker', order: 'order-kicker' };

export function Chip({
  variant = 'task',
  modifier,
  hook,
  kicker,
  children,
  ...data
}: {
  /** Which class pair to wear. `task` (the default) serves four callers; `order` serves OrderChip. */
  variant?: ChipVariant;
  /** A caller's own decoration class layered onto the container: `interrupt-chip` / `handoff-row` / … */
  modifier?: string;
  /** The stable selector hook this row answers to — passed as `HOOK.x`, so the contract test still sees it. */
  hook: HookName;
  /** The uppercase label that opens the row. */
  kicker: ReactNode;
  children: ReactNode;
  // The state DATA a caller carries on the row. Explicit rather than an open spread, so the row can
  // only carry the attributes the design actually uses — each is passed through to the container.
  'data-pr-state'?: string;
  'data-pr-status'?: string;
  'data-pr-urgency'?: string;
  'data-pr-to'?: string;
  'data-pr-kind'?: string;
}) {
  const className = modifier ? `${CONTAINER[variant]} ${modifier}` : CONTAINER[variant];
  return (
    <div className={className} {...pr(hook)} {...data}>
      <span className={KICKER[variant]}>{kicker}</span>
      {children}
    </div>
  );
}
