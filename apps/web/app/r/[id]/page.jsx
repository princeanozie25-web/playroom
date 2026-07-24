'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const DOT = { open: '#3fb950', connecting: '#d29922', closed: '#f85149' };

function socketUrl(roomId, after) {
  const base = API_URL.replace(/^http/, 'ws');
  return `${base}/rooms/${encodeURIComponent(roomId)}/ws?after=${after}`;
}

export default function RoomPage() {
  const params = useParams();
  const roomId = String(params.id ?? '');
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState('connecting');
  const [author, setAuthor] = useState('');
  const [body, setBody] = useState('');

  const wsRef = useRef(null);
  const lastSeqRef = useRef(0); // last seq seen — the resume cursor
  const seenRef = useRef(new Set());
  const backoffRef = useRef(500);
  const timerRef = useRef(null);
  const stoppedRef = useRef(false);

  const connect = useCallback(() => {
    if (!roomId) return;
    setStatus('connecting');
    const ws = new WebSocket(socketUrl(roomId, lastSeqRef.current));
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('open');
      backoffRef.current = 500; // reset backoff after a good connection
    };
    ws.onmessage = (e) => {
      let msg;
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
    ws.onclose = () => {
      setStatus('closed');
      if (stoppedRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, 5000); // 0.5s → 5s cap
      timerRef.current = setTimeout(connect, delay);
    };
    ws.onerror = () => ws.close();
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

  const onSubmit = (e) => {
    e.preventDefault();
    const text = body.trim();
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'send',
        client_msg_id: crypto.randomUUID(),
        author: author.trim() || 'anon',
        body: text,
      }),
    );
    setBody('');
  };

  return (
    <main>
      <h1>
        <span className="dot" style={{ background: DOT[status] }} title={status} />
        room / {roomId}
      </h1>
      <ul className="messages">
        {events.map((ev) => (
          <li key={ev.seq}>
            <strong>{ev.actor_id}</strong> {ev.payload.body}
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          placeholder="you"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          style={{ width: 100 }}
        />
        <input
          placeholder="message"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit">send</button>
      </form>
    </main>
  );
}
