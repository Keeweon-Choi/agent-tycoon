/**
 * C5a: the MCP adapter (cld/bin/cld-gui-mcp.js) against a fake daemon socket,
 * and the agent tools' checks (identity, scope, duplicate, pairwise rate).
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SEND_TEXT_MAX } from '../chatSend.js';
import { REPO_ROOT } from '../testHome.js';
import type { ControlDeps } from './control.js';
import { answerControl, controlPath, listenControl } from './control.js';
import { approvalsPath,ApprovalStore } from './delegation.js';
import type { GroupPost } from './groupMessages.js';
import { roomMentions } from './groupMessages.js';
import type { GroupRoom } from './groups.js';
import type { McpDeps, RosterAgent } from './mcpTools.js';
import { McpTools, RATE } from './mcpTools.js';
import { tasksPath, TaskStore } from './tasks.js';

vi.setConfig({ testTimeout: 60_000 });
const MCP = path.join(REPO_ROOT, 'cld/bin/cld-gui-mcp.js');

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});
function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-mcp-'));
  cleanup.push(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
}

const agent = (
  name: string,
  project: string,
  role: RosterAgent['role'],
  id: string,
  o: Partial<RosterAgent> = {},
): RosterAgent => ({
  name,
  project,
  role,
  assignmentId: id,
  provider: 'claude',
  wantRunning: true,
  live: true,
  busy: false,
  ...o,
});
const ROSTER: RosterAgent[] = [
  agent('alpha', 'alpha', 'lead', 'a_aaaaaaaaaa'),
  agent('alpha-a', 'alpha', 'worker', 'a_bbbbbbbbbb', { busy: true, model: 'm-1' }),
  agent('alpha-b', 'alpha', 'worker', 'a_dddddddddd', { live: false, wantRunning: false }),
  agent('beta', 'beta', 'lead', 'a_cccccccccc'),
];
const ROOMS: GroupRoom[] = [
  { id: 'all', name: '전체', members: ['alpha', 'beta'] },
  { id: 'g1', name: '팀방', members: ['alpha', 'alpha-a', 'alpha-b'] },
  { id: 'g2', name: 'beta방', members: ['beta'] },
];

/** The tools over fake engine parts and a real Task store; what the messenger and rooms got. */
function world(h: string, o: { now?: () => number; sendMs?: number; delegation?: McpDeps['delegation'] } = {}) {
  const tasks = new TaskStore(
    tasksPath(h),
    () => undefined,
    () => undefined,
  );
  const sent: Array<{ to: string; text: string; from: string | null; source: string; task?: string }> = [];
  const posts: GroupPost[] = [];
  const deps: McpDeps = {
    roster: () => ROSTER,
    tasks,
    queueLength: (name) => (name === 'alpha-a' ? 2 : 0),
    limited: () => false,
    send: async (r) => {
      if (o.sendMs) await new Promise((resolve) => setTimeout(resolve, o.sendMs));
      if (r.text === 'fail') return { ok: false, code: 'queue_failed', error: 'x' };
      sent.push(r);
      return { ok: true, delivered: 'pane' };
    },
    groupPost: (r) => {
      const room = ROOMS.find((x) => x.id === r.room)!;
      const { targets } = roomMentions(r.text, room.members);
      const post: GroupPost = {
        id: `p${posts.length + 1}`,
        at: Date.parse('2026-10-24T09:00:00Z') + posts.length,
        sender: r.from,
        text: r.text,
        targets,
        delivery: {},
      };
      posts.push(post);
      return Promise.resolve({ ok: true, post });
    },
    findRoom: (room) => ROOMS.find((x) => x.id === room || x.name === room) ?? null,
    timeline: () => posts,
    ...(o.now && { now: o.now }),
    ...(o.delegation && { delegation: o.delegation }),
  };
  return { tools: new McpTools(deps), tasks, sent, posts };
}

const TOKENS: Record<string, string> = {
  ['L'.repeat(43)]: 'alpha',
  ['W'.repeat(43)]: 'alpha-a',
  ['B'.repeat(43)]: 'beta',
};

/** A daemon socket in `h` answering `mcp` with the tools. */
async function daemon(h: string, tools: McpTools) {
  const deps = {
    names: () => ROSTER.map((a) => a.name),
    agentOf: (t: string) => TOKENS[t] ?? null,
    projectAt: () => 'alpha',
    mcp: (who: string, tool: string, input: unknown) => tools.call(who, tool, input),
  } as unknown as ControlDeps;
  const server = await listenControl(
    controlPath(h),
    (req) => answerControl(req, deps),
    () => undefined,
  );
  if (!server) throw new Error('no socket');
  cleanup.push(() => server.close());
}

/** Run the adapter as Claude Code would, feed it `lines`, collect its answers (one per id). */
function adapter(h: string, lines: string[], env: Record<string, string> = {}, cwd = h) {
  return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], {
      cwd,
      env: { PATH: process.env.PATH, HOME: h, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('close', () => {
      try {
        resolve(
          out
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>),
        );
      } catch (e) {
        reject(new Error(`${String(e)}\n${out}\n${err}`));
      }
    });
    child.stdin.end(lines.join('\n') + '\n');
  });
}
const rpc = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
const callLine = (id: number, name: string, args: unknown = {}) =>
  rpc(id, 'tools/call', { name, arguments: args });
/** The JSON a tools/call answered with. */
const payload = (answer: Record<string, unknown> | undefined) => {
  const r = answer?.result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    json: JSON.parse(r.content[0].text) as Record<string, any>,
    isError: r.isError === true,
  };
};
const byId = (answers: Array<Record<string, unknown>>, id: number | null) =>
  answers.find((a) => a.id === id);

describe('C5a: the MCP adapter (stdio JSON-RPC)', () => {
  it('initialize, a notification, tools/list, ping, a bad line, an unknown method', async () => {
    const h = home();
    const answers = await adapter(h, [
      rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      rpc(2, 'tools/list'),
      rpc(3, 'ping'),
      '{not json',
      rpc(4, 'resources/list'),
      rpc(5, 'initialize', { protocolVersion: '1999-01-01' }),
    ]);
    expect(byId(answers, 1)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'cld-gui', version: '1' },
      },
    });
    // A version it does not know: it answers with its own newest.
    expect((byId(answers, 5)!.result as { protocolVersion: string }).protocolVersion).toBe(
      '2025-11-25',
    );
    const tools = (
      byId(answers, 2)!.result as { tools: Array<{ name: string; inputSchema: { type: string } }> }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'list_agents',
      'create_task',
      'update_task',
      'get_task_status',
      'send_message',
      'post_to_group',
      'get_group_context',
      'delegate_task',
    ]);
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
    expect(byId(answers, 3)!.result).toEqual({});
    expect(byId(answers, null)!.error).toMatchObject({ code: -32700 });
    expect(byId(answers, 4)!.error).toMatchObject({ code: -32601 });
    // The notification got no answer: one answer per id, plus the parse error.
    expect(answers).toHaveLength(6);
  });

  it('JSON-RPC edges: a batch, non-object messages and an object id get -32600 with id null', async () => {
    const answers = await adapter(home(), [
      JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
      'null',
      '42',
      '"s"',
      JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }),
      rpc(7, 'ping'),
      rpc(8, 'initialize', { protocolVersion: '2025-03-26' }),
    ]);
    const refused = answers.filter((a) => a.id === null);
    expect(refused).toHaveLength(6);
    expect(refused.every((a) => (a.error as { code: number }).code === -32600)).toBe(true);
    expect(byId(answers, 7)!.result).toEqual({});
    // 2025-03-26 has batches, which it refuses: it does not offer that version.
    expect((byId(answers, 8)!.result as { protocolVersion: string }).protocolVersion).toBe(
      '2025-11-25',
    );
    expect(answers).toHaveLength(8);
  });

  it('a line over 1 MB is answered with an error and dropped; the next line still works', async () => {
    const answers = await adapter(home(), [
      'x'.repeat(3 * 1024 * 1024),
      rpc(1, 'ping'),
      `{"jsonrpc":"2.0","id":2,"method":"ping","pad":"${'y'.repeat(1024 * 1024)}"}`,
      rpc(3, 'ping'),
    ]);
    expect(answers.filter((a) => a.id === null).map((a) => a.error)).toEqual([
      { code: -32600, message: 'Line too long' },
      { code: -32600, message: 'Line too long' },
    ]);
    expect(answers.filter((a) => a.id !== null).map((a) => a.id)).toEqual([1, 3]);
  });

  it('no token, a forged token, the daemon off: every tool answers no_identity / daemon_off', async () => {
    const h = home();
    const off = await adapter(h, [callLine(1, 'list_agents')], { CLD_AGENT_TOKEN: 'L'.repeat(43) });
    expect(payload(byId(off, 1))).toEqual({
      json: { error: { code: 'daemon_off', message: expect.any(String) } },
      isError: true,
    });
    const { tools } = world(h);
    await daemon(h, tools);
    const none = await adapter(h, [callLine(1, 'list_agents')]);
    expect(payload(byId(none, 1)).json.error.code).toBe('no_identity');
    const forged = await adapter(h, [callLine(1, 'send_message', { to: 'alpha-a', text: 'x' })], {
      CLD_AGENT_TOKEN: 'X'.repeat(43),
    });
    expect(payload(byId(forged, 1))).toMatchObject({
      json: { error: { code: 'no_identity' } },
      isError: true,
    });
  });

  it('identity is the token only: the cwd and a source of another agent change nothing', async () => {
    const h = home();
    const { tools, sent } = world(h);
    await daemon(h, tools);
    fs.mkdirSync(path.join(h, 'beta'));
    const answers = await adapter(
      h,
      [callLine(1, 'list_agents'), callLine(2, 'send_message', { to: 'alpha', text: '보고' })],
      { CLD_AGENT_TOKEN: 'W'.repeat(43), CLD_SOURCE: 'beta' },
      path.join(h, 'beta'),
    );
    expect(payload(byId(answers, 1)).json.you).toMatchObject({
      id: 'a_bbbbbbbbbb',
      name: 'alpha-a',
      role: 'worker',
      depth: 2,
    });
    expect(sent).toEqual([
      { to: 'alpha', text: '보고', ifIdle: false, from: 'alpha-a', source: 'mcp' },
    ]);
  });

  it('a tool call through the adapter: the daemon result as text JSON, refusals with isError', async () => {
    const h = home();
    const { tools } = world(h);
    await daemon(h, tools);
    const answers = await adapter(
      h,
      [
        callLine(1, 'create_task', { title: '로그인 화면' }),
        callLine(2, 'update_task', { taskId: 'T-404' }),
        callLine(3, 'no_such_tool'),
      ],
      { CLD_AGENT_TOKEN: 'L'.repeat(43) },
    );
    expect(payload(byId(answers, 1))).toMatchObject({
      json: { status: 'created', taskId: 'T-1' },
      isError: false,
    });
    expect(payload(byId(answers, 2))).toMatchObject({
      json: { error: { code: 'unknown_task' } },
      isError: true,
    });
    expect(payload(byId(answers, 3)).json.error.code).toBe('unknown_tool');
  });
});

describe('C5a: the agent tools', () => {
  it('list_agents: you, the mode, this project only, states, queue, open tasks, limits', async () => {
    const { tools, tasks } = world(home());
    tasks.add(
      {
        project: 'alpha',
        title: 'API',
        assignee: { assignmentId: 'a_bbbbbbbbbb', name: 'alpha-a' },
      },
      'alpha',
    );
    tasks.add(
      {
        project: 'alpha',
        title: '끝난 것',
        status: 'done',
        assignee: { assignmentId: 'a_bbbbbbbbbb', name: 'alpha-a' },
      },
      'alpha',
    );
    const r = await tools.call('alpha', 'list_agents', {});
    expect(r.you).toEqual({
      id: 'a_aaaaaaaaaa',
      name: 'alpha',
      role: 'lead',
      depth: 1,
      canDelegate: false,
      canCreateWorker: false,
    });
    expect(r.mode).toBe('auto');
    expect(r.agents).toEqual([
      {
        id: 'a_bbbbbbbbbb',
        name: 'alpha-a',
        role: 'worker',
        provider: 'claude',
        model: 'm-1',
        state: 'busy',
        canAccept: true,
        queue: 2,
        openTasks: [{ id: 'T-1', title: 'API', status: 'todo' }],
      },
      {
        id: 'a_dddddddddd',
        name: 'alpha-b',
        role: 'worker',
        provider: 'claude',
        state: 'stopped',
        canAccept: false,
        why: 'stopped by the user',
        queue: 0,
        openTasks: [],
      },
    ]);
    expect(r.limits).toEqual({
      workersRunning: [1, 3],
      hostWorkersRunning: [1, 6],
      newWorkersToday: [0, 5],
      delegationsToday: [0, 30],
    });
    expect(
      ((await tools.call('alpha', 'list_agents', { state: 'idle' })).agents as unknown[]).length,
    ).toBe(0);
    expect((await tools.call('alpha', 'list_agents', { state: 'x' })).error).toMatchObject({
      code: 'bad_input',
    });
  });

  it("create_task: a Lead's is todo; a Worker's is proposed, addressed to its Lead; createdBy agent, reported", async () => {
    const { tools, tasks } = world(home());
    const lead = await tools.call('alpha', 'create_task', {
      title: '배포 준비',
      detail: '체크리스트',
    });
    expect(lead).toMatchObject({
      status: 'created',
      taskId: 'T-1',
      task: {
        status: 'todo',
        project: 'alpha',
        createdBy: 'agent:alpha',
        statusSource: 'reported',
        detail: '체크리스트',
      },
    });
    const worker = await tools.call('alpha-a', 'create_task', {
      title: '테스트 더 쓰기',
      parentTaskId: 'T-1',
    });
    expect(worker).toMatchObject({ status: 'proposed', taskId: 'T-2' });
    expect(tasks.get('T-2')).toMatchObject({
      status: 'proposed',
      parentId: 'T-1',
      createdBy: 'agent:alpha-a',
      assignee: { assignmentId: 'a_aaaaaaaaaa', name: 'alpha' },
      source: 'reported',
    });
    expect(tasks.get('T-2')!.delegatedBy).toBeUndefined();
    // Another project's parent is out of scope.
    tasks.add({ project: 'beta', title: 'beta 일' }, 'beta');
    expect(
      (await tools.call('alpha', 'create_task', { title: 'x', parentTaskId: 'T-3' })).error,
    ).toMatchObject({ code: 'out_of_scope' });
    expect((await tools.call('alpha', 'create_task', {})).error).toMatchObject({
      code: 'bad_input',
    });
  });

  it('update_task: the assignee and the Lead only, as a report; another project → out_of_scope', async () => {
    const { tools, tasks } = world(home());
    tasks.add(
      { project: 'alpha', title: 'A', assignee: { assignmentId: 'a_bbbbbbbbbb', name: 'alpha-a' } },
      'alpha',
    );
    tasks.add(
      { project: 'alpha', title: 'B', assignee: { assignmentId: 'a_dddddddddd', name: 'alpha-b' } },
      'alpha',
    );
    tasks.add({ project: 'beta', title: 'C' }, 'beta');
    expect(
      await tools.call('alpha-a', 'update_task', { taskId: 'T-1', status: 'doing', note: '시작' }),
    ).toMatchObject({
      status: 'updated',
      task: { status: 'doing', note: '시작', statusSource: 'reported' },
    });
    expect(tasks.get('T-1')!.history!.at(-1)!.by).toBe('alpha-a');
    // A stranger to the task (another Worker) is refused; the Lead may.
    expect(
      (await tools.call('alpha-a', 'update_task', { taskId: 'T-2', status: 'done' })).error,
    ).toMatchObject({ code: 'forbidden' });
    expect(tasks.get('T-2')!.status).toBe('todo');
    expect(
      await tools.call('alpha', 'update_task', { taskId: 'T-2', status: 'done' }),
    ).toMatchObject({
      status: 'updated',
      task: { reportedDone: { value: true, source: 'reported' } },
    });
    expect(
      (await tools.call('alpha', 'update_task', { taskId: 'T-3', status: 'done' })).error,
    ).toMatchObject({ code: 'out_of_scope' });
    expect(
      (await tools.call('alpha', 'update_task', { taskId: 'T-1', status: 'finished' })).error,
    ).toMatchObject({ code: 'bad_input' });
  });

  it('C4: lookups never post to a room; the assignee handing back (review, done) is one report event', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const h = home();
    fs.mkdirSync(path.dirname(approvalsPath(h)), { recursive: true });
    const delegation = {
      approvals: new ApprovalStore(approvalsPath(h)),
      providerReady: () => true,
      addWorker: () => Promise.resolve({ ok: true }),
      startAgent: () => Promise.resolve({ ok: true }),
      event: (type: string, fields: Record<string, unknown>) => void events.push([type, fields]),
    };
    const { tools, tasks, posts, sent } = world(h, { delegation });
    tasks.add({ project: 'alpha', title: 'A', assignee: { assignmentId: 'a_bbbbbbbbbb', name: 'alpha-a' } }, 'alpha');
    await tools.call('alpha', 'list_agents', {});
    await tools.call('alpha', 'get_task_status', {});
    await tools.call('alpha-a', 'get_group_context', { room: '팀방' });
    expect(posts).toEqual([]);
    expect(sent).toEqual([]);
    expect(events).toEqual([]);
    await tools.call('alpha-a', 'update_task', { taskId: 'T-1', status: 'doing' }); // progress: no report
    await tools.call('alpha-a', 'update_task', { taskId: 'T-1', status: 'review' });
    await tools.call('alpha-a', 'update_task', { taskId: 'T-1', status: 'review', note: 'x' }); // no change of status
    expect(events).toEqual([['task_report', { name: 'alpha', from: 'alpha-a', task: 'T-1', status: 'review' }]]);
  });

  it('get_task_status: one task, mine, all with a cursor; executions and facts as stored', async () => {
    const { tools, tasks } = world(home());
    tasks.add(
      {
        project: 'alpha',
        title: 'A',
        assignee: { assignmentId: 'a_bbbbbbbbbb', name: 'alpha-a' },
        commits: 2,
      },
      'alpha',
    );
    tasks.attach('T-1', { kind: 'job', ref: 'j1' }, 'alpha');
    for (let i = 0; i < 24; i++) tasks.add({ project: 'alpha', title: `t${i}` }, 'alpha');
    tasks.add({ project: 'beta', title: 'B' }, 'beta');
    const one = await tools.call('alpha-a', 'get_task_status', { taskId: 'T-1' });
    const t = (one.tasks as Array<Record<string, any>>)[0];
    expect(t.executions).toEqual([
      expect.objectContaining({ id: 'job:j1', kind: 'job', ref: 'j1' }),
    ]);
    expect(t.commits).toMatchObject({ value: 2, source: 'reported' });
    expect(t.history).toBeUndefined();
    expect(
      ((await tools.call('alpha-a', 'get_task_status', { mine: true })).tasks as unknown[]).length,
    ).toBe(1);
    const first = await tools.call('alpha', 'get_task_status', {});
    expect((first.tasks as unknown[]).length).toBe(20);
    const second = await tools.call('alpha', 'get_task_status', { cursor: first.cursor });
    expect((second.tasks as unknown[]).length).toBe(5);
    expect(second.cursor).toBeUndefined();
    expect((await tools.call('alpha', 'get_task_status', { taskId: 'T-26' })).error).toMatchObject({
      code: 'out_of_scope',
    });
  });

  it('send_message: by id or name in the project, from the caller; another project → out_of_scope', async () => {
    const { tools, sent } = world(home());
    expect(
      await tools.call('alpha', 'send_message', { to: 'a_bbbbbbbbbb', text: '리뷰 부탁' }),
    ).toEqual({ status: 'sent', to: { id: 'a_bbbbbbbbbb', name: 'alpha-a' }, delivered: 'pane' });
    expect(sent).toEqual([
      { to: 'alpha-a', text: '리뷰 부탁', ifIdle: false, from: 'alpha', source: 'mcp' },
    ]);
    expect(
      (await tools.call('alpha', 'send_message', { to: 'beta', text: 'x' })).error,
    ).toMatchObject({ code: 'out_of_scope' });
    expect(
      (await tools.call('alpha', 'send_message', { to: 'a_cccccccccc', text: 'x' })).error,
    ).toMatchObject({ code: 'out_of_scope' });
    expect(
      (await tools.call('alpha', 'send_message', { to: 'nobody', text: 'x' })).error,
    ).toMatchObject({ code: 'unknown_agent' });
    expect(sent).toHaveLength(1);
  });

  it('duplicate: the same caller and idempotencyKey gets the first result back, nothing done twice', async () => {
    const { tools, sent, tasks } = world(home());
    const first = await tools.call('alpha', 'send_message', {
      to: 'alpha-a',
      text: 'x',
      idempotencyKey: 'k1',
    });
    const again = await tools.call('alpha', 'send_message', {
      to: 'alpha-a',
      text: 'x',
      idempotencyKey: 'k1',
    });
    expect(again).toEqual({ ...first, status: 'duplicate' });
    expect(sent).toHaveLength(1);
    const made = await tools.call('alpha', 'create_task', { title: 'once', idempotencyKey: 'k2' });
    expect(
      await tools.call('alpha', 'create_task', { title: 'once', idempotencyKey: 'k2' }),
    ).toEqual({ ...made, status: 'duplicate' });
    expect(tasks.list({ project: 'alpha' })).toHaveLength(1);
    // Another caller's same key is its own.
    expect(
      await tools.call('alpha-a', 'send_message', { to: 'alpha', text: 'y', idempotencyKey: 'k1' }),
    ).toMatchObject({ status: 'sent' });
  });

  it('D3b: after a Lead swap the swapped names’ idempotency keys and pair rates are forgotten; others stay', async () => {
    const { tools, sent } = world(home());
    const msg = (from: string, to: string, key?: string) =>
      tools.call(from, 'send_message', { to, text: `${from}→${to}`, ...(key && { idempotencyKey: key }) });
    expect(await msg('alpha', 'alpha-a', 'k1')).toMatchObject({ status: 'sent' });
    expect(await msg('beta', 'beta', 'k1')).toMatchObject({ error: { code: 'bad_input' } }); // (to itself)
    expect(await msg('alpha-b', 'alpha', 'k9')).toMatchObject({ status: 'sent' });
    for (let i = 1; i < RATE.perMinute; i++) expect(await msg('alpha', 'alpha-a')).toMatchObject({ status: 'sent' });
    expect(await msg('alpha', 'alpha-a')).toMatchObject({ error: { code: 'rate_limited' } });
    expect(await msg('alpha', 'alpha-a', 'k1')).toMatchObject({ status: 'duplicate' });

    tools.forget(['alpha', 'alpha-a']);
    // A new session answers to "alpha": its key k1 and the pair alpha/alpha-a start over.
    expect(await msg('alpha', 'alpha-a', 'k1')).toMatchObject({ status: 'sent' });
    // Another caller's key is kept.
    expect(await msg('alpha-b', 'alpha', 'k9')).toMatchObject({ status: 'duplicate' });
    expect(sent.filter((x) => x.to === 'alpha-a')).toHaveLength(RATE.perMinute + 1);
  });

  it('D3b: a Task’s assignee shows under the name its assignment answers to now (the board’s rule)', async () => {
    const { tools, tasks } = world(home());
    // Stored under an old name (before a swap); a_bbbbbbbbbb now answers to "alpha-a".
    tasks.add({ title: 'old name', project: 'alpha', assignee: { assignmentId: 'a_bbbbbbbbbb', name: 'renamed' } }, 'cli');
    tasks.add({ title: 'gone', project: 'alpha', assignee: { assignmentId: 'a_zzzzzzzzzz', name: 'left' } }, 'cli');
    const all = (await tools.call('alpha', 'get_task_status', {})) as { tasks: Array<{ title: string; assignee: { name: string } }> };
    expect(all.tasks.map((t) => [t.title, t.assignee.name])).toEqual([
      ['old name', 'alpha-a'],
      ['gone', 'left'], // no agent holds it: the stored name
    ]);
    const id = tasks.list({ project: 'alpha' })[0].id;
    expect(await tools.call('alpha', 'get_task_status', { taskId: id })).toMatchObject({ tasks: [{ assignee: { name: 'alpha-a' } }] });
    expect(await tools.call('alpha', 'update_task', { taskId: id, note: 'x' })).toMatchObject({ task: { assignee: { name: 'alpha-a' } } });
    // Only what is returned changes, never the store.
    expect(tasks.list({ project: 'alpha' })[0].assignee!.name).toBe('renamed');
  });

  it('pairwise rate: the 7th message/task between two agents in a minute → rate_limited + retryAfterSec', async () => {
    let now = Date.parse('2026-10-24T09:00:00Z');
    const { tools, sent } = world(home(), { now: () => now });
    for (let i = 0; i < RATE.perMinute; i++) {
      // Both directions count for the pair (ping-pong).
      const from = i % 2 ? 'alpha-a' : 'alpha';
      expect(
        await tools.call(from, 'send_message', {
          to: from === 'alpha' ? 'alpha-a' : 'alpha',
          text: `m${i}`,
        }),
      ).toMatchObject({ status: 'sent' });
      now += 1_000;
    }
    const seventh = await tools.call('alpha', 'send_message', { to: 'alpha-a', text: 'm7' });
    expect(seventh).toEqual({
      error: { code: 'rate_limited', message: expect.any(String) },
      retryAfterSec: 54,
    });
    // A Worker's proposal to the same Lead is the same pair.
    expect((await tools.call('alpha-a', 'create_task', { title: 'p' })).error).toMatchObject({
      code: 'rate_limited',
    });
    // Another pair is free.
    expect(await tools.call('alpha', 'send_message', { to: 'alpha-b', text: 'x' })).toMatchObject({
      status: 'sent',
    });
    expect(sent).toHaveLength(RATE.perMinute + 1);
    now += 60_000;
    expect(
      await tools.call('alpha', 'send_message', { to: 'alpha-a', text: 'later' }),
    ).toMatchObject({ status: 'sent' });
  });

  it('the idempotency key is per tool: a send_message with the key of a create_task is sent', async () => {
    const { tools, sent, tasks } = world(home());
    expect(
      await tools.call('alpha', 'create_task', { title: 't', idempotencyKey: 'k' }),
    ).toMatchObject({ status: 'created' });
    expect(
      await tools.call('alpha', 'send_message', { to: 'alpha-a', text: 'x', idempotencyKey: 'k' }),
    ).toMatchObject({ status: 'sent' });
    expect(sent).toHaveLength(1);
    expect(tasks.list({ project: 'alpha' })).toHaveLength(1);
  });

  it('concurrent calls with the same key: the first runs, the others wait for it and are duplicates', async () => {
    const { tools, sent } = world(home(), { sendMs: 30 });
    const call = () =>
      tools.call('alpha', 'send_message', { to: 'alpha-a', text: 'x', idempotencyKey: 'k3' });
    const results = await Promise.all([call(), call(), call()]);
    expect(sent).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual(['duplicate', 'duplicate', 'sent']);
    expect(results.every((r) => (r.to as { name: string }).name === 'alpha-a')).toBe(true);
  });

  it('pairwise rate holds for parallel calls: 10 at once with a slow send, exactly 6 go', async () => {
    const { tools, sent } = world(home(), { sendMs: 20 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        tools.call('alpha', 'send_message', { to: 'alpha-a', text: `p${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'sent')).toHaveLength(RATE.perMinute);
    expect(
      results.filter((r) => (r.error as { code?: string } | undefined)?.code === 'rate_limited'),
    ).toHaveLength(10 - RATE.perMinute);
    expect(sent).toHaveLength(RATE.perMinute);
  });

  it('a call that fails gives its rate slot back', async () => {
    const { tools, sent } = world(home());
    expect(
      (await tools.call('alpha', 'send_message', { to: 'alpha-a', text: 'fail' })).error,
    ).toMatchObject({ code: 'queue_failed' });
    for (let i = 0; i < RATE.perMinute; i++)
      expect(
        await tools.call('alpha', 'send_message', { to: 'alpha-a', text: `m${i}` }),
      ).toMatchObject({ status: 'sent' });
    expect(sent).toHaveLength(RATE.perMinute);
  });

  it("the rate is per agent, not per spelling: alternating the target's id and name, the 7th is limited", async () => {
    const { tools, sent } = world(home());
    for (let i = 0; i < RATE.perMinute; i++)
      expect(
        await tools.call('alpha', 'send_message', {
          to: i % 2 ? 'alpha-a' : 'a_bbbbbbbbbb',
          text: `m${i}`,
        }),
      ).toMatchObject({ status: 'sent' });
    expect(
      (await tools.call('alpha', 'send_message', { to: 'a_bbbbbbbbbb', text: 'm7' })).error,
    ).toMatchObject({ code: 'rate_limited' });
    expect(sent).toHaveLength(RATE.perMinute);
  });

  it(`text over ${SEND_TEXT_MAX} characters (the app chat's limit) is bad_input`, async () => {
    const { tools, sent, posts } = world(home());
    const long = 'x'.repeat(SEND_TEXT_MAX + 1);
    expect(
      (await tools.call('alpha', 'send_message', { to: 'alpha-a', text: long })).error,
    ).toMatchObject({ code: 'bad_input' });
    expect(
      (await tools.call('alpha', 'post_to_group', { room: '팀방', text: long })).error,
    ).toMatchObject({ code: 'bad_input' });
    expect(sent).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(
      await tools.call('alpha', 'send_message', { to: 'alpha-a', text: 'x'.repeat(SEND_TEXT_MAX) }),
    ).toMatchObject({ status: 'sent' });
  });

  it('post_to_group and get_group_context: member rooms only, mentions in the project, pages', async () => {
    const { tools, posts } = world(home());
    expect(
      await tools.call('alpha', 'post_to_group', { room: '팀방', text: '@alpha-a 확인해 주세요' }),
    ).toEqual({ status: 'posted', room: '팀방', postId: 'p1', mentioned: ['alpha-a'] });
    expect(posts[0]).toMatchObject({ sender: 'alpha' });
    expect(
      (await tools.call('alpha', 'post_to_group', { room: 'beta방', text: 'x' })).error,
    ).toMatchObject({ code: 'out_of_scope' });
    expect(
      (await tools.call('alpha', 'post_to_group', { room: '전체', text: '@beta 안녕' })).error,
    ).toMatchObject({ code: 'out_of_scope' });
    expect(
      (await tools.call('alpha', 'post_to_group', { room: '팀방', text: '@ghost 안녕' })).error,
    ).toMatchObject({ code: 'unknown_member' });
    for (let i = 2; i <= 5; i++)
      await tools.call('alpha-a', 'post_to_group', { room: '팀방', text: `글 ${i}` });
    const page = await tools.call('alpha-a', 'get_group_context', { room: '팀방', n: 3 });
    expect((page.posts as Array<{ text: string }>).map((p) => p.text)).toEqual([
      '글 3',
      '글 4',
      '글 5',
    ]);
    const older = await tools.call('alpha-a', 'get_group_context', {
      room: 'g1',
      n: 3,
      cursor: page.cursor,
    });
    expect(
      (older.posts as Array<{ text: string; sender: string }>).map((p) => [p.sender, p.text]),
    ).toEqual([
      ['alpha', '@alpha-a 확인해 주세요'],
      ['alpha-a', '글 2'],
    ]);
    expect(older.cursor).toBeUndefined();
    expect(
      (await tools.call('alpha-a', 'get_group_context', { room: '전체' })).error,
    ).toMatchObject({ code: 'out_of_scope' });
  });
});
