/**
 * USAGE-FABLE + USAGE-GENERIC check: each provider shows exactly the windows it reported. Claude
 * (an Ultra plan: 7-day only) reads `Claude 7d 16% · F 7d 18%` (the per-model weekly window from
 * the account usage endpoint's limits[]), with no 5h slot and no "not reported"; Codex reads `5h 35% · 7d 6%`.
 * Folded and open, desktop 1280 and phone 393; the tooltip names Fable.
 *
 * dist/cli.js in a temp HOME with a fake OAuth token and a loopback stand-in for the usage endpoint
 * (testHome's fakeUsage), spare port, headless Chromium (--disable-gpu).
 * Screenshots: cld/artifacts/usage-generic/.
 *
 *   npx tsx cld/test/run-usage-fable.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  fakeUsage,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/usage-generic');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__bx/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__bx/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 120_000;
const IPHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } };
})();

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  const usage = await fakeUsage(home, { sevenDay: 16, fable: 18 }, { fiveHour: 35, sevenDay: 6 });
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--no-terminal', '--allow-actions'],
    { FAKE_TURN_MS: '600', ...usage.env },
  );
  const cleanup = () => {
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}\n${daemon.log.join('').slice(-1500)}`);
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: BrowserContextOptions) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    await ctx.route('**/__bx/*.ttf', (route) =>
      route.fulfill({
        body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
        contentType: 'font/ttf',
      }),
    );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return page;
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
    const notice = page.getByRole('button', { name: '계속 물어보기' });
    if (await notice.count()) await notice.click();
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });

  try {
    const loginUrl = await daemon.loginUrl();
    const desk = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ready(desk, loginUrl);
    const folded = desk.getByTestId('usage-folded');
    const label = desk.getByLabel('사용량');
    // Either state may be the default here; reach both.
    const state = async (want: 'folded' | 'open') => {
      for (let i = 0; i < 40; i++) {
        const isFolded = (await folded.count()) > 0;
        const isOpen = (await label.count()) > 0;
        if (want === 'folded' ? isFolded : isOpen) return;
        if (want === 'open' && isFolded) await folded.click();
        if (want === 'folded' && isOpen)
          await desk.getByRole('button', { name: '사용량 접기' }).click();
        await desk.waitForTimeout(500);
      }
      throw new Error(`usage never ${want}`);
    };
    await state('folded');
    await desk.waitForFunction(
      () => document.querySelector('[data-testid="usage-folded"]')?.textContent?.includes('F 7d'),
      undefined,
      { timeout: 30_000 },
    );
    const text = (await folded.innerText()).replace(/\s+/g, ' ');
    check(/Claude 7d 16% · F 7d 18%/.test(text), `desktop folded: "${text}"`);
    check(
      !/Claude 5h/.test(text) && !text.includes('알려 주지'),
      'desktop folded: no 5h slot for Claude',
    );
    check(/Codex 5h 35% · 7d 6%/.test(text), 'desktop folded: Codex shows both windows');
    check(!/Codex[^C]*F 7d/.test(text), 'desktop folded: Codex has no model window');
    await shot(desk, 'desktop-folded');
    await state('open');
    const fable = desk.locator('[aria-label="사용량"] span[title*="Fable"]');
    check((await fable.count()) === 1, 'desktop open: one Fable window');
    const t = (await fable.innerText()).replace(/\s+/g, ' ');
    check(t.startsWith('F 7d 18%'), `desktop open: "${t}"`);
    const title = await fable.getAttribute('title');
    check(title?.startsWith('Fable 주간 · '), `desktop open: tooltip "${title}"`);
    const cls = await desk
      .locator('[aria-label="사용량"] span', { hasText: /^7d 16%/ })
      .first()
      .getAttribute('class');
    check(
      cls === (await fable.getAttribute('class')),
      'desktop open: same style as the other windows',
    );
    await shot(desk, 'desktop-open');

    const phone = await open(IPHONE);
    await ready(phone, await daemon.loginUrl());
    await phone.waitForFunction(() => document.body.innerText.includes('F 7d'), undefined, {
      timeout: 30_000,
    });
    const body = (await phone.locator('body').innerText()).replace(/\s+/g, ' ');
    check(/Claude 7d 16% · F 7d 18%/.test(body), 'phone: Claude strip shows 7d and F 7d');
    check(
      !(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
      'phone: no sideways scroll',
    );
    await shot(phone, 'phone');
    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`,
    );
    console.log(`screenshots in ${OUT}`);
  } catch (err) {
    console.error(daemon.log.join('').slice(-1500));
    await browser
      .contexts()[0]
      ?.pages()[0]
      ?.screenshot({ path: path.join(OUT, 'debug.png') })
      .catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser.close();
    if (daemon.child.exitCode === null) {
      const gone = new Promise((r) => daemon.child.once('exit', r));
      daemon.child.kill('SIGTERM');
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5_000))]);
    }
    cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
