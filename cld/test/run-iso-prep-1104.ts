/**
 * iso-prep-1104 check: dist/cli.js in an isolated HOME (fake claude) on a spare port, headless
 * Chromium (no GPU), the isometric view on.
 *  1. The generated office: the pantry's water cooler stands in its isometric picture (whole
 *     view, then zoomed in on it to the maximum zoom, shown 2x).
 *  2. A showroom (the layout the page receives is swapped for a small room): every furniture type
 *     newly given its isometric picture (turned desk, small table, chairs, PC, the eight new types)
 *     is drawn in it, none as its top-down sprite; then zoom 8 (the floor cache at its finest,
 *     density 4: the walls and floors shipped at 4 drawn 1:1) and the maximum zoom, shown 2x.
 * Screenshots: cld/artifacts/iso-prep-1104/.
 *
 *   npx tsx cld/test/run-iso-prep-1104.ts <port 18500-18509>
 */
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18500 && port <= 18509)) throw new Error('port must be 18500-18509');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/iso-prep-1104');
const ZOOM_MAX = 10;
const VIEW = { width: 1280, height: 800 };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

type Iso = { drawn: boolean; spriteOnly: string[] };
type Cam = { zoom: number };
type Item = { uid: string; type: string; col: number; row: number };
type Layout = {
  version: number;
  cols: number;
  rows: number;
  tiles: number[];
  furniture: Item[];
  [k: string]: unknown;
};

const iso = (page: Page) => page.evaluate('window.__agentTycoonTestHooks.getIso()') as Promise<Iso>;
const cam = (page: Page) =>
  page.evaluate('window.__agentTycoonTestHooks.getCamera()') as Promise<Cam>;
const isoPoint = (page: Page, x: number, y: number) =>
  page.evaluate(`window.__agentTycoonTestHooks.isoPoint(${x}, ${y})`) as Promise<{
    x: number;
    y: number;
  } | null>;

/** The canvas's CSS box on the page. */
const canvasBox = (page: Page) =>
  page.locator('[data-testid="office-canvas"]').boundingBox() as Promise<{ x: number; y: number }>;

/** Ctrl+wheel over page point (x, y) until the camera's zoom is `to` (at most 40 notches). */
async function zoomTo(page: Page, x: number, y: number, to: number): Promise<number> {
  await page.mouse.move(x, y);
  for (let i = 0; i < 40; i++) {
    const z = (await cam(page)).zoom;
    if (z === to) break;
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, z < to ? -120 : 120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(800);
  return (await cam(page)).zoom;
}

/** A page clip saved twice as large, pixel for pixel (nearest), so the art's grain shows. */
async function shot2x(page: Page, file: string, cx: number, cy: number, w: number, h: number) {
  const x = Math.max(0, Math.min(VIEW.width - w, Math.round(cx - w / 2)));
  const y = Math.max(0, Math.min(VIEW.height - h, Math.round(cy - h / 2)));
  const src = PNG.sync.read(await page.screenshot({ clip: { x, y, width: w, height: h } }));
  const out = new PNG({ width: w * 2, height: h * 2 });
  for (let j = 0; j < out.height; j++)
    for (let i = 0; i < out.width; i++)
      src.data.copy(
        out.data,
        (j * out.width + i) * 4,
        ((j >> 1) * w + (i >> 1)) * 4,
        ((j >> 1) * w + (i >> 1)) * 4 + 4,
      );
  fs.writeFileSync(path.join(OUT, file), PNG.sync.write(out));
}

async function open(
  browser: Browser,
  daemon: ReturnType<typeof startDaemon>,
  swap: ((l: Layout) => Layout) | null,
) {
  const ctx = await browser.newContext({ viewport: VIEW });
  await ctx.addInitScript(() => {
    const w = window as unknown as { __name: (v: unknown) => unknown; __AGENT_TYCOON_E2E: boolean };
    w.__name = (v) => v;
    w.__AGENT_TYCOON_E2E = true;
    for (const [k, v] of [
      ['cld.backdrop', 'off'],
      ['cld.title-scene', 'off'],
      ['cld.office-iso', 'on'],
    ])
      try {
        localStorage.setItem(k, v);
      } catch {
        // about:blank
      }
  });
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let layout: Layout | null = null;
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      try {
        const m = JSON.parse(String(message)) as { type: string; layout?: Layout | null };
        if (m.type === 'layoutLoaded' && m.layout) {
          if (swap) m.layout = swap(m.layout);
          layout = m.layout;
        }
        ws.send(JSON.stringify(m));
      } catch {
        ws.send(message);
      }
    });
    ws.onMessage((message) => server.send(message));
  });
  await page.goto(await daemon.loginUrl());
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  for (let i = 0; i < 40 && !(await iso(page)).drawn; i++) await page.waitForTimeout(250);
  await page.waitForTimeout(2500);
  return { ctx, page, errors, layout: () => layout };
}

/** The showroom: a 22x14 room (back walls on row 0 and column 0) and what is shown in it. */
const SHOW: Item[] = [
  { uid: 's:desk-side', type: 'DESK_SIDE', col: 2, row: 1 },
  { uid: 's:pc-side', type: 'PC_SIDE', col: 2, row: 2 },
  { uid: 's:chair-side', type: 'WOODEN_CHAIR_SIDE', col: 3, row: 2 },
  { uid: 's:table-side', type: 'SMALL_TABLE_SIDE', col: 5, row: 1 },
  { uid: 's:chair-left', type: 'WOODEN_CHAIR_SIDE:left', col: 6, row: 2 },
  { uid: 's:cushion-left', type: 'CUSHIONED_CHAIR_SIDE:left', col: 6, row: 4 },
  { uid: 's:desk-b', type: 'DESK_B_FRONT', col: 8, row: 1 },
  { uid: 's:pc-back', type: 'PC_BACK', col: 9, row: 1 },
  { uid: 's:desk-b-side', type: 'DESK_B_SIDE', col: 12, row: 1 },
  { uid: 's:arm-front', type: 'ARMCHAIR_FRONT', col: 14, row: 2 },
  { uid: 's:arm-side', type: 'ARMCHAIR_SIDE', col: 15, row: 2 },
  { uid: 's:cab-front', type: 'CABINET_FRONT', col: 17, row: 1 },
  { uid: 's:cab-side', type: 'CABINET_SIDE', col: 18, row: 1 },
  { uid: 's:rug', type: 'RUG_ROUND', col: 3, row: 7 },
  { uid: 's:table-b', type: 'COFFEE_TABLE_B', col: 8, row: 8 },
  { uid: 's:board-side', type: 'WHITEBOARD_SIDE', col: 12, row: 7 },
  { uid: 's:cooler', type: 'WATER_COOLER', col: 16, row: 7 },
];

function showroom(l: Layout): Layout {
  const cols = 22;
  const rows = 14;
  const tiles = Array.from({ length: cols * rows }, (_, i) => {
    const [c, r] = [i % cols, Math.floor(i / cols)];
    return r === 0 || c === 0 || r === rows - 1 || c === cols - 1 ? 0 : 7;
  });
  return {
    version: l.version,
    cols,
    rows,
    tiles,
    tileColors: tiles.map(() => null),
    furniture: SHOW,
  };
}

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  try {
    // 1. The generated office's pantry.
    const a = await open(browser, daemon, null);
    const cooler = a.layout()?.furniture.find((f) => f.type === 'WATER_COOLER');
    check(cooler, `the generated office has its water cooler (${cooler?.uid})`);
    const st = await iso(a.page);
    check(st.drawn, 'the isometric view is drawn');
    check(
      !st.spriteOnly.includes('WATER_COOLER'),
      `the water cooler wears its isometric picture (top-down only: ${st.spriteOnly.join(', ') || 'none'})`,
    );
    await a.page.screenshot({ path: path.join(OUT, 'pantry-office.png') });
    const box = await canvasBox(a.page);
    const at = await isoPoint(a.page, (cooler!.col + 0.5) * 16, (cooler!.row + 2) * 16);
    check(at, 'the water cooler is on screen');
    const z = await zoomTo(a.page, box.x + at!.x, box.y + at!.y, ZOOM_MAX);
    check(z === ZOOM_MAX, `zoomed to the maximum (${z})`);
    const near = (await isoPoint(a.page, (cooler!.col + 0.5) * 16, (cooler!.row + 2) * 16))!;
    await shot2x(
      a.page,
      'pantry-cooler-zoom10-2x.png',
      box.x + near.x,
      box.y + near.y - 150,
      360,
      360,
    );
    check(a.errors.length === 0, `no page errors (${a.errors.join(' | ')})`);
    await a.ctx.close();

    // 2. The showroom.
    const b = await open(browser, daemon, showroom);
    const sb = await iso(b.page);
    const shown = SHOW.map((s) => s.type).filter((t) => sb.spriteOnly.includes(t));
    check(sb.drawn, 'the showroom is drawn');
    check(
      shown.length === 0,
      `every type shown wears its isometric picture (top-down only: ${shown.join(', ') || 'none'})`,
    );
    await b.page.screenshot({ path: path.join(OUT, 'showroom.png') });
    const bb = await canvasBox(b.page);
    for (const [zoom, file, wx, wy] of [
      [8, 'showroom-zoom8-2x.png', 13 * 16, 4 * 16],
      [ZOOM_MAX, 'showroom-zoom10-2x.png', 15 * 16, 3 * 16],
      [ZOOM_MAX, 'showroom-zoom10-rug-2x.png', 5 * 16, 9 * 16],
    ] as const) {
      const p = (await isoPoint(b.page, wx, wy))!;
      const got = await zoomTo(b.page, bb.x + p.x, bb.y + p.y, zoom);
      check(got === zoom, `zoom ${zoom} (${got})`);
      const q = (await isoPoint(b.page, wx, wy))!;
      await shot2x(b.page, file, bb.x + q.x, bb.y + q.y - 60, 480, 360);
    }
    check(b.errors.length === 0, `no page errors (${b.errors.join(' | ')})`);
    await b.ctx.close();
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
