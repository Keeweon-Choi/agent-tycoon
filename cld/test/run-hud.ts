/**
 * T-0077 check: floating icons instead of menu buttons, and windows and widgets
 * (U-29: no longer movable or resizable by the user: the checks below that used to
 * drag now assert that dragging, resizing and the size menu do nothing, and that a
 * saved free placement is ignored; the presets still place things). dist/cli.js with the S-8 fake office, --allow-chat and
 * --allow-terminal in an isolated HOME on a spare port, headless Chromium
 * (--disable-gpu, through the shared harness).
 *
 * Desktop 1280x800: no "현황판 열기" text button; the six icons (현황판, 작업실, 메신저,
 * 알림, 터미널, 파일) are square buttons in a column at the right edge; each opens its
 * window; a fresh desktop shows icons only, opening and closing 현황판 survives reload;
 * a window dragged by its title bar moves, a corner drag resizes it, a
 * reload keeps the rect, a narrower viewport keeps it on screen; an icon dragged
 * stays where it was dropped after a reload, a plain click still opens; a size
 * step (right-click menu) scales an icon and is remembered; the messenger's
 * 터미널로 보기 is an icon button with that accessible name; 설정's 화면 배치
 * 초기화 puts everything back. Negative control: with the stored layout key
 * removed the positions return to the defaults.
 * Phone 393x852 (owner 10-24): no bottom tab bar; the icons are the Dock, one row under
 * the card bar, outside the pages; each opens a full-screen page and the Dock stays on
 * it; a long press neither drags nor opens a size menu; 화면 배치 초기화 still clears.
 * (The Dock's switching and restoring in full: run-mobile-dock.ts.)
 * Screenshots go to cld/artifacts/t0077/.
 *
 * T-0111 (second half, screenshots in cld/artifacts/t0111/): a dragged window and a
 * dragged icon land on the 8 px grid and stick to the screen's and another window's
 * edge within 12 px (negative control: Alt held = free, so the dragged position is NOT
 * on the grid); a resize snaps its moved edges; the three presets in 설정 (오른쪽 세로,
 * 아래 가로, 작업용) put icons and windows where they say; the bottom row stays horizontally
 * centred at 1280x800 and 1920x1080 after a desktop resize; each window has 최소화 and
 * 최대화 buttons, a minimized window is shown only by its icon staying lit (aria-label
 * "… (최소화됨)") and a click on that icon restores it with its size and place, a minimized
 * terminal keeps its shell (pid unchanged), maximize fills the office area and 원래 크기
 * gives the rect back, a reload keeps a maximized window; the same on the phone's pages. (The growing message box is checked in
 * run-messenger.ts: this runner's fake office has no lead that can be written to.)
 *
 *   npx tsx cld/test/run-hud.ts <port 18256-18259>
 */
import type { Locator, Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { findTmux, Tmux } from '../../server/src/cld/shell/tmux.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { defaultWindowPlace, EDGE_GAP_PX, ICON_COLUMN_PX, RAIL_PX } from '../../webview-ui/src/cld/hud/layout.js';

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0077');
const OUT2 = path.join(REPO_ROOT, 'cld/artifacts/t0111');
// Shells run in a tmux server of this run's own (never the host's cld-gui-shell).
const TMUX_SOCKET = `cld-test-${randomBytes(6).toString('hex')}`;
const tmuxBin = findTmux();
const testTmux = tmuxBin ? new Tmux(tmuxBin, TMUX_SOCKET) : null;
const KEY = 'cld.hud.layout.v1';
const DEADLINE_MS = 300_000;
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
const nearBox = (a: Box, b: Box, tol = 2) =>
  near(a.x, b.x, tol) &&
  near(a.y, b.y, tol) &&
  near(a.width, b.width, tol) &&
  near(a.height, b.height, tol);
const fmt = (b: Box) =>
  `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox();
  if (!b) throw new Error('not visible');
  return b;
}
const center = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** The mouse pressed at `from`, moved in steps, released at `to`. */
async function mouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/** U-38: every title-bar button of window `id` is on screen and is what a click at its middle hits. */
async function titleBarReachable(page: Page, id: string): Promise<string | null> {
  return page.evaluate((windowId) => {
    const bar = document.querySelector(`[data-testid="hud-title-${windowId}"]`);
    if (!bar) return 'no title bar';
    const buttons = [...bar.querySelectorAll('button')];
    if (buttons.length < 3) return `only ${buttons.length} buttons`;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const b of [bar, ...buttons]) {
      const r = b.getBoundingClientRect();
      if (r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh)
        return `${b.getAttribute('aria-label') ?? 'title bar'} is off screen`;
    }
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit?.closest('button') !== b) return `${b.getAttribute('aria-label')} is covered`;
    }
    return null;
  }, id);
}

/** A finger: down, held `holdMs`, moved in steps, up (CDP touch events). */
async function touchHoldDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number } | null,
  holdMs: number,
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  await page.waitForTimeout(holdMs);
  if (to) {
    for (let k = 1; k <= 12; k++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: from.x + ((to.x - from.x) * k) / 12, y: from.y + ((to.y - from.y) * k) / 12 },
        ],
      });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT2, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  fs.mkdirSync(path.join(fake.home, 'work'));
  const daemon = startDaemon(fake, port, ['--allow-chat', '--allow-terminal'], {
    SHELL: '/bin/sh',
    CLD_GUI_SHELL_TMUX_SOCKET: TMUX_SOCKET,
  });
  const deadline = setTimeout(() => {
    console.error('deadline: stopping');
    void daemon.stop().then(() => process.exit(2));
  }, DEADLINE_MS);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__name = (f: unknown) => f;
        // Upstream's read-only test hooks (chatOpenFor: what notices count as looked at).
        (window as unknown as Record<string, unknown>).__PIXEL_AGENTS_E2E = true;
      });
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(BASE);
      await page.locator('[data-testid="office-canvas"]').waitFor();
      // A phone has the Dock instead of the HUD layer (10-24).
      await page.locator('[data-hud-layer], [data-testid="mobile-dock"]').first().waitFor();
      return { ctx, page };
    };
    const reload = async (page: Page) => {
      await page.reload();
      await page.locator('[data-testid="office-canvas"]').waitFor();
      // A phone has the Dock instead of the HUD layer (10-24).
      await page.locator('[data-hud-layer], [data-testid="mobile-dock"]').first().waitFor();
      await page.waitForTimeout(500);
    };
    const shot = (page: Page, name: string) =>
      page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const shot2 = (page: Page, name: string) =>
      page.screenshot({ path: path.join(OUT2, `${name}.png`) });
    const stored = (page: Page) =>
      page.evaluate((k) => localStorage.getItem(k), KEY) as Promise<string | null>;
    /** How many positions/sizes the stored layout holds (the open-window flags live beside them and survive a reset). */
    const storedItems = async (page: Page) =>
      Object.keys(JSON.parse((await stored(page)) ?? '{}').items ?? {}).length;
    const icon = (page: Page, name: string | RegExp) =>
      page.locator('[data-hud-id^="icon:"]').getByRole('button', { name });
    const win = (page: Page, id: string) => page.locator(`[data-hud-window="${id}"]`);
    const settings = async (page: Page) => {
      await page.getByRole('button', { name: '설정', exact: true }).click();
      // SETTINGS-TABS: the layout reset is in the 화면 tab (the tab is remembered per browser).
      await page.getByRole('tab', { name: '화면', exact: true }).click();
      return page.getByRole('button', { name: '화면 배치 초기화' });
    };

    // ════ Desktop ════
    const desk = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = desk.page;
    await page.waitForTimeout(800);

    check(
      (await page.getByRole('button', { name: '현황판 열기' }).count()) === 0,
      'no "현황판 열기" text button',
    );
    check(
      (await page.getByRole('navigation', { name: '모바일 사무실 메뉴' }).count()) === 0,
      'no tab bar on a desktop',
    );
    const names = ['현황판', '작업실', '메신저', '알림', '터미널', '파일'] as const;
    const defaults: Record<string, Box> = {};
    for (const name of names) {
      const button = icon(page, new RegExp(`^${name}`));
      await button.waitFor();
      defaults[name] = await box(button);
      check(
        (await button.getAttribute('title')) === name &&
          (await button.locator('svg').count()) === 1,
        `${name}: an icon button with that name as its title, one glyph, no text`,
      );
    }
    const layer = await box(page.locator('[data-hud-layer]'));
    const lefts = names.map((n) => defaults[n].x);
    check(
      names.every((n) => near(defaults[n].width, defaults[n].height, 1)) &&
        lefts.every((x) => near(x, lefts[0], 1)) &&
        // The card bar rail is RAIL_PX wide now (120, TOPBAR-CARDS); the icons sit one edge gap left of it.
        near(lefts[0] + defaults['현황판'].width, layer.x + layer.width - RAIL_PX - EDGE_GAP_PX, 2) &&
        names.every((n, i) => i === 0 || defaults[n].y > defaults[names[i - 1]].y),
      `the six icons are squares in a column at the right edge, clear of the card bar (${names.map((n) => fmt(defaults[n])).join(' | ')})`,
    );

    const officeWin = win(page, 'office');
    check(
      (await page.locator('[data-hud-window]:visible').count()) === 0,
      'fresh desktop: six floating icons (작업실 since W1, 파일 since 10-24) and no open window',
    );
    await shot(page, 'desktop-before');
    await icon(page, '현황판').click();
    await officeWin.waitFor();
    const officeDefault = await box(officeWin);
    check(
      officeDefault.x + officeDefault.width <= defaults['현황판'].x &&
        near(officeDefault.y, layer.y + 4, 2),
      `현황판 icon opens beside the icon column (${fmt(officeDefault)})`,
    );
    await reload(page);
    await win(page, 'office').waitFor();
    check(true, 'an open 현황판 window is restored after reload');
    await page.getByRole('button', { name: '정보 창 닫기' }).click();
    await reload(page);
    check(
      (await page.locator('[data-hud-window]:visible').count()) === 0,
      'a closed 현황판 stays closed after reload',
    );
    await shot(page, 'desktop-window-default');

    // Each icon opens its window.
    await icon(page, '현황판').click();
    await officeWin.waitFor();
    check(
      (
        await officeWin
          .getByRole('navigation', { name: '사무실 메뉴' })
          .getByRole('button')
          .allTextContents()
      )
        .join(',')
        .includes('현황판') &&
        (await officeWin
          .getByRole('navigation', { name: '사무실 메뉴' })
          .getByRole('button', { name: '터미널' })
          .count()) === 0,
      '현황판 icon: the window with 현황판, HW, 작업, Codex, 파일 tabs and no 터미널 tab',
    );
    await icon(page, /^메신저/).click();
    await page.getByRole('region', { name: '메신저', exact: true }).waitFor();
    check((await win(page, 'messenger').count()) === 1, '메신저 icon: the messenger window');
    // 터미널로 보기 is an icon button.
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await messenger
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: /^delta/ })
      .click();
    const attach = messenger
      .getByRole('region', { name: 'delta-orchestrator 대화' })
      .getByRole('button', { name: '터미널로 보기' });
    await attach.waitFor();
    check(
      (await attach.locator('svg').count()) === 1 &&
        (await attach.innerText()).trim() === '' &&
        (await attach.getAttribute('title'))?.startsWith('터미널로 보기') === true,
      '메신저: 터미널로 보기 is a terminal icon button (accessible name 터미널로 보기, no text)',
    );
    await icon(page, /^알림/).click();
    await page.getByTestId('notice-panel').waitFor();
    check((await win(page, 'notices').count()) === 1, '알림 icon: the notice list window');
    await icon(page, /^터미널/).click();
    await win(page, 'terminal').waitFor();
    await win(page, 'terminal')
      .getByRole('button', { name: '터미널 추가' })
      .first()
      .waitFor({ timeout: 15_000 });
    check(true, '터미널 icon: the terminal window (the T-0078 workspace: 터미널 추가)');
    // U-28: a click on a <canvas> that belongs to a panel (the cards' mug shots) over the lobby
    // board must not open the board: only the office canvas itself counts.
    const boardEl = page.locator('[data-testid="lobby-board"]');
    if (await boardEl.count()) {
      const bb = await box(boardEl);
      const tw = await box(win(page, 'terminal'));
      const px = Math.max(bb.x, tw.x) + 60;
      const py = Math.min(bb.y + bb.height / 2, 760);
      if (px < tw.x + tw.width && py > tw.y && py < tw.y + tw.height) {
        await win(page, 'terminal').evaluate(
          (el, [x, y]) => {
            const c = document.createElement('canvas');
            c.setAttribute('data-testid', 'panel-canvas');
            c.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:40px;height:40px;z-index:50`;
            el.appendChild(c);
          },
          [px - tw.x, py - tw.y],
        );
        await page.mouse.click(px + 5, py + 5);
        await page.waitForTimeout(600);
        check(
          (await page.locator('[data-testid="board-full"]').count()) === 0,
          'U-28: a click on a panel canvas over the board does not open the board',
        );
        await win(page, 'terminal')
          .locator('[data-testid="panel-canvas"]')
          .evaluate((c) => c.remove());
      }
    }

    await win(page, 'terminal').getByRole('button', { name: '터미널 창 닫기' }).click();
    await win(page, 'notices').getByRole('button', { name: '알림 닫기' }).click();
    check(
      !(await win(page, 'terminal').isVisible()) && (await win(page, 'notices').count()) === 0,
      '× closes a window',
    );
    // The terminal window is hidden, not unmounted: the shells' sockets and tabs live on.
    check(
      (await win(page, 'terminal').count()) === 1 &&
        (await win(page, 'terminal').locator('[aria-label="터미널 추가"]').count()) >= 1,
      '터미널: closed, its content stays mounted (hidden)',
    );
    // 터미널로 보기 (T-0078) asks for the terminal window with one event.
    await page.evaluate(() => window.dispatchEvent(new Event('cld-open-terminal-tab')));
    await win(page, 'terminal').waitFor({ state: 'visible' });
    check(true, 'the cld-open-terminal-tab event opens the terminal window');
    // 터미널로 보기 itself: delta's tab in the window. Closed (hidden, still mounted), the window
    // must not count as looking at delta, or delta's notices are dropped as already seen.
    await page.getByTestId('hud-title-messenger').click({ position: { x: 20, y: 10 } });
    await attach.click();
    await win(page, 'terminal').getByRole('tab', { name: /delta/ }).waitFor();
    await win(page, 'messenger').getByRole('button', { name: '메신저 닫기' }).click();
    const looking = () =>
      page.evaluate(() => {
        const h = (
          window as unknown as {
            __pixelAgentsTestHooks?: {
              getCharacters?: () => Array<{ id: number }>;
              chatOpenFor?: (id: number) => boolean;
            };
          }
        ).__pixelAgentsTestHooks;
        return (h?.getCharacters?.() ?? []).filter((c) => h?.chatOpenFor?.(c.id)).length;
      });
    const seen = await looking();
    check(seen === 1, `터미널로 보기: delta's tab is on screen (looked at: ${seen})`);
    await win(page, 'terminal').getByRole('button', { name: '터미널 창 닫기' }).click();
    check(
      (await looking()) === 0,
      'the terminal window closed (kept mounted): no character counts as looked at',
    );
    await icon(page, /^메신저/).click();
    await win(page, 'messenger').waitFor();
    await icon(page, /^터미널/).click();
    await icon(page, /^알림/).click();
    await win(page, 'notices').waitFor();
    // The last one touched is on top.
    await officeWin
      .locator('[data-testid="hud-title-office"]')
      .click({ position: { x: 20, y: 10 } });
    const z = (id: string) => win(page, id).evaluate((el) => Number(getComputedStyle(el).zIndex));
    check(
      (await z('office')) > (await z('notices')) && (await z('office')) > (await z('terminal')),
      'the last window touched is on top',
    );
    await shot(page, 'desktop-windows-open');
    for (const [id, label] of [
      ['terminal', '터미널 창 닫기'],
      ['notices', '알림 닫기'],
      ['messenger', '메신저 닫기'],
    ] as const) {
      // A window under another is raised first (a touch of its title bar), then closed.
      await page.getByTestId(`hud-title-${id}`).click({ position: { x: 20, y: 10 } });
      await win(page, id).getByRole('button', { name: label }).click();
    }

    // U-38: the four windows move and resize (the icons and widgets below stay fixed, U-29).
    const before = await box(officeWin);
    const title = await box(page.getByTestId('hud-title-office'));
    await mouseDrag(
      page,
      { x: title.x + 30, y: title.y + title.height / 2 },
      { x: title.x + 30 - 300, y: title.y + title.height / 2 - 20 },
    );
    const moved = await box(officeWin);
    check(
      near(moved.x, before.x - 300, 14) && moved.y <= before.y,
      `a window dragged by its title bar moves (${fmt(before)} -> ${fmt(moved)})`,
    );
    check(
      (await officeWin.locator('[data-handle]').count()) === 8,
      'a window has its 8 resize handles',
    );
    await shot(page, 'desktop-window-moved');
    const sizeBefore = await box(officeWin);
    const se = await box(officeWin.locator('[data-handle="se"]'));
    await mouseDrag(page, center(se), { x: center(se).x - 80, y: center(se).y - 60 });
    const sized = await box(officeWin);
    check(
      near(sized.width, sizeBefore.width - 80, 14) &&
        near(sized.height, sizeBefore.height - 60, 14),
      `a corner drag resizes it (${fmt(sizeBefore)} -> ${fmt(sized)})`,
    );
    check((await storedItems(page)) === 1, 'the moved window is stored (only the window)');
    await reload(page);
    await win(page, 'office').waitFor();
    check(nearBox(await box(win(page, 'office')), sized, 1), 'a reload keeps the window rect');
    // The title bar and its buttons stay reachable wherever it is thrown.
    const throwTo: Array<[string, number, number]> = [
      ['far top-left', -3000, -3000],
      ['far bottom-right', 3000, 3000],
      ['far right', 3000, 0],
      ['far bottom', 0, 3000],
    ];
    for (const [where, dx, dy] of throwTo) {
      const t = await box(page.getByTestId('hud-title-office'));
      const grab = { x: t.x + 30, y: t.y + t.height / 2 };
      await mouseDrag(page, grab, {
        x: Math.min(1279, Math.max(0, grab.x + dx)),
        y: Math.min(799, Math.max(0, grab.y + dy)),
      });
      check(
        (await titleBarReachable(page, 'office')) === null,
        `thrown ${where}: the title bar and _ □ × are on screen and clickable (${await titleBarReachable(page, 'office')})`,
      );
    }
    await shot(page, 'desktop-window-thrown');
    // A saved place far outside the screen loads pulled in, and a smaller browser window pulls it in too.
    await page.evaluate(
      ([k]) => {
        const v = JSON.parse(localStorage.getItem(k) ?? '{}');
        v.items.office = { place: { corner: 'tl', dx: 4000, dy: 3000, w: 900, h: 700 } };
        localStorage.setItem(k, JSON.stringify(v));
      },
      [KEY],
    );
    await reload(page);
    await win(page, 'office').waitFor();
    check(
      (await titleBarReachable(page, 'office')) === null,
      'a saved place outside the screen: loaded with the title bar reachable',
    );
    await page.setViewportSize({ width: 900, height: 560 });
    await page.waitForTimeout(400);
    // WINDOW-LAYERS (owner 10-25): a window may sit under the card bar and icon column; what always
    // stays free is a part of its title bar to grab, so the buttons need not all be clickable here.
    const grab = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="hud-title-office"]')!.getBoundingClientRect();
      const free = document.elementFromPoint(bar.left + 20, bar.top + bar.height / 2);
      return {
        onScreen: bar.left >= 0 && bar.top >= 0 && bar.right <= window.innerWidth + 1 && bar.bottom <= window.innerHeight,
        grabbable: !!free?.closest('[data-testid="hud-title-office"]'),
      };
    });
    check(
      grab.onScreen && grab.grabbable,
      'a smaller browser window: the title bar is pulled back in, a part of it free to grab',
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    check(
      (await titleBarReachable(page, 'office')) === null,
      'the browser window grown back: still reachable',
    );
    // Back to the default place for the checks that follow.
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
    await reload(page);

    // Icons: a drag moves nothing, a click still opens.
    const bell = icon(page, /^알림/);
    const bellFrom = await box(bell);
    await mouseDrag(page, center(bellFrom), {
      x: center(bellFrom).x - 420,
      y: center(bellFrom).y + 260,
    });
    check(
      nearBox(await box(icon(page, /^알림/)), bellFrom, 1),
      `an icon dragged on a desktop stays in its column (${fmt(bellFrom)})`,
    );
    await icon(page, /^알림/).click();
    await win(page, 'notices').waitFor();
    check(true, 'a plain click on an icon still opens its window');
    await win(page, 'notices').getByRole('button', { name: '알림 닫기' }).click();

    // No size menu.
    await icon(page, /^메신저/).click({ button: 'right' });
    check(
      (await page.getByRole('group', { name: '메신저 크기' }).count()) === 0,
      'a right click on an icon opens no size menu',
    );
    await page.keyboard.press('Escape');

    // The usage bar does not move either.
    const usage = page.locator('[data-hud-id="usage"]');
    const usageFrom = await box(usage);
    await mouseDrag(
      page,
      { x: usageFrom.x + usageFrom.width - 6, y: usageFrom.y + 6 },
      { x: usageFrom.x + usageFrom.width - 6 - 200, y: usageFrom.y + 6 + 300 },
    );
    check(nearBox(await box(usage), usageFrom, 1), 'the usage bar cannot be dragged');
    await shot(page, 'desktop-fixed');

    // A free placement of an icon or widget saved by an older version is ignored (a window's is kept).
    await page.evaluate(
      ([k, v]) => localStorage.setItem(k, v),
      [
        KEY,
        JSON.stringify({
          v: 1,
          items: {
            'icon:notices': { place: { corner: 'tl', dx: 40, dy: 40 }, scale: 2 },
            office: { place: { corner: 'tl', dx: 5, dy: 5, w: 400, h: 300 } },
            usage: { place: { corner: 'tl', dx: 100, dy: 500 } },
          },
        }),
      ],
    );
    await reload(page);
    check(
      nearBox(await box(icon(page, /^알림/)), defaults['알림'], 2) &&
        nearBox(await box(usage), usageFrom, 2),
      'a saved free placement of icons and widgets is ignored: they sit at the preset layout',
    );
    // 화면 배치 초기화 clears it from storage too.
    const reset = await settings(page);
    await reset.click();
    await page.getByRole('button', { name: 'x', exact: true }).click(); // the dialog's close
    await page.waitForTimeout(400);
    check((await storedItems(page)) === 0, '화면 배치 초기화 clears the stored layout');
    // A corrupt value is the defaults too.
    await page.evaluate((k) => localStorage.setItem(k, '{"v":1,"items":'), KEY);
    await reload(page);
    check(
      nearBox(await box(icon(page, /^알림/)), defaults['알림'], 2),
      'a corrupt stored value gives the defaults',
    );
    check(
      (await page.locator('[data-hud-window]:visible').count()) === 0,
      'a missing or corrupt stored value opens no window either (icons only)',
    );
    await shot(page, 'desktop-after-reset');

    // ════ T-0111 desktop: snapping, presets, minimize, maximize ════
    const OUT_SHOT = (page_: Page, name: string) =>
      page_.screenshot({ path: path.join(OUT2, `${name}.png`) });
    const layerBox = () => box(page.locator('[data-hud-layer]'));
    /** A box in the layer's own coordinates (the grid's origin). */
    const inLayer = (b: Box, l: Box) => ({ x: b.x - l.x, y: b.y - l.y, w: b.width, h: b.height });
    const onGrid = (n: number) => Math.abs(n - Math.round(n / 8) * 8) < 0.6;
    const CLOSE: Record<string, string> = {
      office: '정보 창 닫기',
      messenger: '메신저 닫기',
      notices: '알림 닫기',
      terminal: '터미널 창 닫기',
    };
    const closeAll = async () => {
      for (const id of Object.keys(CLOSE)) {
        if (!(await win(page, id).isVisible())) continue;
        await page.getByTestId(`hud-title-${id}`).click({ position: { x: 20, y: 10 } });
        await win(page, id).getByRole('button', { name: CLOSE[id] }).click();
      }
    };
    const setLayout = async (items: object) => {
      await page.evaluate(
        ([k, v]) => localStorage.setItem(k, v),
        [KEY, JSON.stringify({ v: 1, items })],
      );
      await reload(page);
      await closeAll();
    };
    const zOf = (id: string) => win(page, id).evaluate((el) => Number(getComputedStyle(el).zIndex));

    // ── Windows move, icons do not (U-29, U-38) ──
    await setLayout({
      office: { place: { corner: 'tl', dx: 125, dy: 109, w: 403, h: 301 } },
      messenger: { place: { corner: 'tl', dx: 600, dy: 109, w: 300, h: 301 } },
    });
    await icon(page, '현황판').click();
    await icon(page, /^메신저/).click();
    await win(page, 'office').waitFor();
    await win(page, 'messenger').waitFor();
    let L = await layerBox();
    const dragTitle = async (id: string, dx: number, dy: number) => {
      const t = await box(page.getByTestId(`hud-title-${id}`));
      await mouseDrag(
        page,
        { x: t.x + t.width - 150, y: t.y + t.height / 2 },
        { x: t.x + t.width - 150 + dx, y: t.y + t.height / 2 + dy },
      );
    };
    const officeRect = async () => inLayer(await box(win(page, 'office')), L);
    const start = await officeRect();
    check(
      near(start.x, 125, 1) && near(start.y, 109, 1) && near(start.w, 403, 1),
      `a stored window place is used: the window opens there (${start.x},${start.y} ${start.w}x${start.h})`,
    );
    await dragTitle('office', 37, 29);
    const snapped = await officeRect();
    check(
      onGrid(snapped.x) &&
        onGrid(snapped.y) &&
        near(snapped.x, 125 + 37, 12) &&
        near(snapped.y, 109 + 29, 12),
      `a window dragged by its title bar lands on the 8 px grid (${snapped.x},${snapped.y})`,
    );
    await page.keyboard.down('Alt');
    await dragTitle('office', 23, 3);
    await page.keyboard.up('Alt');
    const freed = await officeRect();
    check(
      near(freed.x, snapped.x + 23, 1) && near(freed.y, snapped.y + 3, 1),
      `Alt moves it freely, off the grid (${freed.x},${freed.y})`,
    );
    const bellBox = await box(icon(page, /^알림/));
    await mouseDrag(page, center(bellBox), {
      x: center(bellBox).x + (L.x + 301 - bellBox.x),
      y: center(bellBox).y + (L.y + 563 - bellBox.y),
    });
    check(
      nearBox(await box(icon(page, /^알림/)), bellBox, 1),
      'an icon dragged across the screen stays where it is',
    );
    await OUT_SHOT(page, 'desktop-fixed');

    // ── Presets ──
    const choose = async (name: string) => {
      await settings(page);
      await page.getByRole('group', { name: '배치 프리셋' }).getByRole('button', { name }).click();
      await page.getByRole('button', { name: 'x', exact: true }).click();
      await page.waitForTimeout(500);
    };
    await choose('아래 가로');
    L = await layerBox();
    const row: Box[] = [];
    for (const n of names) row.push(await box(icon(page, new RegExp(`^${n}`))));
    const stripTop = L.y + L.height - 48;
    check(
      row.every((b) => near(b.y, row[0].y, 1)) &&
        row.every((b) => b.y >= stripTop - 0.5 && b.y + b.height <= L.y + L.height + 0.5) &&
        row.every((b, i) => i === 0 || near(b.x - row[i - 1].x, 48, 1)) &&
        near((row[0].x + row.at(-1)!.x + row.at(-1)!.width) / 2, L.x + L.width / 2, 8),
      `아래 가로: the six icons are one row at the bottom centre, in the bottom strip (${row.map(fmt).join(' | ')})`,
    );
    const checkBottomDockCentre = async (viewport: { width: number; height: number }) => {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(300);
      const windowCentre = viewport.width / 2;
      const dock: Box[] = [];
      for (const n of names) dock.push(await box(icon(page, new RegExp(`^${n}`))));
      const dockCentre = (dock[0].x + dock.at(-1)!.x + dock.at(-1)!.width) / 2;
      check(
        Math.abs(dockCentre - windowCentre) <= 8,
        `아래 가로 ${viewport.width}x${viewport.height}: |dock centre ${Math.round(
          dockCentre,
        )} - window centre ${Math.round(windowCentre)}| <= 8 px`,
      );
    };
    await checkBottomDockCentre({ width: 1280, height: 800 });
    await checkBottomDockCentre({ width: 1920, height: 1080 });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    L = await layerBox();
    await win(page, 'office').waitFor({ state: 'visible' });
    // WINDOW-LAYERS (owner 10-25): a window has the whole room; the icon row draws over its bottom.
    check(
      (await box(win(page, 'office'))).y + (await box(win(page, 'office'))).height <=
        L.y + L.height + 0.5,
      '아래 가로: the windows stay inside the room (the icon row is drawn over them)',
    );
    await OUT_SHOT(page, 'desktop-preset-bottom');
    await choose('작업용');
    L = await layerBox();
    const room = L.width - RAIL_PX - ICON_COLUMN_PX - EDGE_GAP_PX; // the preset's room (layout.ts)
    const mRect = inLayer(await box(win(page, 'messenger')), L);
    const tRect = inLayer(await box(win(page, 'terminal')), L);
    check(
      (await win(page, 'messenger').isVisible()) &&
        (await win(page, 'terminal').isVisible()) &&
        !(await win(page, 'office').isVisible()),
      '작업용: the messenger and the terminal are open, 현황판 is closed',
    );
    check(
      near(mRect.x, 8, 1) &&
        near(mRect.w, Math.round(room / 3 / 8) * 8 - 8, 2) &&
        near(tRect.x + tRect.w, room, 1) &&
        near(tRect.w, Math.round(room / 2 / 8) * 8, 2) &&
        mRect.x + mRect.w < tRect.x &&
        near(mRect.y, 8, 1) &&
        near(mRect.h, L.height - 48 - 16, 2),
      `작업용: the messenger on the left third (${mRect.x},${mRect.y} ${mRect.w}x${mRect.h}), the terminal on the right half (${tRect.x},${tRect.y} ${tRect.w}x${tRect.h})`,
    );
    for (const n of names)
      check(
        nearBox(await box(icon(page, new RegExp(`^${n}`))), defaults[n], 2),
        `작업용: the ${n} icon is in the right-hand column`,
      );
    await OUT_SHOT(page, 'desktop-preset-work');
    await choose('오른쪽 세로');
    const mDef = inLayer(await box(win(page, 'messenger')), L);
    const tDef = inLayer(await box(win(page, 'terminal')), L);
    // The default places come from layout.ts (the rail is RAIL_PX wide now, so they are no longer 164 / 220 px).
    const mPlace = defaultWindowPlace('messenger', { w: L.width, h: L.height });
    const tPlace = defaultWindowPlace('terminal', { w: L.width, h: L.height });
    check(
      near(mDef.x + mDef.w, L.width - mPlace.dx, 1) &&
        near(tDef.x + tDef.w, L.width - tPlace.dx, 1) &&
        near(mDef.y, mPlace.dy, 1),
      `오른쪽 세로: the windows are back at their default places (${mDef.x + mDef.w}, ${tDef.x + tDef.w} from the left)`,
    );
    for (const n of names)
      check(
        nearBox(await box(icon(page, new RegExp(`^${n}`))), defaults[n], 2),
        `오른쪽 세로: the ${n} icon is back at its default`,
      );

    // ── Minimize, maximize ──
    const termIcon = icon(page, /^터미널/);
    check(
      (await termIcon.getAttribute('aria-pressed')) === 'true' &&
        (await termIcon.getAttribute('aria-label')) === '터미널' &&
        (await page.locator('[data-testid="hud-taskbar"]').count()) === 0,
      'an open window lights its icon with the plain name, and there is no taskbar',
    );
    // A shell in the terminal window, then minimize: the window goes, the shell stays.
    const term = win(page, 'terminal');
    await term.getByRole('button', { name: '터미널 추가' }).first().click();
    await page.getByRole('menuitem', { name: '새 터미널' }).click();
    const picker = page
      .getByRole('dialog')
      .filter({ hasText: '폴더 고르기' })
      .or(page.locator('[aria-label="폴더 고르기"]'))
      .first();
    await picker.waitFor();
    await page.locator('ul[aria-label="하위 폴더"] button', { hasText: /^▸ work$/ }).click();
    await page.getByRole('button', { name: '이 폴더 선택' }).click();
    const pane = page.locator('[data-testid="terminal-pane"]:not(.hidden)').first();
    await pane.locator('.xterm-rows').waitFor({ timeout: 20_000 });
    const pidFile = (name: string) => path.join(fake.home, `pid-${name}`);
    const readPid = (name: string) => {
      try {
        return fs.readFileSync(pidFile(name), 'utf8').trim();
      } catch {
        return '';
      }
    };
    const pidIn = async (name: string) => {
      for (const end = Date.now() + 40_000; Date.now() < end; await page.waitForTimeout(1_500)) {
        if (/^\d+$/.test(readPid(name))) return readPid(name);
        await pane.locator('.xterm-helper-textarea').focus();
        await page.keyboard.type(`echo $$ > ${pidFile(name)}`);
        await page.keyboard.press('Enter');
      }
      throw new Error(`no pid from shell ${name}`);
    };
    const pidBefore = await pidIn('before');
    const termOpenBox = await box(term);
    await term.getByRole('button', { name: '최소화' }).click();
    check(
      !(await term.isVisible()) &&
        (await win(page, 'terminal').count()) === 1 &&
        (await termIcon.getAttribute('aria-pressed')) === 'true' &&
        (await termIcon.getAttribute('aria-label')) === '터미널 (최소화됨)',
      '최소화 hides the terminal (still mounted); its icon stays lit and is named 터미널 (최소화됨)',
    );
    check(
      fs.existsSync(`/proc/${pidBefore}`),
      `the shell (pid ${pidBefore}) is still running while minimized`,
    );
    await OUT_SHOT(page, 'desktop-minimized');
    await termIcon.click();
    await term.waitFor({ state: 'visible' });
    const pidAfter = await pidIn('after');
    check(
      pidAfter === pidBefore &&
        (await zOf('terminal')) > (await zOf('messenger')) &&
        nearBox(await box(term), termOpenBox, 1) &&
        (await termIcon.getAttribute('aria-label')) === '터미널',
      `a click on the icon restores it on top with its size and place, and its shell is the same one (pid ${pidBefore} -> ${pidAfter})`,
    );
    // The messenger, minimized from its own button: same icon rules.
    const messengerOpenBox = await box(win(page, 'messenger'));
    await win(page, 'messenger').getByRole('button', { name: '최소화' }).click();
    const messengerIcon = icon(page, /^메신저/);
    check(
      !(await win(page, 'messenger').isVisible()) &&
        (await messengerIcon.getAttribute('aria-pressed')) === 'true' &&
        /\(최소화됨\)$/.test((await messengerIcon.getAttribute('aria-label')) ?? ''),
      'the messenger minimized: hidden, its icon stays lit with the minimized name (any unread count kept)',
    );
    await messengerIcon.click();
    check(
      (await win(page, 'messenger').isVisible()) &&
        nearBox(await box(win(page, 'messenger')), messengerOpenBox, 1) &&
        (await zOf('messenger')) > (await zOf('terminal')),
      'its icon brings a minimized messenger back on top, same size and place, instead of closing it',
    );
    // 현황판 and 알림: the same, from a fresh open.
    for (const [id, name, plain] of [
      ['office', /^현황판/, '현황판'],
      ['notices', /^알림/, '알림'],
    ] as const) {
      await icon(page, name).click();
      await win(page, id).waitFor({ state: 'visible' });
      const was = await box(win(page, id));
      await win(page, id).getByRole('button', { name: '최소화' }).click();
      const label = (await icon(page, name).getAttribute('aria-label')) ?? '';
      check(
        !(await win(page, id).isVisible()) &&
          (await icon(page, name).getAttribute('aria-pressed')) === 'true' &&
          label.startsWith(plain) &&
          label.endsWith('(최소화됨)'),
        `${plain}: 최소화 hides the window; the icon stays lit and is named "${label}"`,
      );
      await icon(page, name).click();
      await win(page, id).waitFor({ state: 'visible' });
      check(
        nearBox(await box(win(page, id)), was, 1) &&
          !((await icon(page, name).getAttribute('aria-label')) ?? '').includes('(최소화됨)'),
        `${plain}: a click on the icon restores the window with its size and place`,
      );
      await icon(page, name).click();
      check(
        !(await win(page, id).isVisible()),
        `${plain}: a click on the icon of an open window still closes it`,
      );
    }
    // Maximize.
    L = await layerBox();
    await page.getByTestId('hud-title-terminal').click({ position: { x: 20, y: 10 } }); // to the front
    const termBefore = await box(term);
    await term.getByRole('button', { name: '최대화' }).click();
    const full = await box(term);
    check(
      near(full.x, L.x, 1) &&
        near(full.y, L.y, 1) &&
        // WINDOW-LAYERS (owner 10-25): a maximized window fills the whole room, over the panels.
        near(full.width, L.width, 1) &&
        near(full.height, L.height, 1) &&
        (await term.locator('[data-handle]').count()) === 0 &&
        JSON.parse((await stored(page)) ?? '{}').items?.terminal?.max === true,
      `최대화 fills the whole room, in front of the panels (${fmt(full)}) and is stored`,
    );
    await OUT_SHOT(page, 'desktop-maximized');
    const tt = await box(page.getByTestId('hud-title-terminal'));
    await mouseDrag(page, { x: tt.x + 40, y: tt.y + 8 }, { x: tt.x - 100, y: tt.y + 108 });
    check(nearBox(await box(term), full, 1), 'a maximized window is not dragged');
    await term.getByRole('button', { name: '원래 크기' }).click();
    check(
      nearBox(await box(term), termBefore, 1) &&
        JSON.parse((await stored(page)) ?? '{}').items?.terminal?.max === undefined,
      '원래 크기 gives the previous rect back',
    );
    await page.getByTestId('hud-title-terminal').dblclick({ position: { x: 60, y: 10 } });
    check(nearBox(await box(term), full, 1), 'a double click on the title bar maximizes too');
    await reload(page);
    // T-0108: the open window is remembered too, so the terminal is already there; its icon would close it.
    await term.waitFor({ state: 'visible' });
    check(
      nearBox(await box(term), full, 2),
      'a reload keeps a maximized window open and maximized (the open flag is remembered, T-0108)',
    );
    await term.getByRole('button', { name: '원래 크기' }).click();
    await closeAll();

    check(pageErrors.length === 0, `desktop: no page errors ${JSON.stringify(pageErrors)}`);
    await desk.ctx.close();

    // ════ Phone ════
    const ph = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      userAgent: IPHONE,
    });
    const phone = ph.page;
    await phone.waitForTimeout(1000);
    // T-0097: an iPhone's first visit shows the install hint. It must not float over the top bar
    // (it covered 설정): a dot on 설정 points to it, and the hint is the first row of the 설정 menu.
    const settingsBtn = phone.getByRole('button', { name: '설정', exact: true });
    const hintAt = await settingsBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        reachable: !!top && el.contains(top),
        floating: !!document.querySelector('[role="status"].fixed'),
      };
    });
    check(
      hintAt.reachable && !hintAt.floating,
      'phone: first visit, 설정 is not covered and no install hint floats over the page',
    );
    check(
      (await phone.getByTestId('install-hint-dot').count()) === 1,
      'phone: a dot on 설정 points to the install hint',
    );
    await settingsBtn.tap(); // without dismissing anything first
    const hint = phone.getByTestId('install-hint');
    await hint.waitFor();
    check(
      (await hint.innerText()).includes('홈 화면에 추가'),
      'phone: the install hint is visible in the 설정 menu',
    );
    await hint.getByRole('button', { name: '설치 안내 닫기' }).tap();
    check(
      (await hint.count()) === 0 && (await phone.getByTestId('install-hint-dot').count()) === 0,
      'phone: dismissing the hint removes it and the dot',
    );
    check(
      (await phone.evaluate(() => localStorage.getItem('cld.install-hint-dismissed') === '1')) &&
        (await phone.getByTestId('install-app-option').count()) === 1,
      'phone: the dismissal is stored and the install row stays in 설정',
    );
    await phone.getByRole('button', { name: 'x', exact: true }).tap();
    check(
      (await phone.getByRole('navigation', { name: '모바일 사무실 메뉴' }).count()) === 0,
      'phone: no bottom tab bar',
    );
    const dockNames = ['현황판', '작업실', '메신저', '알림', '터미널', '파일'] as const;
    const pdefaults: Record<string, Box> = {};
    for (const name of dockNames) pdefaults[name] = await box(icon(phone, new RegExp(`^${name}`)));
    const bar = await box(phone.getByTestId('mobile-agent-bar'));
    const rowTops = dockNames.map((n) => pdefaults[n].y);
    check(
      dockNames.every((n) => pdefaults[n].y >= bar.y + bar.height - 1) &&
        rowTops.every((y) => near(y, rowTops[0], 1)) &&
        dockNames.every((n) => pdefaults[n].height >= 44 && pdefaults[n].width >= 44),
      `phone: the icons are the Dock, one row under the card bar (${dockNames.map((n) => fmt(pdefaults[n])).join(' | ')}; bar ${fmt(bar)})`,
    );
    await shot(phone, 'phone-before');
    const page_ = (label: string) => phone.locator(`[aria-label="${label}"]`);
    const dockShows = async () =>
      (await phone.getByTestId('mobile-dock').isVisible()) &&
      nearBox(await box(icon(phone, /^알림/)), pdefaults['알림'], 1);
    await icon(phone, '현황판').tap();
    await page_('현황판 화면').waitFor();
    await shot(phone, 'phone-office');
    // UI-C1: the 현황판 page keeps 현황판 and HW; 파일 is the folder icon's own mode.
    const boardTabs = (
      await page_('현황판 화면')
        .getByRole('navigation', { name: '작업 메뉴' })
        .getByRole('button')
        .allInnerTexts()
    ).map((x) => x.trim());
    check(
      JSON.stringify(boardTabs) === JSON.stringify(['현황판', 'HW']),
      `phone: the 현황판 page has the tabs ${boardTabs.join(' | ')} (파일 is the folder icon's)`,
    );
    await icon(phone, /^파일/).tap();
    await phone.locator('section[aria-label="파일 탐색"]').waitFor();
    check(await dockShows(), 'phone: the folder icon opens the explorer, the Dock stays');
    await icon(phone, '현황판').tap();
    await page_('현황판 화면').getByRole('navigation', { name: '작업 메뉴' }).waitFor();
    await icon(phone, /^메신저/).tap();
    await phone.getByRole('region', { name: '메신저', exact: true }).waitFor();
    check(
      await dockShows(),
      'phone: the Dock stays in place over a page: 현황판 -> 메신저 in one tap',
    );
    await shot(phone, 'phone-messenger');
    await icon(phone, /^알림/).tap();
    await page_('알림 화면').waitFor();
    await shot(phone, 'phone-notices');
    await icon(phone, /^터미널/).tap();
    await page_('터미널 화면').waitFor();
    check(await dockShows(), 'phone: and on the terminal page');
    await shot(phone, 'phone-terminal');
    await page_('터미널 화면').getByRole('button', { name: '사무실' }).tap();
    check(true, 'phone: each icon opens a full-screen page, 사무실 closes it');

    // U-29: no long-press drag, no size menu; a tap still opens.
    const pbell = pdefaults['알림'];
    await touchHoldDrag(
      phone,
      center(pbell),
      { x: center(pbell).x - 90, y: center(pbell).y - 300 },
      650,
    );
    await phone.waitForTimeout(300);
    check(
      nearBox(await box(icon(phone, /^알림/)), pbell, 2),
      'phone: a long press then a drag moves nothing',
    );
    if (await page_('알림 화면').isVisible())
      await page_('알림 화면').getByRole('button', { name: '사무실' }).tap();
    await touchHoldDrag(phone, center(pbell), null, 650);
    check(
      (await phone.getByRole('group', { name: '알림 크기' }).count()) === 0,
      'phone: a long press without moving opens no size menu',
    );
    if (await page_('알림 화면').isVisible())
      await page_('알림 화면').getByRole('button', { name: '사무실' }).tap();
    await icon(phone, /^알림/).tap();
    await page_('알림 화면').waitFor();
    check(true, 'phone: a tap on an icon still opens it');
    await page_('알림 화면').getByRole('button', { name: '사무실' }).tap();
    await shot(phone, 'phone-fixed');
    // A free placement saved by an older version is ignored.
    await phone.evaluate(
      ([k, v]) => localStorage.setItem(k, v),
      [
        KEY,
        JSON.stringify({
          v: 1,
          items: { 'icon:notices': { place: { corner: 'tl', dx: 40, dy: 40 }, scale: 2 } },
        }),
      ],
    );
    await reload(phone);
    check(
      nearBox(await box(icon(phone, /^알림/)), pdefaults['알림'], 2),
      'phone: a saved free placement is ignored',
    );
    // Rotated: the Dock stays on screen.
    await phone.setViewportSize({ width: 852, height: 393 });
    await phone.waitForTimeout(500);
    const rot = await box(icon(phone, /^알림/));
    check(
      rot.x >= 0 && rot.y >= 0 && rot.x + rot.width <= 852 && rot.y + rot.height <= 393,
      `phone: rotated, the Dock is on screen (${fmt(rot)})`,
    );
    await shot(phone, 'phone-rotated');
    await phone.setViewportSize({ width: 393, height: 852 });
    await phone.waitForTimeout(500);
    // Reset.
    const preset = await settings(phone);
    await preset.tap();
    await phone.getByRole('button', { name: 'x', exact: true }).tap();
    await phone.waitForTimeout(400);
    check((await storedItems(phone)) === 0, 'phone: 화면 배치 초기화 clears the stored layout');
    await shot(phone, 'phone-after-reset');

    // ════ T-0111 phone, with the Dock (10-24): a minimized page comes back from its Dock button ════
    const pm = phone.locator('section[aria-label="메신저"]');
    const pwin = (label: string) => phone.locator(`[aria-label="${label}"]`);
    const current = () =>
      phone.getByTestId('mobile-dock').locator('[aria-current="page"]').getAttribute('data-dock');
    const topIs = (selector: string) =>
      phone.evaluate((sel) => {
        const page_ = document.querySelector(sel);
        if (!page_) return false;
        const b = page_.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 80);
        return hit !== null && page_.contains(hit);
      }, selector);
    // WINMODEL (owner 10-24): the phone's pages have no 최소화 or ×; the Dock's 사무실 goes home and every
    // page stays mounted, so a tab comes back as it was.
    const home = () => phone.locator('[data-dock="office"]').tap();
    await icon(phone, /^메신저/).tap();
    await pm.waitFor({ state: 'visible' });
    const pmBox = await box(pm);
    check(
      (await pm.getByRole('button', { name: '최소화' }).count()) === 0,
      'phone: a page has no 최소화 button of its own (the Dock is the tab bar)',
    );
    await home();
    await pm.waitFor({ state: 'hidden' });
    check(
      !(await pm.isVisible()) &&
        (await phone.getByTestId('hud-taskbar').count()) === 0 &&
        (await current()) === 'office',
      'phone: 사무실 hides the page and the Dock marks the office; no taskbar',
    );
    await shot2(phone, 'phone-minimized');
    await icon(phone, /^알림/).tap();
    await pwin('알림 화면').waitFor();
    await home();
    await pwin('알림 화면').waitFor({ state: 'hidden' });
    check(
      !(await pwin('알림 화면').isVisible()) && (await current()) === 'office',
      'phone: two pages sent home: the office shows',
    );
    await icon(phone, /^메신저/).tap();
    await pm.waitFor({ state: 'visible' });
    check(
      (await topIs('section[aria-label="메신저"]')) &&
        nearBox(await box(pm), pmBox, 1) &&
        (await current()) === 'messenger',
      'phone: a tap on the messenger in the Dock brings its page back to the front, same size and place',
    );
    await icon(phone, /^알림/).tap();
    await pwin('알림 화면').waitFor({ state: 'visible' });
    check(
      (await topIs('[aria-label="알림 화면"]')) &&
        (await current()) === 'notices' &&
        !(await pm.isVisible()),
      'phone: a tap on 알림 in the Dock puts that page on top, the messenger under it',
    );
    await shot2(phone, 'phone-restored');
    await home();
    await phone.waitForTimeout(300);
    check(
      (await pm.isVisible()) === false &&
        (await pwin('알림 화면').isVisible()) === false &&
        (await current()) === 'office',
      'phone: with every page sent home the office shows (the pages are kept, out of sight)',
    );

    check(pageErrors.length === 0, `no page errors ${JSON.stringify(pageErrors)}`);
    await ph.ctx.close();
  } catch (err) {
    console.error(daemon.log.join('').slice(-3000));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await daemon.stop();
    testTmux?.killServer();
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
