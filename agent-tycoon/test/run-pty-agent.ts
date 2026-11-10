/**
 * TERM-P1 (ADR-0018) end to end: one engine agent in our own PTY host. dist/cli.js with --engine
 * on --allow-chat in a temp HOME whose `claude` is the engine fake (its `-n …` interactive mode is
 * agent-tycoon/test/fake-claude/pty-tui.cjs: session file, OSC 7501, transcript), on a spare port, headless
 * Chromium without GPU.
 *
 *   1. TERM-P3: alpha (registered before P3) runs the old way (`claude --bg`); `agty move-pty alpha`
 *      stops it and resumes the same conversation in the host (no --bg), without CLAUDE* / AI_AGENT,
 *      the OSC 7501 probe answered; the card's 새 터미널 방식 switch then shows on; a new Worker
 *      (`agty worker add`) is a claude-pty agent;
 *   2. a messenger message is typed in (paste + Enter) and answered; 터미널로 보기 shows the host's
 *      screen (no `claude attach`); TERM-P3: a permission the agent asks through its
 *      PermissionRequest hook shows the messenger card, and 허용 there is the hook's decision;
 *   3. the daemon restarts: the host and the agent keep their pids, the next message goes in;
 *   4. the host (ours) is killed: the agent comes back through `--resume` with the same
 *      conversation, and a message goes in again;
 *   5. memory: the daemon, the host with one terminal and with five more (scrollback filled).
 * Screenshots: agent-tycoon/artifacts/pty-agent/.
 *
 *   nice -n 10 taskset -c 0-3 npx tsx agent-tycoon/test/run-pty-agent.ts <port 18256-18269>
 */
import type { Locator, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { registryPath } from '../../server/src/agent-tycoon/engine/registry.js';
import { PtyHostClient } from '../../server/src/agent-tycoon/ptyhost/client.js';
import { ptyhostPaths } from '../../server/src/agent-tycoon/ptyhost/protocol.js';
import {
  assertPortFree,
  type Daemon,
  isFakeOf,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/pty-agent');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__pty/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 420_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until<T>(what: string, fn: () => T | null | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const read = (f: string): string => {
  try {
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return '';
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const rssMb = (pid: number): number => {
  const m = /VmRSS:\s+(\d+) kB/.exec(read(`/proc/${pid}/status`));
  return m ? Math.round(Number(m[1]) / 1024) : 0;
};

async function main() {
  const port = sparePort();
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  // TERM-P3: the hook rides in --settings only: no Claude settings file appears anywhere in this HOME.
  const settingsFiles = () =>
    fs
      .readdirSync(home, { recursive: true })
      .map(String)
      .filter((f) => /(^|\/)\.claude\/settings(\.local)?\.json$/.test(f))
      .sort();
  const settingsBefore = settingsFiles();
  const host = ptyhostPaths(home);
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: false }]),
  );
  const typedLog = path.join(home, 'fake-claude-typed.log');
  const typed = () => read(typedLog).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string; sessionId: string });
  const calls = () =>
    read(path.join(home, 'fake-claude.log'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv: string[]; env: string[] });
  const terminals = () => {
    try {
      return JSON.parse(read(host.terminals)) as Array<{ id: string; pid: number; meta: { assignment?: string } }>;
    } catch {
      return [];
    }
  };
  const hostPid = (): number => {
    const m = [...read(host.log).matchAll(/listening, pid (\d+)/g)].at(-1);
    return m ? Number(m[1]) : 0;
  };
  const sessionOf = (pid: number) => {
    try {
      return JSON.parse(read(path.join(home, '.claude/sessions', `${pid}.json`))) as { sessionId: string; status?: string };
    } catch {
      return null;
    }
  };
  const extra = { FAKE_TURN_MS: '600' };
  const boot = () =>
    startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-actions', '--allow-chat', '--no-terminal'], extra);
  let daemon: Daemon = boot();
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  const ours: number[] = []; // hosts this run killed or must end
  const finish = async (code: number) => {
    await browser?.close().catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    // The host and the fakes are ours (this test HOME's environment), nothing else.
    for (const pid of [hostPid(), ...ours]) if (pid && isFakeOf(pid, home)) process.kill(pid, 'SIGKILL');
    killFakeSessions(home);
    if (code === 0) fs.rmSync(home, { recursive: true, force: true });
    else console.error(`left for a look: ${home}\n--- daemon log tail ---\n${daemon.log.join('').slice(-4000)}`);
    process.exit(code);
  };
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    void finish(1);
  }, DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => void finish(1));
  const mem: Record<string, number> = {};

  try {
    const font = fs.readFileSync(FONT);
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('agty.status-tree')) localStorage.setItem('agty.status-tree', '{"rooms":true,"orchs":true}');
    });
    await ctx.route('**/__pty/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
    const page = await ctx.newPage();
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const login = async () => {
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    };
    await login();
    mem.daemonNoAgent = rssMb(daemon.child.pid!);

    // ── 1. TERM-P3: the old way first, then the move (the CLI), the switch shows it ──
    await openOfficeWindow(page);
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    const card = (): Locator =>
      drawer.locator('article').filter({ has: page.getByRole('heading', { name: 'alpha', exact: true }) });
    await card().getByRole('button', { name: '켜기', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '켜기', exact: true }).click();
    await card().getByRole('button', { name: '끄기', exact: true }).waitFor({ timeout: 30_000 });
    check(calls().some((c) => c.argv[0] === '--bg'), 'alpha (registered before P3) runs the old way: claude --bg');
    const bgSession = await until('the --bg session file', () => {
      for (const f of fs.readdirSync(path.join(home, '.claude/sessions'))) {
        const row = JSON.parse(read(path.join(home, '.claude/sessions', f)) || '{}') as { kind?: string; sessionId?: string };
        if (row.kind === 'bg' && row.sessionId) return row.sessionId;
      }
      return null;
    });
    // The fake --bg keeps no transcript; the real one does (the move resumes only a conversation on disk).
    const transcript = path.join(home, '.claude/projects', folder.replace(/[^a-zA-Z0-9-]/g, '-'), `${bgSession}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    const agty = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home },
        encoding: 'utf-8',
        timeout: 300_000,
      });
    const moved = agty('move-pty', 'alpha');
    check(moved.status === 0, `agty move-pty alpha: ${(moved.stdout + moved.stderr).trim().replaceAll('\n', ' / ')}`);
    check(calls().some((c) => c.argv[0] === 'stop'), 'the old background session was stopped (claude stop)');
    const reg = read(path.join(path.dirname(registryPath(home)), 'assignments.json'));
    check(reg.includes('"claude-pty"'), 'saved: the assignment runs on claude-pty');
    await card().getByRole('button', { name: '설정', exact: true }).click();
    const form = page.getByRole('form', { name: '프로젝트 설정' });
    await form.waitFor();
    // A PTY agent's form opens with its advanced options shown.
    if (!(await form.getByTestId('engine-pty-host').isVisible())) await form.getByRole('button', { name: /고급/ }).click();
    check(await form.getByTestId('engine-pty-host').isChecked(), 'the card\'s 새 터미널 방식 switch shows it');
    await shot('1-moved');
    await form.getByRole('button', { name: '취소', exact: true }).click();
    const added = agty('worker', 'add', 'alpha', 'alpha-w');
    check(added.status === 0, `agty worker add alpha alpha-w: ${(added.stdout + added.stderr).trim()}`);
    const assignments = JSON.parse(read(path.join(path.dirname(registryPath(home)), 'assignments.json'))) as {
      assignments?: Array<{ name?: string; provider?: string }>;
    };
    check(
      JSON.stringify(assignments).includes('"claude-pty"') &&
        (assignments.assignments ?? []).filter((a) => a.provider === 'claude-pty').length >= 2,
      'a new Worker is a claude-pty agent by default',
    );
    const [term] = await until('a host terminal', () => (terminals().length ? terminals() : null));
    const sid = (await until('session file', () => sessionOf(term.pid))).sessionId;
    check(sid === bgSession, `the same conversation in the host: ${sid.slice(0, 8)}`);
    const start = calls().filter((c) => c.argv[0] === '-n').at(-1)!;
    check(start && !start.argv.includes('--bg'), `claude runs in the host, no --bg: claude ${start.argv.slice(0, 6).join(' ')} …`);
    check(start.argv.includes('--permission-mode'), 'the permission mode is always given');
    check(!start.env.some((k) => /^(CLAUDE|AI_AGENT)/.test(k)), 'no CLAUDE* / AI_AGENT in its environment');
    check(read(path.join(home, 'fake-pty-osc.log')).includes(`${term.pid} answered`), 'the OSC 7501 probe was answered before DA1');
    check(
      calls().filter((c) => c.argv[0] === '--bg').length === 1 && !calls().some((c) => c.argv[0] === 'attach'),
      'no claude --bg since the move, no claude attach',
    );
    const pid1 = term.pid;
    const host1 = hostPid();
    mem.daemonOneAgent = rssMb(daemon.child.pid!);
    mem.hostOneTerminal = rssMb(host1);
    await shot('2-running');

    // ── 2. a message, and the terminal view ──
    const send = async (text: string) => {
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      if (!(await messenger.isVisible())) await page.getByRole('button', { name: /^메신저/ }).click();
      const contact = messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ });
      await contact.waitFor({ timeout: 15_000 });
      if (!(await messenger.getByRole('region', { name: 'alpha 대화' }).isVisible())) await contact.click();
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      const box = conv.getByRole('textbox', { name: '보낼 글' });
      await box.fill(text);
      await box.press('Enter');
      const sent = await until(`"${text}" typed in`, () => typed().find((t) => t.text.includes(text)), 30_000);
      // Its answer (the fake's turn echoes the header, message id included) shows in the conversation.
      const id = /⟨m:([a-z2-7]{8})⟩/.exec(sent.text)?.[1] ?? text;
      await conv.getByText(id, { exact: false }).first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1_000);
      return conv;
    };
    const conv = await send('첫 메시지: 안녕');
    check(typed().find((t) => t.text.includes('첫 메시지'))?.sessionId === sid, 'the message went into that conversation (paste + Enter)');
    await shot('3-message-delivered');

    // ── 2b. TERM-P3: a permission through the PermissionRequest hook, answered in the messenger ──
    {
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      if (!(await messenger.isVisible())) await page.getByRole('button', { name: /^메신저/ }).click();
      const c = messenger.getByRole('region', { name: 'alpha 대화' });
      const box = c.getByRole('textbox', { name: '보낼 글' });
      await box.fill('FAKE-PERMISSION 권한 시험');
      await box.press('Enter');
      const permCard = c.getByTestId('permission-card');
      await permCard.waitFor({ timeout: 30_000 });
      check((await permCard.innerText()).includes('rm -rf fake-build'), 'the card names the hook\'s call (its whole command)');
      await shot('3b-permission-card');
      await permCard.getByRole('button', { name: '허용', exact: true }).click();
      const perm = await until('the hook\'s decision', () => read(path.join(home, 'fake-claude-perm.log')).trim(), 30_000);
      check(perm.includes('"behavior":"allow"') && perm.includes(sid), '허용 is the hook\'s decision for that session (no screen read)');
      await permCard.waitFor({ state: 'detached', timeout: 15_000 });
      check(!daemon.log.join('').includes('permission dialog in'), 'no permission dialog read off a screen');
      check(
        JSON.stringify(settingsFiles()) === JSON.stringify(settingsBefore),
        `no Claude settings file written (~/.claude or a project's .claude): ${settingsFiles().join(' ')}`,
      );
    }

    await conv.getByRole('button', { name: '터미널로 보기' }).click();
    await page.waitForFunction(
      () => [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some((el) => el.innerText.includes('fake Claude Code (pty)')),
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(1_000);
    check(daemon.log.join('').includes('(PTY host) gui:'), 'the terminal view joined the host stream');
    check(!calls().some((c) => c.argv[0] === 'attach'), 'still no claude attach');
    mem.daemonViewing = rssMb(daemon.child.pid!);
    await shot('4-terminal-view');
    await page.getByRole('button', { name: /터미널 닫기/ }).first().click().catch(() => undefined);


    // ── 3. the daemon restarts; the agent stays ──
    await daemon.stop();
    check(alive(pid1) && alive(host1), 'daemon stopped: the host and the agent live on');
    daemon = boot();
    await login();
    await openOfficeWindow(page);
    await card().getByRole('button', { name: '끄기', exact: true }).waitFor({ timeout: 30_000 });
    check(terminals()[0]?.pid === pid1 && hostPid() === host1, `after the restart: the same agent pid ${pid1} and host pid ${host1}`);
    check(calls().filter((c) => c.argv[0] === '-n').length === 1, 'no new claude started by the restart');
    await send('재시작 뒤 메시지');
    check(typed().find((t) => t.text.includes('재시작 뒤'))?.sessionId === sid, 'the next message went in after the restart');
    mem.daemonAfterRestart = rssMb(daemon.child.pid!);
    await shot('5-after-daemon-restart');

    // ── 4. the host dies; the agent comes back through --resume ──
    check(isFakeOf(host1, home) && read(`/proc/${host1}/cmdline`).includes('agty-ptyhost.js'), 'the host is ours (this HOME, agty-ptyhost.js)');
    process.kill(host1, 'SIGKILL');
    await until('the agent ends with its host', () => !alive(pid1), 15_000);
    // The engine waits out its adoption look (60 s) and the next watch pass (30 s).
    const [back] = await until('revived in a new host', () => {
      const t = terminals().filter((x) => x.pid !== pid1 && alive(x.pid));
      return t.length && sessionOf(t[0].pid) ? t : null;
    }, 150_000);
    const resumed = calls().filter((c) => c.argv[0] === '-n').at(-1)!;
    check(
      resumed.argv.includes('--resume') && resumed.argv[resumed.argv.indexOf('--resume') + 1] === sid,
      `revived with --resume ${sid.slice(0, 8)} and its flags`,
    );
    check(sessionOf(back.pid)?.sessionId === sid && hostPid() !== host1, 'same conversation, a new host');
    await page.reload();
    await page.addStyleTag({ content: FONT_CSS });
    await openOfficeWindow(page);
    await card().getByRole('button', { name: '끄기', exact: true }).waitFor({ timeout: 30_000 });
    await send('호스트 교체 뒤 메시지');
    check(typed().find((t) => t.text.includes('호스트 교체 뒤'))?.sessionId === sid, 'a message goes in after the revive');
    await shot('6-after-host-revive');

    // ── 5. memory: the host with five more terminals, scrollback full ──
    mem.hostOneTerminalAfterRevive = rssMb(hostPid());
    const client = new PtyHostClient({ home, launch: () => undefined, log: () => undefined });
    await client.connect(false);
    const extraIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await client.spawn({
        file: '/bin/sh',
        args: ['-c', 'seq -f "line %g of the scrollback, long enough to look like real output" 1 3000; sleep 600'],
        cwd: home,
        env: { HOME: home, PATH: '/usr/bin:/bin' },
        cols: 120,
        rows: 40,
        meta: {},
      });
      if (r.ok) {
        extraIds.push(r.id as string);
        ours.push(r.pid as number);
      }
    }
    await new Promise((r) => setTimeout(r, 3_000));
    mem.hostSixTerminals = rssMb(hostPid());
    for (const t of extraIds) await client.call('kill', { t });
    client.dispose();
    mem.daemonEnd = rssMb(daemon.child.pid!);
    console.log(`memory (MB RSS): ${JSON.stringify(mem)}`);
    console.log(
      `per terminal ≈ ${((mem.hostSixTerminals - mem.hostOneTerminalAfterRevive) / 5).toFixed(1)} MB (120×40, 1,000 lines scrollback filled)`,
    );
    fs.writeFileSync(path.join(OUT, 'memory.json'), `${JSON.stringify(mem, null, 2)}\n`);
    clearTimeout(deadline);
    console.log('all checks passed');
    await finish(0);
  } catch (err) {
    console.error(err);
    await page_shot_safe(browser, OUT);
    clearTimeout(deadline);
    await finish(1);
  }
}

/** On a failure: whatever the open page shows. */
async function page_shot_safe(browser: Awaited<ReturnType<typeof launchBrowser>> | undefined, out: string) {
  const page: Page | undefined = browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => undefined);
}

void main();
