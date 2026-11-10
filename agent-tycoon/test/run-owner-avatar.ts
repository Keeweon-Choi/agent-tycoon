/**
 * OWNER-AVATAR check: the owner walks the office as their own character and the camera follows it.
 * dist/cli.js with --engine on in an isolated HOME whose `claude` is the engine fake, on a spare
 * port, headless Chromium with --disable-gpu, the auto camera, office hours off.
 *
 * Desktop (1280x800): the owner's character is there and followed with nothing selected; D walks
 * it right, two keys walk a diagonal; a card selects an agent and the camera goes there, Esc comes
 * back; the free camera pans with the keys (the character stays) and '내 캐릭터' follows again; a
 * click on it opens its menu (꾸미기 and its own 스탯, OWNER-STATS), whose 꾸미기 saves a look under the `owner` key; 설정 →
 * 내 캐릭터 opens the same 꾸미기. Phone (390x844 touch): the pad shows with nothing selected and
 * walks it (a diagonal drag walks a diagonal); in the free camera the pad pans.
 * Video and screenshots go to agent-tycoon/artifacts/owner-avatar/ (mp4 H.264 + GIF by ffmpeg).
 *
 *   npx tsx agent-tycoon/test/run-owner-avatar.ts <port 18266-18267>
 */
import type { BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  topBarButton,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/owner-avatar');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__owner/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
const LEADS = ['alpha', 'beta'];
/** webview-ui/src/constants.ts OWNER_CHARACTER_ID. */
const OWNER = -2_000_000_000;

function check(ok: unknown, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Tile = { col: number; row: number };
type Hooks = {
  getCharacterTile: (id: number) => Tile | null;
  getCameraFollowId: () => number | null;
  getCharacterPosition: (id: number) => { x: number; y: number } | null;
  getCamera: () => { zoom: number; pan: { x: number; y: number }; cols: number; rows: number };
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
const tileOf = (page: Page) => hooks(page, (h, a) => h.getCharacterTile(a), OWNER);
const followOf = (page: Page) => hooks(page, (h) => h.getCameraFollowId());
const panOf = (page: Page) => hooks(page, (h) => h.getCamera().pan);

async function until(what: string, ok: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await ok()) return true;
  console.log(`  (waited ${ms} ms for ${what})`);
  return false;
}

/** Sample the owner's tile while `act` runs: the tiles it passed. */
async function trail(page: Page, act: () => Promise<void>): Promise<Tile[]> {
  const seen: Tile[] = [];
  let on = true;
  const sampler = (async () => {
    while (on) {
      const t = await tileOf(page);
      if (t && !seen.some((s) => s.col === t.col && s.row === t.row)) seen.push(t);
      await sleep(40);
    }
  })();
  await act();
  await sleep(500);
  on = false;
  await sampler;
  return seen;
}
const hasDiagonal = (tiles: Tile[]) =>
  tiles.some((t, i) => i > 0 && t.col !== tiles[i - 1].col && t.row !== tiles[i - 1].row);
const fmt = (tiles: Tile[]) => tiles.map((t) => `(${t.col},${t.row})`).join(' ');

/** Where the owner's character is drawn, in viewport px (its middle, above the feet). */
async function ownerOnScreen(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const h = (window as unknown as { __agentTycoonTestHooks: Hooks }).__agentTycoonTestHooks;
    const canvas = [...document.querySelectorAll('canvas')].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0];
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
  await ctx.route('**/__owner/malgun.ttf', (route) =>
    route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
  );
  await ctx.addInitScript(() => {
    (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
    (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    if (!sessionStorage.getItem('owner-run')) {
      sessionStorage.setItem('owner-run', '1');
      localStorage.setItem('agty.camera-mode', 'auto');
      localStorage.setItem('agty.office-iso', 'off');
    }
  });
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForURL(`http://127.0.0.1:${port}/`);
  await page.addStyleTag({ content: FONT_CSS });
  await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
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

/** webm -> H.264 mp4 (iPhone plays it) and a GIF at most `gifWidth` wide. */
function encode(webm: string, name: string, gifWidth: number): void {
  const mp4 = path.join(OUT, `${name}.mp4`);
  const gif = path.join(OUT, `${name}.gif`);
  const ff = (args: string[]) =>
    execFileSync('nice', ['-n', '10', 'ffmpeg', '-y', '-loglevel', 'error', ...args]);
  ff([
    '-i',
    webm,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'main',
    '-movflags',
    '+faststart',
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    mp4,
  ]);
  ff([
    '-i',
    webm,
    '-vf',
    `fps=5,scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    gif,
  ]);
  const mb = (f: string) => (fs.statSync(f).size / 1e6).toFixed(2);
  console.log(`  ${name}: mp4 ${mb(mp4)} MB, gif ${mb(gif)} MB`);
  check(fs.statSync(gif).size <= 4e6, `${name}.gif is at most 4 MB`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
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
  const videos = path.join(home, 'videos');
  const browser = await launchBrowser();
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    const url = await daemon.loginUrl();
    const pageErrors: string[] = [];

    // ── Desktop ──────────────────────────────────────────────
    const desk = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: path.join(videos, 'desktop'), size: { width: 1280, height: 800 } },
    });
    await setUp(desk);
    const page = await desk.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await open(page, url);
    check(
      await until(
        'the owner followed',
        async () => !!(await tileOf(page)) && (await followOf(page)) === OWNER,
      ),
      'the owner character is in the office and followed with nothing selected',
    );
    await sleep(1500);
    await shot(page, 'desktop-1-follow');

    const start = (await tileOf(page))!;
    await page.keyboard.down('d');
    await sleep(900);
    await page.keyboard.up('d');
    await sleep(500);
    const right = (await tileOf(page))!;
    check(right.col > start.col, `D walks it right (${start.col} to ${right.col})`);
    check((await followOf(page)) === OWNER, 'the camera still follows it');

    const diag = await trail(page, async () => {
      await page.keyboard.down('w');
      await page.keyboard.down('d');
      await sleep(700);
      await page.keyboard.up('d');
      await page.keyboard.up('w');
      await page.keyboard.down('s');
      await page.keyboard.down('a');
      await sleep(700);
      await page.keyboard.up('a');
      await page.keyboard.up('s');
    });
    console.log(`  diagonal trail ${fmt(diag)}`);
    check(hasDiagonal(diag), 'two keys walk a diagonal');
    await shot(page, 'desktop-2-walked');

    const card = page.getByTestId('agent-card').filter({ hasText: 'alpha' }).first();
    const alpha = Number(
      await page
        .locator('[data-testid="agent-overlay"]', { hasText: 'alpha' })
        .first()
        .getAttribute('data-agent-id'),
    );
    await card.click();
    check(
      await until('the agent followed', async () => (await followOf(page)) === alpha),
      'a card moves the camera to its agent',
    );
    await sleep(1200);
    await shot(page, 'desktop-3-agent');
    await page.mouse.move(640, 790); // the keys must reach the office, not a focused card
    await page.keyboard.press('Escape');
    check(
      await until('back to the owner', async () => (await followOf(page)) === OWNER),
      'Esc goes back to the owner',
    );
    await sleep(1200);

    await page.getByTestId('camera-toggle').click();
    check(
      (await page.getByTestId('camera-toggle').getAttribute('data-mode')) === 'free',
      'the free camera is on',
    );
    await sleep(300);
    const before = { tile: (await tileOf(page))!, pan: await panOf(page) };
    await page.keyboard.down('d');
    await sleep(900);
    await page.keyboard.up('d');
    await sleep(500);
    const after = { tile: (await tileOf(page))!, pan: await panOf(page) };
    check(
      after.pan.x !== before.pan.x,
      `free: D pans the camera (${Math.round(before.pan.x)} to ${Math.round(after.pan.x)})`,
    );
    check(
      after.tile.col === before.tile.col && after.tile.row === before.tile.row,
      'free: the character stays',
    );
    check((await followOf(page)) === null, 'free: nothing is followed');
    await shot(page, 'desktop-4-free');
    await page.getByTestId('owner-follow').click();
    check(
      await until('following again', async () => (await followOf(page)) === OWNER),
      "'내 캐릭터' follows it again",
    );
    await sleep(1500);

    const at = await ownerOnScreen(page);
    await page.mouse.click(at.x, at.y);
    const menu = page.getByTestId('owner-menu');
    check(
      await menu.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      ),
      'a click on it opens its menu',
    );
    check((await menu.getByRole('menuitem').count()) === 2, 'its menu has 꾸미기 and 스탯');
    await shot(page, 'desktop-5-menu');
    await menu.getByRole('menuitem').first().click();
    const looks = page.locator('[data-testid="looks-window"][data-name="owner"]');
    check(
      await looks.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      ),
      "꾸미기 opens for the owner's look",
    );
    await looks.getByRole('button', { name: /마스코트/ }).click();
    await looks.getByTestId('looks-save').click();
    const saved = () => {
      try {
        return (
          'owner' in
          (JSON.parse(fs.readFileSync(path.join(config, 'characters.json'), 'utf-8')) as object)
        );
      } catch {
        return false;
      }
    };
    check(
      await until('characters.json', async () => saved()),
      'the look is saved under the owner key',
    );
    await sleep(800);
    await shot(page, 'desktop-6-looks-saved');
    await page
      .getByRole('button', { name: /꾸미기 닫기/ })
      .first()
      .click()
      .catch(() => {});

    await topBarButton(page, '설정');
    const row = page.getByTestId('owner-character-option');
    check(
      await row.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      ),
      '설정 has 내 캐릭터',
    );
    await shot(page, 'desktop-7-settings');
    await page.getByTestId('owner-character-pick').click();
    check(
      await looks.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      ),
      '설정 → 내 캐릭터 opens its 꾸미기',
    );
    await sleep(500);
    const deskVideo = await page.video()!.path();
    await desk.close();

    // ── Phone ────────────────────────────────────────────────
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      recordVideo: { dir: path.join(videos, 'phone'), size: { width: 390, height: 844 } },
    });
    await setUp(phone);
    const p = await phone.newPage();
    p.on('pageerror', (e) => pageErrors.push(String(e)));
    await open(p, await daemon.loginUrl()); // a login link is good for one device
    check(
      await until('the owner followed', async () => (await followOf(p)) === OWNER),
      'phone: the owner is followed',
    );
    const pad = p.getByTestId('joystick');
    check(
      await pad.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      ),
      'phone: the pad shows with nothing selected',
    );
    await sleep(1500);
    await shot(p, 'phone-1-follow');
    const box = (await pad.boundingBox())!;
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await phone.newCDPSession(p);
    const drag = async (dx: number, dy: number, holdMs: number) => {
      const pt = (x: number, y: number) => [{ x, y, id: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(c.x, c.y) });
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: pt(c.x + (dx * i) / 6, c.y + (dy * i) / 6),
        });
        await sleep(16);
      }
      await sleep(holdMs);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const pStart = (await tileOf(p))!;
    await drag(40, 0, 900);
    await sleep(500);
    const pRight = (await tileOf(p))!;
    check(
      pRight.col > pStart.col,
      `phone: the pad walks it right (${pStart.col} to ${pRight.col})`,
    );
    const pDiag = await trail(p, async () => {
      await drag(30, -30, 700);
      await drag(-30, 30, 700);
    });
    console.log(`  phone diagonal trail ${fmt(pDiag)}`);
    check(hasDiagonal(pDiag), 'phone: a diagonal drag walks a diagonal');
    await shot(p, 'phone-2-walked');

    await p.getByTestId('camera-toggle').tap();
    await sleep(300);
    const pBefore = { tile: (await tileOf(p))!, pan: await panOf(p) };
    await drag(40, 0, 900);
    await sleep(500);
    const pAfter = { tile: (await tileOf(p))!, pan: await panOf(p) };
    check(pAfter.pan.x !== pBefore.pan.x, 'phone free: the pad pans the camera');
    check(pAfter.tile.col === pBefore.tile.col, 'phone free: the character stays');
    await shot(p, 'phone-3-free');
    await p.getByTestId('owner-follow').tap();
    check(
      await until('following again', async () => (await followOf(p)) === OWNER),
      "phone: '내 캐릭터' follows it again",
    );
    await sleep(1500);
    await shot(p, 'phone-4-back');
    await cdp.detach();
    const phoneVideo = await p.video()!.path();
    await phone.close();

    check(pageErrors.length === 0, `no page errors ${pageErrors.join(' | ')}`);
    encode(deskVideo, 'owner-avatar-desktop', 480);
    encode(phoneVideo, 'owner-avatar-phone', 240);
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
