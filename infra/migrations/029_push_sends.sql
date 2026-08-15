-- ═══ S-PUSH — THE EGRESS RECORD ═══════════════════════════════════════════════════════
--
-- THE RECORD COMES BEFORE THE CAPABILITY, which is the shape RT-005 used at S-CC and the shape
-- every governed act in this system has: the thing that can be audited exists before the thing that
-- can act. This table is written by SP-2 and the sender that fills it is written after it.
--
-- ── WHY A PUSH NEEDS A RECORD AT ALL ─────────────────────────────────────────────────
--
-- This is Playroom's FIRST NON-PROVIDER EGRESS. Everything outbound until now was a model call
-- through packages/adapters — a call this system makes to do the work a member was summoned for. A
-- push is different in kind: the server tells a THIRD PARTY THE ROOM DOES NOT CONTROL that something
-- happened here. Even a minimal payload is a disclosure, and an untracked outbound call is the exact
-- shape of the thing this product exists to refuse. So every send writes a row, and so does every
-- send that DOESN'T happen: a refusal that leaves no trace is indistinguishable from a message that
-- was never worth sending.
--
-- ── WHAT IS RECORDED, AND WHY EACH FIELD ─────────────────────────────────────────────
--
--   principal_id     TO WHOM. The person whose attention was claimed.
--   room_id          ABOUT WHERE. Also the only content in the payload.
--   interrupt_id     WHY. The claim that caused this send; a send with no claim behind it would be
--                    this system notifying on its own account, which it must never do.
--   urgency          WHAT WAS DISCLOSED, and it is named rather than assumed. The urgency word
--                    travels to the vendor in the payload — a deliberate disclosure (R3), because it
--                    is what lets a notification say "blocked" rather than "something", and what a
--                    later FINISHED-versus-NEEDS-YOU distinction would be built on. Recording it
--                    here is what makes it a decision on the record instead of a detail nobody
--                    noticed.
--   endpoint_origin  TO WHOM, at the vendor. THE ORIGIN ONLY, never the full endpoint: the full URL
--                    is the address of a person's phone, and an audit trail needs to know which
--                    company was told, not how to reach the device. It is also the exact thing the
--                    allowlist governs, so the record and the control read the same field.
--   disclosed        WHAT WAS DISCLOSED, as a literal list, written by the sender at send time.
--                    Denormalised on purpose: a future payload change must not silently rewrite the
--                    history of what older sends actually carried.
--   outcome          WHAT HAPPENED, including the refusals — see the CHECK below.
--   detail           The vendor's status or the refusal's reason. NEVER key material, never an
--                    endpoint, never payload content (S-SCRUB, asserted in this slice's tests).
--
-- ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────────────
--
-- No payload column. The payload is three fields and two of them are already columns; storing the
-- encrypted body would put a copy of every notification in the database for no auditing gain. No
-- subscription_id: a subscription is deleted the moment the vendor says it is gone, and a foreign
-- key to it would either block that delete or leave the record lying about what still exists.

CREATE TABLE IF NOT EXISTS push_sends (
  id              TEXT PRIMARY KEY,
  principal_id    TEXT NOT NULL REFERENCES principals (id),
  room_id         TEXT NOT NULL,
  interrupt_id    TEXT,
  urgency         TEXT NOT NULL,
  endpoint_origin TEXT NOT NULL,
  disclosed       TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  detail          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- THE OUTCOMES ARE CLOSED, so a new one cannot be introduced without a decision about it — the
  -- same reasoning migration 021 used for an order's status.
  --
  --   delivered         the vendor accepted it
  --   refused_endpoint  the endpoint's origin is not on the allowlist — refused BEFORE any send
  --   refused_throttle  this principal has been sent to too often in the window
  --   failed            the vendor rejected or was unreachable
  --   gone              the vendor says this subscription no longer exists (404/410); the row it
  --                     names has been deleted, and this record is why
  CONSTRAINT push_sends_outcome_known
    CHECK (outcome IN ('delivered', 'refused_endpoint', 'refused_throttle', 'failed', 'gone'))
);

-- The throttle's window read, and the "what did we tell this person" audit read.
CREATE INDEX IF NOT EXISTS push_sends_principal_time_idx
  ON push_sends (principal_id, created_at DESC);
