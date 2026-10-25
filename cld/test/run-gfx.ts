/**
 * GFX verification (owner 10-25, Phase 4): dist/cli.js with an isolated HOME on a spare port,
 * headless Chromium without a GPU, desktop 1280x800 and phone 390x844. One fake Claude session
 * (a `sleep` with a transcript); no model is ever called.
 *
 * With `--base <dir>` (a built checkout of the integration branch, e.g. `git archive` + esbuild
 * + vite in /tmp), the same office is first opened on that build: the canvas must come out
 * pixel-identical with the new modes off (Classic camera; the backdrop is CSS behind the canvas,
 * so the canvas never contains it) and the idle office must draw no more frames than before.
 *
 * Then on this build: Fit / Fill / Focus framing (whole zooms, the office inside or covering the
 * view left by the panels), a manual drag and wheel winning until 0, resize, refresh, the layout
 * editor and a floor switch; the backdrop (crisp, behind, off, parallax); the title scene (menu,
 * honest status, Enter, the panels it opens); a synthetic HD character (its half-world-px marker
 * survives at even and odd zooms, framing prefers even zooms); the 2.5D test objects (a
 * foreground lamp over a character, a plant in front). Screenshots: cld/artifacts/gfx/.
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/gfx');
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
  if (await closeInfo.count()) await closeInfo.first().click();
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

const CLASSIC = { 'cld.camera-mode': 'classic', 'cld.backdrop': 'off', 'cld.title-scene': 'off' };

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
      const { ctx, page } = await open(browser, await d.loginUrl(), opts, CLASSIC);
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
const modeButton = (page: Page, label: string) =>
  page.getByTestId('camera-modes').getByRole('button', { name: label, exact: true });

async function main() {
  await assertPortFree(port);
  fs.rmSync(path.join(REPO_ROOT, 'cld/artifacts/gfx'), { recursive: true, force: true });
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
          `${name}: Classic, backdrop off: the canvas outside the characters is pixel-identical to the integration build`,
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

    // ── Desktop: Fill (default), Fit, Focus ──
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
    let b = await boxOnScreen(page);
    check(
      b.f.mode === 'fill' && Number.isInteger(b.c.zoom),
      `desktop: Fill by default, whole zoom ${b.c.zoom}`,
    );
    check(
      b.left <= b.f.view.x + 1 || b.right >= b.f.view.x + b.f.view.w - 1 || b.top <= 1,
      'desktop Fill: the office reaches the view edges on at least one axis',
    );
    check(
      b.f.view.x > 0,
      `desktop: the elevator panel is left out of the view (view from x=${b.f.view.x})`,
    );
    const fillFrames = await idleFrames(page);
    if (base)
      check(
        fillFrames <= base.desktop.frames + 2,
        `desktop: Fill + backdrop, idle: ${fillFrames} frames (integration build: ${base.desktop.frames})`,
      );
    await shot(page, 'desktop-fill');
    await modeButton(page, '맞춤').click();
    await until('fit framed', async () => (await cam(page)).framing?.mode === 'fit');
    await page.waitForTimeout(300);
    b = await boxOnScreen(page);
    check(
      b.left >= b.f.view.x &&
        b.right <= b.f.view.x + b.f.view.w &&
        b.top >= b.f.view.y &&
        b.bottom <= b.f.view.y + b.f.view.h,
      `desktop Fit: all of the office inside the view at zoom ${b.c.zoom}`,
    );
    await shot(page, 'desktop-fit');
    await modeButton(page, '집중').click();
    await until('focus framed', async () => (await cam(page)).framing?.mode === 'focus');
    await page.waitForTimeout(300);
    await shot(page, 'desktop-focus');
    await modeButton(page, '채움').click();
    await until('fill again', async () => (await cam(page)).framing?.mode === 'fill');
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
    await until('fill after 0', async () => (await cam(page)).zoom === z0);
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

    // ── Backdrop ──
    const bg = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="office-canvas"]')!.parentElement!;
        const s = getComputedStyle(el);
        return {
          image: s.backgroundImage,
          rendering: s.imageRendering,
          x: el.style.getPropertyValue('--cld-bd-x'),
        };
      });
    let style = await bg();
    check(
      style.image.includes('night-city') && style.rendering === 'pixelated',
      'desktop: the skyline is the canvas container background, image-rendering pixelated',
    );
    await page.evaluate(() => localStorage.setItem('cld.backdrop-parallax', 'on'));
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(1200);
    style = await bg();
    check(
      style.image.split('url(').length - 1 === 4 && style.x !== '',
      'desktop: parallax: four layers, the pan in a CSS variable',
    );
    await shot(page, 'desktop-parallax');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(1000);
    check(
      (await bg()).image.split('url(').length - 1 === 1,
      'desktop: reduced motion: the static skyline',
    );
    await page.evaluate(() => localStorage.setItem('cld.backdrop', 'off'));
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(800);
    const plain = (await bg()).image;
    check(
      !plain.includes('night-'),
      `desktop: backdrop off: the plain background (${plain.slice(0, 40)})`,
    );
    await page.evaluate(() => {
      localStorage.removeItem('cld.backdrop');
      localStorage.removeItem('cld.backdrop-parallax');
    });

    // ── Title scene ──
    await page.evaluate(() => {
      localStorage.setItem('cld.title-scene', 'on');
      sessionStorage.removeItem('cld.title-seen');
    });
    requests.length = 0;
    await page.reload();
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
          'cld.camera-mode': 'fill',
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

    // ── Phone: Focus by default, Fit, rotation, HD prefers even zooms, the title scene ──
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
        c.framing?.mode === 'focus' && Number.isInteger(c.zoom),
        `phone: Focus by default, whole zoom ${c.zoom}`,
      );
      await shot(p, 'phone-focus');
      const focusZoom = c.zoom;
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
        `phone: with an HD character on the floor Focus takes an even zoom (${focusZoom} -> ${c.zoom})`,
      );
      await modeButton(p, '맞춤').tap();
      await until('phone fit', async () => (await cam(p)).framing?.mode === 'fit');
      await p.waitForTimeout(400);
      await shot(p, 'phone-fit');
      const portrait = (await cam(p)).framing!;
      await p.setViewportSize({ width: 844, height: 390 });
      await until('rotated', async () => (await cam(p)).framing!.view.w !== portrait.view.w);
      await p.waitForTimeout(600);
      check(true, 'phone: a rotation frames again');
      await shot(p, 'phone-landscape');
      await p.setViewportSize({ width: 390, height: 844 });
      await p.waitForTimeout(600);
      await p.evaluate(() => {
        localStorage.setItem('cld.title-scene', 'on');
        sessionStorage.removeItem('cld.title-seen');
      });
      await p.reload();
      await p.getByTestId('title-scene').waitFor();
      await p.waitForTimeout(800);
      await shot(p, 'phone-title');
      await logoCrisp(p, 'phone');
      await p.getByTestId('title-enter').tap();
      await until(
        'phone title closes',
        async () => (await p.getByTestId('title-scene').count()) === 0,
      );
      check(true, 'phone title: one tap on 사무실 입장 is the office');
      check(e.length === 0, `phone: no page errors (${e.join(' | ')})`);
      await ctx.close();
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
