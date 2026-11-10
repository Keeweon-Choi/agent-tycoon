/**
 * WINDOW-MODE check: dist/cli.js with an isolated HOME on a spare port, headless Chromium
 * (--disable-gpu), 1280x800 page on a 1920x1080 screen.
 * - with a fake desktop bridge (window.__TAURI_INTERNALS__.invoke, planted before the page runs)
 *   설정 → 화면 shows 화면 모드: 창 is on, 전체 화면 calls toggle_fullscreen, a page the size of
 *   the screen reads as 전체 화면, 창 calls it again, the button already on calls nothing;
 * - a plain browser (no bridge) has no 화면 모드 row.
 * Screenshots to agent-tycoon/artifacts/fullscreen-1104/.
 *
 *   npx tsx agent-tycoon/test/run-fullscreen-1104.ts <port 18360-18369>
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  topBarButton,
  topBarReady,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/fullscreen-1104');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__st/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const FAKE_BRIDGE = `window.__TAURI_INTERNALS__ = { invoke: (cmd) => { (window.__calls ||= []).push(cmd); return Promise.resolve(); } };`;

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal']);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    for (const app of [true, false]) {
      const tag = app ? 'desktop-app' : 'browser';
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        screen: { width: 1920, height: 1080 },
      });
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
      if (app) await ctx.addInitScript(FAKE_BRIDGE);
      await ctx.route('**/__st/malgun.ttf', (route) =>
        route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
      );
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      await topBarReady(page, 60_000);
      const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
      if (await closeInfo.count()) await closeInfo.first().click();
      await topBarButton(page, '설정');
      await page.getByRole('tab', { name: '화면', exact: true }).click();
      await page.getByTestId('ui-scale-option').waitFor();
      const row = page.getByTestId('window-mode-option');
      const shot = (name: string) =>
        page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) });
      if (!app) {
        check((await row.count()) === 0, 'browser: no 화면 모드 row');
        await shot('display-tab');
        await ctx.close();
        continue;
      }
      const calls = () =>
        page.evaluate(() => ((window as unknown as { __calls?: string[] }).__calls ?? []).slice());
      const pressed = (mode: string) =>
        row.locator(`[data-window-mode="${mode}"]`).getAttribute('aria-pressed');
      check(await row.isVisible(), 'desktop app: 화면 모드 row on the 화면 tab');
      check((await row.textContent())?.includes('F11'), 'desktop app: the row names F11');
      check(
        (await pressed('window')) === 'true',
        'desktop app: a window smaller than the screen reads as 창',
      );
      await shot('window');
      await row.locator('[data-window-mode="window"]').click();
      check((await calls()).length === 0, 'desktop app: 창 while already 창 calls nothing');
      await row.locator('[data-window-mode="fullscreen"]').click();
      check(
        (await calls()).join() === 'toggle_fullscreen',
        'desktop app: 전체 화면 calls toggle_fullscreen',
      );
      await page.setViewportSize({ width: 1920, height: 1080 }); // what the app's window does next
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-window-mode="fullscreen"]')
            ?.getAttribute('aria-pressed') === 'true',
      );
      check(true, 'desktop app: a page the size of the screen reads as 전체 화면');
      await shot('fullscreen');
      await row.locator('[data-window-mode="window"]').click();
      check(
        (await calls()).join() === 'toggle_fullscreen,toggle_fullscreen',
        'desktop app: 창 calls toggle_fullscreen again',
      );
      await ctx.close();
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log(`all ${oks} checks passed`);
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
