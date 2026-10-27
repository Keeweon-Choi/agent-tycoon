/**
 * AGENT-CLI: Agent Tycoon installed before Claude Code. The built daemon (dist/cli.js) starts in an
 * isolated HOME whose PATH has no claude:
 *   1. the plain office shows the notice (install command for this OS, 다시 찾기);
 *   2. Claude Code 설치 opens a terminal in HOME and runs a fake curl, never the network;
 *   3. 다시 찾기 with claude still missing answers "아직 설치되지 않았어요" and changes nothing;
 *   4. a fake claude (the engine's) is put in <home>/.local/bin, which is not on the daemon's PATH
 *      (the folder an installer uses); 다시 찾기 finds it, the daemon ends itself with exit 75
 *      (CLD_GUI_TEST_RESTART=exit: this runner plays the helper that restarts it; on Windows a hidden helper does, see restartDaemon) and
 *      is started again; the page reconnects and the office has the engine, the notice is gone.
 *
 *   npx tsx cld/test/run-agent-cli.ts <port 18256-18259>
 */
import type { Browser } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findClaude } from '../../server/src/cld/agentCli.js';
import {
  answerNewAgentChoice,
  assertPortFree,
  type Daemon,
  FAKE_CLAUDE,
  killFakeSessions,
  launchBrowser,
  REPO_ROOT,
  sparePort,
  startDaemon,
  waitForDaemon,
} from '../../server/src/cld/testHome.js';
// @ts-expect-error the installer is plain ESM without types
import { daemonArgs, defaults } from '../install/install.mjs';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/agent-cli');
const DEADLINE_MS = 180_000;
const RESTART_EXIT_CODE = 75;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-agent-cli-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'curl'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$HOME/fake-curl.log"\nprintf \'%s\\n\' \'echo AGENT_CLI_FAKE_INSTALL_RAN\'\n',
  );
  fs.chmodSync(path.join(bin, 'curl'), 0o755);
  const PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  check(
    findClaude({ env: { PATH }, home, platform: process.platform }) === null,
    'precondition: no claude on the daemon PATH or in the usual install folders of this HOME',
  );
  answerNewAgentChoice(home);
  const flags = (
    daemonArgs({ ...defaults, port, readOnly: false, chat: true, allowTerminal: true }) as string[]
  ).slice(2);
  const env = { PATH, LANG: 'C.UTF-8', CLD_GUI_TEST_RESTART: 'exit' };
  // The supervisor: a daemon that ends with the restart code is started again, as the logon task does.
  let daemon: Daemon = startDaemon({ home }, port, flags, env, true);
  const logs: string[] = [];
  const exits: Array<number | null> = [];
  let stopping = false;
  const supervise = (d: Daemon) =>
    d.child.once('close', (code) => {
      exits.push(code);
      logs.push(d.log.join(''));
      if (code === RESTART_EXIT_CODE && !stopping) {
        daemon = startDaemon({ home }, port, flags, env, true);
        supervise(daemon);
      }
    });
  supervise(daemon);
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    stopping = true;
    if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  let browser: Browser | undefined;
  const pageErrors: string[] = [];
  const received: Array<Record<string, unknown>> = [];
  try {
    const url = await daemon.loginUrl();
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      }),
    );
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);

    // ── 1. The plain office tells the user to install the agent CLI ──
    const notice = page.getByTestId('agent-cli-notice');
    await notice.waitFor({ timeout: 20_000 }).catch(async (err) => {
      await page.screenshot({ path: path.join(OUT, 'failure-notice.png') });
      console.error(received.map((m) => m.type).join(' '));
      throw err;
    });
    check((await notice.getAttribute('data-state')) === 'missing', 'the notice shows, state missing');
    // CLI-TERMINAL: one command per install step (Windows: Git, then Claude Code through PowerShell)
    const command = (await page.getByTestId('agent-cli-command-claude').innerText()).trim();
    check(
      command ===
        (process.platform === 'win32'
          ? 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"'
          : 'curl -fsSL https://claude.ai/install.sh | bash'),
      `it names this OS's one-line installer (${command})`,
    );
    const text = await notice.innerText();
    check(/claude/.test(text) && text.includes('다시 찾기'), 'it says to run claude once, and has 다시 찾기');
    check(
      !received.some((m) => m.type === 'engineState'),
      'a plain office: the daemon sent no engine state',
    );
    check(daemon.log.join('').includes('[cld] claude not found'), 'the daemon log says plain office');
    await page.screenshot({ path: path.join(OUT, '01-notice-missing.png') });

    // The first open's 접속 방식 question waits for the full office (it grew over the notice and took its clicks).
    await page.waitForTimeout(2_000);
    check(
      (await page.getByRole('dialog').filter({ hasText: '접속 방식 고르기' }).count()) === 0,
      'while Claude Code is missing the access choice does not cover the notice',
    );
    await page.getByRole('button', { name: '접기', exact: true }).click();
    const bar = page.getByTestId('agent-cli-bar');
    await bar.waitFor({ timeout: 10_000 });
    await notice.waitFor({ state: 'detached', timeout: 10_000 });
    check(
      (await bar.isVisible()) && (await page.getByTestId('agent-cli-notice').count()) === 0,
      'folding leaves the install guide bar, not the full notice',
    );
    await page.screenshot({ path: path.join(OUT, '01-folded-bar.png') });
    await bar.getByTestId('agent-cli-expand').click();
    await notice.waitFor({ timeout: 10_000 });
    check(await notice.isVisible(), 'expanding the bar restores the full notice');

    // ── 2. Claude Code 설치 opens a home shell and runs only this HOME's fake curl ──
    // A shell needs a device key, which registers by itself shortly after the code login (as in
    // run-terminal); a code-only session is refused a terminal.
    // (polled from here: waitForFunction took the async predicate's promise for a truthy answer)
    let keyed = false;
    for (let i = 0; i < 30 && !keyed; i++) {
      keyed = await page.evaluate(() =>
        fetch('/api/auth/me')
          .then((r) => (r.ok ? r.json() : null))
          .then((me) => Boolean((me as { deviceId?: string | null } | null)?.deviceId)),
      );
      if (!keyed) await page.waitForTimeout(500);
    }
    check(keyed, 'the page has its device key (a terminal needs one)');
    // The first open asks for the 접속 방식 here too (the AuthLayer now runs in a plain office): 나중에.
    const notNow = page.getByRole('button', { name: '나중에' });
    if (await notNow.waitFor({ timeout: 5_000 }).then(() => true, () => false)) await notNow.click();
    await page.getByRole('button', { name: 'Claude Code 설치', exact: true }).click();
    await bar.waitFor({ timeout: 10_000 });
    await notice.waitFor({ state: 'detached', timeout: 10_000 });
    check(
      (await bar.isVisible()) && (await page.getByTestId('agent-cli-notice').count()) === 0,
      'the install button folds the notice to its bar',
    );
    // wherever the office shows its terminal (the dock's panel, or the plain-mode window)
    const opened = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some(
            (el) => el.offsetParent !== null,
          ),
        undefined,
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(async () => {
        await page.screenshot({ path: path.join(OUT, 'failure-terminal.png') });
        console.error(
          'diag:',
          // anonymous functions only: tsx names arrow functions with a __name the page lacks
          await page.evaluate(() =>
            Promise.all(
              [
                ['/api/auth/me', 'GET'],
                ['/api/shell', 'GET'],
                ['/api/auth/stepup/device', 'POST'],
              ].map(([u, method]) =>
                fetch(u, { method }).then(
                  async (r) => `${method} ${u} ${r.status} ${(await r.text()).slice(0, 300)}`,
                ),
              ),
            ).then((lines) => lines.join('\n')),
          ),
        );
        return false;
      });
    check(opened, 'the Claude Code install button opens a terminal');
    check(await bar.isVisible(), 'the folded bar leaves the opened terminal visible');
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some(
          (el) => el.offsetParent !== null && el.innerText.includes('AGENT_CLI_FAKE_INSTALL_RAN'),
        ),
      undefined,
      { timeout: 20_000, polling: 'raf' },
    );
    check(true, 'within 20 s the terminal shows AGENT_CLI_FAKE_INSTALL_RAN');
    check(
      fs.readFileSync(path.join(home, 'fake-curl.log'), 'utf8').trim() ===
        '-fsSL https://claude.ai/install.sh',
      'fake-curl.log records -fsSL https://claude.ai/install.sh',
    );
    await page.screenshot({ path: path.join(OUT, '04-install-from-terminal.png') });
    // The bar's 터미널 brings the closed terminal window back (owner 10-27: the plain office has no dock).
    const xtermShown = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some((el) => el.offsetParent !== null),
      );
    await page.getByRole('dialog').filter({ hasText: '터미널' }).locator('[data-modal-title] button').click();
    await page.waitForFunction(
      () => ![...document.querySelectorAll<HTMLElement>('.xterm-rows')].some((el) => el.offsetParent !== null),
      undefined,
      { timeout: 10_000 },
    );
    check(!(await xtermShown()), 'closing the terminal window hides the terminal');
    await bar.getByTestId('agent-cli-terminal').click();
    await page.waitForFunction(
      () => [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some((el) => el.offsetParent !== null),
      undefined,
      { timeout: 10_000 },
    );
    check(await xtermShown(), "the folded bar's 터미널 opens the terminal again");

    const readOnlyContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const readOnlyPage = await readOnlyContext.newPage();
    await readOnlyPage.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        try {
          const received = JSON.parse(String(message)) as { type: string; readOnly?: boolean };
          if (received.type === 'officeAccess') received.readOnly = true;
          ws.send(JSON.stringify(received));
        } catch {
          ws.send(message);
        }
      });
      ws.onMessage((message) => server.send(message));
    });
    await readOnlyPage.goto(await daemon.loginUrl());
    await readOnlyPage.waitForURL(`http://127.0.0.1:${port}/`);
    const readOnlyNotice = readOnlyPage.getByTestId('agent-cli-notice');
    await readOnlyNotice.waitFor({ timeout: 20_000 });
    check(
      (await readOnlyNotice.isVisible()) &&
        (await readOnlyNotice.locator('[data-testid^="agent-cli-install-"]').count()) === 0,
      'a read-only viewer sees the notice without install buttons',
    );
    await readOnlyContext.close();

    // ── 3. 다시 찾기 from the folded bar with nothing installed ──
    await bar.getByTestId('agent-cli-again').click();
    await notice.waitFor({ timeout: 10_000 });
    await page.getByTestId('agent-cli-still').waitFor({ timeout: 10_000 });
    check(
      (await page.getByTestId('agent-cli-still').innerText()).includes('아직 설치되지 않았어요'),
      'rechecking from the bar unfolds the notice and says it is still not installed',
    );
    check((await notice.getAttribute('data-state')) === 'missing', 'still missing: nothing restarted');
    check(exits.length === 0, 'the daemon is still the first one');
    await page.screenshot({ path: path.join(OUT, '02-still-missing.png') });

    // ── 4. The installer puts claude where the daemon's PATH does not reach; 다시 찾기 ──
    const localBin = path.join(home, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    const wrapperFile = path.join(localBin, 'claude');
    fs.writeFileSync(
      wrapperFile,
      `#!/bin/sh\nexec "${process.execPath}" "${fs.realpathSync(path.join(FAKE_CLAUDE, 'engine.cjs'))}" "$@"\n`,
    );
    fs.chmodSync(wrapperFile, 0o755);
    const firstPid = daemon.child.pid;
    await page.getByTestId('agent-cli-again').click();
    for (const stop = Date.now() + 30_000; exits.length === 0; ) {
      if (Date.now() > stop) throw new Error('the daemon did not end for its restart');
      await new Promise((r) => setTimeout(r, 100));
    }
    check(exits[0] === RESTART_EXIT_CODE, `the plain daemon ended itself with the restart code ${RESTART_EXIT_CODE}`);
    check(
      logs[0].includes(`agent CLI found at ${wrapperFile}`),
      'its log says where it found claude (a folder its PATH lacks)',
    );
    check(daemon.child.pid !== firstPid, 'the supervisor started the daemon again');
    await waitForDaemon(port, daemon.child.pid!, 30_000, home);
    await notice.waitFor({ state: 'detached', timeout: 30_000 });
    check(true, 'the page reconnected and the notice is gone');
    // Any engineState is the restarted office's: the plain one sent none (checked above). Counting only
    // what came after the notice went missed one that arrived with the reconnect, before it.
    for (const stop = Date.now() + 30_000; !received.some((m) => m.type === 'engineState'); ) {
      if (Date.now() > stop) throw new Error('no engineState after the restart');
      await new Promise((r) => setTimeout(r, 100));
    }
    check(true, 'the restarted office sent its engine state (full office)');
    const log2 = daemon.log.join('');
    check(log2.includes(`[cld] claude: ${wrapperFile}`) && /\[cld\] engine on/.test(log2), 'its log: claude found, engine on');
    // The full office's first open asks for the 접속 방식 (it names this PC's networks): 나중에, as a user may.
    // (answered already when the plain office asked it first)
    const later = page.getByRole('button', { name: '나중에' });
    if (await later.waitFor({ timeout: 5_000 }).then(() => true, () => false)) await later.click();
    await page.locator('[data-hud-id^="icon:"]').first().waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, '03-full-office.png') });
    check(pageErrors.length === 0, `no page errors${pageErrors.map((e) => `\n  ${e}`).join('')}`);
  } finally {
    stopping = true;
    await browser?.close();
    await daemon.stop();
    clearTimeout(deadline);
    fs.writeFileSync(
      path.join(OUT, 'server-log.txt'),
      [...logs, daemon.log.join('')]
        .join('\n--- restart ---\n')
        .replaceAll(home, '<home>')
        .replaceAll(REPO_ROOT, '<repo>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
