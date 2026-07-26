# RA-006 — Roadmap amendment: S1.1 makes enrolment binding, S1.2 makes it authenticated

**Amends:** Bible §21.3, the S1.1 exit criterion · **Status:** Logged, applied to the S1.1a/b/c split · **Raised by:** S1.1a

## The gap

Bible §21.3 gives S1.1 the binary exit:

> Sol cannot exist in a room without Jerry's **authenticated** enrolment.

**Authentication does not exist until S1.2.** There is no credential, no session, no signature
and no identity stamp anywhere in the system; `actor_id` arrives on the wire as a free string
and the server writes what it is given (M-N1, RT-002, S04-N2). So the criterion as written
cannot be met by the slice it is attached to, no matter what S1.1 builds.

This is the same shape as the P0 film's beat 5, which the deck described as a merge being
blocked while the mechanism that would sign it belongs to S2.1 and S2.2: **a criterion whose
proof lives in a later slice.** The failure mode is not that the work is wrong. It is that the
slice either gets marked done against a claim it did not establish, or gets held open waiting
for a dependency nobody named. Both were observed this quarter.

## The amendment

S1.1's exit splits along the line the architecture already draws:

> **S1.1 — enrolment is expressible and the binding is structural.** A principal and a member
> are records. A member cannot exist without a principal binding, and that is enforced by the
> database rather than by application code. Sol cannot exist in a room without an enrolment
> that names Jerry.
>
> **S1.2 — enrolment is authenticated.** The claim that a caller is Jerry, or acts for Jerry,
> is verified rather than accepted. Only then does "Sol cannot exist in a room without Jerry's
> **authenticated** enrolment" become a statement the system can defend.

The original sentence is not weakened; it is **dated**. Every word of it survives into S1.2,
which is where the word `authenticated` acquires a mechanism.

## Why the distinction is worth a ledger entry

Because the structure is genuinely persuasive on its own, and that is the danger. After S1.1a
there is a `members` table with a foreign key to `principals`, and a room whose roster is read
from records rather than from a YAML file. It looks like identity. It is not identity — it is a
place to put identity once something can establish it.

Anyone reading the schema without this entry will reasonably conclude that enrolment is
enforced, because at the database it is: a member with no principal cannot be inserted. What
cannot be enforced yet is that the caller asserting a member's name is entitled to. **The
binding is real; the claim to be on one end of it is not checked.**

Recorded so the S2.8 audit question — "what does this system actually verify?" — finds the
answer written down rather than inferred from a table definition.

**Precondition:** none. **Blocks:** nothing. **Binds:** S1.1's sign-off, and S1.2's.
