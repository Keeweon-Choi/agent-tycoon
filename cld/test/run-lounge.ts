/**
 * LOUNGE check: dist/cli.js with an isolated HOME (fake office and claude) on a spare port, logged in,
 * headless Chromium without a GPU. The page clock is fixed at 23:00 host time (the daemon on Seoul
 * time, the page on UTC), office hours on, so every idle orchestrator is off duty.
 *
 * - The 휴게실 and its 탕비실 on floor 1: the three machines stand against the lounge's top wall.
 * - Opened at 23:00, the idle orchestrators already rest on the lounge's seats (sofas, lobby benches),
 *   dozing under a zzz, none walking out or in; their cards say 퇴근 and each has the 퇴근 badge.
 * - One is sent for a drink: it walks to a machine, the machine plays its states, it drinks in the
 *   owner's seven steps and walks back to its seat.
 * - One is dragged (the real mouse) to its own desk while off duty: it sits there, still resting.
 * - The page clock moves to 10:00 the next day: everyone walks from where they are to their desks,
 *   with no spawn effect and no door.
 * - The 인테리어 editor lists the three machines and can select one.
 * - Idle frames in 3 s, desktop and phone emulation: the same resting at 23:00 as the day office.
 * Screenshots: cld/artifacts/lounge/.
 *
 *   npx tsx cld/test/run-lounge.ts <port 18256-18259>
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/lounge');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__lounge/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  timezoneId: 'UTC',
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  timezoneId: 'UTC',
};
const NIGHT = new Date('2026-10-21T23:00:00+09:00'); // a Wednesday, host time
const MORNING = new Date('2026-10-22T10:00:00+09:00');
const IDLE_MS = 3000;
const HOURS_OFF = `try { localStorage.setItem('cld.office-hours', '{"on":false}') } catch {}`;

/** The e2e hooks, and a frame counter: a clearRect(0,0,...) on the office canvas, once per animation frame. */
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
async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what} (last seen: ${lastSeen})`);
}

interface Tile {
  col: number;
  row: number;
  state: string;
  queued: number;
  away: boolean;
  rest: string | null;
  restSeat: string | null;
  restKind: string | null;
}
const hook = <T>(page: Page, call: string): Promise<T> =>
  page.evaluate(`window.__pixelAgentsTestHooks.${call}`) as Promise<T>;
const tileOf = async (page: Page, id: number) => {
  const t = await hook<Tile | null>(page, `getCharacterTile(${id})`);
  lastSeen = `${id}: ${JSON.stringify(t)}`;
  return t;
};
const characters = (page: Page) =>
  hook<Array<{ id: number; matrixEffect: string | null; isSubagent?: boolean }>>(
    page,
    'getCharacters()',
  );

/** Frames drawn in IDLE_MS while nothing on the office moves (a few tries: a walker is not idle). */
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

/** The idle frames once they hold steady (sprites warm up for a while after a page opens). */
async function steadyIdleFrames(page: Page): Promise<number | null> {
  const end = Date.now() + 40_000; // sprites warm one slice at a time: wait for the queue to empty
  while (Date.now() < end && (await hook<{ warm: number }>(page, 'getBusy()')).warm > 0)
    await page.waitForTimeout(250);
  let prev: number | null = null;
  let last: number | null = null;
  for (let i = 0; i < 6; i++) {
    last = await idleFrames(page);
    if (prev !== null && last !== null && Math.abs(last - prev) <= 3) return last;
    prev = last;
  }
  return last;
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT))
    if (f.endsWith('.png') && f !== 'pantry-art.png') fs.unlinkSync(path.join(OUT, f));
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal'], { TZ: 'Asia/Seoul' });
  const received: Array<Record<string, unknown>> = [];
  const pageErrors: string[] = [];
  const font = fs.readFileSync(FONT);
  const browser = await launchBrowser({ officeHours: true });
  try {
    const open = async (opts: BrowserContextOptions, hoursOff: boolean, at?: Date) => {
      const ctx = await browser.newContext(opts);
      await ctx.route('**/__lounge/malgun.ttf', (route) =>
        route.fulfill({ body: font, contentType: 'font/ttf' }),
      );
      await ctx.addInitScript(INIT);
      if (hoursOff) await ctx.addInitScript(HOURS_OFF);
      await warmUpOffice(ctx, daemon);
      const login = await ctx.newPage();
      await login.goto(await daemon.loginUrl());
      await login.waitForURL(BASE);
      await login.close();
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      page.on(
        'console',
        (m) =>
          m.type() === 'error' &&
          !m.text().startsWith('Failed to load resource') &&
          pageErrors.push(`console: ${m.text()}`),
      );
      if (at) await page.clock.setFixedTime(at);
      page.on('websocket', (ws) =>
        ws.on('framereceived', (f) => {
          try {
            received.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
          } catch {
            /* binary */
          }
        }),
      );
      await page.goto(BASE);
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      await page.waitForFunction(
        () =>
          (
            window as unknown as { __pixelAgentsTestHooks?: { getCharacters(): unknown[] } }
          ).__pixelAgentsTestHooks?.getCharacters().length,
        undefined,
        { timeout: 30_000 },
      );
      await page.waitForTimeout(3500);
      return page;
    };

    // ── Idle frames: the day office (desks) against the night office (resting), both viewports ──
    const frames: Record<string, number | null> = {};
    for (const [name, opts] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const day = await open(opts, true);
      await day.mouse.move(opts.viewport!.width - 5, opts.viewport!.height - 5);
      await day.waitForTimeout(1500);
      frames[`${name}-day`] = await steadyIdleFrames(day);
      await day.context().close();
      const night = await open(opts, false, NIGHT);
      await night.mouse.move(opts.viewport!.width - 5, opts.viewport!.height - 5);
      await night.waitForTimeout(1500);
      const probe: string[] = [];
      let prev = (await night.evaluate('window.__frames')) as number;
      for (let i = 0; i < 16; i++) {
        await night.waitForTimeout(500);
        const f = (await night.evaluate('window.__frames')) as number;
        const b = await hook<{ animating: boolean; warm: number }>(night, 'getBusy()');
        probe.push(`${f - prev}${b.animating ? 'A' : ''}${b.warm ? `W${b.warm}` : ''}`);
        prev = f;
      }
      console.log(
        `${name} night, frames per 0.5 s (A animating, W sprites warming): ${probe.join(' ')}`,
      );
      frames[`${name}-night`] = await steadyIdleFrames(night);
      const resting = (
        await Promise.all((await characters(night)).map((c) => tileOf(night, c.id)))
      ).filter((t) => t?.rest === 'rest').length;
      frames[`${name}-resting`] = resting;
      await night.context().close();
    }
    console.log(`idle frames in ${IDLE_MS} ms: ${JSON.stringify(frames)}`);
    for (const name of ['desktop', 'phone']) {
      const [day, night] = [frames[`${name}-day`], frames[`${name}-night`]];
      check(
        day !== null && night !== null && night <= day + 2,
        `${name}: idle frames in ${IDLE_MS} ms, ${night} with ${frames[`${name}-resting`]} resting at 23:00 against ${day} in the day office`,
      );
    }

    // ── The night office on the desktop ──
    const page = await open(DESKTOP, false, NIGHT);
    const shot = (name: string, clip?: { x: number; y: number; width: number; height: number }) =>
      page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip && { clip }) });
    const latest = (type: string) => [...received].reverse().find((m) => m.type === type);
    const layout = () =>
      (
        latest('layoutLoaded') as {
          layout: {
            cols: number;
            areaTiles: Array<string | null>;
            areas: Array<{ label: string }>;
            furniture: Array<{ uid: string; type: string; col: number; row: number }>;
          };
        }
      ).layout;
    const L = layout();
    const loungeLabel = L.areas.map((a) => a.label).find((l) => l.endsWith('휴게실'))!;
    const pantryLabel = L.areas.map((a) => a.label).find((l) => l.endsWith('탕비실'))!;
    check(!!loungeLabel && !!pantryLabel, `the floor has a ${loungeLabel} and a ${pantryLabel}`);
    const machines = ['vending', 'coffee', 'water'].map((k) =>
      L.furniture.find((f) => f.uid === `lounge:${k}`),
    );
    check(
      machines.every(Boolean) &&
        new Set(machines.map((m) => m!.row)).size === 1 &&
        machines.map((m) => m!.type).join() === 'VENDING_MACHINE,COFFEE_MACHINE,WATER_COOLER',
      `the pantry's vending machine, coffee machine and water cooler stand side by side at row ${machines[0]!.row}`,
    );
    const loungeTiles: Array<[number, number]> = [];
    L.areaTiles.forEach((l, i) => {
      if (l === loungeLabel || l === pantryLabel)
        loungeTiles.push([i % L.cols, Math.floor(i / L.cols)]);
    });
    const [c0, c1] = [
      Math.min(...loungeTiles.map((t) => t[0])),
      Math.max(...loungeTiles.map((t) => t[0])),
    ];
    const [r0, r1] = [
      Math.min(...loungeTiles.map((t) => t[1])),
      Math.max(...loungeTiles.map((t) => t[1])),
    ];
    const canvasBox = (await page.getByTestId('office-canvas').boundingBox())!;
    const tileCenter = (col: number, row: number) =>
      hook<{ x: number; y: number }>(page, `getTileCenter(${col}, ${row})`);
    const zoomNow = async () =>
      (await page.evaluate(`(() => {
        const h = window.__pixelAgentsTestHooks;
        return (h.getTileCenter(1, 0).x - h.getTileCenter(0, 0).x) / 16;
      })()`)) as number;
    /** The wheel moves the zoom a notch at a time, about the pointer. */
    const setZoom = async (target: number) => {
      for (let i = 0; i < 8; i++) {
        const z = await zoomNow();
        if (Math.abs(z - target) < 0.01) return;
        await page.mouse.wheel(0, z < target ? -300 : 300);
        await page.waitForTimeout(500);
      }
    };
    /** The lounge on the page now (the camera may have moved): the clip around its tiles, kept on screen. */
    const loungeClip = async () => {
      const scale = await zoomNow();
      const [a, b] = [await tileCenter(c0, r0), await tileCenter(c1, r1)];
      const pad = 40;
      const x0 = Math.max(canvasBox.x, canvasBox.x + a.x - 8 * scale - pad);
      const y0 = Math.max(canvasBox.y, canvasBox.y + a.y - 24 * scale - pad);
      const x1 = Math.min(canvasBox.x + canvasBox.width, canvasBox.x + b.x + 8 * scale + pad);
      const y1 = Math.min(canvasBox.y + canvasBox.height, canvasBox.y + b.y + 12 * scale + pad);
      return x1 > x0 + 20 && y1 > y0 + 20
        ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
        : undefined;
    };
    const all = await characters(page);
    const idle: Array<{ id: number; t: Tile }> = [];
    await until('the idle orchestrators rest', async () => {
      idle.length = 0;
      for (const c of await characters(page)) {
        const t = await tileOf(page, c.id);
        if (t?.rest === 'rest') idle.push({ id: c.id, t });
      }
      return idle.length >= 3;
    });
    check(
      idle.every(
        (x) =>
          !x.t.away && // in the building, drawn
          (x.t.restSeat === null ? true : /^(lounge:|lobby:|\d+\/lounge:)/.test(x.t.restSeat)),
      ),
      `${idle.length} of ${all.length} characters rest at 23:00, in the building (seats ${idle.map((x) => x.t.restSeat ?? 'tile').join(', ')})`,
    );
    check(
      idle.filter((x) => x.t.restSeat).length >= 3,
      'at least three of them sit on the lounge seats (sofas, benches)',
    );
    check(
      (await characters(page)).every((c) => !c.matrixEffect),
      'nobody walked out or in through a door: no spawn or despawn effect',
    );
    const marks = await page.$$eval('[data-testid="agent-card"]', (cards) =>
      cards.map((c) => c.querySelector('[data-testid="duty-mark"]')?.textContent ?? ''),
    );
    const badges = await page.locator('[data-testid="off-duty-badge"]').count();
    check(
      marks.filter((m) => m === '퇴근').length === idle.length && badges === idle.length,
      `presence stays 퇴근: ${marks.filter((m) => m === '퇴근').length} cards and ${badges} badges for ${idle.length} resting`,
    );
    // The camera on the lounge: follow a character resting on a lounge seat.
    idle.sort(
      (p, q) =>
        Number(/^lounge:/.test(q.t.restSeat ?? '')) - Number(/^lounge:/.test(p.t.restSeat ?? '')),
    );
    await page.locator(`[data-testid="agent-card"][data-agent-id="${idle[0].id}"]`).first().click();
    await page.getByTestId('off-duty-sheet').waitFor();
    await page.getByRole('button', { name: 'x', exact: true }).click();
    await page.waitForTimeout(1500);
    await shot('1b-whole-office-night');
    // Nothing selected (its plate would cover the pantry), the lounge under the pointer, zoomed in.
    await page.keyboard.press('Escape');
    const mid = await tileCenter(Math.round((c0 + c1) / 2), Math.round((r0 + r1) / 2));
    await page.mouse.move(canvasBox.x + mid.x, canvasBox.y + mid.y);
    await setZoom(4);
    await page.mouse.move(1270, 790);
    await page.waitForTimeout(1200);
    await shot('1-lounge-and-pantry-resting-zzz', await loungeClip());

    // ── A drink: walks to a machine, the machine plays, the seven steps, back to its seat ──
    const who = idle[0].id;
    const seat0 = idle[0].t;
    const phases: string[] = [];
    const sawShot: Record<string, boolean> = {};
    await hook(page, `restDrinkNow(${who})`);
    await until(
      'a full drink',
      async () => {
        const t = (await tileOf(page, who))!;
        if (t.rest && phases.at(-1) !== t.rest) phases.push(t.rest);
        lastSeen += ` phases ${phases.join('>')}`;
        for (const phase of ['use', 'drink']) {
          if (t.rest === phase && !sawShot[phase]) {
            sawShot[phase] = true;
            await page.waitForTimeout(phase === 'use' ? 1400 : 2700);
            await shot(
              `2-${phase === 'use' ? 'machine-plays' : 'drinking'}-${t.restKind}`,
              await loungeClip(),
            );
          }
        }
        return phases.join().endsWith('fetch,use,drink,go,rest') && t.queued === 0;
      },
      60_000,
    );
    const back = (await tileOf(page, who))!;
    check(
      phases.join().endsWith('fetch,use,drink,go,rest') &&
        back.col === seat0.col &&
        back.row === seat0.row,
      `it walked to a machine, used it, drank and went back to its seat (${phases.join(' > ')})`,
    );

    // ── Dragged (the real mouse) to its own desk, and to another room, while off duty ──
    // zoomed out: the desks are some tiles from the lounge
    await page.mouse.move(640, 400);
    await setZoom(1);
    console.log(`office zoom for the drags: ${await zoomNow()}`);
    const seatsOf = await hook<Array<{ id: number; seatId: string | null }>>(
      page,
      'getAgentSeats()',
    );
    const seatTiles = await hook<Array<{ uid: string; col: number; row: number }>>(
      page,
      'getSeats()',
    );
    /** Press character `id` (its card first: the camera centres it), drag to a tile, let go. The
     *  drop must be on the canvas clear of the panels, so the tile is checked to be on screen. */
    const closeSheet = async () => {
      const sheet = page.getByTestId('off-duty-sheet');
      await sheet.waitFor({ timeout: 3000 }).catch(() => undefined);
      if (await sheet.isVisible()) {
        await page.getByRole('button', { name: 'x', exact: true }).click();
        await sheet.waitFor({ state: 'detached' });
      }
    };
    const dragTo = async (id: number, to: Array<{ col: number; row: number }>) => {
      const scale = await zoomNow();
      await page.locator(`[data-testid="agent-card"][data-agent-id="${id}"]`).first().click();
      await closeSheet(); // a card of one off duty opens its sheet too
      await page.waitForTimeout(1500);
      const t = (await tileOf(page, id))!;
      const from = await tileCenter(t.col, t.row);
      const [fx, fy] = [canvasBox.x + from.x, canvasBox.y + from.y - 12 * scale];
      await page.mouse.move(fx, fy);
      await page.mouse.down();
      await page.mouse.move(fx + 30, fy + 10, { steps: 6 });
      // carry it to the first candidate tile whose point is the bare canvas (no panel, no board over it)
      let drop: { col: number; row: number; x: number; y: number } | null = null;
      for (const c of to) {
        const p = await tileCenter(c.col, c.row);
        const [x, y] = [canvasBox.x + p.x, canvasBox.y + p.y - 4 * scale];
        await page.mouse.move(x, y, { steps: 12 });
        const hit = await page.evaluate(
          `document.elementFromPoint(${x}, ${y})?.dataset.testid ?? ''`,
        );
        if (hit === 'office-canvas') {
          drop = { ...c, x, y };
          break;
        }
      }
      await page.mouse.up();
      if (!drop) throw new Error(`no candidate tile of ${to.length} is on the bare canvas`);
      return { from: t, drop };
    };
    const near = (a: { col: number; row: number }, b: { col: number; row: number }) =>
      Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
    // the resting one whose desk is nearest (so the drop is on screen with the camera on the character)
    const rest2 = idle.slice(1);
    const deskOf = (id: number) =>
      seatTiles.find((s) => s.uid === seatsOf.find((x) => x.id === id)!.seatId)!;
    rest2.sort((p, q) => near(p.t, deskOf(p.id)) - near(q.t, deskOf(q.id)));
    const mover = rest2[0].id;
    const desk = deskOf(mover);
    const { from: from1 } = await dragTo(mover, [desk]);
    await until('it reached its desk', async () => {
      const t = (await tileOf(page, mover))!;
      return t.col === desk.col && t.row === desk.row && t.queued === 0 && t.rest === 'rest';
    });
    const sat = (await tileOf(page, mover))!;
    check(
      sat.restSeat === desk.uid && sat.state === 'type' && near(from1, desk) > 0,
      `dragged from ${from1.col},${from1.row} onto its own desk (${desk.uid} at ${desk.col},${desk.row}) it sits there, still resting (off duty)`,
    );
    await page.mouse.move(1270, 790);
    await shot('3-dragged-to-its-desk-off-duty');

    const other = rest2[1].id;
    const here = (await tileOf(page, other))!;
    const roomOf = (c: number, r: number) => L.areaTiles[r * L.cols + c];
    const taken = new Set(L.furniture.map((f) => `${f.col},${f.row}`));
    const spots = L.areaTiles
      .map((l, i) => ({ l, col: i % L.cols, row: Math.floor(i / L.cols) }))
      .filter(
        (x) =>
          x.l &&
          x.l !== loungeLabel &&
          x.l !== pantryLabel &&
          !x.l.endsWith('로비') &&
          [0, 1, 2].every((k) => !taken.has(`${x.col},${x.row - k}`)) &&
          !taken.has(`${x.col - 1},${x.row}`) &&
          !taken.has(`${x.col + 1},${x.row}`),
      )
      .sort((p, q) => near(p, here) - near(q, here));
    const { drop: spot } = await dragTo(other, spots.slice(0, 80));
    await until('it stands in the other room', async () => {
      const t = (await tileOf(page, other))!;
      return t.queued === 0 && t.rest === 'rest' && t.restSeat === null && t.state === 'idle';
    });
    const there = (await tileOf(page, other))!;
    check(
      roomOf(there.col, there.row) === roomOf(spot.col, spot.row) &&
        roomOf(there.col, there.row) !== loungeLabel,
      `dragged to another room (${roomOf(spot.col, spot.row)}) it stands at ${there.col},${there.row} and dozes there`,
    );
    await page.mouse.move(1270, 790);
    await shot('3b-dragged-to-another-room');

    // ── The objects in the layout editor ──
    await page.mouse.move(1270, 790);
    await closeSheet();
    await page.getByRole('button', { name: '인테리어', exact: true }).click();
    await page.getByRole('button', { name: 'Furniture', exact: true }).click();
    await page.getByRole('button', { name: 'Misc', exact: true }).click();
    await page.waitForTimeout(800);
    const coffee = await tileCenter(machines[1]!.col, machines[1]!.row);
    await page.mouse.click(canvasBox.x + coffee.x, canvasBox.y + coffee.y);
    await page.waitForTimeout(500);
    await closeSheet(); // the click can reach the selected resting character's sheet
    await shot('4-layout-editor-pantry-objects');
    const titles = await page.$$eval('[title]', (els) =>
      els.map((e) => e.getAttribute('title') ?? ''),
    );
    check(
      ['Vending Machine', 'Coffee Machine', 'Water Cooler'].every((n) =>
        titles.some((t) => t.includes(n)),
      ),
      `the editor's Misc palette lists the vending machine, the coffee machine and the water cooler (${titles.filter((t) => /Machine|Cooler/.test(t)).join(', ')})`,
    );
    await page.getByRole('button', { name: '인테리어', exact: true }).click();

    // ── Opening time: from where they rest to their desks, no door, no spawn effect ──
    const resting = (
      await Promise.all(
        (await characters(page)).map(async (c) => ({ id: c.id, t: (await tileOf(page, c.id))! })),
      )
    ).filter((x) => x.t.rest);
    await page.clock.setFixedTime(MORNING);
    await until('they set off for their desks', async () => {
      const ts = await Promise.all(resting.map((x) => tileOf(page, x.id)));
      return ts.every((t) => t && !t.rest) && ts.some((t) => t!.queued > 0);
    });
    const effects = (await characters(page)).filter((c) => c.matrixEffect).length;
    await page.mouse.move(1270, 790);
    await shot('5-back-on-duty-walking-to-desks');
    check(
      effects === 0,
      `at 10:00 ${resting.length} characters set off from where they rest, to their desks: no spawn effect, no door`,
    );
    await until(
      'everyone is at a desk',
      async () => {
        const ts = await Promise.all(resting.map((x) => tileOf(page, x.id)));
        return ts.every((t) => t && t.queued === 0 && t.state !== 'walk');
      },
      40_000,
    );
    await shot('6-at-their-desks');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    if (daemon.child.exitCode === null) {
      const exited = new Promise((r) => daemon.child.once('exit', r));
      daemon.child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    }
  }
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
