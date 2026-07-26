import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { loadMandates } from '@playroom/fabric';
import { principalAccent } from './mandate';

// SERVER ONLY. This module reads the filesystem; it must never be imported from a
// component marked 'use client'. The roster is resolved on the server and handed to
// the room as props — no YAML parser and no config file ever reaches the browser.
//
// Until S1.1 lands a real membership model, adapters.yaml doubles as the roster and also
// carries the principals block. Projected out of it: `id`, `display_name`, `principal`, and
// each principal's `display_name`. `provider` and `model` are deliberately NOT projected, so
// the §6 rule — the room, fabric and data model never contain a provider name — survives the
// web app reading this file at all. (`mandate_label` was projected once and is gone: M-3
// deleted it because it described authority without being it.)

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
  /**
   * The principal's DISPLAY NAME, or null if config does not name them.
   *
   * Null renders no affiliation at all. It never falls back to the identifier: putting
   * `principal:jerry` on screen is the same category error as `mandate_label` was, and the
   * same rule applies as for a missing mandate — no data, no claim.
   */
  principal_name: string | null;
  /**
   * Which accent this member inherits from its principal, or null if unaffiliated.
   *
   * This is what answers "whose authority does this agent carry" without a sentence. An
   * agent shares its principal's colour, so the question is answered by looking rather
   * than reading — and it keeps working in a room with four principals, where a clause per
   * member would not fit.
   */
  accent: number | null;
}

interface RawEntry {
  id?: unknown;
  enabled?: unknown;
  display_name?: unknown;
  principal?: unknown;
}

interface RawPrincipal {
  id?: unknown;
  display_name?: unknown;
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

export interface Principal {
  id: string;
  display_name: string;
  accent: number;
}

/**
 * The principals config declares, in declared order — THE ORDER IS THE ACCENT ASSIGNMENT.
 *
 * An entry missing either field is skipped rather than defaulted, so a typo produces a
 * member with no affiliation shown rather than one affiliated to nothing in particular. A
 * duplicate id is ignored: the first declaration wins, so a second copy cannot silently
 * re-colour a principal already on screen.
 *
 * Exported because the DECISION card needs it too — `required_signer` is a principal id and
 * must render as a name there for the same reason it does on a chip.
 */
export function loadPrincipals(): Principal[] {
  const parsed: unknown = parse(readFileSync(yamlPath(), 'utf8'));
  const obj =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const raw = Array.isArray(obj['principals']) ? (obj['principals'] as RawPrincipal[]) : [];
  const out: Principal[] = [];
  const seen = new Set<string>();
  for (const rp of raw) {
    const id = str(rp.id);
    const display_name = str(rp.display_name);
    if (!id || !display_name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, display_name, accent: principalAccent(out.length) });
  }
  return out;
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
  const obj =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const entries = Array.isArray(obj['adapters']) ? (obj['adapters'] as RawEntry[]) : [];

  const principals = new Map(loadPrincipals().map((p) => [p.id, p]));

  const members: RosterMember[] = [];
  for (const e of entries) {
    if (e.enabled === false) continue; // a disabled adapter is not in the room
    const id = str(e.id);
    const display_name = str(e.display_name);
    const principal = str(e.principal);
    if (!id || !display_name || !principal) continue;
    const m = mandates.get(id)?.mandate;
    const p = principals.get(principal);
    members.push({
      id,
      display_name,
      principal,
      principal_name: p?.display_name ?? null,
      accent: p?.accent ?? null,
      scope: m?.scope ?? null,
      protected_actions: m?.protected_actions ?? null,
    });
  }
  return members;
}
