/**
 * D5: a Codex Worker end to end. dist/cli.js in a temp HOME (its own port in config.json),
 * the engine's fake claude as the Lead and the fake codex (cld/test/fake-codex) as the only
 * codex on a PATH of our own: never the real one. Headless Chromium (--disable-gpu).
 * - '+ Worker' in the 작업실 picks Codex (Codex's model list, no permission mode) and adds
 *   alpha-w1; its card has the Codex badge and rests once started;
 * - the Lead's delegate_task(agentId) starts one run (the card says it works); a second
 *   delegation meanwhile is queued and goes in once, after the first run;
 * - the run's end: the Task's Execution has exit 0, a commit (observed) and the report
 *   (reported); the Lead's session gets one line under alpha-w1's name;
 * - the Lead's send_message (no Task) resumes the last thread (`exec resume <thread> -`);
 * - stopping the Worker stops its run (state stopped), and the Lead hears it;
 * - delegate_task with newWorker { provider: 'codex' } makes and starts one, which runs;
 * - the messenger shows the one line instead of an input for a Codex Worker.
 * Screenshots in cld/artifacts/d5/ (desktop 1280x800, phone iPhone 13).
 *
 *   nice -n 10 npx tsx cld/test/run-codex-worker.ts <port 18256-18259>
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
import { tasksPath } from '../../server/src/cld/engine/tasks.js';
import { findOnPath, transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/d5');
const FAKE_CODEX = path.join(REPO_ROOT, 'cld/test/fake-codex');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__d5/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 360_000;
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
    await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'run-codex-worker', version: '1' } });
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
  // Codex's own config in this HOME: the form's model list (invented names only).
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "model-a"\n[profiles.fast]\nmodel = "model-b"\n');
  // One run per message, in order: slow (the card works), the queued Task, the follow-up, a run
  // that hangs until stopped, the new Worker's.
  fs.writeFileSync(
    path.join(home, 'fake-codex.json'),
    JSON.stringify({ scenarios: ['slow', 'success', 'success', 'hang', 'success'], slowS: 8, message: '로그인 고쳤어요 · 테스트 통과 · 남은 일 없음' }),
  );
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
  // Never the user's PATH: the real codex lives there. The fake codex, the fake claude, node, git.
  const PATH = [FAKE_CODEX, bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  check(findOnPath('codex', PATH) === path.join(FAKE_CODEX, 'codex'), 'the only codex on the daemon’s PATH is the fake');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '400', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  let replier: ReturnType<typeof setInterval> | undefined;
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
    type Session = { name: string; jobId: string; cwd: string; sessionId: string };
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
    await daemon.loginUrl();
    await eventually('the Lead revived', () => !!session('alpha'));
    // The fake Lead answers what is typed into it (its turns end).
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    };
    let serial = 0;
    const say = (role: 'user' | 'assistant', text: string) => {
      const s = session('alpha')!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++serial).toString(16).padStart(8, '0')}-0d50-4000-8000-000000000000`;
      const message = role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
      fs.appendFileSync(file, `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message })}\n`);
    };
    let seen = 0;
    replier = setInterval(() => {
      const all = typed();
      for (const item of all.slice(seen)) {
        say('user', item.text.replaceAll('\r', '\n'));
        say('assistant', 'alpha: 받았어요');
      }
      seen = all.length;
    }, 100);
    const toLead = (worker: string) => typed().filter((x) => x.text.includes(`${worker}에게서`)).map((x) => x.text.replaceAll('\r', '\n'));

    browser = await launchBrowser();
    const newPage = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      if (fs.existsSync(FONT))
        await ctx.route('**/__d5/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      await p.addStyleTag({ content: FONT_CSS });
      return { ctx, p };
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const { p: desk } = await newPage({ viewport: { width: 1280, height: 800 } });
    const wb = desk.locator('[data-hud-window="workbench"]');
    const icon = desk.locator('[data-hud-id="icon:workbench"] button');
    await icon.waitFor();
    if (!(await wb.isVisible())) await icon.click();
    await wb.waitFor();
    await wb.getByRole('combobox', { name: '작업실 프로젝트' }).selectOption('alpha');
    await wb.getByRole('button', { name: '에이전트', exact: true }).click();
    await wb.getByTestId('workbench-agent').first().waitFor();

    // '+ Worker' with Codex.
    await wb.getByRole('button', { name: '+ Worker', exact: true }).click();
    const form = desk.getByRole('form', { name: 'alpha 에 Worker 추가' });
    await form.waitFor();
    await form.getByLabel('에이전트').selectOption('codex');
    await form.getByLabel('이름').fill('alpha-w1');
    const models = await form.getByLabel('모델').locator('option').allInnerTexts();
    const efforts = await form.getByLabel('effort').locator('option').allInnerTexts();
    check(
      JSON.stringify(models) === JSON.stringify(['Codex 기본', 'model-a', 'model-b']) && efforts.includes('xhigh'),
      `the Codex form: Codex's models (${models.join('/')}) and efforts (${efforts.join('/')})`,
    );
    check((await form.getByLabel('권한 모드').count()) === 0, 'the Codex form has no permission mode');
    check(
      (await form.getByText('비우면 Task 마다 새 작업 worktree 에서 일해요').isVisible()) && (await form.getByLabel('폴더').inputValue()) === '',
      'the Codex form starts with no folder and says where such a Worker works',
    );
    await form.getByLabel('모델').selectOption('model-a');
    await form.getByLabel('effort').selectOption('high');
    await shot(desk, 'add-codex-worker-form');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await form.waitFor({ state: 'detached', timeout: 20_000 });
    const card = wb.locator('[data-testid="workbench-agent"][data-name="alpha-w1"]');
    await card.waitFor({ timeout: 20_000 });
    const listed = (json(cli('worker', 'list')).workers as Array<Record<string, unknown>>).find((w) => w.name === 'alpha-w1');
    check(listed?.provider === 'codex' && listed.model === 'model-a' && listed.effort === 'high', `alpha-w1 added as a Codex Worker (${JSON.stringify(listed)})`);
    check(json(cli('worker', 'start', 'alpha-w1')).ok === true, 'cld-gui worker start alpha-w1');
    await card.getByText('쉬는 중').waitFor({ timeout: 20_000 });
    check(
      (await card.getByTestId('codex-badge').innerText()) === 'Codex' &&
        // CH-4: every card has its 꾸미기 button; no chat or Lead button besides it.
        (await card.getByRole('button').allInnerTexts()).every((t) => t.trim() === '꾸미기') &&
        (await card.getByTestId('codex-worker-task').innerText()).includes('맡은 일 없음'),
      'the card: the Codex badge, resting, no task, no chat or Lead button',
    );
    check(engineCalls(home).filter((c) => c.argv[0] === '--bg').length === 1, 'starting alpha-w1 started no claude session (only the Lead’s)');
    await shot(desk, 'agents-codex-resting');

    // The Lead's agent tools (its session's token).
    const argv = engineCalls(home).filter((c) => c.argv[0] === '--bg').at(-1)!.argv;
    const token = (JSON.parse(argv[argv.indexOf('--settings') + 1]) as { env: Record<string, string> }).env.CLD_AGENT_TOKEN;
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(cfg, 'mcp-config.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const lead = new McpClient(mcpConfig.mcpServers['cld-gui'], { PATH, HOME: home, CLD_AGENT_TOKEN: token }, folder);
    clients.push(lead);
    await lead.init();
    const agents = (await lead.call('list_agents')).agents as Array<Record<string, unknown>>;
    const w1 = agents.find((a) => a.name === 'alpha-w1')!;
    check(w1.provider === 'codex' && w1.state === 'down' && w1.canAccept === true, `list_agents: alpha-w1 codex, down (resting), accepts (${JSON.stringify(w1)})`);
    const codex = () =>
      fs.existsSync(codexDir(home))
        ? fs
            .readdirSync(codexDir(home))
            .filter((f) => f.endsWith('.json'))
            .sort()
            .map((f) => JSON.parse(fs.readFileSync(path.join(codexDir(home), f), 'utf8')) as CodexRecord)
            .sort((a, b) => a.started.localeCompare(b.started) || a.id.length - b.id.length || a.id.localeCompare(b.id))
        : [];
    const calls = () =>
      fs.existsSync(path.join(home, 'fake-codex.log'))
        ? fs.readFileSync(path.join(home, 'fake-codex.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string; stdin: string })
        : [];

    const d1 = await lead.call('delegate_task', { idempotencyKey: 'd5-1', task: { title: '로그인 고치기' }, target: { agentId: w1.id } });
    check(d1.status === 'accepted', `delegate_task to alpha-w1: ${JSON.stringify(d1)}`);
    await eventually('the first run', () => codex().length === 1 && codex()[0].state === 'running');
    await card.getByText('일하는 중').waitFor({ timeout: 20_000 });
    check((await card.getByTestId('codex-worker-task').innerText()).includes(`${d1.taskId} 로그인 고치기`), 'the card names the Task it works on');
    await shot(desk, 'agents-codex-working');
    const d2 = await lead.call('delegate_task', { idempotencyKey: 'd5-2', task: { title: '테스트 더하기' }, target: { agentId: w1.id } });
    check(d2.status === 'queued' && d2.position === 1, `a second delegation while it works is queued: ${JSON.stringify(d2)}`);
    await wait(1_500);
    check(codex().length === 1, 'still one run while the first works');

    // The first run's end: the Execution and the Lead's one line.
    const execution = (taskId: string) => {
      const doc = JSON.parse(fs.readFileSync(tasksPath(home), 'utf8')) as { tasks: Array<{ id: string; executions?: Array<Record<string, any>> }> };
      return doc.tasks.find((x) => x.id === taskId)?.executions?.find((e) => e.kind === 'codex');
    };
    await eventually('the Execution settled', () => execution(d1.taskId as string)?.exit !== undefined, 60_000);
    const e1 = execution(d1.taskId as string)!;
    check(
      e1.exit.value === 0 && e1.exit.source === 'observed' && e1.commits.value === 1 && e1.commits.source === 'observed' && e1.summary.source === 'reported' && e1.summary.value.startsWith('로그인 고쳤어요'),
      `the Task's Execution codex:${e1.ref}: exit 0 and a commit observed, the report reported`,
    );
    // K1 (e02661c5): an action notice waits noticeBatchMs (30 s) for the rest of its burst before the Lead is typed to.
    await eventually('the Lead told', () => toLead('alpha-w1').length >= 1, 60_000);
    const told = toLead('alpha-w1')[0];
    check(told.includes(`alpha-w1에게서 · Task ${d1.taskId}`) && told.includes('끝남 · exit 0 · 커밋 1개') && told.includes('보고(Worker 의 말):'), 'the Lead got one line under alpha-w1’s name with the facts and the report');

    // The queued Task: a run of its own (a new thread, its own task worktree), once.
    await eventually('the queued Task ran', () => codex().filter((r) => r.state === 'done').length === 2, 60_000);
    const [r1, r2] = codex();
    check(r2.task === d2.taskId && calls()[1].argv[1] !== 'resume' && r2.worktree !== r1.worktree, 'the queued Task went in once, after the first run, as a new thread in a new task worktree');
    await card.getByTestId('codex-worker-last').getByText(/끝남|완료/).waitFor({ timeout: 20_000 });
    await shot(desk, 'agents-codex-done');

    // A follow-up without a Task (send_message) continues the last thread.
    const f = await lead.call('send_message', { to: 'alpha-w1', text: '커밋 메시지도 정리해 주세요', idempotencyKey: 'd5-f' });
    check(f.status === 'sent', `send_message to alpha-w1: ${JSON.stringify(f)}`);
    await eventually('the follow-up ran', () => codex().filter((r) => r.state === 'done').length === 3, 60_000);
    const r3 = codex()[2];
    const c3 = calls()[2];
    check(
      c3.argv.slice(0, 2).join(' ') === 'exec resume' && c3.argv.at(-2) === r2.sid && c3.argv.at(-1) === '-' && c3.stdin.includes('커밋 메시지도 정리해 주세요') && r3.task === d2.taskId && r3.dir === r2.dir,
      `the follow-up resumed thread ${r2.sid} in its folder, its Task inherited (argv ${c3.argv.join(' ')})`,
    );

    // Stopping the Worker stops its run.
    const hang = await lead.call('send_message', { to: 'alpha-w1', text: '오래 걸리는 일', idempotencyKey: 'd5-h' });
    check(hang.status === 'sent', 'a fourth message');
    await eventually('the long run', () => codex().length === 4 && codex()[3].state === 'running' && codex()[3].pid !== null);
    check(json(cli('worker', 'stop', 'alpha-w1')).ok === true, 'cld-gui worker stop alpha-w1');
    await eventually('stopped', () => codex()[3].state === 'stopped', 30_000);
    await eventually('the Lead told of the stop', () => toLead('alpha-w1').some((x) => x.includes('사용자가 멈췄어요')), 60_000);
    check(true, 'the run ended stopped and the Lead heard 사용자가 멈췄어요');
    await card.getByText('꺼짐').waitFor({ timeout: 20_000 });

    // A new Codex Worker through delegate_task.
    const d3 = await lead.call('delegate_task', {
      idempotencyKey: 'd5-3',
      task: { title: '문서 다듬기' },
      target: { newWorker: { provider: 'codex', reason: '문서 일', name: 'alpha-w2' } },
    });
    check(d3.status === 'accepted', `delegate_task newWorker codex: ${JSON.stringify(d3)}`);
    await eventually('the new Worker ran', () => codex().some((r) => r.agent === 'alpha-w2' && r.state === 'done'), 60_000);
    check(true, 'alpha-w2 (Codex) was made, started and ran its Task');

    // The messenger: no input for a Codex Worker, one line why.
    await desk.getByRole('button', { name: /^메신저/ }).click();
    const messenger = desk.getByRole('region', { name: '메신저', exact: true });
    const contact = messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha-w1/ });
    // Workers sit folded under their project.
    await messenger.getByTestId('workers-alpha').locator('summary').click({ timeout: 20_000 });
    await contact.first().click({ timeout: 20_000 });
    await messenger.getByTestId('no-direct-chat').waitFor({ timeout: 20_000 });
    check((await messenger.getByLabel('보낼 글').count()) === 0, 'the messenger: no input for alpha-w1, one line why');
    await shot(desk, 'messenger-codex-no-chat');

    // The phone.
    const { p: phone } = await newPage({ ...devices['iPhone 13'] });
    const dockWb = phone.locator('[aria-label="작업실 화면"]');
    const dockIcon = phone.locator('[data-hud-id="icon:workbench"] button').first();
    await dockIcon.waitFor();
    if (!(await dockWb.isVisible())) await dockIcon.tap();
    await dockWb.waitFor();
    await dockWb.getByRole('combobox', { name: '작업실 프로젝트' }).selectOption('alpha');
    await dockWb.getByRole('button', { name: '에이전트', exact: true }).tap();
    await dockWb.locator('[data-testid="workbench-agent"][data-name="alpha-w1"]').waitFor({ timeout: 20_000 });
    await phone.waitForTimeout(500);
    await shot(phone, 'phone-agents-codex');
    check(true, 'phone: the 에이전트 tab lists the Codex Workers');
    console.log(`\n${oks} checks passed`);
  } catch (err) {
    // The daemon's own lines, for what went wrong.
    fs.writeFileSync(path.join(os.tmpdir(), 'run-codex-worker.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    if (replier) clearInterval(replier);
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
