import type { ComponentType, FormEventHandler, ReactNode } from 'react';
import { pr, type HookName } from './hooks';

// THE PANEL — the bordered container the decision card, the welcome strip, the mandate-detail
// popover and the loops screen's row and its two forms each opened by hand (SHELL-A2). It owns the
// wrapper element and the stable `data-pr` wiring; it deliberately does NOT own the LOOK.
//
// Every panel keeps its own class, because their looks genuinely differ and merging them would be a
// restyle wearing an extraction's clothes: `.decision` has a left-accent rule and a max-width,
// `.welcome` fills indigo, `.loop-row` carries a status-driven left border, `.mandate-detail` is an
// absolutely-positioned popover with a shadow. So the class is passed in and the CSS is untouched —
// the DOM this emits is what each caller emitted before.
//
// Those per-panel differences are exactly what SHELL-B's motion pass will have to animate — a popover
// opening is not a row appearing — and Panel is now the single place that reaches all of them.
//
// NOT panels, and left alone: `.join` and `.home` (no border, plain flex columns). A primitive is the
// container that actually repeats, not every element that wraps something.

type PanelTag = 'div' | 'section' | 'li' | 'form';

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
  // Rendered through a permissive component type. React 19's attribute types are element-specific (a
  // form's onSubmit is not a div's), so a union tag makes JSX intersect every element's props and reject
  // whatever is valid only for the element actually chosen. `as` stays constrained to PanelTag on the
  // way IN — callers cannot ask for an arbitrary element — and at runtime `Component` is still the plain
  // tag string, so `createElement('form', …)` is what runs. The cast relaxes only the type check.
  const Component = as as unknown as ComponentType<Record<string, unknown>>;
  return (
    <Component className={className} {...pr(hook)} {...rest}>
      {children}
    </Component>
  );
}
