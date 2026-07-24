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
import { useParams } from 'next/navigation';
import type { ClientSend, ServerEvent, ServerHello } from '@playroom/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

type Status = 'connecting' | 'open' | 'closed';
const DOT: Record<Status, string> = { open: '#3fb950', connecting: '#d29922', closed: '#f85149' };

function socketUrl(roomId: string, after: number): string {
  const base = API_URL.replace(/^http/, 'ws');
  return `${base}/rooms/${encodeURIComponent(roomId)}/ws?after=${after}`;
}

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
type Item = MessageItem | AgentItem;

// Reduce the raw seq-ordered events into render items. Agent turn events collapse
// into a single bubble keyed by turn_id: deltas append while streaming, completed
// sets the authoritative text + telemetry. Narrowing on event_type gives each
// branch its exact payload — no casts. Replaying deltas on resume rebuilds the same
// text (deduped upstream on seq, so nothing is doubled).
function buildItems(events: ServerEvent[]): Item[] {
  const turns = new Map<string, AgentItem>();
  const order: Item[] = [];
  for (const ev of events) {
    if (ev.event_type === 'message') {
      order.push({
        kind: 'message',
        key: `m${ev.seq}`,
        author: ev.actor_id,
        body: ev.payload.body,
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

export default function RoomPage() {
  const params = useParams();
  const roomId = String(params.id ?? '');
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [author, setAuthor] = useState<string>('');
  const [body, setBody] = useState<string>('');

  const items = useMemo<Item[]>(() => buildItems(events), [events]);

  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef<number>(0); // last seq seen — the resume cursor
  const seenRef = useRef<Set<number>>(new Set());
  const backoffRef = useRef<number>(500);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef<boolean>(false);

  const connect = useCallback((): void => {
    if (!roomId) return;
    setStatus('connecting');
    const ws = new WebSocket(socketUrl(roomId, lastSeqRef.current));
    wsRef.current = ws;

    ws.onopen = (): void => {
      setStatus('open');
      backoffRef.current = 500; // reset backoff after a good connection
    };
    ws.onmessage = (e: MessageEvent): void => {
      // Wire boundary: JSON.parse returns `any`; assigning it to the union is not a
      // cast. The server sends validated frames (there is no zod at runtime in the
      // web app — a dep constraint). We then narrow on the discriminant below.
      let msg: ServerEvent | ServerHello;
      try {
        msg = JSON.parse(e.data);
      } catch {
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
    ws.onclose = (): void => {
      setStatus('closed');
      if (stoppedRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, 5000); // 0.5s → 5s cap
      timerRef.current = setTimeout(connect, delay);
    };
    ws.onerror = (): void => ws.close();
  }, [roomId]);

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

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const text = body.trim();
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    const payload: ClientSend = {
      type: 'send',
      client_msg_id: crypto.randomUUID(),
      author: author.trim() || 'anon',
      body: text,
    };
    ws.send(JSON.stringify(payload));
    setBody('');
  };

  return (
    <main>
      <h1>
        <span className="dot" style={{ background: DOT[status] }} title={status} />
        room / {roomId}
      </h1>
      <ul className="messages">
        {items.map((it) =>
          it.kind === 'message' ? (
            <li key={it.key}>
              <strong>{it.author}</strong> {it.body}
            </li>
          ) : (
            <li key={it.key}>
              <strong>{it.adapter_id}</strong> {it.text}
              {it.streaming && <span style={{ opacity: 0.5 }}>▍</span>}
              {!it.streaming && it.success === false && (
                <span style={{ color: DOT.closed }}> ⚠ error</span>
              )}
              {!it.streaming && (it.tokens_in != null || it.cost_usd != null) && (
                <div style={{ fontSize: 12, opacity: 0.55 }}>
                  {it.tokens_in != null ? `${it.tokens_in}→${it.tokens_out} tok` : ''}
                  {it.cost_usd != null ? ` · $${it.cost_usd}` : ''}
                </div>
              )}
            </li>
          ),
        )}
      </ul>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          placeholder="you"
          value={author}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setAuthor(e.target.value)}
          style={{ width: 100 }}
        />
        <input
          placeholder="message"
          value={body}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setBody(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit">send</button>
      </form>
    </main>
  );
}
