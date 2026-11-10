/**
 * DISK-CARD check: dist/cli.js with an isolated HOME on a spare port, in headless
 * Chromium (desktop 1280x800, phone 390x844). The fake HOME holds known sizes in each
 * place the card counts; the H/W page of the lobby board (wall and full view) shows them.
 * Screenshots go to agent-tycoon/artifacts/disk-card/.
 *
 *   npx tsx agent-tycoon/test/run-disk-card.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { jobsDir } from '../../server/src/agent-tycoon/engine/jobs.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/disk-card');
const DEADLINE_MS = 180_000;
const MIB = 1024 * 1024;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

const put = (file: string, bytes: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
};

/** One finger dragged across the office (CDP touch events: Playwright only taps). */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const at = (k: number) => [
    { x: from.x + ((to.x - from.x) * k) / 12, y: from.y + ((to.y - from.y) * k) / 12 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let k = 1; k <= 12; k++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  writeEngineProjects(
    fake.home,
    names.map((name) => ({ name, folder: path.join(fake.home, 'work', name), room: 'orch-1' })),
  );
  put(path.join(fake.home, '.claude/projects/-work-alpha/a.jsonl'), 340 * MIB);
  put(path.join(fake.home, 'work/alpha/.worktrees/t1/blob'), 12 * MIB);
  put(path.join(fake.home, 'work/beta/.worktrees/t2/blob'), 3 * MIB);
  put(path.join(jobsDir(fake.home), '1101-000000-alpha.log'), 2 * MIB);
  put(path.join(configDirectory(fake.home), 'big-state.bin'), 1 * MIB);
  // A link to a big file outside: never counted.
  put(path.join(fake.home, 'outside.bin'), 500 * MIB);
  fs.symlinkSync(
    path.join(fake.home, 'outside.bin'),
    path.join(fake.home, '.claude/projects/-work-alpha/link'),
  );

  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  const deadline = setTimeout(() => {
    console.error('deadline: stopping');
    daemon.kill('SIGTERM');
    process.exit(2);
  }, DEADLINE_MS);
  const pageErrors: string[] = [];
  const browser = await launchBrowser();
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    await ctx.addInitScript(() => localStorage.setItem('agty.office-hours', '{"on":false}'));
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const board = (page: Page) => page.locator('[data-testid="lobby-board"]');
  const cardText = (scope: ReturnType<Page['locator']>) =>
    scope.locator('.led-diskcard').textContent({ timeout: 1_000 }).catch(() => null);

  try {
    const loginUrl = await started.loginUrl();
    // ── Desktop ──
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await until('the lobby board is on screen', async () => (await board(page).count()) === 1);
    await shot(page, 'desktop-office');
    await board(page).locator('[data-testid="board-tab-hw"]').click();
    await until(
      'the wall board shows its H/W page',
      async () => (await board(page).locator('.led-donut').count()) > 0,
    );
    await page.waitForTimeout(1_500);
    check(
      (await board(page).locator('.led-diskcard').count()) === 0,
      'the wall copy (pages turn by themselves) neither asks for nor shows the disk card',
    );
    await shot(page, 'desktop-wall-hw');

    const b = (await board(page).boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.7);
    const full = page.locator('[data-testid="board-full"]');
    await full.waitFor({ timeout: 3_000 });
    await full.locator('[data-testid="board-tab-hw"]').click();
    await until('the full view shows the disk card', async () => (await cardText(full)) !== null);
    const card = (await cardText(full)) ?? '';
    console.log(`card: ${card}`);
    check(/340 MB/.test(card), 'Claude logs read 340 MB (the 500 MB link is not counted)');
    check(/15 MB/.test(card), 'worktrees of two projects add up to 15 MB');
    check(/2 MB/.test(card), 'job logs read 2 MB');
    await shot(page, 'desktop-full-hw');
    await full.locator('.led-diskcard').scrollIntoViewIfNeeded();
    await shot(page, 'desktop-full-hw-card');
    await page.keyboard.press('Escape');

    // ── Phone ──
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.locator('[data-testid="office-canvas"]').waitFor();
    await phone.waitForTimeout(1500);
    const boxOf = async () => ((await board(phone).count()) ? board(phone).boundingBox() : null);
    const reachable = async () => {
      const pb = await boxOf();
      return !!pb && pb.x < 300 && pb.x + pb.width > 90 && pb.y > 80 && pb.y < 600;
    };
    for (let k = 0; k < 10 && !(await reachable()); k++) {
      const pb = await boxOf();
      const clamp = (d: number) => Math.max(-250, Math.min(250, d));
      const to = pb ? { x: 195 + clamp(8 - pb.x), y: 380 + clamp(260 - pb.y) } : { x: 120, y: 200 };
      await touchDrag(phone, { x: 195, y: 380 }, to);
      await phone.waitForTimeout(400);
    }
    check(await reachable(), 'the phone pans to the lobby board');
    const pb = (await board(phone).boundingBox())!;
    const tapX = (Math.max(0, pb.x) + Math.min(390, pb.x + pb.width)) / 2;
    const tapY = (Math.max(80, pb.y + pb.height * 0.3) + Math.min(700, pb.y + pb.height)) / 2;
    await phone.touchscreen.tap(tapX, tapY);
    const pfull = phone.locator('[data-testid="board-full"]');
    await pfull.waitFor({ timeout: 3_000 });
    await pfull.locator('[data-testid="board-tab-hw"]').tap();
    await until('the phone full view shows the disk card', async () => (await cardText(pfull)) !== null);
    await shot(phone, 'phone-full-hw');
    await pfull.locator('.led-diskcard').scrollIntoViewIfNeeded();
    await shot(phone, 'phone-full-hw-card');
    const fit = await phone.evaluate(() => document.body.scrollWidth <= window.innerWidth);
    check(fit, 'the phone view has no sideways scroll');

    check(pageErrors.length === 0, `no page errors ${JSON.stringify(pageErrors)}`);
    await phoneCtx.close();
    await desk.close();
  } catch (err) {
    console.error(started.log.join('').slice(-3000));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser.close();
    daemon.kill('SIGTERM');
  }
}

main().then(
  () => {
    console.log('all checks passed');
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
