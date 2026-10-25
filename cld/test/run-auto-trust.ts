/**
 * AUTO-TRUST visual check: dist/cli.js on a spare port with an isolated HOME and the engine's fake
 * `claude`, whose interactive mode shows Claude Code 2.1.310's folder-trust dialog (trust-tui.cjs).
 *
 * Desktop 1280×800: 오케스트레이터 추가 says under the folder that it answers Claude's trust question;
 * the added project's 켜기 shows 폴더 신뢰 중… on its card, then it is on and the toast says the
 * question was answered (the folder's .fake-untrusted is gone: the fake's answer recorded).
 * Phone 393×852: a folder whose claude crashes at the question: 켜기 ends with today's manual
 * message, the card keeps the manual way and says what 켜기 does.
 * Screenshots into cld/artifacts/auto-trust/, Hangul from malgun.ttf (read only).
 *
 *   npx tsx cld/test/run-auto-trust.ts <port 18256-18259>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { TRUST_ARGS } from '../../server/src/cld/engine/trust.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/auto-trust');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__autotrust/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 180_000;
const ADD = '오케스트레이터 추가';
const ADD_HELP = '추가하면 Claude 가 이 폴더를 신뢰하도록 대신 답합니다';
const CARD_HELP = '켜기를 누르면 Claude 가 이 폴더를 신뢰하도록 대신 답합니다';
const RUNNING = '폴더 신뢰 중…';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(path.join(home, '.config/cld-gui/config.json'), JSON.stringify({ accessChosen: true, port }));
  const folder = (name: string, mode?: string) => {
    const d = path.join(home, 'projects', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.fake-untrusted'), '');
    if (mode) fs.writeFileSync(path.join(d, '.fake-trust'), mode);
    return d;
  };
  const alphaDir = folder('alpha-app');
  const betaDir = folder('beta-app', 'crash');
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine',
    'on',
    '--no-terminal',
    '--allow-actions',
  ]);
  const { child: server, log: serverLog } = daemon;
  const cleanupHome = () => {
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    cleanupHome();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  let browser: Browser | undefined;
  const font = fs.readFileSync(FONT);
  const open = async (opts: Parameters<Browser['newContext']>[0]) => {
    const ctx = await browser!.newContext(opts);
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    await ctx.route('**/__autotrust/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
    return { ctx, page: await ctx.newPage() };
  };
  const hangul = async (page: Page) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };
  const card = (scope: Locator, page: Page, name: string) =>
    scope.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const toast = (page: Page, text: string) =>
    page.getByRole('status').filter({ hasText: text }).waitFor({ timeout: 20_000 });

  try {
    browser = await launchBrowser();
    const loginUrl = await daemon.loginUrl();

    // ── Desktop: add, then 켜기 answers the question ──
    const { ctx: desk, page } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page);
    await hangul(page);
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    await drawer.getByRole('button', { name: ADD, exact: true }).click();
    const form = page.getByRole('form', { name: ADD });
    await form.waitFor();
    await form.getByLabel('폴더').fill(alphaDir);
    check((await form.textContent())?.includes(ADD_HELP), 'the add form says it answers the trust question');
    await shot(page, 'desktop-add-form');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await toast(page, '추가했어요');
    const alpha = card(drawer, page, 'alpha-app');
    await alpha.getByRole('button', { name: '켜기', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '켜기', exact: true }).click();
    await alpha.getByText(RUNNING, { exact: true }).waitFor({ timeout: 20_000 });
    await shot(page, 'desktop-trusting');
    check(true, `the card shows ${RUNNING} while it runs`);
    await toast(page, '대신 답하고 켰어요');
    await alpha.getByRole('button', { name: '끄기', exact: true }).waitFor({ timeout: 20_000 });
    check(!fs.existsSync(path.join(alphaDir, '.fake-untrusted')), 'the fake recorded the answer');
    check((await alpha.getByText(RUNNING).count()) === 0, `${RUNNING} goes away`);
    await shot(page, 'desktop-started');

    // ── Phone: a crash at the question keeps today's manual way ──
    const { page: phone } = await open({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      storageState: await desk.storageState(),
    });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    await phone.locator('[data-hud-id^="icon:"]').getByRole('button', { name: '현황판', exact: true }).click();
    const panel = phone.getByLabel('현황판 화면');
    await panel.getByRole('button', { name: ADD, exact: true }).tap();
    const pform = phone.getByRole('form', { name: ADD });
    await pform.waitFor();
    await pform.getByLabel('폴더').fill(betaDir);
    check((await pform.textContent())?.includes(ADD_HELP), 'the phone add form says it too');
    await shot(phone, 'phone-add-form');
    await pform.getByRole('button', { name: '추가', exact: true }).tap();
    await toast(phone, '추가했어요');
    const beta = card(panel, phone, 'beta-app');
    await beta.getByRole('button', { name: '켜기', exact: true }).tap();
    const pdialog = phone.getByRole('alertdialog');
    await pdialog.waitFor();
    await pdialog.getByRole('button', { name: '켜기', exact: true }).tap();
    await toast(phone, '폴더 신뢰 확인 필요');
    await beta.getByText(CARD_HELP, { exact: false }).waitFor({ timeout: 20_000 });
    const text = (await beta.textContent()) ?? '';
    check(text.includes('Yes, I trust this folder') && text.includes(`cd ${betaDir}`), 'the manual way stays on the card');
    await beta.scrollIntoViewIfNeeded();
    await shot(phone, 'phone-needs-trust');
    const runs = engineCalls(home).filter((c) => c.argv.join(' ') === TRUST_ARGS.join(' '));
    check(runs.length === 2, 'one trust step per 켜기 (alpha, beta), none anywhere else');
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
    fs.writeFileSync(
      path.join(OUT, 'server-log.txt'),
      serverLog
        .join('')
        .replaceAll(home, '<fake-home>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    cleanupHome();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
