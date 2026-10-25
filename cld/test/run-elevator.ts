/**
 * ELEVATOR check: dist/cli.js with an isolated HOME (fake office and claude, R-8) on a spare
 * port, logged in, in headless Chromium without a GPU. The real claude and office are never
 * run. Desktop 1280x800, office hours off (the runners' default).
 *
 * 편집 -> 층 추가 gives two floors, each with an elevator, and the office draws no more frames
 * while nothing moves than with one floor. Then: beta (idle) dragged onto the 2 button walks to
 * the elevator, waits for the doors, is hidden in the car, comes out on floor 2 and visits there
 * (nothing is sent, the building is unchanged); in the one-floor view, dragged back onto 1, it comes out of the
 * floor-1 doors while floor 1 shows; orch-gamma's room chip moved to floor 2 in 편집 takes eta
 * and theta up by elevator (no jump); alpha let go over floor 2 on the canvas (all floors shown)
 * rides there; beta walked onto the lobby entrance stays in the office. Screenshots:
 * cld/artifacts/elevator/.
 *
 *   npx tsx cld/test/run-elevator.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/elevator');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__elevator/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
};
const IDLE_MS = 3000;

/** The e2e hooks, and a frame counter: a clearRect(0,0,...) on the office canvas, once per
 *  animation frame (with floors the canvas is cleared twice a frame: the other floors' layer
 *  is drawn first, then the shown floor). */
const INIT = `
  globalThis.__name = (fn) => fn;
  window.__PIXEL_AGENTS_E2E = true;
  window.__frames = 0;
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
    if (x === 0 && y === 0 && this.canvas.dataset && this.canvas.dataset.testid === 'office-canvas') {
      const t = document.timeline.currentTime;
      if (t !== window.__frameAt) {
        window.__frameAt = t;
        window.__frames++;
      }
    }
    return clear.call(this, x, y, w, h);
  };`;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

let lastSeen = '';
async function until(what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${what} (last seen: ${lastSeen})`);
}

type Tile = {
  col: number;
  row: number;
  state: string;
  queued: number;
  away: boolean;
  ride: string | null;
  hidden: boolean;
  visit: string | null;
};
type Lift = { floor: string; col: number; row: number; open: number };
type Rect = { id: string; row: number; rows: number; cols: number };
type Building = { floors: Array<{ id: string; rooms: string[]; characters: string[] }> };

const hook = <T>(page: Page, call: string): Promise<T> =>
  page.evaluate(`window.__pixelAgentsTestHooks.${call}`) as Promise<T>;
const tileOf = async (page: Page, id: number) => {
  const t = await hook<Tile | null>(page, `getCharacterTile(${id})`);
  lastSeen = `${id}: ${JSON.stringify(t)}`;
  return t;
};
const lifts = (page: Page) => hook<Lift[]>(page, 'getElevators()');
const tileCenter = (page: Page, col: number, row: number) =>
  hook<{ x: number; y: number } | null>(page, `getTileCenter(${col}, ${row})`);
const onRect = (r: Rect, row: number) => row >= r.row && row < r.row + r.rows;
/** Rows floor 2 is drawn shifted by in the stacked view while floor 1 shows (run-floors.ts). */
const shiftRows = (r1: Rect, r2: Rect) => r1.row - r2.row - (r2.rows + (r2.row - r1.row - r1.rows));

/** Frames drawn in IDLE_MS while nothing on the office moves: no character walks, rides, spawns
 *  or shows a fading bubble, no pet is on the move (a few tries: idle ones wander). */
async function idleFrames(page: Page): Promise<number | null> {
  for (let i = 0; i < 15; i++) {
    const r = (await page.evaluate(`(async () => {
      const h = window.__pixelAgentsTestHooks;
      const start = window.__frames;
      const t0 = performance.now();
      let moved = false;
      while (performance.now() - t0 < ${IDLE_MS}) {
        for (const c of h.getCharacters()) {
          const t = h.getCharacterTile(c.id);
          if (c.matrixEffect || c.bubbleType === 'waiting' || (t && !t.away && (t.state === 'walk' || t.ride)))
            moved = true;
        }
        for (const p of h.getPets()) if (p.state !== 'idle' || p.bubbleType) moved = true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return { frames: window.__frames - start, moved };
    })()`)) as { frames: number; moved: boolean };
    if (!r.moved) return r.frames;
  }
  return null;
}

let lastPage: Page | null = null;
let beta0 = 0;
let dropInfo = '';
async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f));
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const received: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const pageErrors: string[] = [];
  const font = fs.readFileSync(FONT);
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext(DESKTOP);
    await ctx.route('**/__elevator/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    await ctx.addInitScript(INIT);
    await warmUpOffice(ctx, daemon);
    const page = await ctx.newPage();
    lastPage = page;
    const keep = (into: typeof received) => (f: { payload: string | Buffer }) => {
      try {
        into.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
      } catch {
        /* binary */
      }
    };
    page.on('websocket', (ws) => {
      ws.on('framereceived', keep(received));
      ws.on('framesent', keep(sent));
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on(
      'console',
      (m) =>
        m.type() === 'error' &&
        !m.text().startsWith('Failed to load resource') &&
        pageErrors.push(`console: ${m.text()}`),
    );
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(BASE);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(2500);

    const latest = (type: string) => [...received].reverse().find((m) => m.type === type);
    const building = () => latest('buildingState') as unknown as Building;
    const rects = () =>
      (latest('layoutLoaded') as { layout: { cldFloors?: Rect[] } }).layout.cldFloors ?? [];
    const agentId = (name: string) =>
      (
        latest('officeSnapshot') as { orchestrators: Array<{ name: string; agentId: number }> }
      ).orchestrators.find((o) => o.name === name)!.agentId;
    const ids = ['alpha', 'beta', 'eta', 'theta'].map(agentId);
    const [alpha, beta, eta, theta] = ids;
    beta0 = beta;
    const label = (id: number) =>
      page.locator(`[data-testid="agent-overlay"][data-agent-id="${id}"]`);
    const floorButton = (id: string) => page.locator(`.cld-elevator [data-floor-id="${id}"]`);
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const press = async (key: string) => {
      await page.keyboard.press(key);
      await page.waitForFunction(() => !document.querySelector('[data-testid="elevator-doors"]'));
    };
    /** Drag character `id` (by its label) and let go at a page point. */
    const drag = async (id: number, where: () => Promise<{ x: number; y: number }>) => {
      // Its card first: the camera follows it to the middle of the canvas, clear of the panels.
      await page.locator(`[data-testid="agent-card"][data-agent-id="${id}"]`).first().click();
      await page.waitForTimeout(1200);
      const to = await where();
      // Its body: the 24 world px above its feet are its hit box (sitting, 6 px lower).
      const t = (await tileOf(page, id))!;
      const c = (await tileCenter(page, t.col, t.row))!;
      const scale = (await page.evaluate(`(() => {
        const h = window.__pixelAgentsTestHooks;
        return (h.getTileCenter(1, 0).x - h.getTileCenter(0, 0).x) / 16;
      })()`)) as number;
      const canvasBox = (await page.getByTestId('office-canvas').boundingBox())!;
      const from = { x: canvasBox.x + c.x, y: canvasBox.y + c.y - 8 * scale };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 30, from.y + 10, { steps: 6 });
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.waitForTimeout(100);
      dropInfo = (await page.evaluate(
        `(() => { const e = document.elementFromPoint(${to.x}, ${to.y}); return (e && (e.dataset.testid || e.className || e.tagName)) + ''; })()`,
      )) as string;
      await page.mouse.up();
    };
    const center = async (loc: ReturnType<Page['locator']>) => {
      const b = (await loc.boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    type Rides = { phases: Record<string, string[]>; shots: Record<string, string> };
    /** Watch characters `ids` from inside the page, every frame (a ride's phases last 0.35 s
     *  and more): the phases each goes through, and the office canvas at the doors open with a
     *  rider in front, a rider shut in, and a rider coming out. */
    const watchRides = (ids: number[]) =>
      page.evaluate(`(() => {
        const h = window.__pixelAgentsTestHooks;
        const canvas = document.querySelector('[data-testid="office-canvas"]');
        const ids = ${JSON.stringify(ids)};
        const rec = (window.__rides = { phases: {}, shots: {} });
        for (const id of ids) rec.phases[id] = [];
        const t0 = performance.now();
        const tick = () => {
          const open = Math.max(...h.getElevators().map((e) => e.open));
          for (const id of ids) {
            const c = h.getCharacterTile(id);
            const p = rec.phases[id];
            const phase = c.ride || 'none';
            if (p[p.length - 1] !== phase) p.push(phase);
            if (!rec.shots.open && (c.ride === 'call' || c.ride === 'in') && open >= 0.99)
              rec.shots.open = canvas.toDataURL();
            if (!rec.shots.inside && c.ride === 'close' && c.rideT >= 0.15)
              rec.shots.inside = canvas.toDataURL();
            if (!rec.shots.out && c.ride === 'out' && c.rideT >= 0.1) rec.shots.out = canvas.toDataURL();
          }
          if (performance.now() - t0 < 60000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })()`);
    const rides = () => page.evaluate('window.__rides') as Promise<Rides>;
    /** A full ride: it waited for the doors, was shut in, rode and came out. */
    const rodeFully = (p: string[] = []) =>
      ['call', 'in', 'close', 'travel', 'open', 'out'].every(
        (x, k, all) => p.indexOf(x) >= 0 && (k === 0 || p.indexOf(x) > p.indexOf(all[k - 1])),
      );
    const saveShots = async (names: Record<string, string>) => {
      const { shots } = await rides();
      for (const [k, name] of Object.entries(names))
        if (shots[k])
          fs.writeFileSync(
            path.join(OUT, `${name}.png`),
            Buffer.from(shots[k].split(',')[1], 'base64'),
          );
      return Object.keys(names).filter((k) => !shots[k]);
    };

    // ── Two floors, an elevator on each; idle frames before and after ──
    await page.mouse.move(1270, 790);
    await page.waitForTimeout(2000);
    const before = await idleFrames(page);
    await page.locator('.cld-elevator-edit').click();
    await page.getByTestId('floor-editor').waitFor();
    await page.getByRole('button', { name: '층 추가' }).click(); // 층 추가
    await until('two floors', async () => building().floors.length === 2 && rects().length === 2);
    const f2 = building().floors[1].id;
    await page.locator('.cld-elevator-edit').click(); // the editor closed
    await until('two elevators', async () => (await lifts(page)).length === 2);
    const [l1, l2] = await lifts(page);
    let [r1, r2] = rects();
    check(
      onRect(r1, l1.row) && onRect(r2, l2.row) && l1.open === 0 && l2.open === 0,
      `two floors, an elevator on each (floor 1 at ${l1.col},${l1.row}; floor 2 at ${l2.col},${l2.row}), doors shut`,
    );
    await page.mouse.move(1270, 790);
    await page.waitForTimeout(2000);
    const after = await idleFrames(page);
    check(
      before !== null && after !== null && after <= before + 2,
      `idle frames in ${IDLE_MS} ms with nothing moving: ${before} with one floor, ${after} with two floors and their elevators`,
    );
    await shot('1-two-floors-elevators');

    // ── Step 1 + 3: beta dragged onto the 2 button rides there and visits ──
    const homeBeta = (await tileOf(page, beta))!;
    await drag(beta, () => center(floorButton(f2)));
    await watchRides([beta]);
    await until(
      'beta rides to floor 2',
      async () => {
        const t = (await tileOf(page, beta))!;
        return rodeFully((await rides()).phases[beta]) && !t.ride && onRect(r2, t.row);
      },
      30_000,
    );
    const missed = await saveShots({
      open: '2-ride-doors-open-floor1',
      inside: '3-ride-shut-in-doors-closing',
      out: '4-ride-comes-out-floor2',
    });
    await page.waitForTimeout(400);
    const up = (await tileOf(page, beta))!;
    check(
      onRect(r2, up.row) && up.visit === f2 && !missed.length,
      `beta walked to the floor-1 elevator, waited for the doors, was shut in, rode and came out on floor 2 (${up.col},${up.row}), visiting it (phases ${(await rides()).phases[beta].join(' > ')})`,
    );
    check(
      !building().floors[1].characters.includes('beta') &&
        !sent.some((m) => m.type === 'moveToFloor'),
      'the drop moved only the character, on this page: no moveToFloor sent, the building is unchanged',
    );
    await page.waitForTimeout(5000);
    const stays = (await tileOf(page, beta))!;
    check(
      onRect(r2, stays.row) && stays.visit === f2,
      'five seconds later beta still visits floor 2',
    );
    await shot('5-beta-visits-floor2');

    // ── The one-floor view: dragged back onto 1, it comes out of the floor-1 doors ──
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: '설정' }).click(); // 설정
    await page.getByRole('tab', { name: '화면', exact: true }).click(); // 화면
    await page.getByTestId('floor-view-option').getByRole('button', { name: '한 층만' }).click(); // 한 층만
    await page.getByRole('dialog').last().getByRole('button', { name: 'x', exact: true }).click();
    await page.waitForTimeout(800);
    await drag(beta, () => center(floorButton('1')));
    await watchRides([beta]);
    // Followed (its card), it takes the one floor shown along: floor 1 when it gets there.
    await until(
      'beta back on floor 1',
      async () => {
        const t = (await tileOf(page, beta))!;
        return rodeFully((await rides()).phases[beta]) && !t.ride && t.queued === 0 && !t.visit;
      },
      30_000,
    );
    const cameOut = !(await saveShots({ out: '6-one-floor-view-comes-out-floor1' })).length;
    const home = (await tileOf(page, beta))!;
    check(
      cameOut && onRect(r1, home.row) && home.visit === null,
      `one floor shown: beta came out of the floor-1 doors and went home (${home.col},${home.row}; seat at ${homeBeta.col},${homeBeta.row})`,
    );

    // ── Step 2: orch-gamma's room moved to floor 2 in 편집: eta and theta ride up ──
    await page.getByRole('button', { name: '설정' }).click();
    await page.getByRole('tab', { name: '화면', exact: true }).click();
    await page
      .getByTestId('floor-view-option')
      .getByRole('button', { name: '모든 층 보기' })
      .click(); // 모든 층 보기
    await page.getByRole('dialog').last().getByRole('button', { name: 'x', exact: true }).click();
    await page.waitForTimeout(500);
    await press('1');
    const layouts = received.filter((m) => m.type === 'layoutLoaded').length;
    await page.locator('.cld-elevator-edit').click();
    const chip = page.locator('[data-testid="floor-editor"] .cld-chip', { hasText: 'orch-gamma' });
    await chip.dragTo(floorButton(f2));
    await until('orch-gamma on floor 2', async () =>
      building().floors[1].rooms.includes('orch-gamma'),
    );
    await until(
      'the new office',
      async () => received.filter((m) => m.type === 'layoutLoaded').length > layouts,
    );
    await page.locator('.cld-elevator-edit').click();
    [r1, r2] = rects();
    const firstSeen = await Promise.all([eta, theta].map((id) => tileOf(page, id)));
    await watchRides([eta, theta]);
    await until(
      'eta and theta upstairs',
      async () => {
        const ts = await Promise.all([eta, theta].map((id) => tileOf(page, id)));
        const { phases } = await rides();
        return (
          [eta, theta].every((id) => rodeFully(phases[id])) &&
          ts.every((t) => !t!.ride && onRect(r2, t!.row) && t!.queued === 0)
        );
      },
      40_000,
    );
    await saveShots({ open: '7-room-move-at-the-elevator' });
    check(
      firstSeen.every((t) => onRect(r1, t!.row)),
      `after the room move eta and theta were still on floor 1 (${firstSeen.map((t) => `${t!.col},${t!.row}`).join(' ')}), and both rode the elevator up to their new seats`,
    );
    await press('2');
    await page.waitForTimeout(600);
    await shot('8-room-move-floor2');
    await press('1');

    // ── Step 3 on the canvas: alpha let go over floor 2 (all floors shown) rides there ──
    [r1, r2] = rects();
    const lift = shiftRows(r1, r2);
    await drag(alpha, async () => {
      const canvas = (await page.getByTestId('office-canvas').boundingBox())!;
      let target: { x: number; y: number } | null = null;
      for (let i = 0; i < 8 && !target; i++) {
        const p = await tileCenter(
          page,
          Math.floor(r2.cols / 2),
          r2.row + r2.rows - 3 + lift, // its bottom rows: the nearest to floor 1 below
        );
        if (p && p.y > 120 && p.y < canvas.height - 160)
          target = { x: canvas.x + p.x, y: canvas.y + p.y };
        else {
          await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
          await page.keyboard.down('Control');
          await page.mouse.wheel(0, 120);
          await page.keyboard.up('Control');
          await page.waitForTimeout(600);
        }
      }
      check(target, 'floor 2 is in view above floor 1');
      return target!;
    });
    await until(
      'alpha on floor 2',
      async () => {
        const t = (await tileOf(page, alpha))!;
        lastSeen += ` (dropped on: ${dropInfo})`;
        return t.visit === f2 && !t.ride && onRect(r2, t.row) && t.queued === 0;
      },
      30_000,
    );
    check(true, 'alpha let go over floor 2 on the canvas rode up and visits it');
    await press('2');
    await page.waitForTimeout(600);
    await shot('9-canvas-drop-alpha-floor2');
    await press('1');

    // ── Step 4: beta walked onto the lobby entrance stays ──
    // Its turn ends first (an idle character walks where it is sent; a working one goes back
    // to its desk): a turn's end in its transcript.
    fs.appendFileSync(
      path.join(
        fake.home,
        '.claude/projects/-work-orch-alpha/a0000002-0000-4000-8000-000000000002.jsonl',
      ),
      `${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1000 })}\n`,
    );
    await until('beta idle', async () => !(await tileOf(page, beta))!.active, 20_000);
    // The entrance: floor tiles of floor 1 next to the void (the office door in the lobby).
    const office = (latest('layoutLoaded') as { layout: { cols: number; tiles: number[] } }).layout;
    const VOID = 255;
    const WALL = 0;
    const at = (c: number, r: number) =>
      c < 0 || c >= office.cols || !onRect(r1, r) ? VOID : office.tiles[r * office.cols + c];
    let entrance: { col: number; row: number } | null = null;
    for (let r = r1.row; r < r1.row + r1.rows && !entrance; r++)
      for (let c = 0; c < office.cols && !entrance; c++) {
        const t = at(c, r);
        if (t === VOID || t === WALL) continue;
        if ([at(c - 1, r), at(c + 1, r), at(c, r - 1), at(c, r + 1)].includes(VOID))
          entrance = { col: c, row: r };
      }
    check(entrance, `the lobby entrance is at ${entrance?.col},${entrance?.row}`);
    const door = entrance!.col;
    const doorRow = entrance!.row;
    check(
      await hook<boolean>(page, `walkAgentTo(${beta}, ${door}, ${doorRow})`),
      'beta sets off for the entrance',
    );
    await until(
      'beta at the entrance',
      async () => {
        const t = (await tileOf(page, beta))!;
        return t.col === door && t.row === doorRow && t.queued === 0;
      },
      30_000,
    );
    await shot('10-entrance-beta-stands-there');
    await page.waitForTimeout(6000);
    const after4 = (await tileOf(page, beta))!;
    const drawn = (await hook<Array<{ id: number }>>(page, 'getCharacters()')).map((c) => c.id);
    check(
      !after4.away && drawn.includes(beta),
      'six seconds after reaching the entrance beta is still in the office (not 퇴근)',
    );
    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`,
    );
    await ctx.close();
  } catch (err) {
    console.error(daemon.log.join('').slice(-1500));
    console.error(`page errors: ${pageErrors.join(' | ').slice(0, 3000)}`);
    console.error(
      `elevators: ${JSON.stringify(await lastPage?.evaluate('window.__pixelAgentsTestHooks.getElevators()').catch(() => null))}`,
    );
    const probe =
      "(async () => { const h = window.__pixelAgentsTestHooks; const log = []; let last = ''; const t0 = performance.now(); " +
      `const tick = () => { const c = h.getCharacterTile(${beta0}); const e = h.getElevators(); ` +
      "const k = [c.ride, c.col + ',' + c.row, c.queued, c.active, e.map((x) => x.open.toFixed(2)).join('/')].join(' '); " +
      "if (k.split(' ')[0] !== last) { last = k.split(' ')[0]; log.push(Math.round(performance.now() - t0) + 'ms ' + k + ' t=' + c.rideT); } " +
      'if (performance.now() - t0 < 4000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); ' +
      'await new Promise((r) => setTimeout(r, 4100)); return log; })()';
    console.error(
      `loop: ${JSON.stringify(await lastPage?.evaluate(probe).catch((e) => String(e)))}`,
    );
    throw err;
  } finally {
    await browser.close();
    await daemon.stop();
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  },
);
