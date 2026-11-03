/**
 * OWNER-STATS check: the owner's own 스탯 window, after a few owner actions.
 * dist/cli.js with --engine on in an isolated HOME (the engine fake `claude`), on a spare port,
 * headless Chromium with --disable-gpu, the auto camera, the top-down office.
 *
 * Desktop (1280x800): the owner walks (D), the page's own socket creates 10 Tasks and sends a DM
 * (an owner session: 104 XP, Lv 2, the level-up plays over the owner), the 30 s activity report
 * lands; a click on the owner, then 스탯, opens the window with Lv 2 and today's rows. Phone
 * (390x844 touch): a tap on the owner, then 스탯, opens the same window.
 * Screenshots go to cld/artifacts/owner-stats/.
 *
 *   npx tsx cld/test/run-owner-stats.ts <port 18264-18265>
 */
import type { BrowserContext, Page } from '@playwright/test';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/owner-stats');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__owner/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
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
  getCharacterPosition: (id: number) => { x: number; y: number } | null;
  getCamera: () => { zoom: number; pan: { x: number; y: number }; cols: number; rows: number };
};
const followOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __agentTycoonTestHooks: Hooks }).__agentTycoonTestHooks.getCameraFollowId());

async function until(what: string, ok: () => Promise<boolean> | boolean, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await ok()) return true;
  console.log(`  (waited ${ms} ms for ${what})`);
  return false;
}

/** Where the owner's character is drawn, in viewport px (its middle, above the feet). */
function ownerOnScreen(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __agentTycoonTestHooks: Hooks }).__agentTycoonTestHooks;
    const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const { zoom: z, pan, cols, rows } = h.getCamera();
    const p = h.getCharacterPosition(id)!;
    const ox = Math.floor((canvas.width - cols * 16 * z) / 2) + pan.x;
    const oy = Math.floor((canvas.height - rows * 16 * z) / 2) + pan.y;
    return { x: r.left + (ox + p.x * z) / dpr, y: r.top + (oy + (p.y - 10) * z) / dpr };
  }, OWNER);
}

async function setUp(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/__owner/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
  await ctx.addInitScript(() => {
    (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
    (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    localStorage.setItem('cld.camera-mode', 'auto');
    localStorage.setItem('cld.office-iso', 'off');
  });
}

async function open(page: Page, url: string, port: number): Promise<void> {
  await page.goto(url);
  await page.waitForURL(`http://127.0.0.1:${port}/`);
  await page.addStyleTag({ content: FONT_CSS });
  await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  const notice = page.getByTestId('update-notice');
  if (await notice.waitFor({ timeout: 3_000 }).then(() => true, () => false))
    await notice.getByRole('button').last().click();
}

/** Tap or click the owner, then 스탯: the window. */
async function openStats(page: Page, tap: boolean): Promise<boolean> {
  check(await until('the owner followed', async () => (await followOf(page)) === OWNER), 'the owner is followed');
  await sleep(1200);
  const at = await ownerOnScreen(page);
  if (tap) await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.click(at.x, at.y);
  const item = page.getByTestId('owner-stats-open');
  if (!(await item.waitFor({ timeout: 5_000 }).then(() => true, () => false))) return false;
  await item.click();
  return page.getByTestId('owner-stats').waitFor({ timeout: 5_000 }).then(() => true, () => false);
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
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
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
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const owner = () => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(config, 'levels.json'), 'utf-8')) as { owner?: { xp: number; today: Record<string, number> } }).owner;
    } catch {
      return undefined;
    }
  };
  try {
    const pageErrors: string[] = [];
    // ── Desktop ──────────────────────────────────────────────
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await setUp(desk);
    const page = await desk.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await open(page, await daemon.loginUrl(), port);
    check(await until('the owner followed', async () => (await followOf(page)) === OWNER), 'the owner is in the office');
    await sleep(6_000); // past the page's settle window (REST_SETTLE_MS): what comes now is live
    const reportFrom = Date.now();
    await page.keyboard.down('d');
    await sleep(900);
    await page.keyboard.up('d');
    // The owner's own actions, on a socket of this logged-in page (cookie: an owner session).
    const answers = await page.evaluate(async () => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      const got: string[] = [];
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; ok?: boolean; error?: string };
        if (m.type === 'chatSendResult') got.push(`chat ${m.ok} ${m.error ?? ''}`);
        if (m.type === 'taskBoard' && m.error) got.push(`task ${m.error}`);
        if (m.type === 'officeSnapshot' && (m as { owner?: { level: { level: number } } }).owner!.level.level >= 2) lv2();
      };
      let lv2: () => void = () => undefined;
      const levelled = new Promise<void>((r) => (lv2 = r));
      await new Promise((r) => (ws.onopen = r));
      ws.send(JSON.stringify({ type: 'webviewReady' }));
      for (let i = 0; i < 10; i++)
        ws.send(JSON.stringify({ type: 'taskEdit', fields: { project: 'alpha', title: `owner task ${i + 1}` } }));
      ws.send(JSON.stringify({ type: 'chatSend', requestId: 'r1', name: 'alpha', text: 'hello from the owner' }));
      // The first office snapshot after the XP (any publish carries the owner's live Lv)
      await Promise.race([levelled, new Promise((r) => setTimeout(r, 15_000))]);
      ws.close();
      return got;
    });
    console.log(`  answers: ${answers.join(' | ')}`);
    await sleep(600); // the burst plays 3-3.5 s
    await shot(page, 'desktop-1-levelup');
    check(await until('owner XP on disk', () => (owner()?.xp ?? 0) >= 100, 15_000), `the owner's XP reached Lv 2 (${owner()?.xp} XP)`);
    // The page's first activity report: 30 s after the first frame (plus the 5 s write).
    await until('the activity report', () => (owner()?.today.seconds ?? 0) > 0, 45_000 - (Date.now() - reportFrom));
    const today = owner()?.today;
    check((today?.seconds ?? 0) > 0 && (today?.seconds ?? 99) <= 60, `connected time counted and clamped (${today?.seconds} s)`);
    check((today?.steps ?? 0) > 0, `steps counted (${today?.steps})`);
    check(today?.tasks === 10, `10 Tasks counted (${today?.tasks})`);
    await page.keyboard.press('Escape');
    check(await openStats(page, false), 'click on the owner, then 스탯: the window opens');
    const level = page.getByTestId('owner-stats-level');
    check((await level.getAttribute('data-level')) === '2', `the window says Lv 2 (${await level.getAttribute('data-xp')} XP)`);
    check((await page.getByTestId('owner-today-tasks').textContent()) === '10', 'today: 10 Tasks');
    await shot(page, 'desktop-2-stats');
    await desk.close();

    // ── Phone ────────────────────────────────────────────────
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await setUp(phone);
    const p = await phone.newPage();
    p.on('pageerror', (e) => pageErrors.push(String(e)));
    await open(p, await daemon.loginUrl(), port);
    check(await openStats(p, true), 'phone: tap on the owner, then 스탯: the window opens');
    await sleep(500);
    await shot(p, 'phone-1-stats');
    await phone.close();
    check(pageErrors.length === 0, `no page errors ${pageErrors.join(' | ')}`);
  } finally {
    await browser.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
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
