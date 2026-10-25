/**
 * SETTINGS-TABS check: dist/cli.js with an isolated HOME on a spare port, headless
 * Chromium (--disable-gpu), desktop 1920x1080 and phone 390x844.
 * - 설정 is five tabs (일반 화면 접속 보안 고급); every former setting sits in one of them;
 *   a tab's content fits without a long scroll; the last tab is remembered across a reload;
 * - 보안: 로그인한 기기 comes first, 패스키 (선택) after it, sections are boxes, the window
 *   leaves no empty strip on the right, 보안 기록 is closed until clicked.
 * With BEFORE=1 (run from a checkout of the old build) it only screenshots the old 보안 panel
 * into OUT_DIR. Screenshots to cld/artifacts/settings-tabs/.
 *
 *   npx tsx cld/test/run-settings-tabs.ts <port 18256-18259>
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
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const BEFORE = process.env.BEFORE === '1';
const OUT = process.env.OUT_DIR ?? path.join(REPO_ROOT, 'cld/artifacts/settings-tabs');
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
      ['desktop', { width: 1920, height: 1080 }, false],
      ['phone', { width: 390, height: 844 }, true],
    ] as const) {
      const ctx = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
        deviceScaleFactor: mobile ? 2 : 1,
      });
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
      await ctx.route('**/__st/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      const ready = async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.addStyleTag({ content: FONT_CSS });
        await page.getByRole('button', { name: '설정', exact: true }).first().waitFor({ timeout: 60_000 });
        const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
        if (await closeInfo.count()) await closeInfo.first().click();
        await page.waitForTimeout(1_500);
      };
      const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}-${tag}.png`) });
      const dialogX = () => page.getByRole('button', { name: 'x', exact: true }).last().click();
      await ready();

      // The security panel: top bar on the desktop, 설정's quick row on the phone.
      const openSecurity = async () => {
        if (mobile) await page.getByRole('button', { name: '설정', exact: true }).first().click();
        await page.getByRole('button', { name: '보안', exact: true }).first().click();
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
      await page.getByRole('button', { name: '설정', exact: true }).first().click();
      const tablist = page.getByTestId('settings-tabs');
      await tablist.waitFor();
      const names = await tablist.getByRole('tab').allTextContents();
      check(names.join(',') === TABS.map(([n]) => n).join(','), `${tag}: tabs are ${names.join(' ')}`);
      check(
        (await page.getByTestId('settings-tabs').getByRole('tab', { selected: true }).textContent()) === '일반',
        `${tag}: a new browser opens on 일반`,
      );
      const dialog = page.getByRole('dialog').last();
      for (const [name, ids] of TABS) {
        await page.getByRole('tab', { name, exact: true }).click();
        for (const id of ids) {
          check(await page.getByTestId(id).first().isVisible(), `${tag}: ${name} tab shows ${id}`);
        }
        const fit = await dialog.evaluate((el) => ({ scroll: el.scrollHeight, shown: el.clientHeight, w: el.scrollWidth, cw: el.clientWidth }));
        check(fit.scroll <= fit.shown * MAX_SCREENS, `${tag}: ${name} needs ${(fit.scroll / fit.shown).toFixed(2)} screens`);
        check(fit.w <= fit.cw, `${tag}: ${name} has no sideways scroll`);
        await shot(`settings-${name}`);
      }
      // Every panel's settings are in some tab: nothing dropped.
      const all = TABS.flatMap(([, ids]) => ids);
      for (const id of [...all, 'access-option']) check((await page.getByTestId(id).count()) >= 1, `${tag}: ${id} exists`);
      if (!mobile) check((await page.getByTestId('hud-preset-option').count()) === 1, `${tag}: layout presets exist`);
      check((await page.getByText('가장자리 스크롤').count()) + (mobile ? 1 : 0) >= 1, `${tag}: edge scrolling setting exists`);

      // ── The security panel opened from the 보안 tab ──
      await page.getByRole('tab', { name: '보안', exact: true }).click();
      await page.getByTestId('security-open-option').getByRole('button', { name: '보안', exact: true }).click();
      await page.getByTestId('security').waitFor();
      await page.getByTestId('session-row').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(500);
      await dialogX(); // the security window (the last dialog)
      await dialogX(); // 설정

      // ── The remembered tab ──
      await page.getByRole('button', { name: '설정', exact: true }).first().click();
      await page.getByRole('tab', { name: '접속', exact: true }).click();
      await dialogX();
      await ready();
      await page.getByRole('button', { name: '설정', exact: true }).first().click();
      check(
        (await page.getByTestId('settings-tabs').getByRole('tab', { selected: true }).textContent()) === '접속',
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
