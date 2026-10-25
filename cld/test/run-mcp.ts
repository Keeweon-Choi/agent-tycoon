/**
 * C5a: the MCP adapter end to end with the fake claude. dist/cli.js in a temp
 * HOME, one project with its Lead and a Worker (added and started through
 * `cld-gui worker`); the adapter started the way Claude Code starts it from the
 * generated --mcp-config (its command and args, the session's environment with
 * the token the engine handed that session). Checks: the argv carries
 * --mcp-config and no --strict-mcp-config; list_agents from the Lead lists the
 * Worker; send_message from the Lead reaches the Worker's session with the Lead
 * named as sender; post_to_group appears in the room and wakes the mentioned
 * Worker; a Worker's create_task is a proposed task on the board; a forged
 * token is no_identity.
 *
 * C6 (delegate_task): the Lead delegates to the idle Worker (its session gets the
 * Task header and text; the 작업실 board shows the child Task under its parent
 * with its Execution), to the busy Worker (queued, typed once it idles), asks for
 * a new Worker of the same kind (idle_worker_available, the Worker as candidate)
 * and of another kind (created, started with the Task as its first prompt, its
 * character in the office), then past the project's 3 running Workers
 * (pending_approval → a notice and a card in the 작업실 → 승인 in the headless
 * browser → run once). Screenshots in cld/artifacts/c6/.
 *
 *   env -u CLD_AGENT_TOKEN nice -n 10 npx tsx cld/test/run-mcp.ts <port 18256-18259>
 */
import type { Browser } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
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
const DEADLINE_MS = 300_000;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/c6');
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 20_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

/** The adapter as Claude Code runs it: config command + args, the session's environment. */
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
  notify(method: string) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
  async init() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'run-mcp', version: '1' },
    });
    this.notify('notifications/initialized');
    return r;
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
  const { home, bin } = makeEngineHome();
  const cfg = path.join(home, '.config/cld-gui');
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({
      v: 2,
      projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }],
    }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({
      v: 1,
      assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }],
    }),
  );
  fs.writeFileSync(
    path.join(cfg, 'groups.json'),
    JSON.stringify({ v: 1, groups: [{ id: 'team0001', name: '팀방', members: ['alpha', 'alpha-a'] }] }),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { FAKE_TURN_MS: '400' },
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  const clients: McpClient[] = [];
  let replier: ReturnType<typeof setInterval> | undefined;
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        env: { PATH: process.env.PATH, HOME: home, CLD_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    type Session = { name: string; jobId: string; cwd: string; sessionId: string };
    const session = (name: string): Session | null => {
      const dir = path.join(home, '.claude/sessions');
      for (const file of fs.readdirSync(dir)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
          if (parsed.name === name) return parsed;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    await daemon.loginUrl(); // up
    await eventually('the Lead revived', () => !!session('alpha'));
    check(json(cli('worker', 'add', 'alpha', 'alpha-a')).ok === true, 'cld-gui worker add alpha alpha-a');
    check(json(cli('worker', 'start', 'alpha-a')).ok === true, 'cld-gui worker start alpha-a');
    await eventually('the Worker session', () => !!session('alpha-a'));

    // The argv each session got, and the token in it (the session's environment).
    const starts = engineCalls(home).filter((c) => c.argv[0] === '--bg');
    const argvOf = (name: string) => starts.filter((c) => c.argv[c.argv.indexOf('-n') + 1] === name).at(-1)!.argv;
    const configFile = path.join(cfg, 'mcp-config.json');
    for (const name of ['alpha', 'alpha-a']) {
      const argv = argvOf(name);
      check(
        argv[argv.indexOf('--mcp-config') + 1] === configFile && !argv.includes('--strict-mcp-config'),
        `${name}: --mcp-config ${configFile}, no --strict-mcp-config`,
      );
    }
    const tokenOf = (name: string) => {
      const argv = argvOf(name);
      return (JSON.parse(argv[argv.indexOf('--settings') + 1]) as { env: Record<string, string> }).env.CLD_AGENT_TOKEN;
    };
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: unknown }>;
    };
    const server = config.mcpServers['cld-gui'];
    check(
      server.command === process.execPath &&
        server.args.length === 1 &&
        fs.existsSync(server.args[0]) &&
        server.env === undefined &&
        !fs.readFileSync(configFile, 'utf8').includes(tokenOf('alpha')),
      `the config names the adapter on the daemon's Node (${server.args[0]}), no token in it`,
    );
    const open = async (name: string | null, token = name ? tokenOf(name) : 'Z'.repeat(43)) => {
      const c = new McpClient(server, { PATH: process.env.PATH, HOME: home, CLD_AGENT_TOKEN: token }, folder);
      clients.push(c);
      await c.init();
      return c;
    };

    // The fake answers whatever is typed into a session in its transcript (as in run-lead-workers).
    let serial = 0;
    // The agents the replier answers for (C6 adds the Workers delegate_task makes).
    const agents = ['alpha', 'alpha-a'];
    const say = (name: string, role: 'user' | 'assistant', text: string) => {
      const s = session(name)!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++serial).toString(16).padStart(8, '0')}-0d30-4000-8000-000000000000`;
      const message = role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
      fs.appendFileSync(file, `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message })}\n`);
    };
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    };
    let seen = 0;
    replier = setInterval(() => {
      const all = typed();
      for (const item of all.slice(seen)) {
        const name = agents.find((n) => session(n)?.jobId === item.id);
        if (!name) continue;
        say(name, 'user', item.text.replaceAll('\r', '\n'));
        say(name, 'assistant', `${name}: 받았어요`);
      }
      seen = all.length;
    }, 100);

    const lead = await open('alpha');
    const tools = (await lead.request('tools/list')).result.tools as Array<{ name: string }>;
    check(tools.length === 8 && tools.some((t) => t.name === 'post_to_group'), `tools/list: ${tools.map((t) => t.name).join(', ')}`);
    const listed = await lead.call('list_agents');
    const workerRef = (listed.agents as Array<Record<string, any>>).find((a) => a.name === 'alpha-a');
    check(
      listed.you.role === 'lead' && listed.you.id === 'a_aaaaaaaaaa' && workerRef?.role === 'worker' && /^a_[a-z2-7]{10}$/.test(workerRef.id),
      `list_agents from the Lead lists the Worker (${workerRef?.id}, ${workerRef?.state})`,
    );

    const sent = await lead.call('send_message', { to: workerRef!.id, text: 'MCP 로 보내는 리뷰 요청' });
    check(sent.status === 'sent', `send_message: ${JSON.stringify(sent)}`);
    await eventually('the message typed into the Worker', () =>
      typed().some((t) => t.id === session('alpha-a')!.jobId && t.text.includes('MCP 로 보내는 리뷰 요청')),
    );
    const dm = typed().find((t) => t.text.includes('MCP 로 보내는 리뷰 요청'))!;
    check(/^\[cld-gui · alpha에게서 · /.test(dm.text) && !dm.text.includes('사장'), `the Worker's session got it from the Lead: ${dm.text.split('\n')[0]}`);

    const posted = await lead.call('post_to_group', { room: '팀방', text: '@alpha-a 회의록 확인해 주세요' });
    check(posted.status === 'posted' && posted.mentioned.join() === 'alpha-a', `post_to_group: ${JSON.stringify(posted)}`);
    const read = json(cli('groups', 'read', '팀방'));
    check(
      (read.posts as Array<{ sender: string; text: string }>).some((p) => p.sender === 'alpha' && p.text.includes('회의록')),
      'the post is in the room (cld-gui groups read 팀방), sent by alpha',
    );
    await eventually('the mention typed into the Worker', () =>
      typed().some((t) => t.id === session('alpha-a')!.jobId && t.text.includes('회의록')),
    );
    check(
      typed().filter((t) => t.text.includes('회의록')).every((t) => t.id === session('alpha-a')!.jobId && t.text.startsWith("[alpha · 단톡방 '팀방'")),
      "the mention reached only alpha-a, as alpha in '팀방'",
    );

    const worker = await open('alpha-a');
    const context = await worker.call('get_group_context', { room: '팀방' });
    check((context.posts as Array<{ text: string }>).some((p) => p.text.includes('회의록')), 'get_group_context from the Worker shows the post');
    const proposal = await worker.call('create_task', { title: '테스트 보강 제안', detail: '경계값' });
    check(proposal.status === 'proposed', `a Worker's create_task: ${JSON.stringify(proposal)}`);
    const shown = json(cli('task', 'show', proposal.taskId as string, '--json'));
    check(
      shown.task.status === 'proposed' && shown.task.createdBy === 'agent:alpha-a' && shown.task.assignee?.name === 'alpha',
      `on the board: ${proposal.taskId} proposed, createdBy agent:alpha-a, addressed to alpha`,
    );

    // ── C6: delegate_task ──
    fs.mkdirSync(OUT, { recursive: true });
    const before = await lead.call('list_agents');
    check(
      before.mode === 'auto' && before.you.canDelegate === true && before.you.canCreateWorker === true &&
        before.limits.workersRunning[0] === 1 && before.limits.delegationsToday[0] === 0,
      `list_agents: mode auto, the Lead may delegate and make Workers, limits ${JSON.stringify(before.limits)}`,
    );
    const parent = await lead.call('create_task', { title: '인증 기능' });
    const idle = (name: string) => (session(name) as { status?: string } | null)?.status === 'idle';
    await eventually('alpha-a idle again', () => idle('alpha-a'));
    const typedFor = (name: string, needle: string) =>
      typed().filter((t) => t.id === session(name)?.jobId && t.text.includes(needle));
    const d1 = await lead.call('delegate_task', {
      idempotencyKey: 'c6-idle',
      task: { title: 'API 테스트 작성', detail: '로그인·로그아웃 경로', parentTaskId: parent.taskId },
      target: { agentId: workerRef!.id },
    });
    check(d1.status === 'accepted' && d1.agentId === workerRef!.id && d1.executionId === `agent:${workerRef!.id}`, `delegate_task to the idle Worker: ${JSON.stringify(d1)}`);
    await eventually('the Task typed into the Worker', () => typedFor('alpha-a', 'API 테스트 작성').length === 1);
    const handed = typedFor('alpha-a', 'API 테스트 작성')[0].text;
    check(
      handed.startsWith(`[cld-gui · alpha에게서 · Task ${d1.taskId as string} · `) && handed.includes('로그인·로그아웃 경로') && !handed.includes('사장'),
      `the Worker's session got the Task from the Lead: ${handed.split('\n')[0]}`,
    );
    const child = json(cli('task', 'show', d1.taskId as string, '--json')).task;
    check(
      child.parentId === parent.taskId && child.delegatedBy === 'alpha' && child.createdBy === 'agent:alpha' &&
        child.assignee?.name === 'alpha-a' && child.executions?.[0]?.kind === 'agent' && child.executions[0].ref === workerRef!.id,
      `on the board: ${d1.taskId as string} under ${parent.taskId as string}, delegated by alpha to alpha-a, Execution agent:${workerRef!.id}`,
    );
    const again = await lead.call('delegate_task', {
      idempotencyKey: 'c6-idle',
      task: { title: 'API 테스트 작성', parentTaskId: parent.taskId },
      target: { agentId: workerRef!.id },
    });
    check(again.status === 'duplicate' && again.taskId === d1.taskId, 'the same key again: duplicate, the same Task');

    // A busy Worker: queued, typed once it is idle.
    await eventually('alpha-a idle again', () => idle('alpha-a'));
    const setStatus = (name: string, status: string) => {
      const dir = path.join(home, '.claude/sessions');
      for (const f of fs.readdirSync(dir)) {
        const file = path.join(dir, f);
        const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (s.name === name) fs.writeFileSync(file, JSON.stringify({ ...s, status, statusUpdatedAt: Date.now() }));
      }
    };
    setStatus('alpha-a', 'busy');
    const d2 = await lead.call('delegate_task', {
      idempotencyKey: 'c6-busy',
      task: { title: '리뷰 반영', parentTaskId: parent.taskId },
      target: { agentId: workerRef!.id },
    });
    check(d2.status === 'queued' && d2.position === 1, `delegate_task to the busy Worker: ${JSON.stringify(d2)}`);
    await wait(3000);
    check(typedFor('alpha-a', '리뷰 반영').length === 0, 'nothing typed while it is busy');
    setStatus('alpha-a', 'idle');
    await eventually('the queued Task typed once idle', () => typedFor('alpha-a', '리뷰 반영').length === 1, 30_000);
    check(typedFor('alpha-a', '리뷰 반영')[0].text.includes(`Task ${d2.taskId as string}`), `typed after it idled, naming ${d2.taskId as string}`);

    // A new Worker of the same kind while one is idle: refused, with the candidate.
    await eventually('alpha-a idle again', () => idle('alpha-a'));
    const sameKind = await lead.call('delegate_task', {
      idempotencyKey: 'c6-same',
      task: { title: '새 사람 필요?' },
      target: { newWorker: { provider: 'claude', reason: '따로 떼기' } },
    });
    check(
      sameKind.status === 'rejected' && sameKind.code === 'idle_worker_available' && sameKind.candidates?.[0]?.id === workerRef!.id,
      `a new Worker while alpha-a is idle: ${sameKind.code as string}, candidates ${JSON.stringify(sameKind.candidates?.map((c: { name: string }) => c.name))}`,
    );
    // Another kind: made, started, the Task its first prompt.
    agents.push('alpha-rev');
    const d3 = await lead.call('delegate_task', {
      idempotencyKey: 'c6-new',
      task: { title: '보안 리뷰', parentTaskId: parent.taskId },
      target: { newWorker: { provider: 'claude', role: 'reviewer', name: 'alpha-rev', reason: '리뷰 전담' } },
    });
    check(d3.status === 'accepted' && /^a_[a-z2-7]{10}$/.test(d3.agentId as string), `delegate_task to a new Worker: ${JSON.stringify(d3)}`);
    await eventually('the new Worker session', () => !!session('alpha-rev'), 30_000);
    await eventually('its first prompt', () => typedFor('alpha-rev', '보안 리뷰').length > 0, 30_000);
    const first = typed().filter((t) => t.id === session('alpha-rev')!.jobId);
    check(
      first.length === 1 && first[0].text.includes(`Task ${d3.taskId as string}`) && first[0].text.includes('alpha에게서'),
      `the new Worker's first prompt is the Task: ${first[0]?.text.split('\n')[0]}`,
    );
    const workers = json(cli('worker', 'list')).workers as Array<{ name: string; role: string; live: boolean }>;
    check(workers.some((w) => w.name === 'alpha-rev' && w.role === 'reviewer' && w.live), 'cld-gui worker list: alpha-rev, a reviewer, on');

    // The office, the 작업실.
    browser = await launchBrowser();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const names = page.locator('[data-testid="agent-overlay"] [data-testid="agent-name"]');
    await names.getByText('alpha-rev', { exact: true }).first().waitFor({ timeout: 30_000 });
    check(true, 'the new Worker’s character is in the office');
    await page.locator('[data-hud-id="icon:workbench"] button').click();
    const bench = page.locator('[data-hud-window="workbench"]');
    await bench.waitFor();
    await bench.getByRole('combobox', { name: '작업실 프로젝트' }).selectOption('alpha');
    await bench.getByRole('button', { name: 'Task', exact: true }).click();
    const parentCard = bench.locator(`[data-testid="task-card"][data-task-id="${parent.taskId as string}"]`);
    const childCard = parentCard.locator(`[data-testid="task-children"] [data-task-id="${d1.taskId as string}"]`);
    await childCard.waitFor({ timeout: 20_000 });
    await childCard.locator('button').first().click();
    const execution = childCard.locator(`[data-testid="task-execution"][data-execution="agent:${workerRef!.id}"]`);
    await execution.waitFor();
    check((await execution.innerText()).includes(workerRef!.id), `the board: ${d1.taskId as string} under ${parent.taskId as string} with its Execution`);
    await page.screenshot({ path: path.join(OUT, 'board-child-execution.png') });

    // Past a limit: the project's 3rd running Worker is made, the 4th asks the user.
    agents.push('alpha-w3', 'alpha-w4');
    const d4 = await lead.call('delegate_task', {
      idempotencyKey: 'c6-third',
      task: { title: '문서 정리' },
      target: { newWorker: { provider: 'claude', model: 'm-docs', name: 'alpha-w3', reason: '문서' } },
    });
    check(d4.status === 'accepted', `the 3rd running Worker: ${d4.status as string}`);
    await eventually('alpha-w3 session', () => !!session('alpha-w3'), 30_000);
    // A connection's first 2 s of feed are history, not notices (NOTICE_FEED_REPLAY_MS).
    await page.waitForTimeout(2_500);
    const d5 = await lead.call('delegate_task', {
      idempotencyKey: 'c6-fourth',
      task: { title: '성능 측정' },
      target: { newWorker: { provider: 'claude', model: 'm-perf', name: 'alpha-w4', reason: '측정' } },
    });
    check(
      d5.status === 'pending_approval' && /^ap-/.test(d5.approvalId as string) && /3 managed Workers/.test(d5.message as string),
      `the 4th: ${JSON.stringify(d5)}`,
    );
    const stored = JSON.parse(fs.readFileSync(path.join(cfg, 'approvals.json'), 'utf8')) as { v: number; approvals: Array<Record<string, unknown>> };
    check(
      stored.v === 1 && stored.approvals.length === 1 && stored.approvals[0].caller === 'alpha' && stored.approvals[0].check === 'limits' &&
        (fs.statSync(path.join(cfg, 'approvals.json')).mode & 0o777) === 0o600,
      'approvals.json (v1, 0600) holds the call: caller alpha, check limits',
    );
    const toast = page.getByTestId('notice-toast').filter({ hasText: '승인을 기다리는 위임' });
    await toast.waitFor({ timeout: 15_000 });
    check(true, 'a notice: 승인을 기다리는 위임이 있어요');
    const card = bench.locator(`[data-testid="approval-card"][data-approval-id="${d5.approvalId as string}"]`);
    await card.waitFor({ timeout: 15_000 });
    const cardText = await card.innerText();
    check(cardText.includes('성능 측정') && cardText.includes('상한 넘음') && cardText.includes('새 Worker'), `the card in the 작업실: ${cardText.replace(/\s+/g, ' ')}`);
    await card.screenshot({ path: path.join(OUT, 'approval-card.png') });
    await page.screenshot({ path: path.join(OUT, 'workbench-approval.png') });
    await card.getByRole('button', { name: '승인', exact: true }).click();
    await card.waitFor({ state: 'detached', timeout: 60_000 });
    await eventually('alpha-w4 session', () => !!session('alpha-w4'), 30_000);
    await eventually('alpha-w4 got its Task', () => typedFor('alpha-w4', '성능 측정').length > 0, 30_000);
    await page.screenshot({ path: path.join(OUT, 'after-approve.png') });
    const runs = json(cli('task', 'list', '--json')).tasks.filter((t: { title: string }) => t.title === '성능 측정');
    check(runs.length === 1 && runs[0].executions?.length === 1, `승인: run once (${runs.length} task, ${runs[0]?.executions?.length} execution)`);
    await eventually('the Lead heard the result', () => typed().some((t) => t.id === session('alpha')!.jobId && t.text.includes('[위임 승인] delegate_task(c6-fourth): accepted')), 30_000);
    check(true, "the Lead's session got the line: [위임 승인] delegate_task(c6-fourth): accepted");
    const dupAfter = await lead.call('delegate_task', {
      idempotencyKey: 'c6-fourth',
      task: { title: '성능 측정' },
      target: { newWorker: { provider: 'claude', model: 'm-perf', name: 'alpha-w4', reason: '측정' } },
    });
    check(dupAfter.status === 'duplicate' && dupAfter.taskId === runs[0].id, 'the same key after the approval: duplicate of the run');
    check(
      (json(cli('worker', 'list')).workers as Array<{ name: string }>).filter((w) => w.name.startsWith('alpha-w4')).length === 1,
      'one alpha-w4, not two',
    );

    const stranger = await open(null);
    const refused = await stranger.call('list_agents');
    check(refused.error?.code === 'no_identity', 'a forged token: no_identity');
    console.log(`${oks} ok`);
  } finally {
    await browser?.close();
    if (replier) clearInterval(replier);
    for (const c of clients) c.close();
    clearTimeout(deadline);
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
