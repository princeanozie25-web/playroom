import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * THE PER-PRINCIPAL CONTEXT STORE — private by construction, not by care (Bible §7.1, §13).
 *
 * ── THERE IS NO METHOD HERE THAT CAN NAME A FOREIGN PRINCIPAL ──
 *
 * That is the design, and it is aimed at one specific failure: a `WHERE principal_id = $1` that a
 * later refactor drops, reorders or parameterises wrongly. You cannot drop a clause that no query
 * contains. `Store`'s methods take no principal id — the principal is fixed by the transaction the
 * store lives inside, before any statement runs, and the store object cannot outlive it.
 *
 * The database is the second half. Every statement runs as `playroom_context`, a role with
 * NOBYPASSRLS, under a policy keyed to a session variable — so even a hand-written query naming
 * another principal returns zero rows. Measured on this deployment, and written up in migration 015
 * because the first attempt (a policy alone) enforced nothing: Neon's owner role has BYPASSRLS.
 *
 * Two mechanisms, and neither is decorative. The structure stops the query being written; the
 * database stops it mattering if someone writes it anyway.
 */

export interface ContextItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** A summary is the same context, shorter. Null when nothing has summarised this item. */
  summary: string | null;
  /** Present only if something has embedded the item. Nothing does yet. */
  embedding: number[] | null;
  created_at: string;
}

/**
 * A store bound to ONE principal for the life of one transaction.
 *
 * Deliberately narrow. `items()` and `add()` are what assembly and seeding need; there is no
 * `itemsFor(principalId)`, no `all()`, and no escape hatch that takes a query string. A method that
 * could express a foreign read is a method someone will eventually call.
 */
export interface Store {
  items(limit?: number): Promise<ContextItem[]>;
  add(item: {
    kind: string;
    title: string;
    body: string;
    summary?: string | null;
    embedding?: number[] | null;
  }): Promise<ContextItem>;
  /** Which principal this store is bound to. Readable, and not settable. */
  readonly principal: string;
}

/** The role the transaction assumes. NOBYPASSRLS is the only property that matters. */
const RESTRICTED_ROLE = 'playroom_context';

function rowToItem(row: {
  id: string;
  kind: string;
  title: string;
  body: string;
  summary: string | null;
  embedding: number[] | null;
  created_at: Date | string;
}): ContextItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    summary: row.summary,
    embedding: row.embedding,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function storeFor(client: PoolClient, principalId: string): Store {
  return {
    principal: principalId,
    async items(limit = 20): Promise<ContextItem[]> {
      // NO `WHERE principal_id` CLAUSE, AND THAT IS THE POINT. The policy supplies it, so this
      // query cannot be wrong about scope — there is nothing here to get wrong.
      const { rows } = await client.query(
        `SELECT id, kind, title, body, summary, embedding, created_at
           FROM principal_context
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit],
      );
      return rows.map(rowToItem);
    },
    async add(item): Promise<ContextItem> {
      // `principal_id` IS written, because a row has to carry one — and the policy's WITH CHECK
      // refuses an insert that names anyone else, so this cannot be used to plant a row in a
      // foreign store even deliberately.
      const { rows } = await client.query(
        `INSERT INTO principal_context (id, principal_id, kind, title, body, summary, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, kind, title, body, summary, embedding, created_at`,
        [
          `ctx_${randomBytes(8).toString('hex')}`,
          principalId,
          item.kind,
          item.title,
          item.body,
          item.summary ?? null,
          item.embedding ?? null,
        ],
      );
      return rowToItem(rows[0]);
    },
  };
}

/**
 * Open a principal's store for the duration of one callback.
 *
 * The only way to reach `principal_context`. Everything about the isolation is set up before the
 * callback runs and torn down when it returns:
 *
 *   BEGIN
 *   SET LOCAL ROLE playroom_context          -- drop BYPASSRLS for this transaction
 *   SET LOCAL playroom.principal_id = ...    -- the policy's parameter
 *   ...the callback...
 *   COMMIT                                   -- role and setting both end here
 *
 * `SET LOCAL` rather than `SET`, and it is not a style preference: `DATABASE_URL` is Neon's POOLED
 * endpoint, so a session-scoped setting would leak this principal's identity to whichever request
 * borrowed the connection next. Verified that `current_user` is back to the owner after COMMIT.
 *
 * REFUSES AN EMPTY PRINCIPAL rather than opening an unscoped store. The policy already fails closed
 * on an unset variable, so this is the second line: a caller passing `''` gets an error naming the
 * mistake instead of a store that silently reads nothing and looks like an empty account.
 */
export async function withPrincipalStore<T>(
  pool: Pool,
  principalId: string,
  fn: (store: Store) => Promise<T>,
): Promise<T> {
  if (!principalId || principalId.trim() === '') {
    throw new Error(
      'withPrincipalStore requires a principal id — an unscoped store is not a thing',
    );
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The order matters: assume the restricted role FIRST, so that even the set_config below runs
    // without BYPASSRLS. Nothing between BEGIN and here touches the table.
    await client.query(`SET LOCAL ROLE ${RESTRICTED_ROLE}`);
    await client.query('SELECT set_config($1, $2, true)', ['playroom.principal_id', principalId]);
    const result = await fn(storeFor(client, principalId));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* the connection may already be unusable; the release below still returns it */
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Prove the isolation is LIVE, against the real connection.
 *
 * Returns the role and BYPASSRLS state the store actually runs under. The isolation test asserts on
 * this rather than trusting the migration to have been applied — because a policy that EXISTS and a
 * policy that APPLIES are different facts, and this deployment is one where they differed: the
 * owner role has BYPASSRLS, so the first attempt enforced nothing while looking correct.
 */
export async function isolationState(
  pool: Pool,
  principalId: string,
): Promise<{ current_user: string; bypassrls: boolean; setting: string | null }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${RESTRICTED_ROLE}`);
    await client.query('SELECT set_config($1, $2, true)', ['playroom.principal_id', principalId]);
    const { rows } = await client.query<{
      current_user: string;
      bypassrls: boolean;
      setting: string | null;
    }>(
      `SELECT current_user,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
              current_setting('playroom.principal_id', true) AS setting`,
    );
    await client.query('COMMIT');
    return rows[0];
  } finally {
    client.release();
  }
}

/**
 * THE ADVERSARIAL READ: what a caller sees if they try to name a foreign principal themselves.
 *
 * Exists only for the isolation test, and it exists because the test has to run the attack rather
 * than describe it. It writes the `WHERE principal_id = $1` that `Store` deliberately cannot express
 * — inside the same scoped transaction the store uses — so the assertion is about what the DATABASE
 * does with a hostile query, not about what our own query happens to omit.
 */
export async function attemptForeignRead(
  pool: Pool,
  asPrincipal: string,
  targetPrincipal: string,
): Promise<{ rows: number; titles: string[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${RESTRICTED_ROLE}`);
    await client.query('SELECT set_config($1, $2, true)', ['playroom.principal_id', asPrincipal]);
    const { rows } = await client.query<{ title: string; summary: string | null }>(
      // Every column that could carry the context, including the two derived forms.
      'SELECT title, summary FROM principal_context WHERE principal_id = $1',
      [targetPrincipal],
    );
    await client.query('COMMIT');
    return { rows: rows.length, titles: rows.map((r) => r.title) };
  } finally {
    client.release();
  }
}
