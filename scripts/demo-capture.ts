// Scripted demo capture — records the S0.2 (resume) and S0.3 (streamed turn) exit
// criteria as video with no human at the keyboard, so a slice's clip is a command and
// not a filming session (roadmap §11.1: every slice closes with a recording). Playwright
// writes video from the browser context directly, which needs no display server and no
// screenshot path — the mechanism that defeated S0.2/S0.3/T1. Playwright is
// **developer-local tooling and never a repo dependency**: install it in a directory
// outside this tree (`npm i playwright && npx playwright install chromium`), point
// PLAYROOM_CAPTURE_HOME at that directory, then run `pnpm tsx scripts/demo-capture.ts all`.
//
// FILM A PRODUCTION BUILD, NOT THE DEV SERVER (closes A4-F6 — the Next.js dev badge
// sat in the corner of every A4 clip):
//   pnpm --filter @playroom/web build && pnpm --filter @playroom/web start   # port 3000
//   pnpm --filter @playroom/api dev                                          # port 3001
// The script refuses to record if it detects the dev overlay, rather than producing a
// clip with a badge in it. Videos land in $PLAYROOM_CAPTURE_HOME/videos,
// outside the repo; `videos/` and `*.webm` are gitignored so a stray run cannot be
// committed. Every beat asserts — a take that cannot observe the socket drop, the
// replay, or the tokens+cost footer fails loudly instead of recording nothing.
//
// The app is filmed exactly as it is. Nothing here asks it to behave differently for
// the camera: selectors are structural, and the only intervention is cutting one
// client's wire.

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LiveCaptureRefused,
  assertLiveMandateHash,
  resolveLiveTarget,
  type LiveTarget,
} from './capture-live.js';

const API = process.env.PLAYROOM_API_URL ?? 'http://localhost:3001';
const WEB = process.env.PLAYROOM_WEB_URL ?? 'http://localhost:3000';
const SIZE = { width: 1280, height: 800 };

// Pacing law: nothing faster than a human could read.
const BEAT = 450;
const SETTLE = 1500;
const HOLD = 3000;
const TYPE_DELAY = 55;

// A reused room id silently inherits the previous take's messages (POST /rooms is
// idempotent on id), so each run gets its own stamp. Everything stays under `a4-` so
// cleanup is one `DELETE ... WHERE room_id LIKE 'a4-%'`.
const RUN = Date.now().toString(36);

// A4-F7: the short prompt answers in ~1.4s, which is a blink on camera — the
// token-by-token fill is the content of the S0.3 clip, so it has to last long enough
// to read. The long prompt is the default as of S-UI; the short one stays available
// as `clipBShort` because it is the prompt the P0 brief names.
const PROMPT_LONG =
  '@claude walk me through, step by step, what happens between me pressing send on this message and your first token appearing on my screen — name each layer it passes through and what could go wrong at each one';
const PROMPT_SHORT = '@claude explain what this room does in three short sentences';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]): void =>
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

class BeatError extends Error {}
function must(cond: boolean, msg: string): void {
  if (!cond) throw new BeatError(`BEAT FAILED: ${msg}`);
}

function captureHome(): string {
  const home = process.env.PLAYROOM_CAPTURE_HOME;
  if (!home) {
    throw new Error(
      'PLAYROOM_CAPTURE_HOME is not set.\n' +
        '  Playwright is developer-local and never a repo dependency. Install it outside this tree:\n' +
        '    mkdir ../playroom-capture && cd ../playroom-capture\n' +
        '    npm i playwright && npx playwright install chromium\n' +
        '  then re-run with PLAYROOM_CAPTURE_HOME=<that directory>',
    );
  }
  return home.replace(/\\/g, '/');
}

function loadChromium(home: string): any {
  try {
    return createRequire(`${home}/package.json`)('playwright').chromium;
  } catch (err) {
    throw new Error(
      `could not resolve "playwright" from ${home}: ${(err as Error).message}\n` +
        '  Run `npm i playwright && npx playwright install chromium` in that directory.',
    );
  }
}

interface RoomRow {
  id: string;
  title: string;
}

// POST /rooms slugifies the requested id (createRoom.ts: lowercase, non-alnum → '-').
// Callers must use the id in the RESPONSE: the ws route accepts any room id, and a send
// into a room that does not exist is dropped with no client error and no server log, so
// an un-normalised id looks exactly like a working room that eats every message.
async function createRoom(id: string, title: string): Promise<RoomRow> {
  const res = await fetch(`${API}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, title }),
  });
  must(res.status === 201, `POST /rooms expected 201, got ${res.status}`);
  const room = (await res.json()) as RoomRow;
  must(typeof room.id === 'string' && room.id.length > 0, 'no room id in POST /rooms response');
  if (room.id !== id) log(`  note: requested id "${id}" normalised to "${room.id}"`);
  return room;
}

// Playwright's types are deliberately unavailable here: it is developer-local and never
// a repo dependency, so there is no `@types` surface to import. Browser/page/locator
// values are therefore `any` by necessity, not by shortcut. Note that `scripts/` is not
// currently reachable from the root tsconfig, so `tsc -b` does not check this file at
// all — see the A4 report; wiring scripts/ in is its own change.
const connPill = (page: any): any => page.locator('.conn');
const items = (page: any): any => page.locator('ul.transcript li');
const bodyInput = (page: any): any => page.locator('input[placeholder="message"]');
const authorInput = (page: any): any => page.locator('input[placeholder="you"]');
const sendBtn = (page: any): any => page.locator('button[type="submit"]');

// S-UI replaced the bare status dot with a labelled connection state. The pill's
// class carries it: conn-connected | conn-reconnecting | conn-refused. Reading the
// class rather than the text avoids depending on CSS text-transform.
async function waitForConn(page: any, state: string, timeout = 20_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const cls: string = (await connPill(page).getAttribute('class')) ?? '';
    if (cls.split(/\s+/).includes(`conn-${state}`)) return Date.now() - started;
    await sleep(120);
  }
  const cls: string = (await connPill(page).getAttribute('class')) ?? '(none)';
  throw new BeatError(`connection never reached "${state}" within ${timeout}ms (class "${cls}")`);
}

async function waitForItemCount(page: any, n: number, timeout = 25_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if ((await items(page).count()) >= n) return Date.now() - started;
    await sleep(120);
  }
  throw new BeatError(
    `expected >= ${n} items within ${timeout}ms, saw ${await items(page).count()}`,
  );
}

async function sendMessage(page: any, text: string): Promise<void> {
  await bodyInput(page).click();
  await bodyInput(page).pressSequentially(text, { delay: TYPE_DELAY });
  await sleep(BEAT);
  await sendBtn(page).click();
}

interface Wire {
  dark: boolean;
  live: any;
  connects: number;
  refused: number;
}

// Clip A — S0.2. The observer's video is the point: the gap fills itself in on reconnect.
async function clipA(browser: any, take: number, out: string): Promise<unknown> {
  const dir = resolve(out, `clipA-take${take}`);
  mkdirSync(dir, { recursive: true });
  const room = await createRoom(`a4-clipa-t${take}-${RUN}`, `A4 clip A — resume (take ${take})`);
  const roomId = room.id;
  log(`clipA take${take}: room ${roomId}`);

  // Severing one client's socket:
  //   - context.route(...).abort() does not apply — route() never sees WebSockets.
  //   - context.setOffline(true) does NOT drop an already-established WebSocket in
  //     Chromium 151 (measured: the dot stayed green for a full 20s).
  // routeWebSocket proxies the real socket, so it can be cut on command and reconnects
  // refused while dark. Server, events and replay are real; only the wire is cut.
  const mk = async (label: string, wire: Wire | null): Promise<any> => {
    const ctx = await browser.newContext({
      viewport: SIZE,
      recordVideo: { dir: resolve(dir, label), size: SIZE },
    });
    const page = await ctx.newPage();
    if (wire) {
      await page.routeWebSocket(/\/rooms\/.*\/ws/, (ws: any) => {
        if (wire.dark) {
          wire.refused += 1;
          ws.close();
          return;
        }
        ws.connectToServer();
        wire.live = ws;
        wire.connects += 1;
      });
    }
    await page.goto(`${WEB}/r/${roomId}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page, video: page.video() };
  };

  const wire: Wire = { dark: false, live: null, connects: 0, refused: 0 };
  const A = await mk('A-sender', null);
  const B = await mk('B-observer', wire);
  const beats: Record<string, unknown> = {};

  try {
    await waitForConn(A.page, 'connected');
    await waitForConn(B.page, 'connected');
    await authorInput(A.page).fill('prince');
    await authorInput(B.page).fill('watcher');
    await sleep(SETTLE);

    for (const text of [
      'morning — starting the resume check',
      'both windows are live',
      'watch this one survive the drop',
    ]) {
      await sendMessage(A.page, text);
      await sleep(1500);
    }
    beats.bSawFirstThree = await waitForItemCount(B.page, 3);
    must((await items(A.page).count()) === 3, 'A should render exactly 3 messages before the drop');
    log(`  both at 3 messages (B caught up in ${beats.bSawFirstThree}ms)`);
    await sleep(BEAT);

    must(wire.live !== null, 'B never established a routed socket');
    wire.dark = true;
    await wire.live.close();
    beats.bWentDark = await waitForConn(B.page, 'reconnecting');
    log(`  B severed — dot went red in ${beats.bWentDark}ms`);
    await sleep(SETTLE);

    for (const text of ['message four — B cannot see this yet', 'message five — still dark']) {
      await sendMessage(A.page, text);
      await sleep(1500);
    }
    await waitForItemCount(A.page, 5);
    const bDuringDark = await items(B.page).count();
    must(bDuringDark === 3, `B must still show 3 while dark, showed ${bDuringDark}`);
    log(`  A at 5, B held at ${bDuringDark} — the gap is real`);
    await sleep(BEAT);

    must(wire.refused > 0, 'no reconnect attempt was refused — B may not have been dark');
    wire.dark = false;
    beats.bReconnectsRefusedWhileDark = wire.refused;
    beats.bReconnected = await waitForConn(B.page, 'connected', 30_000);
    beats.bReplayed = await waitForItemCount(B.page, 5, 30_000);
    log(`  B reconnected in ${beats.bReconnected}ms, replayed to 5 in ${beats.bReplayed}ms`);

    // Correctness of the replay, not merely the count: order, and no duplicates.
    const bTexts: string[] = await items(B.page).allInnerTexts();
    const aTexts: string[] = await items(A.page).allInnerTexts();
    must(bTexts.length === 5, `B should render exactly 5 items, rendered ${bTexts.length}`);
    must(
      JSON.stringify(bTexts) === JSON.stringify(aTexts),
      `B's replayed list must match A's exactly.\n  A: ${JSON.stringify(aTexts)}\n  B: ${JSON.stringify(bTexts)}`,
    );
    must(new Set(bTexts).size === 5, `B has duplicate rows: ${JSON.stringify(bTexts)}`);

    await sleep(HOLD);
    return { roomId, dir, beats, aTexts, bTexts };
  } finally {
    await A.ctx.close();
    await B.ctx.close();
    await A.video.saveAs(resolve(dir, `clipA-take${take}-A-sender.webm`)).catch(() => {});
    await B.video.saveAs(resolve(dir, `clipA-take${take}-B-observer.webm`)).catch(() => {});
  }
}

// Clip B — S0.3. Hold through the whole stream; the token-by-token fill is the content.
// The short prompt answers in ~1.4s, which is honest but barely legible on camera, so
// `clipBLong` exists as a second, watchable take. Neither is a substitute for the other.
async function clipB(
  browser: any,
  take: number,
  out: string,
  prompt: string = PROMPT_LONG,
  label = 'clipB',
): Promise<unknown> {
  const dir = resolve(out, `${label}-take${take}`);
  mkdirSync(dir, { recursive: true });
  const room = await createRoom(
    `a4-${label.toLowerCase()}-t${take}-${RUN}`,
    `A4 ${label} — streaming turn (take ${take})`,
  );
  const roomId = room.id;
  log(`${label} take${take}: room ${roomId}`);

  const ctx = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: resolve(dir, 'stream'), size: SIZE },
  });
  const page = await ctx.newPage();
  const video = page.video();
  const beats: Record<string, unknown> = {};

  try {
    await page.goto(`${WEB}/r/${roomId}`, { waitUntil: 'domcontentloaded' });
    await waitForConn(page, 'connected');
    await authorInput(page).fill('prince');
    await sleep(SETTLE);

    const t0 = Date.now();
    await sendMessage(page, prompt);
    await waitForItemCount(page, 2, 30_000);

    // The ▍ caret renders only while streaming is true.
    const caret = page.locator('.caret');
    let sawCaret = false;
    for (let i = 0; i < 100 && !sawCaret; i++) {
      sawCaret = (await caret.count()) > 0;
      if (!sawCaret) await sleep(100);
    }
    beats.sawStreamingCaret = sawCaret;

    // The telemetry footer renders only on !streaming with tokens/cost present, so it
    // is the honest end-of-turn marker.
    const footer = page.locator('.meter');
    const started = Date.now();
    while (Date.now() - started < 90_000) {
      if ((await footer.count()) > 0 && (await caret.count()) === 0) break;
      await sleep(150);
    }
    must((await footer.count()) > 0, 'telemetry footer (tokens + cost) never rendered');
    must((await caret.count()) === 0, 'streaming caret never cleared — turn did not complete');
    beats.streamCompleted = Date.now() - t0;

    const footerText = (await footer.first().innerText()).trim();
    const bubble = (await items(page).nth(1).innerText()).trim();
    must(/\d+→\d+ tok/.test(footerText), `footer should show "N→M tok", got "${footerText}"`);
    must(bubble.length > 40, `agent reply looks empty: "${bubble}"`);
    log(`  turn completed in ${beats.streamCompleted}ms — footer: ${footerText}`);

    await sleep(HOLD);
    return { roomId, dir, beats, footerText };
  } finally {
    await ctx.close();
    await video.saveAs(resolve(dir, `${label}-take${take}-stream.webm`)).catch(() => {});
  }
}

// The web tier SLEEPS (auto_stop=suspend, min=0). A capture that opens on a loading spinner because the
// machine was asleep is an accurate recording of a bad first impression — a separate finding, not this
// artifact. So warm both tiers to a good state BEFORE the browser opens, or refuse loudly.
async function warmTier(target: LiveTarget): Promise<number> {
  const started = Date.now();
  const deadline = started + 60_000;
  let webOk = false;
  let apiOk = false;
  while (Date.now() < deadline && !(webOk && apiOk)) {
    try {
      apiOk =
        ((await fetch(`${target.api}/health`).then((r) => r.json())) as { ok?: boolean }).ok ===
        true;
    } catch {
      apiOk = false;
    }
    try {
      webOk = (await fetch(`${target.web}/`)).status < 500;
    } catch {
      webOk = false;
    }
    if (!(webOk && apiOk)) await sleep(1000);
  }
  if (!(webOk && apiOk)) {
    throw new LiveCaptureRefused(`tier did not warm within 60s (web=${webOk}, api=${apiOk})`);
  }
  return Date.now() - started;
}

// Clip MANDATE — UI3-4. Enrolment through to the mandate surface, at 390px, against the LIVE tier, via a
// redeemed code. The film is not the proof; the LIVENESS ASSERTION is: the mandate_hash on screen must
// equal the one the live /members endpoint returns at capture time, or the run aborts. A capture that
// looks right but recorded a local surface is the one thing this exists to prevent.
async function clipMandate(
  browser: any,
  take: number,
  out: string,
  target: LiveTarget,
  code: string,
  displayName: string,
): Promise<unknown> {
  const dir = resolve(out, `mandate-take${take}`);
  mkdirSync(dir, { recursive: true });
  const PHONE = { width: 390, height: 844 }; // read on a phone before it is ever read on a laptop
  const ctx = await browser.newContext({
    viewport: PHONE,
    recordVideo: { dir: resolve(dir, 'stream'), size: PHONE },
  });
  const page = await ctx.newPage();
  const video = page.video();
  const beats: Record<string, unknown> = {};

  try {
    // ENROLMENT — REDEEMED OFF-CAMERA, ON PURPOSE. A room code is a claim on an identity until it is
    // spent, and step 13 forbids a code in any frame — so the redemption happens over the wire here (the
    // code is spent, never typed on screen), and its credential is installed as the tester's session
    // cookie. The FILM then shows what a real tester sees AFTER the door: the enrolment screen, then the
    // room where their member has appeared, then the surface. No owner shortcut, no injected mandate —
    // the same credential the redemption issued.
    const redeemRes = await fetch(`${target.api}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, display_name: displayName }),
    });
    must(redeemRes.status === 200, `redeem expected 200, got ${redeemRes.status}`);
    const redeemed = (await redeemRes.json()) as { token?: string; room_id?: string };
    const token = redeemed.token ?? '';
    const roomId = redeemed.room_id ?? '';
    must(token.length > 0 && roomId.length > 0, 'redeem did not return a token and a room');
    log(`  redeemed "${displayName}" into room ${roomId} (off-camera — the code is never filmed)`);

    // Install the credential as the browser's own session cookie: from here the browser IS the tester.
    const host = new URL(target.web).host;
    await ctx.addCookies([
      {
        name: 'playroom_member',
        value: token,
        domain: host,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);

    // The enrolment door — filmed empty, as the tester's entry point (never the code).
    await page.goto(`${target.web}/join`, { waitUntil: 'domcontentloaded' });
    await sleep(HOLD);
    // …then the room their redemption enrolled them into.
    await page.goto(`${target.web}/r/${encodeURIComponent(roomId)}`, {
      waitUntil: 'domcontentloaded',
    });

    await waitForConn(page, 'connected');
    await sleep(SETTLE);

    // THE MEMBER APPEARS, THE SURFACE OPENS. Scope to ONE chip that carries a mandate — the human tester
    // has none, the agents do — and read the member id, the surface and the hash all from THAT SAME chip.
    // Reading the id from a different chip than the one whose hash is checked would compare two members.
    const chip = page.locator('[data-pr="roster-member"]:has(details.mandate)').first();
    must((await chip.count()) > 0, 'no roster member carries a mandate to surface');
    const memberId = await chip.getAttribute('data-pr-member');
    must(!!memberId, 'the mandate-bearing chip has no member id');
    await chip.locator('details.mandate summary').click();
    await sleep(SETTLE);
    const surface = chip.locator('[data-pr="mandate-surface"]');
    must((await surface.count()) > 0, 'mandate surface did not render');
    for (const field of [
      'mandate-status',
      'mandate-cosign',
      'mandate-limits',
      'mandate-policy',
      'mandate-hash',
    ]) {
      must((await chip.locator(`[data-pr="${field}"]`).count()) > 0, `surface is missing ${field}`);
    }
    beats.surfaceRendered = true;

    // Read the on-screen hash (the full, copyable value — not the truncated display) FROM THAT chip.
    const onScreen = (
      await chip.locator('[data-pr="mandate-hash"] .mandate-hash-full').innerText()
    ).trim();

    // ── THE LIVENESS ASSERTION — the slice ─────────────────────────────────────────────
    // Fetch /members from the LIVE api with the tester's own credential, and compare. Mismatch aborts.
    const membersRes = await fetch(`${target.api}/rooms/${encodeURIComponent(roomId)}/members`, {
      headers: { authorization: `Bearer ${token}` },
    });
    must(membersRes.status === 200, `live /members expected 200, got ${membersRes.status}`);
    const membersBody = (await membersRes.json()) as {
      members?: Array<{ id: string; mandate_hash: string | null }>;
    };
    const liveness = assertLiveMandateHash(onScreen, membersBody, memberId as string); // throws on mismatch
    beats.liveness = liveness;
    log(
      `  LIVENESS FIRED — ${liveness.member}: screen == live (${liveness.onScreen.slice(0, 20)}…)`,
    );

    await sleep(HOLD);
    return { roomId, dir, beats, memberId, target };
  } finally {
    await ctx.close();
    await video.saveAs(resolve(dir, `mandate-take${take}-stream.webm`)).catch(() => {});
  }
}

// Clip BRIEFING — S-LIVE. The room briefing rendered, a summoned member's reply that read it, and the
// order's task on the loops screen: at 390px, against the LIVE tier, in a room that has an owner.
//
// THE LIVENESS ASSERTION IS THE POINT, exactly as it is for the mandate clip. The briefing text on
// screen must equal the one the LIVE api returns for that room at capture time — read through the web
// app's own history route, from inside the page, so a local surface cannot masquerade as this one.
//
// WHAT IS NOT FILMED, AND WHY: the briefing being SET. There is no control for it anywhere in the web
// app — S1.7 shipped the record, the delivery and the render, and set/clear are WebSocket frames with
// no surface (grep `briefing_set` under apps/web: nothing). So a film of a person setting one would
// have to be a film of something that does not exist. The ROW the set produces is filmed instead, and
// the gap is reported rather than staged.
async function clipBriefing(
  browser: any,
  take: number,
  out: string,
  target: LiveTarget,
  roomId: string,
): Promise<unknown> {
  const dir = resolve(out, `briefing-take${take}`);
  mkdirSync(dir, { recursive: true });
  const PHONE = { width: 390, height: 844 };
  const ctx = await browser.newContext({
    viewport: PHONE,
    recordVideo: { dir: resolve(dir, 'stream'), size: PHONE },
  });
  const page = await ctx.newPage();
  const video = page.video();
  const beats: Record<string, unknown> = {};

  try {
    // 1. THE ROOM, as a phone opens it.
    await page.goto(`${target.web}/r/${encodeURIComponent(roomId)}`, {
      waitUntil: 'domcontentloaded',
    });
    must(page.url().startsWith(target.web), `the page left the live origin: ${page.url()}`);
    await page.waitForSelector('[data-pr="briefing"]', { timeout: 30_000 });
    await sleep(SETTLE);

    // 2. LIVENESS — the rendered briefing against what the LIVE api says, fetched from inside the page
    //    through the app's own route. Mismatch aborts the run rather than recording a pretty lie.
    const onScreen = (await page.locator('[data-pr="briefing-body"]').first().innerText()).trim();
    const fromApi = await page.evaluate(async (rid: string) => {
      const res = await fetch(`/api/history?room=${encodeURIComponent(rid)}`);
      const body = (await res.json()) as { briefing?: { content?: string } | null };
      return body.briefing?.content ?? '';
    }, roomId);
    must(fromApi.length > 0, 'the live api returned no briefing for this room');
    must(
      onScreen === fromApi.trim(),
      `the briefing on screen is not the live one:\n  screen: ${onScreen}\n  api:    ${fromApi}`,
    );
    beats.briefing = { rendered: onScreen, matches_live_api: true };
    log(`  briefing on screen matches the live api (${onScreen.length} chars)`);
    await sleep(HOLD);

    // 3. A SUMMONED MEMBER'S REPLY, on the live tier, with the briefing in its window. A real turn:
    //    a real provider call, metered, on the deployment's own key.
    const turnsBefore = await page.locator('[data-pr="turn"]').count();
    await page
      .locator('[data-pr="composer"] textarea, [data-pr="composer"] input')
      .first()
      .fill('@claude in one sentence, what does the room briefing ask you to do?');
    await page.locator('[data-pr="composer"] button[type="submit"]').first().click();
    await page.waitForFunction(
      (n: number) => document.querySelectorAll('[data-pr="turn"]').length > n,
      turnsBefore,
      { timeout: 90_000 },
    );
    // WAIT FOR THE TURN TO FINISH, not merely to appear. The row exists at the FIRST delta, so
    // reading it then captures the streaming caret and calls it a reply — take 1 of this clip did
    // exactly that and recorded "▌". The caret is present only while streaming, and the spend line
    // only once the turn completed, so both conditions together mean "this is the whole answer".
    await page.waitForFunction(
      () => {
        const last = document.querySelectorAll('[data-pr="turn"]');
        const el = last[last.length - 1];
        if (!el) return false;
        return !el.querySelector('[data-pr="caret"]') && !!el.querySelector('[data-pr="spend"]');
      },
      undefined,
      { timeout: 120_000 },
    );
    const reply = (
      await page.locator('[data-pr="turn"]').last().locator('[data-pr="body"]').innerText()
    ).trim();
    must(reply.length > 0, 'the summoned member produced an empty reply');
    must(reply !== '▌', 'the caret was captured instead of the reply — the turn had not finished');
    beats.reply = reply;
    log(`  live reply: ${reply.slice(0, 120)}`);
    await sleep(HOLD);

    // 4. THE ORDER'S TASK, on the loops screen — what the loop is for, where a person edits loops.
    await page.goto(`${target.web}/r/${encodeURIComponent(roomId)}/loops`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('[data-pr="loop-row"]', { timeout: 30_000 });
    const task = (await page.locator('[data-pr="loop-task"]').first().innerText()).trim();
    must(task.length > 0, 'the loops screen rendered no task');
    must(!/no task/i.test(task), `the order on screen has no task: ${task}`);
    beats.task = task;
    log(`  order task on screen: ${task.slice(0, 120)}`);
    await sleep(HOLD);
  } finally {
    await ctx.close();
    await video?.saveAs(resolve(dir, `briefing-take${take}-stream.webm`)).catch(() => {});
  }
  return { take, room: roomId, beats };
}

// Clip PUSH — S-PUSH SP-4. The IN-PRODUCT half of a notification reaching a person: the control that
// says it is on, and the claim itself sitting in the room the notification pointed at.
//
// WHAT THIS CANNOT FILM, AND WHY THAT IS NOT A GAP IN THE HARNESS. The notification arrives on an
// operating system's lock screen. Playwright drives a browser; there is no browser API that can
// observe an OS notification, and a browser screenshot of one would be a mock-up. The artifact for
// that half is Prince's own device screenshot (15 Aug 2026, 11:23 BST) — a photograph of the thing
// happening, which is the only honest evidence available for it. This clip films everything on the
// Playroom side of that boundary and claims nothing about the other side.
/**
 * A fresh browser must meet the OFFER or an honest "cannot" — never an already-granted state, and
 * never a dead toggle.
 *
 * Headless Chromium reports Notification.permission as "denied" by default, so what this clip
 * actually films is the BLOCKED copy: "notifications are blocked for this site — turn them back on
 * in your browser settings". That is the right thing to film. It is a control telling the truth
 * about a permission it does not own, in the one state where a lesser implementation would show a
 * switch that silently does nothing.
 */
function offersTheChoiceHonestly(text: string): boolean {
  return /notify me when something needs me|blocked for this site|cannot receive notifications|not configured/i.test(
    text,
  );
}

async function clipPush(
  browser: any,
  take: number,
  out: string,
  target: LiveTarget,
  roomId: string,
): Promise<unknown> {
  const dir = resolve(out, `push-take${take}`);
  mkdirSync(dir, { recursive: true });
  const PHONE = { width: 390, height: 844 };
  const ctx = await browser.newContext({
    viewport: PHONE,
    recordVideo: { dir: resolve(dir, 'stream'), size: PHONE },
  });
  const page = await ctx.newPage();
  const video = page.video();
  const beats: Record<string, unknown> = {};

  try {
    await page.goto(`${target.web}/r/${encodeURIComponent(roomId)}`, {
      waitUntil: 'domcontentloaded',
    });
    must(page.url().startsWith(target.web), `the page left the live origin: ${page.url()}`);

    // 1. THE CONTROL, OFFERING THE CHOICE. This browser is NOT the subscribed device — it is a fresh
    //    context with no service worker and no permission — so what it correctly shows is the OFFER:
    //    "notify me when something needs me". That is the state worth filming anyway, because it is
    //    the state every new viewer meets, and it is the proof that the prompt is asked for rather
    //    than sprung: nothing has been requested at this point, and nothing will be until a tap.
    //    The subscribed state ("on · 1 device") is on Prince's phone, which no browser can film.
    await page.waitForSelector('[data-pr="push-control"]', { timeout: 30_000 });
    const control = (await page.locator('[data-pr="push-control"]').first().innerText()).trim();
    must(control.length > 0, 'the notification control rendered empty');
    must(
      offersTheChoiceHonestly(control),
      `the control is in an unexpected state for a fresh browser: "${control}"`,
    );
    beats.control = control;
    log(`  notification control (fresh browser): ${control}`);
    await sleep(HOLD);

    // 2. THE CLAIM IN THE ROOM. The interrupt the notification was about — the thing a person opens
    //    the room to find. LIVENESS: the chip on screen must be an interrupt the live api knows.
    await page.waitForSelector('[data-pr="interrupt"]', { timeout: 30_000 });
    const chip = page.locator('[data-pr="interrupt"]').last();
    const summary = (await chip.innerText()).trim();
    must(summary.length > 0, 'the interrupt chip rendered empty');
    const fromApi = await page.evaluate(async (rid: string) => {
      const res = await fetch(`/api/history?room=${encodeURIComponent(rid)}&limit=200`);
      const body = (await res.json()) as {
        events?: Array<{ event_type: string; payload?: { urgency?: string } }>;
      };
      return (body.events ?? []).filter((e) => e.event_type === 'interrupt.raised').length;
    }, roomId);
    must(fromApi > 0, 'the live api reports no raised interrupt for this room');
    beats.interrupts_live = fromApi;
    beats.chip = summary.replace(/\s+/g, ' ').slice(0, 160);
    log(`  interrupt chip on screen, and the live api reports ${fromApi} raised`);
    await sleep(HOLD);
  } finally {
    await ctx.close();
    await video?.saveAs(resolve(dir, `push-take${take}-stream.webm`)).catch(() => {});
  }
  return { take, room: roomId, beats };
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'all';
  const takeArg = process.argv[3];
  const home = captureHome();
  const out = resolve(home, 'videos');
  mkdirSync(out, { recursive: true });

  // ── THE LIVE MANDATE-SURFACE CAPTURE (UI3-4) — explicit live target, fail-loud, no default ──
  // This path never touches the localhost defaults below: the live target is resolved from explicit env
  // or the run refuses, and it is printed so a viewer of the artifact can see what was filmed.
  if (which === 'mandate') {
    const target = resolveLiveTarget(process.env); // throws LiveCaptureRefused if unset or local
    log(`LIVE TARGET — api ${target.api} · web ${target.web}`);
    const code = process.env.PLAYROOM_CAPTURE_CODE?.trim();
    if (!code) {
      throw new LiveCaptureRefused(
        'PLAYROOM_CAPTURE_CODE is not set — a live capture needs a redeemable code (mint one first)',
      );
    }
    const name = process.env.PLAYROOM_CAPTURE_NAME?.trim() || 'Tester';
    const warmed = await warmTier(target);
    log(`tier warm in ${warmed}ms`);
    const liveHtml = await fetch(target.web).then((r) => r.text());
    must(
      !/__next_devtools|nextjs-portal|__nextDevClientId|\/_next\/static\/chunks\/react-refresh/.test(
        liveHtml,
      ),
      'the LIVE web is serving a development overlay — refusing to film a dev badge (A4-F6)',
    );
    const browser = await loadChromium(home).launch();
    log(`chromium ${browser.version()}`);
    const take = Number(takeArg ?? 1);
    let report: unknown;
    try {
      report = await clipMandate(browser, take, out, target, code, name);
    } finally {
      await browser.close();
    }
    writeFileSync(
      resolve(out, `mandate-run-report-take${take}.json`),
      JSON.stringify({ target, ...(report as object) }, null, 2),
    );
    log(`done — mandate capture at 390px against ${target.web}`);
    log(`videos: ${out}`);
    process.exit(0);
  }

  // ── THE LIVE BRIEFING CAPTURE (S-LIVE) — same discipline as `mandate`: explicit live target, no
  // default, and it films a room that already HAS an owner and a briefing (S17-N3 means most cannot).
  if (which === 'push') {
    const target = resolveLiveTarget(process.env);
    log(`LIVE TARGET — api ${target.api} · web ${target.web}`);
    const roomId = process.env.PLAYROOM_CAPTURE_ROOM?.trim();
    if (!roomId) {
      throw new LiveCaptureRefused(
        'PLAYROOM_CAPTURE_ROOM is not set — this clip films the room a notification pointed at',
      );
    }
    const warmed = await warmTier(target);
    log(`tier warm in ${warmed}ms`);
    const browser = await loadChromium(home).launch();
    const take = Number(takeArg ?? 1);
    let report: unknown;
    try {
      report = await clipPush(browser, take, out, target, roomId);
    } finally {
      await browser.close();
    }
    writeFileSync(
      resolve(out, `push-run-report-take${take}.json`),
      JSON.stringify({ target, ...(report as object) }, null, 2),
    );
    log(`done — push capture at 390px against ${target.web}`);
    process.exit(0);
  }

  if (which === 'briefing') {
    const target = resolveLiveTarget(process.env);
    log(`LIVE TARGET — api ${target.api} · web ${target.web}`);
    const roomId = process.env.PLAYROOM_CAPTURE_ROOM?.trim();
    if (!roomId) {
      throw new LiveCaptureRefused(
        'PLAYROOM_CAPTURE_ROOM is not set — this clip films a specific live room that has an owner, ' +
          'a briefing and a tasked order; there is no sensible default',
      );
    }
    const warmed = await warmTier(target);
    log(`tier warm in ${warmed}ms`);
    const liveHtml = await fetch(target.web).then((r) => r.text());
    must(
      !/__next_devtools|nextjs-portal|__nextDevClientId|\/_next\/static\/chunks\/react-refresh/.test(
        liveHtml,
      ),
      'the LIVE web is serving a development overlay — refusing to film a dev badge (A4-F6)',
    );
    const browser = await loadChromium(home).launch();
    log(`chromium ${browser.version()}`);
    const take = Number(takeArg ?? 1);
    let report: unknown;
    try {
      report = await clipBriefing(browser, take, out, target, roomId);
    } finally {
      await browser.close();
    }
    writeFileSync(
      resolve(out, `briefing-run-report-take${take}.json`),
      JSON.stringify({ target, ...(report as object) }, null, 2),
    );
    log(`done — briefing capture at 390px against ${target.web}`);
    log(`videos: ${out}`);
    process.exit(0);
  }

  const health = (await fetch(`${API}/health`).then((r) => r.json())) as { ok?: boolean };
  must(health.ok === true, `API not healthy: ${JSON.stringify(health)} — is the api running?`);
  log(`API healthy at ${API}`);

  // A4-F6: every A4 clip carried the Next.js dev badge because they were filmed
  // against `next dev`. Refuse to record rather than produce another one. The badge
  // is injected by the dev overlay, whose script Next only serves in development.
  const html = await fetch(WEB).then((r) => r.text());
  const isDev =
    /__next_devtools|nextjs-portal|__nextDevClientId|\/_next\/static\/chunks\/react-refresh/.test(
      html,
    );
  must(
    !isDev,
    'the web app is running in DEVELOPMENT mode — clips would carry the Next.js dev badge (A4-F6).\n' +
      '  Build and serve production instead:\n' +
      '    pnpm --filter @playroom/web build && pnpm --filter @playroom/web start',
  );
  log(`web is a production build at ${WEB}`);

  const browser = await loadChromium(home).launch();
  log(`chromium ${browser.version()}`);

  const plan: Array<[string, number]> =
    which === 'all'
      ? [
          ['clipA', 1],
          ['clipA', 2],
          ['clipA', 3],
          ['clipB', 1],
          ['clipB', 2],
          ['clipB', 3],
        ]
      : [[which, Number(takeArg ?? 1)]];

  const results: unknown[] = [];
  for (const [clip, take] of plan) {
    try {
      const r =
        clip === 'clipA'
          ? await clipA(browser, take, out)
          : clip === 'clipBShort'
            ? await clipB(browser, take, out, PROMPT_SHORT, 'clipBShort')
            : await clipB(browser, take, out);
      results.push({ clip, take, status: 'ok', ...(r as object) });
      log(`✓ ${clip} take${take}`);
    } catch (err) {
      results.push({ clip, take, status: 'failed', error: (err as Error).message });
      log(`✗ ${clip} take${take}: ${(err as Error).message}`);
    }
    await sleep(1000);
  }

  await browser.close();
  writeFileSync(resolve(out, 'run-report.json'), JSON.stringify(results, null, 2));
  const ok = results.filter((r) => (r as { status: string }).status === 'ok').length;
  log(`done — ${ok}/${results.length} takes passed every beat`);
  log(`videos: ${out}`);
  process.exit(ok === results.length ? 0 : 1);
}

main().catch((err: Error) => {
  console.error('FATAL', err.message);
  process.exit(2);
});
