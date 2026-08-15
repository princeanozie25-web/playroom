import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DISCLOSED_FIELDS } from '../src/push-send.js';

/**
 * ═══ S-DIAL — TWO WORDS, NOT ONE (SD-2) ═══
 *
 * An order that reached LIMIT_REACHED and an order that paused for a person both arrived as DECISION
 * and both read "Something needs a decision". So the phone could not tell a loop that FINISHED from
 * one that needs you, which is the difference between reading it in the morning and getting up.
 *
 * ── WHAT FINISHED IS, AND WHAT IT IS NOT ────────────────────────────────────────────
 *
 * It names the ORDER'S TERMINAL STATUS — REVOKED, EXPIRED, LIMIT_REACHED — which the server writes
 * and a member cannot assert. It is NOT an agent saying its work is complete. **ST-N1 stays open**:
 * "the order ran the count it was given" is not "the audit is done", and nothing here closes that
 * gap or pretends to.
 */

const SRC = resolve(import.meta.dirname, '..', 'src');
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const interrupts = strip(readFileSync(resolve(SRC, 'interrupts.ts'), 'utf8'));
const runner = strip(readFileSync(resolve(SRC, 'commands', 'runOrders.ts'), 'utf8'));
const sender = strip(readFileSync(resolve(SRC, 'push-send.ts'), 'utf8'));
const sw = strip(readFileSync(resolve(SRC, '..', '..', 'web', 'public', 'sw.js'), 'utf8'));

describe('FINISHED comes from server-owned terminal state, and nowhere else', () => {
  it('exactly ONE site sets the tone, and it derives it from TERMINAL_ORDER_STATUSES', () => {
    // THE WHOLE CONTROL. A grep for the value across the source: the runner's stopOrder is the only
    // place that can produce it, and it reads the status IT just wrote rather than anything a member
    // said. Every other raiser omits the field and therefore gets NEEDS-YOU.
    const setters: string[] = [];
    for (const f of [
      'interrupts.ts',
      'push-send.ts',
      'server.ts',
      'agent.ts',
      'commands/runOrders.ts',
      'commands/coSign.ts',
      'commands/raiseHand.ts',
      'commands/requestAction.ts',
      'commands/summon.ts',
    ]) {
      const body = strip(readFileSync(resolve(SRC, f), 'utf8'));
      if (body.includes("notifyTone: 'FINISHED'")) setters.push(f);
    }
    expect(setters).toEqual(['commands/runOrders.ts']);
    expect(runner).toContain("TERMINAL_ORDER_STATUSES.has(status) ? 'FINISHED' : 'NEEDS-YOU'");
  });

  it('no member-reachable command carries a tone — there is no field to put one in', () => {
    // The command union is the whole surface a member can reach (executeCommand is the single entry).
    // If `notifyTone` appeared on any of these, a crafted frame could ask for a FINISHED.
    const context = strip(readFileSync(resolve(SRC, 'commands', 'context.ts'), 'utf8'));
    const index = strip(readFileSync(resolve(SRC, 'commands', 'index.ts'), 'utf8'));
    expect(context).not.toContain('notifyTone');
    expect(index).not.toContain('notifyTone');
    // ...and the door's own raise path does not mention it either.
    const hand = strip(readFileSync(resolve(SRC, 'commands', 'raiseHand.ts'), 'utf8'));
    expect(hand).not.toContain('notifyTone');
    expect(hand).not.toContain('FINISHED');
  });

  it('the field is OPTIONAL, so silence means NEEDS-YOU rather than nothing', () => {
    // A default of "absent = the louder thing" is the fail-safe direction: a raiser that forgets the
    // field claims attention, rather than quietly not doing so.
    expect(interrupts).toContain('notifyTone?:');
    expect(interrupts).toContain("input.notifyTone ?? 'NEEDS-YOU'");
  });

  it('an unrecognised tone on the wire reads as NEEDS-YOU, not as quiet', () => {
    // The worker is the last place this value is trusted, and it is trusted least there: anything
    // that is not exactly 'FINISHED' is loud.
    expect(sw).toContain("payload.tone === 'FINISHED'");
    expect(sw).not.toContain('payload.tone !== ');
  });
});

describe('FINISHED does not wake a phone; NEEDS-YOU does', () => {
  it('the REQUEST: a FINISHED asks the vendor for the low-urgency class', () => {
    expect(sender).toContain("tone === 'FINISHED' ? 'low'");
    // ...and a BLOCKER still asks for immediate delivery.
    expect(sender).toContain("'high'");
  });

  it('the DECISION: the worker shows a FINISHED silently, and that one cannot be overridden', () => {
    // The Web Push urgency header is a hint a vendor may ignore. This is not: `silent` and an empty
    // vibration pattern are ours, applied at display time on the device.
    expect(sw).toContain('silent: finished');
    expect(sw).toContain('vibrate: finished ? [] : undefined');
  });

  it('and it reads as done rather than as a claim', () => {
    expect(sw).toContain("'A loop finished'");
    expect(sw).toContain('Nothing needs you');
  });
});

describe('the disclosure widens FORWARD ONLY', () => {
  it('the constant names the new field, and history cannot be rewritten by changing it', () => {
    expect(DISCLOSED_FIELDS).toBe(
      'room_id, urgency(BLOCKER|DECISION), tone(FINISHED|NEEDS-YOU), sent_at',
    );
    // WHY IT IS FORWARD-ONLY BY CONSTRUCTION rather than by anyone remembering: the string is copied
    // into the row at INSERT and NOTHING updates that column. A row written under S-PUSH keeps the
    // narrower text it was actually sent under, forever.
    expect(sender).toContain('disclosed');
    expect(sender).not.toMatch(/UPDATE\s+push_sends/i);
    const migration = readFileSync(
      resolve(SRC, '..', '..', '..', 'infra', 'migrations', '029_push_sends.sql'),
      'utf8',
    );
    expect(migration).toContain('disclosed       TEXT NOT NULL');
  });

  it('the payload gained exactly one field, and it still carries no text', () => {
    const start = sender.indexOf('const payload = JSON.stringify({');
    const body = sender.slice(start, sender.indexOf('});', start));
    // Keys, counted as NAMES rather than as "name:" — `tone` is a shorthand property and the
    // colon-only regex silently skipped it, which would have let a fifth field in unnoticed.
    const keys = (body.match(/^\s*(\w+)\s*[,:]/gm) ?? []).map((k) => k.trim().replace(/[,:]$/, ''));
    expect(new Set(keys)).toEqual(new Set(['room', 'urgency', 'tone', 'at']));
    for (const forbidden of ['summary', 'reason', 'briefing', 'mandate', 'text']) {
      expect(body, `the payload gained "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe('ST-N1 is not closed by this', () => {
  it('nothing lets a member or a turn declare work complete', () => {
    // The anti-goal, asserted where it would be violated: an agent's turn text, a task state, or a
    // message cannot become a FINISHED. The only input is an order status the server wrote.
    expect(runner).not.toContain('payload.text');
    expect(interrupts).not.toContain("'FINISHED'" + ' as');
    // And the runner still has no completion CONDITION — only counts, clocks, budgets and failures.
    expect(runner).not.toMatch(/complete[dt]?\s*[:=]/i);
  });
});
