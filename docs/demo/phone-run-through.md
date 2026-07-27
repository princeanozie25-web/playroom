# Trying Playroom on your phone

**For:** whoever has been sent a code. No technical knowledge needed, nothing to install, no account
to make.

**For Prince, before sending this to anyone:** the operator's half is at the bottom.

---

## What you are looking at

A shared room. Some of the people in it have their own AI assistant, and everyone can see everything
that happens — every message, every reply, and every time an assistant is asked to do something and
says no.

That last part is the point of the whole thing. You are not here to be impressed by the assistant.
You are here to see what it is **not allowed** to do.

## 1. Open the link

Tap the link you were sent. You will see a box asking for two things.

## 2. Type your code and your first name

The code looks like `PLAY-4K7Q`. It works once, so it is yours.

Your first name is shown next to everything you do in the room, so other people can see who did
what. A first name is enough — there is nothing to sign up for.

Tap **Enter the room**.

> **If it says the code does not work:** check it with whoever sent it. Codes run out after a while,
> and each one only works for one person.

## 3. Say something

There is a box at the bottom. Type anything and send it. Your name appears next to it.

Nothing has woken up yet. The assistants are sitting there doing nothing, on purpose.

## 4. Wake yours up

Look at the names along the top. One of them is yours — the welcome note said which.

They are written like `Ada (Amara)`. The first name is the assistant. The name in brackets is the
**person it works for**. So `Ada (Amara)` is Amara's assistant, and it only ever acts for Amara.

Type an `@` and its name, then a question. For example:

```
@ada what should I ask you?
```

It will answer, word by word, as it thinks.

**Only the one you name will answer.** The others stay quiet. Try tagging someone else's and watch
whose assistant replies — it is theirs, not yours, and it is still their name on it.

## 5. Optional: ask it to do something it is not allowed to do

This is the part worth seeing, and it takes one message:

```
@ada please merge this
```

**The room says no, and it names a human.** Not the assistant apologising, and not a vague "I can't
help with that" — the room itself stops the action and shows whose signature would be needed to
allow it. Often that person is **you**.

Nothing was broken and nothing went wrong. That refusal is the product working.

---

## If something looks wrong

| What you see                                            | What it means                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **RECONNECTING** at the top for more than a few seconds | Your connection dropped. It retries by itself; nothing you sent was lost.                                                    |
| Nobody answers when you tag an assistant                | Check the spelling of the name. If it still does nothing, tell Prince.                                                       |
| A note about a **spending limit**                       | The assistants run on a paid service with a daily cap, and today's is used up. Messages still work; replies resume tomorrow. |
| You are asked for the code again                        | Your session expired. Ask Prince for a new code.                                                                             |

**Anything else, say so.** A thing that confused you is more useful to us than a thing that worked.

---

## For the operator

**Mint one code per person.** Each code is single-use and binds to its own seat, so each tester gets
their own assistant bound to their own principal — that is what makes the audit log able to say who
did what.

```bash
pnpm tsx scripts/mint-code.ts --room playroom --label "Amara (phone test)"
```

```bash
pnpm tsx scripts/mint-code.ts --list --room playroom
```

**There are two guest seats, and that is a real ceiling** — not a database limit. The accent palette
has four hues assigned by principal ordinal, and two are already Prince and Jerry. A fifth principal
silently reuses Prince's colour, which matters because colour is how the room answers "whose
authority is this" when two assistants are replying at once. A third external tester needs a palette
decision first, not another row.

**A redeemed seat stays redeemed.** Handing seat A to a second person would rename that principal and
silently re-attribute the first person's messages to them. If a seat was spent by _testing_ rather
than by a person, give it back with:

```bash
pnpm tsx scripts/reset-guest.ts --seat principal:guest-a
```

That destroys the guest and everything they did, so it is only ever for a seat nobody real used.

**Set the spending ceiling before sending any link.**

```bash
PLAYROOM_DAILY_USD_CEILING=5
```

Unset means no ceiling. A malformed value throws rather than reading as unlimited.

**Not in this slice, deliberately:** no file or image upload (untrusted content entering agent
context, and screening does not exist yet), no promotion controls for testers (the consent surface is
one slice old), and no bring-your-own provider key. See the red-team log for what a demo credential
can and cannot reach.
