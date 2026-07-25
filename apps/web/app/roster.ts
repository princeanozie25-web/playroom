import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

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
   * DESCRIPTIVE TEXT, NOT AUTHORITY.
   *
   * This is what the roster *says* a member is for. It is not consulted by
   * anything, it gates nothing, and no code branches on it. It cannot deny an
   * action and it cannot permit one — the permission engine that will do that
   * does not exist yet (S2.1).
   *
   * When S2.1 lands, this field is replaced by the effective mandate hash and the
   * human-readable label is DERIVED from the mandate — not the other way round.
   * Anything that starts reading this string to make a decision has inverted the
   * dependency and reintroduced the exact failure the fabric exists to prevent.
   */
  mandate_label: string;
}

interface RawEntry {
  id?: unknown;
  enabled?: unknown;
  display_name?: unknown;
  principal?: unknown;
  mandate_label?: unknown;
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
    const mandate_label = str(e.mandate_label);
    if (!id || !display_name || !principal || !mandate_label) continue;
    members.push({ id, display_name, principal, mandate_label });
  }
  return members;
}
