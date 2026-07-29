'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  WS_CLOSE_ROOM_NOT_FOUND,
  type ClientSend,
  type DecisionEvent,
  type ServerErrorFrame,
  type ServerEvent,
  type ServerHello,
} from '@playroom/shared';
import { MemberChip, MemberName } from '../../MemberChip';
import { DecisionCard } from '../../DecisionCard';
import { OrderChip, type OrderItemView } from '../../OrderChip';
import {
  HandoffRow,
  SummonRow,
  TaskChip,
  type HandoffItemView,
  type SummonItemView,
  type TaskItemView,
} from '../../TaskChip';
import { InterruptChip, type InterruptItemView } from '../../InterruptChip';
import { PromotionRow, type PromotionItemView } from '../../PromotionRow';
import { Welcome } from '../../Welcome';
import { HOOK, pr } from '../../hooks';
import type { Principal, RosterMember } from '../../roster';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Socket lifecycle, as the client sees it.
type Status = 'connecting' | 'open' | 'closed';

// What a member sees. Three labelled states, not a bare coloured dot: F1 made
// refusal a real outcome, so it has to be legible at a glance rather than inferred
// from a colour. `reconnecting` covers both the first connect and a backoff retry —
// from the member's side those are the same situation.
type Conn = 'connected' | 'reconnecting' | 'refused';

type MessageItem = { kind: 'message'; key: string; author: string; body: string };
type AgentItem = {
  kind: 'agent';
  key: string;
  adapter_id: string;
  text: string;
  streaming: boolean;
  success?: boolean;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
};
// A decision item exists only because a `decision` row arrived in the log. There is no constructor
// for one anywhere else in the room. Its `resolution` is mutated in place when a `decision.resolved`
// row arrives (S2.2) — the same card, now answered, never a second one; the same discipline as an
// interrupt lowered in place.
type DecisionItemView = {
  event: DecisionEvent;
  resolution: 'APPROVED' | 'DENIED' | null;
  signedBy: string | null;
};
type DecisionItem = { kind: 'decision'; key: string; view: DecisionItemView };
// A task chip exists because `task.created` arrived. Its state is mutated in place by later
// `task.state` and `task.handoff` events — one chip per task, where the work was asked for.
type TaskItem = { kind: 'task'; key: string; view: TaskItemView };
// A handoff is an ACT, so it gets its own row where it happened — see TaskChip.tsx for why the
// state chip alone is not enough.
type HandoffItem = { kind: 'handoff'; key: string; view: HandoffItemView };
// An interrupt is a claim on a member's attention. One chip per interrupt, updated in place when
// it is lowered — the downgrade changes the claim rather than making a second one.
type InterruptItem = { kind: 'interrupt'; key: string; view: InterruptItemView };
// A promotion is a DISCLOSURE that happened. One row where it happened, never updated in place:
// unlike a task or an interrupt there is no later event that changes it, because a disclosure has
// no second state — it cannot be lowered, moved or undone.
type PromotionItem = { kind: 'promotion'; key: string; view: PromotionItemView };
// An AGENT-INITIATED summon (S1.8): agent A summoned agent B through the tool-call channel. That is a
// visible ACT, unlike a human tag — which is already visible as the @-mention in the human's message.
// So ONLY agent-rooted summons render here; a human summon (requested_by is a human) does not.
type SummonItem = { kind: 'summon'; key: string; view: SummonItemView };
// A standing order (S-LOOP). One chip per order, updated in place as it changes state and cycles —
// the same discipline as an interrupt or a task, never a new chip per transition.
type OrderItem = { kind: 'order'; key: string; view: OrderItemView };
type Item =
  | MessageItem
  | AgentItem
  | DecisionItem
  | TaskItem
  | HandoffItem
  | InterruptItem
  | PromotionItem
  | SummonItem
  | OrderItem;

/**
 * Group the event log into renderable items.
 *
 * AN ALLOWLIST, with no fallthrough: an event type this chain does not name produces no item.
 * That is deliberate and it is what keeps the transcript honest as the log grows — `route.selected`
 * is a record of how a turn came to happen, not a thing a member said, and an `else` branch would
 * have rendered it as an agent bubble the moment it was added.
 *
 * `summon` is the one that renders CONDITIONALLY: an agent-initiated summon (requested_by is an
 * agent, per `agentIds`) is a visible act and gets a row; a human summon is already visible as the
 * @-mention it was, so it is skipped — the same "not a second representation of a visible fact" rule.
 */
function buildItems(events: ServerEvent[], agentIds: Set<string>): Item[] {
  const turns = new Map<string, AgentItem>();
  const tasks = new Map<string, TaskItemView>();
  const interrupts = new Map<string, InterruptItemView>();
  const decisions = new Map<string, DecisionItemView>();
  const orders = new Map<string, OrderItemView>();
  const order: Item[] = [];
  for (const ev of events) {
    if (ev.event_type === 'message') {
      order.push({
        kind: 'message',
        key: `m${ev.seq}`,
        author: ev.actor_id,
        body: ev.payload.body,
      });
    } else if (ev.event_type === 'summon') {
      // ONLY agent-initiated summons: a human tag is already the visible @-mention. `depth` and
      // `root_actor` are provenance the log keeps; the row shows the ACT — this agent summoned that one.
      if (agentIds.has(ev.payload.requested_by)) {
        order.push({
          kind: 'summon',
          key: `s${ev.seq}`,
          view: { by: ev.payload.requested_by, member: ev.payload.member },
        });
      }
    } else if (ev.event_type === 'order.created') {
      // A STANDING ORDER (S-LOOP) — one chip, updated in place by later order.status/order.cycled.
      const view: OrderItemView = {
        order_id: ev.payload.order_id,
        creator: ev.payload.creator,
        action_member: ev.payload.action_member,
        status: 'ACTIVE',
        cycle_count: 0,
        reason: null,
      };
      orders.set(ev.payload.order_id, view);
      order.push({ kind: 'order', key: `o${ev.payload.order_id}`, view });
    } else if (ev.event_type === 'order.status') {
      // THE SAME CHIP, its state changed — paused, resumed, revoked, or a bound reached. Never a new
      // chip: the order did not become a second order, it changed. Out loud, with the reason.
      const view = orders.get(ev.payload.order_id);
      if (view) {
        view.status = ev.payload.status;
        view.reason = ev.payload.status === 'ACTIVE' ? null : ev.payload.reason;
      }
    } else if (ev.event_type === 'decision') {
      const view: DecisionItemView = { event: ev, resolution: null, signedBy: null };
      decisions.set(ev.payload.decision_id, view);
      order.push({ kind: 'decision', key: `d${ev.seq}`, view });
    } else if (ev.event_type === 'decision.resolved') {
      // THE SAME CARD, ANSWERED (S2.2). A resolution is not a new row; it turns the pending card into
      // an approved or denied one, in place. A card whose decision this room never showed produces
      // nothing — the resolution has no card of its own.
      const view = decisions.get(ev.payload.decision_id);
      if (view) {
        view.resolution = ev.payload.resolution === 'APPROVED' ? 'APPROVED' : 'DENIED';
        view.signedBy = ev.payload.signed_by;
      }
    } else if (ev.event_type === 'task.created') {
      const view: TaskItemView = {
        task_id: ev.payload.task_id,
        state: ev.payload.state,
        assignee: ev.payload.assignee,
        action: ev.payload.action,
        mandate_hash: null,
        handed_by: null,
      };
      tasks.set(ev.payload.task_id, view);
      order.push({ kind: 'task', key: `k${ev.payload.task_id}`, view });
    } else if (ev.event_type === 'task.state') {
      // NO CHIP IS CREATED HERE. A state change for a task whose creation this client has not
      // seen is dropped rather than rendered as a chip with invented fields — the same
      // no-fallthrough rule the transcript has followed since S-UI. On resume the log replays
      // in order, so `task.created` always arrives first.
      const view = tasks.get(ev.payload.task_id);
      if (view) {
        view.state = ev.payload.state;
        view.assignee = ev.payload.assignee;
      }
    } else if (ev.event_type === 'context.promoted') {
      // STRAIGHT FROM THE EVENT, with nothing derived. Every field the row shows is a field the
      // record wrote — who approved, why, how much, and the text — so the room cannot describe a
      // disclosure differently from the way it was recorded.
      order.push({
        kind: 'promotion',
        key: `p${ev.payload.promotion_id}`,
        view: {
          promotion_id: ev.payload.promotion_id,
          source_principal: ev.payload.source_principal,
          representation: ev.payload.representation,
          purpose: ev.payload.purpose,
          approved_by: ev.payload.approved_by,
          content: ev.payload.content,
        },
      });
    } else if (ev.event_type === 'interrupt.raised') {
      const view: InterruptItemView = {
        interrupt_id: ev.payload.interrupt_id,
        urgency: ev.payload.urgency,
        raised_by: ev.payload.raised_by,
        addressed_to: ev.payload.addressed_to,
        summary: ev.payload.summary,
        budget_remaining: ev.payload.budget_remaining,
        downgraded: false,
      };
      interrupts.set(ev.payload.interrupt_id, view);
      order.push({ kind: 'interrupt', key: `i${ev.payload.interrupt_id}`, view });
    } else if (ev.event_type === 'interrupt.downgraded') {
      // THE SAME CHIP, LOWERED — and the budget number drops with it, which is where "visibly"
      // in the exit criterion lands. A second chip would read as a second claim.
      const view = interrupts.get(ev.payload.interrupt_id);
      if (view) {
        view.urgency = ev.payload.urgency;
        view.budget_remaining = ev.payload.budget_remaining;
        view.downgraded = true;
      }
    } else if (ev.event_type === 'task.handoff') {
      // THE CHIP MOVES. Same chip, new holder — the transfer is a change to the work, not a
      // second piece of work, and the log keeps every previous holder.
      const view = tasks.get(ev.payload.task_id);
      if (view) {
        view.state = ev.payload.state;
        view.assignee = ev.payload.to_member;
        view.action = ev.payload.action;
        view.mandate_hash = ev.payload.mandate_hash;
        view.handed_by = ev.actor_id;
      }
      // The act, in the transcript, at the point it happened — visible whether or not the chip
      // it moved is still on screen.
      order.push({
        kind: 'handoff',
        key: `x${ev.seq}`,
        view: {
          task_id: ev.payload.task_id,
          actor: ev.actor_id,
          from_member: ev.payload.from_member,
          to_member: ev.payload.to_member,
          action: ev.payload.action,
          mandate_hash: ev.payload.mandate_hash,
        },
      });
    } else if (ev.event_type === 'agent.turn.started') {
      const turn: AgentItem = {
        kind: 'agent',
        key: `t${ev.payload.turn_id}`,
        adapter_id: ev.payload.adapter_id,
        text: '',
        streaming: true,
      };
      turns.set(ev.payload.turn_id, turn);
      order.push(turn);
    } else if (ev.event_type === 'agent.turn.delta') {
      const turn = turns.get(ev.payload.turn_id);
      if (turn) turn.text += ev.payload.text;
    } else if (ev.event_type === 'agent.turn.completed') {
      const p = ev.payload;
      let turn = turns.get(p.turn_id);
      if (!turn) {
        turn = {
          kind: 'agent',
          key: `t${p.turn_id}`,
          adapter_id: p.adapter_id,
          text: '',
          streaming: false,
        };
        turns.set(p.turn_id, turn);
        order.push(turn);
      }
      turn.text = p.text;
      turn.streaming = false;
      turn.success = p.success;
      turn.tokens_in = p.tokens_in;
      turn.tokens_out = p.tokens_out;
      turn.cost_usd = p.cost_usd;
    }
  }
  return order;
}

function socketUrl(roomId: string, after: number, ticket: string): string {
  const base = API_URL.replace(/^http/, 'ws');
  // A TICKET, NOT THE CREDENTIAL (S1.3c). Something still travels in the query string, because a
  // browser cannot set headers on a WebSocket handshake — but it is worth one socket, on this
  // room, for thirty seconds, and it is spent the moment the handshake accepts it. An access log
  // holding it is holding something already useless.
  //
  // S13-N3 closed on both faces: this URL, and the page that used to carry the long-lived
  // credential to the client so it could be put here.
  return `${base}/rooms/${encodeURIComponent(roomId)}/ws?after=${after}&ticket=${encodeURIComponent(ticket)}`;
}

/**
 * Ask the web tier for a ticket.
 *
 * SAME-ORIGIN, so the credential stays in the server process that holds it — see
 * `app/api/ws-ticket/route.ts`. Called on every connect INCLUDING every reconnect, because a
 * ticket is single-use: a backoff retry that reused one would be refused, which is the property
 * working rather than a bug.
 */
async function fetchTicket(roomId: string): Promise<string> {
  const res = await fetch('/api/ws-ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room_id: roomId }),
  });
  if (!res.ok) throw new Error(`no ticket: HTTP ${res.status}`);
  const body: { ticket?: string } = await res.json();
  if (!body.ticket) throw new Error('no ticket in the response');
  return body.ticket;
}

/**
 * Fetch a bounded page of history through the same-origin BFF (S16b).
 *
 * No `before` → THE RECENT WINDOW (events after the summary floor, the span the agent's context also
 * uses). A `before` cursor → the OLDER PAGE just below it. `has_older` says whether there is more to
 * page to. This is how the client loads a long room without replaying it whole (S16-N2) and without a
 * stale cursor truncating it (S16-N1) — a WINDOW of a log whose rest is all still one request away.
 */
async function fetchHistory(
  roomId: string,
  before?: number,
): Promise<{ events: ServerEvent[]; has_older: boolean }> {
  const qs = new URLSearchParams({ room: roomId });
  if (before !== undefined) qs.set('before', String(before));
  const res = await fetch(`/api/history?${qs.toString()}`);
  if (!res.ok) throw new Error(`no history: HTTP ${res.status}`);
  const body: { events?: ServerEvent[]; has_older?: boolean } = await res.json();
  return {
    events: Array.isArray(body.events) ? body.events : [],
    has_older: Boolean(body.has_older),
  };
}

export function Room({
  roomId,
  roster,
  principals,
}: {
  roomId: string;
  roster: RosterMember[];
  principals: Principal[];
  /**
   * The member credential this browser connects as (S1.2).
   *
   * IT REACHES THE BROWSER, and that is a real limitation rather than an oversight. It is a
   * member credential held by a process, and a browser page is a process the viewer can read:
   * anyone with the page can connect as that member. What it buys is that the WIRE can no
   * longer name its author — the claim is gone from the protocol, which is the part that five
   * findings rested on. What it does not buy is a person. A per-human credential needs a login,
   * which is a product; see S12-N1 in the red-team log.
   */
}) {
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [body, setBody] = useState<string>('');
  const [refusal, setRefusal] = useState<ServerErrorFrame | null>(null);
  // WHICH MEMBER THIS SOCKET IS, from `hello`. Used only to decide whether to draw a control the
  // server would accept — the authorisation itself is the socket's, never this value.
  const [viewer, setViewer] = useState<string | null>(null);
  // THE PER-ROOM METER'S BASELINE (§18, S1.6), from `hello`: the room's spend to date, summed
  // server-side, and the high-water seq it was summed through. Authoritative, so a phone that just
  // reloaded shows the right number without holding the older events. Live turns and summaries after
  // `baselineSeq` add to it below and cannot double-count what the baseline already includes.
  const [baselineSpend, setBaselineSpend] = useState(0);
  const [baselineSeq, setBaselineSeq] = useState(0);
  // WINDOWED LOAD (S16b). `hasOlder` is whether history exists below what is loaded — the "load
  // earlier" control appears only when it would do something. `loadingOlder` makes the fetch VISIBLE
  // as loading rather than a freeze.
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // THE WELCOME SCREEN SHOWS ONCE, and only for somebody who arrived through redemption — the join
  // route redirects with `?welcome=1`. Read from the URL rather than from storage so it cannot
  // reappear on a later visit, and so my own browser and the capture harness never see it: take 13
  // is the asset and a panel over the room would have changed the film.
  const [showWelcome, setShowWelcome] = useState(
    () =>
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('welcome'),
  );

  // Agent ids, for deciding which summons render — only agent-initiated ones (S1.8). From the roster
  // prop, so it is available before `items` is built.
  const agentIdSet = useMemo(
    () => new Set(roster.filter((m) => m.kind === 'agent').map((m) => m.id)),
    [roster],
  );
  const items = useMemo<Item[]>(() => buildItems(events, agentIdSet), [events, agentIdSet]);
  const conn: Conn = refusal ? 'refused' : status === 'open' ? 'connected' : 'reconnecting';

  // WHAT THIS ROOM HAS SPENT: the authoritative baseline plus every completed turn and summary the
  // client has seen SINCE it. A fact, not a warning — it shows what was spent and never predicts,
  // nags, or moralises. Distinct from the daily ceiling, which is one number that refuses; this is
  // per-room and only informs.
  const roomSpent = useMemo(() => {
    let live = 0;
    for (const e of events) {
      if (e.seq <= baselineSeq) continue;
      if (e.event_type === 'agent.turn.completed' && e.payload.cost_usd != null) {
        live += e.payload.cost_usd;
      } else if (e.event_type === 'room.summary' && e.payload.cost_usd != null) {
        live += e.payload.cost_usd;
      }
    }
    return baselineSpend + live;
  }, [events, baselineSpend, baselineSeq]);

  // EVERY member, for resolving NAMES — humans included as of S1.3, so a byline and the decision
  // card show "Prince" rather than the raw id.
  const byId = useMemo(() => new Map(roster.map((m) => [m.id, m])), [roster]);
  // The strip's chips are the AGENTS: they are the members with a mandate to show, and the
  // human's chip is added below only once they have spoken. That composition is unchanged —
  // S1.3 widened who can be NAMED, not who is drawn in the header.
  const agents = useMemo(() => roster.filter((m) => m.kind === 'agent'), [roster]);

  // Human chips are still DERIVED FROM THE EVENT LOG — the people who have actually spoken here.
  // Membership IS a table now (S1.1b), so this could show every enrolled human from the start;
  // that is a change to what the header displays and it belongs to the shell slice, not to a
  // slice about tasks. What DID change: the chip now resolves through the roster, so it renders
  // a display name instead of a member id.
  const humans = useMemo<string[]>(() => {
    const agentIds = new Set(agents.map((m) => m.id));
    const seen = new Set<string>();
    for (const e of events) {
      if (e.event_type !== 'message') continue;
      if (e.actor_id === 'system' || agentIds.has(e.actor_id)) continue;
      seen.add(e.actor_id);
    }
    return [...seen];
  }, [events, agents]);

  const wsRef = useRef<WebSocket | null>(null);
  // THE RESUME CURSOR, IN MEMORY ONLY (S16b). It was persisted to sessionStorage, which is what
  // made a RELOAD resume from a stale point and show a truncated room (S16-N1). It now lives only for
  // the life of this mount — used to resume a DROPPED socket (which retains its events), never to
  // decide what a fresh open loads. A fresh open loads the window, always.
  const lastSeqRef = useRef<number>(0);
  const oldestSeqRef = useRef<number>(0); // oldest event loaded — the cursor for the next older page
  const seenRef = useRef<Set<number>>(new Set());
  const backoffRef = useRef<number>(500);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef<boolean>(false);
  const pendingRef = useRef<string>(''); // last body sent, restored if it is refused
  const tailRef = useRef<HTMLDivElement | null>(null);
  // Set when a page of OLDER history is prepended, so the "keep the newest in frame" effect below
  // does NOT yank the reader to the bottom on a load-older — the one items change that must not scroll.
  const prependingRef = useRef<boolean>(false);

  /**
   * ONE TAP. The frame carries only the interrupt id: who is lowering it is the socket's
   * authenticated member, which the server reads for itself rather than believing a field.
   */
  const downgrade = useCallback((interruptId: string): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'downgrade',
        client_msg_id: `dg-${interruptId}`,
        interrupt_id: interruptId,
      }),
    );
  }, []);

  /**
   * COMPLETE A CO-SIGNATURE (S2.2). The frame carries only the decision id and the answer: WHO is
   * signing is the socket's authenticated member, which the server reads for itself and refuses if it
   * is not the human bound to the decision's required principal. The button is offered only to that
   * signer (see DecisionCard), but the server is the authority — the affordance is not the check.
   */
  const signDecision = useCallback(
    (decisionId: string, resolution: 'APPROVED' | 'DENIED'): void => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: 'sign_decision',
          client_msg_id: `sign-${decisionId}-${resolution}`,
          decision_id: decisionId,
          resolution,
        }),
      );
    },
    [],
  );

  /**
   * Load the page of history just before the oldest event held — S16b, item 10.
   *
   * WINDOWED, NOT TRUNCATED: the older messages were never lost, only not loaded, and this reaches
   * them. It prepends and flags `prependingRef` so the newest-in-frame effect leaves the reader where
   * they are. `has_older` from the response decides whether the control stays.
   */
  const loadOlder = useCallback((): void => {
    if (loadingOlder || oldestSeqRef.current <= 1) return;
    setLoadingOlder(true);
    void (async (): Promise<void> => {
      try {
        const { events: page, has_older } = await fetchHistory(roomId, oldestSeqRef.current);
        if (stoppedRef.current) return;
        const fresh = page.filter((ev) => !seenRef.current.has(ev.seq));
        if (fresh.length > 0) {
          for (const ev of fresh) seenRef.current.add(ev.seq);
          oldestSeqRef.current = fresh[0].seq;
          prependingRef.current = true;
          setEvents((prev) => [...fresh, ...prev].sort((a, b) => a.seq - b.seq));
        }
        setHasOlder(has_older);
      } catch {
        // Leave the control in place: a failed page is a retry, not a dead end.
      } finally {
        setLoadingOlder(false);
      }
    })();
  }, [roomId, loadingOlder]);

  const connect = useCallback((): void => {
    if (!roomId) return;
    setStatus('connecting');

    // THE TICKET COMES FIRST, and it is fetched per attempt. A failed exchange is treated exactly
    // like a failed socket: back off and try again, because both mean "not connected yet" and a
    // member watching the badge cannot tell them apart anyway.
    void (async (): Promise<void> => {
      let ticket: string;
      try {
        ticket = await fetchTicket(roomId);
      } catch {
        if (stoppedRef.current) return;
        const wait = backoffRef.current;
        backoffRef.current = Math.min(wait * 2, 5000);
        timerRef.current = setTimeout(connect, wait);
        return;
      }
      if (stoppedRef.current) return; // a refusal or an unmount landed while we were asking

      const ws = new WebSocket(socketUrl(roomId, lastSeqRef.current, ticket));
      wsRef.current = ws;

      ws.onopen = (): void => {
        setStatus('open');
        backoffRef.current = 500; // reset backoff after a good connection
      };
      ws.onmessage = (e: MessageEvent): void => {
        // Wire boundary: JSON.parse returns `any`; assigning it to the union is not a
        // cast. The server sends validated frames (there is no zod at runtime in the
        // web app — a dep constraint). We then narrow on the discriminant below.
        let msg: ServerEvent | ServerHello | ServerErrorFrame;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        // An explicit refusal. Surface it and stop: the server has already closed the
        // socket, and retrying a room that does not exist would just loop.
        if (msg.type === 'error') {
          stoppedRef.current = true;
          setRefusal(msg);
          setStatus('closed');
          // Put the text back. It was cleared optimistically on send, and leaving the
          // box empty after a refusal is the whole bug: it reads as "sent". Only
          // restore if the member has not started typing something else.
          setBody((current) => (current.trim() ? current : pendingRef.current));
          return;
        }
        if (msg.type === 'hello') {
          setViewer(msg.member_id);
          // Re-baseline on every hello, including a reconnect: the server's number is authoritative
          // and supersedes whatever the client had accrued.
          setBaselineSpend(msg.room_spent_usd);
          setBaselineSeq(msg.last_seq);
          return;
        }
        if (msg.type !== 'event') return;
        if (seenRef.current.has(msg.seq)) return; // dedupe on seq
        seenRef.current.add(msg.seq);
        // In-memory only now (S16b): the cursor resumes a dropped socket, and is never persisted, so a
        // reload cannot resume from it and truncate the room (S16-N1). The oldest cursor only moves
        // BACKWARD, via loadOlder — a live event is always newer than the window, never older than it.
        if (msg.seq > lastSeqRef.current) lastSeqRef.current = msg.seq;
        setEvents((prev) => [...prev, msg].sort((a, b) => a.seq - b.seq));
      };
      ws.onclose = (e: CloseEvent): void => {
        setStatus('closed');
        // A refused room is permanent, not transient: reconnecting would loop until
        // the tab is closed. The close code says so without string-matching a reason.
        if (e.code === WS_CLOSE_ROOM_NOT_FOUND) stoppedRef.current = true;
        if (stoppedRef.current) return;
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, 5000); // 0.5s → 5s cap
        timerRef.current = setTimeout(connect, delay);
      };
      ws.onerror = (): void => ws.close();
    })();
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    // A FRESH OPEN LOADS THE WINDOW, NOT THE LOG (S16b). Reset, fetch the recent window over HTTP,
    // then connect the socket for the live tail from where the window ends. The client mirror of what
    // the summary already did for the agent: a bounded recent span, the rest reachable via loadOlder.
    // No stale cursor to truncate from (N1), no whole-room replay (N2).
    lastSeqRef.current = 0;
    oldestSeqRef.current = 0;
    seenRef.current = new Set();
    stoppedRef.current = false;
    setEvents([]);
    setHasOlder(false);
    void (async (): Promise<void> => {
      try {
        const { events: recent, has_older } = await fetchHistory(roomId);
        if (stoppedRef.current) return;
        for (const ev of recent) seenRef.current.add(ev.seq);
        if (recent.length > 0) {
          oldestSeqRef.current = recent[0].seq;
          lastSeqRef.current = recent[recent.length - 1].seq;
        }
        setEvents([...recent].sort((a, b) => a.seq - b.seq));
        setHasOlder(has_older);
      } catch {
        // The window failed to load — connect anyway (from 0) so the room still opens rather than
        // showing nothing. That degrades to the pre-S16b full replay, which is no worse; the history
        // route shares a tier with the ticket route, so this is rare.
      }
      // THEN the live tail, resuming from where the window ended (lastSeqRef). Not after=0 on a loaded
      // window — the socket replays only the gap since the fetch, not the whole room.
      if (!stoppedRef.current) connect();
    })();
    return () => {
      stoppedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [roomId, connect]);

  // Keep the newest turn in frame. The transcript scrolls, not the page, so this
  // never drags the composer out of shot mid-take.
  useEffect(() => {
    // ON A LOAD-OLDER PREPEND, do not scroll to the tail: the reader is up in the history, and yanking
    // them to the newest message is the opposite of what they asked for. Every other items change —
    // the window loading, a live event — keeps the newest in frame.
    if (prependingRef.current) {
      prependingRef.current = false;
      return;
    }
    tailRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const text = body.trim();
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    const payload: ClientSend = {
      type: 'send',
      client_msg_id: crypto.randomUUID(),
      body: text,
    };
    pendingRef.current = text;
    ws.send(JSON.stringify(payload));
    setBody('');
  };

  return (
    <main className="room" {...pr(HOOK.room)}>
      <header className="room-header">
        <h1 className="room-title">
          <span>
            room <span className="room-id">/ {roomId}</span>
          </span>
          {/* `data-pr-state` carries the state as DATA. The harness read a `title`
              attribute here once and the attribute was removed by a redesign, matching
              nothing — a hook is a contract, a class name is not (S06-N1). */}
          <span className={`conn conn-${conn}`} {...pr(HOOK.conn)} data-pr-state={conn}>
            <span className="dot" />
            {conn}
          </span>
        </h1>
        <div className="roster" {...pr(HOOK.roster)}>
          {agents.map((m) => (
            <MemberChip key={m.id} member={m} name={m.id} />
          ))}
          {humans.map((h) => (
            <MemberChip key={h} member={byId.get(h)} name={h} />
          ))}
        </div>
        {/* THE PER-ROOM METER (§18, S1.6). Ambient and quiet — a member can see spend accruing
            before they hit the ceiling, but it never nags. Shown only once there is spend to show,
            so a fresh room carries nothing. It reads "this room" to stay distinct from the daily
            ceiling, which is a different number on a different surface (the refusal, when hit). */}
        {roomSpent > 0 && (
          <div className="room-meter" {...pr(HOOK.roomSpend)}>
            this room · ${roomSpent.toFixed(4)}
          </div>
        )}
        {/* INSIDE THE HEADER, not as a fourth child of `.room`. The room is a three-row grid
            (header / transcript / composer) and a fourth child takes `1fr` off the transcript and
            pushes the composer into an implicit row — the layout collapses rather than shifting,
            which is a good deal worse than the panel being in the wrong place. */}
        {showWelcome && (
          <Welcome
            roster={roster}
            viewer={viewer}
            onDismiss={() => {
              setShowWelcome(false);
              // Take the flag out of the URL so a reload does not bring the panel back, and so a
              // shared link never carries somebody else's onboarding.
              window.history.replaceState(null, '', `/r/${roomId}`);
            }}
          />
        )}
      </header>

      {refusal && (
        <p role="alert" className="refusal" {...pr(HOOK.refusal)}>
          <strong>{refusal.message}</strong>
          <span className="code">{refusal.code}</span> — nothing you type here will be delivered.
          Your message was not sent.
        </p>
      )}

      <ul className="transcript" {...pr(HOOK.transcript)}>
        {/* LOAD EARLIER — the top of a WINDOW, not the top of the room (S16b). It appears only when
            history exists below what is loaded, and reaching it is one request, never a lost message.
            An explicit control rather than scroll-detection: loading behaviour, no new UI look. */}
        {hasOlder && (
          <li className="load-older">
            <button
              type="button"
              className="load-older-btn"
              onClick={loadOlder}
              disabled={loadingOlder}
              {...pr(HOOK.loadOlder)}
            >
              {loadingOlder ? 'loading earlier messages…' : 'load earlier messages'}
            </button>
          </li>
        )}
        {items.map((it) =>
          it.kind === 'message' ? (
            <li key={it.key} {...pr(HOOK.message)} data-pr-author={it.author}>
              <div className="turn-head">
                {/* A human's byline is the same component an agent gets — the SHAPE and the
                    absence of an accent are what distinguish them, not a word. */}
                <MemberName member={byId.get(it.author)} name={it.author} />
              </div>
              <div className="msg-body" {...pr(HOOK.body)}>
                {it.body}
              </div>
            </li>
          ) : it.kind === 'decision' ? (
            <li key={it.key}>
              <DecisionCard
                event={it.view.event}
                resolution={it.view.resolution}
                signedBy={it.view.signedBy}
                roster={roster}
                principals={principals}
                viewer={viewer}
                onSign={signDecision}
              />
            </li>
          ) : it.kind === 'task' ? (
            <li key={it.key}>
              <TaskChip task={it.view} roster={byId} />
            </li>
          ) : it.kind === 'interrupt' ? (
            <li key={it.key}>
              <InterruptChip
                interrupt={it.view}
                roster={byId}
                viewer={viewer}
                onDowngrade={downgrade}
              />
            </li>
          ) : it.kind === 'handoff' ? (
            <li key={it.key}>
              <HandoffRow handoff={it.view} roster={byId} />
            </li>
          ) : it.kind === 'summon' ? (
            <li key={it.key}>
              <SummonRow summon={it.view} roster={byId} />
            </li>
          ) : it.kind === 'order' ? (
            <li key={it.key}>
              <OrderChip order={it.view} roster={byId} />
            </li>
          ) : it.kind === 'promotion' ? (
            <li key={it.key}>
              <PromotionRow promotion={it.view} roster={byId} />
            </li>
          ) : (
            /* `data-accent` on the ROW, so the caret and the working indicator inherit the
               speaking member's colour — custom properties cascade, a class would not. */
            <li
              key={it.key}
              {...pr(HOOK.turn)}
              data-pr-member={it.adapter_id}
              {...(byId.get(it.adapter_id)?.accent != null
                ? { 'data-accent': byId.get(it.adapter_id)?.accent }
                : {})}
            >
              <div className="turn-head">
                <MemberName member={byId.get(it.adapter_id)} name={it.adapter_id} />
                {it.streaming && <span className="working">working…</span>}
              </div>
              {/* Agent output is rendered as TEXT with whitespace preserved and
                  markdown left unparsed (.turn-body sets white-space: pre-wrap).
                  This is deliberate and closes A4-F8 in the direction §13 requires:
                  rendering model output as markup is an injection surface, while
                  preserving newlines is not. Do NOT "improve" this into a markdown
                  renderer — that needs a sanitisation story and an ADR first. */}
              <div className="turn-body" {...pr(HOOK.body)}>
                {it.text}
                {it.streaming && (
                  <span className="caret" {...pr(HOOK.caret)}>
                    {'▌'}
                  </span>
                )}
              </div>
              {!it.streaming && it.success === false && (
                <div className="turn-error">⚠ the turn failed</div>
              )}
              {!it.streaming && (it.tokens_in != null || it.cost_usd != null) && (
                <div className="meter" {...pr(HOOK.spend)}>
                  {it.tokens_in != null ? `${it.tokens_in}→${it.tokens_out} tok` : ''}
                  {it.cost_usd != null ? ` · $${it.cost_usd}` : ''}
                </div>
              )}
            </li>
          ),
        )}
        <div ref={tailRef} />
      </ul>

      <form className="composer" onSubmit={onSubmit} {...pr(HOOK.composer)}>
        {/* THE `you` INPUT IS GONE. It let a sender type their own name, which the server
            wrote down — the claim S1.2 exists to delete. Identity now comes from the
            credential on the socket, so a box labelled "you" would control nothing, and a
            control that changes nothing is a UI telling a lie about itself. Showing WHO you
            are authenticated as is a real need and a design decision; it belongs to the shell
            slice, not here. */}
        <input
          className="what"
          placeholder="message"
          value={body}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setBody(e.target.value)}
        />
        <button type="submit" disabled={conn === 'refused'}>
          send
        </button>
      </form>
    </main>
  );
}
