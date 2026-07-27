-- 015_principal_context: a private store per principal, isolated by the DATABASE (S1.5).
--
-- Additive. One role, one table, one policy.
--
-- Bible §7.1 is the law this carries: assembly reaches common ground and the summoned member's own
-- principal store, and NOTHING ELSE. Foreign private stores are unreachable BY CONSTRUCTION —
-- "a prompt instruction telling an agent to ignore foreign context is not a control if the data is
-- already in the window."
--
-- ── WHY ROW-LEVEL SECURITY, AND WHY IT NEARLY DID NOT WORK ─────────────────────────────
--
-- Bible §13 wants isolation enforced by the database rather than by discipline. The obvious shape
-- is RLS with a policy on a session variable, and MEASURED ON THIS DEPLOYMENT IT DID NOTHING:
--
--   current_user: neondb_owner | superuser: false | BYPASSRLS: true
--   rows visible as principal:prince, with the policy enabled and FORCEd: BOTH of them
--
-- Neon hands out an owner role with BYPASSRLS, and BYPASSRLS beats both ENABLE and FORCE. A
-- migration that stopped at `CREATE POLICY` would have shipped a table that LOOKS isolated, passes
-- a casual read of the schema, and enforces nothing — the exact shape of a field that looks like
-- authority, which this project has now found five times.
--
-- ── WHAT ACTUALLY ENFORCES IT: A ROLE THAT CANNOT BYPASS ───────────────────────────────
--
-- `playroom_context` has NOBYPASSRLS. Every read of this table happens inside a transaction that
-- does `SET LOCAL ROLE playroom_context` first, so `current_user` for the duration is a role the
-- policy applies to. Measured, same deployment:
--
--   inside tx  current_user: playroom_context | BYPASSRLS: false
--   rows visible as principal:prince            a          (jerry's row absent)
--   SELECT ... WHERE principal_id='principal:jerry'  →  0 ROWS
--   with the setting empty                          →  0 ROWS
--   after COMMIT current_user: neondb_owner
--
-- THE THIRD LINE IS THE POINT. An explicit foreign WHERE clause returns nothing: the database
-- refuses the read rather than trusting the query to be correctly scoped. That is what makes this
-- structural instead of conditional — the failure mode being designed out is a
-- `WHERE principal_id = $1` that a future refactor drops, and here dropping it changes nothing.
--
-- THE FOURTH LINE IS THE SECOND HALF. No principal set means NO context, not ALL context: an
-- unset session variable fails closed, so a caller that forgets to scope gets an empty store
-- rather than everyone's.
--
-- `SET LOCAL` and `SET LOCAL ROLE` both end at COMMIT, which matters because `DATABASE_URL` is
-- Neon's POOLED endpoint — a plain `SET` would leak the principal to whoever borrowed the
-- connection next. Verified: `current_user` is back to the owner after COMMIT.
--
-- ── THE THREE INDIRECT PATHS ARE COLUMNS IN THIS TABLE, DELIBERATELY ───────────────────
--
-- §7.1's parenthetical is that a foreign store must be unreachable "including through summaries,
-- embeddings and promoted items". A summary of Jerry's note is still Jerry's context, and so is a
-- vector derived from it. If either lived in its own table, or in a cache, or on the room, it
-- would be governed by whatever that place enforces — which is usually nothing.
--
-- So the derived forms live in the SAME ROW as what they derive from, under the SAME policy: one
-- boundary, and no second place to remember. A summary cannot be read without the note being
-- readable, because they are the same row.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'playroom_context') THEN
    -- NOLOGIN: nothing connects AS this role. It is assumed, per transaction, by a connection that
    -- has already authenticated — so there is no second credential and no second connection string
    -- to leak. NOBYPASSRLS is the whole reason it exists.
    CREATE ROLE playroom_context NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS principal_context (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  -- What kind of thing this is. Open string, per the taxonomy convention.
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  -- A SUMMARY IS NOT A SAFER COPY. It is the same context, shorter, and it sits here so that no
  -- reader can reach it without reaching the row it summarises. Null when nothing has summarised
  -- this item — never a truncation of `body` pretending to be a summary.
  summary      TEXT,
  -- AN EMBEDDING IS NOT ANONYMOUS EITHER. A vector derived from private text leaks that text to
  -- anyone who can compare vectors, so it lives under the same policy. `double precision[]` rather
  -- than pgvector: no extension to depend on, and the isolation question is unaffected by the
  -- index type. Null until something embeds the item; nothing does yet, and the column exists so
  -- that when something does, there is no decision left to get wrong.
  embedding    DOUBLE PRECISION[],
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS principal_context_principal_idx
  ON principal_context (principal_id, created_at);

ALTER TABLE principal_context ENABLE ROW LEVEL SECURITY;
-- FORCE so the policy also applies to the table's owner. It is not sufficient on its own — see the
-- measurement above — and it is kept because it closes the case where the app is ever run by a role
-- that lacks BYPASSRLS but owns the table.
ALTER TABLE principal_context FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS own_principal_only ON principal_context;
-- `current_setting(..., true)` returns NULL when unset rather than erroring, and NULL = anything is
-- NULL, so an unscoped read matches no rows. Fail closed, by the shape of SQL's own comparison.
CREATE POLICY own_principal_only ON principal_context
  USING (principal_id = current_setting('playroom.principal_id', true))
  WITH CHECK (principal_id = current_setting('playroom.principal_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON principal_context TO playroom_context;
-- So the authenticated connection may assume the restricted role for a transaction.
GRANT playroom_context TO CURRENT_USER;
