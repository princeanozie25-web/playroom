import { MemberName } from './MemberChip';
import type { RosterMember } from './roster';
import { HOOK, pr } from './hooks';

// THE STANDING-ORDER CHIP (S-LOOP) — recurring work a human authorised, ambient in the room (§18's
// register: a fact, not a nag). It says what recurs, who authorised it, its status, and how many
// cycles it has run — quiet, one line, updated in place as the order pauses/resumes/revokes and cycles.
//
// ITS ONLY INPUT IS THE ORDER EVENTS IN THE LOG (order.created + order.status, and — the firing commit
// — order.cycled). There is no prop for "show a pretend one" and no default: a chip exists because
// order.created arrived, and its state is whatever the last order.status said. If the room ever shows
// an order the log did not produce, this component is where that went wrong.

/** The statuses, as words a person would use. Unknown statuses render verbatim. */
const STATUS_WORDS: Record<string, string> = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  LIMIT_REACHED: 'limit reached',
};

export interface OrderItemView {
  order_id: string;
  /** The human who authorised it — the root of every summon it fires. */
  creator: string;
  /** The member it summons each cycle. */
  action_member: string;
  status: string;
  cycle_count: number;
  /** Why it is paused/terminal, once it is — shown so the room says out loud why it stopped. */
  reason: string | null;
}

export function OrderChip({
  order,
  roster,
}: {
  order: OrderItemView;
  roster: Map<string, RosterMember>;
}) {
  const creator = roster.get(order.creator);
  const action = roster.get(order.action_member);
  return (
    <div className="order-chip" {...pr(HOOK.order)} data-pr-status={order.status}>
      <span className="order-kicker">standing order</span>
      <span className="order-status">{STATUS_WORDS[order.status] ?? order.status}</span>
      {/* WHAT RECURS — it summons this member each cycle. */}
      <span className="order-summons">summons</span>
      <MemberName member={action} name={order.action_member} />
      <span className="order-cycles">
        {order.cycle_count} cycle{order.cycle_count === 1 ? '' : 's'}
      </span>
      {/* WHO AUTHORISED IT — the human at the head; an order confers no authority, it only recurs. */}
      <span className="order-by">
        by <MemberName member={creator} name={order.creator} />
      </span>
      {/* WHY IT STOPPED, when it has — never a silent pause. */}
      {order.reason && order.status !== 'ACTIVE' ? (
        <span className="order-reason">{order.reason}</span>
      ) : null}
    </div>
  );
}
