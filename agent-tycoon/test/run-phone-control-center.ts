/**
 * FEAT-PHONE-CONTROL-CENTER (owner 11-06 19:24): the phone's usage row is the desktop control center's folded
 * usage (logo, name, window, what is left, on one row) above the dock; a tap opens the usage panel as a bottom
 * sheet. dist/cli.js with the engine fake as `claude` and a temp HOME, headless Chromium --disable-gpu,
 * phone 390x844 at 3x in 모던 and 픽셀 감성: the folded row, then the sheet. Photos: agent-tycoon/artifacts/feat-phone-control-center/.
 *
 *   npx tsx agent-tycoon/test/run-phone-control-center.ts <port 19200-19209>
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { assertPortFree, fakeUsage, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port < 19200 || port > 19209) throw new Error('port must be 19200-19209');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-phone-control-center');
const DEADLINE_MS = 180_000;
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
  // Claude: a 5-hour and a week window (85% and 22% left); Codex: 78% left in 5 hours, 40% in the week.
  const usage = await fakeUsage(home, { fiveHour: 15, sevenDay: 78 }, { fiveHour: 22, sevenDay: 60 });
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
  try {
    const url = await daemon.loginUrl();
    browser = await launchBrowser();
    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    if (font) await ctx.route('**/__pcc/malgun.ttf', (r) => r.fulfill({ body: font, contentType: 'font/ttf' }));
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    if (font) await page.addStyleTag({ content: FONT_CSS });
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const row = page.getByTestId('cc-seg-usage');
    await row.waitFor({ timeout: 40_000 });
    await page.getByTestId('party-strip').waitFor({ timeout: 60_000 });

    for (const theme of ['modern', 'pixel'] as const) {
      await page.evaluate((v) => localStorage.setItem('agty.ui-theme', v), theme);
      await page.reload();
      if (font) await page.addStyleTag({ content: FONT_CSS });
      await row.waitFor({ timeout: 40_000 });
      await page.getByTestId('party-strip').waitFor({ timeout: 60_000 });
      await wait(1_500);
      check((await page.locator('html').getAttribute('data-ui-theme')) === theme, `${theme}: the screen style is on`);
      const agents = await row.locator('[data-agent]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-agent'), top: Math.round(e.getBoundingClientRect().top), logo: !!e.querySelector('[data-mark="logo"]') })));
      check(agents.length === 2 && agents[0].top === agents[1].top, `${theme}: two agents on one row (${JSON.stringify(agents)})`);
      check(agents.every((a) => a.logo), `${theme}: each shows its real logo`);
      const rb = (await row.boundingBox())!;
      const dock = (await page.getByTestId('mobile-bottom').boundingBox())!;
      const party = page.getByTestId('party-strip');
      const pb = await party.boundingBox();
      check(rb.y + rb.height <= dock.y + dock.height && rb.height >= 44 && rb.height < 64, `${theme}: the row is ${Math.round(rb.height)} px, inside the bottom band`);
      check(pb && pb.y + pb.height <= rb.y + 1, `${theme}: the party strip sits above the row without overlap`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${theme}: no sideways scroll`);
      await shot(`${theme}-1-folded`);
      await row.tap();
      const sheet = page.getByTestId('cc-usage-sheet');
      await sheet.waitFor({ timeout: 5_000 });
      await wait(400);
      const sb = (await sheet.boundingBox())!;
      const text = (await sheet.innerText()).replace(/\s+/g, ' ');
      check(/Claude/.test(text) && /Codex/.test(text) && /%/.test(text), `${theme}: the sheet lists the agents ("${text}")`);
      check(sb.x === 0 && Math.round(sb.width) === 390 && sb.y + sb.height <= 844 + 1, `${theme}: the sheet spans the width at the bottom`);
      await shot(`${theme}-2-sheet`);
      await page.getByTestId('cc-usage-sheet-close').tap();
      await sheet.waitFor({ state: 'detached' });
      check(true, `${theme}: the close button folds the sheet`);
    }
    await ctx.close();
    console.log(`${oks} checks passed`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
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
