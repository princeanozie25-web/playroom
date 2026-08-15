'use client';

import { useCallback, useEffect, useState } from 'react';
import { HOOK, pr } from './hooks';

// THE NOTIFICATION CONTROL (S-PUSH) — asked for, never sprung.
//
// ── THE PROMPT IS NOT SHOWN ON LOAD, AND THAT IS THE WHOLE DESIGN ────────────────────
//
// A browser gives an origin exactly one chance to ask: a permission prompt fired at page load gets
// dismissed by reflex, and a dismissal on some platforms is permanent for that origin. So nothing
// here touches `Notification.requestPermission` until a person has clicked a control that says what
// it will do. The state is visible before the choice, not after it.
//
// ── OFF ACTUALLY DELETES ─────────────────────────────────────────────────────────────
//
// Turning it off unsubscribes at the browser AND deletes the row. A toggle that only stops sending
// while the address lingers is a control that lies about itself, and the row is the thing that
// decides whether a phone gets woken.
//
// The browser permission itself is NOT ours to revoke — only the person can, in browser settings —
// so the copy says which half this switch owns rather than implying it owns both.

type State =
  | { kind: 'checking' }
  | { kind: 'unsupported' }
  | { kind: 'unconfigured' }
  | { kind: 'off' }
  | { kind: 'on'; devices: number }
  | { kind: 'blocked' }
  | { kind: 'error'; message: string };

/** base64url → Uint8Array, which is the only shape `pushManager.subscribe` accepts for a VAPID key. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  // An explicitly-backed ArrayBuffer, not the default: `pushManager.subscribe` takes a BufferSource
  // over a plain ArrayBuffer, and the default Uint8Array type admits a SharedArrayBuffer it will not.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushControl() {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [busy, setBusy] = useState(false);

  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  // WHAT THE STATE IS READ FROM: the browser for the subscription, the server for the count. Both,
  // because they can disagree — a row can outlive a browser's subscription and vice versa, and a
  // control that reads only one of them will eventually claim something untrue.
  const refresh = useCallback(async () => {
    if (!supported) return setState({ kind: 'unsupported' });
    if (Notification.permission === 'denied') return setState({ kind: 'blocked' });
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (!sub) return setState({ kind: 'off' });
      const res = await fetch('/api/push/state');
      const body = (await res.json().catch(() => ({}))) as { devices?: number };
      setState({ kind: 'on', devices: body.devices ?? 1 });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    }
  }, [supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const turnOn = useCallback(async () => {
    setBusy(true);
    try {
      const keyRes = await fetch('/api/push/key');
      if (!keyRes.ok) return setState({ kind: 'unconfigured' });
      const { key } = (await keyRes.json()) as { key: string };

      // The registration is scoped to the origin root so the worker can be woken for any room.
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      // ASKED FOR, HERE, after a click and never before it.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setBusy(false);
        return setState({ kind: permission === 'denied' ? 'blocked' : 'off' });
      }

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, // every push shows something; no silent background wakes
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setState({ kind: 'error', message: body.message ?? 'the server refused the subscription' });
      } else {
        const body = (await res.json()) as { devices?: number };
        setState({ kind: 'on', devices: body.devices ?? 1 });
      }
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, []);

  const turnOff = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        // The server first: if the row survives a browser-side unsubscribe, this phone keeps being
        // sent to and nothing will ever tell us it is gone.
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState({ kind: 'off' });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, []);

  if (state.kind === 'checking') return null;

  return (
    <div className="push-control" {...pr(HOOK.pushControl)}>
      {state.kind === 'unsupported' && (
        <span className="push-state">this browser cannot receive notifications</span>
      )}
      {state.kind === 'unconfigured' && (
        <span className="push-state">notifications are not configured on this deployment</span>
      )}
      {state.kind === 'blocked' && (
        <span className="push-state">
          notifications are blocked for this site — turn them back on in your browser settings
        </span>
      )}
      {state.kind === 'error' && <span className="push-state">notifications: {state.message}</span>}
      {state.kind === 'off' && (
        <button type="button" disabled={busy} onClick={turnOn} {...pr(HOOK.pushToggle)}>
          notify me when something needs me
        </button>
      )}
      {state.kind === 'on' && (
        <>
          <span className="push-state" {...pr(HOOK.pushState)}>
            on · {state.devices} {state.devices === 1 ? 'device' : 'devices'}
          </span>
          <button type="button" disabled={busy} onClick={turnOff} {...pr(HOOK.pushToggle)}>
            turn off
          </button>
        </>
      )}
    </div>
  );
}
