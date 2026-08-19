'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { AppBrand } from './AppBrand';
import { ThemeToggle } from './ThemeToggle';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="system-page">
      <header className="system-page__topbar">
        <AppBrand />
        <ThemeToggle showLabel={false} />
      </header>
      <section className="system-page__content" aria-labelledby="error-title">
        <p className="system-page__code system-page__code--error">Application error</p>
        <h1 id="error-title">This surface could not be opened.</h1>
        <p>
          The underlying action has not been retried automatically. Try loading the surface again,
          or return to the Playroom front door.
        </p>
        <div className="system-page__actions">
          <button className="system-action system-action--primary" type="button" onClick={reset}>
            Try again
          </button>
          <Link className="system-action" href="/">
            Back to Playroom
          </Link>
        </div>
      </section>
    </main>
  );
}
