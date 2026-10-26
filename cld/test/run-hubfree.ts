/**
 * T-0033b: the office with no hub anywhere. The built daemon (dist/cli.js) starts
 * with the installer's default flags (plus --allow-actions and --allow-chat, which
 * the add form and the messenger need) in an isolated HOME that has no
 * ~/.local/bin/hub, with a fake `hub` first on PATH that appends its arguments to
 * <home>/hub-calls.log and exits 1. Headless Chromium (--disable-gpu) logs in,
 * opens every floating icon (현황판, 메신저, 알림, 터미널), every tab of the 현황판
 * window (현황판, HW, 작업, Codex, 파일; the GPU board sits in HW) and 설정, adds an
 * engine project with the fake claude, starts it and sends it a message.
 *
 * Checks: hub-calls.log absent or empty, no page errors, every window and tab
 * shows content or its empty-state line, the daemon's log never names hub.
 *
 *   npx tsx cld/test/run-hubfree.ts <port 18256-18259>
 */
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  openWorkbenchTab,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
// @ts-expect-error the installer is plain ESM without types
import { daemonArgs, defaults } from '../install/install.mjs';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0033b');
const DEADLINE_MS = 180_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** The visible text of a locator, trimmed. */
const textOf = async (page: Page, selector: string): Promise<string> =>
  ((await page.locator(selector).first().innerText()) ?? '').trim();

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const hubLog = path.join(home, 'hub-calls.log');
  check(!fs.existsSync(path.join(home, '.local/bin/hub')), 'the HOME has no ~/.local/bin/hub');
  // A fake `hub` that records every call: it must never be run.
  const fakeBin = path.join(home, 'fake-bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, 'hub'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${hubLog}"\nexit 1\n`,
  );
  fs.chmodSync(path.join(fakeBin, 'hub'), 0o755);
  const PATH = [fakeBin, bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');

  // The installer's flags for this config: the first two are --port <n>, which startDaemon adds.
  const flags = (
    daemonArgs({ ...defaults, port, readOnly: false, chat: true, allowTerminal: true }) as string[]
  ).slice(2);
  console.log(`daemon flags: ${flags.join(' ')}`);
  check(!flags.some((f) => f.startsWith('--hub')), 'the installer passes no hub flag');
  const daemon = startDaemon({ home }, port, flags, { PATH, LANG: 'C.UTF-8' }, true);
  const { child: server, log: serverLog } = daemon;
  const loginUrl = daemon.loginUrl();
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
  const pageErrors: string[] = [];
  const received: Array<Record<string, unknown>> = [];
  try {
    const url = await loginUrl;
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    // The 현황판 folds rooms and cards; this run presses buttons inside them (모두 펼치기).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      // MSG-UI3: the owner's picture is fetched at /cld/profile/owner.png and is a 404 until one is set.
      if (msg.type() === 'error' && !msg.location().url.includes('/cld/profile/'))
        pageErrors.push(`console: ${msg.text()} ${msg.location().url}`);
    });
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      }),
    );
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const icon = (name: string) =>
      page.locator('[data-hud-id^="icon:"]').getByRole('button', { name: new RegExp(`^${name}`) });
    const win = (id: string) => page.locator(`[data-hud-window="${id}"]`);
    const shows = async (id: string, what: string) => {
      const text = await textOf(page, `[data-hud-window="${id}"]`);
      check(
        text.length > 0,
        `${what}: the window shows text (${text.slice(0, 40).replace(/\n/g, ' ')}…)`,
      );
    };

    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.locator('[data-hud-id^="icon:"]').first().waitFor();
    await page.waitForTimeout(1_000);

    // ── Every floating icon ──
    await openOfficeWindow(page);
    await shows('office', '현황판');
    await icon('메신저').click();
    await win('messenger').waitFor();
    await shows('messenger', '메신저');
    await icon('알림').click();
    await win('notices').waitFor();
    await shows('notices', '알림');
    await icon('터미널').click();
    await win('terminal').waitFor();
    await shows('terminal', '터미널');
    await shot('icons');
    for (const id of ['terminal', 'notices', 'messenger']) {
      await page
        .getByRole('button', {
          name: new RegExp(
            `^(${id === 'terminal' ? '터미널 창' : id === 'notices' ? '알림' : '메신저'}) 닫기$`,
          ),
        })
        .click()
        .catch(() => undefined);
    }

    // ── The 현황판 tabs and 설정 ──
    await openOfficeWindow(page);
    const panel = win('office');
    for (const tab of ['현황판', 'HW']) {
      await panel.getByRole('button', { name: tab, exact: true }).first().click();
      await page.waitForTimeout(700);
      await shows('office', `현황판 tab ${tab}`);
      await shot(`tab-${tab}`);
    }
    // UI-C1: 파일 is the folder icon's mode of the window (no tab); the jobs and Codex lists are the 작업실's.
    await icon('파일').click();
    await page.waitForTimeout(700);
    await shows('office', '파일 mode');
    await shot('tab-파일');
    for (const tab of ['Task', '에이전트']) {
      await openWorkbenchTab(page, tab);
      await page.waitForTimeout(700);
      await shows('workbench', `작업실 tab ${tab}`);
      await shot(`tab-작업실-${tab}`);
    }
    await icon('현황판').click();
    await panel.getByRole('button', { name: 'HW', exact: true }).first().click();
    await page.waitForTimeout(700);
    check(
      (await textOf(page, '[data-hud-window="office"]')).includes('GPU'),
      'the HW tab holds the GPU board (or its empty line)',
    );
    await page.getByRole('button', { name: '설정', exact: true }).click();
    // SETTINGS-TABS: the layout reset is in the 화면 tab.
    await page.getByRole('tab', { name: '화면', exact: true }).click();
    await page.getByRole('button', { name: '화면 배치 초기화' }).waitFor();
    check(true, '설정 opens its menu');
    await page.getByRole('button', { name: 'x', exact: true }).click(); // the dialog's close
    await panel.getByRole('button', { name: '현황판', exact: true }).first().click();

    // ── An engine project, started, and a message to it ──
    const addButton = panel.getByRole('button', { name: '오케스트레이터 추가', exact: true });
    await addButton.waitFor();
    await addButton.click();
    const form = page.getByRole('form', { name: '오케스트레이터 추가' });
    await form.waitFor();
    const folder = path.join(home, 'projects', 'alpha-app');
    fs.mkdirSync(folder, { recursive: true });
    await form.getByLabel('폴더').fill(folder);
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '추가했어요' }).waitFor({ timeout: 15_000 });
    const card = panel
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'alpha-app', exact: true }) });
    await card.getByRole('button', { name: '켜기', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '켜기', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '켰어요' }).waitFor({ timeout: 15_000 });
    await card.getByRole('button', { name: '끄기', exact: true }).waitFor({ timeout: 15_000 });
    check(true, 'the engine project is added and its fake claude session is running');
    await shot('project-running');

    await icon('메신저').click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await messenger
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: /alpha-app/ })
      .click();
    const box = messenger.getByRole('textbox', { name: '보낼 글' });
    await box.fill('hub 없이 보내는 첫 메시지');
    await box.press('Enter');
    for (const end = Date.now() + 15_000; ; await page.waitForTimeout(250)) {
      if (received.some((m) => m.type === 'chatSendResult' && m.ok === true)) break;
      if (Date.now() > end) throw new Error('no chatSendResult ok');
    }
    check(true, 'the message to the engine project was accepted (chatSendResult ok)');
    await shot('message-sent');
    await page.waitForTimeout(3_000);

    // ── The verdicts ──
    const calls = fs.existsSync(hubLog) ? fs.readFileSync(hubLog, 'utf-8').trim() : '';
    check(
      calls === '',
      `hub-calls.log is absent or empty (${calls ? calls.split('\n').length : 0} calls)`,
    );
    check(pageErrors.length === 0, `no page errors${pageErrors.map((e) => `\n  ${e}`).join('')}`);
    const log = serverLog.join('');
    check(!/\bhub\b/i.test(log), "the daemon's log never names hub");
    fs.writeFileSync(
      path.join(OUT, 'hubfree-summary.txt'),
      `flags: ${flags.join(' ')}\nhub calls: ${calls ? calls.split('\n').length : 0}\npage errors: ${pageErrors.length}\n`,
    );
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
