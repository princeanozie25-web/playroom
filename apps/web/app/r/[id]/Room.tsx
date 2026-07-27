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
import { HandoffRow, TaskChip, type HandoffItemView, type TaskItemView } from '../../TaskChip';
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
// A decision item exists only because a `decision` row arrived in the log. There is
// no constructor for one anywhere else in the room.
type DecisionItem = { kind: 'decision'; key: string; event: DecisionEvent };
// A task chip exists because `task.created` arrived. Its state is mutated in place by later
// `task.state` and `task.handoff` events — one chip per task, where the work was asked for.
type TaskItem = { kind: 'task'; key: string; view: TaskItemView };
// A handoff is an ACT, so it gets its own row where it happened — see TaskChip.tsx for why the
// state chip alone is not enough.
type HandoffItem = { kind: 'handoff'; key: string; view: HandoffItemView };
type Item = MessageItem | AgentItem | DecisionItem | TaskItem | HandoffItem;

/**
 * Group the event log into renderable items.
 *
 * AN ALLOWLIST, with no fallthrough: an event type this chain does not name produces no item.
 * That is deliberate and it is what keeps the transcript honest as the log grows — `summon`
 * and `route.selected` are records of how a turn came to happen, not things a member said, and
 * an `else` branch would have rendered them as agent bubbles the moment they were added.
 */
function buildItems(events: ServerEvent[]): Item[] {
  const turns = new Map<string, AgentItem>();
  const tasks = new Map<string, TaskItemView>();
  const order: Item[] = [];
  for (const ev of events) {
    if (ev.event_type === 'message') {
      order.push({
        kind: 'message',
        key: `m${ev.seq}`,
        author: ev.actor_id,
        body: ev.payload.body,
      });
    } else if (ev.event_type === 'decision') {
      order.push({ kind: 'decision', key: `d${ev.seq}`, event: ev });
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

function socketUrl(roomId: string, after: number, token: string): string {
  const base = API_URL.replace(/^http/, 'ws');
  // The credential travels in the query string because a browser cannot set headers on a
  // WebSocket handshake. That puts it in any api access log that is ever enabled, and in browser
  // history — recorded as S13-N3, with a subprotocol or a short-lived ticket as the fix.
  //
  // THIS COMMENT CITED S12-N2 UNTIL S1.3, which is a different finding entirely (a governed
  // request's subject being a claim). So the concern was documented at the code and recorded
  // nowhere, under a label pointing at something else — the failure mode a ledger exists to
  // prevent, committed in the same slice that built the ledger entry.
  return `${base}/rooms/${encodeURIComponent(roomId)}/ws?after=${after}&token=${encodeURIComponent(token)}`;
}

export function Room({
  roomId,
  roster,
  principals,
  token,
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
  token: string;
}) {
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [body, setBody] = useState<string>('');
  const [refusal, setRefusal] = useState<ServerErrorFrame | null>(null);

  const items = useMemo<Item[]>(() => buildItems(events), [events]);
  const conn: Conn = refusal ? 'refused' : status === 'open' ? 'connected' : 'reconnecting';

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
  const lastSeqRef = useRef<number>(0); // last seq seen — the resume cursor
  const seenRef = useRef<Set<number>>(new Set());
  const backoffRef = useRef<number>(500);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef<boolean>(false);
  const pendingRef = useRef<string>(''); // last body sent, restored if it is refused
  const tailRef = useRef<HTMLDivElement | null>(null);

  const connect = useCallback((): void => {
    if (!roomId) return;
    setStatus('connecting');
    const ws = new WebSocket(socketUrl(roomId, lastSeqRef.current, token));
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
      if (msg.type !== 'event') return;
      if (seenRef.current.has(msg.seq)) return; // dedupe on seq
      seenRef.current.add(msg.seq);
      if (msg.seq > lastSeqRef.current) {
        lastSeqRef.current = msg.seq;
        sessionStorage.setItem(`playroom:last:${roomId}`, String(msg.seq));
      }
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
  }, [roomId, token]);

  useEffect(() => {
    if (!roomId) return;
    lastSeqRef.current = Number(sessionStorage.getItem(`playroom:last:${roomId}`) || 0);
    seenRef.current = new Set();
    stoppedRef.current = false;
    connect();
    return () => {
      stoppedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [roomId, connect]);

  // Keep the newest turn in frame. The transcript scrolls, not the page, so this
  // never drags the composer out of shot mid-take.
  useEffect(() => {
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
      </header>

      {refusal && (
        <p role="alert" className="refusal" {...pr(HOOK.refusal)}>
          <strong>{refusal.message}</strong>
          <span className="code">{refusal.code}</span> — nothing you type here will be delivered.
          Your message was not sent.
        </p>
      )}

      <ul className="transcript" {...pr(HOOK.transcript)}>
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
              <DecisionCard event={it.event} roster={roster} principals={principals} />
            </li>
          ) : it.kind === 'task' ? (
            <li key={it.key}>
              <TaskChip task={it.view} roster={byId} />
            </li>
          ) : it.kind === 'handoff' ? (
            <li key={it.key}>
              <HandoffRow handoff={it.view} roster={byId} />
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
