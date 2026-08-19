import type { Metadata } from 'next';
import Link from 'next/link';
import { ThemeToggle } from '../ThemeToggle';
import { CreateRoomForm } from './CreateRoomForm';

export const metadata: Metadata = { title: 'Create a Playroom room' };

export default function StartPage() {
  return (
    <main className="public-entry start-page">
      <div className="entry-shell">
        <nav className="entry-nav" aria-label="Create room navigation">
          <Link href="/">← Back to Playroom</Link>
          <div className="entry-nav__actions">
            <ThemeToggle showLabel={false} />
            <Link href="/join">Join a room</Link>
          </div>
        </nav>
        <CreateRoomForm />
      </div>
    </main>
  );
}
