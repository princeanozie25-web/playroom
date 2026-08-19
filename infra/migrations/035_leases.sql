-- 035 — THE LOCAL NODE LEASE (Track C / C2, ADR-013).
--
-- C1 (the Execution Gate, ADR-012) makes a host file/git/shell op pass a policy check, but the gate only
-- DECIDES — nothing executes (RT-005). C2 is the trusted bridge that a node holds while it does the real
-- work: a LEASE. A host op is authorized for execution ONLY under a live lease, so revoking the lease
-- refuses the node's next op — "a revoked lease stops local work mid-flight" (the Drift rail's acceptance
-- test). Invariant #7 becomes unbypassable in the SANCTIONED path: a compliant node's only execution
-- interface is the lease-bound door.
--
-- ── A LEASE IS A SESSION ROW, MODELLED ON THE REVOCABLE-TOKEN TABLES ──────────────────────────────
--
-- Same discipline as `member_credentials` and `oauth_tokens`: the secret is HASHED at rest (sha256 over a
-- `pln_` token, the shared `hashSecret`), and liveness is enforced IN THE LOOKUP, never by a background
-- sweep. A lease is live when it is unrevoked, unexpired, its heartbeat is fresh, AND the `prm_` credential
-- that granted it is still live (the same cascade OAuth uses — revoke the credential, every lease under it
-- dies). Issue-then-revoke, never update-in-place: a revoked row stays as the record that the lease existed.
--
-- Two clocks, on purpose:
--   * `expires_at`        — the ABSOLUTE ceiling. A node cannot hold a lease forever, heartbeats or not.
--   * `heartbeat_deadline`— the NEAR-TERM liveness, bumped by each heartbeat. A node that stops pinging
--                           (crashed, disconnected, network-partitioned) loses its authority when this
--                           passes — the "a disconnected node does not keep acting" half of the bridge.
--
-- `capabilities` is the CAPABILITY SCOPE: the host action types this particular lease may propose (least
-- privilege per session — a lease issued to run the test suite need not carry the member's full host
-- authority). It is bounded by the member's mandate at issue time; the gate still evaluates every op, so the
-- lease can only NARROW, never widen. `workspace` is a human label for what the node is working on.

CREATE TABLE IF NOT EXISTS leases (
  token_hash         TEXT PRIMARY KEY,        -- sha256 of the `pln_` lease token; the plaintext is returned once
  lease_id           TEXT NOT NULL UNIQUE,    -- `lea_` public id: names the lease for heartbeat/revoke/logging
  member_id          TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  principal_id       TEXT NOT NULL,
  credential_id      TEXT NOT NULL,           -- the granting prm_ credential; verify joins it so its revocation cascades
  capabilities       TEXT[] NOT NULL,         -- the host action types this lease may propose (least privilege)
  workspace          TEXT NOT NULL,           -- a label for what this node is working on (provenance, not a path scope)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,    -- the absolute ceiling
  heartbeat_deadline TIMESTAMPTZ NOT NULL,    -- the near-term liveness; each heartbeat bumps it
  revoked_at         TIMESTAMPTZ              -- explicit revocation — the "stop the node" control
);

-- Member-scoped listing (an owner enumerating / revoking their nodes) and a partial index over the live rows
-- the verify lookup hits, so authorising a host op is one indexed read whatever the revoked history.
CREATE INDEX IF NOT EXISTS leases_member_idx ON leases (member_id);
CREATE INDEX IF NOT EXISTS leases_live_idx ON leases (token_hash) WHERE revoked_at IS NULL;
