/**
 * REDEPLOY-STATE (owner 11-04 16:51): a deploy (the daemon restarting, the page reconnecting or
 * reloading) keeps the messenger composer as it was (the text and the files attached but not sent
 * yet) and opens no window by itself (the ones open stay open, on the same tab). dist/cli.js with
 * --engine on --allow-chat in an isolated HOME whose `claude` is the engine fake, headless Chromium
 * (--disable-gpu), desktop 1400x900. The daemon is stopped and started again on the same HOME.
 *
 *   npx tsx cld/test/run-redeploy-state.ts <port 18480-18489>
 *
 * Screenshots: cld/artifacts/redeploy-state-1104/*.png
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  type Daemon,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18480 && port <= 18489)) throw new Error('port must be 18480-18489');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/redeploy-state-1104');
const DEADLINE_MS = 240_000;
const TEXT_BYTES = Buffer.from('redeploy note\n');

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const start = () =>
    startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
      '--engine',
      'on',
      '--allow-chat',
      '--no-terminal',
    ]);
  let daemon: Daemon = start();
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    const c = daemon.child;
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));
  const sessions = path.join(home, '.claude/sessions');
  const hasSession = () =>
    fs.existsSync(sessions) &&
    fs.readdirSync(sessions).some((f) => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as { name?: string }).name === 'alpha';
      } catch {
        return false;
      }
    });

  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const url = await daemon.loginUrl();
    for (const end = Date.now() + 40_000; !hasSession(); ) {
      if (Date.now() > end) throw new Error('the engine did not revive the session');
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 4_000));
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.getByRole('button', { name: /^메신저/ }).click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    const openAlpha = async () => {
      // A reload shows the contact list again; a reconnect keeps the conversation.
      const alpha = messenger.getByRole('region', { name: 'alpha 대화' });
      if (!(await alpha.isVisible()))
        await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).click();
      await alpha.waitFor({ timeout: 20_000 });
      return alpha;
    };
    let alpha = await openAlpha();
    await alpha.getByRole('textbox', { name: '보낼 글' }).fill('배포 뒤에도 남아 있어야 해');
    await alpha
      .getByLabel('첨부 파일 선택', { exact: true })
      .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: TEXT_BYTES });
    await alpha.getByLabel('첨부 파일', { exact: true }).getByText('note.txt').waitFor({ timeout: 10_000 });
    // The windows as the owner left them: the 현황판 open, the 개발실 minimized (its icon pressed in front).
    await page.getByRole('button', { name: '현황판', exact: true }).click();
    const devroom = page.locator('button[data-window][title="개발실"]');
    // The big 현황판 window may lie over the icon column: press the icon as its click does.
    await devroom.dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('[data-hud-window="devroom"]') !== null);
    await devroom.dispatchEvent('click');
    await page.screenshot({ path: path.join(OUT, '01-before-restart.png') });

    const state = async (p: Page) => {
      const a = p.getByRole('region', { name: 'alpha 대화' });
      const shown = await a.isVisible();
      return {
        icons: await p.$$eval('button[data-window]', (els) =>
          Object.fromEntries(els.map((e) => [e.getAttribute('title'), e.getAttribute('data-window')])),
        ),
        windows: await p.$$eval('[data-hud-window]', (els) =>
          els
            .filter((e) => (e as HTMLElement).offsetParent !== null)
            .map((e) => e.getAttribute('data-hud-window'))
            .sort(),
        ),
        text: shown ? await a.getByRole('textbox', { name: '보낼 글' }).inputValue() : null,
        chips: shown ? await a.getByLabel('첨부 파일', { exact: true }).getByText('note.txt').count() : null,
      };
    };
    const before = await state(page);
    console.log('before', JSON.stringify(before));

    // The deploy: the daemon stops and starts again on the same HOME and port.
    await daemon.stop();
    await new Promise((r) => setTimeout(r, 1_500));
    daemon = start();
    await daemon.loginUrl();
    // The page reconnects by itself.
    await page.waitForFunction(() => !document.body.innerText.includes('연결 끊김'), undefined, { timeout: 30_000 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 8_000));
    alpha = await openAlpha();
    const reconnected = await state(page);
    console.log('reconnected', JSON.stringify(reconnected));
    await page.screenshot({ path: path.join(OUT, '02-after-restart-reconnected.png') });

    // A new build reloads the page (the stale-build reload).
    await page.reload();
    await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0);
    await new Promise((r) => setTimeout(r, 8_000));
    const reloadedWindows = await state(page);
    console.log('reloaded (before opening alpha)', JSON.stringify(reloadedWindows));
    await page.screenshot({ path: path.join(OUT, '03-after-reload.png') });
    if (!(await messenger.isVisible())) await page.getByRole('button', { name: /^메신저/ }).click();
    alpha = await openAlpha();
    await alpha.getByLabel('첨부 파일', { exact: true }).getByText('note.txt').waitFor({ timeout: 5_000 }).catch(() => undefined);
    const reloaded = await state(page);
    console.log('reloaded', JSON.stringify(reloaded));
    await page.screenshot({ path: path.join(OUT, '04-after-reload-conversation.png') });

    check(reconnected.text === before.text && reconnected.chips === 1, 'reconnect: the text and the file stay in the composer');
    check(reloaded.text === before.text && reloaded.chips === 1, 'reload: the text and the file stay in the composer');
    check(
      before.icons['개발실'] === 'minimized' && reloadedWindows.icons['개발실'] === 'minimized',
      `reload: the minimized 개발실 stays minimized (${reloadedWindows.icons['개발실']})`,
    );
    check(
      JSON.stringify(reloadedWindows.windows) === JSON.stringify(before.windows.filter((w) => w !== 'messenger')),
      `reload: no window opened by itself, the 현황판 left open is open (${JSON.stringify(reloadedWindows.windows)})`,
    );

    // The file kept through the reload is the file: 보내기 uploads it and the session gets its line.
    await alpha.getByRole('button', { name: '보내기', exact: true }).click();
    const typedLog = path.join(home, 'fake-claude-typed.log');
    const typed = () => (fs.existsSync(typedLog) ? fs.readFileSync(typedLog, 'utf-8') : '');
    for (const end = Date.now() + 40_000; !typed().includes('note.txt'); ) {
      if (Date.now() > end) throw new Error(`the kept file never reached the session: ${typed()}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    check(
      /배포 뒤에도 남아 있어야 해.*\[첨부\] \S+note\.txt \(text\/plain, 1 KB\)/s.test(typed()),
      'reload: 보내기 sends the kept text with the kept file',
    );
    await page.screenshot({ path: path.join(OUT, '05-sent-after-reload.png') });
  } finally {
    await browser?.close();
    await daemon.stop();
    clearTimeout(deadline);
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
