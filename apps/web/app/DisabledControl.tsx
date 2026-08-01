import type { ReactNode } from 'react';

// THE DISABLED CONTROL — a control shown inert as a STATEMENT, not one that merely happens to be
// busy (SHELL-A3). Two of these exist, and they refuse for different reasons by different rules: the
// mandate surface's co-signature switch is inert because the surface is a read-only projection (a
// mandate is set in code, not changed here), and the decision card's Approve/Deny are inert for
// everyone who is not the required signer. Rendering them identically WITHOUT their reason would turn
// two honest refusals into one grey blur — so the reason travels with the control.
//
// REASON IS REQUIRED BY CONSTRUCTION. There is no default, no fallback, and no optional field: the
// prop is `reason: string`, so a control that cannot say why it is disabled does not typecheck. The
// type refuses the lie; nothing has to catch it at runtime. (disabled-control.test.ts proves this by
// a @ts-expect-error that only compiles while the prop stays required.)
//
// It travels as `title`: a pointer sees it on hover, a screen reader reads it as the control's
// description, and it changes NO visible layout — a disabled control looked exactly like this before,
// and a title renders nothing in a screenshot. Where the surface already states the reason in the open
// (the decision card's "Awaiting Prince"), that text stays; this adds the reason to the control itself.
//
// NOT this primitive, deliberately: the busy/loading disabled buttons elsewhere (a form mid-submit,
// "load earlier…", the composer while a room is refused) are active controls momentarily off, not
// refusals by a rule. Conflating them would be the grey-blur mistake in reverse.

type DisabledControlProps =
  | {
      /** A refused action button (Approve / Deny). Its label is the child. */
      as?: 'button';
      reason: string;
      children: ReactNode;
    }
  | {
      /** A switch shown in its TRUE position and frozen there — the mandate surface's co-sign box. */
      as: 'checkbox';
      reason: string;
      /** The position the switch genuinely holds; showing it inert is the whole point. */
      checked: boolean;
      /** The accessible name — the switch carries no visible label of its own. */
      'aria-label': string;
    };

export function DisabledControl(props: DisabledControlProps) {
  if (props.as === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={props.checked}
        disabled
        readOnly
        title={props.reason}
        aria-label={props['aria-label']}
      />
    );
  }
  return (
    <button type="button" disabled title={props.reason}>
      {props.children}
    </button>
  );
}
