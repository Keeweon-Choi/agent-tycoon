/**
 * T-0075 check: what an idle office costs the browser's main thread, and that
 * it costs nothing while it is not on screen. dist/cli.js with an isolated HOME
 * on a spare port, headless Chromium (--disable-gpu, through the shared
 * harness). The assertions are on COUNTS, never milliseconds (machine load
 * varies too much to assert time); the main-thread task time (CDP Performance
 * metrics) is only reported.
 *
 * An init script counts, per page, the rAF ticks, the `drawImage` calls on the
 * office canvas, and the RENDERS: ticks in which the office canvas was drawn on.
 * - desktop 1280x800, S-8 office, nothing moving: at most 1/4 of the rAF ticks
 *   render (60 fps full rate -> at most 15/s), in the median second;
 * - the pointer over the office keeps nearly every tick rendering (full rate),
 *   and ONE pointer move after the idle seconds renders >= 5 of the next 8
 *   ticks (the very next frames are back at the full rate);
 * - phone 393x852 (the shell keeps both pages laid out), reached the way a user
 *   reaches it: a background session's menu -> 대화 -> 터미널로 보기. With the
 *   terminal page in front the office canvas is slid off screen and renders
 *   nothing; back on the office page it renders again.
 * Exit code 1 when any assertion fails (the negative controls: run it against
 * the webview build of main, and against a build whose input wake is disabled).
 *
 *   PROFILE=1 adds a CPU profile of the idle desktop window.
 *   npx tsx cld/test/run-overlay-cost.ts [18258|18259]
 */
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeEngineHome,
  makeFakeHome,
  SPARE_PORTS,
  startDaemon,
} from '../../server/src/cld/testHome.js';

// RUNNERS-FIX: run-all hands out 18256/18257: any spare port will do.
const port = Number(process.argv[2] ?? SPARE_PORTS[2]);
if (!SPARE_PORTS.includes(port)) throw new Error('port must be 18256-18259');
const BASE = `http://127.0.0.1:${port}/`;
const IDLE_SECONDS = 6;
const ACTIVE_MS = 1_500;
const WAKE_TICKS = 8;
const WAKE_MIN_RENDERS = 5;
/** The idle office may render at most this share of the rAF ticks (1/4 of the full rate). */
const IDLE_MAX_SHARE = 0.25;
/** An awake office renders at least this share of the rAF ticks. */
const AWAKE_MIN_SHARE = 0.8;
/** The off-screen office may render this many frames in total. */
const HIDDEN_MAX_RENDERS = 1;
const CHAT_SESSION = 'beta-task';
const PHONE = { width: 393, height: 852 };

type Counts = { draws: number; ticks: number; renders: number };
type Metrics = Record<string, number>;
const failures: string[] = [];

function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) failures.push(what);
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function newPage(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  opts: Parameters<typeof browser.newContext>[0],
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__name = (f: unknown) => f;
    (window as unknown as Record<string, unknown>).__PIXEL_AGENTS_E2E = true;
    const w = window as unknown as Record<string, number>;
    w.__draws = 0;
    w.__ticks = 0;
    w.__renders = 0;
    w.__renderTick = -1;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (this: unknown, ...a: unknown[]) {
      const canvas = (this as CanvasRenderingContext2D).canvas;
      if (canvas.dataset?.testid === 'office-canvas') {
        w.__draws++;
        if (w.__renderTick !== w.__ticks) {
          w.__renderTick = w.__ticks; // the first draw of a tick: one render
          w.__renders++;
        }
      }
      return (draw as (...x: unknown[]) => void).apply(this, a);
    } as typeof draw;
    const tick = () => {
      w.__ticks++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return { ctx, page: await ctx.newPage() };
}

const counts = (page: Page): Promise<Counts> =>
  page.evaluate(() => {
    const w = window as unknown as Record<string, number>;
    return { draws: w.__draws, ticks: w.__ticks, renders: w.__renders };
  });

async function metrics(cdp: CDPSession): Promise<Metrics> {
  return Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
  );
}

type Window = Counts;

/** `seconds` consecutive one-second windows of counts, and the main-thread ms/s. */
async function windows(
  page: Page,
  cdp: CDPSession,
  seconds: number,
): Promise<{ w: Window[]; taskMsPerSec: number }> {
  const m0 = await metrics(cdp);
  const w: Window[] = [];
  for (let i = 0; i < seconds; i++) {
    const a = await counts(page);
    await page.waitForTimeout(1_000);
    const b = await counts(page);
    w.push({ draws: b.draws - a.draws, ticks: b.ticks - a.ticks, renders: b.renders - a.renders });
  }
  const m1 = await metrics(cdp);
  return { w, taskMsPerSec: ((m1.TaskDuration - m0.TaskDuration) * 1000) / seconds };
}

const fmt = (w: Window[]) => w.map((x) => `${x.renders}/${x.ticks}`).join(' ');
const sum = (w: Window[], k: keyof Counts) => w.reduce((s, x) => s + x[k], 0);

/** Keep the office awake with pointer moves over it for a while. */
async function awake(page: Page, x: number, y: number): Promise<Counts> {
  const a = await counts(page);
  for (const end = Date.now() + ACTIVE_MS; Date.now() < end;) {
    await page.mouse.move(x + (Date.now() % 40), y);
    await page.waitForTimeout(8);
  }
  const b = await counts(page);
  return { draws: b.draws - a.draws, ticks: b.ticks - a.ticks, renders: b.renders - a.renders };
}

/** Tap a character until the office follows it and its menu is up (T-0017). The
 *  camera does not start on every character on a phone: its card brings it in view. */
async function selectCharacter(page: Page, name: string) {
  const menu = page.getByRole('menu', { name: `${name} 메뉴` });
  const label = page
    .locator('[data-testid="agent-overlay"]')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
  await label.waitFor();
  const id = Number(await label.getAttribute('data-agent-id'));
  for (let i = 0; i < 12 && (await menu.count()) === 0; i++) {
    if (await page.getByTestId('board-full').count()) await page.keyboard.press('Escape');
    const card = page.locator(`[data-testid="agent-card"][data-agent-id="${id}"]`).first();
    if (await card.count()) await card.tap();
    await page.waitForTimeout(1_200);
    const box = (await label.boundingBox())!;
    const ez = await label.evaluate((el) => el.classList.contains('-translate-y-full'));
    const scale = await page.evaluate(() => {
      const h = (
        window as unknown as {
          __pixelAgentsTestHooks: {
            getTileCenter?: (c: number, r: number) => { x: number } | null;
          };
        }
      ).__pixelAgentsTestHooks;
      const a = h.getTileCenter?.(0, 0);
      const b = h.getTileCenter?.(1, 0);
      return a && b ? (b.x - a.x) / 16 : 2;
    });
    await page.touchscreen.tap(
      box.x + box.width / 2,
      (ez ? box.y + box.height : box.y + 34) + 20 * scale,
    );
    await page.waitForTimeout(500);
  }
  await menu.waitFor({ timeout: 5_000 });
  return menu;
}

async function profile(cdp: CDPSession): Promise<void> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await new Promise((r) => setTimeout(r, 3_000));
  const { profile: prof } = await cdp.send('Profiler.stop');
  const self = new Map<string, number>();
  const dt = (prof.endTime - prof.startTime) / 1000 / prof.samples!.length;
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  for (const id of prof.samples!) {
    const f = byId.get(id)!.callFrame;
    const k = `${f.functionName || '(anon)'} ${path.basename(f.url)}:${f.lineNumber + 1}`;
    self.set(k, (self.get(k) ?? 0) + dt);
  }
  for (const [k, ms] of [...self].sort((x, y) => y[1] - x[1]).slice(0, 15)) {
    console.log(`  ${(ms / 3).toFixed(1)} ms/s  ${k}`);
  }
}

async function main(): Promise<void> {
  await assertPortFree(port);
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  let daemon = startDaemon(fake, port, []);
  const browser = await launchBrowser();
  try {
    // ── Desktop: visible, nothing moving ─────────────────────────
    const desk = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    await desk.page.goto(await daemon.loginUrl());
    await desk.page.waitForURL(BASE);
    await desk.page.locator('[data-testid="office-canvas"]').waitFor();
    await desk.page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await desk.page.mouse.move(5, 790); // off the office's own controls, still on the page
    await desk.page.waitForTimeout(4_000); // spawn effects and first loads settle, grace ends
    const cdp = await desk.ctx.newCDPSession(desk.page);
    await cdp.send('Performance.enable');
    const idle = await windows(desk.page, cdp, IDLE_SECONDS);
    if (process.env.PROFILE === '1') await profile(cdp);
    const idleShare = median(idle.w.map((x) => x.renders / x.ticks));
    console.log(
      `desktop idle: renders/ticks per second ${fmt(idle.w)}; ` +
        `${(sum(idle.w, 'draws') / IDLE_SECONDS).toFixed(0)} drawImage/s; main thread ${idle.taskMsPerSec.toFixed(0)} ms/s`,
    );
    check(
      idleShare <= IDLE_MAX_SHARE,
      `idle office renders <= 1/4 of the rAF ticks (median ${(idleShare * 100).toFixed(0)}%, limit ${IDLE_MAX_SHARE * 100}%)`,
    );

    const box = (await desk.page.locator('[data-testid="office-canvas"]').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const active = await awake(desk.page, cx, cy);
    console.log(
      `desktop, pointer over the office: ${active.renders}/${active.ticks} ticks rendered, ${(active.draws / active.renders).toFixed(0)} drawImage per render`,
    );
    check(
      active.renders / active.ticks >= AWAKE_MIN_SHARE,
      `with the pointer on it the office renders at the full rate (${((active.renders / active.ticks) * 100).toFixed(0)}% of ticks)`,
    );

    // The very next frames after one pointer move are rendered at the full rate.
    await desk.page.mouse.move(5, 790);
    await desk.page.waitForTimeout(2_000); // the grace ends, idle again
    const woke = desk.page.evaluate(
      (n) =>
        new Promise<number>((resolve) => {
          const w = window as unknown as Record<string, number>;
          const start = w.__renders;
          let left = n;
          const step = () =>
            --left > 0 ? requestAnimationFrame(step) : resolve(w.__renders - start);
          requestAnimationFrame(step);
        }),
      WAKE_TICKS,
    );
    await desk.page.mouse.move(cx, cy);
    const wakeRenders = await woke;
    console.log(`after one pointer move: ${wakeRenders} of the next ${WAKE_TICKS} ticks rendered`);
    check(
      wakeRenders >= WAKE_MIN_RENDERS,
      `one pointer move wakes the office to the full rate at once (${wakeRenders}/${WAKE_TICKS} ticks rendered, need >= ${WAKE_MIN_RENDERS})`,
    );
    await desk.ctx.close();
    await daemon.stop();

    // ── Phone: the terminal page in front ───────────────────────
    // The terminal page is reached the way a user reaches it: a background
    // session's character menu -> 대화 -> 터미널로 보기 (--allow-chat).
    const chatHome = makeFakeHome({ claude: 'S-chat', agentsJson: true });
    const phoneDaemon = startDaemon(chatHome, port, ['--no-terminal', '--allow-chat']);
    daemon = phoneDaemon;
    const phone = await newPage(browser, {
      viewport: PHONE,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await phone.page.goto(await phoneDaemon.loginUrl());
    await phone.page.waitForURL(BASE);
    await phone.page.locator('[data-testid="office-canvas"]').waitFor();
    await phone.page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await phone.page.waitForTimeout(4_000);
    const pcdp = await phone.ctx.newCDPSession(phone.page);
    await pcdp.send('Performance.enable');
    const phoneIdle = await windows(phone.page, pcdp, 3);
    console.log(
      `phone, office page: renders/ticks per second ${fmt(phoneIdle.w)}; main thread ${phoneIdle.taskMsPerSec.toFixed(0)} ms/s`,
    );
    const menu = await selectCharacter(phone.page, CHAT_SESSION);
    await menu.getByRole('menuitem', { name: '대화' }).tap();
    await phone.page
      .getByRole('region', { name: `${CHAT_SESSION} 대화` })
      .getByRole('button', { name: '터미널로 보기' })
      .tap();
    await phone.page.getByRole('button', { name: '사무실', exact: true }).first() /* the page's own button; the Dock has one too */.waitFor();
    await phone.page.waitForTimeout(1_500); // the slide ends
    // WINMODEL: the Dock's pages sit over the office, which keeps its place: covered, not slid away.
    const covered = await phone.page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="office-canvas"]')!;
      const r = canvas.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && !canvas.contains(hit);
    });
    check(covered, 'the terminal page is in front: it covers the office canvas');
    const hidden = await windows(phone.page, pcdp, 4);
    const hiddenRenders = sum(hidden.w, 'renders');
    console.log(
      `phone, terminal page in front: renders/ticks per second ${fmt(hidden.w)}; ${sum(hidden.w, 'draws')} drawImage in 4 s; main thread ${hidden.taskMsPerSec.toFixed(0)} ms/s`,
    );
    check(
      hiddenRenders <= HIDDEN_MAX_RENDERS,
      `an office that is not on screen renders nothing (${hiddenRenders} renders in 4 s, limit ${HIDDEN_MAX_RENDERS})`,
    );
    await phone.page.getByRole('button', { name: '사무실', exact: true }).first() /* the page's own button; the Dock has one too */.tap();
    // The old >_ toggle is gone (WINMODEL: the Dock's 사무실 goes home): wait for the canvas.
    await phone.page.waitForFunction(() => {
      const r = document.querySelector('[data-testid="office-canvas"]')!.getBoundingClientRect();
      return r.right > 0 && r.left < window.innerWidth;
    });
    await phone.page.waitForTimeout(1_000);
    const back = await windows(phone.page, pcdp, 2);
    check(back.w[1].renders > 0, `back on the office page it renders again (${fmt(back.w)})`);
    await phone.ctx.close();
  } finally {
    await browser.close();
    await daemon.stop();
  }
  if (failures.length) {
    console.error(`\n${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nall assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
