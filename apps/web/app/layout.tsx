import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// A shared link used to render a bare "Playroom" with no card and no description. The description is the
// hero line in the join-form register; openGraph/twitter give a link preview a title and summary. The
// favicon comes from app/icon.svg (Next App Router picks it up); a full maskable PWA icon set from the
// three-bar mark is still a design asset to generate, tracked separately.
const DESCRIPTION =
  'People and AI agents work in one room. Every action is checked against a mandate a human signed, and everything that happens is on the record.';

export const metadata: Metadata = {
  title: { default: 'Playroom', template: '%s · Playroom' },
  description: DESCRIPTION,
  applicationName: 'Playroom',
  // S-PUSH: a web app must declare a manifest before a browser will install it or, on some
  // platforms, before it will deliver a push at all.
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: 'Playroom',
    description: DESCRIPTION,
    siteName: 'Playroom',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Playroom',
    description: DESCRIPTION,
  },
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

// Runs before paint for every route. Public and authenticated surfaces resolve their own token sets
// from the same preference, so navigation never flashes or lands in a mismatched colour scheme.
const playroomThemeScript = `(function(){try{var saved=localStorage.getItem('playroom-landing-theme');var dark=saved==='dark'||(saved!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.landingTheme=dark?'dark':'light'}catch(_){document.documentElement.dataset.landingTheme='light'}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: playroomThemeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
