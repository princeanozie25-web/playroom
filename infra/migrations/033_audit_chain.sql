-- 033 — THE TAMPER-EVIDENT AUDIT CHAIN (S2.3 / A3, Bible §17).
--
-- `events` is the operational log: mutable, prunable, and the source of truth the room reads. This is the
-- other table Bible §17 names — the record that a commitment happened and CANNOT be quietly rewritten. The
-- two are separate on purpose: one is convenient, one is trustworthy, and a single table cannot be both.
--
-- ── WHAT IT CHAINS, AND WHY NOT EVERY EVENT ─────────────────────────────────────────
--
-- Only COMMITMENT-shaped events (Bible §2's "receipts for anything commitment-shaped"): today the co-sign
-- lifecycle — a `decision` (a co-sign was raised) and a `decision.resolved` (a human APPROVED or DENIED it).
-- A chat message is not a commitment; hashing every message would spend the chain's one property — that an
-- edit is detectable — on noise. The set is a named constant in audit.ts, extended by decision, not by a
-- prefix that admits a new event type by accident.
--
-- ── DERIVED, APPEND-ONLY, AND CHAINED ───────────────────────────────────────────────
--
-- Each row is derived from ONE `events` row (`source_seq`), and it commits to two things at once:
--   * `body_hash`  = sha256(canonicalise(that event's payload)) — so editing the SOURCE event is detected,
--     because re-hashing it at verify time no longer matches this row.
--   * `entry_hash` = sha256(prev_hash || body_hash || meta) — so editing THIS row, or removing/inserting a
--     row, breaks the link to the next one. The chain's newest `entry_hash` is the daily ROOT; anchoring it
--     externally (Bible §17: emailed to principals) makes even a wholesale rewrite detectable, because the
--     rewrite cannot reproduce a root that was already sent out.
--
-- `source_seq` is UNIQUE so an event is chained exactly once — the anchor is idempotent and re-runnable.
--
-- ── sig IS PRESENT AND NULL, NOT STUBBED (the A1 discipline) ─────────────────────────
--
-- Bible §17's `sig` is the fabric's own signature over the entry — non-repudiation on top of the hash
-- chain's tamper-evidence. It needs a fabric RUNTIME signing identity, which does not exist yet (the mandate
-- trust root deliberately keeps its private key off every serving machine — S2.1). So the column exists and
-- is left NULL: absent, not faked with an `ed25519:` placeholder that would read as verified. The hash chain
-- plus the anchored root is the tamper-evidence S2.3 requires; the signature is a later, additive bar.

CREATE TABLE IF NOT EXISTS audit_chain (
  seq         BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  room_id     TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  event       TEXT NOT NULL,          -- the commitment event type (decision | decision.resolved)
  source_seq  BIGINT NOT NULL,        -- the events.seq this entry was derived from
  body_hash   TEXT NOT NULL,          -- sha256(canonicalise(source payload)) — catches a tampered source
  prev_hash   TEXT NOT NULL,          -- the previous entry_hash, or the genesis marker for the first row
  entry_hash  TEXT NOT NULL,          -- sha256(prev_hash || body_hash || meta) — the link and the root
  sig         TEXT                    -- fabric signature; NULL in v1 (deferred, never stubbed)
);

-- One entry per source event: the anchor re-runs safely and cannot double-chain.
CREATE UNIQUE INDEX IF NOT EXISTS audit_chain_source_seq_idx ON audit_chain (source_seq);
