/**
 * building-a-1104 (owner 11-04 17:51, 19:47): the isometric building as one building, and the
 * lobby board outside as a billboard. dist/cli.js in an isolated HOME (the run-iso-floors
 * building: three floors) on a spare port, headless Chromium without a GPU, the owner's window
 * 1282x832.
 *  - The whole building with each floor in focus (1F, 2F, 3F): the floors below closed, the ones
 *    above an outline. A click on a closed storey focuses it; one on an outline above the focus
 *    focuses that floor.
 *  - The billboard, in the building view and the lobby's floor view: in the view, clear of the
 *    floor panel, its type (list 13, numbers 40 CSS px in the lobby view), taps just outside its
 *    edges open nothing. Its pages turn by themselves (summary, projects, H/W, GPU): a picture of
 *    each, and a tap on each opens what it continues (the 현황판 with no HW tab, the full board on
 *    its projects, H/W and GPU screens); the HUD heat gauge opens the full board's H/W.
 *  - Night (the outline and facade in the night palette), and a phone 390x844.
 * Screenshots: cld/artifacts/building-a-1104/.
 *
 *   npx tsx cld/test/run-building-a.ts <port 18540-18549> [--board-only]
 * --board-only: the billboard checks only (the negative control's quick run).
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18540 && port <= 18549)) throw new Error('port must be 18540-18549');
const BOARD_ONLY = process.argv.includes('--board-only');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/building-a-1104');
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
    Object.entries({ 'cld.title-scene': 'off', 'cld.office-iso': 'on', 'cld.floor': floor }),
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

/** The billboard: in the view, not under the floor panel, its type size (from its face's
 *  scale: the face is ISO_BILLBOARD.h iso px tall), taps just outside open nothing. */
async function billboardChecks(page: Page, where: string, readable: boolean) {
  const bb = page.locator('[data-testid="lobby-billboard"]');
  check((await bb.count()) === 1, `${where}: the billboard shows`);
  if (!(await bb.count())) return;
  const b = (await bb.boundingBox())!;
  const view = DESK.viewport!;
  check(b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width && b.y + b.height <= view.height, `${where}: inside the window (${JSON.stringify(b)})`);
  const panel = await page.locator('.cld-elevator').first().boundingBox();
  const apart = (p: Box | null) => !p || b.x >= p.x + p.width || b.x + b.width <= p.x || b.y >= p.y + p.height || b.y + b.height <= p.y;
  check(apart(panel), `${where}: clear of the floor panel`);
  // ISO_BILLBOARD.h = 56, the list type 6.5 and the big number 20 iso px (billboardFace.ts).
  const k = b.height / 56;
  console.log(`${where}: billboard ${Math.round(b.width)}x${Math.round(b.height)}, list type ${(6.5 * k).toFixed(1)} px, numbers ${(20 * k).toFixed(1)} px`);
  if (readable) {
    check(6.5 * k >= 12, `${where}: list labels at least 12 px`);
    check(Math.abs(20 * k - 40) <= 2, `${where}: big numbers about 40 px`);
  }
  const out = [
    { x: b.x + b.width / 2, y: b.y - 3 },
    { x: b.x - 3, y: b.y + b.height / 2 },
    { x: b.x + b.width + 3, y: b.y + b.height / 2 },
  ];
  for (const p of out) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(600);
    const opened = (await boardOpen(page)) || (await officeOpen(page));
    check(!opened, `${where}: a tap just outside (${Math.round(p.x)},${Math.round(p.y)}) opens nothing`);
    if (opened) await closeAll(page);
  }
}

const officeOpen = async (page: Page) => (await page.locator('[data-hud-window="office"]').count()) > 0;
async function closeAll(page: Page) {
  if (await boardOpen(page)) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }
  if (await officeOpen(page)) {
    await page.locator('[data-testid="hud-title-office"] button').last().click();
    await page.waitForTimeout(600);
  }
}
/** The 현황판's tab strip as shown. */
const officeTabs = (page: Page) =>
  page.locator('[data-hud-window="office"] nav button').allInnerTexts();

/** Each page in turn: it comes by itself, a picture of it, a tap opens what it continues. */
async function billboardPages(page: Page) {
  const bb = page.locator('[data-testid="lobby-billboard"]');
  const order = ['summary', 'projects', 'hw', 'gpu'];
  const pageNow = () => bb.getAttribute('data-page');
  const seen: string[] = [];
  for (const want of [...order.slice(order.indexOf((await pageNow()) ?? 'summary')), ...order].slice(0, 4)) {
    const end = Date.now() + 12_000;
    while ((await pageNow()) !== want && Date.now() < end) await page.waitForTimeout(250);
    const at = await pageNow();
    seen.push(at ?? '?');
    check(at === want, `the billboard turns to ${want}`);
    if (at !== want) continue;
    const b = (await bb.boundingBox())!;
    await page.screenshot({ path: path.join(OUT, `billboard-${want}.png`), clip: { x: b.x - 10, y: b.y - 10, width: b.width + 20, height: b.height + 40 } });
    await page.mouse.click(b.x + b.width * 0.3, b.y + b.height * 0.5);
    await page.waitForTimeout(1000);
    if (want === 'summary') {
      const tabs = await officeTabs(page);
      const pressed = await page.locator('[data-hud-window="office"] nav button[aria-pressed="true"]').allInnerTexts();
      check((await officeOpen(page)) && pressed.length === 1, `summary: a tap opens the 현황판 (${JSON.stringify(pressed)})`);
      check(!tabs.includes('HW'), `the 현황판 has no HW tab (${JSON.stringify(tabs)})`);
      await page.screenshot({ path: path.join(OUT, `billboard-${want}-open.png`) });
    } else {
      const sel = await page.locator(`[data-testid="board-full"] [data-testid="board-tab-${want}"][aria-selected="true"]`).count();
      check(sel === 1, `${want}: a tap opens the full board on its ${want} screen`);
      await page.screenshot({ path: path.join(OUT, `billboard-${want}-open.png`) });
    }
    await closeAll(page);
  }
  console.log(`pages seen: ${seen.join(' -> ')}`);
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
      const bb = (await l.page.locator('[data-testid="lobby-billboard"]').boundingBox())!;
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
