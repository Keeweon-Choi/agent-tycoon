/**
 * OWNER-HUD check: the "나" plate over the owner's character (isometric and top-down, desktop and
 * phone) and the '내 캐릭터' button in the auto camera: visible while an agent is followed, and
 * pressing it clears the selection and follows the owner again. dist/cli.js in an isolated HOME
 * with the engine fake, headless Chromium with --disable-gpu. Screenshots: cld/artifacts/owner-hud/.
 *
 *   npx tsx cld/test/run-owner-hud.ts <port 18256-18269>
 */
import type { BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/owner-hud');
const DEADLINE_MS = 240_000;
const LEADS = ['alpha', 'beta'];
/** webview-ui/src/constants.ts OWNER_CHARACTER_ID. */
const OWNER = -2_000_000_000;

function check(ok: unknown, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Hooks = {
  getCameraFollowId: () => number | null;
};
const hooks = <T>(page: Page, fn: (h: Hooks, a: any) => T, arg?: unknown): Promise<T> =>
  page.evaluate(
    ([src, a]) =>
      (new Function('h', 'a', `return (${src})(h, a)`) as (h: unknown, a: unknown) => T)(
        (window as unknown as { __agentTycoonTestHooks: Hooks }).__agentTycoonTestHooks,
        a,
      ),
    [fn.toString(), arg] as const,
  );
const followOf = (page: Page) => hooks(page, (h) => h.getCameraFollowId());

async function until(what: string, ok: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await ok()) return true;
  console.log(`  (waited ${ms} ms for ${what})`);
  return false;
}

async function setUp(ctx: BrowserContext, iso: boolean): Promise<void> {
  await ctx.addInitScript((isoOn: boolean) => {
    (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
    (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    if (!sessionStorage.getItem('owner-run')) {
      sessionStorage.setItem('owner-run', '1');
      localStorage.setItem('cld.camera-mode', 'auto');
      localStorage.setItem('cld.office-iso', isoOn ? 'on' : 'off');
    }
  }, iso);
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForURL(`http://127.0.0.1:${port}/`);
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  // The update notice covers the 자동/로비 group on a phone (a tap would scroll the page under it).
  const notice = page.getByTestId('update-notice');
  if (
    await notice.waitFor({ timeout: 3_000 }).then(
      () => true,
      () => false,
    )
  )
    await notice.getByRole('button').last().click();
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const config = configDirectory(home);
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(
    path.join(config, 'projects.json'),
    JSON.stringify(
      LEADS.map((name) => {
        const folder = path.join(home, 'work', name);
        fs.mkdirSync(folder, { recursive: true });
        return { name, folder, room: '개발실', wantRunning: true };
      }),
    ),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    server.kill('SIGKILL');
    killFakeSessions(home);
    process.exit(1);
  }, DEADLINE_MS);
  const browser = await launchBrowser();
  try {
    const views = [
      { name: 'desktop-iso', iso: true, opts: { viewport: { width: 1280, height: 800 } } },
      { name: 'desktop-topdown', iso: false, opts: { viewport: { width: 1280, height: 800 } } },
      {
        name: 'phone-iso',
        iso: true,
        opts: {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
        },
      },
      {
        name: 'phone-topdown',
        iso: false,
        opts: {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
        },
      },
    ];
    for (const v of views) {
      const ctx = await browser.newContext(v.opts);
      await setUp(ctx, v.iso);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await open(page, await daemon.loginUrl()); // a login link is good for one device
      check(
        await until('the owner followed', async () => (await followOf(page)) === OWNER),
        `${v.name}: the owner is followed`,
      );
      await sleep(1500);
      const plate = page.getByTestId('owner-plate');
      check((await plate.count()) === 1 && (await plate.isVisible()), `${v.name}: the plate shows`);
      check((await plate.textContent()) === '나', `${v.name}: it reads 나`);
      await page.screenshot({ path: path.join(OUT, `${v.name}-1-plate.png`) });
      // Follow an agent: the button is still there.
      const alpha = page.getByTestId('agent-card').filter({ hasText: 'alpha' }).first();
      if (await alpha.isVisible().catch(() => false)) await alpha.click();
      else await page.getByTestId('agent-overlay').filter({ hasText: 'alpha' }).first().click();
      const alphaId = Number(
        await page
          .locator('[data-testid="agent-overlay"]', { hasText: 'alpha' })
          .first()
          .getAttribute('data-agent-id'),
      );
      check(
        await until('the agent followed', async () => (await followOf(page)) === alphaId),
        `${v.name}: an agent is followed`,
      );
      await sleep(1200);
      const btn = page.getByTestId('owner-follow');
      check(await btn.isVisible(), `${v.name}: the button shows while an agent is followed`);
      await page.screenshot({ path: path.join(OUT, `${v.name}-2-agent-button.png`) });
      await btn.click();
      check(
        await until('back to the owner', async () => (await followOf(page)) === OWNER),
        `${v.name}: the button goes back to the owner`,
      );
      await sleep(1500);
      check(await btn.isVisible(), `${v.name}: the button still shows`);
      await page.screenshot({ path: path.join(OUT, `${v.name}-3-pressed.png`) });
      check(errors.length === 0, `${v.name}: no page errors ${errors.join('; ')}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    clearTimeout(deadline);
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
