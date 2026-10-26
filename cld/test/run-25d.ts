/**
 * 2.5D PILOT verification: dist/cli.js with an isolated HOME on a spare port, headless Chromium
 * without a GPU, one fake Claude session (a `sleep` with a transcript; no model is ever called).
 *
 * With `--base <dir>` (a built checkout of the integration branch): the office with the switch
 * off is pixel-identical to that build, and draws no more idle frames. Then the switch on: the
 * 2.5D walls and furniture (desktop and phone), idle frames no more than with it off and the
 * picture steady while idle, the lead sitting at its desk, then walking behind a tall plant and
 * behind a shelf (the piece in front covers it). Screenshots: cld/artifacts/pilot25d/.
 *
 *   npx tsx cld/test/run-25d.ts <port 18256-18259> [--base /tmp/integ-base]
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
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const baseArg = process.argv.indexOf('--base');
const BASE = baseArg > 0 ? process.argv[baseArg + 1] : null;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/pilot25d');
const ART = path.join(REPO_ROOT, 'webview-ui/src/cld/office25d/art');
const DESK = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
const DESK2 = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const IDLE_MS = 3000;
/** The settings every page gets: the old camera (the base build's), no backdrop or title. */
const CLASSIC = { 'cld.camera-mode': 'classic', 'cld.backdrop': 'off', 'cld.title-scene': 'off' };
const OFF = { ...CLASSIC, 'cld.office-25d': 'off' };
const ON = { ...CLASSIC, 'cld.office-25d': 'on' };

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

/** The lead: a busy interactive session reading a file (run-gfx.ts's, the same on both builds);
 *  or, with `walker`, an idle one in the same folder (it sits nowhere and can be walked about). */
function session(home: string, walker = false) {
  fs.writeFileSync(
    path.join(configDirectory(home), 'characters.json'),
    JSON.stringify({ lead: { palette: 0, hueShift: 0 }, walker: { palette: 1, hueShift: 0 } }),
  );
  const cwd = '/work/alpha';
  const proc = spawn('sleep', ['1200'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c1025800-0000-4000-8000-00000000002${walker ? 6 : 5}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    // The walker says nothing until it has joined (then its turn ends: see main).
    walker
      ? ''
      : JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-haiku-4-5',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: `${cwd}/a.md` } }],
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
      name: walker ? 'walker' : 'lead',
      status: walker ? 'idle' : 'busy',
    }),
  );
  return { proc, transcript: path.join(projectDir, `${sessionId}.jsonl`) };
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

type Hooks = {
  getAgentSeats: () => Array<{ id: number }>;
  getCharacterTile: (id: number) => { col: number; row: number; state: string; active: boolean } | null;
  getCharacterPosition: (id: number) => { x: number; y: number } | null;
  getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
  isTileWalkable: (c: number, r: number) => boolean;
  placeFurniture: (type: string, col: number, row: number) => boolean;
  walkAgentTo: (id: number, c: number, r: number) => boolean;
};
const hooks =
  (page: Page) =>
  <T, A>(fn: (h: Hooks, a: A) => T, arg: A): Promise<T> =>
    page.evaluate(
      `(${fn.toString()})(window.__pixelAgentsTestHooks, ${JSON.stringify(arg)})`,
    ) as Promise<T>;

/** Hashes of the office canvas: everything but the characters (`rest`), and each character's
 *  own rectangle (`chars`: it types and its ring pulses, so the builds compare the poses seen). */
const canvasHash = (page: Page) =>
  page.evaluate(() => {
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

async function hashes(page: Page): Promise<{ rest: Set<string>; chars: Set<string> }> {
  const out = { rest: new Set<string>(), chars: new Set<string>() };
  for (let i = 0; i < 20; i++) {
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

async function open(
  browser: Browser,
  url: string,
  opts: BrowserContextOptions,
  store: Record<string, string>,
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
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForURL(/\/$/);
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
  if (await closeInfo.count()) await closeInfo.first().click();
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}

async function baseline(browser: Browser) {
  const { home, claudePath } = makeEngineHome();
  const lead = session(home).proc;
  const d = startDaemon(
    { home, claudePath },
    port,
    ['--no-terminal'],
    {},
    false,
    path.join(BASE!, 'dist/cli.js'),
  );
  try {
    const out: Record<string, { hashes: Awaited<ReturnType<typeof hashes>>; frames: number }> = {};
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

/** Canvas RGBA at device px. */
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
      return [...c.getContext('2d')!.getImageData(x, y, 1, 1).data];
    },
    [x, y],
  );
/** Device px of world (wx, wy): the projection of tile centres the page itself uses. */
async function toDevice(page: Page, wx: number, wy: number) {
  const r = await hooks(page)(
    (h) => ({ a: h.getTileCenter(0, 0)!, b: h.getTileCenter(1, 1)!, dpr: window.devicePixelRatio }),
    null,
  );
  const z = ((r.b.x - r.a.x) * r.dpr) / 16;
  return {
    x: Math.round((r.a.x * r.dpr - 8 * z) + wx * z),
    y: Math.round((r.a.y * r.dpr - 8 * z) + wy * z),
    z,
  };
}

/** Walk character `id` to (c, r), as the right-click command does (a right click on this page opens
 *  the G1 menu first). */
async function walkTo(page: Page, id: number, c: number, r: number) {
  check(await hooks(page)((h, a) => h.walkAgentTo(a[0], a[1], a[2]), [id, c, r]), `a path to ${c},${r}`);
  const seen: string[] = [];
  await until(`the walker walks to ${c},${r}`, async () => {
    const at = await hooks(page)((h, i) => h.getCharacterTile(i), id);
    const k = at ? `${at.col},${at.row}:${at.state}` : 'none';
    if (seen.at(-1) !== k) seen.push(k);
    return !!at && at.col === c && at.row === r && at.state !== 'walk';
  }).catch((err: unknown) => {
    throw new Error(`${String(err)}; seen ${seen.join(' ')}`);
  });
  console.log(`  walker path: ${seen.join(' ')}`);
}

/** The opaque px of art `name` in its top `rows` rows, drawn with its top-left at world
 *  (wx, wy): how many the canvas shows in the art's own colour (it is in front). One read. */
async function inFront(page: Page, name: string, wx: number, wy: number, rows: number) {
  const png = PNG.sync.read(fs.readFileSync(path.join(ART, `${name}.png`)));
  const o = await toDevice(page, 0, 0);
  const want: Array<{ x: number; y: number; rgb: number[] }> = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i + 3] !== 255) continue;
      want.push({
        x: Math.round(o.x + (wx + x + 0.5) * o.z),
        y: Math.round(o.y + (wy + y + 0.5) * o.z),
        rgb: [...png.data.subarray(i, i + 3)],
      });
    }
  const got = await page.evaluate((pts) => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    return pts.map((p) => [...d.subarray((p.y * c.width + p.x) * 4, (p.y * c.width + p.x) * 4 + 3)]);
  }, want);
  const miss = want.flatMap((w, k) =>
    w.rgb.every((v, j) => got[k][j] === v) ? [] : [`${w.x},${w.y}:${w.rgb.join('.')}->${got[k].join('.')}`],
  );
  if (miss.length) console.log(`  ${name} not shown: ${miss.slice(0, 8).join(' ')}`);
  return { shown: want.length - miss.length, tried: want.length };
}

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const pages: Page[] = [];
  let home = '';
  let lead: ReturnType<typeof spawn> | null = null;
  let walker: ReturnType<typeof spawn> | null = null;
  let daemon: ReturnType<typeof startDaemon> | null = null;
  try {
    const base = BASE ? await baseline(browser) : null;
    const fake = makeEngineHome();
    home = fake.home;
    lead = session(home).proc;
    daemon = startDaemon({ home, claudePath: fake.claudePath }, port, ['--no-terminal'], {});
    const callsBefore = engineCalls(home).length;

    for (const [name, opts] of [
      ['desktop', DESK],
      ['phone', PHONE],
    ] as const) {
      // ── Off: as before ──
      const off = await open(browser, await daemon.loginUrl(), opts, OFF);
      pages.push(off.page);
      const ours = await hashes(off.page);
      const offFrames = await idleFrames(off.page);
      await off.page.screenshot({ path: path.join(OUT, `${name}-off.png`) });
      if (base) {
        const was = base[name].hashes;
        check(
          ours.rest.size === 1 && was.rest.size === 1 && [...ours.rest][0] === [...was.rest][0],
          `${name}, switch off: the canvas outside the characters is pixel-identical to the integration build`,
        );
        const poses = [...ours.chars].filter((h) => was.chars.has(h)).length;
        check(
          poses > 0,
          `${name}, switch off: the character matches the integration build in ${poses} of the poses seen`,
        );
        check(
          offFrames <= base[name].frames + 2,
          `${name}, switch off: idle, ${offFrames} frames in ${IDLE_MS} ms (integration build: ${base[name].frames})`,
        );
      }
      check(off.errors.length === 0, `${name} off: no page errors (${off.errors.join(' | ')})`);
      await off.ctx.close();

      // ── On: the 2.5D office ──
      const on = await open(browser, await daemon.loginUrl(), opts, ON);
      pages.push(on.page);
      const onHashes = await hashes(on.page);
      const onFrames = await idleFrames(on.page);
      check(
        onHashes.rest.size === 1 && [...onHashes.rest][0] !== [...ours.rest][0],
        `${name}, switch on: the office is drawn differently and holds still while idle`,
      );
      check(
        onFrames <= offFrames + 2,
        `${name}, switch on: idle, ${onFrames} frames in ${IDLE_MS} ms (switch off: ${offFrames})`,
      );
      await on.page.screenshot({ path: path.join(OUT, `${name}-on.png`) });
      check(on.errors.length === 0, `${name} on: no page errors (${on.errors.join(' | ')})`);
      await on.ctx.close();
    }

    // ── Desktop at dpr 2: sitting at the desk; an idle walker behind a plant and a shelf ──
    const w = session(home, true);
    walker = w.proc;
    const { ctx, page, errors } = await open(browser, await daemon.loginUrl(), DESK2, ON);
    pages.push(page);
    const h = hooks(page);
    await until('the walker joins', async () => (await h((x) => x.getAgentSeats().length, null)) === 2, 30_000);
    await page.addStyleTag({ content: '[data-testid="agent-overlay"]{visibility:hidden!important}' });
    // The lead is at work; the walker, its turn over, is not (and can be sent about).
    let leadId = -1;
    let id = -1;
    let last = '';
    let ended = false;
    await until('the lead works and the walker idles', async () => {
      const all = await h((x) => x.getAgentSeats().map((a) => ({ id: a.id, ...x.getCharacterTile(a.id)! })), null);
      last = JSON.stringify(all);
      if (all.length === 2 && !ended) {
        // The walker's turn: a word, then the end of the turn (it stops working).
        for (const rec of [
          { type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'done' }] } },
          { type: 'system', subtype: 'turn_duration', durationMs: 1000 },
        ])
          fs.appendFileSync(w.transcript, JSON.stringify(rec) + '\n');
        ended = true;
      }
      leadId = all.find((a) => a.active)?.id ?? -1;
      id = all.find((a) => !a.active)?.id ?? -1;
      return all.length === 2 && leadId >= 0 && id >= 0;
    }, 30_000).catch((err: unknown) => {
      throw new Error(`${String(err)}: ${last}`);
    });
    const seat = (await h((x, i) => x.getCharacterTile(i), leadId))!;
    const clip = async (c: number, r: number) => {
      const t = (await h((x, a) => x.getTileCenter(a[0], a[1]), [c, r]))!;
      const box = (await page.getByTestId('office-canvas').boundingBox())!;
      t.x += box.x;
      t.y += box.y;
      // Two tiles (64 CSS px at zoom 4, dpr 2) above, one below, three to each side.
      return { x: t.x - 96, y: t.y - 96, width: 192, height: 160 };
    };
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'desktop-sit.png'), clip: await clip(seat.col, seat.row) });
    check(seat.state === 'type', `the lead sits at its desk typing (tile ${seat.col},${seat.row})`);

    // A spot two columns by three rows clear below the desk row, as far left in the room as
    // there is one (the room's name is painted in its middle): the walker stands at (c, r), the
    // piece below it.
    const spot = await h(
      (x, s) => {
        for (let c = 0; c < s.col + 8; c++)
          for (let r = s.row + 1; r < s.row + 8; r++)
            if ([0, 1, 2].every((k) => x.isTileWalkable(c, r + k) && x.isTileWalkable(c + 1, r + k)))
              return { c, r };
        return null;
      },
      seat,
    );
    check(spot, `a clear spot near the desk for the walk (${JSON.stringify(spot)})`);
    const { c, r } = spot!;
    // The plant's footprint is 1x2, its top row walkable: the lead stands in that row.
    await h((x, a) => x.placeFurniture('PLANT', a[0], a[1]), [c, r]);
    await walkTo(page, id, c, r);
    const plant = PNG.sync.read(fs.readFileSync(path.join(ART, 'plant-monstera.png')));
    const plantLeft = Math.round(c * 16 + 8 - plant.width / 2);
    const plantTop = (r + 2) * 16 - plant.height;
    // The leaves above the lead's feet line ((r + 1) * 16) are over it.
    const leaves = await inFront(page, 'plant-monstera', plantLeft, plantTop, (r + 1) * 16 - plantTop);
    check(
      leaves.tried > 0 && leaves.shown === leaves.tried,
      `behind the tall plant: its leaves cover the walker's legs (${leaves.shown}/${leaves.tried} px)`,
    );
    await page.screenshot({ path: path.join(OUT, 'desktop-behind-plant.png'), clip: await clip(c, r) });

    // The shelf (2x1, its picture 26 px tall): the lead stands in the row behind it.
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.addStyleTag({ content: '[data-testid="agent-overlay"]{visibility:hidden!important}' });
    await page.waitForTimeout(1500);
    await h((x, a) => x.placeFurniture('BOOKSHELF', a[0], a[1]), [c, r + 1]);
    await walkTo(page, id, c + 1, r);
    const shelf = PNG.sync.read(fs.readFileSync(path.join(ART, 'bookshelf-combo.png')));
    const shelfLeft = Math.round((c + 1) * 16 - shelf.width / 2);
    const shelfTop = (r + 2) * 16 - shelf.height;
    const books = await inFront(page, 'bookshelf-combo', shelfLeft, shelfTop, (r + 1) * 16 - shelfTop);
    check(
      books.tried > 0 && books.shown === books.tried,
      `behind the shelf: its top covers the walker's legs (${books.shown}/${books.tried} px)`,
    );
    await page.screenshot({ path: path.join(OUT, 'desktop-behind-shelf.png'), clip: await clip(c, r) });
    check(errors.length === 0, `dpr 2 page: no page errors (${errors.join(' | ')})`);
    await ctx.close();

    // `claude --version` / `--help` (the daemon checking the CLI) are no model call.
    const calls = engineCalls(home)
      .slice(callsBefore)
      .filter((c) => !['--version', '--help'].includes(c.argv.join(' ')));
    check(calls.length === 0, `no engine (model) call was made by any of this (${calls.map((c) => c.argv.join(' ').slice(0, 80)).join(' | ')})`);
    console.log('all checks passed');
  } catch (err) {
    for (const [i, pg] of pages.entries())
      await pg.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => undefined);
    throw err;
  } finally {
    await browser.close();
    await daemon?.stop();
    lead?.kill();
    walker?.kill();
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
