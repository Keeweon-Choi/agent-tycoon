/**
 * building-a-1104 (owner 11-04 17:51, 19:47): the isometric building as one building, and the
 * lobby board outside as a billboard. dist/cli.js in an isolated HOME (the run-iso-floors
 * building: three floors) on a spare port, headless Chromium without a GPU, the owner's window
 * 1282x832.
 *  - The whole building with each floor in focus (1F, 2F, 3F): the floors below closed, the ones
 *    above an outline. A click on a closed storey focuses it; one on an outline above the focus
 *    focuses that floor.
 *  - The billboard (billboard2-1104: the old lobby board's own screen on a 3D case): in the
 *    building view and the lobby's floor view, in the view, clear of the floor panel, its tab
 *    head and 나를 기다림, at least the old board's readable em (10 px) in the lobby view where
 *    its pages turn; taps just outside open nothing, a tap on it opens the full board. A page
 *    turns by itself; each tab's page pictured, and a tap on it opens the full board on it; the
 *    HUD heat gauge opens the full board's H/W.
 *  - Night (the outline and facade in the night palette), and a phone 390x844.
 * Screenshots: agent-tycoon/artifacts/billboard2-1104/ (OUT_DIR to change).
 *
 *   npx tsx agent-tycoon/test/run-building-a.ts <port 18540-18549> [--board-only]
 * --board-only: the billboard checks only (the negative control's quick run).
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  startDaemon,
  warmUpOffice,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18540 && port <= 18549)) throw new Error('port must be 18540-18549');
const BOARD_ONLY = process.argv.includes('--board-only');
const OUT = path.join(REPO_ROOT, process.env.OUT_DIR ?? 'agent-tycoon/artifacts/billboard2-1104');
const DESK: BrowserContextOptions = { viewport: { width: 1282, height: 832 }, deviceScaleFactor: 1 };
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;

let failed = 0;
function check(ok: unknown, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) failed++;
}

function makeHome(time: 'day' | 'night') {
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const dir = configDirectory(fake.home);
  fs.writeFileSync(
    path.join(dir, 'building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: [
        { id: '1', name: '1F', rooms: [], characters: [] },
        { id: '2', name: '2F', rooms: ['orch-alpha', 'orch-beta'], characters: [] },
        { id: '3', name: '3F', rooms: ['orch-gamma'], characters: [] },
      ],
    }),
  );
  fs.writeFileSync(path.join(dir, 'background.json'), JSON.stringify({ time, mix: 'mixed', seed: 1101 }));
  return fake;
}

type Daemon = ReturnType<typeof startDaemon>;
type Pt = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

async function open(browser: Browser, daemon: Daemon, opts: BrowserContextOptions, floor: string) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(INIT);
  await ctx.addInitScript(
    (pairs) => {
      for (const [k, v] of pairs)
        try {
          if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
        } catch {
          // about:blank
        }
    },
    Object.entries({ 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': floor }),
  );
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  await page.goto(await daemon.loginUrl());
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  return { ctx, page };
}

const hook = <T>(page: Page, fn: string): Promise<T> =>
  page.evaluate(`(() => { const h = window.__agentTycoonTestHooks; return ${fn}; })()`) as Promise<T>;
const focusOf = (page: Page) => hook<string>(page, 'h.getIso().focus');
type IsoFloor = { id: string; row: number; rows: number; level: number };

async function canvasBox(page: Page): Promise<Box> {
  return (await page.getByTestId('office-canvas').boundingBox())!;
}
async function clickCanvas(page: Page, p: Pt) {
  const c = await canvasBox(page);
  await page.mouse.click(c.x + p.x, c.y + p.y);
  await page.waitForTimeout(1200);
}
const boardOpen = async (page: Page) => (await page.locator('[data-testid="board-full"]').count()) > 0;

/** The billboard: the old board's own screen on it (its tab head, 나를 기다림 in the head), in
 *  the view, clear of the floor panel, at least the old board's readable em in the lobby view
 *  (where its pages turn), taps just outside open nothing, a tap on it opens the full board. */
async function billboardChecks(page: Page, where: string, readable: boolean) {
  const bb = page.locator('[data-testid="lobby-board"]');
  check((await bb.count()) === 1, `${where}: the billboard shows the old board's screen`);
  if (!(await bb.count())) return;
  const b = (await bb.boundingBox())!;
  const view = DESK.viewport!;
  check(b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width && b.y + b.height <= view.height, `${where}: inside the window (${JSON.stringify(b)})`);
  const panel = await page.locator('.agty-elevator').first().boundingBox();
  const apart = (p: Box | null) => !p || b.x >= p.x + p.width || b.x + b.width <= p.x || b.y >= p.y + p.height || b.y + b.height <= p.y;
  check(apart(panel), `${where}: clear of the floor panel`);
  const tabs = await bb.locator('[data-testid^="board-tab-"]').count();
  check(tabs === 3 && (await bb.locator('.led-wait').count()) === 1, `${where}: its tab head (3 tabs) and 나를 기다림 in the head`);
  const em = await bb.evaluate((el) => parseFloat((el as HTMLElement).style.fontSize));
  const live = await bb.getAttribute('data-live');
  console.log(`${where}: board ${Math.round(b.width)}x${Math.round(b.height)}, em ${em.toFixed(1)} px, live ${live}`);
  if (readable) {
    check(em >= 10, `${where}: em at least 10 px (the old board's readable size, BOARD_MIN_EM_PX)`);
    check(live === 'true', `${where}: its pages turn (live)`);
  }
  const out = [
    { x: b.x + b.width / 2, y: b.y - 6 },
    { x: b.x - 6, y: b.y + b.height / 2 },
    { x: b.x + b.width + 12, y: b.y + b.height * 0.8 },
  ];
  for (const p of out) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(600);
    const opened = await boardOpen(page);
    check(!opened, `${where}: a tap just outside (${Math.round(p.x)},${Math.round(p.y)}) opens nothing`);
    if (opened) await closeAll(page);
  }
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.7);
  await page.waitForTimeout(1000);
  check(await boardOpen(page), `${where}: a tap on the board opens the full board`);
  await closeAll(page);
}

async function closeAll(page: Page) {
  if (await boardOpen(page)) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }
}

/** Its pages: one turns by itself (BOARD_PAGE_MS), then each by its tab: a picture of each, and
 *  a tap on the board opens the full board on that page. */
async function billboardPages(page: Page) {
  const bb = page.locator('[data-testid="lobby-board"]');
  const shown = async () =>
    (await bb.locator('[data-testid^="board-tab-"][aria-selected="true"]').getAttribute('data-testid'))?.replace('board-tab-', '');
  const first = await shown();
  const end = Date.now() + 26_000;
  while ((await shown()) === first && Date.now() < end) await page.waitForTimeout(500);
  const next = await shown();
  check(next !== first, `the billboard's page turns by itself (${first} -> ${next})`);
  for (const want of ['projects', 'hw', 'gpu']) {
    await bb.locator(`[data-testid="board-tab-${want}"]`).click();
    await page.waitForTimeout(800);
    check((await shown()) === want, `the ${want} tab shows its page`);
    const b = (await bb.boundingBox())!;
    await page.screenshot({ path: path.join(OUT, `billboard-${want}.png`), clip: { x: b.x - 24, y: b.y - 24, width: b.width + 60, height: b.height + 60 } });
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.7);
    await page.waitForTimeout(1000);
    const sel = await page.locator(`[data-testid="board-full"] [data-testid="board-tab-${want}"][aria-selected="true"]`).count();
    check(sel === 1, `${want}: a tap opens the full board on its ${want} screen`);
    await page.screenshot({ path: path.join(OUT, `billboard-${want}-open.png`) });
    await closeAll(page);
  }
  // The CPU heat gauge (it went to the HW tab) opens the full board's H/W screen.
  const heat = page.locator('[data-testid="hud-heat"]');
  if (await heat.count()) {
    await heat.first().click();
    await page.waitForTimeout(1000);
    const sel = await page.locator('[data-testid="board-full"] [data-testid="board-tab-hw"][aria-selected="true"]').count();
    check(sel === 1, 'the HUD heat gauge opens the full board H/W screen');
    await closeAll(page);
  } else console.log('no heat gauge in this sample (no CPU temperature): skipped');
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  let daemon = startDaemon(makeHome('day'), port, ['--no-terminal']);
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    if (!BOARD_ONLY) {
      for (const floor of ['1', '2', '3']) {
        const d = await open(browser, daemon, DESK, floor);
        await shot(d.page, `building-${floor}F`);
        check((await focusOf(d.page)) === floor, `building view, ${floor}F in focus`);
        if (floor === '1') await billboardChecks(d.page, 'building-1F', false);
        if (floor === '2') {
          // A click on 1F's closed facade (under 2F's front edge) focuses 1F.
          const [f1] = await hook<IsoFloor[]>(d.page, 'h.getIso().floors');
          const edge = await hook<Pt | null>(d.page, `h.isoPoint(${10 * 16 + 8}, ${(f1.row + f1.rows - 0.02) * 16})`);
          const cam = await hook<{ zoom: number }>(d.page, 'h.getCamera()');
          check(edge, 'a point on 1F front edge');
          await clickCanvas(d.page, { x: edge!.x, y: edge!.y - 30 * cam.zoom });
          check((await focusOf(d.page)) === '1', 'a click on the closed 1F storey focuses 1F');
          // Now 2F and 3F are outlines: a point above 1F's walls inside 3F's storey focuses 3F.
          const floors = await hook<IsoFloor[]>(d.page, 'h.getIso().floors');
          const back3 = await hook<Pt | null>(d.page, `h.isoPoint(8, ${(floors[2].row + 0.02) * 16})`);
          check(back3, 'a point on 3F back corner');
          await clickCanvas(d.page, { x: back3!.x, y: back3!.y - 30 * cam.zoom });
          check((await focusOf(d.page)) === '3', "a click inside 3F's outline above the focus focuses 3F");
          await shot(d.page, 'building-click-3F');
        }
        await d.ctx.close();
      }
    }
    // The lobby's own view (1F, this floor): the billboard reads at its default zoom.
    const l = await open(browser, daemon, DESK, '1');
    await l.page.getByTestId('iso-view-toggle').click();
    await l.page.waitForTimeout(1800);
    await shot(l.page, 'lobby');
    console.log('lobby camera', JSON.stringify(await hook(l.page, 'h.getCamera()')));
    await billboardChecks(l.page, 'lobby', true);
    await billboardPages(l.page);
    if (!BOARD_ONLY) {
      const bb = (await l.page.locator('[data-testid="lobby-board"]').boundingBox())!;
      const clip = { x: Math.max(0, bb.x - 60), y: Math.max(0, bb.y - 60), width: bb.width + 120, height: bb.height + 100 };
      await l.page.screenshot({ path: path.join(OUT, 'lobby-billboard-crop.png'), clip });
    }
    await l.ctx.close();
    if (!BOARD_ONLY) {
      const f2 = await open(browser, daemon, DESK, '2');
      await f2.page.getByTestId('iso-view-toggle').click();
      await f2.page.waitForTimeout(1800);
      await shot(f2.page, 'floor-2F');
      await f2.ctx.close();
      const ph = await open(browser, daemon, PHONE, '1');
      await shot(ph.page, 'phone-1F');
      await ph.ctx.close();
      const ph2 = await open(browser, daemon, PHONE, '2');
      await shot(ph2.page, 'phone-2F');
      await ph2.ctx.close();
      // Night: the same building in the night palette.
      await daemon.stop();
      daemon = startDaemon(makeHome('night'), port, ['--no-terminal']);
      for (const floor of ['1', '2']) {
        const n = await open(browser, daemon, DESK, floor);
        await shot(n.page, `night-building-${floor}F`);
        await n.ctx.close();
      }
      const nl = await open(browser, daemon, DESK, '1');
      await nl.page.getByTestId('iso-view-toggle').click();
      await nl.page.waitForTimeout(1800);
      await shot(nl.page, 'night-lobby');
      await nl.ctx.close();
    }
  } finally {
    await browser.close();
    await daemon.stop();
  }
  console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
