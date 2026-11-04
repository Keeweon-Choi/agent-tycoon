/**
 * SETTINGS-TABS + OPTIONS-3A check: dist/cli.js with an isolated HOME on a spare port, headless
 * Chromium (--disable-gpu), the owner's 1282x832 and 1400x900 (a fake desktop app bridge, so
 * 화면 모드 shows) and a phone 390x844.
 * - 설정 is five tabs (일반 화면 접속 보안 고급), a column on the left on a desktop; every former
 *   setting sits in one of them; the last tab is remembered across a reload;
 * - 3A: the window is at most 960x768; in every tab each row is one height, every control ends on
 *   one right edge, buttons are one height, a choice's buttons one gap apart, no name is cut or
 *   covered; 화면 fits without scrolling; hovering shows the help on the hint line and moves no row;
 *   ↑↓ walk rows, ←→ pick, Esc closes; picks survive closing and a reload.
 *   MISALIGN=1 (the negative control) pushes one row's buttons 12px left: the run must fail.
 * - 보안: 로그인한 기기 comes first, 패스키 (선택) after it, sections are boxes, the window
 *   leaves no empty strip on the right, 보안 기록 is closed until clicked.
 * With BEFORE=1 (run from a checkout of the old build) it only screenshots the old 보안 panel
 * into OUT_DIR. Screenshots to cld/artifacts/settings-tabs/.
 *
 *   npx tsx cld/test/run-settings-tabs.ts <port 18440-18449>
 */
import type { Page } from '@playwright/test';
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
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const BEFORE = process.env.BEFORE === '1';
const OUT = process.env.OUT_DIR ?? path.join(REPO_ROOT, 'cld/artifacts/settings-3a-1104');
const MISALIGN = process.env.MISALIGN === '1';
const FAKE_BRIDGE = `window.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve() };`;
const TAB_FILES: Record<string, string> = { 일반: 'general', 화면: 'display', 접속: 'access', 보안: 'security', 고급: 'advanced' };
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__st/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
/** The tabs, with the testids each one must hold. */
const TABS: Array<[string, string[]]> = [
  ['일반', ['install-app-option', 'language-option', 'owner-picture-option', 'office-hours-options']],
  ['화면', ['ui-scale-option', 'floor-view-option', 'nameplates-option', 'rank-icon-option', 'hud-reset-option']],
  ['접속', ['access-option']],
  ['보안', ['bypass-option', 'security-open-option']],
  ['고급', ['ime-guard-option']],
];
/** A tab must not need more than this many screens of scrolling (the real numbers are printed). */
const MAX_SCREENS = 2.5;
/** OPTIONS-3A's window, and one gap between a choice's buttons. */
const FRAME = { w: 960, h: 768 };
const CHOICE_GAP = 4;

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
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-actions']);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    for (const [tag, viewport, mobile] of [
      ['d1282', { width: 1282, height: 832 }, false],
      ['d1400', { width: 1400, height: 900 }, false],
      ['phone', { width: 390, height: 844 }, true],
    ] as const) {
      const first = tag === 'd1282';
      const ctx = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
        deviceScaleFactor: mobile ? 2 : 1,
      });
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
      if (!mobile) await ctx.addInitScript(FAKE_BRIDGE);
      await ctx.route('**/__st/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      const ready = async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.addStyleTag({ content: FONT_CSS });
        await topBarReady(page, 60_000);
        const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
        if (await closeInfo.count()) await closeInfo.first().click();
        await page.waitForTimeout(1_500);
      };
      const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) });
      const dialogX = () => page.getByRole('button', { name: 'x', exact: true }).last().click();
      /** OPTIONS-3A: the shown tab's rows, measured. */
      const measure = () =>
        page.evaluate(() => {
          const d = [...document.querySelectorAll('[role="dialog"]')].at(-1)!.getBoundingClientRect();
          const content = document.querySelector('[data-testid="settings-content"]') as HTMLElement;
          const rows = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]:not([hidden]) [data-setting-row]')].filter(
            (r) => r.getClientRects().length > 0,
          );
          const box = (el: Element) => el.getBoundingClientRect();
          const name = (r: Element) => r.querySelector('p')?.textContent ?? '';
          return {
            dialog: { w: Math.round(d.width), h: Math.round(d.height) },
            shown: content.clientHeight,
            scroll: content.scrollHeight - content.clientHeight,
            sideways: content.scrollWidth - content.clientWidth,
            heights: rows.map((r) => Math.round(box(r).height * 10) / 10),
            past: rows
              .filter((r) => [...r.querySelectorAll('[data-setting-control] button')].some((b) => box(b).right > box(r).right + 0.5))
              .map(name),
            rights: rows.flatMap((r) => [...r.querySelectorAll('[data-setting-control]')].map((c) => Math.round(box(c).right * 10) / 10)),
            buttonHeights: [...new Set(rows.flatMap((r) => [...r.querySelectorAll('[data-setting-control] button')].map((b) => Math.round(box(b).height))))],
            gaps: rows.flatMap((r) =>
              [...r.querySelectorAll('[data-choice]')].flatMap((g) => {
                const bs = [...g.querySelectorAll('button')].map(box);
                return bs.slice(1).map((b, i) => Math.round(b.left - bs[i].right));
              }),
            ),
            overlaps: rows
              .filter((r) => {
                const c = r.querySelector('[data-setting-control]');
                const p = r.querySelector('p');
                return c && p && box(c).top < box(p).bottom && box(c).bottom > box(p).top && box(c).left < box(p).right - 0.5;
              })
              .map(name),
            cut: rows.map((r) => r.querySelector('p')).filter((p): p is HTMLParagraphElement => !!p && p.scrollWidth > p.clientWidth + 1).map((p) => p.textContent ?? ''),
          };
        });
      await ready();

      // The security panel: top bar on the desktop, 설정 → 보안 tab on the phone (its quick row is gone).
      const openSecurity = async () => {
        if (mobile) {
          await topBarButton(page, '설정');
          await page.getByRole('tab', { name: '보안', exact: true }).click();
          await page.getByTestId('security-open-option').getByRole('button', { name: '보안', exact: true }).click();
        } else await topBarButton(page, '보안');
        await page.getByTestId('security').waitFor();
        await page.getByTestId('session-row').first().waitFor({ timeout: 20_000 });
        await page.waitForTimeout(500);
      };
      if (BEFORE) {
        await openSecurity();
        await shot('before-security');
        continue;
      }

      // ── 설정: the tabs ──
      await topBarButton(page, '설정');
      const tablist = page.getByTestId('settings-tabs');
      await tablist.waitFor();
      const tabText = (els: Element[]) => els.map((e) => e.lastChild?.textContent ?? '');
      const selectedTab = async () => (await tablist.getByRole('tab', { selected: true }).evaluateAll(tabText))[0];
      const names = await tablist.getByRole('tab').evaluateAll(tabText);
      check(names.join(',') === TABS.map(([n]) => n).join(','), `${tag}: tabs are ${names.join(' ')}`);
      if (first) check((await selectedTab()) === '일반', `${tag}: a new browser opens on 일반`);
      const dialog = page.getByRole('dialog').last();
      if (!mobile) {
        const xs = await tablist.getByRole('tab').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
        check(new Set(xs).size === 1, `${tag}: the tabs are a column on the left (x ${xs.join(',')})`);
      }
      if (MISALIGN) {
        await page.addStyleTag({ content: '[data-testid="nameplates-option"] [data-setting-control] { margin-right: 12px }' });
      }
      for (const [name, ids] of TABS) {
        await page.getByRole('tab', { name, exact: true }).click();
        await page.mouse.move(1, 1); // no row hovered
        for (const id of ids) {
          check(await page.getByTestId(id).first().isVisible(), `${tag}: ${name} tab shows ${id}`);
        }
        const m = await measure();
        console.log(`${tag} ${name}: ${JSON.stringify(m)}`);
        const shown = m.shown + m.scroll;
        check(shown <= m.shown * MAX_SCREENS, `${tag}: ${name} needs ${(shown / m.shown).toFixed(2)} screens`);
        check(m.sideways <= 0, `${tag}: ${name} has no sideways scroll`);
        if (!mobile) {
          check(m.dialog.w <= FRAME.w && m.dialog.h <= FRAME.h, `${tag}: the window is ${m.dialog.w}x${m.dialog.h} (at most 960x768)`);
          check(new Set(m.heights).size === 1, `${tag} ${name}: every row is one height (${[...new Set(m.heights)].join(',')})`);
          check(m.rights.length > 0 && Math.max(...m.rights) - Math.min(...m.rights) <= 0.5, `${tag} ${name}: every control ends at x ${[...new Set(m.rights)].join(',')}`);
          check(m.buttonHeights.length === 1, `${tag} ${name}: one button height (${m.buttonHeights.join(',')})`);
          check(m.cut.length === 0, `${tag} ${name}: no name cut (${m.cut.join(',')})`);
        }
        check(m.past.length === 0, `${tag} ${name}: no button past the row's edge (${m.past.join(',')})`);
        check(m.overlaps.length === 0, `${tag} ${name}: no control covers a name (${m.overlaps.join(',')})`);
        check(m.gaps.every((g) => g === CHOICE_GAP), `${tag} ${name}: a choice's buttons are ${CHOICE_GAP} apart (${[...new Set(m.gaps)].join(',')})`);
        if (name === '화면') {
          check(m.heights.length >= (mobile ? 12 : 15), `${tag}: 화면 has ${m.heights.length} rows`);
          if (!mobile) check(m.scroll <= 0, `${tag}: 화면 fits without scrolling (${m.scroll}px over)`);
          // The hint line: hovering a row shows its help there, and the rows do not move.
          if (!mobile) {
            await page.getByTestId('background-mix-option').hover();
            const hint = (await page.getByTestId('settings-hint').textContent()) ?? '';
            check(hint.startsWith('건물 둘레') && hint.includes('길과 터는 그대로'), `${tag}: hovering 건물 둘레 shows its help (${hint.slice(0, 40)})`);
            const after = await measure();
            check(after.scroll === m.scroll && after.shown === m.shown, `${tag}: the hint line moves no row`);
          }
        }
        await shot(TAB_FILES[name]);
      }
      // Every panel's settings are in some tab: nothing dropped.
      const all = TABS.flatMap(([, ids]) => ids);
      for (const id of [...all, 'access-option']) check((await page.getByTestId(id).count()) >= 1, `${tag}: ${id} exists`);
      if (!mobile) check((await page.getByTestId('hud-preset-option').count()) === 1, `${tag}: layout presets exist`);
      check((await page.getByText('가장자리 스크롤').count()) + (mobile ? 1 : 0) >= 1, `${tag}: edge scrolling setting exists`);

      if (!mobile) {
        // ── The keys: ←→ pick in a choice, ↓ to the next row, Esc closes ──
        await page.getByRole('tab', { name: '화면', exact: true }).click();
        const font = page.getByTestId('ui-font-option');
        await font.locator('[aria-pressed="true"]').focus();
        await page.keyboard.press('ArrowRight');
        check((await font.locator('[data-ui-font="readable"]').getAttribute('aria-pressed')) === 'true', `${tag}: → picks 읽기 쉬움`);
        await page.keyboard.press('ArrowLeft');
        check((await font.locator('[data-ui-font="pixel"]').getAttribute('aria-pressed')) === 'true', `${tag}: ← picks 픽셀 감성 again`);
        await page.keyboard.press('ArrowDown');
        check((await page.getByTestId('game-motion-option').locator('[data-setting-row]').getAttribute('data-picked')) === 'true', `${tag}: ↓ goes to 게임 효과, picked`);
        check(((await page.getByTestId('settings-hint').textContent()) ?? '').startsWith('게임 효과'), `${tag}: the picked row's help is on the hint line`);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        check(true, `${tag}: Esc closes 설정`);
        await topBarButton(page, '설정');
      }

      if (first) {
        // ── Picks are kept: close, reload, open again ──
        await page.getByRole('tab', { name: '화면', exact: true }).click();
        await page.getByTestId('nameplates-option').getByRole('button', { name: '끔', exact: true }).click();
        await page.getByTestId('background-time-option').locator('[data-time="night"]').click();
        await page.getByTestId('rank-icon-option').locator('[data-rank-style="medal"]').click();
        await page.getByRole('tab', { name: '일반', exact: true }).click();
        await page.getByTestId('office-hours-options').getByRole('button', { name: '켬', exact: true }).click();
        await page.waitForTimeout(800);
        await dialogX();
        await ready();
        await topBarButton(page, '설정');
        const on = async (testId: string, locator: string) =>
          (await page.getByTestId(testId).locator(locator).first().getAttribute('aria-pressed')) === 'true';
        check(await on('office-hours-options', 'button:has-text("켬")'), `${tag}: 근무 시간 켬 is kept`);
        await page.getByRole('tab', { name: '화면', exact: true }).click();
        check(await on('nameplates-option', 'button:has-text("끔")'), `${tag}: 이름표 끔 is kept`);
        check(await on('background-time-option', '[data-time="night"]'), `${tag}: 배경의 하늘 늘 밤 is kept`);
        check(await on('rank-icon-option', '[data-rank-style="medal"]'), `${tag}: 직급 아이콘 메달 is kept`);
        await shot('display-changed');
      }

      if (!first && !mobile) {
        await ctx.close();
        continue; // the 보안 window and the remembered tab: once on a desktop, once on the phone
      }
      // ── The security panel opened from the 보안 tab ──
      await page.getByRole('tab', { name: '보안', exact: true }).click();
      await page.getByTestId('security-open-option').getByRole('button', { name: '보안', exact: true }).click();
      await page.getByTestId('security').waitFor();
      await page.getByTestId('session-row').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(500);
      await dialogX(); // the security window (the last dialog)
      await dialogX(); // 설정

      // ── The remembered tab ──
      await topBarButton(page, '설정');
      await page.getByRole('tab', { name: '접속', exact: true }).click();
      await dialogX();
      await ready();
      await topBarButton(page, '설정');
      check(
        (await selectedTab()) === '접속',
        `${tag}: the last tab (접속) is remembered across a reload`,
      );
      await dialogX();

      // ── 보안 ──
      await openSecurity();
      const heads = await page.getByTestId('security').locator('h3, [data-testid="audit-toggle"]').allTextContents();
      console.log(`${tag}: sections ${JSON.stringify(heads)}`);
      const at = (needle: string) => heads.findIndex((h) => h.includes(needle));
      check(at('로그인한 기기') === 0, `${tag}: 로그인한 기기 is first`);
      check(at('패스키') === 1 && heads[1].includes('선택'), `${tag}: 패스키 (선택) comes second`);
      check(at('보안 기록') === heads.length - 1, `${tag}: 보안 기록 is last`);
      check((await page.getByTestId('audit-row').count()) === 0, `${tag}: 보안 기록 starts closed (no rows)`);
      const toggle = page.getByTestId('audit-toggle');
      check((await toggle.getAttribute('aria-expanded')) === 'false', `${tag}: its toggle reads closed`);
      const box = async () =>
        page.evaluate(() => {
          const win = document.querySelector('[role="dialog"]:last-of-type, [role="dialog"]') as HTMLElement;
          const dlgs = [...document.querySelectorAll('[role="dialog"]')];
          const dlg = (dlgs.at(-1) ?? win) as HTMLElement;
          const inner = dlg.querySelector('[data-testid="security"]') as HTMLElement;
          const d = dlg.getBoundingClientRect();
          const i = inner.getBoundingClientRect();
          return { winW: d.width, innerW: i.width, gap: d.right - i.right, innerH: window.innerWidth };
        });
      const geometry = await box();
      console.log(`${tag}: window ${geometry.winW}px, content ${geometry.innerW}px, right gap ${geometry.gap}px`);
      check(geometry.gap <= 24 && geometry.winW <= geometry.innerH, `${tag}: the content uses the window's width (gap ${geometry.gap}px)`);
      await shot('security-closed');
      await toggle.click();
      check((await toggle.getAttribute('aria-expanded')) === 'true', `${tag}: one click opens the 보안 기록`);
      await page.getByTestId('audit').locator('p').first().waitFor();
      await page.waitForTimeout(800);
      await page.getByTestId('audit').scrollIntoViewIfNeeded();
      await shot('security-open');
      check((await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)), `${tag}: no page sideways scroll`);
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
