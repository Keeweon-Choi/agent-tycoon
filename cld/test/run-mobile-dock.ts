/**
 * Mobile Dock check (owner's request 10-24 02:16): on a phone the office,
 * 현황판 (its 개발 tab the old 작업실, UI-DASH), 파일, 메신저, 알림, 개발실 and 터미널 share one Dock outside the sliding track,
 * the agent cards are compact until expanded, the top keeps only the floor and
 * 설정, the usage line sits at the bottom, and nothing leaves an empty band.
 *
 * dist/cli.js with --engine on --allow-chat --allow-terminal --no-terminal (the
 * live daemon's flags) in an isolated HOME whose `claude` is the engine fake,
 * shells in a tmux server of this run's own, on a spare port.
 *
 *   --before   only the measurements and screenshots of office, messenger,
 *              terminal, 현황판 and 파일 at 390×844 (run on main for the "before")
 *   (default)  the same as "after", then every Dock check on 390×844, the
 *              keyboard (390×664), a 360-px Android width, and the desktop
 *              files icon
 *
 * Screenshots and the measurements (JSON) go to cld/artifacts/mobile-dock/.
 *
 *   npx tsx cld/test/run-mobile-dock.ts <port 18256-18259> [--before]
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import { findTmux, Tmux } from '../../server/src/cld/shell/tmux.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  topBarButton,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const BEFORE = process.argv.includes('--before');
const STAGE = BEFORE ? 'before' : 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/mobile-dock');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const HANGUL = 'unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3;';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__dock/malgun.ttf'); ${HANGUL} }
@font-face { font-family: 'Menlo'; src: url('/__dock/malgun.ttf'); ${HANGUL} }`;
/** An iPhone's notch and home indicator, as the app's vars carry them (no !important: the
 *  app zeroes the top one under its own top bar, as it does with the real env()). */
const SAFE_AREA = ':root { --cld-safe-top: 47px; --cld-safe-bottom: 34px; }';
const DEADLINE_MS = 420_000;
const LEADS = ['alpha', 'beta'];
const TMUX_SOCKET = `cld-test-${randomBytes(6).toString('hex')}`;
const tmuxBin = findTmux();
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
})();
const ANDROID: BrowserContextOptions = {
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent: devices['Pixel 5'].userAgent,
};

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 'dev': the 현황판's 개발 tab (UI-DASH: the old 작업실 page), under the 현황판's Dock button. */
type Screen = 'office' | 'board' | 'dev' | 'files' | 'messenger' | 'notices' | 'terminal';
const dockOf = (screen: Screen) => (screen === 'dev' ? 'board' : screen);
/** The page each screen shows as (its accessible name); the office has none. */
const PAGE_LABEL: Record<Exclude<Screen, 'office'>, string> = {
  board: '현황판 화면',
  dev: '현황판 화면',
  files: '파일 화면',
  messenger: '메신저',
  notices: '알림 화면',
  terminal: '터미널 화면',
};

/** Where the screen's content lives, per screen: the canvas for the office, the page otherwise. */
const workArea = (page: Page, screen: Screen): Locator =>
  screen === 'office'
    ? page.getByTestId('office-canvas')
    : screen === 'messenger'
      ? page.getByRole('region', { name: '메신저', exact: true })
      : page.locator(`[aria-label="${PAGE_LABEL[screen]}"]`);

interface Measure {
  screen: Screen;
  viewport: { w: number; h: number };
  /** The work area (canvas or page), clipped to the viewport. */
  work: { top: number; bottom: number; height: number };
  /** From the top edge to the work area (status bar inset included). */
  header: number;
  /** Chrome under the work area: cards, Dock, usage (whatever there is). */
  below: number;
  /** Floating icons laid over the work area (before: the HUD row over the canvas). */
  overlayBand: number;
  /** Viewport bottom minus the lowest content (padding excluded) of any visible element. */
  bottomGap: number;
  /** The bottom-most element's padding below its content. */
  bottomPadding: number;
  /** Agent card bar height. */
  cards: number;
  /** Dock height (0 before). */
  dock: number;
  scrollFits: boolean;
}

async function measure(page: Page, screen: Screen): Promise<Measure> {
  const work = await workArea(page, screen).first().boundingBox();
  if (!work) throw new Error(`no work area for ${screen}`);
  return page.evaluate(
    ({ screen, work }) => {
      const H = window.innerHeight;
      const W = window.innerWidth;
      const top = Math.max(0, work.y);
      const bottom = Math.min(H, work.y + work.height);
      const visible = (el: Element) => {
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0)
          return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < H ? r : null;
      };
      // Lowest content: border-box bottom minus padding-bottom, over every visible element
      // that paints something (text, image, canvas, border, background).
      let lowest = 0;
      let pad = 0;
      for (const el of document.body.querySelectorAll('*')) {
        const r = visible(el);
        // A screen-tall box is a background (the app's own, a page), not a band's content.
        if (!r || r.height > H * 0.6) continue;
        const s = getComputedStyle(el);
        const paints =
          el.childElementCount === 0 ||
          !/^rgba\(.*, 0\)$/.test(s.backgroundColor) || // a fully transparent background paints nothing
          parseFloat(s.borderBottomWidth) > 0;
        if (!paints) continue;
        const p = parseFloat(s.paddingBottom) || 0;
        const content = Math.min(H, r.bottom - p);
        if (content > lowest) {
          lowest = content;
          pad = Math.min(H, r.bottom) - content;
        }
      }
      const heightOf = (sel: string) => {
        const el = document.querySelector(sel);
        const r = el && visible(el);
        return r ? Math.round(r.height) : 0;
      };
      // Before: the HUD's icons sat in a row over the bottom of the canvas.
      let overlayBand = 0;
      if (screen === 'office') {
        const icons = [...document.querySelectorAll('[data-hud-id^="icon:"]')]
          .map((el) => visible(el))
          .filter((r): r is DOMRect => r !== null && r.top >= top && r.bottom <= bottom + 1);
        if (icons.length) overlayBand = Math.round(bottom - Math.min(...icons.map((r) => r.top)));
      }
      return {
        screen,
        viewport: { w: W, h: H },
        work: {
          top: Math.round(top),
          bottom: Math.round(bottom),
          height: Math.round(bottom - top),
        },
        header: Math.round(top),
        below: Math.round(H - bottom),
        overlayBand,
        bottomGap: Math.round(H - lowest),
        bottomPadding: Math.round(pad),
        cards: heightOf('[data-testid="mobile-agent-bar"]') || heightOf('.touch-pan-x'),
        dock: heightOf('[data-testid="mobile-dock"]'),
        scrollFits: document.documentElement.scrollWidth <= W,
      };
    },
    { screen, work },
  );
}

/** Everything of the phone shell after the change, on the iPhone page left on the office. */
async function afterChecks(
  phone: Page,
  conv: Locator,
  termShows: (page: Page) => Promise<unknown>,
): Promise<void> {
  const tap = (screen: Screen) => phone.locator(`[data-dock="${screen}"]`).tap();
  const active = () =>
    phone.getByTestId('mobile-dock').locator('[aria-current="page"]').getAttribute('data-dock');
  /** Close whatever dialog is up (Escape, then its x). */
  const closeDialogs = async () => {
    // The top dialog's x is the last one in the DOM (each portals to the end of body).
    for (let i = 0; i < 4; i++) {
      const xs = phone.getByRole('button', { name: 'x', exact: true });
      if (!(await xs.count())) break;
      await xs.last().tap();
      await phone.waitForTimeout(200);
    }
  };

  // ── Header: only the floor and 설정; the rest two taps away ──
  const top = phone.getByTestId('mobile-top-bar');
  const topButtons = await top
    .getByRole('button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent ?? ''));
  check(
    topButtons.length <= 2 && topButtons.includes('설정'),
    `header: only the floor picker and 설정 on top (${topButtons.join(' | ')})`,
  );
  await top.getByRole('button', { name: '설정' }).tap();
  // UI-FONT: no second row over the tabs; 기기 추가 sits under 접속, 범례 under 화면, 보안 is a tab.
  check((await phone.getByTestId('settings-quick').count()) === 0, 'header: 설정 has no second row over its tabs');
  const tabNames = await phone.getByTestId('settings-tabs').getByRole('tab').allTextContents();
  check(
    tabNames.filter((n) => n.trim() === '보안').length === 1,
    `header: 보안 appears once in 설정 (${tabNames.join(' | ')})`,
  );
  await phone.getByTestId('settings-tabs').getByRole('tab', { name: '접속', exact: true }).tap();
  check(await phone.getByTestId('add-device-option').getByRole('button', { name: '기기 추가' }).isVisible(), 'header: 기기 추가 is under 접속');
  await phone.getByTestId('settings-tabs').getByRole('tab', { name: '화면', exact: true }).tap();
  await phone.screenshot({ path: path.join(OUT, 'after-settings-quick.png') });
  await phone.getByTestId('legend-option').getByRole('button', { name: '범례' }).tap();
  const legend = phone.getByTestId('activity-legend');
  await legend.waitFor();
  const onTop = await legend.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + 10));
  });
  check(onTop, 'header: 범례 opened from 설정 is on top of it (the second tap)');
  await closeDialogs();
  await closeDialogs();
  check(
    (await phone.getByTestId('mobile-bottom').getByTestId('usage-folded').count()) === 1,
    'header: the usage line is at the bottom, folded to one line',
  );

  // ── Tap areas of the small controls: at least 44×44 (their hit area, not their drawing) ──
  const hitArea = (selector: string) =>
    phone.evaluate((sel) => {
      const el = document.querySelector(sel)!.closest('button')!;
      const r = el.getBoundingClientRect();
      const hits = (x: number, y: number) =>
        document.elementFromPoint(x, y)?.closest('button') === el;
      const reach = (x: number, y: number, dx: number, dy: number) => {
        let n = 0;
        while (n < 80 && hits(x + dx * (n + 1), y + dy * (n + 1))) n++;
        return n;
      };
      const [cx, cy] = [r.x + r.width / 2, r.y + r.height / 2];
      return {
        w: reach(cx, cy, -1, 0) + reach(cx, cy, 1, 0) + 1,
        h: reach(cx, cy, 0, -1) + reach(cx, cy, 0, 1) + 1,
      };
    }, selector);
  for (const [name, sel] of [
    ['the card toggle', '[data-testid="cards-toggle"]'],
    ['설정', '[data-testid="mobile-top-bar"] [aria-label="설정"]'],
    ['the usage line', '[data-testid="mobile-bottom"] [data-testid="usage-folded"]'],
  ] as const) {
    const a = await hitArea(sel);
    check(a.w >= 44 && a.h >= 44, `tap area: ${name} is ${a.w}×${a.h} px`);
  }

  // ── Compact cards ──
  const bar = phone.getByTestId('mobile-agent-bar');
  const cards = bar.getByTestId('agent-card');
  const compact = await cards.evaluateAll((els) =>
    els.map((el) => ({
      compact: el.hasAttribute('data-compact'),
      h: Math.round(el.getBoundingClientRect().height),
    })),
  );
  check(
    compact.length === 2 && compact.every((c) => c.compact && c.h <= 44),
    `cards: compact by default, ${compact.map((c) => c.h).join(', ')} px tall`,
  );
  check(
    ((await cards.first().getByTestId('card-name').textContent()) ?? '') !== '' &&
      (await cards.first().getByTestId('card-status').count()) === 1 &&
      (await cards.first().locator('canvas').count()) === 1,
    'cards: a compact card has the mug shot, the name and the status dot',
  );
  const barCompact = (await bar.boundingBox())!.height;
  await phone.getByTestId('cards-toggle').tap();
  const barFull = (await bar.boundingBox())!.height;
  check(
    (await cards.first().getAttribute('data-compact')) === null && barFull > barCompact,
    `cards: the toggle expands them (bar ${barCompact} -> ${barFull} px)`,
  );
  const [expandedCard, expandedFace] = await Promise.all([
    cards.first().boundingBox(),
    cards.first().locator('canvas').boundingBox(),
  ]);
  check(
    !!expandedCard &&
      !!expandedFace &&
      Math.abs(
        expandedCard.x + expandedCard.width / 2 - (expandedFace.x + expandedFace.width / 2),
      ) <= 1,
    'cards: an expanded card centers its larger orchestrator face',
  );
  await phone.screenshot({ path: path.join(OUT, 'after-cards-expanded.png') });
  const officeBefore = await phone.getByTestId('office-canvas').boundingBox();
  await phone.getByTestId('cards-toggle').tap();
  check(
    (await bar.getAttribute('data-roster-state')) === 'hidden' && (await cards.count()) === 0,
    'cards: the full strip folds away',
  );
  // Hidden: the strip has no height, the office reaches the usage line, only the handle floats.
  const hiddenGeometry = async (label: string) => {
    const [o, b, h, u, j, m] = await Promise.all([
      phone.getByTestId('office-canvas').boundingBox(),
      bar.boundingBox(),
      phone.getByTestId('cards-toggle').boundingBox(),
      phone.getByTestId('mobile-bottom').boundingBox(),
      phone
        .getByTestId('joystick')
        .count()
        .then((n) => (n ? phone.getByTestId('joystick').boundingBox() : null)),
      phone.getByTestId('camera-modes').boundingBox(),
    ]);
    const apart = (a: typeof h, c: typeof h) =>
      !a ||
      !c ||
      a.x + a.width <= c.x ||
      c.x + c.width <= a.x ||
      a.y + a.height <= c.y ||
      c.y + c.height <= a.y;
    check(!!b && b.height === 0, `cards hidden ${label}: the strip takes no height`);
    check(
      !!o && !!u && Math.abs(o.y + o.height - u.y) <= 1,
      `cards hidden ${label}: the office reaches the usage band (${o && Math.round(o.y + o.height)} vs ${u && Math.round(u.y)})`,
    );
    check(
      !!h &&
        !!o &&
        !!u &&
        h.y + h.height <= u.y + 1 &&
        h.y >= o.y &&
        h.x >= 0 &&
        h.x + h.width <= 390,
      `cards hidden ${label}: the handle floats over the office's bottom edge`,
    );
    check(
      apart(h, j) && apart(h, m),
      `cards hidden ${label}: the handle covers neither the joystick nor 자동/로비`,
    );
    // Owner 11-01 03:13: the handle is on the left, where the strip's toggle is.
    check(!!h && h.x + h.width <= 390 / 3, `cards hidden ${label}: the handle is on the left`);
    return { j };
  };
  await phone.waitForTimeout(500); // the canvas resizes after its observer fires
  const officeAfter = await phone.getByTestId('office-canvas').boundingBox();
  check(
    !!officeBefore && !!officeAfter && officeAfter.height > officeBefore.height,
    `cards hidden: the office grew (${officeBefore?.height} -> ${officeAfter?.height} px)`,
  );
  // The update toast sits over the handle's spot: dismiss it for the picture.
  const notice = phone.getByTestId('update-notice');
  if (await notice.count()) await notice.getByRole('button').last().tap();
  await phone.waitForTimeout(500);
  await hiddenGeometry('without a selection');
  await phone.screenshot({ path: path.join(OUT, 'after-cards-hidden.png') });
  // With a character selected the joystick shows (bottom-left); the handle must clear it.
  const alpha = phone.locator('[data-testid="agent-overlay"]').first();
  const alphaId = Number(await alpha.getAttribute('data-agent-id'));
  await phone.evaluate((id) => {
    (
      window as unknown as { __agentTycoonTestHooks: { selectAgent: (i: number) => void } }
    ).__agentTycoonTestHooks.selectAgent(id);
  }, alphaId);
  await phone.getByTestId('joystick').waitFor({ timeout: 5_000 });
  await phone.waitForTimeout(500);
  const withPad = await hiddenGeometry('with a selected character');
  check(!!withPad.j, 'cards hidden: the joystick is showing');
  await phone.screenshot({ path: path.join(OUT, 'after-cards-hidden-joystick.png') });
  await phone.getByTestId('cards-toggle').tap();
  check(
    (await cards.first().getAttribute('data-compact')) !== null,
    'cards: the handle restores compact cards',
  );
  await cards.first().tap();
  await phone.waitForTimeout(300);
  check(
    ((await cards.first().getAttribute('class')) ?? '').includes('bg-active-bg'),
    'cards: a tap still selects the agent (its card lights up)',
  );

  // ── Switching and restoring ──
  await tap('messenger');
  const box = conv.getByRole('textbox', { name: '보낼 글' });
  await box.fill('초안 그대로');
  const list = conv.locator('.overflow-y-auto.space-y-8');
  await list.evaluate(
    (el) => (el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 150)),
  );
  await phone.waitForTimeout(300);
  const scrolled = await list.evaluate((el) => el.scrollTop);
  const sameConversation = async () =>
    (await box.inputValue()) === '초안 그대로' &&
    Math.abs((await list.evaluate((el) => el.scrollTop)) - scrolled) <= 2;
  await tap('terminal');
  await termShows(phone);
  check((await active()) === 'terminal', 'Dock: messenger -> terminal, the same attach on screen');
  await tap('board');
  await phone.locator(`[aria-label="${PAGE_LABEL.board}"]`).waitFor();
  check((await active()) === 'board', 'Dock: terminal -> 현황판');
  await tap('messenger');
  await conv.waitFor();
  check(
    (await active()) === 'messenger' && (await sameConversation()),
    `Dock: back on the messenger, the same conversation, draft and scroll (${scrolled})`,
  );
  // WINMODEL (owner 10-24): the Dock is a tab bar. The shown tab pressed again goes to its root
  // (the messenger's list), it no longer minimizes; 사무실 goes home, every page kept.
  await tap('office');
  await phone.waitForTimeout(300);
  check(
    (await active()) === 'office' && !(await conv.isVisible()),
    'Dock: 사무실 goes home, the messenger kept out of sight',
  );
  await tap('messenger');
  await conv.waitFor();
  check(await sameConversation(), 'Dock: reopened from home, the draft and the scroll are there');
  const selectedTab = () =>
    phone
      .locator(`[aria-label="${PAGE_LABEL.terminal}"] [role="tab"][aria-selected="true"]`)
      .first()
      .textContent();
  await tap('terminal');
  await termShows(phone);
  const tabBefore = await selectedTab();
  await tap('office');
  check((await active()) === 'office', 'Dock: 사무실 minimizes the terminal');
  await tap('terminal');
  await termShows(phone);
  const tabAfter = await selectedTab();
  check(
    tabBefore !== null && tabBefore === tabAfter,
    `Dock: the terminal comes back on the same tab (${tabAfter})`,
  );

  // 현황판 keeps its tab across 파일.
  await tap('board');
  await phone
    .getByRole('navigation', { name: '작업 메뉴' })
    .getByRole('button', { name: 'HW', exact: true })
    .tap();
  await phone.locator('[aria-label="HW 화면"]').waitFor();
  await tap('files');
  await phone.locator(`[aria-label="${PAGE_LABEL.files}"] [aria-label$="파일 탐색기"]`).waitFor();
  check((await active()) === 'files', 'Dock: 파일 opens the explorer');
  await tap('board');
  await phone.locator('[aria-label="HW 화면"]').waitFor();
  check((await active()) === 'board', 'Dock: 현황판 comes back on its HW tab');
  await tap('files');
  await tap('files');
  check((await active()) === 'files', 'Dock: a second tap on 파일 stays (its root), no minimize');

  // ── Layers: a dialog covers the Dock ──
  await tap('messenger');
  await phone.getByTestId('mobile-top-bar').getByRole('button', { name: '설정' }).tap();
  await phone.getByTestId('settings-tabs').waitFor();
  const dockBox = (await phone.getByTestId('mobile-dock').boundingBox())!;
  const covered = await phone.evaluate(
    ({ x, y }) =>
      !document
        .querySelector('[data-testid="mobile-dock"]')!
        .contains(document.elementFromPoint(x, y)),
    { x: dockBox.x + dockBox.width / 2, y: dockBox.y + dockBox.height / 2 },
  );
  check(covered, 'layers: a dialog (설정) lies over the Dock');
  await closeDialogs();

  // ── The keyboard (390×664) ──
  await box.tap();
  await phone.setViewportSize({ width: 390, height: 664 });
  await phone.getByTestId('mobile-dock').waitFor({ state: 'detached' });
  const boxBottom = await box.evaluate((el) => el.getBoundingClientRect().bottom);
  check(
    boxBottom <= 664 && (await bar.count()) === 0,
    `keyboard: the Dock and the cards step aside, the message box stays in view (bottom ${Math.round(boxBottom)})`,
  );
  await phone.screenshot({ path: path.join(OUT, 'after-keyboard-messenger.png') });
  const keyboardDown = async () => {
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await phone.getByTestId('mobile-dock').waitFor();
  };
  await keyboardDown();
  await tap('messenger');
  await conv.waitFor({ state: 'hidden' });
  check(
    (await active()) === 'messenger',
    'Dock: a tap on the messenger showing goes to its list (its root), still on the messenger',
  );
  await tap('terminal');
  await termShows(phone);
  await phone.locator('.xterm-screen').first().tap();
  await phone.setViewportSize({ width: 390, height: 664 });
  // U-33 / key bar 10-24: Shift, Tab and paste are gone from the bar (the owner's 7-column layout).
  for (const key of ['Esc 키', '컨트롤 키', 'End 키'])
    await phone.getByRole('button', { name: key, exact: true }).waitFor();
  const keyBar = await phone.getByRole('button', { name: 'Esc 키', exact: true }).boundingBox();
  check(
    keyBar !== null &&
      keyBar.y + keyBar.height <= 664 &&
      (await phone.getByTestId('mobile-dock').count()) === 0,
    'keyboard: on the terminal the key bar is up and in view, the Dock out of its way',
  );
  await phone.screenshot({ path: path.join(OUT, 'after-keyboard-terminal.png') });
  await keyboardDown();
  await tap('office');
}

async function main() {
  await assertPortFree(port);
  if (!tmuxBin)
    throw new Error('this check needs tmux (the terminal workspace lists shells in it)');
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const testTmux = new Tmux(tmuxBin, TMUX_SOCKET);
  // The spare port in the temp HOME's own config: nothing can fall back to the live 18240.
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folders = Object.fromEntries(LEADS.map((n) => [n, path.join(home, 'work', n)]));
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      LEADS.map((name) => ({ name, folder: folders[name], room: '개발실', wantRunning: true })),
    ),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-terminal', '--no-terminal'],
    { FAKE_TURN_MS: '600', SHELL: '/bin/sh', CLD_GUI_SHELL_TMUX_SOCKET: TMUX_SOCKET },
  );
  const server = daemon.child;
  const cleanup = () => {
    killFakeSessions(home);
    testTmux.killServer();
    fs.rmSync(home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { pid: number; sessionId: string; cwd: string; name: string };
  const sessionOf = (name: string): Sess | null => {
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  let uuid = 0;
  const say = (name: string, role: 'user' | 'assistant', text: string) => {
    const s = sessionOf(name)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const timestamp = new Date().toISOString();
    fs.appendFileSync(
      file,
      `${JSON.stringify(
        role === 'user'
          ? { type: 'user', uuid: id, timestamp, message: { role, content: text } }
          : {
              type: 'assistant',
              uuid: id,
              timestamp,
              message: { role, content: [{ type: 'text', text }] },
            },
      )}\n`,
    );
  };

  let browser: Browser | undefined;
  const results: Record<string, Measure> = {};
  try {
    const font = fs.readFileSync(FONT);
    const url = await daemon.loginUrl();
    for (const end = Date.now() + 40_000; LEADS.some((n) => !sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await sleep(300);
    }
    // A conversation long enough to scroll.
    for (const n of LEADS)
      for (let i = 1; i <= 24; i++)
        say(n, i % 2 ? 'user' : 'assistant', `${n} ${i}번째 메시지: 오늘 할 일 정리`);
    await sleep(4_000);

    browser = await launchBrowser();
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser!.newContext(opts);
      await ctx.route('**/__dock/malgun.ttf', (route) =>
        route.fulfill({ body: font, contentType: 'font/ttf' }),
      );
      // tsx keeps function names with a `__name` helper the page does not have.
      await ctx.addInitScript('window.__name = (f) => f; window.__AGENT_TYCOON_E2E = true;');
      const page = await ctx.newPage();
      return { ctx, page };
    };
    const ready = async (page: Page, safeArea: boolean) => {
      await page.addStyleTag({ content: FONT_CSS });
      if (safeArea) await page.addStyleTag({ content: SAFE_AREA });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      await page.locator('[data-testid="agent-overlay"]').first().waitFor();
      await page.waitForTimeout(1_500);
    };

    // ════ Phone 390×844 ════
    const { ctx: phoneCtx, page: phone } = await open(IPHONE);
    await phone.goto(url);
    await phone.waitForURL(`http://127.0.0.1:${port}/`);
    await ready(phone, true);

    /** The Dock's button (after), or the floating icon / tab that opened the screen before. */
    const dockButton = (page: Page, screen: Screen) => page.locator(`[data-dock="${screen}"]`);
    const go = async (page: Page, screen: Screen) => {
      if (!BEFORE && screen === 'dev') {
        await dockButton(page, 'board').tap();
        // A DOM click, not tap(): Playwright's scroll-into-view moved the office region's
        // overflow-hidden track 160 px sideways (a finger does not), and the hidden-roster
        // geometry check then measured the joystick off screen.
        return page
          .getByRole('navigation', { name: '작업 메뉴' })
          .getByRole('button', { name: '개발', exact: true })
          .evaluate((el) => (el as HTMLElement).click());
      }
      if (!BEFORE) return dockButton(page, screen).tap();
      if (screen === 'office') {
        // Before: each page had its own way back (사무실 in its title bar).
        const back = page.getByRole('button', { name: '사무실', exact: true });
        for (let i = 0; (await back.count()) && i < 4; i++) await back.first().tap();
        return;
      }
      // Before: a page covered the floating icons, so every switch went through the office.
      await go(page, 'office');
      if (screen === 'files') {
        await go(page, 'board');
        return page
          .getByRole('navigation', { name: '작업 메뉴' })
          .getByRole('button', { name: '파일', exact: true })
          .tap();
      }
      const icon = {
        board: 'office',
        messenger: 'messenger',
        notices: 'notices',
        terminal: 'terminal',
      }[screen];
      await page.locator(`[data-hud-id="icon:${icon}"]`).getByRole('button').tap();
    };
    /** On every screen: the Dock is there, marks this screen and only it, nothing is wider
     *  than the screen, and no band is left empty under the last row. */
    const dockChecks = async (page: Page, screen: Screen, m: Measure, label: string) => {
      const dock = page.getByTestId('mobile-dock');
      const current = await dock
        .locator('[aria-current="page"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-dock')));
      check(
        (await dock.isVisible()) && current.length === 1 && current[0] === dockOf(screen),
        `${label} ${screen}: the Dock shows and marks ${dockOf(screen)} (${current.join(',')})`,
      );
      // UI-DASH: from 360 px every tab is whole on screen (none cut at the edge, no sideways scroll).
      if (m.viewport.w >= 360) {
        const fit = await dock.evaluate((nav) => ({
          scrolls: nav.scrollWidth > nav.clientWidth + 1,
          out: [...nav.querySelectorAll('button')].filter((b) => {
            const r = b.getBoundingClientRect();
            return r.left < 0 || r.right > window.innerWidth + 0.5 || r.width < 44;
          }).length,
          count: nav.querySelectorAll('button').length,
        }));
        check(
          !fit.scrolls && fit.out === 0 && fit.count === 7,
          `${label} ${screen}: all ${fit.count} Dock tabs whole on screen, each >= 44 px, no sideways scroll`,
        );
      }
      check(m.scrollFits, `${label} ${screen}: scrollWidth <= innerWidth`);
      // The last row ends at the inset's edge (nothing tappable in the strip, T-0008): the
      // gap under it is the inset itself plus the band's own few pixels, nothing more.
      const inset = await page.evaluate(
        () =>
          parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--cld-safe-bottom'),
          ) || 0,
      );
      check(
        m.bottomGap <= inset + 6,
        `${label} ${screen}: no empty band at the bottom (${m.bottomGap}px under the last row's content: the ${inset}px inset + 6)`,
      );
    };
    const shotAndMeasure = async (page: Page, screen: Screen, prefix = STAGE) => {
      await page.waitForTimeout(500);
      const m = await measure(page, screen);
      results[`${prefix}-${screen}`] = m;
      await page.screenshot({ path: path.join(OUT, `${prefix}-${screen}.png`) });
      console.log(
        `${prefix} ${screen}: work ${m.work.height}px (top ${m.work.top}), header ${m.header}, below ${m.below} (cards ${m.cards}, dock ${m.dock}), icons over the work area ${m.overlayBand}, bottom gap ${m.bottomGap} (padding ${m.bottomPadding})`,
      );
      if (!BEFORE) await dockChecks(page, screen, m, prefix);
      return m;
    };

    // Office.
    await shotAndMeasure(phone, 'office');

    // Messenger: alpha's conversation.
    await go(phone, 'messenger');
    const pm = phone.getByRole('region', { name: '메신저', exact: true });
    await pm
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: /^alpha/ })
      .tap();
    const conv = pm.getByRole('region', { name: 'alpha 대화' });
    await conv.getByText('alpha 24번째 메시지: 오늘 할 일 정리').waitFor();
    await shotAndMeasure(phone, 'messenger');

    // Terminal: alpha's attach, through 터미널로 보기.
    await conv.getByRole('button', { name: '터미널로 보기' }).tap();
    const termShows = (page: Page) =>
      page.waitForFunction(
        () =>
          [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some(
            (el) => el.offsetParent !== null && el.innerText.includes('fake Claude Code'),
          ),
        undefined,
        { timeout: 15_000 },
      );
    await termShows(phone);
    await shotAndMeasure(phone, 'terminal');

    // 현황판 and 파일.
    await go(phone, 'board');
    await phone.locator(`[aria-label="${PAGE_LABEL.board}"]`).waitFor();
    await shotAndMeasure(phone, 'board');
    await go(phone, 'files');
    await phone.locator(`[aria-label="${PAGE_LABEL.files}"]`).waitFor();
    await shotAndMeasure(phone, 'files');
    if (!BEFORE) {
      // UI-DASH: the old 작업실 is the 현황판's 개발 tab.
      await go(phone, 'dev');
      await phone.getByRole('combobox', { name: '개발 프로젝트' }).waitFor();
      await shotAndMeasure(phone, 'dev');
    }
    await go(phone, 'office');

    if (!BEFORE) await afterChecks(phone, conv, termShows);
    const phoneState = await phoneCtx.storageState();
    await phoneCtx.close();

    if (!BEFORE) {
      // ════ Android, 360 px ════
      const { ctx: aCtx, page: android } = await open({ ...ANDROID, storageState: phoneState });
      await android.goto(`http://127.0.0.1:${port}/`);
      await ready(android, false);
      const widths = await android
        .getByTestId('mobile-dock')
        .locator('button')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
      check(
        widths.length === 7 && widths.every((w) => w >= 44),
        `android-360: seven Dock buttons, each >= 44 px wide (${widths.join(', ')})`,
      );
      for (const screen of [
        'office',
        'messenger',
        'terminal',
        'board',
        'dev',
        'files',
      ] as const) {
        if (screen !== 'office') await go(android, screen);
        if (screen === 'messenger')
          await android
            .getByRole('region', { name: '메신저', exact: true })
            .getByRole('list', { name: '연락처' })
            .waitFor();
        else if (screen !== 'office') await workArea(android, screen).first().waitFor();
        await shotAndMeasure(android, screen, 'android360');
      }
      await aCtx.close();

      // ════ The bottom is tight on every phone: the inset counted once, at the very bottom ════
      // The shell reads --cld-safe-bottom; set it as each device reports it and measure the gap
      // between the Dock's last pixel and the screen's bottom edge (the inset, plus 4 px at least).
      const bottomCases = [
        { name: 'iphone-390x844-inset34', w: 390, h: 844, bottom: 34, top: 47 },
        { name: 'iphone-se-390x844-inset0', w: 390, h: 844, bottom: 0, top: 0 },
        { name: 'galaxy-360x780-gesture16', w: 360, h: 780, bottom: 16, top: 24 },
        { name: 'galaxy-360x780-3button0', w: 360, h: 780, bottom: 0, top: 24 },
      ];
      for (const c of bottomCases) {
        const { ctx: bCtx, page: bp } = await open({
          ...ANDROID,
          viewport: { width: c.w, height: c.h },
          storageState: phoneState,
        });
        await bp.goto(`http://127.0.0.1:${port}/`);
        await ready(bp, false);
        await bp.addStyleTag({
          content: `:root { --cld-safe-top: ${c.top}px; --cld-safe-bottom: ${c.bottom}px; }`,
        });
        await bp.waitForTimeout(300);
        const gap = await bp.evaluate(() => {
          const nav = document.querySelector('[data-testid="mobile-dock"]')!;
          const last = [...nav.querySelectorAll('button')].reduce(
            (m, b) => Math.max(m, b.getBoundingClientRect().bottom),
            0,
          );
          return {
            gap: Math.round(innerHeight - last),
            root: document.getElementById('root')!.getBoundingClientRect().bottom,
          };
        });
        const want = Math.max(4, c.bottom);
        check(
          Math.abs(gap.gap - want) <= 1 && Math.round(gap.root) === c.h,
          `bottom ${c.name}: ${gap.gap} px under the Dock icons (inset ${c.bottom}, want ${want}), root ends at ${Math.round(gap.root)}`,
        );
        await bp.screenshot({ path: path.join(OUT, `bottom-${c.name}.png`) });
        await bCtx.close();
      }

      // A Home-Screen app whose layout viewport is shorter than the screen by the top inset
      // (iPhone 390x844: 797 px tall, owner 11-01 02:04). WebKit paints nothing past that viewport
      // (11-01 02:50: a root stretched to 844 cut the Dock's icons), so the root ends there, the
      // home indicator lies below it (no inset inside), and the band under it has the Dock's colour.
      {
        const { ctx: sCtx2, page: sp } = await open({
          ...IPHONE,
          viewport: { width: 390, height: 797 },
          screen: { width: 390, height: 844 },
          storageState: phoneState,
        });
        await sp.addInitScript(
          "Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });",
        );
        await sp.goto(`http://127.0.0.1:${port}/`);
        await ready(sp, false);
        await sp.addStyleTag({
          content: ':root { --cld-safe-top: 47px; --cld-safe-bottom: 34px; }',
        });
        await sp.evaluate(() => window.dispatchEvent(new Event('resize')));
        await sp.waitForTimeout(500);
        const m = await sp.evaluate(() => {
          const nav = document.querySelector('[data-testid="mobile-dock"]')!;
          const last = [...nav.querySelectorAll('button')].reduce(
            (a, b) => Math.max(a, b.getBoundingClientRect().bottom),
            0,
          );
          return {
            root: Math.round(document.getElementById('root')!.getBoundingClientRect().bottom),
            gap: Math.round(innerHeight - last),
            sameColour:
              getComputedStyle(document.documentElement).backgroundColor ===
              getComputedStyle(document.querySelector('[data-testid="mobile-bottom"]')!)
                .backgroundColor,
          };
        });
        check(
          m.root === 797 && Math.abs(m.gap - 4) <= 1 && m.sameColour,
          `bottom short Home-Screen viewport (797 of 844): root ends at ${m.root}, ${m.gap} px under the Dock icons, the band below in the Dock's colour (${m.sameColour})`,
        );
        await sp.screenshot({ path: path.join(OUT, 'bottom-standalone-short-viewport.png') });
        await sCtx2.close();
      }

      // ════ A 320 px phone: seven 44 px buttons do not fit, so the Dock scrolls sideways ════
      const { ctx: sCtx, page: narrow } = await open({
        ...ANDROID,
        viewport: { width: 320, height: 640 },
        storageState: phoneState,
      });
      await narrow.goto(`http://127.0.0.1:${port}/`);
      await ready(narrow, false);
      const dockBox = () =>
        narrow.getByTestId('mobile-dock').evaluate((nav) => {
          const box = nav.getBoundingClientRect();
          const buttons = [...nav.querySelectorAll('button')].map((el) =>
            el.getBoundingClientRect(),
          );
          const current = nav.querySelector('[aria-current="page"]')?.getBoundingClientRect();
          return {
            widths: buttons.map((r) => Math.round(r.width * 10) / 10),
            oneRow: new Set(buttons.map((r) => Math.round(r.top))).size === 1,
            scrolls: nav.scrollWidth > nav.clientWidth + 1,
            overflowX: getComputedStyle(nav).overflowX,
            currentInView:
              !current || (current.left >= box.left - 1 && current.right <= box.right + 1),
          };
        });
      const narrowDock = await dockBox();
      check(
        narrowDock.widths.length === 7 &&
          narrowDock.widths.every((w) => w >= 44) &&
          narrowDock.oneRow &&
          narrowDock.scrolls &&
          narrowDock.overflowX === 'auto',
        `android-320: seven Dock buttons, each >= 44 px wide (${narrowDock.widths.join(', ')}), one row, the Dock scrolls sideways`,
      );
      for (const screen of [
        'office',
        'messenger',
        'terminal',
        'board',
        'dev',
        'files',
      ] as const) {
        if (screen !== 'office') await go(narrow, screen);
        if (screen === 'messenger')
          await narrow
            .getByRole('region', { name: '메신저', exact: true })
            .getByRole('list', { name: '연락처' })
            .waitFor();
        else if (screen !== 'office') await workArea(narrow, screen).first().waitFor();
        await shotAndMeasure(narrow, screen, 'android320');
        const where = await dockBox();
        check(
          where.currentInView && where.widths.every((w) => w >= 44),
          `android320 ${screen}: its Dock button is scrolled into view, every button still >= 44 px`,
        );
      }
      await sCtx.close();

      // ════ Desktop: the 파일 icon (the one desktop change) ════
      const { ctx: dCtx, page: desk } = await open({
        viewport: { width: 1400, height: 900 },
        deviceScaleFactor: 1,
        storageState: phoneState,
      });
      await desk.goto(`http://127.0.0.1:${port}/`);
      await ready(desk, false);
      check(
        (await desk.getByTestId('mobile-dock').count()) === 0 &&
          (await desk.getByTestId('mobile-top-bar').count()) === 0 &&
          (await desk.locator('[data-hud-id="usage"]').count()) === 1,
        'desktop: no Dock, no phone top bar; the usage bar with its buttons stays on top',
      );
      const filesIcon = desk.locator('[data-hud-id="icon:files"]').getByRole('button');
      const explorer = desk.locator('[data-hud-window="office"] [aria-label$="파일 탐색기"]');
      check(
        (await filesIcon.getAttribute('aria-label')) === '파일' &&
          (await desk.locator('[data-hud-id^="icon:"]').count()) === 6,
        'desktop: the 파일 icon is in the default set (six icons, the 작업실 among them)',
      );
      await desk.screenshot({ path: path.join(OUT, 'after-desktop-icons.png') });
      await filesIcon.click();
      await explorer.waitFor();
      check(
        (await filesIcon.getAttribute('aria-pressed')) === 'true',
        'desktop: 파일 opens the explorer (the 현황판 window on 파일), pressed',
      );
      await desk.screenshot({ path: path.join(OUT, 'after-desktop-files.png') });
      await filesIcon.click();
      // WINMODEL (owner 10-24): the front window's icon minimizes (only its x closes).
      await explorer.waitFor({ state: 'hidden' });
      check(
        /최소화됨/.test((await filesIcon.getAttribute('aria-label')) ?? ''),
        'desktop: a second click on 파일 minimizes it (the window is kept, its icon says so)',
      );
      await filesIcon.click();
      await explorer.waitFor();
      await desk
        .locator('[data-hud-window="office"]')
        .getByRole('button', { name: '최소화' })
        .click();
      await explorer.waitFor({ state: 'hidden' });
      check(
        /최소화됨/.test((await filesIcon.getAttribute('aria-label')) ?? ''),
        'desktop: minimized, the explorer is out of sight and its icon says so',
      );
      await filesIcon.click();
      await explorer.waitFor();
      check(true, 'desktop: the icon brings the minimized explorer back');
      await dCtx.close();
    }

    const file = path.join(OUT, `${STAGE}.json`);
    fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`measurements: ${path.relative(REPO_ROOT, file)}`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
