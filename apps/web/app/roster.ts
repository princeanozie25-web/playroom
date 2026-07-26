import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { loadMandates } from '@playroom/fabric';

// SERVER ONLY. This module reads the filesystem; it must never be imported from a
// component marked 'use client'. The roster is resolved on the server and handed to
// the room as props — no YAML parser and no config file ever reaches the browser.
//
// Until S1.1 lands a real membership model, adapters.yaml doubles as the roster.
// Only four fields are projected out of it: id, display_name, principal,
// mandate_label. `provider` and `model` are deliberately NOT projected, so the §6
// rule — the room, fabric and data model never contain a provider name — survives
// the web app reading this file at all.

export interface RosterMember {
  id: string;
  display_name: string;
  principal: string;
  /**
   * The member's granted action scope, READ FROM THEIR MANDATE — not from config.
   *
   * This replaced `mandate_label`, a caption in adapters.yaml that described authority
   * without being it. The chip now renders the mandate's own scope, so the text a
   * viewer reads and the array the evaluator checks are the same data. A member with
   * no mandate gets `null` and renders NO mandate text — never "unrestricted".
   */
  scope: string[] | null;
  /**
   * Actions the mandate lists as protected. Shown so the chip cannot imply that a
   * granted action is freely exercisable: `pr.merge` in scope means the member may
   * ASK, and being protected means a human must sign. Reading the scope alone would
   * make those two look identical.
   */
  protected_actions: string[] | null;
}

interface RawEntry {
  id?: unknown;
  enabled?: unknown;
  display_name?: unknown;
  principal?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// adapters.yaml lives at the repo root. `next dev` and `next start` both run with
// cwd = apps/web, but the candidates cover a run from the repo root too.
function yamlPath(): string {
  const candidates = [
    resolve(process.cwd(), '../../adapters.yaml'),
    resolve(process.cwd(), 'adapters.yaml'),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c);
      return c;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`adapters.yaml not found (looked in: ${candidates.join(', ')})`);
}

/**
 * Agent members the roster declares. An entry missing any roster field is SKIPPED,
 * not defaulted: a chip invented from a missing field would be the UI asserting a
 * mandate the config never stated, which is the one thing this surface may not do.
 */
export function loadRoster(): RosterMember[] {
  // Mandates are the authority; adapters.yaml only says who is in the room. A member
  // with no mandate is still a member — they simply have no granted scope to show.
  const mandates = loadMandates();
  const parsed: unknown = parse(readFileSync(yamlPath(), 'utf8'));
  const entries =
    typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as never)['adapters'])
      ? ((parsed as Record<string, unknown>)['adapters'] as RawEntry[])
      : [];

  const members: RosterMember[] = [];
  for (const e of entries) {
    if (e.enabled === false) continue; // a disabled adapter is not in the room
    const id = str(e.id);
    const display_name = str(e.display_name);
    const principal = str(e.principal);
    if (!id || !display_name || !principal) continue;
    const m = mandates.get(id)?.mandate;
    members.push({
      id,
      display_name,
      principal,
      scope: m?.scope ?? null,
      protected_actions: m?.protected_actions ?? null,
    });
  }
  return members;
}
