-- 017: credentials that expire, a human member for Jerry, and two guest slots (S-LIVE).
--
-- Additive. One column, three seeds.
--
-- ── WHY CREDENTIALS NEED AN EXPIRY BEFORE STRANGERS HOLD THEM ──────────────────────────
--
-- Every credential issued so far has been mine or a test's, and revocation was enough: I know who
-- holds them and I can revoke on purpose. A credential handed to someone outside this machine is
-- different in one specific way — NOBODY WILL REMEMBER TO REVOKE IT. A demo credential with no
-- expiry is a permanent one that happens to be unused, and the difference only shows up months
-- later when it is used.
--
-- NULLABLE, and null means "does not expire". Every existing row keeps working: the capture
-- harness's credential and mine are long-lived on purpose, and rewriting them to carry a date
-- would be inventing an expiry nobody chose. New demo credentials are issued WITH one, and the
-- code that issues them requires it — see credentials.ts. So the column is optional and the
-- policy is not.
--
-- CHECKED IN `authenticate`, not by a sweep. An expired credential must stop working at the
-- moment it expires, not at the next time something remembers to clean up; a background job that
-- deletes expired rows is housekeeping, not enforcement. Same reasoning as the ticket path.

ALTER TABLE member_credentials ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- ── A HUMAN MEMBER FOR JERRY ───────────────────────────────────────────────────────────
--
-- Migration 008 created a human member for Prince and none for Jerry, which was invisible while
-- one browser held one credential and acted as Prince. It stops being invisible the moment the
-- primary test is TWO PEOPLE IN ONE ROOM: Jerry has an agent (`sol`) and no way to be himself.
--
-- `principal:jerry` already exists and already owns `sol`, so this adds the person, not the
-- principal. After this, `@sol` is Jerry's agent tagged by Jerry, and the co-sign path has a human
-- of Jerry's principal to name — which is what makes the merge refusal say a person's name rather
-- than fail to find one.

INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES
  ('jerry', 'human', 'Jerry', 'principal:jerry', NULL)
ON CONFLICT (id) DO NOTHING;

-- ── TWO GUEST SLOTS, AND WHY EXACTLY TWO ───────────────────────────────────────────────
--
-- A tester gets their own agent bound to their own principal, which means a principal per tester.
-- The ceiling is not arbitrary and it is not a database limit: THE ACCENT PALETTE HAS FOUR HUES.
-- `principalAccent` is `ordinal % 4`, and the four hues were chosen in S-UI to sit clear of the
-- state colours (--ok green, --warn amber, --bad red). A fifth principal silently reuses Prince's
-- colour, and "whose authority does this carry" is answered by colour in a room where two agents
-- are streaming at once.
--
-- So: ordinals 2 and 3, giving four principals with four distinct accents, and a fifth tester
-- needs a palette decision rather than another INSERT. That constraint is stated here because the
-- next person to add a guest will read this file, not the CSS.
--
-- A SLOT IS A SLOT UNTIL SOMEBODY REDEEMS IT. The display names below are placeholders in the
-- honest sense — they name an empty seat, not a fictional person — and redemption REPLACES the
-- principal's display name with the name the tester gives. So `Ada (Guest A)` becomes
-- `Ada (Amara)` when Amara redeems, and nothing in the room ever renders an invented human.

-- ── `guest` IS A FLAG WITH ONE JOB, AND IT CLOSES A HOLE THIS MIGRATION WOULD OPEN ─────
--
-- `createRoom` enrols EVERY MEMBER IN THE DATABASE into every new room. That was harmless while
-- every member was mine or Jerry's — a test pinned it as "a new room gets every current member,
-- today's behaviour, recorded rather than narrowed" — and it stops being harmless the instant a
-- stranger holds a guest slot: they would become a member of every room created after they
-- redeemed, including rooms nobody meant to show them.
--
-- Which would also make the room code POINTLESS. The whole design is that a code enrols the
-- redeemer; blanket enrolment enrols them anyway, so the code would be decoration over an open
-- door. Not a hypothetical — it is what the code as written did an hour ago.
--
-- So guest principals are excluded from blanket enrolment, and the ONLY way into a room for a guest
-- is a redemption that writes the row on purpose. Non-guest behaviour is untouched, which is why
-- this is a flag rather than a rewrite of `createRoom`: narrowing enrolment for everyone is the
-- right eventual design and it is a bigger change than a slice with a deadline should make.
ALTER TABLE principals ADD COLUMN IF NOT EXISTS guest BOOLEAN NOT NULL DEFAULT false;

INSERT INTO principals (id, display_name, ordinal, guest) VALUES
  ('principal:guest-a', 'Guest A', 2, true),
  ('principal:guest-b', 'Guest B', 3, true)
ON CONFLICT (id) DO UPDATE SET guest = true;

-- The agents. Their ids are adapter ids (`members_agent_has_adapter`, and `isAgentActor` resolves
-- an actor against the adapter registry), so each has an entry in adapters.yaml and a mandate file
-- of its own. Short names, because they are spoken aloud in a room and typed on a phone.
INSERT INTO members (id, kind, display_name, principal_id, adapter_id) VALUES
  ('ada', 'agent', 'Ada', 'principal:guest-a', 'ada'),
  ('bo',  'agent', 'Bo',  'principal:guest-b', 'bo')
ON CONFLICT (id) DO NOTHING;

-- ── AND THEIR ROUTES, WHICH ARE NOT OPTIONAL ───────────────────────────────────────────
--
-- Migration 009 seeded a hosted route for every agent member by SELECTing from `members`, which
-- was complete when it ran and cannot cover a member added eight migrations later. §6.2's failure
-- rule says a member with no usable route puts its task in `input-required` and names the route as
-- the reason — so without these rows, tagging a guest agent produces a correct, well-explained
-- refusal instead of a turn, and the demo fails in the most confusing possible way: nothing is
-- broken, everything reports success, and no agent ever speaks.
--
-- Found by reading 009's WHERE clause rather than by tagging @ada and wondering. Worth stating
-- because it generalises: EVERY MIGRATION THAT SEEDS BY SELECTING FROM A TABLE is a snapshot, and
-- the next row added to that table does not get retro-seeded.
INSERT INTO routes (id, member_id, type, status, capabilities, data_classes, adapter_id)
SELECT 'rt_' || m.id, m.id, 'hosted', 'available',
       ARRAY['text', 'stream'], ARRAY[]::TEXT[], m.adapter_id
  FROM members AS m
 WHERE m.id IN ('ada', 'bo')
ON CONFLICT (id) DO NOTHING;
