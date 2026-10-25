/**
 * W2: worktrees tied to Tasks and assignments, end to end. dist/cli.js in a temp HOME (its own
 * port in config.json), a temp project repository, the engine's fake claude as the Lead and as
 * Claude Worker alpha-w1, the fake codex (cld/test/fake-codex) as Codex Worker alpha-c1, on a
 * PATH of our own (never a real claude or codex). Headless Chromium (--disable-gpu).
 * - two Tasks (T-1 for alpha-w1, T-2 for alpha-c1); in the 작업실's Task tab each card gets
 *   "worktree 만들기" (assignee picked, the repository write's confirmation): branch
 *   task/t-<n>-<slug> from main in .worktrees/, recorded with the Task and the assignee;
 * - the cards show worktree ↔ assignee, the worktree tab lists each worktree's Task and assignee;
 * - alpha-w1's next start is in its worktree (the session's cwd), its commit lands there only;
 * - the Lead hands T-2 to alpha-c1 (delegate_task task.id): its Codex run works in T-2's
 *   worktree (the fake commits), the Execution counts that commit (observed);
 * - delegate_task({ worktree: 'new' }) gives T-3 a worktree for alpha-w1 and the message names it;
 * - `cld-gui worktree list --json` says the same.
 * Screenshots in cld/artifacts/w2/ (desktop 1280x800, phone iPhone 13).
 *
 *   nice -n 10 npx tsx cld/test/run-w2.ts <port 18256-18259>
 */
import type { Browser, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CodexRecord } from '../../server/src/cld/engine/codex.js';
import { codexDir } from '../../server/src/cld/engine/codex.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import { tasksPath } from '../../server/src/cld/engine/tasks.js';
import { findOnPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openWorkbenchTab,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/w2');
const FAKE_CODEX = path.join(REPO_ROOT, 'cld/test/fake-codex');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__w2/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
let oks = 0;

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 30_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private next = 1;
  private waiting = new Map<number, (r: Record<string, any>) => void>();
  constructor(server: { command: string; args: string[] }, env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(server.command, server.args, { env, cwd });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d: string) => {
      this.buf += d;
      for (let nl = this.buf.indexOf('\n'); nl !== -1; nl = this.buf.indexOf('\n')) {
        const m = JSON.parse(this.buf.slice(0, nl)) as Record<string, any>;
        this.buf = this.buf.slice(nl + 1);
        this.waiting.get(m.id as number)?.(m);
      }
    });
  }
  request(method: string, params?: unknown): Promise<Record<string, any>> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'run-w2', version: '1' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const r = await this.request('tools/call', { name, arguments: args });
    return JSON.parse(r.result.content[0].text as string) as Record<string, any>;
  }
  close() {
    this.child.stdin.end();
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = path.join(home, '.config/cld-gui');
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  fs.writeFileSync(path.join(home, 'fake-codex.json'), JSON.stringify({ scenarios: ['success'], message: 'API 문서 고쳤어요' }));
  const repo = makeTempRepo();
  const folder = repo.folder;
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] }),
  );
  // Never the user's PATH: the real claude and codex live there. The fakes, node, git.
  const PATH = [FAKE_CODEX, bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  check(findOnPath('codex', PATH) === path.join(FAKE_CODEX, 'codex') && findOnPath('claude', PATH) === path.join(bin, 'claude'), 'the only codex and claude on the daemon’s PATH are the fakes');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '400', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const clients: McpClient[] = [];
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        env: { PATH, HOME: home, CLD_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    type Session = { name: string; cwd: string; sessionId: string; kind?: string };
    const session = (name: string): Session | null => {
      for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as Session;
          if (parsed.name === name) return parsed;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    const records = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[];
      } catch {
        return [];
      }
    };
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    };
    await daemon.loginUrl();
    await eventually('the Lead revived', () => !!session('alpha'));

    // A Claude Worker and a Codex Worker, two Tasks.
    check(json(cli('worker', 'add', 'alpha', 'alpha-w1')).ok === true, 'cld-gui worker add alpha alpha-w1 (Claude)');
    check(json(cli('worker', 'add', 'alpha', 'alpha-c1', '--provider', 'codex')).ok === true, 'cld-gui worker add alpha alpha-c1 --provider codex');
    check(json(cli('worker', 'start', 'alpha-c1')).ok === true, 'alpha-c1 on (resting)');
    const t1 = json(cli('task', 'add', 'Login page', '--project', 'alpha', '--assignee', 'alpha-w1'));
    const t2 = json(cli('task', 'add', 'API docs', '--project', 'alpha', '--assignee', 'alpha-c1'));
    check(t1.task?.id === 'T-1' && t2.task?.id === 'T-2', 'two Tasks: T-1 for alpha-w1, T-2 for alpha-c1');

    browser = await launchBrowser();
    const newPage = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      if (fs.existsSync(FONT))
        await ctx.route('**/__w2/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      await p.addStyleTag({ content: FONT_CSS });
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const desk = await newPage({ viewport: { width: 1280, height: 800 } });
    const wb = desk.locator('[data-hud-window="workbench"]');
    await openWorkbenchTab(desk, 'Task', { project: 'alpha' });
    const card = (id: string) => wb.locator(`[data-testid="task-card"][data-task-id="${id}"]`);
    await card('T-1').waitFor({ timeout: 20_000 });

    // "worktree 만들기" on each card, from the screen.
    const make = async (id: string, assignee: string, name: string) => {
      await card(id).locator('button[aria-expanded]').first().click();
      await card(id).getByRole('button', { name: 'worktree 만들기', exact: true }).click();
      const form = card(id).getByRole('form', { name: 'worktree 만들기' });
      check((await form.getByLabel('담당').inputValue()) === assignee, `${id}'s form starts with its assignee ${assignee}`);
      await form.getByLabel('담당').selectOption(assignee);
      if (id === 'T-1') await shot(desk, 'task-worktree-form');
      await form.getByRole('button', { name: 'worktree 만들기', exact: true }).click();
      const dialog = desk.getByRole('alertdialog');
      await dialog.waitFor();
      if (id === 'T-1') await shot(desk, 'task-worktree-confirm');
      await dialog.getByRole('button', { name: 'worktree 만들기', exact: true }).click();
      await card(id).getByTestId('task-worktree').waitFor({ timeout: 20_000 });
      const chip = await card(id).getByTestId('task-worktree').innerText();
      check(chip.includes(name) && chip.includes(assignee), `${id}'s card: ${chip}`);
    };
    await make('T-1', 'alpha-w1', 't-1-login-page');
    await make('T-2', 'alpha-c1', 't-2-api-docs');
    const [w1, w2] = records();
    const tree = (task: string) => path.join(folder, '.worktrees', task);
    check(
      w1.taskId === 'T-1' && w1.branch === 'task/t-1-login-page' && w1.base === 'main' && w1.path === tree('t-1-login-page') && w1.createdBy === 'user' &&
        w2.taskId === 'T-2' && w2.branch === 'task/t-2-api-docs',
      `worktrees.json: ${w1.task} (T-1) and ${w2.task} (T-2), from main, made by the user`,
    );
    const ids = (json(cli('worker', 'list')).workers as Array<{ name: string }>).map((w) => w.name);
    const roster = json(cli('task', 'show', 'T-1')).task as { branch: string; worktree: string; assignee: { assignmentId: string } };
    check(w1.assignmentId === roster.assignee.assignmentId && roster.branch === w1.branch && roster.worktree === w1.path && ids.includes('alpha-c1'), 'T-1 says its branch and worktree; the worktree is given to its assignee (by assignment id)');
    check(repo.git(['status', '--porcelain']) === '' && fs.readFileSync(path.join(folder, '.git/info/exclude'), 'utf8').includes('/.worktrees/'), 'the project’s checkout is untouched (.worktrees/ excluded)');
    // One card open at a time: T-1's again, to see its worktree.
    await card('T-1').locator('button[aria-expanded]').first().click();
    await card('T-1').getByTestId('task-worktree-detail').waitFor();
    const detail = await card('T-1').getByTestId('task-worktree-detail').innerText();
    check(detail.includes(w1.path) && detail.includes('task/t-1-login-page ← main') && detail.includes('담당 alpha-w1'), 'T-1’s open card: its worktree folder, branch ← base, assignee');
    await shot(desk, 'tasks-with-worktrees');

    // alpha-w1's next start is in its worktree; its work lands there only.
    check(json(cli('worker', 'start', 'alpha-w1')).ok === true, 'cld-gui worker start alpha-w1');
    await eventually('alpha-w1 live', () => !!session('alpha-w1'));
    check(session('alpha-w1')!.cwd === w1.path, `alpha-w1's session runs in ${w1.path}`);
    check(engineCalls(home).some((c) => c.argv[0] === '--bg' && c.argv[2] === 'alpha-w1' && c.cwd === w1.path), 'the fake claude was started there');
    fs.writeFileSync(path.join(w1.path, 'login.txt'), 'login\n');
    repo.git(['add', 'login.txt'], w1.path);
    repo.git(['commit', '-q', '-m', 'login page'], w1.path);
    check(!fs.existsSync(path.join(folder, 'login.txt')) && repo.git(['rev-list', '--count', 'main..task/t-1-login-page']).trim() === '1', 'alpha-w1’s commit is on task/t-1-login-page only');

    // The Lead hands T-2 to the Codex Worker: its run works in T-2's worktree.
    const argv = engineCalls(home).filter((c) => c.argv[0] === '--bg' && c.argv[2] === 'alpha').at(-1)!.argv;
    const token = (JSON.parse(argv[argv.indexOf('--settings') + 1]) as { env: Record<string, string> }).env.CLD_AGENT_TOKEN;
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(cfg, 'mcp-config.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const lead = new McpClient(mcpConfig.mcpServers['cld-gui'], { PATH, HOME: home, CLD_AGENT_TOKEN: token }, folder);
    clients.push(lead);
    await lead.init();
    const agents = (await lead.call('list_agents')).agents as Array<{ id: string; name: string }>;
    const c1 = agents.find((a) => a.name === 'alpha-c1')!;
    const aw1 = agents.find((a) => a.name === 'alpha-w1')!;
    const d2 = await lead.call('delegate_task', { idempotencyKey: 'w2-t2', task: { id: 'T-2' }, target: { agentId: c1.id } });
    check(d2.status === 'accepted', `delegate_task T-2 to alpha-c1: ${JSON.stringify(d2)}`);
    const runs = () =>
      fs.existsSync(codexDir(home))
        ? fs.readdirSync(codexDir(home)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(codexDir(home), f), 'utf8')) as CodexRecord)
        : [];
    await eventually('the Codex run ended', () => runs().some((r) => r.task === 'T-2' && r.state === 'done'), 60_000);
    const run = runs().find((r) => r.task === 'T-2')!;
    check(run.dir === w2.path && run.worktree === w2.path && run.branch === w2.branch && run.commits === 1, `alpha-c1's run worked in ${w2.path} on ${run.branch} (1 commit)`);
    check(repo.git(['rev-list', '--count', 'main..task/t-2-api-docs']).trim() === '1' && records().length === 2, 'the fake codex’s commit is on task/t-2-api-docs; no other worktree was made');
    const execution = () =>
      (JSON.parse(fs.readFileSync(tasksPath(home), 'utf8')) as { tasks: Array<{ id: string; executions?: Array<Record<string, any>> }> }).tasks
        .find((x) => x.id === 'T-2')
        ?.executions?.find((e) => e.kind === 'codex');
    await eventually('T-2’s Execution settled', () => execution()?.commits !== undefined, 30_000);
    check(execution()!.commits.value === 1 && execution()!.commits.source === 'observed', 'T-2’s Execution counts that commit (observed)');

    // delegate_task with worktree 'new'.
    const d3 = await lead.call('delegate_task', { idempotencyKey: 'w2-t3', task: { title: 'Settings page', worktree: 'new' }, target: { agentId: aw1.id } });
    check(d3.status === 'accepted', `delegate_task worktree 'new' to alpha-w1: ${JSON.stringify(d3)}`);
    const w3 = records().find((r) => r.taskId === d3.taskId)!;
    check(w3?.branch === `task/${String(d3.taskId).toLowerCase()}-settings-page` && w3.assignmentId === roster.assignee.assignmentId && w3.createdBy === 'agent:alpha', `${String(d3.taskId)}'s worktree ${w3?.task}, given to alpha-w1, made by agent:alpha`);
    await eventually('the Task reached alpha-w1', () => typed().some((x) => x.text.includes(`Task ${String(d3.taskId)}`) && x.text.includes(w3.path)), 30_000);
    check(session('alpha-w1')!.cwd === w1.path, 'alpha-w1 (running) was not moved; the message names the new worktree');

    // The CLI says the same.
    const listed = json(cli('worktree', 'list')).worktrees as Array<Record<string, any>>;
    check(
      JSON.stringify(listed.map((w) => [w.taskId, w.assignee, w.ahead])) === JSON.stringify([['T-1', 'alpha-w1', 1], ['T-2', 'alpha-c1', 1], [d3.taskId, 'alpha-w1', 0]]),
      `cld-gui worktree list: ${JSON.stringify(listed.map((w) => [w.taskId, w.assignee, w.ahead]))}`,
    );
    const again = json(cli('worktree', 'new', '--task', 'T-1'));
    check(again.ok === false && again.code === 'exists', `cld-gui worktree new --task T-1 again: refused (${again.error})`);

    // The worktree tab: Task ↔ worktree ↔ assignee.
    await openWorkbenchTab(desk, 'worktree', { project: 'alpha' });
    const row = (task: string) => wb.locator(`[data-testid="worktree-row"][data-task="${task}"]`);
    await row('t-1-login-page').waitFor({ timeout: 20_000 });
    const rows = await Promise.all([w1.task, w2.task, w3.task].map((t) => row(t).getByTestId('worktree-task').innerText()));
    check(rows[0] === 'Task T-1 · 담당 alpha-w1' && rows[1] === 'Task T-2 · 담당 alpha-c1' && rows[2] === `Task ${String(d3.taskId)} · 담당 alpha-w1`, `the worktree tab: ${rows.join(' | ')}`);
    await shot(desk, 'worktree-tab');

    // The phone.
    const phone = await newPage({ ...devices['iPhone 13'] });
    await openWorkbenchTab(phone, 'Task', { project: 'alpha', tap: true });
    const dock = phone.locator('[aria-label="작업실 화면"]');
    const pcard = dock.locator('[data-testid="task-card"][data-task-id="T-1"]');
    await pcard.getByTestId('task-worktree').waitFor({ timeout: 20_000 });
    await pcard.locator('button[aria-expanded]').first().tap();
    await pcard.getByTestId('task-worktree-detail').waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-tasks-worktree');
    await openWorkbenchTab(phone, 'worktree', { project: 'alpha', tap: true });
    await dock.locator('[data-testid="worktree-row"]').first().waitFor({ timeout: 20_000 });
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-worktree-tab');
    check(true, 'phone: the Task tab and the worktree tab show Task ↔ worktree ↔ assignee');
    console.log(`\n${oks} checks passed`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-w2.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    for (const c of clients) c.close();
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
