'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export function CreateRoomForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // `/api/rooms`, not `/rooms`: the route handler adds the credential server-side.
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: slug.trim() || undefined, title: title.trim() || undefined }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          code?: string;
          error?: string;
          message?: string;
        };
        if (payload.code === 'credential_required' || payload.error === 'credential_required') {
          throw new Error(
            'This Playroom setup has no usable room-creation credential. Run the local bootstrap and try again.',
          );
        }
        throw new Error(payload.message ?? `The room could not be created (${res.status}).`);
      }
      // The API deliberately returns only `{ id }`; the client only needs it for this redirect.
      const room: { id: string } = await res.json();
      router.push(`/r/${room.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The room could not be created.');
      setBusy(false);
    }
  };

  return (
    <section className="start-card" aria-labelledby="create-room-title">
      <p className="start-eyebrow">New canonical room</p>
      <h1 id="create-room-title">Create a room</h1>
      <p className="start-lede">Give the room a clear name. You can also choose its URL slug.</p>
      <form
        className="start-form"
        onSubmit={onSubmit}
        aria-describedby={error === null ? undefined : 'create-room-error'}
      >
        <label htmlFor="room-title">Room name</label>
        <input
          id="room-title"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Product launch"
          autoComplete="off"
        />
        <label htmlFor="room-slug">
          Room slug <span>(optional)</span>
        </label>
        <p id="room-slug-help">Used in the room URL. Leave blank to let Playroom choose one.</p>
        <input
          id="room-slug"
          name="slug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="product-launch"
          autoComplete="off"
          aria-describedby="room-slug-help"
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Creating room…' : 'Create room'}
        </button>
        {error !== null && (
          <p id="create-room-error" className="start-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <p className="entry-alternative">
        Have an invitation code? <Link href="/join">Join a room</Link>.
      </p>
    </section>
  );
}
