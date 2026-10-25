/**
 * Floor and wall art check (the art-floor-cc0 task): dist/cli.js with an isolated
 * HOME (fake office and claude) on a spare port, headless Chromium with --disable-gpu.
 * A second socket saves an edited layout: the nine floor patterns, each colourized,
 * in one room, and a block of walls in every auto-tile shape. Screenshots on a
 * desktop viewport and a phone one go to cld/artifacts/art-floor/.
 *
 *   npx tsx cld/test/run-floor-art.ts <port 18256-18259>
 */
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

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
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/art-floor');

type Layout = {
  cols: number;
  rows: number;
  layoutRevision?: number;
  tiles: number[];
  tileColors: unknown[];
  areaTiles: Array<string | null>;
  furniture: Array<{ uid: string; type: string; col: number; row: number }>;
};
type Color = { h: number; s: number; b: number; c: number; colorize?: boolean };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
}

type Rect = { x: number; y: number; w: number; h: number };

/** Floor colours: shot 0 the warm default, a layout blue and a layout brown (contrast squashed); shot 1 others. */
const COLOR_SETS: Color[][] = [
  [
    { h: 30, s: 30, b: 0, c: 0, colorize: true },
    { h: 209, s: 39, b: -25, c: -80, colorize: true },
    { h: 25, s: 48, b: -43, c: -88, colorize: true },
  ],
  [
    { h: 140, s: 30, b: 0, c: 20, colorize: true },
    { h: 280, s: 25, b: -10, c: -30, colorize: true },
    { h: 0, s: 0, b: 0, c: 0, colorize: true },
  ],
];
/** '+' presses after the pan: the tiles bigger, to judge the pixels. */
const ZOOM_STEPS = 1;
const WALL_LIGHT: Color = { h: 240, s: 25, b: 0, c: 0, colorize: true };
const WALL_LAYOUT: Color = { h: 209, s: 39, b: -25, c: -80, colorize: true };

/** A wall block drawn from a picture: every one of the 16 auto-tile shapes appears in it (checked). */
const WALLS = [
  '###########.',
  '#....#....#.',
  '#....#....#.',
  '###.###.###.',
  '#....#....#.',
  '#....#....#.',
  '#.##########',
  '#.#.#.#.#.#.',
  '..#..####..#',
  '..#..#..#..#',
  '..####..#...',
  '.#......###.',
];
const wallAt = (c: number, r: number) => WALLS[r]?.[c] === '#';
const maskAt = (c: number, r: number) =>
  (wallAt(c, r - 1) ? 1 : 0) |
  (wallAt(c + 1, r) ? 2 : 0) |
  (wallAt(c, r + 1) ? 4 : 0) |
  (wallAt(c - 1, r) ? 8 : 0);

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  const received: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await warmUpOffice(ctx, daemon);
    await ctx.addInitScript(() => {
      (window as unknown as { __PIXEL_AGENTS_E2E: boolean }).__PIXEL_AGENTS_E2E = true;
    });
    const page = await ctx.newPage();
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary frame */
        }
      }),
    );
    page.on('pageerror', (e) => errors.push(String(e)));
    const lastLayout = () =>
      [...received].reverse().find((m) => m.type === 'layoutLoaded')?.layout as Layout | undefined;
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(BASE);
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await until('initial layout', () => !!lastLayout());
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '00-default-desktop.png') });

    const l0 = lastLayout()!;
    console.log(`layout ${l0.cols}x${l0.rows}`);
    if (process.env.DUMP) {
      for (let r = 0; r < l0.rows; r++)
        console.log(
          l0.tiles
            .slice(r * l0.cols, (r + 1) * l0.cols)
            .map((t) => (t === 255 ? ' ' : t === 0 ? '#' : String(t)))
            .join(''),
        );
    }
    // The room: the first area's bounding box.
    const labels = [...new Set(l0.areaTiles.filter((v): v is string => !!v))];
    const label = labels[0];
    const idx = l0.areaTiles.flatMap((v, i) => (v === label ? [i] : []));
    const cols = idx.map((i) => i % l0.cols);
    const rows = idx.map((i) => Math.floor(i / l0.cols));
    const x0 = Math.min(...cols);
    const y0 = Math.min(...rows);
    const w = Math.max(...cols) - x0 + 1;
    const h = Math.max(...rows) - y0 + 1;
    console.log(`room ${label}: ${x0},${y0} ${w}x${h}`);

    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
          (window as unknown as { artSocket: WebSocket }).artSocket = socket;
          socket.addEventListener('open', () => resolve(), { once: true });
          socket.addEventListener('error', () => reject(new Error('socket failed')), {
            once: true,
          });
        }),
    );
    const room: Rect = { x: x0, y: y0, w, h };
    const save = async (layout: Layout, shot: string) => {
      const n = received.length;
      await page.evaluate((l) => {
        (window as unknown as { artSocket: WebSocket }).artSocket.send(
          JSON.stringify({ type: 'saveLayout', layout: l }),
        );
      }, layout);
      await until(`${shot} echoed`, () => received.slice(n).some((m) => m.type === 'layoutLoaded'));
      await page.waitForTimeout(800);
    };
    /** The specimen: the room with its furniture cleared, every tile a plain floor. */
    const blank = (): Layout => {
      const l = structuredClone(l0);
      l.layoutRevision = 1; // without one, a tile 8 is read as a legacy void
      l.furniture = l.furniture.filter(
        (f) =>
          f.col < room.x || f.col >= room.x + room.w || f.row < room.y || f.row >= room.y + room.h,
      );
      return l;
    };
    const at = (l: Layout, c: number, r: number) => r * l.cols + c;
    const frame = async (
      name: string,
      viewport?: { width: number; height: number },
      target: { c: number; r: number } = { c: room.x, r: room.y },
      steps = ZOOM_STEPS,
    ) => {
      if (viewport) await page.setViewportSize(viewport);
      await page.keyboard.press('Escape'); // stop following a character
      await page.keyboard.press('0'); // the default zoom, so every frame starts equal
      for (let i = 0; i < steps; i++) await page.keyboard.press('+');
      await page.waitForTimeout(400);
      // Drag the floor until the specimen's top-left tile sits near the top-left of the view
      // (the camera clamps the pan to the map, so repeat until it stops moving).
      for (let i = 0; i < 4; i++) {
        const p0 = await page.evaluate(
          ({ c, r }) =>
            (
              window as unknown as {
                __pixelAgentsTestHooks: {
                  getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
                };
              }
            ).__pixelAgentsTestHooks.getTileCenter(c, r),
          { c: target.c, r: target.r },
        );
        if (!p0) break;
        const dx = (target.c === room.x ? 140 : 640) - p0.x;
        const dy = (target.c === room.x ? 110 : 400) - p0.y;
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
        await page.mouse.move(640, 400);
        await page.mouse.down();
        await page.mouse.move(640 + dx, 400 + dy, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, name) });
    };

    const seen = new Set<number>();
    for (let r = 0; r < WALLS.length; r++)
      for (let c = 0; c < WALLS[0].length; c++) if (wallAt(c, r)) seen.add(maskAt(c, r));
    check(seen.size === 16, `the wall picture shows all 16 auto-tile shapes (${seen.size})`);

    // Floors: nine patterns in blocks of 3x2, three colours per shot.
    for (let shot = 0; shot < COLOR_SETS.length; shot++) {
      const l = blank();
      COLOR_SETS[shot].forEach((color, k) => {
        for (let p0 = 0; p0 < 9; p0++) {
          const bx = p0 % 5;
          const by = Math.floor(p0 / 5);
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 3; dx++) {
              const i = at(l, room.x + bx * 3 + dx, room.y + k * 4 + by * 2 + dy);
              l.tiles[i] = p0 + 1;
              l.tileColors[i] = color;
            }
        }
      });
      await save(l, `floors ${shot}`);
      await frame(`01-floors-${shot}-desktop.png`);
    }
    // Walls: a room's own walls are rebuilt by the daemon from its area, so a painted wall inside a
    // room does not survive a save. The office's real walls are the in-engine evidence instead:
    // list which of the 16 shapes it contains and where, and frame the richest junctions.
    {
      const wallTile = (c: number, r: number) =>
        l0.tiles[r * l0.cols + c] === 0 && c >= 0 && c < l0.cols && r >= 0 && r < l0.rows;
      const where = new Map<number, Array<[number, number]>>();
      for (let r = 0; r < l0.rows; r++)
        for (let c = 0; c < l0.cols; c++) {
          if (!wallTile(c, r)) continue;
          const m =
            (wallTile(c, r - 1) ? 1 : 0) |
            (wallTile(c + 1, r) ? 2 : 0) |
            (wallTile(c, r + 1) ? 4 : 0) |
            (wallTile(c - 1, r) ? 8 : 0);
          where.set(m, [...(where.get(m) ?? []), [c, r]]);
        }
      console.log(
        'office wall shapes: ' +
          [...where.entries()]
            .sort((x, y) => x[0] - y[0])
            .map(([m, v]) => `${m}x${v.length}`)
            .join(' '),
      );
      await save(l0, 'office as it was');
      await frame('02-walls-desktop.png', undefined, { c: 18, r: 14 }, 1);
      await frame('03-walls-junction-desktop.png', undefined, { c: 18, r: 27 }, 1);
    }
    // Phone: the specimen floors saved again, an iPhone-sized touch context, the office as it opens,
    // then dragged (CDP touch events) until the specimen's top-left tile is in view.
    {
      const l = blank();
      COLOR_SETS[0].forEach((color, k) => {
        for (let p0 = 0; p0 < 9; p0++)
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 3; dx++) {
              const i = at(
                l,
                room.x + (p0 % 5) * 3 + dx,
                room.y + k * 4 + Math.floor(p0 / 5) * 2 + dy,
              );
              l.tiles[i] = p0 + 1;
              l.tileColors[i] = color;
            }
      });
      await save(l, 'floors for the phone');
      const phone = await browser.newContext({
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['iPhone 13'].userAgent,
      });
      await phone.addInitScript(() => {
        (window as unknown as { __PIXEL_AGENTS_E2E: boolean }).__PIXEL_AGENTS_E2E = true;
      });
      const mp = await phone.newPage();
      mp.on('pageerror', (e) => errors.push(String(e)));
      await mp.goto(await daemon.loginUrl());
      await mp.locator('[data-testid="agent-overlay"]').first().waitFor();
      await mp.waitForTimeout(1500);
      await mp.screenshot({ path: path.join(OUT, '04-floors-phone-open.png') });
      const cdp = await phone.newCDPSession(mp);
      const touch = async (type: string, x: number, y: number) =>
        cdp.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
        });
      for (let i = 0; i < 5; i++) {
        const p0 = await mp.evaluate(
          ({ c, r }) =>
            (
              window as unknown as {
                __pixelAgentsTestHooks: {
                  getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
                };
              }
            ).__pixelAgentsTestHooks.getTileCenter(c, r),
          { c: room.x, r: room.y },
        );
        if (!p0) break;
        const dx = 30 - p0.x;
        const dy = 120 - p0.y;
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) break;
        const cx = 196;
        const cy = 420;
        await touch('touchStart', cx, cy);
        for (let t = 1; t <= 8; t++) await touch('touchMove', cx + (dx * t) / 8, cy + (dy * t) / 8);
        await touch('touchEnd', 0, 0);
        await mp.waitForTimeout(400);
      }
      await mp.screenshot({ path: path.join(OUT, '05-floors-phone.png') });
      await phone.close();
    }
    check(errors.length === 0, `no page errors ${errors.join('|')}`);
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
