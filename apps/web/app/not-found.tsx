import Link from 'next/link';
import { AppBrand } from './AppBrand';
import { ThemeToggle } from './ThemeToggle';

export default function NotFound() {
  return (
    <main className="system-page">
      <header className="system-page__topbar">
        <AppBrand />
        <ThemeToggle showLabel={false} />
      </header>
      <section className="system-page__content" aria-labelledby="not-found-title">
        <p className="system-page__code">404 · Route not found</p>
        <h1 id="not-found-title">This room surface does not exist.</h1>
        <p>
          Return to the public front door, create a new room, or use an invitation to join an
          existing one.
        </p>
        <div className="system-page__actions">
          <Link className="system-action system-action--primary" href="/">
            Back to Playroom
          </Link>
          <Link className="system-action" href="/start">
            Create a room
          </Link>
          <Link className="system-action" href="/join">
            Join a room
          </Link>
        </div>
      </section>
    </main>
  );
}
