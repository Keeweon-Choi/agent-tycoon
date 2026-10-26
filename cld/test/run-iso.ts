/**
 * ISO-PILOT proof: dist/cli.js with an isolated HOME (the fake claude scenario R-8, its office
 * never asked to act) on a spare port, headless Chromium without a GPU. The building: three
 * floors (building.json), floor 1 the lobby and a room, floor 2 two rooms and a 휴게실 with
 * sofas and a coffee counter, floor 3 a room and its lounge; alpha wears the 64×128 bunny
 * (cld/packs/hd-bunny), beta the 32×64 bunny-hd-sample preset.
 *
 * Desktop 1280×800 and phone 390×844 (dpr 3): the switch off (today's office), the whole
 * building with 2F in focus and 1F, 3F dimmed, the current-floor view, a focus switch by the
 * floor button (the camera glides, the car rides) and by a click on another floor, a character
 * dragged onto another floor's button riding the elevator (the car seen between floors), a
 * character walking, a click on the HD bunny that follows it in its sharpest drawing. Measured: idle
 * frames with the view on and off, the dimmed floors' redraws while idle, frame time with 20
 * more characters (and with the CPU 4× slower). ISO-2: the owner's objects, flush storeys, one
 * elevator column. Screenshots: cld/artifacts/iso-2/.
 *
 *   npx tsx cld/test/run-iso.ts <port 18256-18259>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
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
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/iso-2');
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
const IDLE_MS = 3000;
const BASE = {
  'cld.backdrop': 'off',
  'cld.title-scene': 'off',
  'cld.floor': '2',
  'cld.floor-view': 'all',
};
const OFF = { ...BASE, 'cld.office-iso': 'off' };
const ON = { ...BASE, 'cld.office-iso': 'on' };

const results: string[] = [];
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const note = (s: string) => {
  console.log(`  ${s}`);
  results.push(s);
};
async function until(what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out: ${what}`);
}

type Iso = {
  groundRenders: number;
  dimRenders: number;
  frames: number;
  ms: number;
  focus: string;
  building: boolean;
  car: number;
  drawn: boolean;
  floors: Array<{ id: string; row: number; rows: number; level: number }>;
};
type Hooks = {
  getIso: () => Iso;
  isoPoint: (x: number, y: number) => { x: number; y: number } | null;
  getElevators: () => Array<{ floor: string; col: number; row: number; open: number }>;
  getAgentSeats: () => Array<{ id: number }>;
  getCharacterTile: (
    id: number,
  ) => { col: number; row: number; state: string; active: boolean } | null;
  getCharacterPosition: (id: number) => { x: number; y: number } | null;
  getSelectedAgentId: () => number | null;
  getCameraFollowId: () => number | null;
  isTileWalkable: (c: number, r: number) => boolean;
  getAreaTiles: () => Array<{ col: number; row: number; label: string }>;
  getTiles: () => { cols: number; rows: number; tiles: number[] };
  placeFurniture: (type: string, col: number, row: number) => boolean;
  walkTo: (id: number, c: number, r: number) => boolean;
  setZoom: (z: number) => void;
  drawnDensity: (palette: number, hue: number, zoom: number) => number;
  getCamera: () => { zoom: number; pan: { x: number; y: number } };
  spawnLook: (look: unknown, n: number, firstId: number) => number[];
};
const hooks =
  (page: Page) =>
  <T, A>(fn: (h: Hooks, a: A) => T, arg: A): Promise<T> =>
    page.evaluate(
      `(${fn.toString()})(window.__pixelAgentsTestHooks, ${JSON.stringify(arg)})`,
    ) as Promise<T>;

/** The e2e hooks; a frame counter (clearRect(0,0,...) on the office canvas = one drawn frame). */
const INIT = `
  globalThis.__name = (fn) => fn;
  window.__PIXEL_AGENTS_E2E = true;
  window.__frames = 0;
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
    if (x === 0 && y === 0 && this.canvas.dataset && this.canvas.dataset.testid === 'office-canvas') window.__frames++;
    return clear.call(this, x, y, w, h);
  };`;

const PACK = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'cld/packs/hd-bunny/pack.json'), 'utf-8'),
) as {
  id: string;
  presets: { look: { parts: Record<string, string> } & Record<string, unknown> }[];
};
const HD64 = {
  ...PACK.presets[0].look,
  parts: Object.fromEntries(
    Object.entries(PACK.presets[0].look.parts).map(([k, v]) => [k, `${PACK.id}/${v}`]),
  ),
};

function makeHome() {
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const cfg = configDirectory(fake.home);
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
  fs.mkdirSync(path.join(cfg, 'characters'), { recursive: true });
  for (const f of ['bunny-hd-sample.png', 'bunny-hd-sample.json'])
    fs.copyFileSync(
      path.join(REPO_ROOT, 'cld/artifacts/char-factory/hd-sample', f),
      path.join(cfg, 'characters', f),
    );
  fs.writeFileSync(
    path.join(cfg, 'characters.json'),
    JSON.stringify({ alpha: HD64, beta: { preset: 'bunny-hd-sample' } }),
  );
  return fake;
}

async function open(
  browser: Browser,
  daemon: ReturnType<typeof startDaemon>,
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
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(await daemon.loginUrl());
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  return { ctx, page, errors };
}

async function idleFrames(page: Page): Promise<number> {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(1500);
  const a = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
  await page.waitForTimeout(IDLE_MS);
  return (await page.evaluate(() => (window as unknown as { __frames: number }).__frames)) - a;
}

/** The coffee counter against the back wall of floor 2's lounge (a lounge row with wall above). */
async function placeCounter(
  page: Page,
  floor: Iso['floors'][number],
): Promise<{ col: number; row: number }> {
  const spot = await hooks(page)((h, f) => {
    const t = h.getTiles();
    const wall = (c: number, r: number) => t.tiles[r * t.cols + c] === 0;
    const lounge = h
      .getAreaTiles()
      .filter((a) => a.row >= f.row && a.row < f.row + f.rows && a.label.endsWith('휴게실'));
    const top = Math.min(...lounge.map((a) => a.row));
    for (const a of lounge.filter((x) => x.row === top).sort((x, y) => x.col - y.col))
      if (
        wall(a.col, top - 1) &&
        wall(a.col + 1, top - 1) &&
        h.isTileWalkable(a.col, top) &&
        h.isTileWalkable(a.col + 1, top) &&
        h.isTileWalkable(a.col + 2, top)
      )
        return { col: a.col + 1, row: top - 1 };
    return null;
  }, floor);
  check(spot, `a place for the coffee counter on floor 2's lounge (${JSON.stringify(spot)})`);
  check(
    await hooks(page)((h, s) => h.placeFurniture('SMALL_TABLE_FRONT', s.col, s.row), spot!),
    'the coffee counter placed',
  );
  return spot!;
}

async function canvasBox(page: Page) {
  return (await page.getByTestId('office-canvas').boundingBox())!;
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT))
    if (f.startsWith('desktop-') || f.startsWith('phone-') || f.startsWith('failure-'))
      fs.unlinkSync(path.join(OUT, f));
  const browser = await launchBrowser();
  const fake = makeHome();
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const pages: Page[] = [];
  try {
    // ── The switch off: today's office ──
    const off = await open(browser, daemon, DESK, OFF);
    pages.push(off.page);
    const offFrames = await idleFrames(off.page);
    check(
      !(await hooks(off.page)((h) => h.getIso().drawn, null)),
      'switch off: the top-down office is drawn, nothing isometric',
    );
    await off.page.screenshot({ path: path.join(OUT, 'desktop-off.png') });
    check(off.errors.length === 0, `off: no page errors (${off.errors.join(' | ')})`);
    await off.ctx.close();

    // ── Desktop, the whole building, 2F in focus ──
    const { ctx, page, errors } = await open(browser, daemon, DESK, ON);
    pages.push(page);
    const h = hooks(page);
    let iso = await h((x) => x.getIso(), null);
    check(
      iso.drawn && iso.focus === '2' && iso.building,
      `switch on: the building is drawn, 2F in focus (${iso.floors.length} floors)`,
    );
    check(iso.floors.length === 3, 'three floors stacked');
    // ISO-2: one elevator column: the same tile on every floor, the doors on one screen column.
    const els = await h((x) => x.getElevators(), null);
    check(
      els.length === 3 &&
        new Set(els.map((e) => e.col)).size === 1 &&
        new Set(els.map((e, k) => e.row - iso.floors[k].row)).size === 1,
      `one elevator tile on every floor (${JSON.stringify(els.map((e) => [e.col, e.row]))})`,
    );
    const doorsAt = await Promise.all(
      els.map((e) => h((x, d) => x.isoPoint(d.col * 16 + 16, d.row * 16 + 16), e)),
    );
    check(
      doorsAt.every((p) => p) && new Set(doorsAt.map((p) => Math.round(p!.x))).size === 1,
      `the doors line up on one screen column (x ${doorsAt.map((p) => Math.round(p!.x)).join(', ')})`,
    );
    const counter = await placeCounter(page, iso.floors[1]);
    await page.waitForTimeout(1500);
    const before = await h((x) => x.getIso(), null);
    const onFrames = await idleFrames(page);
    const after = await h((x) => x.getIso(), null);
    note(`idle frames in ${IDLE_MS} ms: top-down ${offFrames}, isometric ${onFrames}`);
    check(
      onFrames <= offFrames + 3,
      `idle: the isometric view draws no more frames than the top-down one (${onFrames} vs ${offFrames})`,
    );
    note(
      `dimmed floor redraws while idle: ${after.dimRenders - before.dimRenders} (ground: ${after.groundRenders - before.groundRenders})`,
    );
    await page.screenshot({ path: path.join(OUT, 'desktop-building-2F.png') });

    // ── The current-floor view (the one toggle) ──
    await page.getByTestId('iso-view-toggle').click();
    await page.waitForTimeout(1200);
    iso = await h((x) => x.getIso(), null);
    check(!iso.building, 'the toggle shows this floor');
    await page.screenshot({ path: path.join(OUT, 'desktop-floor-2F.png') });
    // The lounge with the coffee counter, close up.
    const cp = await h((x, c) => x.isoPoint(c.col * 16 + 16, c.row * 16 + 32), counter);
    const box = await canvasBox(page);
    if (cp)
      await page.screenshot({
        path: path.join(OUT, 'desktop-lounge-2F.png'),
        clip: {
          x: Math.max(0, box.x + cp.x - 260),
          y: Math.max(0, box.y + cp.y - 200),
          width: 520,
          height: 320,
        },
      });
    await page.getByTestId('iso-view-toggle').click();
    await page.waitForTimeout(1200);

    // ── Focus by the floor button: the camera glides, the car rides ──
    const pan0 = (await h((x) => x.getCamera(), null)).pan;
    await page.locator('.cld-elevator [data-floor-id="3"]').click();
    await page.waitForTimeout(250);
    const mid = await h((x) => ({ iso: x.getIso(), cam: x.getCamera() }), null);
    await page.screenshot({ path: path.join(OUT, 'desktop-focus-3F-gliding.png') });
    check(mid.iso.focus === '3', 'the 3F button focuses floor 3');
    check(
      mid.iso.car > 1 && mid.iso.car <= 2,
      `the car is on its way up (level ${mid.iso.car.toFixed(2)})`,
    );
    await page.waitForTimeout(1800);
    iso = await h((x) => x.getIso(), null);
    check(iso.car === 2, 'the car arrives at floor 3');
    note(
      `camera pan on the switch: ${JSON.stringify(pan0)} -> ${JSON.stringify(mid.cam.pan)} (mid-glide)`,
    );
    await page.screenshot({ path: path.join(OUT, 'desktop-focus-3F-button.png') });

    // ── Focus by a click on another floor (floor 1's lobby) ──
    const lobby = iso.floors[0];
    const p1 = await h((x, f) => x.isoPoint(20 * 16, (f.row + f.rows - 4) * 16), lobby);
    check(p1, 'a point on floor 1');
    const b1 = await canvasBox(page);
    await page.mouse.click(b1.x + p1!.x, b1.y + p1!.y);
    await until('floor 1 in focus', async () => (await h((x) => x.getIso().focus, null)) === '1');
    await page.waitForTimeout(1800);
    check(true, 'a click on the dimmed floor 1 focuses it');
    await page.screenshot({ path: path.join(OUT, 'desktop-focus-1F-click.png') });

    // ── Back to 2F: a character dragged onto the 3F button rides the elevator (ELEVATOR) ──
    await page.locator('.cld-elevator [data-floor-id="2"]').click();
    await page.waitForTimeout(2000);
    const f2r = iso.floors[1];
    const f3r = iso.floors[2];
    const onF2 = await h(
      (x, f) =>
        x.getAgentSeats().flatMap(({ id }) => {
          const t = x.getCharacterTile(id);
          const p = x.getCharacterPosition(id);
          return t && p && t.row >= f.row && t.row < f.row + f.rows ? [{ id, p }] : [];
        }),
      f2r,
    );
    const rider = onF2[onF2.length - 1];
    check(rider, 'someone on 2F to ride');
    // SEAT-WIRE: press where the frame drew the rider (a seated one sits on its chair's seat point,
    // off its tile), at the body's middle.
    const riderBox = (await h((x, id) => x.isoCharacterBox(id), rider.id))!;
    const rp = { x: riderBox.x + riderBox.w / 2, y: riderBox.y + riderBox.h * 0.6 + 8 };
    const rb = await canvasBox(page);
    await page.mouse.move(rb.x + rp.x, rb.y + rp.y - 8);
    await page.mouse.down();
    await page.mouse.move(rb.x + rp.x + 30, rb.y + rp.y - 8, { steps: 5 });
    const btn = (await page.locator('.cld-elevator [data-floor-id="3"]').boundingBox())!;
    await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2, { steps: 10 });
    await page.mouse.up();
    const phases: string[] = [];
    let carMid = -1;
    await until(
      'the rider rides to 3F and comes out',
      async () => {
        const t = (await h((x, id) => x.getCharacterTile(id), rider.id)) as unknown as {
          ride: string | null;
          row: number;
        };
        const car = (await h((x) => x.getIso(), null)).car;
        if (t.ride && phases.at(-1) !== t.ride) {
          phases.push(t.ride);
          if (t.ride === 'call')
            await page.screenshot({ path: path.join(OUT, 'desktop-ride-1-doors.png') });
        }
        if (t.ride === 'travel' && car > 1 && car < 2 && carMid < 0) {
          carMid = car;
          await page.screenshot({ path: path.join(OUT, 'desktop-ride-2-car-between.png') });
        }
        return !t.ride && phases.includes('out') && t.row >= f3r.row && t.row < f3r.row + f3r.rows;
      },
      45_000,
    );
    check(
      carMid > 1 && carMid < 2,
      `the car is seen between 2F and 3F (level ${carMid.toFixed(2)}); phases ${phases.join(' > ')}`,
    );
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, 'desktop-ride-3-arrived-3F.png') });

    // ── The current-floor view at zoom 4: a character walks ──
    await page.getByTestId('iso-view-toggle').click();
    await page.waitForTimeout(1500);
    await h((x) => x.setZoom(4), null);
    await page.waitForTimeout(1200);
    const f2 = iso.floors[1];
    const people = await h(
      (x, f) =>
        x.getAgentSeats().flatMap(({ id }) => {
          const t = x.getCharacterTile(id);
          return t && t.row >= f.row && t.row < f.row + f.rows ? [{ id, ...t }] : [];
        }),
      f2,
    );
    note(`on 2F: ${JSON.stringify(people.map((p) => [p.id, p.state, p.active]))}`);
    const walker = people.find((p) => !p.active) ?? people[0];
    check(walker, 'someone on 2F to walk');
    const goal = await h((x, w) => {
      for (let d = 3; d < 9; d++)
        for (const [dc, dr] of [
          [d, 0],
          [-d, 0],
          [0, d],
          [0, -d],
        ])
          if (x.isTileWalkable(w.col + dc, w.row + dr)) return { col: w.col + dc, row: w.row + dr };
      return null;
    }, walker!);
    check(
      goal && (await h((x, a) => x.walkTo(a.id, a.col, a.row), { id: walker!.id, ...goal! })),
      `a path for ${walker!.id} to ${JSON.stringify(goal)}`,
    );
    await page.waitForTimeout(450);
    const s1 = await h((x, id) => {
      const p = x.getCharacterPosition(id);
      return p && x.isoPoint(p.x, p.y);
    }, walker!.id);
    await page.screenshot({ path: path.join(OUT, 'desktop-walk-a.png') });
    await page.waitForTimeout(450);
    const s2 = await h((x, id) => {
      const p = x.getCharacterPosition(id);
      return p && x.isoPoint(p.x, p.y);
    }, walker!.id);
    await page.screenshot({ path: path.join(OUT, 'desktop-walk-b.png') });
    check(
      s1 && s2 && (s1.x !== s2.x || s1.y !== s2.y),
      `the walker moves on screen (${JSON.stringify(s1)} -> ${JSON.stringify(s2)})`,
    );

    // ── A click on the HD bunny selects and follows it, in its sharpest drawing ──
    const alpha = people.find((p) => p.id !== walker!.id) ?? people[0];
    // SEAT-WIRE: click where the frame drew it (seated, it sits on its chair's seat point).
    const abox = await h((x, id) => x.isoCharacterBox(id), alpha.id);
    const b2 = await canvasBox(page);
    if (abox) await page.mouse.click(b2.x + abox.x + abox.w / 2, b2.y + abox.y + abox.h * 0.6);
    await page.waitForTimeout(1500);
    const sel = await h((x) => ({ s: x.getSelectedAgentId(), f: x.getCameraFollowId() }), null);
    check(
      sel.s === alpha.id && sel.f === alpha.id,
      `a click on character ${alpha.id} (drawn where it stands) selects and follows it`,
    );
    await page.screenshot({ path: path.join(OUT, 'desktop-follow-hd.png') });

    // ── Frame time with 20 more characters (unthrottled, then the CPU 4× slower) ──
    await page.keyboard.press('Escape');
    await h((x) => x.setZoom(2), null);
    await page.waitForTimeout(800);
    await h((x, look) => x.spawnLook(look, 20, 900), HD64);
    await page.waitForTimeout(3000);
    const cdp = await ctx.newCDPSession(page);
    for (const rate of [1, 4]) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      await page.waitForTimeout(1000);
      const a = await h((x) => x.getIso(), null);
      const fa = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
      await page.waitForTimeout(IDLE_MS);
      const b = await h((x) => x.getIso(), null);
      const fb = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
      note(
        `20 more characters, CPU ${rate}×: ${((b.ms - a.ms) / Math.max(1, b.frames - a.frames)).toFixed(2)} ms per isometric frame, ${fb - fa} frames in ${IDLE_MS} ms, dimmed floor redraws ${b.dimRenders - a.dimRenders}`,
      );
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.screenshot({ path: path.join(OUT, 'desktop-20-more.png') });
    check(errors.length === 0, `desktop: no page errors (${errors.join(' | ')})`);
    await ctx.close();

    // ── Phone: the whole building, this floor, a tap on another floor ──
    const ph = await open(browser, daemon, PHONE, ON);
    pages.push(ph.page);
    const hp = hooks(ph.page);
    await ph.page.screenshot({ path: path.join(OUT, 'phone-building-2F.png') });
    const pf = (await hp((x) => x.getIso(), null)).floors[2];
    const tp = await hp((x, f) => x.isoPoint(10 * 16, (f.row + 8) * 16), pf);
    const pb = await canvasBox(ph.page);
    if (tp) await ph.page.touchscreen.tap(pb.x + tp.x, pb.y + tp.y);
    await until(
      'phone: floor 3 in focus',
      async () => (await hp((x) => x.getIso().focus, null)) === '3',
    );
    await ph.page.waitForTimeout(1800);
    check(true, 'phone: a tap on the dimmed floor 3 focuses it');
    await ph.page.screenshot({ path: path.join(OUT, 'phone-focus-3F-tap.png') });
    await ph.page.getByTestId('floor-picker').click();
    await ph.page.getByTestId('iso-view-toggle').click();
    await ph.page.waitForTimeout(1500);
    await ph.page.screenshot({ path: path.join(OUT, 'phone-floor-3F.png') });
    check(ph.errors.length === 0, `phone: no page errors (${ph.errors.join(' | ')})`);
    await ph.ctx.close();
    fs.writeFileSync(path.join(OUT, 'measurements.txt'), results.join('\n') + '\n');
    console.log('all checks passed');
  } catch (err) {
    for (const [i, pg] of pages.entries())
      await pg.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => undefined);
    throw err;
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
