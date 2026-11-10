/**
 * BACKGROUND proof: the isometric office's procedural surroundings (ground tiles on the building's
 * grid, a ring of houses and towers from a seed, sky and skyline), day and night, the three
 * surroundings. dist/cli.js with an isolated HOME (the run-phone-zoom building: three floors) on a
 * spare port, headless Chromium without a GPU. Desktop 1280x800 and phone 390x844 (dpr 3): the
 * setting is changed in 설정 > 화면 (so the buttons are proven too), each of day/night x
 * houses/towers/mixed once, a reroll, then: the phone, a second device, sees the desktop's
 * choice (the daemon keeps it), a reload keeps it, and nothing is repainted while the view idles.
 * Screenshots: agent-tycoon/artifacts/background/.
 *
 *   npx tsx agent-tycoon/test/run-background.ts <port 18256-18259> [shot prefix]
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
  sparePort,
  startDaemon,
  warmUpOffice,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const PREFIX = process.argv[3] ?? 'bg';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/background');
const DESK: BrowserContextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const STORE = { 'agty.title-scene': 'off', 'agty.floor': '2', 'agty.office-iso': 'on' };
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const MIXES = ['mixed', 'houses', 'towers'] as const;
const TIMES = ['night', 'day'] as const;

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
  store: Record<string, string> = STORE,
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
  ctxPages.push(page);
  return { ctx, page };
}

/** 설정 > 화면: click the buttons named by their data attribute, then close. */
async function choose(page: Page, picks: string[]) {
  await page.locator('button[aria-label="설정"]').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.locator('#settings-tab-display').click();
  for (const pick of picks) await dialog.locator(pick).first().click();
  await page.waitForTimeout(300);
  await dialog.locator('[data-modal-title] button').click();
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  await page.waitForTimeout(700);
}
async function pressed(page: Page): Promise<string[]> {
  await page.locator('button[aria-label="설정"]').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.locator('#settings-tab-display').click();
  const on = await dialog
    .locator('[data-time][aria-pressed="true"], [data-mix][aria-pressed="true"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-time') ?? e.getAttribute('data-mix') ?? ''));
  await dialog.locator('[data-modal-title] button').click();
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  return on;
}
const ctxPages: Page[] = [];
const paints = (page: Page): Promise<{ paints: number; ms: number }> =>
  page.evaluate(`window.__agentTycoonTestHooks.getIso().background`) as Promise<{ paints: number; ms: number }>;

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const daemon = startDaemon(makeHome(), port, ['--no-terminal']);
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) });
  try {
    for (const [label, opts] of [
      ['desk', DESK],
      ['phone', PHONE],
    ] as const) {
      const { ctx, page } = await open(browser, daemon, opts);
      for (const time of TIMES)
        for (const mix of MIXES) {
          await choose(page, [`[data-time="${time}"]`, `[data-mix="${mix}"]`]);
          await shot(page, `${label}-${time}-${mix}`);
        }
      await choose(page, ['[data-time="night"]', '[data-mix="mixed"]']);
      const before = await paints(page);
      await page.waitForTimeout(2500);
      const idle = await paints(page);
      check(idle.paints === before.paints, `${label}: nothing repainted while the view idles (${idle.paints} pictures, ${Math.round(idle.ms)} ms in all)`);
      await choose(page, ['[data-testid="background-reroll"]']);
      const rerolled = await paints(page);
      check(rerolled.paints > idle.paints, `${label}: a reroll paints the pieces in view anew (${rerolled.paints - idle.paints})`);
      await shot(page, `${label}-night-mixed-rerolled`);
      if (label === 'desk') {
        await choose(page, ['[data-time="day"]', '[data-mix="towers"]']);
        // A second device (the phone) must see the same choice, and a reload keeps it.
        const phone = await open(browser, daemon, PHONE);
        const got = await pressed(phone.page);
        check(got.includes('day') && got.includes('towers'), `a second device shows the desktop's choice (${got.join(', ')})`);
        await shot(phone.page, 'phone-from-desktop-day-towers');
        await phone.ctx.close();
        await page.reload();
        await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
        await page.waitForTimeout(3000);
        const again = await pressed(page);
        check(again.includes('day') && again.includes('towers'), `a reload keeps it (${again.join(', ')})`);
      }
      await ctx.close();
    }
    // The classic 2D office with the daemon's choice kept: its top-down city is untouched.
    for (const [label, opts] of [
      ['desk', DESK],
      ['phone', PHONE],
    ] as const) {
      const flat = await open(browser, daemon, opts, { ...STORE, 'agty.office-iso': 'off' });
      await shot(flat.page, `${label}-2d`);
      await flat.ctx.close();
    }
  } catch (e) {
    for (const p of ctxPages) await shot(p, 'failure').catch(() => undefined);
    throw e;
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
