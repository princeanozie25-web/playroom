'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { OrderView } from '../../../orders';
import type { RosterMember } from '../../../roster';
import { MemberName } from '../../../MemberChip';
import { Panel, PanelPresence } from '../../../Panel';
import { HOOK, pr } from '../../../hooks';

// THE LOOPS SCREEN (S-UI3) — standing orders as a form, not a bash script.
//
// It renders ONLY from records and events (the orders the API returned) and every write goes through
// the existing command via a same-origin route handler — the form adds no enforcement and bypasses
// none. Authorisation is VISIBLE TRUTH, not a hidden guard: a non-creator sees pause and nothing else,
// an agent (who never reaches here, but the render is honest anyway) sees nothing doable. A control
// that is shown is a control the server will honour; there is no third state, no toggle that lies.

const TRIGGER_EVENT = 'agent.turn.completed'; // the only trigger type that exists — S-LOOP fires on it

const STATUS_WORDS: Record<string, string> = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  LIMIT_REACHED: 'limit reached',
};

function fired(iso: string | null): string {
  if (!iso) return 'never fired';
  const d = new Date(iso);
  return `last fired ${d.toLocaleString()}`;
}

export function LoopsScreen({
  roomId,
  roster,
  orders,
  viewer,
}: {
  roomId: string;
  roster: RosterMember[];
  orders: OrderView[];
  viewer: { member_id: string; kind: 'human' | 'agent' };
}) {
  const router = useRouter();
  const rosterMap = new Map(roster.map((m) => [m.id, m]));
  const agents = roster.filter((m) => m.kind === 'agent');
  const isHuman = viewer.kind === 'human';

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function mutate(url: string, method: string, body: unknown): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        setError(payload.message ?? `that did not work (${res.status})`);
        return;
      }
      setEditing(null);
      router.refresh(); // re-read the server component so the list reflects the record
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="loops" {...pr(HOOK.loops)}>
      <header className="loops-head">
        <Link className="loops-back" href={`/r/${roomId}`} {...pr(HOOK.loopsBack)}>
          ← back to the room
        </Link>
        <h1>Standing orders</h1>
        <p className="loops-sub">
          Recurring work you authorise: when an agent finishes a turn, summon another. Set how often
          it checks in and when it stops. It causes; it does not grant — every turn it fires is
          still governed.
        </p>
      </header>

      {error && (
        <p className="loops-error" role="alert" {...pr(HOOK.loopError)}>
          {error}
        </p>
      )}

      {/* THE LIST — rendered from records and events, one row per order. */}
      {orders.length === 0 ? (
        <p className="loops-empty" {...pr(HOOK.loopsEmpty)}>
          No standing orders yet. Create one below to set up a loop.
        </p>
      ) : (
        <ul className="loop-list">
          {orders.map((o) => {
            const mine = isHuman && viewer.member_id === o.creator_member_id;
            const terminal = ['REVOKED', 'EXPIRED', 'LIMIT_REACHED'].includes(o.status);
            return (
              <Panel
                as="li"
                className="loop-row"
                key={o.id}
                hook={HOOK.loopRow}
                data-pr-status={o.status}
              >
                <div className="loop-row-head">
                  <span className="loop-status" {...pr(HOOK.loopStatus)}>
                    {STATUS_WORDS[o.status] ?? o.status}
                  </span>
                  <span className="loop-wire">
                    when{' '}
                    <MemberName
                      member={rosterMap.get(o.trigger_member_id)}
                      name={o.trigger_member_id}
                    />{' '}
                    finishes, summon{' '}
                    <MemberName
                      member={rosterMap.get(o.action_member_id)}
                      name={o.action_member_id}
                    />
                  </span>
                </div>
                <div className="loop-row-meta">
                  <span className="loop-cycles" {...pr(HOOK.loopCycles)}>
                    {o.cycle_count} cycle{o.cycle_count === 1 ? '' : 's'}
                  </span>
                  <span className="loop-terms">
                    dial {o.max_unattended_cycles}
                    {o.max_cycles !== null ? ` · cap ${o.max_cycles}` : ''}
                    {o.expires_at
                      ? ` · expires ${new Date(o.expires_at).toLocaleDateString()}`
                      : ''}
                  </span>
                  <span className="loop-fired" {...pr(HOOK.loopFired)}>
                    {fired(o.last_fired)}
                  </span>
                </div>
                {o.pause_reason && o.status !== 'ACTIVE' && (
                  <p className="loop-reason" {...pr(HOOK.loopReason)}>
                    {o.pause_reason}
                  </p>
                )}

                {/* CONTROLS AS VISIBLE TRUTH. Pause: any human, on an active order. Resume/revoke/edit:
                    the creator only — a non-creator simply does not see them. An agent sees none. */}
                {isHuman && (
                  <div className="loop-controls">
                    {o.status === 'ACTIVE' && (
                      <button
                        type="button"
                        disabled={busy}
                        {...pr(HOOK.loopPause)}
                        onClick={() =>
                          mutate(`/api/rooms/${roomId}/orders/${o.id}/control`, 'POST', {
                            op: 'pause',
                          })
                        }
                      >
                        pause
                      </button>
                    )}
                    {mine && o.status === 'PAUSED' && (
                      <button
                        type="button"
                        disabled={busy}
                        {...pr(HOOK.loopResume)}
                        onClick={() =>
                          mutate(`/api/rooms/${roomId}/orders/${o.id}/control`, 'POST', {
                            op: 'resume',
                          })
                        }
                      >
                        resume
                      </button>
                    )}
                    {mine && !terminal && (
                      <button
                        type="button"
                        disabled={busy}
                        {...pr(HOOK.loopRevoke)}
                        onClick={() =>
                          mutate(`/api/rooms/${roomId}/orders/${o.id}/control`, 'POST', {
                            op: 'revoke',
                          })
                        }
                      >
                        revoke
                      </button>
                    )}
                    {mine && !terminal && (
                      <button
                        type="button"
                        {...pr(HOOK.loopEdit)}
                        onClick={() => setEditing(editing === o.id ? null : o.id)}
                      >
                        {editing === o.id ? 'cancel' : 'edit'}
                      </button>
                    )}
                  </div>
                )}

                {/* PanelPresence (SHELL-B3): the edit form is the loops screen's one unmounting
                    Panel — its enter/exit play here, and the row's own layout animation eases the
                    height the form takes and vacates. */}
                <PanelPresence show={editing === o.id && mine && !terminal}>
                  <EditForm roomId={roomId} order={o} busy={busy} onSave={mutate} />
                </PanelPresence>
              </Panel>
            );
          })}
        </ul>
      )}

      {/* THE CREATE FORM — any human may author an order; the server enforces human-only, this adds none. */}
      {isHuman && <CreateForm roomId={roomId} agents={agents} busy={busy} onCreate={mutate} />}
    </div>
  );
}

function CreateForm({
  roomId,
  agents,
  busy,
  onCreate,
}: {
  roomId: string;
  agents: RosterMember[];
  busy: boolean;
  onCreate: (url: string, method: string, body: unknown) => Promise<void>;
}) {
  const first = agents[0]?.id ?? '';
  const second = agents[1]?.id ?? first;
  const [trigger, setTrigger] = useState(first);
  const [action, setAction] = useState(second);
  const [dial, setDial] = useState(3);
  const [cap, setCap] = useState('');
  const [expiry, setExpiry] = useState('');

  return (
    <Panel
      as="form"
      className="loop-create"
      hook={HOOK.loopCreate}
      onSubmit={(e) => {
        e.preventDefault();
        void onCreate(`/api/rooms/${roomId}/orders`, 'POST', {
          trigger_event_type: TRIGGER_EVENT,
          trigger_member: trigger,
          action_member: action,
          max_unattended_cycles: dial,
          max_cycles: cap.trim() === '' ? null : Number(cap),
          expires_at: expiry.trim() === '' ? null : new Date(expiry).toISOString(),
        });
      }}
    >
      <h2>New standing order</h2>
      <label>
        when this agent finishes a turn
        <select
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          {...pr(HOOK.loopTriggerMember)}
        >
          {agents.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name}
            </option>
          ))}
        </select>
      </label>
      <label>
        summon this agent
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          {...pr(HOOK.loopActionMember)}
        >
          {agents.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name}
            </option>
          ))}
        </select>
      </label>
      <label>
        check in after this many cycles (the attendance dial)
        <input
          type="number"
          min={1}
          value={dial}
          onChange={(e) => setDial(Number(e.target.value))}
          {...pr(HOOK.loopDial)}
        />
      </label>
      <label>
        stop after this many cycles (optional)
        <input
          type="number"
          min={1}
          value={cap}
          placeholder="no limit"
          onChange={(e) => setCap(e.target.value)}
          {...pr(HOOK.loopCap)}
        />
      </label>
      <label>
        expires (optional)
        <input
          type="datetime-local"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          {...pr(HOOK.loopExpiry)}
        />
      </label>
      <button type="submit" disabled={busy || !trigger || !action} {...pr(HOOK.loopSubmit)}>
        create standing order
      </button>
    </Panel>
  );
}

function EditForm({
  roomId,
  order,
  busy,
  onSave,
}: {
  roomId: string;
  order: OrderView;
  busy: boolean;
  onSave: (url: string, method: string, body: unknown) => Promise<void>;
}) {
  const [dial, setDial] = useState(order.max_unattended_cycles);
  const [cap, setCap] = useState(order.max_cycles === null ? '' : String(order.max_cycles));

  return (
    <Panel
      as="form"
      className="loop-edit-form"
      hook={HOOK.loopEditForm}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(`/api/rooms/${roomId}/orders/${order.id}`, 'PATCH', {
          max_unattended_cycles: dial,
          max_cycles: cap.trim() === '' ? null : Number(cap),
          expires_at: order.expires_at, // expiry edited elsewhere; keep it here
        });
      }}
    >
      <label>
        dial
        <input
          type="number"
          min={1}
          value={dial}
          onChange={(e) => setDial(Number(e.target.value))}
        />
      </label>
      <label>
        cap
        <input
          type="number"
          min={1}
          value={cap}
          placeholder="no limit"
          onChange={(e) => setCap(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy} {...pr(HOOK.loopEditSave)}>
        save — effective next cycle
      </button>
    </Panel>
  );
}
