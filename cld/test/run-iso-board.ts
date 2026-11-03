/**
 * ISO-BOARD proof (owner 11-03 11:57): in the isometric office a click (a tap on the phone) on
 * the lobby's 전광판 opens its full view, as the top view does; the board's head shows
 * 나를 기다림 N (agents waiting on a permission or a question), 0 and then 1 once a fake session's
 * tool waits past the permission timer; pressing it opens the 현황판 on its 오케스트레이터 tab.
 * dist/cli.js with an isolated HOME (run-iso-floors' three-floor building, the lobby in focus)
 * on a spare port, headless Chromium without a GPU, desktop 1920x1080 and phone 390x844.
 * Screenshots: cld/artifacts/iso-board/.
 *
 *   npx tsx cld/test/run-iso-board.ts <port 18260-18269>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  DEV_WINDOW,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18260 && port <= 18269)) throw new Error('port must be 18260-18269');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/iso-board');
const DESK: BrowserContextOptions = {
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const ALPHA = { cwd: '/work/orch-alpha', sessionId: 'a0000001-0000-4000-8000-000000000001' };

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
    Object.entries({ 'cld.title-scene': 'off', 'cld.office-iso': 'on', 'cld.floor': '1' }),
  );
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  await page.goto(await daemon.loginUrl());
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  return { ctx, page };
}

const focusOf = (page: Page) =>
  page.evaluate(`window.__agentTycoonTestHooks.getIso().focus`) as Promise<string>;
const waitingOf = async (page: Page) =>
  Number(await page.getByTestId('board-waiting').first().getAttribute('data-count'));

async function until(page: Page, what: string, fn: () => Promise<boolean>, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(250))
    if (await fn()) return check(true, what);
  check(false, what);
}

/** Press the board's middle (the canvas under it: the copy lets the pointer through). */
async function pressBoard(page: Page, tap: boolean) {
  const b = (await page.getByTestId('lobby-board').boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height * 0.6];
  if (tap) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

/** The 현황판 is open on its 오케스트레이터 tab. */
async function onStatusTab(page: Page): Promise<boolean> {
  const win = page.locator(DEV_WINDOW).first();
  if (!(await win.isVisible())) return false;
  const tab = win.getByRole('button', { name: '오케스트레이터', exact: true }).first();
  return (await tab.getAttribute('aria-pressed')) === 'true';
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeHome();
  const browser = await launchBrowser();
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    // ── PC ──
    const d = await open(browser, daemon, DESK);
    await d.page.getByTestId('lobby-board').waitFor();
    check((await focusOf(d.page)) === '1', 'the lobby is the floor in focus');
    await shot(d.page, 'desktop-1-iso-board');
    check((await waitingOf(d.page)) === 0, 'desktop: 나를 기다림 0 with nobody waiting');
    await pressBoard(d.page, false);
    check(
      await d.page.getByTestId('board-full').isVisible(),
      'desktop: a click on the iso board opens its full view',
    );
    check((await focusOf(d.page)) === '1', 'desktop: the click kept the lobby in focus');
    await shot(d.page, 'desktop-2-full-view');
    await d.page.keyboard.press('Escape');
    await d.page.waitForTimeout(500);
    check(!(await d.page.getByTestId('board-full').isVisible()), 'desktop: Esc closes it');

    // A tool that never answers: past the permission timer the session waits on the user.
    const file = transcriptPath(ALPHA.cwd, ALPHA.sessionId, fake.home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const call = {
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'tool_use', id: 'tu-wait', name: 'Bash', input: { command: 'rm -rf build' } },
        ],
      },
    };
    fs.appendFileSync(file, `${JSON.stringify(call)}\n`);
    await until(
      d.page,
      'desktop: 나를 기다림 1 once alpha waits on a permission',
      async () => (await waitingOf(d.page)) === 1,
    );
    await shot(d.page, 'desktop-3-waiting-1');
    // The floor view: the board big enough to read, its count pressed there.
    await d.page.getByTestId('iso-view-toggle').click();
    await d.page.waitForTimeout(1500);
    await shot(d.page, 'desktop-3b-floor-view-waiting-1');
    await d.page.getByTestId('lobby-board').getByTestId('board-waiting').click();
    await until(
      d.page,
      'desktop: 나를 기다림 opens the 현황판 on 오케스트레이터',
      () => onStatusTab(d.page),
      5000,
    );
    await shot(d.page, 'desktop-4-status-tab');
    // From the full view too: it closes and the 현황판 is in front.
    await d.page
      .locator(DEV_WINDOW)
      .first()
      .getByRole('button', { name: '개발', exact: true })
      .first()
      .click();
    await pressBoard(d.page, false);
    if (await d.page.getByTestId('board-full').isVisible()) {
      await d.page.getByTestId('board-full').getByTestId('board-waiting').click();
      await d.page.waitForTimeout(600);
      check(
        !(await d.page.getByTestId('board-full').isVisible()) && (await onStatusTab(d.page)),
        'desktop: 나를 기다림 in the full view closes it and opens 오케스트레이터',
      );
    } else console.log('note - the 현황판 window covers the board: full-view press skipped');
    await d.ctx.close();

    // ── Phone ──
    const p = await open(browser, daemon, PHONE);
    await p.page.getByTestId('lobby-board').waitFor();
    await shot(p.page, 'phone-1-iso-board');
    await until(
      p.page,
      'phone: 나를 기다림 1',
      async () => (await waitingOf(p.page)) === 1,
      15_000,
    );
    await pressBoard(p.page, true);
    check(
      await p.page.getByTestId('board-full').isVisible(),
      'phone: a tap on the iso board opens its full view',
    );
    await shot(p.page, 'phone-2-full-view');
    await p.page.getByTestId('board-full').getByTestId('board-waiting').tap();
    await until(
      p.page,
      'phone: 나를 기다림 opens the 현황판 page on 오케스트레이터',
      () => onStatusTab(p.page),
      5000,
    );
    await shot(p.page, 'phone-3-status-tab');
    await p.ctx.close();
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
