import type { Metadata } from 'next';
import { JoinForm } from './JoinForm';

export const metadata: Metadata = { title: 'Join a Playroom room' };

// A server component wrapping one client form. The page itself renders nothing dynamic and holds no
// credential — everything secret happens in `app/api/join/route.ts`, server-side.
export default function JoinPage() {
  return (
    <main className="join-page">
      <JoinForm />
    </main>
  );
}
