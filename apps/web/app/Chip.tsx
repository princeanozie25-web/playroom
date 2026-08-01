'use client';

import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { pr, type HookName } from './hooks';

// THE CHIP — the kicker-led row that Task, Interrupt, Order, Handoff and Summon each hand-rolled
// (SHELL-A1). It owns the ONE structure they share: a flex row opened by an uppercase "kicker" label
// and wired to a stable `data-pr` hook. It owns nothing else — and deliberately not their LOOK.
//
// `.task-chip` and `.order-chip` differ ON PURPOSE (font size, baseline vs centre alignment): an order
// reads a step stronger than a task-state chip. So `variant` selects the existing class pair rather
// than merging them, and the DOM this emits is byte-for-byte what each caller emitted before.
// `modifier` layers a caller's own decoration class (`interrupt-chip`, `handoff-row`, `summon-row`)
// on top, exactly as the hand-rolled markup did.
//
// MOTION (SHELL-B3): `layout` only. A chip changes SIZE in place when an event commits — a handoff
// adds the mandate span, a pause adds its reason, a downgrade removes the button — and easing that
// reflow is the one job CSS cannot do (auto-size has no transition). Entering the transcript is the
// CSS rise-in's job (SHELL-B2); a chip never exits (the log is append-only), so there is no exit.
// The animatable surface is POSITION AND SIZE ONLY — never opacity on state, never a colour — so a
// chip mid-ease is the same truthful chip, already committed, merely finding its place. Reduced
// motion renders the plain element: no layout animation at all, per design.md "kills all of it".
//
// NOT this family, established in SHELL-A Phase 0 and left alone: PromotionRow is a system-line block
// with no kicker, and MemberChip is a pill.

type ChipVariant = 'task' | 'order';

const CONTAINER: Record<ChipVariant, string> = { task: 'task-chip', order: 'order-chip' };
const KICKER: Record<ChipVariant, string> = { task: 'task-kicker', order: 'order-kicker' };

/* design.md "Tokens": 150–200ms ease-out. The same 180ms/quint as the CSS --motion/--ease-out —
   framer cannot read a custom property, so the values are restated here and motion.test.ts pins
   the CSS side while framer-scope.test.ts pins this one. */
const LAYOUT_TRANSITION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

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
  const reduce = useReducedMotion();
  const className = modifier ? `${CONTAINER[variant]} ${modifier}` : CONTAINER[variant];
  return (
    <motion.div
      className={className}
      {...(reduce ? {} : { layout: true, transition: { layout: LAYOUT_TRANSITION } })}
      {...pr(hook)}
      {...data}
    >
      <span className={KICKER[variant]}>{kicker}</span>
      {children}
    </motion.div>
  );
}
