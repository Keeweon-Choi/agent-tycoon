/**
 * feat-iso-phone-start-on-owner: the phone (390x844) opens with the owner's character in the middle
 * (followed, at the rooms' zoom) although an agent is at work; the desktop's first screen is as it
 * was. Pictures only: the checks read the pictures by eye. dist/cli.js in an isolated HOME on a spare port, headless Chromium without a GPU.
 *
 *   npx tsx agent-tycoon/test/run-feat-iso-phone-start-on-owner.ts <port 18620-18629>
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
if (!(port >= 18620 && port <= 18629)) throw new Error('port must be 18620-18629');
const OUT = path.join(
  REPO_ROOT,
  process.env.OUT_DIR ?? 'agent-tycoon/artifacts/feat-iso-phone-start-on-owner',
);
const DESK: BrowserContextOptions = {
  viewport: { width: 1282, height: 832 },
  deviceScaleFactor: 1,
};
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

async function open(
  browser: Browser,
  daemon: ReturnType<typeof startDaemon>,
  opts: BrowserContextOptions,
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
    Object.entries({ 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': '1' }),
  );
  // warmUpOffice's defaults say 'off' (no framing) for the old runners: this one is about auto.
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('agty.camera-mode', 'auto');
    } catch {
      // about:blank
    }
  });
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  await page.goto(await daemon.loginUrl());
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(5000);
  return { ctx, page };
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const dir = configDirectory(fake.home);
  fs.mkdirSync(dir, { recursive: true });
  // Three floors, as run-building-a's: the floor panel (and its view toggle) only shows for a building of several.
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
  const daemon = startDaemon(fake, port, ['--no-terminal', '--engine', 'on']);
  try {
    const p = await open(browser, daemon, PHONE);
    await shot(p.page, 'phone-first-screen');
    const toggle = p.page.getByTestId('camera-toggle');
    check((await toggle.getAttribute('data-mode')) === 'auto', 'phone: the camera starts in auto');
    await toggle.click(); // auto -> free
    await p.page.waitForTimeout(800);
    await toggle.click(); // free -> auto
    await p.page.waitForTimeout(2500);
    await shot(p.page, 'phone-after-auto');
    await p.ctx.close();
    const d = await open(browser, daemon, DESK);
    await shot(d.page, 'desktop-first-screen');
    await d.ctx.close();
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
