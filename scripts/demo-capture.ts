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

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'all';
  const takeArg = process.argv[3];
  const home = captureHome();
  const out = resolve(home, 'videos');
  mkdirSync(out, { recursive: true });

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
