/**
 * FEAT-HUD-SUMMARY-STYLES (owner 11-06 22:23, T-66): the bottom-left summary in three styles (컨트롤 센터, 카드 쌓기,
 * 얇은 상태줄) in both screen styles at 1600x1000, and the folded usage rows with a plan's 5 hours and week side by
 * side (Codex: both; Claude: the week only) on the PC and on the phone strip (WebKit 390x844). dist/cli.js with the
 * engine fake as `claude` and a temp HOME, headless Chromium --disable-gpu. Photos: agent-tycoon/artifacts/feat-hud-summary-styles/.
 *
 *   npx tsx agent-tycoon/test/run-feat-hud-summary-styles.ts <port 19210-19219>
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { assertPortFree, fakeUsage, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port < 19210 || port > 19219) throw new Error('port must be 19210-19219');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-hud-summary-styles');
const DEADLINE_MS = 280_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__pcc/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'projects.json'), JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]));
  // Claude: a week only (78% used, 22% left, and a Fable week); Codex: a 5-hour window (0% used) and a week (17% used).
  const usage = await fakeUsage(home, { sevenDay: 78, fable: 5 }, { fiveHour: 0, sevenDay: 17 });
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--no-terminal'], usage.env);
  const { child: server } = daemon;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); // our own daemon only
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let webkit: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const url = await daemon.loginUrl();
    browser = await launchBrowser();
    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    if (font) await ctx.route('**/__pcc/malgun.ttf', (r) => r.fulfill({ body: font, contentType: 'font/ttf' }));
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const open = async (style: string, theme: string) => {
      await page.evaluate(([s, t]) => {
        localStorage.setItem('agty.hud-summary', s);
        localStorage.setItem('agty.ui-theme', t);
      }, [style, theme]);
      await page.reload();
      if (font) await page.addStyleTag({ content: FONT_CSS });
      await page.getByTestId('control-center').waitFor({ timeout: 40_000 });
      await page.locator('[data-testid="cc-seg-usage"] [data-agent="codex"]').waitFor({ timeout: 40_000 });
      await wait(1_500);
    };
    await open('center', 'modern');
    check(await page.getByTestId('cc-tile').isVisible(), 'default: the control center tile is the summary (no setting stored)');

    for (const style of ['center', 'cards', 'line'] as const) {
      for (const theme of ['modern', 'pixel'] as const) {
        const tag = `${style}-${theme}`;
        await open(style, theme);
        check((await page.locator('html').getAttribute('data-ui-theme')) === theme, `${tag}: the screen style is on`);
        check(await page.getByTestId(style === 'center' ? 'cc-tile' : style === 'cards' ? 'cc-cards' : 'cc-strip').isVisible(), `${tag}: its own summary is drawn`);
        // The side-by-side rule: Codex shows 5시간 then 주간, Claude only the week.
        const codex = await page.locator('[data-testid="cc-seg-usage"] [data-agent="codex"] [data-window]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-window'), x: Math.round(e.getBoundingClientRect().left), y: Math.round(e.getBoundingClientRect().top) })));
        const claude = await page.locator('[data-testid="cc-seg-usage"] [data-agent="claude"] [data-window]').evaluateAll((els) => els.map((e) => e.getAttribute('data-window')));
        // 얇은 상태줄 keeps one window per agent (5 hours first); the others show the pair.
        if (style === 'line') check(codex.length === 1 && codex[0].id === '5h', `${tag}: Codex shows one window, the 5 hours (${JSON.stringify(codex)})`);
        else check(codex.length === 2 && codex[0].id === '5h' && codex[1].id === '7d' && codex[0].x < codex[1].x && codex[0].y === codex[1].y, `${tag}: Codex shows 5h and 7d side by side (${JSON.stringify(codex)})`);
        check(claude.length === 1 && claude[0] === '7d', `${tag}: Claude, week only, shows the week (${claude})`);
        for (const id of ['cc-seg-notices', 'cc-seg-usage', 'cc-seg-running', 'cc-clock', 'hud-menu'])
          check((await page.getByTestId(id).count()) >= 1, `${tag}: ${id} is there`);
        const box = (await page.getByTestId('control-center').boundingBox())!;
        console.log(`  ${tag}: summary ${Math.round(box.width)} x ${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}`);
        await shot(`${tag}-1-folded`);

        // the same actions: notices, usage, menu
        await page.getByTestId('cc-seg-notices').first().click();
        check(await page.getByTestId('cc-notice-pop').isVisible(), `${tag}: the notifications segment opens the notification panel`);
        await page.getByTestId('cc-seg-notices').first().click();
        if (style === 'cards') {
          await page.getByTestId('cc-card-agent').first().click();
          await page.locator('[data-testid="cc-agent"]').first().waitFor({ timeout: 5_000 });
          check((await page.locator('[data-testid="cc-window"]').count()) >= 2, `${tag}: an agent row opens its windows in place`);
        } else {
          await page.getByTestId('cc-seg-usage').click();
          await page.getByTestId('cc-usage-pop').waitFor({ timeout: 5_000 });
          const rows = await page.locator('[data-testid="cc-usage-pop"] [data-testid="cc-window"]').count();
          check(rows >= 4, `${tag}: the usage segment opens the usage panel (${rows} windows)`);
        }
        await wait(300);
        await shot(`${tag}-2-usage`);
        if (style === 'cards') await page.getByTestId('cc-card-agent').first().click();
        else await page.getByTestId('cc-seg-usage').click();
        await page.getByTestId('hud-menu').first().click();
        await page.getByTestId(style === 'center' ? 'cc-center' : 'cc-menu-pop').waitFor({ state: 'visible', timeout: 5_000 });
        check((await page.getByTestId('hud-menu-list').getByRole('button').count()) === 4, `${tag}: the menu holds its four entries`);
        if (theme === 'modern') await shot(`${tag}-3-menu`);
        await page.getByTestId(style === 'center' ? 'cc-close' : 'hud-menu').first().click();
        check((await page.getByTestId('cc-seg-running').count()) >= 1, `${tag}: the running target stays`);
      }
    }

    // 얇은 상태줄 stays one row (36 px of line + 12 of frame) at 1600 and at 1024, clear of the dock, in both styles.
    for (const [width, height] of [[1600, 1000], [1024, 700]] as const) {
      await page.setViewportSize({ width, height });
      for (const theme of ['modern', 'pixel'] as const) {
        await open('line', theme);
        const strip = (await page.getByTestId('cc-strip').boundingBox())!;
        const dockLeft = await page.locator('[data-hud-id^="icon:"]').evaluateAll((els) => Math.min(...els.map((e) => e.getBoundingClientRect().left)));
        const clock = (await page.getByTestId('cc-clock').boundingBox())!;
        const rows = await page.locator('[data-testid="cc-strip"] > *').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
        console.log(`  line ${theme} ${width}: strip ${Math.round(strip.width)} x ${Math.round(strip.height)}, right ${Math.round(strip.x + strip.width)}, dock left ${Math.round(dockLeft)}, clock right ${Math.round(clock.x + clock.width)}`);
        check(rows === 1 && strip.height <= 52, `line ${theme} ${width}: one row, ${Math.round(strip.height)} px high`);
        check(strip.x + strip.width <= dockLeft && clock.x + clock.width <= strip.x + strip.width, `line ${theme} ${width}: clear of the dock, the clock inside the frame`);
        check(await page.getByTestId('cc-clock').isVisible() && (await page.getByTestId('cc-seg-running').isVisible()), `line ${theme} ${width}: running and the clock are in the row`);
        await page.getByTestId('cc-seg-usage').locator('[data-agent]').first().waitFor();
        const windows = await page.locator('[data-testid="cc-strip"] [data-agent]').evaluateAll((els) => els.map((e) => e.querySelectorAll('[data-window]').length));
        check(windows.every((n) => n === 1), `line ${theme} ${width}: each agent shows one window (${windows})`);
        await shot(`line-${theme}-1-folded${width === 1600 ? '' : '-1024'}`);
      }
    }
    await page.setViewportSize({ width: 1600, height: 1000 });

    // The setting: 설정 > 화면 holds it; picking a style switches the summary at once.
    await open('center', 'modern');
    await page.getByTestId('hud-menu').first().click();
    await page.getByTestId('hud-menu-list').getByRole('button', { name: '설정' }).click();
    const dialog = page.getByRole('dialog').first();
    await dialog.locator('#settings-tab-display').click();
    const row = page.getByTestId('summary-style-option');
    await row.waitFor({ timeout: 5_000 });
    await row.scrollIntoViewIfNeeded();
    await shot('setting-row');
    await row.locator('[data-summary-style="line"]').click();
    await page.getByTestId('cc-strip').waitFor({ timeout: 5_000 });
    check((await page.evaluate(() => localStorage.getItem('agty.hud-summary'))) === 'line', 'the setting switches the summary and is stored per browser');
    await ctx.close();

    // the phone strip: WebKit 390x844 at 3x
    webkit = await launchBrowser({ webkit: true });
    const pctx = await webkit.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await pctx.addInitScript('globalThis.__name = (fn) => fn;');
    if (font) await pctx.route('**/__pcc/malgun.ttf', (r) => r.fulfill({ body: font, contentType: 'font/ttf' }));
    const phone: Page = await pctx.newPage();
    phone.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await phone.goto(await daemon.loginUrl());
    await phone.waitForURL(`http://127.0.0.1:${port}/`);
    const prow = phone.getByTestId('cc-seg-usage');
    for (const theme of ['modern', 'pixel'] as const) {
      await phone.evaluate((v) => localStorage.setItem('agty.ui-theme', v), theme);
      await phone.reload();
      if (font) await phone.addStyleTag({ content: FONT_CSS });
      await prow.waitFor({ timeout: 40_000 });
      await phone.getByTestId('party-strip').waitFor({ timeout: 60_000 });
      await wait(1_500);
      const info = await prow.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const agents = [...el.querySelectorAll('[data-agent]')].map((a) => ({ id: a.getAttribute('data-agent'), top: Math.round(a.getBoundingClientRect().top), right: Math.round(a.getBoundingClientRect().right), windows: a.querySelectorAll('[data-window]').length }));
        return { height: Math.round(r.height), width: Math.round(r.width), scroll: el.scrollWidth, client: el.clientWidth, agents, text: (el.textContent ?? '').replace(/\s+/g, ' '), level: el.getAttribute('data-fold-level') };
      });
      console.log(`  phone ${theme}: ${JSON.stringify(info)}`);
      check(info.agents.length === 2 && info.agents[0].top === info.agents[1].top, `phone ${theme}: two agents on one line`);
      check(info.scroll <= info.client, `phone ${theme}: nothing is cut off (${info.scroll} <= ${info.client})`);
      check(info.height < 64, `phone ${theme}: the strip is ${info.height} px high`);
      check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `phone ${theme}: no sideways scroll`);
      await phone.screenshot({ path: path.join(OUT, `phone-${theme}-folded.png`) });
    }
    await pctx.close();
    console.log(`${oks} checks passed`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await webkit?.close();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); // our own daemon only
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
