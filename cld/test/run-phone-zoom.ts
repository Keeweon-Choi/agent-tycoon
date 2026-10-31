/**
 * PHONE-ZOOM proof: the office's first view on a phone (390x844, dpr 3) frames the current
 * floor, not the whole isometric building; desktop is unchanged. dist/cli.js with an isolated
 * HOME (the fake claude scenario R-8, the run-iso building: three floors, two rooms on 2F) on a
 * spare port, headless Chromium without a GPU. Shots: the isometric phone office, the classic
 * 2D phone office, the desktop isometric office; then a one-finger pan and a pinch on the phone
 * (the user's zoom is kept, also across a viewport resize and a reload), and a viewport resize
 * without any gesture (an iOS toolbar collapsing). Prints each camera.
 *
 *   npx tsx cld/test/run-phone-zoom.ts <port 18256-18259> [shot prefix]
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
  sparePort,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const PREFIX = process.argv[3] ?? 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/phone-zoom');
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
const BASE = { 'cld.title-scene': 'off', 'cld.floor': '2' };
const ISO = { ...BASE, 'cld.office-iso': 'on' };
const FLAT = { ...BASE, 'cld.office-iso': 'off' };
type Pt = { x: number; y: number; id?: number };
type Cam = { zoom: number; pan: { x: number; y: number } };

const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const camera = (page: Page): Promise<Cam> =>
  page.evaluate(
    `(() => { const c = window.__agentTycoonTestHooks.getCamera(); return { zoom: c.zoom, pan: c.pan }; })()`,
  ) as Promise<Cam>;
const show = (c: Cam) => `zoom ${c.zoom} pan ${Math.round(c.pan.x)},${Math.round(c.pan.y)}`;
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
  store: Record<string, string>,
) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(INIT);
  await ctx.addInitScript((pairs) => {
    for (const [k, v] of pairs)
      try {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      } catch {
        // about:blank
      }
  }, Object.entries(store));
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  await page.goto(await daemon.loginUrl());
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  return { ctx, page };
}

/** Touches through CDP (Playwright only taps). Each step moves every finger. */
async function touches(page: Page, steps: Pt[][]) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: steps[0] });
  for (const s of steps.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: s });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const line = (a: Pt, b: Pt, n: number): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / n,
    y: a.y + ((b.y - a.y) * i) / n,
  }));

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const daemon = startDaemon(makeHome(), port, ['--no-terminal']);
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) });
  try {
    const desk = await open(browser, daemon, DESK, ISO);
    console.log(`desktop iso: ${show(await camera(desk.page))}`);
    await shot(desk.page, 'desktop-iso');
    // A wheel zoom, then the building/floor toggle: does the toggle still frame the view?
    await desk.page.mouse.move(640, 400);
    for (let i = 0; i < 3; i++) {
      await desk.page.mouse.wheel(0, -120);
      await desk.page.waitForTimeout(200);
    }
    const wheeled = await camera(desk.page);
    await desk.page.getByText('건물 전체').click();
    await desk.page.waitForTimeout(1500);
    const toggled = await camera(desk.page);
    console.log(`desktop iso: wheel ${show(wheeled)} -> view toggle ${show(toggled)}`);
    await shot(desk.page, 'desktop-iso-toggled');
    await desk.ctx.close();

    const flat = await open(browser, daemon, PHONE, FLAT);
    console.log(`phone 2D: ${show(await camera(flat.page))}`);
    await shot(flat.page, 'phone-2d');
    await flat.ctx.close();

    const iso = await open(browser, daemon, PHONE, ISO);
    const first = await camera(iso.page);
    console.log(`phone iso: ${show(first)}`);
    await shot(iso.page, 'phone-iso');
    if (PREFIX === 'before') return;

    // A toolbar collapse with no gesture yet: the view grows a little.
    await iso.page.setViewportSize({ width: 390, height: 900 });
    await iso.page.waitForTimeout(1500);
    const grown = await camera(iso.page);
    console.log(`phone iso, view 390x900 untouched: ${show(grown)}`);
    await shot(iso.page, 'phone-iso-resized');
    check(grown.zoom >= first.zoom, 'a resize before any gesture keeps the floor framing');
    await iso.page.setViewportSize({ width: 390, height: 844 });
    await iso.page.waitForTimeout(1500);

    const box = (await iso.page.getByTestId('office-canvas').boundingBox())!;
    const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const before = await camera(iso.page);
    await touches(
      iso.page,
      line(mid, { x: mid.x + 80, y: mid.y + 60 }, 12).map((p) => [{ ...p, id: 1 }]),
    );
    await iso.page.waitForTimeout(500);
    const panned = await camera(iso.page);
    console.log(`after a one-finger pan: ${show(panned)}`);
    check(panned.pan.x !== before.pan.x || panned.pan.y !== before.pan.y, 'one finger pans');

    const a = line({ x: mid.x - 30, y: mid.y }, { x: mid.x - 120, y: mid.y }, 14);
    const b = line({ x: mid.x + 30, y: mid.y }, { x: mid.x + 120, y: mid.y }, 14);
    await touches(
      iso.page,
      a.map((p, i) => [
        { ...p, id: 1 },
        { ...b[i], id: 2 },
      ]),
    );
    await iso.page.waitForTimeout(500);
    const pinched = await camera(iso.page);
    console.log(`after a pinch out: ${show(pinched)}`);
    check(pinched.zoom > panned.zoom, 'a pinch zooms in');
    await iso.page.waitForTimeout(3000);
    const later = await camera(iso.page);
    check(later.zoom === pinched.zoom, `the pinched zoom stays (${later.zoom})`);
    await shot(iso.page, 'phone-iso-pinched');

    await iso.page.setViewportSize({ width: 390, height: 900 });
    await iso.page.waitForTimeout(1500);
    const resized = await camera(iso.page);
    check(
      resized.zoom === pinched.zoom,
      `a resize after a pinch keeps the user's zoom (${resized.zoom})`,
    );
    await iso.page.setViewportSize({ width: 390, height: 844 });
    await iso.page.waitForTimeout(1500);

    const beforeReload = await camera(iso.page);
    await iso.page.reload();
    await iso.page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
    await iso.page.waitForTimeout(3000);
    const reloaded = await camera(iso.page);
    console.log(`after a reload: ${show(reloaded)}`);
    check(reloaded.zoom === pinched.zoom, `a reload keeps the user's zoom (${reloaded.zoom})`);
    check(
      reloaded.pan.x === beforeReload.pan.x && reloaded.pan.y === beforeReload.pan.y,
      `a reload keeps the user's pan (${show(beforeReload)})`,
    );
    await shot(iso.page, 'phone-iso-reloaded');
    await iso.ctx.close();
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
