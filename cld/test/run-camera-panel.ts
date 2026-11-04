/**
 * HUD-1B + HUD-2B (owner 11-04 16:42, specs/ui-mock-1104/hud2): the 시점 buttons under the elevator's ▲ 1F ▼,
 * and the top bar as a resource bar (usage rows, ≡ 메뉴). dist/cli.js in a temp HOME (the engine's fake
 * claude, a loopback usage endpoint, never a real agent or account), two Leads, two floors, page defaults
 * (launchBrowser `partyFrame: true`), headless Chromium without a GPU.
 *  Desktop 1282x832 (the owner's screen) and 1400x900:
 *  1. 자동 / 내 캐릭터 / 로비 are a 40px strip right under the elevator strip; the lamp is on top, 32px, says 1F
 *  2. ▲ rides to 2F and the lamp says so, ▼ back; the 자동 toggle flips the camera mode and back
 *  3. the usage is two rows (Claude over Codex), the main window 20 cells
 *  4. 메뉴: shut at first; opens with 기기 추가 · 보안 · 범례 · 설정; Esc shuts it (focus back on 메뉴); Tab
 *     moves into the rows; a press outside shuts it; 범례 and 설정 open their dialogs and shut the menu
 *  5. the 메신저 open: 보내기 is what a click hits, and the window draws over the camera strip
 *  Phone 390x844: the camera group bottom-right (its toggle flips), no 메뉴, 설정 on the bar, no sideways scroll.
 * Screenshots: cld/artifacts/hud-1b2b-1104/.
 *
 *   npx tsx cld/test/run-camera-panel.ts <port 18430-18439>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  type Daemon,
  fakeUsage,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18430 && port <= 18439)) throw new Error('port 18430-18439');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/hud-1b2b-1104');
const DEADLINE_MS = 300_000;
const LEADS = ['alpha', 'beta'];
const DESKS: Array<[string, BrowserContextOptions]> = [
  ['1282', { viewport: { width: 1282, height: 832 } }],
  ['1400', { viewport: { width: 1400, height: 900 } }],
];
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const MENU_ROWS = ['기기 추가', '보안', '범례', '설정'];

let failed = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => Promise<unknown> | unknown, timeout = 30_000): Promise<boolean> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (await test()) return true;
    if (Date.now() > end) {
      check(false, `timed out: ${what}`);
      return false;
    }
  }
}
/** Nothing covers the element's centre. */
const onTop = (p: Page, selector: string) =>
  p.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  }, selector);

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const ids = LEADS.map((_, i) => String.fromCharCode(97 + i).repeat(10));
  const folders = LEADS.map((n) => fs.mkdtempSync(path.join(home, `${n}-`)));
  put('projects.json', { v: 2, projects: LEADS.map((n, i) => ({ projectId: `p_${ids[i]}`, name: n, folder: folders[i], room: `${n}-room`, leadAssignmentId: `a_${ids[i]}` })) });
  put('assignments.json', { v: 1, assignments: LEADS.map((_, i) => ({ assignmentId: `a_${ids[i]}`, projectId: `p_${ids[i]}`, role: 'lead', provider: 'claude-pty', model: 'claude-sonnet-4-5', wantRunning: true })) });
  put('building.json', {
    version: 1,
    perProject: false,
    floors: [
      { id: '1', name: '1층', rooms: ['alpha-room'], characters: [] },
      { id: '2', name: '연구실', rooms: ['beta-room'], characters: [] },
    ],
  });
  // An Ultra-like Claude (the week only) and Codex's 5h and week.
  const usage = await fakeUsage(home, { sevenDay: 52 }, { fiveHour: 2, sevenDay: 30 });
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--no-terminal'], {
    FAKE_TURN_MS: '240000',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...usage.env,
  });
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
    process.exit(2);
  }, DEADLINE_MS);
  const revived = (name: string) =>
    fs.readdirSync(path.join(home, '.claude/sessions')).some((f) => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', f), 'utf8')) as { name: string }).name === name;
      } catch {
        return false; // written as we read
      }
    });
  const newPage = async (opts: BrowserContextOptions) => {
    const ctx = await browser!.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    const p = await ctx.newPage();
    p.on('pageerror', (err) => pageErrors.push(String(err)));
    await p.goto(await daemon.loginUrl());
    await p.waitForURL(`http://127.0.0.1:${port}/`);
    const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 4_000 }).catch(() => null);
    const v = toast?.match(/v([\d.]+)/)?.[1];
    if (v) {
      await p.evaluate((x) => localStorage.setItem('cld.changelogSeen', x), v);
      await p.reload();
    }
    return p;
  };
  const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
  const pageErrors: string[] = [];

  try {
    await daemon.loginUrl();
    for (const n of LEADS) await eventually(`${n} revived`, () => revived(n), 90_000);
    browser = await launchBrowser({ partyFrame: true });
    for (const [w, opts] of DESKS) {
      const p = await newPage(opts);
      const lamp = p.getByTestId('elevator-display');
      await lamp.waitFor({ timeout: 30_000 });
      const cam = p.getByTestId('camera-modes');
      await cam.waitFor({ timeout: 10_000 });

      // 1. the strip under the elevator, the floor on top and full size.
      const strip = (await p.locator('.cld-elevator-strip').boundingBox())!;
      const camBox = (await cam.boundingBox())!;
      check(
        Math.abs(camBox.x - strip.x) <= 1 && Math.round(camBox.width) === 40 && camBox.y >= strip.y + strip.height && camBox.y - (strip.y + strip.height) <= 12,
        `${w}: the 시점 strip (40px) sits right under ▲ 1F ▼ (strip ${Math.round(strip.x)},${Math.round(strip.y + strip.height)}; camera ${Math.round(camBox.x)},${Math.round(camBox.y)} ${Math.round(camBox.width)}w)`,
      );
      check((await cam.getByRole('button').count()) === 3, `${w}: three camera buttons`);
      check(
        (await cam.getByRole('button', { name: '내 캐릭터' }).count()) === 1 && (await cam.getByRole('button', { name: '로비' }).count()) === 1,
        `${w}: 내 캐릭터 and 로비 are named icons`,
      );
      const lampSize = await lamp.evaluate((el) => getComputedStyle(el).fontSize);
      check((await onTop(p, '[data-testid="elevator-display"]')) && (await lamp.innerText()).includes('1F') && lampSize === '32px', `${w}: the lamp is on top and says 1F at ${lampSize}`);

      // 2. floors and the camera mode.
      await p.getByTestId('elevator-up').click();
      await eventually(`${w}: 2F lit`, async () => (await lamp.innerText()).includes('2F'), 10_000);
      check((await lamp.innerText()).includes('2F'), `${w}: ▲ rides to 2F and the lamp shows it`);
      if (w === '1282') await shot(p, 'desktop-1282-2F');
      await p.waitForTimeout(1_500);
      await p.getByTestId('elevator-down').click();
      await eventually(`${w}: 1F again`, async () => (await lamp.innerText()).includes('1F'), 10_000);
      const toggle = p.getByTestId('camera-toggle');
      const before = await toggle.getAttribute('data-mode');
      await toggle.click();
      const after = await toggle.getAttribute('data-mode');
      check(before !== after, `${w}: the toggle flips the camera (${before} -> ${after})`);
      await toggle.click();

      // 3. the usage rows.
      const gauges = p.locator('.game-gx-rows [data-testid="usage-gauge"]');
      await eventually(`${w}: two usage rows`, async () => (await gauges.count()) === 2, 30_000);
      const [g1, g2] = [(await gauges.nth(0).boundingBox())!, (await gauges.nth(1).boundingBox())!];
      check(g2.y >= g1.y + g1.height - 1 && Math.abs(g1.x - g2.x) <= 1, `${w}: Claude's row over Codex's (${Math.round(g1.y)} / ${Math.round(g2.y)})`);
      const cells = await gauges.nth(0).locator('[data-main] .game-segbar > i').count();
      check(cells === 20, `${w}: the main window is 20 cells (${cells})`);
      check(/52%|48%/.test((await gauges.nth(0).innerText()) + '') && (await gauges.nth(1).innerText()).includes('%'), `${w}: the percents read (${(await gauges.nth(0).innerText()).replace(/\s+/g, ' ')})`);

      // 4. the menu.
      const menu = p.getByTestId('hud-menu');
      const list = p.getByTestId('hud-menu-list');
      check((await menu.isVisible()) && !(await list.isVisible()), `${w}: 메뉴 is on the bar, shut`);
      check((await p.locator('[data-hud-id="usage"]').getByRole('button', { name: '보안', exact: true }).count()) === 0, `${w}: no 보안 / 기기 추가 / 범례 buttons on the bar itself`);
      await menu.click();
      const rows = (await list.getByRole('button').allInnerTexts()).map((s) => s.trim());
      check(rows.join() === MENU_ROWS.join() && (await menu.getAttribute('aria-expanded')) === 'true', `${w}: 메뉴 opens with ${rows.join(' · ')}`);
      if (w === '1282') await shot(p, 'desktop-1282-menu');
      await p.keyboard.press('Escape');
      check(!(await list.isVisible()) && (await menu.evaluate((b) => document.activeElement === b)), `${w}: Esc shuts it, focus back on 메뉴`);
      await p.keyboard.press('Enter');
      await p.keyboard.press('Tab');
      const tabbed = await list.evaluate((l) => l.contains(document.activeElement) && document.activeElement?.textContent?.trim());
      check(tabbed === '기기 추가', `${w}: Tab moves into the rows (${tabbed})`);
      // Outside the menu: the bar's empty strip left of the clock (the office below would select or open things).
      await p.mouse.click(Math.round((opts.viewport?.width ?? 0) / 2) - 220, 6);
      check(!(await list.isVisible()), `${w}: a press outside shuts it`);
      await menu.click();
      await list.getByRole('button', { name: '범례' }).click();
      const legend = p.getByTestId('activity-legend');
      check(await legend.waitFor({ timeout: 5_000 }).then(() => true).catch(() => false), `${w}: 범례 opens its dialog`);
      check(!(await list.isVisible()), `${w}: picking a row shuts the menu`);
      await p.keyboard.press('Escape');
      await legend.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => p.getByRole('button', { name: 'x', exact: true }).last().click());
      await menu.click();
      await list.getByRole('button', { name: '설정' }).click();
      check(await p.getByTestId('settings-tabs').waitFor({ timeout: 5_000 }).then(() => true).catch(() => false), `${w}: 설정 opens the settings window`);
      await p.keyboard.press('Escape');
      await p.getByTestId('settings-tabs').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => p.getByRole('button', { name: 'x', exact: true }).last().click());

      // 5. the messenger: 보내기 clear, the window over the camera strip.
      await p.locator('[data-hud-id="icon:messenger"]').getByRole('button').click();
      const msgr = p.locator('[data-hud-window="messenger"]');
      await msgr.waitFor({ timeout: 10_000 });
      await msgr.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).click();
      const send = msgr.getByRole('button', { name: '보내기' }).first();
      await send.waitFor({ timeout: 10_000 });
      await p.waitForTimeout(500);
      check(await send.evaluate((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && b.contains(hit); }), `${w}: 보내기 is what a click hits`);
      const under = await p.evaluate(() => {
        const g = document.querySelector('[data-testid="camera-modes"]')!.getBoundingClientRect();
        let over = 0;
        for (const win of document.querySelectorAll('[data-hud-window]')) {
          const b = win.getBoundingClientRect();
          const [x0, x1, y0, y1] = [Math.max(g.left, b.left), Math.min(g.right, b.right), Math.max(g.top, b.top), Math.min(g.bottom, b.bottom)];
          if (x1 <= x0 || y1 <= y0) continue;
          const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
          if (!hit || !win.contains(hit)) over++;
        }
        return over;
      });
      check(under === 0, `${w}: no camera button draws over a window`);
      await shot(p, `desktop-${w}`);
      await p.context().close();
    }

    // Phone.
    const phone = await newPage(PHONE);
    await phone.waitForTimeout(2_500);
    const pt = phone.getByTestId('camera-toggle');
    await pt.waitFor({ timeout: 30_000 });
    const pb = await pt.getAttribute('data-mode');
    await pt.click();
    check(pb !== (await pt.getAttribute('data-mode')), 'phone: the camera toggle flips');
    await pt.click();
    check((await phone.getByTestId('hud-menu').count()) === 0 && (await phone.getByTestId('mobile-top-bar').getByRole('button', { name: '설정' }).isVisible()), 'phone: no 메뉴, 설정 stays on the bar');
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no horizontal scroll');
    await shot(phone, 'phone-390x844');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => undefined);
    killFakeSessions(home);
    await daemon.stop();
    removeTestHome(home);
  }
  console.log(failed ? `\n${failed} failed` : '\nall checks ok');
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
