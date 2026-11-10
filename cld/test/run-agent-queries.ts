/**
 * BRN K3: the agent query tools end to end. dist/cli.js in a temp HOME with the fake claude, one
 * project (a git folder with an SRS) with its Lead and a Worker, one room, and a K1 renew on record
 * for the Lead (renew-history.json and its delivered handoff). The adapter is started the way
 * Claude Code starts it from the generated --mcp-config, with each session's own token. Checks:
 * get_message finds the original of a DM and a room post for whom it belongs to and nobody else;
 * an unknown id is not_covered; get_resume_context reads the handoff back with its references;
 * after the owner turns tracking on, get_requirement, search_requirements, get_task_context and
 * get_traceability_summary answer from the spec reader; every call is an agent_query event.
 * The answers go to cld/artifacts/feat-brain-agent-queries/.
 *
 *   env -u CLD_AGENT_TOKEN nice -n 10 npx tsx cld/test/run-agent-queries.ts <port 18730-18739>
 */
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18730 && port <= 18739)) throw new Error('port must be 18730-18739');
const DEADLINE_MS = 180_000;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-brain-agent-queries');
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
    await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'run-agent-queries', version: '1' } });
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
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(path.join(folder, 'docs/requirements'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'server/src'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'docs/requirements/SRS.md'),
    '# SRS\n\n### 3.1 조회(K3)\n\n| ID | 요구 |\n|---|---|\n| FR-K3-001 | 에이전트가 메시지 원문을 번호로 읽는다 |\n| FR-K3-002 | 답할 수 없으면 not_covered 로 답한다 |\n',
  );
  fs.writeFileSync(path.join(folder, 'server/src/queries.ts'), '// FR-K3-001: the message reader\nexport const q = 1;\n');
  const git = (...a: string[]) =>
    spawnSync('git', a, { cwd: folder, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'feat(FR-K3-001): first');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  // Older than the scan's settle window (SPEC_SETTLE_MS): a document changed just now waits for the next scan.
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(path.join(folder, 'docs/requirements/SRS.md'), old, old);
  fs.writeFileSync(path.join(folder, 'server/src/later.ts'), 'export const later = 2;\n');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'feat(FR-K3-002): after the handoff');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({
      v: 1,
      assignments: [
        { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true },
        { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_aaaaaaaaaa', role: 'worker', name: 'alpha-a', folder, provider: 'claude', wantRunning: false },
      ],
    }),
  );
  fs.writeFileSync(path.join(cfg, 'groups.json'), JSON.stringify({ v: 1, groups: [{ id: 'team0001', name: '팀방', members: ['alpha', 'alpha-a'] }] }));
  // K1: one renew of the Lead on record (an hour ago), its handoff delivered.
  const endedAt = Date.now() - 3_600_000;
  fs.writeFileSync(
    path.join(cfg, 'renew-history.json'),
    JSON.stringify({ v: 1, terms: [{ name: 'alpha', projectId: 'p_aaaaaaaaaa', sessionId: 'old-session-0001', next: 'new-session-0001', transcript: path.join(home, 'old.jsonl'), bytes: 0, endedAt }] }),
  );
  const delivered = path.join(cfg, 'inbox', 'alpha', 'delivered');
  fs.mkdirSync(delivered, { recursive: true });
  const handoffFile = path.join(delivered, '20261106-130000-000.md');
  fs.writeFileSync(
    handoffFile,
    [
      '[agty renew · 11-06 13:00] 컨텍스트가 포화돼 새 대화로 이어 간다. 이어 가기는 best-effort 다: 빠진 것이 있을 수 있다.',
      '- 이전 대화와 아래 인수인계는 읽기 전용 참고다.',
      '',
      '--- 인수인계 ---',
      '## 목표\n[사실] FR-K3-001 조회 도구를 끝낸다. 기준 커밋 ' + head.slice(0, 10) + '.',
      '## 완료\n[사실] get_message 초안. 배포 키 token=k3-live-secret-value 는 쓰지 말 것.',
      '## 미해결\n[미확인] FR-K3-002',
      '## 다음 행동\n[판단] 실제 시험',
      '',
      '--- 작업 기준 (엔진이 직접 읽은 값) ---',
      `이전 세션: old-session-0001 · 이전 대화 파일(필요하면 읽기만): ${path.join(home, 'old.jsonl')}`,
      `폴더: ${folder} · 브랜치: main · HEAD: ${head} · 바뀐 파일: 0개`,
    ].join('\n'),
  );
  fs.utimesSync(handoffFile, endedAt / 1000, endedAt / 1000);

  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'], { FAKE_TURN_MS: '400' });
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  const clients: McpClient[] = [];
  let replier: ReturnType<typeof setInterval> | undefined;
  const answers: Record<string, unknown> = {};
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], { env: { PATH: process.env.PATH, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 });
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
    // The owner's browser session (the spec routes refuse the host token: agents can read it).
    const login = await fetch(await daemon.loginUrl(), { redirect: 'manual' });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    await eventually('the Lead revived', () => !!session('alpha'));
    check(JSON.parse(cli('worker', 'start', 'alpha-a').stdout || '{}').ok === true, 'agty worker start alpha-a');
    await eventually('the Worker session', () => !!session('alpha-a'));
    const starts = engineCalls(home).filter((c) => c.argv[0] === '--bg');
    const tokenOf = (name: string) => {
      const argv = starts.filter((c) => c.argv[c.argv.indexOf('-n') + 1] === name).at(-1)!.argv;
      return (JSON.parse(argv[argv.indexOf('--settings') + 1]) as { env: Record<string, string> }).env.CLD_AGENT_TOKEN;
    };
    const server = (JSON.parse(fs.readFileSync(path.join(cfg, 'mcp-config.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers['cld-gui'];
    const open = async (name: string) => {
      const c = new McpClient(server, { PATH: process.env.PATH, HOME: home, CLD_AGENT_TOKEN: tokenOf(name) }, folder);
      clients.push(c);
      await c.init();
      return c;
    };
    // The fake answers whatever is typed into a session in its transcript (as run-mcp.ts).
    let serial = 0;
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
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string }) : [];
    };
    let seen = 0;
    replier = setInterval(() => {
      const all = typed();
      for (const item of all.slice(seen)) {
        const name = ['alpha', 'alpha-a'].find((n) => session(n)?.jobId === item.id);
        if (!name) continue;
        say(name, 'user', item.text.replaceAll('\r', '\n'));
        say(name, 'assistant', `${name}: 받았어요`);
      }
      seen = all.length;
    }, 100);

    const lead = await open('alpha');
    const worker = await open('alpha-a');
    const tools = ((await lead.request('tools/list')).result.tools as Array<{ name: string }>).map((t) => t.name);
    check(tools.includes('get_message') && tools.includes('get_resume_context') && tools.length === 16, `tools/list: ${tools.length} tools`);

    // A DM from the Lead to the Worker, found by its id in the Worker's conversation only.
    check((await lead.call('send_message', { to: 'alpha-a', text: 'K3 원문 확인: api_key=live-secret-123 은 가려야 한다' })).status === 'sent', 'send_message to the Worker');
    await eventually('typed into the Worker', () => typed().some((t) => t.id === session('alpha-a')!.jobId && t.text.includes('K3 원문 확인')));
    await eventually('in its transcript', () => fs.readFileSync(transcriptPath(session('alpha-a')!.cwd, session('alpha-a')!.sessionId, home), 'utf8').includes('K3 원문 확인'));
    const dmId = /⟨m:([a-z2-7]{8})⟩/.exec(typed().find((t) => t.text.includes('K3 원문 확인'))!.text)![1];
    const own = (answers.get_message_dm = await worker.call('get_message', { id: `⟨m:${dmId}⟩` }));
    check(
      own.conversation?.kind === 'dm' && own.message?.sender === 'alpha' && own.message.text.includes('api_key=***') && !JSON.stringify(own).includes('live-secret-123') && own.after?.text === 'alpha-a: 받았어요',
      `get_message (Worker, its own DM): from ${own.message?.sender}, masked, the next line "${own.after?.text}"`,
    );
    const other = (answers.get_message_other_dm = await lead.call('get_message', { id: dmId }));
    check(other.status === 'not_covered' && !JSON.stringify(other).includes('K3 원문'), `get_message (Lead, the Worker's DM): ${other.status} ${other.missing?.[0]?.code}`);

    // A room post, by a member.
    const post = await lead.call('post_to_group', { room: '팀방', text: '@alpha-a 단톡방 원문 K3' });
    check(post.status === 'posted', `post_to_group: ${post.postId}`);
    const room = (answers.get_message_room = await worker.call('get_message', { id: post.postId }));
    check(room.conversation?.kind === 'room' && room.conversation.name === '팀방' && room.message?.text.includes('단톡방 원문 K3'), 'get_message (Worker, a room post): the room and its text');

    const missing = (answers.get_message_unknown = await lead.call('get_message', { id: 'zzzzzzz2' }));
    check(missing.status === 'not_covered' && missing.missing?.[0]?.code === 'not_found', `get_message (unknown id): ${missing.status}`);

    const resume = (answers.get_resume_context = await lead.call('get_resume_context'));
    check(
      resume.renew?.newSession === 'new-session-0001' &&
        resume.base?.head === head &&
        resume.handoff.includes('## 목표') &&
        !JSON.stringify(resume).includes('k3-live-secret-value') &&
        resume.since?.commits?.[0]?.subject === 'feat(FR-K3-002): after the handoff' &&
        resume.refs.some((r: { ref: { t: string; sha?: string }; subject?: string }) => r.ref.t === 'commit' && r.ref.sha === head && r.subject === 'feat(FR-K3-001): first'),
      `get_resume_context: base ${resume.base?.head?.slice(0, 7)}, ${resume.since?.commits?.length} commit since, ${resume.refs?.length} refs`,
    );
    check((answers.get_resume_context_worker = await worker.call('get_resume_context')).status === 'not_covered', "get_resume_context (Worker): the Lead's handoff is not its own");

    // Tracking off, then on (the owner's route, a browser session).
    const off = (answers.get_traceability_summary_off = await lead.call('get_traceability_summary'));
    check(off.status === 'not_covered' && off.missing?.[0]?.code === 'tracking_off', 'get_traceability_summary (tracking off): not_covered tracking_off');
    const en = await fetch(`http://127.0.0.1:${port}/api/cld/spec/alpha/enable`, {
      method: 'POST',
      headers: { cookie, origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs: ['docs/requirements/SRS.md'] }),
    });
    check(en.ok, `tracking on (owner): ${en.status}`);
    const req = (answers.get_requirement = await lead.call('get_requirement', { id: 'FR-K3-001' }));
    check(req.requirement?.node?.label === 'FR-K3-001' && typeof req.rev === 'number' && req.head === git('rev-parse', 'HEAD').stdout.trim(), `get_requirement FR-K3-001: ${req.requirement?.node?.id ?? JSON.stringify(req)}, rev ${req.rev}`);
    const search = (answers.search_requirements = await worker.call('search_requirements', { query: 'FR-K3' }));
    check(search.items?.length === 2, `search_requirements FR-K3: ${search.items?.length} rows`);
    const created = await lead.call('create_task', { title: 'FR-K3-002 의 not_covered 를 끝낸다' });
    const tc = (answers.get_task_context = await lead.call('get_task_context', { taskId: created.taskId }));
    check(tc.task?.id === created.taskId && tc.requirements?.some((r: { label: string }) => r.label === 'FR-K3-002'), `get_task_context ${created.taskId}: requirements ${tc.requirements?.map((r: { label: string }) => r.label)}, missing ${tc.missing?.map((m: { code: string }) => m.code) ?? 'none'}`);
    answers.get_related_context = await lead.call('get_related_context', { id: 'FR-K3-002' });
    answers.get_traceability_summary = await lead.call('get_traceability_summary');
    check(Array.isArray(answers.get_traceability_summary && (answers.get_traceability_summary as { features?: unknown }).features), 'get_traceability_summary (tracking on): features');

    const events = fs
      .readFileSync(path.join(cfg, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === 'agent_query');
    const last = events.at(-1)!;
    check(events.length === Object.keys(answers).length && last.asked === events.length, `events.jsonl: ${events.length} agent_query lines, not covered ${last.notCovered}/${last.asked}`);
    fs.writeFileSync(path.join(OUT, 'agent-query-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    console.log(`${oks} ok`);
  } finally {
    fs.writeFileSync(path.join(OUT, 'responses.json'), `${JSON.stringify(answers, null, 2)}\n`);
    if (replier) clearInterval(replier);
    for (const c of clients) c.close();
    clearTimeout(deadline);
    await daemon.stop();
    killFakeSessions(home);
    removeTestHome(home);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
