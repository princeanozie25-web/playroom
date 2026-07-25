'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function Landing() {
  const router = useRouter();
  const [title, setTitle] = useState<string>('');
  const [slug, setSlug] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: slug.trim() || undefined, title: title.trim() || undefined }),
      });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      // POST /rooms returns the RoomRow shape; the client needs only `id`. RoomRow
      // is not exported from @playroom/shared (see FINDING in the closeout), so it
      // is typed locally here — an any→typed assignment, not a cast.
      const room: { id: string } = await res.json();
      router.push(`/r/${room.id}`);
    } catch (err) {
      alert(String(err));
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <h1>Playroom</h1>
      <p>Create a room, then open it in two browsers.</p>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8 }}>
        <input placeholder="room name" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input
          placeholder="slug (optional)"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          create room
        </button>
      </form>
    </main>
  );
}
