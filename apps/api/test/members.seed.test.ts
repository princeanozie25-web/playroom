import { afterAll, describe, expect, it } from 'vitest';
import { listAdapters } from '@playroom/adapters';
import { testPool } from './support.js';

// THE SEED IS THE MIGRATION PATH, AND THIS IS THE ONLY WINDOW IN WHICH IT IS CHECKABLE.
//
// Migration 007 seeds `principals` and `members` with the roster adapters.yaml held at
// S11a-1. The next commit strips those fields from adapters.yaml, at which point there is
// nothing left to compare against and the migration becomes simply the historical record.
//
// So the equivalence is asserted HERE, while both representations still exist. "Seeded from
// adapters.yaml" is otherwise a claim in a comment, and a seed that quietly differs from the
// roster it replaced would change the room on a migration — which is the one thing this
// slice may not do.
//
// The comparison goes through `listAdapters()` rather than re-parsing the YAML: that is the
// same schema-validated read the app itself uses, so this checks the seed against what the
// application actually sees, not against a second parser that could differ. It also keeps
// `yaml` out of this workspace's dependencies.
//
// WHEN S11a-2 REMOVES THOSE FIELDS, THIS FILE GOES WITH THEM. It is not a permanent test; it
// is the proof obligation for one transition, and leaving it asserting against fields that no
// longer exist would be worse than deleting it.

const pool = testPool();

afterAll(async () => {
  await pool.end();
});

describe('migration 007 seeded the roster faithfully', () => {
  it('seeds every ENABLED adapter as an agent member, bound to its principal', async () => {
    const { rows } = await pool.query<{
      id: string;
      kind: string;
      display_name: string;
      principal_id: string;
      adapter_id: string | null;
    }>('SELECT id, kind, display_name, principal_id, adapter_id FROM members ORDER BY id');

    const expected = listAdapters()
      .map((a) => ({
        id: a.id,
        kind: 'agent',
        display_name: a.display_name,
        principal_id: a.principal,
        adapter_id: a.id,
      }))
      .sort((x, y) => (x.id < y.id ? -1 : 1));

    expect(rows).toEqual(expected);
  });

  it('binds every seeded member to a principal that exists', async () => {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM members m LEFT JOIN principals p ON p.id = m.principal_id WHERE p.id IS NULL',
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('keeps the accents the room already shows — Prince 0, Jerry 1', async () => {
    // The regression this slice most easily causes and least easily notices. S-UI2 assigned a
    // principal's accent from its index in a config array; 007 stores an ordinal. If the two
    // disagree the room recolours on a migration.
    //
    // Pinned to the OBSERVABLE OUTCOME rather than to the config that produced it: these are
    // the accents S-UI2 shipped and take 10 of the P0 film shows — Claude indigo (--p0),
    // Sol cyan (--p1). Asserting against the config would only prove the seed copied a file;
    // asserting the outcome proves the screen does not move.
    const { rows } = await pool.query<{ id: string; ordinal: number }>(
      'SELECT id, ordinal FROM principals ORDER BY ordinal',
    );
    expect(rows).toEqual([
      { id: 'principal:prince', ordinal: 0 },
      { id: 'principal:jerry', ordinal: 1 },
    ]);
  });
});

describe('the binding is structural, not conventional', () => {
  it('refuses a member with no principal — NOT NULL, at the database', async () => {
    await expect(
      pool.query(
        "INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES ('x-no-principal', 'agent', 'X', NULL, 'x')",
      ),
    ).rejects.toThrow(/null value|not-null/i);
  });

  it('refuses a member bound to a principal that does not exist — foreign key', async () => {
    await expect(
      pool.query(
        "INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES ('x-ghost', 'agent', 'X', 'principal:nobody', 'x')",
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('refuses an agent with no adapter, and a human wired to one', async () => {
    // The one place a record could be internally incoherent: an "agent" nothing can run, or a
    // human bound to a provider.
    await expect(
      pool.query(
        "INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES ('x-agentless', 'agent', 'X', 'principal:prince', NULL)",
      ),
    ).rejects.toThrow(/members_agent_has_adapter/);
    await expect(
      pool.query(
        "INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES ('x-human-adapter', 'human', 'X', 'principal:prince', 'claude-main')",
      ),
    ).rejects.toThrow(/members_agent_has_adapter/);
  });

  it('accepts a human member with no adapter — the shape S1.1b needs', async () => {
    await pool.query(
      "INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES ('x-human', 'human', 'X', 'principal:prince', NULL) ON CONFLICT (id) DO NOTHING",
    );
    const { rows } = await pool.query("SELECT kind FROM members WHERE id = 'x-human'");
    expect(rows[0]).toEqual({ kind: 'human' });
    await pool.query("DELETE FROM members WHERE id = 'x-human'");
  });
});
