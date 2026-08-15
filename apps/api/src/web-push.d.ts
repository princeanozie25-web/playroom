/**
 * THE BOUNDED SURFACE OF `web-push` (S-PUSH, R1).
 *
 * The package ships no types. Rather than pull `@types/web-push` — which declares the whole library,
 * including a GCM legacy path, a key generator and a request-details builder this tier must never
 * touch — the surface is declared HERE, and it is exactly the three things this system is allowed to
 * use. Anything else is a compile error rather than a code-review question.
 *
 * R1's ruling in a file: the library does the VAPID JWT and the RFC 8291 encryption, because those
 * fail SILENTLY when hand-rolled — a wrong ECDH step delivers nothing, or delivers something
 * readable, and both look like success from the sending side. Everything else — the allowlist, the
 * send record, the throttle, the refusal semantics — is Playroom's own code above it. The governance
 * is not delegated to a dependency; the dependency only encrypts and signs.
 */
declare module 'web-push' {
  /** Identify this application server to the vendor, and sign with the VAPID keypair. Called once. */
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  /** Encrypt and POST one payload to one endpoint. Rejects with a WebPushError on a vendor refusal. */
  export function sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options?: { TTL?: number; urgency?: string },
  ): Promise<{ statusCode: number }>;

  /** A vendor refusal, carrying the status code the send path branches on (404/410 = gone). */
  export class WebPushError extends Error {
    statusCode: number;
    body: string;
  }
}
