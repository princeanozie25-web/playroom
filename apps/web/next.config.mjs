const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const nextConfig = {
  // Proxy same-origin POST /rooms to the api so the browser avoids a cross-origin
  // CORS preflight. The room WebSocket connects to the api directly (WS is exempt).
  async rewrites() {
    return [{ source: '/rooms', destination: `${API_URL}/rooms` }];
  },

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
