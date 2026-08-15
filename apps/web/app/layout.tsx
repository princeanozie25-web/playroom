import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Playroom',
  // S-PUSH: a web app must declare a manifest before a browser will install it or, on some
  // platforms, before it will deliver a push at all. It carries no icons yet — an icon set is
  // design work this slice has no business inventing, and an empty array is honest about that.
  manifest: '/manifest.webmanifest',
};

/**
 * THE SINGLE BIGGEST MOBILE BREAK, AND IT WAS ONE LINE MISSING (S-LIVE).
 *
 * With no viewport meta, mobile browsers render into a virtual ~980px window and scale the result
 * down. Everything "works" and everything is unreadable — the room would have looked like a
 * screenshot of a desktop rather than a broken layout, which is the kind of failure a tester reports
 * as "it's a bit small" instead of as a bug.
 *
 * `initialScale: 1` and no `maximumScale`: pinch-zoom stays available. Locking it out is a common
 * way to make an app feel native and it takes zoom away from anyone who needs it to read.
 *
 * `viewportFit: 'cover'` so the layout can reach under a notch, paired with the safe-area insets in
 * globals.css — without both, one of them is worse than neither.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
