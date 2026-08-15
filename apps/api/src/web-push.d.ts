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
  /**
   * A DEFAULT EXPORT, and that is not a style choice — it is what the package actually is.
   *
   * `web-push` is CommonJS. Under Node's ESM loader a CJS module has exactly one export, the
   * default; named imports are synthesised only when Node's static analysis can see the assignments,
   * and it cannot see this package's. Vitest's transform DOES synthesise them, so
   * `import { sendNotification } from 'web-push'` passed the entire test suite and then crash-looped
   * the deployed api at boot: "The requested module 'web-push' does not provide an export named
   * 'sendNotification'". The fix is to import what is there.
   */
  interface WebPush {
    /** Identify this application server to the vendor, and sign with the VAPID keypair. Once. */
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    /** Encrypt and POST one payload to one endpoint. Rejects with a WebPushError on a refusal. */
    sendNotification(
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
      payload: string,
      options?: { TTL?: number; urgency?: string },
    ): Promise<{ statusCode: number }>;
    /** A vendor refusal, carrying the status code the send path branches on (404/410 = gone). */
    WebPushError: new (...args: never[]) => Error & { statusCode: number };
  }
  const webpush: WebPush;
  export default webpush;
}
