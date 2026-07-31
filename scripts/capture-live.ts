// The honest core of a LIVE capture — the two decisions that make "captured against the live fabric"
// provable rather than asserted (UI3-4). Pure and side-effect-free on import, so a test can exercise
// them without Playwright, a browser, or a running tier — which is the whole point: the mechanism that
// prevents a convincing-but-local film has to itself be checkable.
//
// scripts/ is not in `tsc -b` (A4-F3), so this file is not typechecked by `pnpm verify`; its test is,
// at runtime, by vitest — which is why the logic that MATTERS lives here as plain functions rather than
// inline in the Playwright harness where nothing could reach it.

/** Why a live capture refused to run. A named reason, never a silent fallback. */
export class LiveCaptureRefused extends Error {
  constructor(readonly reason: string) {
    super(`live capture refused: ${reason}`);
    this.name = 'LiveCaptureRefused';
  }
}

export interface LiveTarget {
  api: string;
  web: string;
}

/**
 * Resolve the LIVE target from explicit env, NEVER from a default. A localhost value is refused as
 * loudly as an absent one: the failure this guards is a run that quietly filmed a dev server and was
 * believed. The resolved target is returned so the harness can print it into the run — a viewer of the
 * artifact must be able to see what was filmed.
 */
export function resolveLiveTarget(env: NodeJS.ProcessEnv): LiveTarget {
  const api = env.PLAYROOM_LIVE_API_URL?.trim();
  const web = env.PLAYROOM_LIVE_WEB_URL?.trim();
  if (!api || !web) {
    throw new LiveCaptureRefused(
      'PLAYROOM_LIVE_API_URL and PLAYROOM_LIVE_WEB_URL must both be set to the live tier — ' +
        'a live capture has no default target, so it cannot silently film localhost',
    );
  }
  for (const [name, value] of [
    ['PLAYROOM_LIVE_API_URL', api],
    ['PLAYROOM_LIVE_WEB_URL', web],
  ] as const) {
    if (!/^https:\/\//.test(value)) {
      throw new LiveCaptureRefused(
        `${name} must be an https:// URL on the live tier, got "${value}"`,
      );
    }
    if (/localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(value)) {
      throw new LiveCaptureRefused(
        `${name} points at a local host ("${value}") — that is not the live tier`,
      );
    }
  }
  return { api, web };
}

/** The result of the liveness check — recorded so a test (and the run report) can prove it FIRED. */
export interface LivenessResult {
  fired: true;
  member: string;
  onScreen: string;
  live: string;
}

interface MembersBody {
  members?: Array<{ id: string; mandate_hash: string | null }>;
}

/**
 * THE LIVENESS ASSERTION — the slice. Compare the `mandate_hash` shown on screen to the one the live
 * `/members` endpoint returns for the same member, AT CAPTURE TIME. A match returns a record proving the
 * comparison fired, with both values; a mismatch (or a member/hash the live tier does not have) throws a
 * named reason and the run aborts. This is what makes the film a recording of the live fabric and not of
 * a local surface, a stub, or a warm cache: the two hashes are the same document or the run does not
 * complete. Returning the record (rather than a bare boolean) is deliberate — a caller that forgets to
 * check still leaves evidence the comparison happened, and the test asserts on `fired` + both values so
 * it cannot pass when the check never executed.
 */
export function assertLiveMandateHash(
  onScreenHash: string,
  membersBody: MembersBody,
  memberId: string,
): LivenessResult {
  const onScreen = onScreenHash.trim();
  if (!onScreen) throw new LiveCaptureRefused('no mandate_hash was read from the screen');
  const members = membersBody.members;
  if (!Array.isArray(members) || members.length === 0) {
    throw new LiveCaptureRefused('the live /members endpoint returned no members to check against');
  }
  const record = members.find((m) => m.id === memberId);
  if (!record) {
    throw new LiveCaptureRefused(
      `the live roster has no member "${memberId}" to verify the surface against`,
    );
  }
  const live = (record.mandate_hash ?? '').trim();
  if (!live) {
    throw new LiveCaptureRefused(`the live roster gives member "${memberId}" no mandate_hash`);
  }
  if (live !== onScreen) {
    throw new LiveCaptureRefused(
      `mandate_hash MISMATCH for "${memberId}": screen=${onScreen} live=${live} — ` +
        'the surface on film is NOT the mandate the live fabric is enforcing',
    );
  }
  return { fired: true, member: memberId, onScreen, live };
}
