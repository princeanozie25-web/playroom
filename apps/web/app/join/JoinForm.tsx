'use client';

import { useState, type FormEvent } from 'react';
import { HOOK, pr } from '../hooks';

// THE FIRST SCREEN A TESTER SEES, AND THE ONLY ONE BEFORE THE ROOM.
//
// Two fields. A code somebody sent them, and their first name. No account, no password, no email —
// there is nothing to recover and nothing to verify, so asking for any of it would be collecting
// personal data to no purpose.
//
// NO GITHUB VOCABULARY ANYWHERE ON THIS SCREEN. Not "repository", not "pull request", not "merge",
// not "commit". A tester who has never seen a terminal has to get from a text message to a working
// room without meeting a single word that assumes they are a developer.
//
// The name is asked for because EVERY ACT IN THE ROOM IS ATTRIBUTED, and an unattributed act is the
// one thing this product cannot have. The field label says so in those terms rather than "required".

export function JoinForm() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, display_name: name }),
      });
      const body = (await res.json()) as { room_id?: string; error?: string };
      if (!res.ok || !body.room_id) {
        setError(body.error ?? 'That did not work.');
        setBusy(false);
        return;
      }
      // A FULL NAVIGATION, not a client-side push. The credential arrived as a cookie on this
      // response, and the room is a server component that has to be rendered with it present.
      window.location.href = `/r/${body.room_id}?welcome=1`;
    } catch {
      setError('Could not reach the room. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <form className="join" onSubmit={submit} {...pr(HOOK.join)}>
      <h1 className="join-title">Join the room</h1>
      <p className="join-lede">
        Someone sent you a short code. Enter it below with your first name, and you are in.
      </p>

      <label className="join-label" htmlFor="join-code">
        Your code
      </label>
      <input
        id="join-code"
        className="join-input join-code"
        {...pr(HOOK.joinCode)}
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="PLAY-1234"
        // `characters` not `words`: a code is not a sentence, and iOS capitalising the first letter
        // only is worse than not capitalising at all. `off` on autocorrect so a phone does not
        // helpfully turn a code into a word.
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        // Not `type="number"` despite being short — the alphabet is letters and digits, and a
        // numeric keypad would make half of it untypeable.
        inputMode="text"
        autoComplete="off"
        required
      />

      <label className="join-label" htmlFor="join-name">
        Your first name
      </label>
      <p className="join-hint">
        Shown next to everything you do here, so people can see who did what.
      </p>
      <input
        id="join-name"
        className="join-input"
        {...pr(HOOK.joinName)}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Amara"
        autoCapitalize="words"
        autoComplete="given-name"
        maxLength={24}
        required
      />

      <button className="join-submit" {...pr(HOOK.joinSubmit)} type="submit" disabled={busy}>
        {busy ? 'Letting you in…' : 'Enter the room'}
      </button>

      {error !== null && (
        <p className="join-error" {...pr(HOOK.joinError)} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
