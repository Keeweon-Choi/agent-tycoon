/**
 * SHEET-IMPORT proof: dist/cli.js with an isolated HOME on a spare port, headless Chromium without
 * a GPU. The owner's isometric sheets (specs/owner-iso-chars-1026, never copied into the repo) are
 * imported through 꾸미기 > 커스텀 > 시트 가져오기 into the temp HOME; nothing converted from them
 * is written under the repo, only screenshots.
 *
 *  1. Four imports through the window: the preview (frames, motion in every direction, report) for
 *     each, one applied to a character, a bad sheet's error.
 *  2. The isometric view (2F): the imported characters walking, typing, reading at zoom 2 and 4, a
 *     follow at the sharpest zoom; the top-down view of one (the isometric sheet standing in).
 *  3. Numbers: conversion time per sheet; memory and first-draw time of an imported character;
 *     frame times (p50, p95, max) with 8 imported + 10 classic characters walking for 10 s and over
 *     a zoom sweep, desktop and phone with the CPU 4× slower, entering right after the lobby's
 *     warm-up; the same with 8 64×128 bunnies before (the integration build, `--before <dist/cli.js>`)
 *     and after.
 *
 *   npx tsx cld/test/run-sheet-import.ts <port 18256-18259> [--before <cli.js>]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const beforeAt = process.argv.indexOf('--before');
const BEFORE_CLI = beforeAt > 0 ? process.argv[beforeAt + 1] : null;
/** Only the imports and the numbers again (the view screenshots of an earlier pass stay). */
const PERF_ONLY = process.argv.includes('--perf-only');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/sheet-import');
/** The owner's generated sheets (not in the repo): beside a worktree (.worktrees/specs), or under
 *  the main checkout's .worktrees/specs (ACCEPT-4: from the main checkout the first path is
 *  /tmp/example-home/projects/specs, which does not exist, and the upload crashed the runner). */
const SHEETS_DIR =
  process.env.SHEETS_DIR ??
  ['../specs', '.worktrees/specs']
    .map((d) => path.join(REPO_ROOT, d, 'owner-iso-chars-1026'))
    .find((d) => fs.existsSync(d)) ??
  '';
const SHEETS = [3, 5, 8, 1];
const DESK: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const THROTTLE = 4;
const WALK_MS = 10_000;
const SWEEP = [2, 3, 4, 5, 6, 5, 4, 3, 2];
const SWEEP_STEP_MS = 700;
const LONG_FRAME_MS = 20;
const BASE = { 'cld.backdrop': 'off', 'cld.floor': '2', 'cld.floor-view': 'all' };
const NO_LOBBY = { ...BASE, 'cld.title-scene': 'off' };

const PACK = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'cld/packs/hd-bunny/pack.json'), 'utf-8'),
) as {
  id: string;
  presets: { look: { parts: Record<string, string> } & Record<string, unknown> }[];
};
const BUNNY = {
  ...PACK.presets[0].look,
  parts: Object.fromEntries(
    Object.entries(PACK.presets[0].look.parts).map(([k, v]) => [k, `${PACK.id}/${v}`]),
  ),
};

const results: Record<string, unknown> = {};
const lines: string[] = [];
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const note = (s: string) => {
  console.log(`  ${s}`);
  lines.push(s);
};

type Hooks = Record<string, (...a: never[]) => unknown> & {
  setZoom: (z: number) => void;
  centerOn: (id: number) => boolean;
  walkTo: (id: number, c: number, r: number) => boolean;
  isTileWalkable: (c: number, r: number) => boolean;
  getCharacterTile: (id: number) => { col: number; row: number; state: string } | null;
  getCharacterPosition: (id: number) => { x: number; y: number } | null;
  getAgentSeats: () => Array<{ id: number }>;
  isoPoint: (x: number, y: number) => { x: number; y: number } | null;
  getSelectedAgentId: () => number | null;
  getCameraFollowId: () => number | null;
  getCamera: () => { zoom: number };
  follow: (id: number) => void;
  spawnPreset: (id: string, n: number, firstId: number) => number;
  spawnLook: (look: unknown, n: number, firstId: number) => number[];
  setActive: (id: number, on: boolean, tool?: string | null) => void;
  cacheBuildMs: (palette: number, hue: number, zoom: number) => number;
  warmState: () => { pending: number; bytes: number };
  perf: () => { cacheBytes: number };
  setPerf: (on: boolean) => void;
};
const hooks =
  (page: Page) =>
  <T, A>(fn: (h: Hooks, a: A) => T, arg: A): Promise<T> =>
    page.evaluate(
      `(${fn.toString()})(window.__pixelAgentsTestHooks, ${JSON.stringify(arg)})`,
    ) as Promise<T>;

const INIT = `
  globalThis.__name = (fn) => fn;
  window.__PIXEL_AGENTS_E2E = true;`;

function makeHome() {
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const cfg = path.join(fake.home, '.config/cld-gui');
  fs.writeFileSync(
    path.join(cfg, 'building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: [
        { id: '1', name: '1층', rooms: [], characters: [] },
        { id: '2', name: '2층', rooms: ['orch-alpha', 'orch-beta'], characters: [] },
        { id: '3', name: '3층', rooms: ['orch-gamma'], characters: [] },
      ],
    }),
  );
  return fake;
}

async function open(
  browser: Browser,
  daemon: ReturnType<typeof startDaemon>,
  opts: BrowserContextOptions,
  store: Record<string, string>,
  ready = true,
) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(INIT);
  await ctx.addInitScript((pairs) => {
    for (const [k, v] of pairs)
      try {
        localStorage.setItem(k, v);
      } catch {
        // about:blank
      }
  }, Object.entries(store));
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(await daemon.loginUrl());
  if (ready) {
    await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
    const info = page.getByRole('button', { name: '정보 창 닫기' });
    if (await info.count()) await info.first().click();
    await page.waitForTimeout(1500);
  }
  return { ctx, page, errors };
}

/** Imported presets in the temp HOME (id, label), oldest first. */
function imported(home: string): Array<{ id: string; label: string }> {
  const dir = path.join(home, '.config/cld-gui/characters');
  return fs
    .readdirSync(dir)
    .filter((f) => /^sheet-\d+(-\d+)?\.json$/.test(f))
    .sort()
    .map((f) => ({
      id: f.replace(/\.json$/, ''),
      label: (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as { label: string }).label,
    }));
}

/** A bad sheet (outside the repo): sheet 2 with its row 2, cell 4 painted over in magenta. */
function badSheet(): string {
  const src = PNG.sync.read(fs.readFileSync(path.join(SHEETS_DIR, 'char-2.png')));
  const cw = src.width / 7;
  const half = src.height / 2;
  for (let y = Math.round(half); y < src.height; y++)
    for (let x = Math.round(cw * 3); x < Math.round(cw * 4); x++)
      src.data.set([255, 0, 255, 255], (y * src.width + x) * 4);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-bad-')), 'bad.png');
  fs.writeFileSync(file, PNG.sync.write(src));
  return file;
}

/** Walkable tiles near a character for it to walk to. */
async function wander(page: Page, ids: number[]) {
  return hooks(page)((h, list) => {
    let n = 0;
    for (const id of list) {
      const t = h.getCharacterTile(id);
      if (!t) continue;
      for (let tries = 0; tries < 12; tries++) {
        const dc = Math.round((Math.random() - 0.5) * 12);
        const dr = Math.round((Math.random() - 0.5) * 8);
        if (h.isTileWalkable(t.col + dc, t.row + dr) && h.walkTo(id, t.col + dc, t.row + dr)) {
          n++;
          break;
        }
      }
    }
    return n;
  }, ids);
}

/** rAF frame times (ms between frames) for `ms`, while `during` runs. */
async function frames(page: Page, ms: number, during: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __ft: number[]; __ftOn: boolean };
    w.__ft = [];
    w.__ftOn = true;
    let last = performance.now();
    const step = (t: number) => {
      w.__ft.push(t - last);
      last = t;
      if (w.__ftOn) requestAnimationFrame(step);
    };
    requestAnimationFrame((t) => {
      last = t;
      requestAnimationFrame(step);
    });
  });
  const t0 = Date.now();
  await during();
  const left = ms - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left);
  const ft = await page.evaluate(() => {
    const w = window as unknown as { __ft: number[]; __ftOn: boolean };
    w.__ftOn = false;
    return w.__ft;
  });
  const s = [...ft].sort((a, b) => a - b);
  const q = (p: number) =>
    Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10;
  return {
    frames: s.length,
    p50: q(0.5),
    p95: q(0.95),
    max: Math.round((s[s.length - 1] ?? 0) * 10) / 10,
    over20: s.filter((v) => v > LONG_FRAME_MS).length,
  };
}

/** Main-thread tasks over 20 ms in a trace: how many, and per kind of their largest part (the
 *  game loop's frame, a GC, the compositor's commit, ...), with how many held a GC over 3 ms. */
function longTasksOf(
  events: Array<{ name: string; ph: string; ts: number; dur?: number; tid: number }>,
) {
  const frames = new Map<number, number>();
  for (const e of events)
    if (e.name === 'FireAnimationFrame') frames.set(e.tid, (frames.get(e.tid) ?? 0) + 1);
  const tid = [...frames].sort((a, b) => b[1] - a[1])[0]?.[0];
  const main = events.filter((e) => e.tid === tid && e.ph === 'X' && e.dur);
  const tasks = main.filter((e) => e.name === 'RunTask' && e.dur! > LONG_FRAME_MS * 1000);
  const by: Record<string, number> = {};
  let withGc = 0;
  for (const t of tasks) {
    const inside = main.filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur! <= t.ts + t.dur!);
    const top = inside
      .filter((e) =>
        [
          'FireAnimationFrame',
          'MajorGC',
          'MinorGC',
          'Commit',
          'TimerFire',
          'EventDispatch',
          'FunctionCall',
        ].includes(e.name),
      )
      .sort((a, b) => b.dur! - a.dur!)[0];
    by[top?.name ?? 'other'] = (by[top?.name ?? 'other'] ?? 0) + 1;
    if (inside.some((e) => /GC$/.test(e.name) && e.dur! > 3000)) withGc++;
  }
  return {
    count: tasks.length,
    by,
    withGc,
    maxMs: Math.round(Math.max(0, ...tasks.map((t) => t.dur!)) / 100) / 10,
  };
}

/** One profile's frame times: 8 `look` characters (imported preset ids, or the bunny pack look)
 *  and 10 classic ones walking; the lobby's warm-up first, then the office from its first second. */
async function perfRun(
  browser: Browser,
  daemon: ReturnType<typeof startDaemon>,
  opts: BrowserContextOptions,
  look: { presets: string[] } | { bunny: true },
  label: string,
) {
  const { ctx, page, errors } = await open(browser, daemon, opts, BASE, false);
  const cdp = await ctx.newCDPSession(page);
  await page
    .locator('[data-testid="agent-overlay"]')
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 });
  // the lobby a fresh launch shows (after a login link it may not: then the 로비 button opens it)
  if (
    !(await page
      .getByTestId('title-scene')
      .isVisible()
      .catch(() => false))
  )
    await page.getByTestId('title-open').click();
  await page.getByTestId('title-scene').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  const h = hooks(page);
  await h((x, z) => x.setZoom(z), 3);
  const ids: number[] = [];
  if ('presets' in look)
    for (let i = 0; i < 8; i++) {
      const id = 9100 + i;
      for (let k = 0; k < 40; k++) {
        if (
          (await h((x, a) => x.spawnPreset(a.p, 1, a.id), {
            p: look.presets[i % look.presets.length],
            id,
          })) >= 0
        )
          break;
        await page.waitForTimeout(250);
      }
      ids.push(id);
    }
  else {
    await h((x, l) => x.spawnLook(l, 8, 9100), BUNNY);
    for (let i = 0; i < 8; i++) ids.push(9100 + i);
  }
  await h((x) => x.spawnLook({ palette: 0 }, 10, 9200), null);
  for (let i = 0; i < 10; i++) ids.push(9200 + i);
  // (no setActive: the integration build has no such hook; every one is sent walking alike)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  // the lobby's warm-up and the office's own queue behind it, done (the before build has
  // neither: its lobby stays as long)
  const t0 = Date.now();
  if (await h((x) => !!x.warmState, null))
    for (let k = 0; k < 120; k++) {
      if (
        (await h((x) => x.warmState().pending, null)) === 0 &&
        (await page.locator('[data-testid="title-warm"][data-done="0"]').count()) === 0
      )
        break;
      await page.waitForTimeout(500);
    }
  else await page.waitForTimeout(3000);
  const warmMs = Date.now() - t0;
  await page.getByTestId('title-enter').click();
  await wander(page, ids);
  // the walk traced: every main-thread task over 20 ms, and what took most of it
  const events: Array<{ name: string; ph: string; ts: number; dur?: number; tid: number }> = [];
  cdp.on('Tracing.dataCollected', (e: { value: typeof events }) => events.push(...e.value));
  const traced = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8,disabled-by-default-devtools.timeline',
    transferMode: 'ReportEvents',
  });
  const walk = await frames(page, WALK_MS, async () => {
    for (let k = 0; k < WALK_MS / 2500; k++) {
      await page.waitForTimeout(2500);
      await wander(page, ids);
    }
  });
  await cdp.send('Tracing.end');
  await traced;
  const longTasks = longTasksOf(events);
  const sweep = await frames(page, SWEEP.length * SWEEP_STEP_MS, async () => {
    for (const z of SWEEP) {
      await h((x, a) => x.setZoom(a), z);
      await page.waitForTimeout(SWEEP_STEP_MS);
    }
  });
  const heapMB =
    Math.round(
      ((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize / 104857.6,
    ) / 10;
  const pendingAfterSweep = await h((x) => (x.warmState ? x.warmState().pending : null), null);
  // the scene left idle: the queue drains (how long it takes)
  const d0 = Date.now();
  if (pendingAfterSweep !== null)
    for (let k = 0; k < 60 && (await h((x) => x.warmState().pending, null)) > 0; k++)
      await page.waitForTimeout(500);
  const drainMs = Date.now() - d0;
  const warmState = await h((x) => (x.warmState ? x.warmState() : null), null);
  await page.screenshot({ path: path.join(OUT, `perf-${label}.png`) });
  await ctx.close();
  const row = {
    label,
    warmMs,
    walk,
    longTasks,
    sweep,
    pendingAfterSweep,
    drainMs,
    heapMB,
    warmState,
    errors: errors.length,
  };
  note(`${label}: ${JSON.stringify(row)}`);
  return row;
}

async function main() {
  if (!SHEETS_DIR)
    throw new Error("check failed: the owner's sheets are not found (set SHEETS_DIR)");
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  if (!PERF_ONLY)
    for (const f of fs.readdirSync(OUT))
      if (/\.(png|json|txt)$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  const browser = await launchBrowser();
  const fake = makeHome();
  let daemon = startDaemon(fake, port, ['--no-terminal']);
  try {
    // ── 1. four imports through the window ──
    const { page, errors } = await open(browser, daemon, DESK, NO_LOBBY);
    const card = page.locator('[data-testid="agent-card"][title="alpha"]');
    await card.waitFor({ timeout: 30_000 });
    await card.click({ button: 'right' });
    const win = page.locator('[data-testid="looks-window"]');
    await win.waitFor();
    await page.getByRole('button', { name: '최대화' }).click();
    const conversions: Record<string, unknown>[] = [];
    for (const [k, n] of SHEETS.entries()) {
      await win.getByRole('button', { name: '커스텀', exact: true }).click();
      if (k === 0) {
        check(
          await win.locator('[data-testid^="looks-custom-pack-"]').count(),
          'the 커스텀 tab lists the pack presets (the 64×128 bunny)',
        );
        await page.screenshot({ path: path.join(OUT, 'window-custom-tab.png') });
      }
      await page.getByTestId('looks-sheet-import').click();
      const t0 = Date.now();
      const preview = page.waitForResponse((r) =>
        r.url().includes('/cld/characters/import/preview'),
      );
      await page
        .getByTestId('sheet-import-file')
        .setInputFiles(path.join(SHEETS_DIR, `char-${n}.png`));
      const res = await (await preview).json();
      await page.getByTestId('sheet-import-report').waitFor({ timeout: 60_000 });
      const wall = Date.now() - t0;
      check(res.format === 'iso', `sheet ${n}: cut as an isometric 2×7 sheet`);
      conversions.push({ sheet: n, requestMs: wall, ...res.report });
      note(`sheet ${n}: ${JSON.stringify({ requestMs: wall, ...res.report })}`);
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(OUT, `import-${n}-preview-iso-zoom4.png`) });
      if (k === 0) {
        await page.getByTestId('sheet-import-preview').scrollIntoViewIfNeeded();
        await page.getByTestId('sheet-import-zoom-2').click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(OUT, `import-${n}-preview-iso-zoom2.png`) });
        await page.getByTestId('sheet-import-view-top').click();
        await page.getByTestId('sheet-import-zoom-4').click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(OUT, `import-${n}-preview-top-zoom4.png`) });
        await page.getByTestId('sheet-import-view-iso').click();
        await page.getByTestId('sheet-import-report').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(OUT, `import-${n}-report.png`) });
      }
      await page.getByTestId('sheet-import-name').fill(`가져온 ${n}`);
      await page.getByTestId('sheet-import-save').click();
      await win.getByTestId('looks-save').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(800);
      if (k === SHEETS.length - 1) {
        // the last one goes on alpha
        await win.getByTestId('looks-save').click();
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(OUT, 'window-applied.png') });
        await page.getByRole('button', { name: '원래 크기' }).click();
      }
    }
    results.conversions = conversions;
    const presets = imported(fake.home);
    check(presets.length === SHEETS.length, `${presets.length} presets saved in the temp HOME`);
    // a bad sheet
    await win.getByRole('button', { name: '커스텀', exact: true }).click();
    await page.getByTestId('looks-sheet-import').click();
    await page.getByTestId('sheet-import-file').setInputFiles(badSheet());
    const err = page.getByTestId('sheet-import-error');
    await err.waitFor({ timeout: 60_000 });
    const text = (await err.textContent()) ?? '';
    check(/2줄 4번째 칸/.test(text), `a bad sheet is refused: "${text}"`);
    note(`bad sheet: ${text}`);
    await page.screenshot({ path: path.join(OUT, 'import-bad-sheet.png') });
    check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
    await page.close();

    // ── 2. the isometric view, then the top-down one ──
    if (!PERF_ONLY) {
      const {
        page: p,
        ctx,
        errors: e2,
      } = await open(browser, daemon, DESK, {
        ...NO_LOBBY,
        'cld.office-iso': 'on',
      });
      const h = hooks(p);
      // three more imported characters on 2F: typing, reading, walking
      const extra = [
        { id: 9100, preset: presets[0].id, mode: 'type' },
        { id: 9101, preset: presets[1].id, mode: 'read' },
        { id: 9102, preset: presets[2].id, mode: 'walk' },
      ];
      for (const x of extra) {
        for (let k = 0; k < 40; k++) {
          if ((await h((y, a) => y.spawnPreset(a.preset, 1, a.id), x)) >= 0) break;
          await p.waitForTimeout(250);
        }
        await h(
          (y, a) => y.setActive(a.id, a.mode !== 'walk', a.mode === 'read' ? 'Read' : 'Edit'),
          x,
        );
      }
      await p.waitForTimeout(2500);
      await p.screenshot({ path: path.join(OUT, 'iso-building.png') });
      await p.getByTestId('iso-view-toggle').click();
      // the camera follows each one (centerOn is the top-down camera's), the shot around it
      const shoot = async (id: number, name: string) => {
        const q = await h((y, a) => {
          const c = y.getCharacterPosition(a);
          return c && y.isoPoint(c.x, c.y);
        }, id);
        const side = 16 * (await h((y) => y.getCamera().zoom, null)) * 7;
        await p.screenshot({
          path: path.join(OUT, `${name}.png`),
          ...(q && {
            clip: {
              x: Math.max(0, q.x - side / 2),
              y: Math.max(0, q.y - side * 0.7),
              width: side,
              height: side,
            },
          }),
        });
      };
      for (const z of [2, 4]) {
        await h((y, a) => y.setZoom(a), z);
        await h((y) => y.follow(9100), null);
        await p.waitForTimeout(2000);
        await p.screenshot({ path: path.join(OUT, `iso-2F-zoom${z}.png`) });
        await shoot(9100, `iso-zoom${z}-typing`);
        await h((y) => y.follow(9101), null);
        await p.waitForTimeout(1500);
        await shoot(9101, `iso-zoom${z}-reading`);
        await h((y) => y.follow(9102), null);
        await p.waitForTimeout(1500);
        await wander(p, [9102]);
        await p.waitForTimeout(450);
        await shoot(9102, `iso-zoom${z}-walking-a`);
        await p.waitForTimeout(330);
        await shoot(9102, `iso-zoom${z}-walking-b`);
      }
      // a follow, at the sharpest zoom the camera gives
      await h((y) => y.follow(9100), null);
      await h((y) => y.setZoom(10), null);
      await p.waitForTimeout(2000);
      const sel = await h((y) => ({ f: y.getCameraFollowId(), z: y.getCamera().zoom }), null);
      note(`follow: ${JSON.stringify(sel)}`);
      check(sel.f === 9100, 'the camera follows an imported character');
      await p.screenshot({ path: path.join(OUT, 'iso-follow-zoom10.png') });
      check(e2.length === 0, `no page errors in the isometric view (${e2.join(' | ')})`);
      await ctx.close();
    }
    if (!PERF_ONLY) {
      const { page: p, ctx, errors: e3 } = await open(browser, daemon, DESK, NO_LOBBY);
      const h = hooks(p);
      for (let k = 0; k < 40; k++) {
        if ((await h((y, a) => y.spawnPreset(a, 1, 9100), presets[0].id)) >= 0) break;
        await p.waitForTimeout(250);
      }
      await h((y) => y.setActive(9100, false), null);
      for (const z of [2, 4]) {
        await h((y, a) => y.setZoom(a), z);
        await h((y) => y.centerOn(9100), null);
        await p.waitForTimeout(1200);
        await p.screenshot({ path: path.join(OUT, `topdown-fallback-zoom${z}.png`) });
      }
      check(e3.length === 0, `no page errors in the top-down view (${e3.join(' | ')})`);
      await ctx.close();
    }
    {
      // first draw (all frames at zoom 4 and 2) and the bytes it built, on a fresh page
      const { page: p, ctx } = await open(browser, daemon, DESK, NO_LOBBY);
      const h = hooks(p);
      await h((y) => y.setPerf(true), null);
      const before = await h((y) => y.perf().cacheBytes, null);
      let palette = -1;
      for (let k = 0; k < 40 && palette < 0; k++) {
        palette = await h((y, a) => y.spawnPreset(a, 1, 9300), presets[0].id);
        if (palette < 0) await p.waitForTimeout(250);
      }
      const first4 = await h((y, a) => y.cacheBuildMs(a, 0, 4), palette);
      const again4 = await h((y, a) => y.cacheBuildMs(a, 0, 4), palette);
      const first2 = await h((y, a) => y.cacheBuildMs(a, 0, 2), palette);
      const built = (await h((y) => y.perf().cacheBytes, null)) - before;
      // the decoded sheet: 7 × 2 frames of 192×384 RGBA; the 64×128 proxies are JS strings
      const sheetBytes = 7 * 2 * 192 * 384 * 4;
      const mem = {
        firstDrawMsZoom4: Math.round(first4 * 10) / 10,
        cachedDrawMsZoom4: Math.round(again4 * 10) / 10,
        firstDrawMsZoom2: Math.round(first2 * 10) / 10,
        sheetMB: Math.round((sheetBytes / 1048576) * 10) / 10,
        builtMB: Math.round((built / 1048576) * 10) / 10,
      };
      results.memory = mem;
      note(`one imported character: ${JSON.stringify(mem)}`);
      await ctx.close();
    }

    // ── 3. frame times ──
    const perf: Record<string, unknown>[] = [];
    // desktop only (the phone's whole-office cost is its own task)
    for (const k of [1])
      perf.push(
        await perfRun(
          browser,
          daemon,
          DESK,
          { presets: presets.map((p) => p.id) },
          `after-desktop-imported-${k}`,
        ),
      );
    perf.push(await perfRun(browser, daemon, DESK, { bunny: true }, 'after-desktop-bunny'));
    if (BEFORE_CLI) {
      await daemon.stop();
      daemon = startDaemon(fake, port, ['--no-terminal'], {}, false, BEFORE_CLI);
      perf.push(await perfRun(browser, daemon, DESK, { bunny: true }, 'before-desktop-bunny'));
    }
    results.perf = perf;
    fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify(results, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, 'measurements.txt'), lines.join('\n') + '\n');
    check(true, 'measurements written');
  } finally {
    await daemon.stop();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
