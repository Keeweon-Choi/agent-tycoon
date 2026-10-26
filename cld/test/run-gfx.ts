/**
 * GFX2 verification (owner 10-25 22:27): dist/cli.js with an isolated HOME on a spare port,
 * headless Chromium without a GPU, desktop 1280x800 and phone 390x844. One fake Claude session
 * (a `sleep` with a transcript); no model is ever called. The HD sample preset is put in the
 * temp HOME's presets, as the owner has it.
 *
 * With `--base <dir>` (a built checkout of the integration branch before GFX, e.g. `git archive`
 * + esbuild + vite in /tmp), the same office is first opened on that build: the canvas must come
 * out pixel-identical with the camera 'off' and the backdrop off (the backdrop is CSS behind the
 * canvas, never in it) and the idle office must draw no more frames than before.
 *
 * Then on this build: the two camera modes (자동: the office framed, a click on a character zooms
 * in and follows, the floor or Esc frames the office again, a manual drag or wheel wins until 0;
 * 자유 시점: a click moves nothing), resize, refresh, the layout editor, a floor switch; the
 * backdrop seen from above (crisp, repeating, moving with the world, nothing written while idle,
 * off); the lobby (shown on a fresh launch, not on a reload nor over a deep link; the title box
 * hugs the logo with equal margins and the menu and status line take its width; its lights
 * animate and stop under reduced motion; Tori and the owner at the counter at a whole-number
 * scale); a synthetic HD character; the 2.5D test objects. Screenshots: cld/artifacts/gfx2/.
 *
 *   npx tsx cld/test/run-gfx.ts <port 18256-18259> [--base /tmp/gfx-base]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const baseArg = process.argv.indexOf('--base');
const BASE = baseArg > 0 ? process.argv[baseArg + 1] : null;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/gfx2');
const DESK = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const IDLE_MS = 3000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out: ${what}`);
}

function session(home: string) {
  // The same look on both builds (the daemon otherwise picks one): built-in sheet 0.
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/characters.json'),
    JSON.stringify({ lead: { palette: 0, hueShift: 0 } }),
  );
  const cwd = '/work/alpha';
  const proc = spawn('sleep', ['1200'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1025800-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: `${cwd}/a.md` } },
        ],
      },
    }) + '\n',
  );
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name: 'lead',
      status: 'busy',
    }),
  );
  return proc;
}

/** The e2e hooks, a frame counter (clearRect(0,0,...) on the office canvas = one drawn frame). */
const INIT = `
  globalThis.__name = (fn) => fn; // tsx names the functions it passes to page.evaluate
  window.__PIXEL_AGENTS_E2E = true;
  window.__frames = 0;
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
    if (x === 0 && y === 0 && this.canvas.dataset && this.canvas.dataset.testid === 'office-canvas') window.__frames++;
    return clear.call(this, x, y, w, h);
  };`;

type Framing = {
  mode: string;
  zoom: number;
  view: { x: number; y: number; w: number; h: number };
  box: { x: number; y: number; w: number; h: number };
};
type Cam = {
  zoom: number;
  pan: { x: number; y: number };
  cols: number;
  rows: number;
  framing: Framing | null;
};
type Hooks = {
  getCamera: () => Cam;
  getAgentSeats: () => Array<{ id: number }>;
  getCharacterTile: (id: number) => { col: number; row: number; state: string } | null;
  getCharacterPosition: (id: number) => { x: number; y: number } | null;
  getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
  makeHdCharacter: (id: number) => boolean;
  placeFurniture: (type: string, col: number, row: number) => boolean;
};
const hooks =
  (page: Page) =>
  <T>(fn: (h: Hooks) => T): Promise<T> =>
    page.evaluate(`(${fn.toString()})(window.__pixelAgentsTestHooks)`) as Promise<T>;
const cam = (page: Page) => hooks(page)((h) => h.getCamera());

/** Hashes of the office canvas: everything but the characters (`rest`), and each character's
 *  own rectangle (`chars`: its sprite, ring and props animate, so the two builds are compared
 *  on the poses both showed). */
const canvasHash = (page: Page) =>
  page.evaluate(() => {
    // Only hooks the integration build has too (it has no getCamera).
    type H = {
      getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
      getAgentSeats: () => Array<{ id: number }>;
      getCharacterPosition: (id: number) => { x: number; y: number } | null;
    };
    const h = (window as unknown as { __pixelAgentsTestHooks: H }).__pixelAgentsTestHooks;
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const dpr = window.devicePixelRatio || 1;
    const t0 = h.getTileCenter(0, 0)!;
    const t1 = h.getTileCenter(1, 0)!;
    const z = Math.round(((t1.x - t0.x) * dpr) / 16);
    const ox = Math.round(t0.x * dpr - 8 * z);
    const oy = Math.round(t0.y * dpr - 8 * z);
    const rects = h.getAgentSeats().flatMap(({ id }) => {
      const p = h.getCharacterPosition(id);
      return p
        ? [[ox + (p.x - 14) * z, oy + (p.y - 40) * z, ox + (p.x + 14) * z, oy + (p.y + 14) * z]]
        : [];
    });
    const fnv = (h0: number, v: number) => Math.imul(h0 ^ v, 16777619) >>> 0;
    let rest = 2166136261;
    const chars = rects.map(() => 2166136261);
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const k = rects.findIndex(([l, t, r, b]) => x >= l && x < r && y >= t && y < b);
        const i = (y * c.width + x) * 4;
        for (let j = 0; j < 4; j++)
          if (k < 0) rest = fnv(rest, d[i + j]);
          else chars[k] = fnv(chars[k], d[i + j]);
      }
    return {
      rest: `${c.width}x${c.height}:${rest.toString(16)}`,
      chars: chars.map((v) => v.toString(16)).join(','),
    };
  });
/** The canvas's RGBA at device px (x, y). */
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
      return [...c.getContext('2d')!.getImageData(x, y, 1, 1).data];
    },
    [x, y],
  );
/** Device px of world (0,0) on the canvas (projection.mapOffset). */
const origin = (c: Cam, canvas: { width: number; height: number }) => ({
  x: Math.floor((canvas.width - c.cols * 16 * c.zoom) / 2) + Math.round(c.pan.x),
  y: Math.floor((canvas.height - c.rows * 16 * c.zoom) / 2) + Math.round(c.pan.y),
});
const canvasSize = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
    return { width: c.width, height: c.height };
  });

async function open(
  browser: Browser,
  url: string,
  opts: BrowserContextOptions,
  store: Record<string, string | null>,
  /** false: the lobby may be over the office, so its info window is left alone. */
  office = true,
) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(INIT);
  // These settings on every load (null: absent, the default); a key left out keeps what the
  // test sets (launchBrowser keeps the title scene off unless a test turns it on).
  await ctx.addInitScript((pairs) => {
    for (const [k, v] of pairs)
      try {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        // about:blank
      }
  }, Object.entries(store));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForURL(/\/$/);
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
  if (office && (await closeInfo.count())) await closeInfo.first().click();
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

/** The canvas over a few seconds: the hashes of all but the characters, and of the poses seen. */
async function hashes(page: Page): Promise<{ rest: Set<string>; chars: Set<string> }> {
  const out = { rest: new Set<string>(), chars: new Set<string>() };
  for (let i = 0; i < 25; i++) {
    const h = await canvasHash(page);
    out.rest.add(h.rest);
    out.chars.add(h.chars);
    await page.waitForTimeout(120);
  }
  return out;
}
/** Frames the office drew in IDLE_MS with nothing touched. */
async function idleFrames(page: Page): Promise<number> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1000);
  const a = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
  await page.waitForTimeout(IDLE_MS);
  const b = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
  return b - a;
}

/** The office as before: the integration build's Classic camera, this build's 'off'. */
const CLASSIC_BASE = {
  'cld.camera-mode': 'classic',
  'cld.backdrop': 'off',
  'cld.title-scene': 'off',
};
const CLASSIC = { 'cld.camera-mode': 'off', 'cld.backdrop': 'off', 'cld.title-scene': 'off' };
const HD_SAMPLE = path.join(REPO_ROOT, 'cld/artifacts/char-factory/hd-sample');

async function baseline(browser: Browser) {
  const { home, claudePath } = makeEngineHome();
  const lead = session(home);
  const d = startDaemon(
    { home, claudePath },
    port,
    ['--no-terminal'],
    {},
    false,
    path.join(BASE!, 'dist/cli.js'),
  );
  try {
    const out: Record<
      string,
      { hashes: { rest: Set<string>; chars: Set<string> }; frames: number }
    > = {};
    for (const [name, opts] of [
      ['desktop', DESK],
      ['phone', PHONE],
    ] as const) {
      const { ctx, page } = await open(browser, await d.loginUrl(), opts, CLASSIC_BASE);
      out[name] = { hashes: await hashes(page), frames: await idleFrames(page) };
      await page.screenshot({ path: path.join(OUT, `${name}-integ.png`) });
      await ctx.close();
    }
    return out;
  } finally {
    await d.stop();
    lead.kill();
    killFakeSessions(home);
  }
}

/** The office's drawn box on screen, device px. */
async function boxOnScreen(page: Page) {
  const c = await cam(page);
  const size = await canvasSize(page);
  const o = origin(c, size);
  const f = c.framing!;
  return {
    c,
    f,
    left: o.x + f.box.x * c.zoom,
    top: o.y + f.box.y * c.zoom,
    right: o.x + (f.box.x + f.box.w) * c.zoom,
    bottom: o.y + (f.box.y + f.box.h) * c.zoom,
  };
}
/** The lobby's logo sign: a whole number of device px per art px, each art px one flat block of
 *  its own colour on the screen (nearest-neighbour, not smoothed, not shifted half a pixel). */
async function logoCrisp(page: Page, name: string) {
  const r = await page.getByTestId('title-logo').evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height, dpr: window.devicePixelRatio || 1 };
  });
  const src = PNG.sync.read(
    fs.readFileSync(path.join(REPO_ROOT, 'webview-ui/src/cld/gfx/art/logo-sign.png')),
  );
  const k = (r.w * r.dpr) / src.width;
  // The whole viewport, indexed at the logo's device px (a clip would round its CSS origin).
  const shot = PNG.sync.read(await page.screenshot());
  const ox = Math.round(r.x * r.dpr);
  const oy = Math.round(r.y * r.dpr);
  const offGrid = Math.abs(r.x * r.dpr - ox) + Math.abs(r.y * r.dpr - oy);
  let bad = 0;
  let opaque = 0;
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      if (src.data[i + 3] !== 255) continue;
      opaque++;
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) {
          const j = ((oy + y * k + dy) * shot.width + ox + x * k + dx) * 4;
          if ([0, 1, 2].some((c) => Math.abs(shot.data[j + c] - src.data[i + c]) > 3)) bad++;
        }
    }
  check(
    Number.isInteger(k) && bad === 0 && opaque > 0,
    `${name} title: the logo is drawn at ${k} device px per art px, every block flat (${bad} stray px; layout origin ${offGrid.toFixed(2)} device px off the grid, snapped by the browser)`,
  );
}
/** Where to click lead (CSS px of the page). */
async function leadAt(p: Page) {
  const t = await p.evaluate(() => {
    const h = (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks;
    const tile = h.getCharacterTile(h.getAgentSeats()[0].id)!;
    return h.getTileCenter(tile.col, tile.row)!;
  });
  const cb = (await p.getByTestId('office-canvas').boundingBox())!;
  return { x: cb.x + t.x, y: cb.y + t.y - 10 };
}
/** The title box hugs the logo with equal margins; the menu buttons and the status line take
 *  exactly its width. */
async function titleBox(page: Page, name: string) {
  const r = await page.evaluate(() => {
    const at = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const box = at('[data-testid="title-box"]');
    const logo = at('[data-testid="title-logo"]');
    return {
      left: logo.left - box.left,
      right: box.right - logo.right,
      box: box.width,
      menu: [...document.querySelectorAll('[data-testid="title-column"] nav button')].map(
        (b) => b.getBoundingClientRect().width,
      ),
      status: at('[data-testid="title-status"]').width,
    };
  });
  check(
    Math.abs(r.left - r.right) < 0.5 &&
      r.menu.every((w) => Math.abs(w - r.box) < 0.5) &&
      Math.abs(r.status - r.box) < 0.5,
    `${name} title: logo margins ${r.left.toFixed(1)} / ${r.right.toFixed(1)} px, the ${r.menu.length} buttons and the status line ${r.box.toFixed(1)} px wide like the box`,
  );
}
/** The lobby's lights move (two frames differ inside the picture, outside the menu) and stop
 *  under reduced motion; Tori and the owner sit at the counter at whole-number scales. */
async function lobbyLife(page: Page, name: string) {
  const cast = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLCanvasElement>('canvas.cld-lobby-cast')].map((c) => ({
      id: c.dataset.testid,
      scale: Number(c.dataset.scale),
    })),
  );
  check(
    cast.length === 2 && cast.every((c) => Number.isInteger(c.scale) && c.scale >= 1),
    `${name} lobby: ${cast.map((c) => `${c.id} x${c.scale}`).join(', ')} at the counter, whole-number scales`,
  );
  const diff = async (tag: string) => {
    const art = (await page.getByTestId('title-art').boundingBox())!;
    const menu = (await page.getByTestId('title-column').boundingBox())!;
    const a = PNG.sync.read(await page.screenshot());
    await page.waitForTimeout(1300);
    const shotB = await page.screenshot();
    if (tag) fs.writeFileSync(path.join(OUT, `${name}-title-${tag}.png`), shotB);
    const bimg = PNG.sync.read(shotB);
    const dpr = a.width / page.viewportSize()!.width;
    let n = 0;
    for (let y = 0; y < a.height; y += 2)
      for (let x = 0; x < a.width; x += 2) {
        const cx = x / dpr;
        const cy = y / dpr;
        if (cx < art.x || cy < art.y || cx >= art.x + art.width || cy >= art.y + art.height)
          continue;
        if (cx >= menu.x && cx < menu.x + menu.width && cy >= menu.y && cy < menu.y + menu.height)
          continue;
        const i = (y * a.width + x) * 4;
        if (
          a.data[i] !== bimg.data[i] ||
          a.data[i + 1] !== bimg.data[i + 1] ||
          a.data[i + 2] !== bimg.data[i + 2]
        )
          n++;
      }
    return n;
  };
  const moving = await diff('frame2');
  check(
    moving > 0,
    `${name} lobby: the lights and the cast change between two frames (${moving} sampled px)`,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('title-enter').click();
  await page.getByTestId('title-open').click();
  await page.getByTestId('title-scene').waitFor();
  await page.waitForTimeout(500);
  const still = await diff('');
  check(still === 0, `${name} lobby: under reduced motion nothing moves (${still} px)`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

async function main() {
  await assertPortFree(port);
  fs.rmSync(path.join(REPO_ROOT, 'cld/artifacts/gfx2'), { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const pages: Page[] = [];
  let home = '';
  let lead: ReturnType<typeof spawn> | null = null;
  let daemon: ReturnType<typeof startDaemon> | null = null;
  try {
    const base = BASE ? await baseline(browser) : null;

    const fake = makeEngineHome();
    home = fake.home;
    lead = session(home);
    fs.mkdirSync(path.join(home, '.config/cld-gui/characters'), { recursive: true });
    for (const f of ['bunny-hd-sample.png', 'bunny-hd-sample.json'])
      fs.copyFileSync(path.join(HD_SAMPLE, f), path.join(home, '.config/cld-gui/characters', f));
    daemon = startDaemon({ home, claudePath: fake.claudePath }, port, ['--no-terminal'], {});

    // ── Pixel identity with the new modes off, and idle frames ──
    for (const [name, opts] of [
      ['desktop', DESK],
      ['phone', PHONE],
    ] as const) {
      const { ctx, page } = await open(browser, await daemon.loginUrl(), opts, CLASSIC);
      pages.push(page);
      const ours = await hashes(page);
      const frames = await idleFrames(page);
      if (base) {
        const was = base[name].hashes;
        check(
          ours.rest.size === 1 && was.rest.size === 1 && [...ours.rest][0] === [...was.rest][0],
          `${name}: camera off, backdrop off: the canvas outside the characters is pixel-identical to the integration build`,
        );
        const poses = [...ours.chars].filter((h) => was.chars.has(h)).length;
        check(
          poses > 0,
          `${name}: the character rectangles match the integration build in ${poses} of the poses seen (${ours.chars.size} here, ${was.chars.size} there; it types and its ring pulses)`,
        );
        check(
          frames <= base[name].frames + 2,
          `${name}: idle, the office drew ${frames} frames in ${IDLE_MS} ms (integration build: ${base[name].frames})`,
        );
      }
      await shot(page, `${name}-classic`);
      await ctx.close();
      if (base) console.log(`  ${name} idle frames: integ ${base[name].frames}, classic ${frames}`);
    }

    // ── Desktop: 자동 (default) and 자유 시점 ──
    const callsBefore = engineCalls(home).length;
    const requests: string[] = [];
    const {
      ctx: deskCtx,
      page,
      errors,
    } = await open(browser, await daemon.loginUrl(), DESK, {
      'cld.camera-mode': null,
    });
    pages.push(page);
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    const b = await boxOnScreen(page);
    check(
      b.f.mode === 'auto' && Number.isInteger(b.c.zoom),
      `desktop: 자동 by default, the office framed at whole zoom ${b.c.zoom}`,
    );
    check(
      b.left <= b.f.view.x + 1 || b.right >= b.f.view.x + b.f.view.w - 1 || b.top <= 1,
      'desktop 자동: the office reaches the view edges on at least one axis',
    );
    check(
      b.f.view.x > 0,
      `desktop: the elevator panel is left out of the view (view from x=${b.f.view.x})`,
    );
    const autoFrames = await idleFrames(page);
    if (base)
      check(
        autoFrames <= base.desktop.frames + 2,
        `desktop: 자동 + backdrop, idle: ${autoFrames} frames (integration build: ${base.desktop.frames})`,
      );
    await shot(page, 'desktop-auto');
    const office = await cam(page);
    let at = await leadAt(page);
    await page.mouse.click(at.x, at.y);
    await until('follow zooms in', async () => (await cam(page)).zoom > office.zoom);
    await page.waitForTimeout(1200);
    const following = await cam(page);
    check(
      following.zoom === office.zoom + 2 && following.pan.x !== office.pan.x,
      `desktop 자동: a click on lead zooms in (${office.zoom} -> ${following.zoom}) and follows it`,
    );
    await shot(page, 'desktop-auto-follow');
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await until('Esc frames the office', async () => {
      const c = await cam(page);
      return c.zoom === office.zoom && c.pan.x === office.pan.x && c.pan.y === office.pan.y;
    });
    check(true, 'desktop 자동: Esc ends the follow and frames the office again');
    at = await leadAt(page);
    await page.mouse.click(at.x, at.y);
    await until('follow again', async () => (await cam(page)).zoom > office.zoom);
    const floorSpot = (await page.getByTestId('office-canvas').boundingBox())!;
    await page.waitForTimeout(800);
    await page.mouse.click(
      floorSpot.x + floorSpot.width * 0.5,
      floorSpot.y + floorSpot.height * 0.9,
    );
    await until('a click on the floor frames the office', async () => {
      const c = await cam(page);
      return c.zoom === office.zoom && c.pan.x === office.pan.x;
    });
    check(true, 'desktop 자동: a click on empty floor frames the office again');
    await page.getByTestId('camera-toggle').click();
    await until(
      'free',
      async () => (await page.getByTestId('camera-toggle').getAttribute('data-mode')) === 'free',
    );
    at = await leadAt(page);
    const beforeFree = await cam(page);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(1200);
    const afterFree = await cam(page);
    check(
      afterFree.zoom === beforeFree.zoom &&
        afterFree.pan.x === beforeFree.pan.x &&
        afterFree.pan.y === beforeFree.pan.y,
      'desktop 자유 시점: a click on lead selects it and moves nothing',
    );
    await shot(page, 'desktop-free');
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await page.getByTestId('camera-toggle').click();
    await until('auto again', async () => (await cam(page)).zoom === office.zoom);
    check(
      (await page.getByTestId('camera-toggle').getAttribute('data-mode')) === 'auto',
      'desktop: the toggle goes back to 자동, which frames the office',
    );
    await page.waitForTimeout(300);

    // ── Manual wins until asked again ──
    const canvasBox = (await page.getByTestId('office-canvas').boundingBox())!;
    const framed = await cam(page);
    const sx = canvasBox.x + canvasBox.width * 0.5;
    const sy = canvasBox.y + canvasBox.height * 0.92;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 120, sy - 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const dragged = await cam(page);
    check(dragged.pan.x !== framed.pan.x || dragged.pan.y !== framed.pan.y, 'desktop: a drag pans');
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.waitForTimeout(600);
    const afterResize = await cam(page);
    check(
      afterResize.framing!.view.w === framed.framing!.view.w,
      'desktop: after a manual pan a resize does not frame again',
    );
    await page.mouse.move(0, 0);
    await page.keyboard.press('0');
    await until(
      '0 frames again',
      async () => (await cam(page)).framing!.view.w !== framed.framing!.view.w,
    );
    check(true, 'desktop: 0 frames again for the new size');
    await page.setViewportSize({ width: 1280, height: 800 });
    await until(
      'resize reframes',
      async () => (await cam(page)).framing!.view.w === framed.framing!.view.w,
    );
    check(true, 'desktop: in Fill a resize frames again');
    await page.waitForTimeout(300);
    const z0 = (await cam(page)).zoom;
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.mouse.wheel(0, -120);
    await until('wheel zooms', async () => (await cam(page)).zoom === z0 + 1);
    check(true, `desktop: the wheel still zooms (${z0} -> ${z0 + 1})`);
    const manual = await cam(page);
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(1500);
    const restored = await cam(page);
    check(
      restored.zoom === manual.zoom &&
        Math.abs(restored.pan.x - manual.pan.x) <= 1 &&
        Math.abs(restored.pan.y - manual.pan.y) <= 1,
      'desktop: a refresh keeps a view moved by hand',
    );
    await page.mouse.move(0, 0);
    await page.keyboard.press('0');
    await until('framed after 0', async () => (await cam(page)).zoom === z0);
    await page.waitForTimeout(400);
    const auto = await cam(page);
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(1500);
    const reframed = await cam(page);
    check(
      reframed.zoom === auto.zoom && reframed.pan.x === auto.pan.x && reframed.pan.y === auto.pan.y,
      'desktop: a refresh of a framed view frames it again (the same view at the same size)',
    );

    // ── The layout editor keeps the camera; a floor switch frames the new floor ──
    const beforeEdit = await cam(page);
    await page.getByRole('button', { name: '인테리어', exact: true }).click();
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(500);
    const inEdit = await cam(page);
    check(
      inEdit.zoom === beforeEdit.zoom &&
        inEdit.pan.x === beforeEdit.pan.x &&
        inEdit.pan.y === beforeEdit.pan.y,
      'desktop: the layout editor keeps the camera (no framing while editing, even on a resize)',
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: '인테리어', exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('.cld-elevator-edit').click();
    await page.getByTestId('floor-editor').waitFor();
    await page.getByRole('button', { name: '층 추가' }).click();
    await until('two floors', async () => (await page.locator('.cld-floor-button').count()) === 2);
    await page.locator('.cld-elevator-edit').click();
    await page.waitForTimeout(800);
    const floor1 = await cam(page);
    await page.mouse.move(0, 0);
    await page.keyboard.press('2');
    await until(
      'floor 2 framed',
      async () => (await cam(page)).framing!.box.y !== floor1.framing!.box.y,
    );
    await page.waitForTimeout(800);
    const floor2 = await cam(page);
    check(
      Number.isInteger(floor2.zoom),
      `desktop: floor 2 is framed (its own rows, whole zoom ${floor2.zoom})`,
    );
    await shot(page, 'desktop-floor2');
    await page.keyboard.press('1');
    await until(
      'floor 1 framed',
      async () => (await cam(page)).framing!.box.y === floor1.framing!.box.y,
    );
    check(true, 'desktop: back on floor 1 it is framed as before');

    // ── Backdrop: the city seen from above, moving with the world ──
    const bg = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="office-canvas"]')!.parentElement!;
        const s = getComputedStyle(el);
        return {
          image: s.backgroundImage,
          rendering: s.imageRendering,
          repeat: s.backgroundRepeat,
          position: el.style.backgroundPosition,
          size: el.style.backgroundSize,
        };
      });
    // ACCEPT-4: the baseline is read once the backdrop has held still for three reads (1.2 s): the
    // floor switch above may still be settling (the acceptance runs under load failed here twice,
    // an earlier full run too, while four unloaded, pinned and CPU-throttled runs did not). An
    // office that never settles still fails (after 25 reads, 10 s).
    let style = await bg();
    for (let held = 0, reads = 0; held < 3; reads++) {
      if (reads === 25) throw new Error('check failed: desktop: the backdrop never held still (10 s)');
      await page.waitForTimeout(400);
      const next = await bg();
      held = next.position === style.position ? held + 1 : 0;
      style = next;
    }
    check(
      style.image.includes('topdown-night') &&
        style.rendering === 'pixelated' &&
        style.repeat === 'repeat' &&
        style.size !== '',
      'desktop: the city seen from above is the canvas container background, pixelated, repeating',
    );
    await page.mouse.move(0, 0);
    await page.waitForTimeout(1500);
    const idleStyle = await bg();
    check(
      idleStyle.position === style.position,
      `desktop: idle, the backdrop is not written again (${style.position} then ${idleStyle.position}, camera ${JSON.stringify(await cam(page))})`,
    );
    const cb2 = (await page.getByTestId('office-canvas').boundingBox())!;
    await page.mouse.move(cb2.x + cb2.width * 0.5, cb2.y + cb2.height * 0.92);
    await page.mouse.down();
    await page.mouse.move(cb2.x + cb2.width * 0.5 - 90, cb2.y + cb2.height * 0.92 - 40, {
      steps: 5,
    });
    await page.mouse.up();
    await page.waitForTimeout(300);
    style = await bg();
    check(style.position !== idleStyle.position, 'desktop: a drag moves the city with the office');
    await shot(page, 'desktop-backdrop');
    await page.mouse.move(0, 0);
    await page.keyboard.press('0');
    await page.evaluate(() => localStorage.setItem('cld.backdrop', 'off'));
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(800);
    const plain = (await bg()).image;
    check(
      !plain.includes('topdown'),
      `desktop: backdrop off: the plain background (${plain.slice(0, 40)})`,
    );
    await page.evaluate(() => localStorage.removeItem('cld.backdrop'));
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(800);

    // ── Title scene ──
    requests.length = 0;
    await page.getByTestId('title-open').click();
    const title = page.getByTestId('title-scene');
    await title.waitFor();
    await until('status line', async () =>
      (await page.getByTestId('title-status').innerText()).includes('데몬 연결됨'),
    );
    check(
      (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) ===
        'title-enter',
      'desktop title: 사무실 입장 has the focus; the status line says the daemon is connected',
    );
    await page.waitForTimeout(600);
    await shot(page, 'desktop-title');
    await logoCrisp(page, 'desktop');
    await titleBox(page, 'desktop');
    await lobbyLife(page, 'desktop');
    const titleCalls = requests.filter((p) => p.startsWith('/api/') && p !== '/api/cld/connector');
    check(
      !requests.some((p) => /usage|engine|chat|claude/i.test(p) && p !== '/api/cld/connector'),
      `desktop title: no usage, engine or chat request (api calls: ${[...new Set(titleCalls)].join(', ') || 'none'})`,
    );
    await page.keyboard.press('Enter');
    await until('Enter enters', async () => (await title.count()) === 0);
    check(true, 'desktop title: Enter is the office');
    await page.getByTestId('title-open').click();
    await title.waitFor();
    await page.getByTestId('title-settings').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const onTop = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
      const el = document.elementFromPoint(d.left + d.width / 2, d.top + 20);
      return !!el?.closest('[role="dialog"]');
    });
    check(onTop, 'desktop title: 설정 opens the settings window over the title scene');
    await dialog.locator('[data-modal-title] button').click(); // the window's own x
    await until('settings closed', async () => (await dialog.count()) === 0);
    await page.getByTestId('title-remote').click();
    await dialog.waitFor();
    check(
      (await page.locator('#settings-tab-access').getAttribute('aria-selected')) === 'true',
      'desktop title: 원격 연결 · 기기 관리 opens settings on its 접속 tab',
    );
    await shot(page, 'desktop-title-remote');
    await dialog.locator('[data-modal-title] button').click(); // the window's own x
    await until('access closed', async () => (await dialog.count()) === 0);
    await page.getByTestId('title-help').click();
    await page.getByTestId('title-help-text').waitFor();
    check(
      (await page.locator('[data-testid="title-help-text"] li').count()) === 5,
      'desktop title: 도움말 shows the short help',
    );
    await dialog.locator('[data-modal-title] button').click(); // the window's own x
    await until('help closed', async () => (await dialog.count()) === 0);
    await page.getByTestId('title-enter').click();
    await until('enter closes', async () => (await title.count()) === 0);
    check(true, 'desktop title: one click on 사무실 입장 is the office');

    // ── HD character: the half-world-px marker survives at an even and an odd zoom ──
    const id = (await hooks(page)((h) => h.getAgentSeats()[0].id)) as number;
    check(
      await page.evaluate(
        (i) =>
          (
            window as unknown as { __pixelAgentsTestHooks: Hooks }
          ).__pixelAgentsTestHooks.makeHdCharacter(i),
        id,
      ),
      'desktop: a synthetic density-2 sheet on lead',
    );
    const marker = async () => {
      const c = await cam(page);
      const size = await canvasSize(page);
      const o = origin(c, size);
      const t = await page.evaluate((i) => {
        const h = (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks;
        return { pos: h.getCharacterPosition(i)!, tile: h.getCharacterTile(i)! };
      }, id);
      const sit = t.tile.state === 'type' ? 6 : 0;
      // The sprite's left/top (renderer: round(origin + x*zoom - width/2), round(... - height)).
      // A 32x64 HD frame at zoom/2 is 16*zoom x 32*zoom device px, the world rect of today's.
      const left = Math.round(o.x + t.pos.x * c.zoom - 8 * c.zoom);
      const top = Math.round(o.y + (t.pos.y + sit) * c.zoom - 32 * c.zoom);
      const s = c.zoom / 2;
      const x0 = left + Math.round(15 * s);
      const y0 = top + Math.round(41 * s);
      const w = Math.round(16 * s) - Math.round(15 * s);
      const inside = await pixel(page, x0, y0);
      const after = await pixel(page, x0 + w, y0);
      return { zoom: c.zoom, w, inside, after };
    };
    await page.waitForTimeout(400);
    const even = await marker();
    check(
      even.inside.slice(0, 3).every((v) => v === 255) &&
        !even.after.slice(0, 3).every((v) => v === 255),
      `desktop HD at zoom ${even.zoom}: the marker is ${even.w} device px wide, its neighbour another colour`,
    );
    // The wheel over lead zooms about lead, so it stays on screen at the odd zoom.
    const over = await page.evaluate((i) => {
      const h = (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks;
      const t = h.getCharacterTile(i)!;
      return h.getTileCenter(t.col, t.row)!;
    }, id);
    const cb = (await page.getByTestId('office-canvas').boundingBox())!;
    await page.mouse.move(cb.x + over.x, cb.y + over.y);
    await page.mouse.wheel(0, -120);
    await until('odd zoom', async () => (await cam(page)).zoom % 2 === 1);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    const odd = await marker();
    check(
      odd.inside.slice(0, 3).every((v) => v === 255),
      `desktop HD at odd zoom ${odd.zoom}: drawn nearest-neighbour, the marker still there (${odd.w} px)`,
    );
    await page.keyboard.press('0');
    await page.waitForTimeout(400);
    check(errors.length === 0, `desktop: no page errors (${errors.join(' | ')})`);
    await deskCtx.close();

    // ── 2.5D test objects (dpr 2: zoom 4) ──
    {
      const {
        ctx,
        page: p,
        errors: e,
      } = await open(
        browser,
        await daemon.loginUrl(),
        { ...DESK, deviceScaleFactor: 2 },
        {
          'cld.camera-mode': 'auto',
          'cld.title-scene': 'off',
        },
      );
      pages.push(p);
      const h = hooks(p);
      const t = await h((x) => {
        const i = x.getAgentSeats()[0].id;
        return { i, tile: x.getCharacterTile(i)! };
      });
      const lampPng = PNG.sync.read(
        fs.readFileSync(
          path.join(REPO_ROOT, 'webview-ui/public/assets/furniture/PENDANT_LAMP/PENDANT_LAMP.png'),
        ),
      );
      const plantPng = PNG.sync.read(
        fs.readFileSync(
          path.join(REPO_ROOT, 'webview-ui/public/assets/furniture/TALL_PLANT/TALL_PLANT.png'),
        ),
      );
      /** Canvas px of sprite px (sx,sy) of an item whose picture's top-left is world (wx,wy). */
      const at = async (wx: number, wy: number, sx: number, sy: number) => {
        const c = await cam(p);
        const o = origin(c, await canvasSize(p));
        return pixel(p, o.x + (wx + sx) * c.zoom + 1, o.y + (wy + sy) * c.zoom + 1);
      };
      const opaqueRow = (png: PNG, y: number) => {
        for (let x = 0; x < png.width; x++)
          if (png.data[(y * png.width + x) * 4 + 3] === 255) return x;
        return -1;
      };
      const { col, row } = t.tile;
      await p.evaluate(
        ([c, r]) =>
          (
            window as unknown as { __pixelAgentsTestHooks: Hooks }
          ).__pixelAgentsTestHooks.placeFurniture('PENDANT_LAMP', c, r + 1),
        [col, row],
      );
      await p.waitForTimeout(600);
      // The lamp's lowest opaque row: world y = foot (row+2)*16 - 32 - (16 - y).
      const ly = lampPng.height - 1;
      const lx = opaqueRow(lampPng, ly);
      const lampLeft = col * 16 + 8 - lampPng.width / 2;
      const lampTop = (row + 2) * 16 - 32 - lampPng.height;
      const got = await at(lampLeft, lampTop, lx, ly);
      const want = [
        ...lampPng.data.subarray((ly * lampPng.width + lx) * 4, (ly * lampPng.width + lx) * 4 + 3),
      ];
      check(
        got.slice(0, 3).every((v, k) => v === want[k]),
        `2.5D: the foreground lamp hanging in front of lead is drawn over it (pixel ${got.slice(0, 3)} = lamp ${want})`,
      );
      await p.addStyleTag({
        content: '[data-testid="agent-overlay"]{visibility:hidden!important}',
      });
      await p.waitForTimeout(300);
      const tc = await p.evaluate(
        ([c, r]) =>
          (
            window as unknown as { __pixelAgentsTestHooks: Hooks }
          ).__pixelAgentsTestHooks.getTileCenter(c, r),
        [col, row],
      );
      await p.screenshot({
        path: path.join(OUT, 'desktop-25d-lamp.png'),
        clip: { x: tc!.x - 110, y: tc!.y - 90, width: 220, height: 220 },
      });
      await p.reload();
      await p.locator('[data-testid="agent-overlay"]').first().waitFor();
      await p.waitForTimeout(1000);
      await p.evaluate(
        ([c, r]) =>
          (
            window as unknown as { __pixelAgentsTestHooks: Hooks }
          ).__pixelAgentsTestHooks.placeFurniture('TALL_PLANT', c, r + 1),
        [col, row],
      );
      await p.waitForTimeout(600);
      // The plant's top rows overlap lead's lower body: the plant (in front) is what shows.
      const plantLeft = Math.round(col * 16 + 8 - plantPng.width / 2);
      const plantTop = (row + 2) * 16 - plantPng.height;
      let shown = 0;
      let tried = 0;
      for (let y = 0; y < 6; y++) {
        const x = opaqueRow(plantPng, y);
        if (x < 0) continue;
        tried++;
        const g = await at(plantLeft, plantTop, x, y);
        const w = [
          ...plantPng.data.subarray((y * plantPng.width + x) * 4, (y * plantPng.width + x) * 4 + 3),
        ];
        if (g.slice(0, 3).every((v, k) => v === w[k])) shown++;
      }
      check(
        tried > 0 && shown === tried,
        `2.5D: the tall plant in front of lead covers it (${shown}/${tried} leaf pixels)`,
      );
      await p.addStyleTag({
        content: '[data-testid="agent-overlay"]{visibility:hidden!important}',
      });
      await p.waitForTimeout(300);
      await p.screenshot({
        path: path.join(OUT, 'desktop-25d-plant.png'),
        clip: { x: tc!.x - 110, y: tc!.y - 90, width: 220, height: 220 },
      });
      check(e.length === 0, `2.5D page: no page errors (${e.join(' | ')})`);
      await ctx.close();
    }

    // ── Phone: 자동, a tap follows, 자유 시점, rotation, HD prefers even zooms, the lobby ──
    {
      const {
        ctx,
        page: p,
        errors: e,
      } = await open(browser, await daemon.loginUrl(), PHONE, {
        'cld.camera-mode': null,
      });
      pages.push(p);
      let c = await cam(p);
      check(
        c.framing?.mode === 'auto' && Number.isInteger(c.zoom),
        `phone: 자동 by default, whole zoom ${c.zoom}`,
      );
      await shot(p, 'phone-auto');
      const framedZoom = c.zoom;
      const i = (await hooks(p)((x) => x.getAgentSeats()[0].id)) as number;
      await p.evaluate(
        (n) =>
          (
            window as unknown as { __pixelAgentsTestHooks: Hooks }
          ).__pixelAgentsTestHooks.makeHdCharacter(n),
        i,
      );
      await until('HD reframe', async () => (await cam(p)).zoom % 2 === 0, 5000).catch(
        () => undefined,
      );
      c = await cam(p);
      check(
        c.zoom % 2 === 0,
        `phone: with an HD character on the floor 자동 takes an even zoom (${framedZoom} -> ${c.zoom})`,
      );
      const hdZoom = c.zoom;
      // The framed office is wider than the phone: bring lead on screen first (a manual pan,
      // which the tap's follow then overrides).
      let t = await leadAt(p);
      const pc = (await p.getByTestId('office-canvas').boundingBox())!;
      const dx = pc.x + pc.width / 2 - t.x;
      const dy = pc.y + pc.height / 2 - t.y;
      await p.mouse.move(pc.x + pc.width / 2, pc.y + pc.height * 0.8);
      await p.mouse.down();
      await p.mouse.move(pc.x + pc.width / 2 + dx, pc.y + pc.height * 0.8 + dy, { steps: 6 });
      await p.mouse.up();
      await p.waitForTimeout(500);
      t = await leadAt(p);
      await p.touchscreen.tap(t.x, t.y);
      await until('phone follow', async () => (await cam(p)).zoom > hdZoom);
      await p.waitForTimeout(1200);
      c = await cam(p);
      check(
        c.zoom % 2 === 0,
        `phone 자동: a tap on lead zooms in and follows (${hdZoom} -> ${c.zoom}, even for HD)`,
      );
      await shot(p, 'phone-auto-follow');
      await p.getByTestId('camera-toggle').tap();
      await until(
        'phone free',
        async () => (await p.getByTestId('camera-toggle').getAttribute('data-mode')) === 'free',
      );
      await p.waitForTimeout(400);
      await shot(p, 'phone-free');
      await p.getByTestId('camera-toggle').tap();
      await until('phone auto', async () => (await cam(p)).zoom === hdZoom);
      const portrait = (await cam(p)).framing!;
      await p.setViewportSize({ width: 844, height: 390 });
      await until('rotated', async () => (await cam(p)).framing!.view.w !== portrait.view.w);
      await p.waitForTimeout(600);
      check(true, 'phone: a rotation frames again');
      await shot(p, 'phone-landscape');
      await p.setViewportSize({ width: 390, height: 844 });
      await p.waitForTimeout(600);
      await p.getByTestId('title-open').tap();
      await p.getByTestId('title-scene').waitFor();
      await p.waitForTimeout(800);
      await shot(p, 'phone-title');
      await logoCrisp(p, 'phone');
      await titleBox(p, 'phone');
      await lobbyLife(p, 'phone');
      await p.getByTestId('title-enter').tap();
      await until(
        'phone title closes',
        async () => (await p.getByTestId('title-scene').count()) === 0,
      );
      check(true, 'phone title: one tap on 사무실 입장 is the office');
      check(e.length === 0, `phone: no page errors (${e.join(' | ')})`);
      await ctx.close();
    }

    // ── The lobby on a fresh launch, not on a reload, not over a deep link ──
    {
      const fresh = await open(
        browser,
        await daemon.loginUrl(),
        DESK,
        { 'cld.title-scene': 'on' },
        false,
      );
      pages.push(fresh.page);
      await fresh.page.getByTestId('title-scene').waitFor({ timeout: 10_000 });
      check(true, 'a fresh launch (a new session) opens on the lobby');
      await fresh.page.reload();
      await fresh.page.getByTestId('office-canvas').waitFor();
      await fresh.page.waitForTimeout(1500);
      check(
        (await fresh.page.getByTestId('title-scene').count()) === 0,
        'a reload within the session goes straight to the office',
      );
      const linked = await fresh.ctx.newPage();
      pages.push(linked);
      const url = new URL(fresh.page.url());
      url.searchParams.set('agent', '1');
      await linked.goto(url.href);
      await linked.getByTestId('office-canvas').waitFor();
      await linked.waitForTimeout(1500);
      check(
        (await linked.getByTestId('title-scene').count()) === 0,
        'a notice link (?agent=) in a new tab opens the office, not the lobby',
      );
      await fresh.ctx.close();
    }

    check(
      engineCalls(home).length === callsBefore,
      'no engine (model) call was made by any of this',
    );
    console.log('all checks passed');
  } catch (err) {
    for (const [i, pg] of pages.entries())
      await pg.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => undefined);
    throw err;
  } finally {
    await browser.close();
    await daemon?.stop();
    lead?.kill();
    if (home) killFakeSessions(home);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
