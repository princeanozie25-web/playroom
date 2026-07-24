const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const nextConfig = {
  // Proxy same-origin POST /rooms to the api so the browser avoids a cross-origin
  // CORS preflight. The room WebSocket connects to the api directly (WS is exempt).
  async rewrites() {
    return [{ source: '/rooms', destination: `${API_URL}/rooms` }];
  },
};

export default nextConfig;
