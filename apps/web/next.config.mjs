// SUI-N1: `next dev` and `next start` shared apps/web/.next, so alternating between
// them destroyed the other's build — it produced a 500 on a stale chunk once and
// "Could not find a production build" once, both with no camera running. Separate
// directories mean a production build survives a dev session and vice versa, which
// matters because scripts/demo-capture.ts refuses to film the dev server (A4-F6) and
// the two are now routinely used in the same sitting.
const distDir = process.env.NODE_ENV === 'production' ? '.next-prod' : '.next-dev';

const nextConfig = {
  distDir,

  // NO REWRITE FOR /rooms ANY MORE (S1.3c). It proxied the browser's create straight through to
  // the api to avoid a CORS preflight, and a rewrite cannot add a header — so the moment
  // `POST /rooms` required a credential (RT-002), it had to become a route handler that holds one
  // server-side: `app/api/rooms/route.ts`, alongside the ticket counter. Same origin, same
  // absence of a preflight, and the credential never reaches the browser.
  //
  // The room WebSocket still connects to the api directly, with a single-use ticket.

  // @playroom/shared became a real dependency of this app in S-UI (ruling on F1-N1:
  // a close code defined in two places will drift, and a runtime import from a
  // devDependency breaks on a pruned production install). It ships raw TypeScript
  // from src/, so Next must compile it rather than treat it as a built package.
  transpilePackages: ['@playroom/shared', '@playroom/fabric'],

  webpack(config) {
    // The package uses NodeNext specifiers — `export * from './protocol.js'` pointing
    // at protocol.ts. Node resolves that; webpack does not, so it is taught the same
    // mapping. Without this the app fails to build the moment it imports a runtime
    // value rather than only a type.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
