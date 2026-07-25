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
import {
  WS_CLOSE_ROOM_NOT_FOUND,
  type ClientSend,
  type ServerErrorFrame,
  type ServerEvent,
  type ServerHello,
} from '@playroom/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Socket lifecycle, as the client sees it.
type Status = 'connecting' | 'open' | 'closed';

// What a member sees. Three labelled states, not a bare coloured dot: F1 made
// refusal a real outcome, so it has to be legible at a glance rather than inferred
// from a colour. `reconnecting` covers both the first connect and a backoff retry —
// from the member's side those are the same situation.
type Conn = 'connected' | 'reconnecting' | 'refused';

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

function socketUrl(roomId: string, after: number): string {
  const base = API_URL.replace(/^http/, 'ws');
  return `${base}/rooms/${encodeURIComponent(roomId)}/ws?after=${after}`;
}

export default function RoomPage() {
  const params = useParams();
  const roomId = String(params.id ?? '');
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [author, setAuthor] = useState<string>('');
  const [body, setBody] = useState<string>('');
  const [refusal, setRefusal] = useState<ServerErrorFrame | null>(null);

  const items = useMemo<Item[]>(() => buildItems(events), [events]);
  const conn: Conn = refusal ? 'refused' : status === 'open' ? 'connected' : 'reconnecting';

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
      author: author.trim() || 'anon',
      body: text,
    };
    pendingRef.current = text;
    ws.send(JSON.stringify(payload));
    setBody('');
  };

  return (
    <main className="room">
      <header className="room-header">
        <h1 className="room-title">
          <span>
            room <span className="room-id">/ {roomId}</span>
          </span>
          <span className={`conn conn-${conn}`}>
            <span className="dot" />
            {conn}
          </span>
        </h1>
      </header>

      {refusal && (
        <p role="alert" className="refusal">
          <strong>{refusal.message}</strong>
          <span className="code">{refusal.code}</span> — nothing you type here will be delivered.
          Your message was not sent.
        </p>
      )}

      <ul className="transcript">
        {items.map((it) =>
          it.kind === 'message' ? (
            <li key={it.key}>
              <div className="turn-head">
                <span className="turn-author">{it.author}</span>
              </div>
              <div className="msg-body">{it.body}</div>
            </li>
          ) : (
            <li key={it.key}>
              <div className="turn-head">
                <span className="turn-author turn-author-agent">{it.adapter_id}</span>
                {it.streaming && <span className="working">working…</span>}
              </div>
              {/* Agent output is rendered as TEXT with whitespace preserved and
                  markdown left unparsed (.turn-body sets white-space: pre-wrap).
                  This is deliberate and closes A4-F8 in the direction §13 requires:
                  rendering model output as markup is an injection surface, while
                  preserving newlines is not. Do NOT "improve" this into a markdown
                  renderer — that needs a sanitisation story and an ADR first. */}
              <div className="turn-body">
                {it.text}
                {it.streaming && <span className="caret">▌</span>}
              </div>
              {!it.streaming && it.success === false && (
                <div className="turn-error">⚠ the turn failed</div>
              )}
              {!it.streaming && (it.tokens_in != null || it.cost_usd != null) && (
                <div className="meter">
                  {it.tokens_in != null ? `${it.tokens_in}→${it.tokens_out} tok` : ''}
                  {it.cost_usd != null ? ` · $${it.cost_usd}` : ''}
                </div>
              )}
            </li>
          ),
        )}
        <div ref={tailRef} />
      </ul>

      <form className="composer" onSubmit={onSubmit}>
        <input
          className="who"
          placeholder="you"
          value={author}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setAuthor(e.target.value)}
        />
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
