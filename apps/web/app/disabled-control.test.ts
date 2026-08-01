import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { DisabledControl } from './DisabledControl';

// THE DISABLED CONTROL CARRIES ITS REASON — asserted at the two levels this repo can check without a
// DOM (no jsdom, no testing-library — the same limit hooks.test.ts and mandate-no-write.test.ts state,
// and for the same dependency reason). The rendered `title` is proven by the SHELL-A render harness;
// here the MECHANISM is proven: the reason is required BY CONSTRUCTION, and the two call sites supply
// DIFFERENT reasons, each sourced from its own rule — not the same reason rendered three ways.

const APP = resolve(import.meta.dirname);
const primitive = readFileSync(resolve(APP, 'DisabledControl.tsx'), 'utf8');
const mandate = readFileSync(resolve(APP, 'MandateSurface.tsx'), 'utf8');
const decision = readFileSync(resolve(APP, 'DecisionCard.tsx'), 'utf8');

describe('DisabledControl — the reason is required by construction, not by validation', () => {
  it('does not typecheck without a reason (the type refuses the lie)', () => {
    // If `reason` were optional or defaulted, the @ts-expect-error below would become an UNUSED
    // expect-error and `tsc -b` in `pnpm verify` would fail. So this file passing typecheck IS the
    // proof that a control with no reason cannot be constructed — enforced by the compiler, not a
    // runtime check. createElement (not JSX) so the file needs no JSX runtime; the component is never
    // rendered, only described.
    // @ts-expect-error — a DisabledControl with no reason must not typecheck
    createElement(DisabledControl, { children: 'Approve' });
    // A well-formed one, for contrast, compiles:
    createElement(DisabledControl, { reason: 'because', children: 'Approve' });
    expect(true).toBe(true);
  });

  it('declares reason required — no optional, no default, no fallback — and renders it as title', () => {
    expect(primitive).toMatch(/reason:\s*string/);
    expect(primitive, 'reason must not be optional').not.toMatch(/reason\?:/);
    expect(primitive, 'reason must have no default').not.toMatch(/reason\s*=\s*['"`]/);
    expect(primitive, 'reason must have no ?? fallback').not.toMatch(/reason\s*\?\?/);
    expect(primitive, 'the reason must travel with the control').toMatch(/title=\{props\.reason\}/);
  });
});

describe('each call site supplies its own true reason, and the two differ', () => {
  const mandateReason = /reason="([^"]+)"/.exec(mandate)?.[1] ?? null;
  const decisionReasonExpr = /reason=\{([^}]+)\}/.exec(decision)?.[1] ?? null;

  it('the mandate switch is inert because the surface is read-only', () => {
    expect(mandate, 'MandateSurface must construct a DisabledControl').toContain(
      '<DisabledControl',
    );
    expect(mandateReason, 'a literal reason string was expected').not.toBeNull();
    expect(mandateReason).toMatch(/read-only/i);
    // and it does NOT borrow the decision card's rule
    expect(mandateReason).not.toMatch(/awaiting/i);
  });

  it('the decision buttons are inert because the viewer is not the required signer', () => {
    expect(decision, 'DecisionCard must construct a DisabledControl').toContain('<DisabledControl');
    expect(decisionReasonExpr, 'a reason expression was expected').toContain('pendingReason');
    // pendingReason is SOURCED FROM the required signer, not a constant, and says who is awaited
    expect(decision).toMatch(/const pendingReason\s*=\s*signer\s*\?/);
    expect(decision).toMatch(/Awaiting \$\{signer\.display_name\}/);
    // and it does NOT borrow the mandate surface's rule
    expect(decision.slice(decision.indexOf('const pendingReason'))).not.toMatch(/read-only/i);
  });

  it('the two reasons are not the same — three honest refusals, not one grey blur', () => {
    // A literal read-only sentence vs a signer-derived "Awaiting …" expression: different text, from
    // different rules. A primitive that rendered one reason for both would fail here.
    expect(mandateReason).not.toEqual(decisionReasonExpr);
  });
});
