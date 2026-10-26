/**
 * ENV-3: the office on a machine with nothing of the owner's around it. The built
 * daemon (dist/cli.js, run by absolute Node path the way the bundle runs its own
 * Node) starts with the installer's flags in an isolated HOME and a strict
 * environment: HOME, XDG_RUNTIME_DIR, LANG and PATH = <home>/bin:/usr/bin:/bin.
 * No ~/.claude plugins, skills, hooks, settings or CLAUDE.md, no hub, no
 * aliases, no node or npm on PATH, no earlier cld-gui config. <home>/bin holds
 * only the fake `claude` (engine.cjs) and fake `codex`, as tiny sh wrappers
 * that exec them with this Node by absolute path.
 *
 * Headless Chromium (--disable-gpu):
 *   1. first open: the office opens; usage reads "Claude/Codex 사용량 알 수 없음"
 *      (no source anywhere, no number invented); HW (with the GPU board), 작업
 *      and Codex tabs render;
 *   2. Claude Code's own rate_limits (fake-rate-limits.json, what the fake hands
 *      the status line) and one Codex session log with rate_limits are put in
 *      HOME; a project is added and started with the fake claude, and a message
 *      goes in through the messenger;
 *   3. a new page: usage shows the numbers from those two sources (the status
 *      line the engine injected kept Claude's; Codex's own log gave Codex's).
 * Then: the injected status line ran cleanly (exit 0, no user line to chain),
 * no page error, no "[cld usage]" warning, and every path of the real HOME the
 * daemon log names is this checkout or this Node (nothing else of the real HOME).
 *
 *   npx tsx cld/test/run-clean-env.ts <port 18256-18259>
 */
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  answerNewAgentChoice,
  assertPortFree,
  FAKE_CLAUDE,
  killFakeSessions,
  launchBrowser,
  openOfficeWindow,
  openWorkbenchTab,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
// @ts-expect-error the installer is plain ESM without types
import { daemonArgs, defaults } from '../install/install.mjs';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/clean-env');
const DEADLINE_MS = 240_000;
const REAL_HOME = os.userInfo().homedir;
const NODE_DIR = path.dirname(process.execPath);

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

function wrapper(file: string, target: string): void {
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`);
  fs.chmodSync(file, 0o755);
}

/** Paths of the real HOME a text names, other than this checkout and this Node. */
function realHomePaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(
    new RegExp(`${REAL_HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s'"),]*`, 'g'),
  )) {
    const p = m[0];
    if (!p.startsWith(REPO_ROOT) && !p.startsWith(NODE_DIR)) out.add(p);
  }
  return [...out];
}

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-clean-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  wrapper(path.join(bin, 'claude'), fs.realpathSync(path.join(FAKE_CLAUDE, 'engine.cjs')));
  wrapper(path.join(bin, 'codex'), path.join(REPO_ROOT, 'cld/test/fake-codex/codex'));
  const PATH = [bin, '/usr/bin', '/bin'].join(':');
  check(
    !fs.existsSync(path.join(home, '.claude')),
    'the HOME has no ~/.claude (plugins, skills, hooks, settings)',
  );
  check(!fs.existsSync(path.join(home, '.config')), 'the HOME has no earlier cld-gui config');
  check(
    !['node', 'npm', 'hub'].some((c) => fs.existsSync(path.join(bin, c))),
    'PATH has no node, npm or hub of ours (only /usr/bin, /bin and the two fakes)',
  );

  // O4: a clean machine's first open (daemon with --allow-actions) asks which permission mode new agents
  // start with, in a tour over the office: run-o4 covers that; here it is answered beforehand.
  answerNewAgentChoice(home);
  const flags = (
    daemonArgs({ ...defaults, port, readOnly: false, chat: true, allowTerminal: true }) as string[]
  ).slice(2);
  console.log(`daemon flags: ${flags.join(' ')}`);
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
  const summary: string[] = [];
  try {
    const url = await loginUrl;
    browser = await launchBrowser();
    const openPage = async (): Promise<Page> => {
      const ctx = await browser!.newContext({ viewport: { width: 1400, height: 900 } });
      await ctx.addInitScript(() => {
        if (!localStorage.getItem('cld.status-tree'))
          localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
      });
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(err.message));
      page.on('console', (msg) => {
        // MSG-UI3: the owner's picture is fetched at /cld/profile/owner.png and is a 404 until one is set.
        if (msg.type() === 'error' && !msg.location().url.includes('/cld/profile/'))
          pageErrors.push(`console: ${msg.text()}`);
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
      return page;
    };
    const body = (page: Page) => page.locator('body').innerText();
    /** A brand-new install shows the 접속 방식 start screen (T-0074): 나중에, as a user may. */
    const passStartScreen = async (page: Page, shot: string) => {
      const later = page.getByRole('button', { name: '나중에' });
      const icons = page.locator('[data-hud-id^="icon:"]').first();
      await Promise.race([
        later.waitFor({ timeout: 15_000 }).catch(() => undefined),
        icons.waitFor({ timeout: 15_000 }).catch(() => undefined),
      ]);
      // The icons are there before the start screen is (it comes with the first office snapshot).
      await later.waitFor({ timeout: 8_000 }).catch(() => undefined);
      if (await later.isVisible().catch(() => false)) {
        await page.screenshot({ path: path.join(OUT, `${shot}.png`) });
        await later.click();
        check(true, `${shot}: the 접속 방식 start screen; 나중에 leaves it`);
      }
      await icons.waitFor();
    };

    // ── 1. First open on a clean machine ──
    let page = await openPage();
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await passStartScreen(page, 'first-open-start-screen');
    await openOfficeWindow(page);
    check(true, 'the office opens on the clean machine');
    await page.getByText('Claude 사용량 알 수 없음').waitFor({ timeout: 15_000 });
    const first = await body(page);
    check(
      first.includes('Codex 사용량 알 수 없음') && !/\b5h\b|\b7d\b/.test(first),
      'usage with no source: Claude and Codex 사용량 알 수 없음, no number shown',
    );
    const usage1 = received.filter((m) => m.type === 'usageState');
    check(
      usage1.length > 0 && usage1.every((m) => m.claude === null && m.codex === null),
      'usageState says unknown (claude null, codex null), nothing invented',
    );
    const engine = [...received].reverse().find((m) => m.type === 'engineState') as
      { agentChoices?: { claude?: unknown; codex?: unknown } } | undefined;
    check(
      !!engine?.agentChoices?.claude && !!engine.agentChoices.codex,
      'provider discovery found claude and codex on PATH (engineState.agentChoices)',
    );
    await page.screenshot({ path: path.join(OUT, 'first-open-usage-unknown.png') });
    const panel = page.locator('[data-hud-window="office"]');
    for (const tab of ['HW']) {
      await panel.getByRole('button', { name: tab, exact: true }).first().click();
      await page.waitForTimeout(700);
      const text = (await panel.innerText()).trim();
      check(
        text.length > 0,
        `현황판 tab ${tab} renders (${text.slice(0, 40).replace(/\n/g, ' ')}…)`,
      );
      if (tab === 'HW') {
        check(text.includes('GPU'), 'the HW tab holds the GPU board (or its empty line)');
        await page.screenshot({ path: path.join(OUT, 'hw-gpu.png') });
      }
    }
    await panel.getByRole('button', { name: '현황판', exact: true }).first().click();
    // UI-C1: the jobs and Codex lists live in the 작업실 (Task and 에이전트 tabs).
    const bench = page.locator('[data-hud-window="workbench"]');
    for (const tab of ['Task', '에이전트']) {
      await openWorkbenchTab(page, tab);
      await page.waitForTimeout(700);
      const text = (await bench.innerText()).trim();
      check(text.length > 0, `작업실 tab ${tab} renders (${text.slice(0, 40).replace(/\n/g, ' ')}…)`);
    }
    await bench.getByRole('button', { name: /닫기/ }).first().click();

    // ── 2. Usage sources appear; a project starts and gets a message ──
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(
      path.join(home, 'fake-rate-limits.json'),
      JSON.stringify({
        five_hour: { used_percentage: 24, resets_at: now + 3 * 3600 },
        seven_day: { used_percentage: 61, resets_at: now + 3 * 86400 },
      }),
    );
    const day = path.join(home, '.codex/sessions/2026/10/24');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(
      path.join(day, 'rollout-clean.jsonl'),
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 73, window_minutes: 300, resets_at: now + 3600 },
            secondary: { used_percent: 27, window_minutes: 10080, resets_at: now + 86400 },
          },
        },
      })}\n`,
    );
    const addButton = panel.getByRole('button', { name: '오케스트레이터 추가', exact: true });
    await addButton.waitFor();
    await addButton.click();
    const form = page.getByRole('form', { name: '오케스트레이터 추가' });
    await form.waitFor();
    const folder = path.join(home, 'projects', 'clean-app');
    fs.mkdirSync(folder, { recursive: true });
    await form.getByLabel('폴더').fill(folder);
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '추가했어요' }).waitFor({ timeout: 15_000 });
    const card = panel
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'clean-app', exact: true }) });
    await card.getByRole('button', { name: '켜기', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '켜기', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '켰어요' }).waitFor({ timeout: 15_000 });
    await card.getByRole('button', { name: '끄기', exact: true }).waitFor({ timeout: 15_000 });
    check(true, 'the project is added and its fake claude session runs (상태 표시: 끄기 offered)');
    await page.screenshot({ path: path.join(OUT, 'project-running.png') });

    await page
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: /^메신저/ })
      .click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await messenger
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: /clean-app/ })
      .click();
    const box = messenger.getByRole('textbox', { name: '보낼 글' });
    await box.fill('깨끗한 PC에서 보내는 첫 메시지');
    await box.press('Enter');
    for (const end = Date.now() + 15_000; ; await page.waitForTimeout(250)) {
      if (received.some((m) => m.type === 'chatSendResult' && m.ok === true)) break;
      if (Date.now() > end) throw new Error('no chatSendResult ok');
    }
    check(true, 'the message to the project went in (chatSendResult ok)');
    await page.screenshot({ path: path.join(OUT, 'message-sent.png') });

    const lineLog = path.join(home, 'fake-statusline.log');
    const lines = fs.existsSync(lineLog)
      ? fs
          .readFileSync(lineLog, 'utf-8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { status: number; stdout: string; stderr: string })
      : [];
    check(
      lines.length > 0 && lines.every((l) => l.status === 0 && !l.stdout && !l.stderr),
      `the status line the engine injected ran cleanly, with no user line to chain (${lines.length} run)`,
    );
    check(
      fs.existsSync(path.join(configDirectory(home), 'usage-claude.json')),
      "it kept Claude Code's rate_limits in the test HOME (usage-claude.json)",
    );

    // ── 3. A new viewer: the numbers from Tycoon's own sources ──
    await page.context().close();
    await new Promise((r) => setTimeout(r, 500)); // the last viewer leaves: the office sleeps
    page = await openPage();
    await page.goto(await daemon.loginUrl()); // a new browser: a new login code
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await passStartScreen(page, 'second-open-start-screen');
    await page.getByText('24%').first().waitFor({ timeout: 15_000 });
    const after = await body(page);
    check(
      /Claude[\s\S]*5h 24%[\s\S]*7d 61%/.test(after) &&
        /Codex[\s\S]*5h 73%[\s\S]*7d 27%/.test(after),
      'usage from our own sources: Claude 5h 24% 7d 61% (status line), Codex 5h 73% 7d 27% (its log)',
    );
    await page.screenshot({ path: path.join(OUT, 'usage-own-sources.png') });

    // ── Verdicts ──
    check(pageErrors.length === 0, `no page errors${pageErrors.map((e) => `\n  ${e}`).join('')}`);
    const log = serverLog.join('');
    check(!log.includes('[cld usage]'), 'the daemon logged no usage warning');
    const outside = realHomePaths(
      [log, fs.readFileSync(path.join(home, 'fake-claude.log'), 'utf-8')].join('\n'),
    );
    check(
      outside.length === 0,
      `the daemon log and the fake's call log name nothing of the real HOME but this checkout and this Node${outside.map((p) => `\n  ${p}`).join('')}`,
    );
    summary.push(
      `flags: ${flags.join(' ')}`,
      `PATH: <home>/bin:/usr/bin:/bin (node by absolute path: ${process.execPath.replace(REAL_HOME, '~')})`,
      `status line runs: ${lines.length}`,
      `page errors: ${pageErrors.length}`,
      `usageState messages: ${received.filter((m) => m.type === 'usageState').length}`,
    );
  } finally {
    await browser?.close();
    await daemon.stop();
    clearTimeout(deadline);
    fs.writeFileSync(path.join(OUT, 'summary.txt'), `${summary.join('\n')}\n`);
    fs.writeFileSync(
      path.join(OUT, 'server-log.txt'),
      serverLog
        .join('')
        .replaceAll(home, '<clean-home>')
        .replaceAll(REPO_ROOT, '<repo>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    cleanupHome();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
