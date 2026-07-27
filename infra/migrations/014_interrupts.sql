-- 014_interrupts: claiming a human's attention becomes a record with a price (S1.4).
--
-- Additive only. One table.
--
-- Bible §21.3's exit: BLOCKER / DECISION / FYI plus one-tap downgrade, where the downgrade
-- decrements the raising member's interrupt budget, visibly.
--
-- ── THE ECONOMIC IDEA, WHICH IS THE POINT ─────────────────────────────────────────────
--
-- Interrupting a human spends budget. Silence is free. A downgrade is not a dismissal — it is a
-- signal that costs the interrupter something, which is what makes it a control rather than a
-- preference. An agent that misjudges what deserves a person's attention pays twice: once to
-- raise, once when the person says it was not worth it.
--
-- ── MEMBER-ADDRESSED, NEVER HUMAN-ADDRESSED ───────────────────────────────────────────
--
-- THE CONSTRAINT THIS SLICE INHERITED, and the one thing here that is expensive to get wrong.
-- Per-human identity does not exist (S04-N2) and is not this slice's to build: a credential
-- authenticates a PROCESS acting as a member, and there is no login behind it.
--
-- So every column here names a MEMBER. `raised_by` is a member, `addressed_to` is a member, and
-- the budget belongs to a member. Nothing in this table, and nothing in the code that writes it,
-- assumes one human sits behind one member.
--
-- WHAT THAT BUYS, CONCRETELY. A co-signature is required from a PRINCIPAL (`required_signer` is
-- `principal:prince`), and a principal may have several members — today `principal:prince` has
-- two, the human `prince` and the agent `claude-main`. The co-sign path resolves that principal
-- to its HUMAN members and raises one interrupt PER HUMAN MEMBER. When a second human joins a
-- principal, that path raises two interrupts instead of one and nothing here changes shape. A
-- table keyed on "the person to notify" would have needed a new column and a migration to say
-- which person.
--
-- ── NO STATE COLUMN. URGENCY IS THE STATE. ────────────────────────────────────────────
--
-- An interrupt is raised at an urgency and can be lowered; there is no separate lifecycle to
-- track, and a `state` column beside `urgency` would be two fields answering one question. The
-- log carries every change (`interrupt.raised`, `interrupt.downgraded`), so the history is
-- reconstructible exactly as a task's is — and the row is a projection of it, same rule.

CREATE TABLE IF NOT EXISTS interrupts (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- BLOCKER halts the work, DECISION queues, FYI never interrupts. The behaviours differ, not
  -- only the labels — see commands/interrupt.ts.
  urgency      TEXT NOT NULL,
  -- WHOSE BUDGET PAYS. A member, and for a co-sign it is the SUBJECT whose mandate needs the
  -- signature: the work is theirs, so the claim on a person's attention is theirs to fund.
  raised_by    TEXT NOT NULL REFERENCES members (id),
  -- WHOSE ATTENTION IS CLAIMED. A member, and today always a human one — an interrupt addressed
  -- to an agent would be a notification nothing reads, because an agent acts only when summoned.
  addressed_to TEXT NOT NULL REFERENCES members (id),
  -- WHAT IT IS ABOUT: a task, a decision, or a message. `about_id` is that row's id, not a
  -- foreign key, because the three targets live in three tables and a nullable column per target
  -- would be three columns of which two are always empty.
  about_kind   TEXT NOT NULL,
  about_id     TEXT NOT NULL,
  -- The owning task, when there is one. Kept as a real reference because BLOCKER HALTS IT, and
  -- the halt has to find the task without parsing `about_id` against a guessed table.
  task_id      TEXT REFERENCES tasks (id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT interrupts_urgency_known CHECK (urgency IN ('BLOCKER', 'DECISION', 'FYI')),
  CONSTRAINT interrupts_about_known CHECK (about_kind IN ('task', 'decision', 'message'))
);

-- ONE INTERRUPT PER THING PER RECIPIENT. The same discipline migration 005 gave the summon: a
-- retried co-sign, a replayed frame or two requests racing must not claim a person's attention
-- twice for one decision. An `if` cannot survive two of them in flight; this can.
CREATE UNIQUE INDEX IF NOT EXISTS interrupts_about_uniq
  ON interrupts (room_id, about_kind, about_id, addressed_to);

CREATE INDEX IF NOT EXISTS interrupts_room_idx ON interrupts (room_id);
-- The budget query reads a member's raises for the current day.
CREATE INDEX IF NOT EXISTS interrupts_raiser_idx ON interrupts (raised_by, created_at);
