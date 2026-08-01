'use client';

import type { ComponentType, FormEventHandler, ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { pr, type HookName } from './hooks';

// THE PANEL — the bordered container the decision card, the welcome strip, the mandate-detail
// popover and the loops screen's row and its two forms each opened by hand (SHELL-A2). It owns the
// wrapper element and the stable `data-pr` wiring; it deliberately does NOT own the LOOK. Every
// panel keeps its own class — `.decision`'s left-accent rule, `.welcome`'s fill, `.loop-row`'s
// bordered card and `.mandate-detail`'s positioned shadow genuinely differ.
//
// MOTION (SHELL-B3): `layout` only, here — a panel whose content grows (a loop row unfolding its
// edit form, a card swapping buttons for its outcome) eases the reflow CSS cannot. Enter/exit across
// unmount lives in <PanelPresence> below, at the SITE of the conditional, because that is the only
// place the library guarantees an exit: AnimatePresence detects removal on its DIRECT children, and
// a wrapper component between them silently downgrades the exit to a stuck, invisible node — found
// live in SHELL-B3 (opacity 0, never removed, still in the a11y tree) and why this split exists.
//
// ── THE TRUTHFULNESS CONSTRAINT, load-bearing ──
// The animatable surface is OPACITY AND POSITION ONLY (opacity/y), plus size via layout. No colour,
// no background, no border ever animates here — those are the channels that ENCODE STATE (pending vs
// resolved, refused vs allowed), and a transition that touched them could render a state the log has
// not produced. A panel mid-enter is therefore the true panel at partial opacity — a pending card is
// pending for every frame of its transition, and the resolved style exists only on the resolved
// element, which renders only from a `decision.resolved` event. framer-scope.test.ts asserts this
// set stays closed.
//
// Reduced motion renders the plain element — no layout animation, and PanelPresence mounts/unmounts
// with no animation at all ("kills all of it", including the unmount).
//
// NOT panels, and left alone: `.join` and `.home` (no border, plain flex columns).

type PanelTag = 'div' | 'section' | 'li' | 'form';

/* design.md "Tokens": 150–200ms ease-out — the same 180ms/quint as the CSS --motion/--ease-out,
   restated because framer cannot read a custom property. Pinned by framer-scope.test.ts. */
const TRANSITION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

export function Panel({
  as = 'div',
  className,
  hook,
  children,
  ...rest
}: {
  /** The element to render. Callers span `section` (decision), `div` (welcome, popover), `li` (row), `form`. */
  as?: PanelTag;
  /** The panel's own look. Passed in, never owned here — the CSS stays exactly where it was. */
  className: string;
  /** The stable selector hook — passed as `HOOK.x`, so the contract test still sees the reference. */
  hook: HookName;
  children: ReactNode;
  role?: string;
  'aria-label'?: string;
  'data-pr-status'?: string;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  const reduce = useReducedMotion();
  // Rendered through a permissive component type: React 19's attribute types are element-specific,
  // and framer's motion proxy compounds it. `as` stays constrained to PanelTag on the way IN, and at
  // runtime `motion[as]` is the real motion element for that tag. The cast relaxes only the check.
  const M = motion[as] as unknown as ComponentType<Record<string, unknown>>;
  const motionProps = reduce ? {} : { layout: true, transition: TRANSITION };
  return (
    <M className={className} {...pr(hook)} {...motionProps} {...rest}>
      {children}
    </M>
  );
}

/**
 * Enter/exit across unmount, at the SITE of the conditional — the one job CSS cannot do, and the
 * reason the dependency exists (SHELL-B3). Owns the condition (`show`) so AnimatePresence's direct
 * child is a real motion element and the exit is structural rather than hopeful. The wrapper also
 * keeps the framer import inside this module: a surface that needs presence renders
 * <PanelPresence show={...}> and imports nothing from framer-motion itself.
 *
 * Animates opacity/y only — the truthfulness constraint above applies verbatim. Under reduced
 * motion the child simply mounts and unmounts, instantly and completely: suppressing the animation
 * must never suppress the removal.
 */
export function PanelPresence({ show, children }: { show: boolean; children: ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return show ? <>{children}</> : null;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={TRANSITION}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
