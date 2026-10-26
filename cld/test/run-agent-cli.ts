/**
 * AGENT-CLI: Agent Tycoon installed before Claude Code. The built daemon (dist/cli.js) starts in an
 * isolated HOME whose PATH has no claude:
 *   1. the plain office shows the notice (install command for this OS, 다시 찾기);
 *   2. 다시 찾기 with claude still missing answers "아직 설치되지 않았어요" and changes nothing;
 *   3. a fake claude (the engine's) is put in <home>/.local/bin, which is not on the daemon's PATH
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
  const PATH = '/usr/bin:/bin';
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
    const command = (await page.getByTestId('agent-cli-command').innerText()).trim();
    check(
      command ===
        (process.platform === 'win32'
          ? 'irm https://claude.ai/install.ps1 | iex'
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

    // ── 2. 다시 찾기 with nothing installed ──
    await page.getByTestId('agent-cli-again').click();
    await page.getByTestId('agent-cli-still').waitFor({ timeout: 10_000 });
    check((await page.getByTestId('agent-cli-still').innerText()).includes('아직 설치되지 않았어요'), 'the notice says it is still not installed');
    check((await notice.getAttribute('data-state')) === 'missing', 'still missing: nothing restarted');
    check(exits.length === 0, 'the daemon is still the first one');
    await page.screenshot({ path: path.join(OUT, '02-still-missing.png') });

    // ── 3. The installer puts claude where the daemon's PATH does not reach; 다시 찾기 ──
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
    const before = received.length;
    for (const stop = Date.now() + 30_000; !received.slice(before).some((m) => m.type === 'engineState'); ) {
      if (Date.now() > stop) throw new Error('no engineState after the restart');
      await new Promise((r) => setTimeout(r, 100));
    }
    check(true, 'the restarted office sent its engine state (full office)');
    const log2 = daemon.log.join('');
    check(log2.includes(`[cld] claude: ${wrapperFile}`) && /\[cld\] engine on/.test(log2), 'its log: claude found, engine on');
    // The full office's first open asks for the 접속 방식 (it names this PC's networks): 나중에, as a user may.
    const later = page.getByRole('button', { name: '나중에' });
    await later.waitFor({ timeout: 15_000 });
    await later.click();
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
