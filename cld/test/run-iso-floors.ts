/**
 * ISO-FLOORS proof: the isometric building with taller, closer storeys, a clearly focused floor
 * and the lobby's LED board on its wall. dist/cli.js with an isolated HOME (the run-phone-zoom
 * building: three floors) on a spare port, headless Chromium without a GPU. Shots: desktop whole
 * building (2F focus), desktop focused floor, phone 390x844, the lobby (1F) with its board in
 * the building view and the floor view, and the lobby zoomed in. Checked: the board shows only while
 * the lobby is the floor in focus; the floors nest, so a click where 2F's slab is drawn across the
 * lobby's back wall goes to the floor drawn on top there: 2F with the lobby in focus (2F faint
 * over it), 2F again (kept) with 2F in focus; a click on the lobby's own floor keeps the lobby.
 * Screenshots: cld/artifacts/iso-floors/.
 *
 *   npx tsx cld/test/run-iso-floors.ts <port 18260-18269> [shot prefix]
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
if (!(port >= 18260 && port <= 18269)) throw new Error('port must be 18260-18269');
const PREFIX = process.argv[3] ?? 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/iso-floors');
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
const ISO = { 'cld.title-scene': 'off', 'cld.office-iso': 'on' };
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;

function check(ok: unknown, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) process.exitCode = 1;
}

function makeHome() {
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  fs.writeFileSync(
    path.join(configDirectory(fake.home), 'building.json'),
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
  return fake;
}

async function open(
  browser: Browser,
  daemon: ReturnType<typeof startDaemon>,
  opts: BrowserContextOptions,
  floor: string,
) {
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
    Object.entries({ ...ISO, 'cld.floor': floor }),
  );
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  await page.goto(await daemon.loginUrl());
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  return { ctx, page };
}

type Pt = { x: number; y: number };
type IsoFloor = { id: string; row: number; rows: number };
const hook = <T>(page: Page, fn: string): Promise<T> =>
  page.evaluate(`(() => { const h = window.__agentTycoonTestHooks; return ${fn}; })()`) as Promise<T>;
const focusOf = (page: Page) => hook<string>(page, 'h.getIso().focus');

/** Click at a CSS point of the office canvas. */
async function clickAt(page: Page, p: Pt) {
  const box = (await page.getByTestId('office-canvas').boundingBox())!;
  await page.mouse.click(box.x + p.x, box.y + p.y);
  await page.waitForTimeout(1200);
}

/** The lobby's back wall where 2F's slab is drawn across it, and a tile of the lobby's floor. */
async function overlapPoints(page: Page) {
  const [f1, f2] = await hook<IsoFloor[]>(page, 'h.getIso().floors');
  const col = 6;
  const at = (x: number, y: number) => hook<Pt | null>(page, `h.isoPoint(${x}, ${y})`);
  // The lobby's floor at its back edge, and 2F's front edge straight above it on screen.
  const base = await at(col * 16 + 8, (f1.row + 0.05) * 16);
  const edge = await at((col + f2.rows) * 16 + 8, (f2.row + f2.rows - 0.05) * 16);
  const lobby = await at(col * 16 + 8, (f1.row + f1.rows - 3) * 16 + 8);
  if (!base || !edge || !lobby || !(base.y > edge.y)) return null;
  return { wall: { x: base.x, y: edge.y - (base.y - edge.y) }, lobby };
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const daemon = startDaemon(makeHome(), port, ['--no-terminal']);
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) });
  try {
    const d2 = await open(browser, daemon, DESK, '2');
    await shot(d2.page, 'desktop-building-2F');
    check(
      (await d2.page.locator('[data-testid="lobby-board"]').count()) === 0,
      'no board over the building while 2F is in focus',
    );
    const under = await overlapPoints(d2.page);
    check(under, `points on the lobby wall and floor (${JSON.stringify(under)})`);
    await clickAt(d2.page, under!.wall);
    check((await focusOf(d2.page)) === '2', "a click on 2F's slab over the lobby wall keeps 2F");
    await d2.page.getByTestId('iso-view-toggle').click();
    await d2.page.waitForTimeout(1500);
    await shot(d2.page, 'desktop-floor-2F');
    await d2.ctx.close();

    const d1 = await open(browser, daemon, DESK, '1');
    await shot(d1.page, 'desktop-building-1F');
    const inBuilding = await d1.page.locator('[data-testid="lobby-board"]').count();
    console.log(`board in the building view: ${inBuilding}`);
    if (PREFIX !== 'before') {
      check(inBuilding === 1, 'the lobby in focus shows its board in the building view');
      const pts = await overlapPoints(d1.page);
      await clickAt(d1.page, pts!.lobby);
      check((await focusOf(d1.page)) === '1', "a click on the lobby's floor keeps the lobby");
      await clickAt(d1.page, pts!.wall);
      check((await focusOf(d1.page)) === '2', "a click on 2F drawn over the lobby's wall focuses 2F");
      check(
        (await d1.page.locator('[data-testid="lobby-board"]').count()) === 0,
        'the board goes when another floor takes the focus',
      );
      await d1.page.locator('.cld-elevator [data-floor-id="1"]').click();
      await d1.page.waitForTimeout(1800);
    }
    await d1.page.getByTestId('iso-view-toggle').click();
    await d1.page.waitForTimeout(1500);
    await shot(d1.page, 'desktop-lobby-floor');
    if (PREFIX !== 'before')
      check(
        (await d1.page.locator('[data-testid="lobby-board"]').count()) === 1,
        'the lobby wall shows the board in the isometric floor view',
      );
    if (PREFIX !== 'before') {
      const board = d1.page.locator('[data-testid="lobby-board"]');
      const b = (await d1.page.locator('[data-testid="lobby-board"]').boundingBox())!;
      await d1.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      for (let i = 0; i < 3; i++) await d1.page.mouse.wheel(0, -240);
      await d1.page.waitForTimeout(1500);
      await shot(d1.page, 'desktop-lobby-zoomed');
      const z = await board.boundingBox();
      check(z && z.width > b.width, `the board grows with the zoom (${b.width} -> ${z?.width})`);
    }
    await d1.ctx.close();

    const ph = await open(browser, daemon, PHONE, '2');
    await shot(ph.page, 'phone-2F');
    await ph.ctx.close();
    const pl = await open(browser, daemon, PHONE, '1');
    await shot(pl.page, 'phone-lobby');
    if (PREFIX !== 'before')
      check(
        (await pl.page.locator('[data-testid="lobby-board"]').count()) === 1,
        'phone: the lobby shows its board',
      );
    await pl.ctx.close();
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
