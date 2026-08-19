import type { Metadata } from 'next';
import Link from 'next/link';
import { ThemeToggle } from '../ThemeToggle';
import { JoinForm } from './JoinForm';

export const metadata: Metadata = { title: 'Join a Playroom room' };

// A server component wrapping one client form. The page itself renders nothing dynamic and holds no
// credential — everything secret happens in `app/api/join/route.ts`, server-side.
export default function JoinPage() {
  return (
    <main className="public-entry join-page">
      <div className="entry-shell">
        <nav className="entry-nav" aria-label="Join room navigation">
          <Link href="/">← Back to Playroom</Link>
          <div className="entry-nav__actions">
            <ThemeToggle showLabel={false} />
            <Link href="/start">Create a room</Link>
          </div>
        </nav>
        <JoinForm />
      </div>
    </main>
  );
}
