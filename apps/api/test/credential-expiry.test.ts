import { afterAll, describe, expect, it } from 'vitest';
import { testPool } from './support.js';
import { authenticate, issueCredential } from '../src/credentials.js';

// CREDENTIALS THAT EXPIRE, BECAUSE STRANGERS ARE ABOUT TO HOLD THEM.
//
// Revocation was sufficient while every credential was mine or a test's: I know who holds those and
// I can revoke on purpose. A credential handed to someone outside this machine fails differently —
// NOBODY WILL REMEMBER TO REVOKE IT — so the expiry has to be a property of the row rather than of
// anyone's diligence.
//
// Expiry is tested with a NEGATIVE interval rather than a real wait. The interval is computed by the
// database and compared against the database's clock, so "issued two hours ago, expires an hour ago"
// exercises the identical comparison a real expiry will, and does it in a millisecond.

const pool = testPool();
const LABEL = 'expiry test';

afterAll(async () => {
  await pool.query('DELETE FROM member_credentials WHERE label = $1', [LABEL]);
  await pool.end();
});

describe('a credential with an expiry', () => {
  it('authenticates before it expires, and reports when that is', async () => {
    const cred = await issueCredential(pool, 'prince', LABEL, 4);
    expect(cred.expires_at, 'no expiry was recorded').not.toBeNull();
    // Roughly four hours out. Loose because the clock is the database's, not this process's —
    // asserting to the second would be asserting that two machines agree.
    const hours = (new Date(cred.expires_at as string).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(3.5);
    expect(hours).toBeLessThan(4.5);

    const result = await authenticate(pool, cred.token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.auth.member_id).toBe('prince');
  });

  it('STOPS WORKING once it has expired', async () => {
    const cred = await issueCredential(pool, 'prince', LABEL, -1);
    const result = await authenticate(pool, cred.token);
    expect(result.ok, 'an expired credential still authenticated').toBe(false);
  });

  it('and the refusal is INDISTINGUISHABLE from a token that never existed', async () => {
    // Deliberate. "That one expired" confirms the string was once real, which is a fact about our
    // records that a stranger holding a guessed token has not earned — the same rule the ticket
    // path follows: one refusal outward, the detail in the log.
    const expired = await issueCredential(pool, 'prince', LABEL, -1);
    const expiredResult = await authenticate(pool, expired.token);
    const nonsenseResult = await authenticate(pool, 'pk_this_was_never_a_credential');
    expect(expiredResult.ok).toBe(false);
    expect(nonsenseResult.ok).toBe(false);
    if (!expiredResult.ok && !nonsenseResult.ok) {
      expect(expiredResult.failure).toBe(nonsenseResult.failure);
      expect(expiredResult.failure).toBe('credential_invalid');
    }
  });

  it('a credential issued WITHOUT one is still long-lived — the harness is not broken', async () => {
    // The regression that matters. The capture harness and my own browser credential are
    // deliberately permanent; a default expiry here would have expired them mid-take, and the
    // failure would have looked like a socket problem.
    const cred = await issueCredential(pool, 'prince', LABEL);
    expect(cred.expires_at).toBeNull();
    const result = await authenticate(pool, cred.token);
    expect(result.ok).toBe(true);
  });
});

describe('every agent member can actually be reached', () => {
  it('has a route — the invariant, not the two rows that were missing', async () => {
    // WHAT THIS CAUGHT. Migration 009 seeded one hosted route per agent by SELECTing from
    // `members`, which was complete when it ran and could not cover the guest agents added in 017.
    // §6.2 says a member with no usable route puts its task in `input-required` and names the
    // route — so the guests would have failed by REFUSING CORRECTLY, with nothing broken, every
    // step reporting success, and no agent ever speaking.
    //
    // Asserted as the general invariant rather than as `ada` and `bo`, because the same trap is set
    // for the next agent anyone adds. Every migration that seeds by selecting from a table is a
    // snapshot, and the next row does not get retro-seeded.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT m.id FROM members AS m
        WHERE m.kind = 'agent'
          AND NOT EXISTS (
            SELECT 1 FROM routes AS r
             WHERE r.member_id = m.id AND r.status = 'available'
          )`,
    );
    expect(
      rows.map((r) => r.id),
      'agent members with no available route',
    ).toEqual([]);
  });

  it('and every agent has a mandate, so a refusal can name a signer', async () => {
    // The other half of the same class of gap. An agent with no mandate gets `limit: null` and no
    // co-sign rule, so asking it to merge would produce a refusal that names nobody — which is
    // precisely the thing the script asks a tester to look at.
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM members WHERE kind = 'agent' ORDER BY id",
    );
    const { mandateFor } = await import('../src/mandates.js');
    const missing = rows.map((r) => r.id).filter((id) => mandateFor(id) === undefined);
    expect(missing, 'agent members with no mandate document').toEqual([]);
  });
});
