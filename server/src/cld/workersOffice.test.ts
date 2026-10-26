// D3 in the office: a project's Lead and two Workers (the fake claude) get three
// characters in the project's room; the messenger lists the Workers under the
// project; the project's conversation reaches the Lead, a Worker's DM that Worker,
// a room mention only the mentioned Worker; `전체` stays the projects.
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GIT_AVAILABLE, makeTempRepo } from './engine/git/testRepo.js';
import type { McpTools } from './engine/mcpTools.js';
import type { Typist } from './engine/messenger.js';
import type { TaskStore } from './engine/tasks.js';
import { startEngineOffice } from './officeTestKit.js';
import { findOnPath, transcriptPath } from './providers/claudeProvider.js';
import { REPO_ROOT } from './testHome.js';
import { chatHistory } from './transcriptHistory.js';

const WAIT = { timeout: 15_000, interval: 50 };

async function leadAndWorkersOffice() {
  const typed: Array<{ id: string; text: string }> = [];
  const typist: Typist = {
    type: (id, text) => (typed.push({ id, text }), Promise.resolve('typed')),
  };
  const t = await startEngineOffice({ readOnly: false, chat: true, extra: { typist } });
  const got: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => got.push(m);
  t.office.onClientOpened(send); // a viewer: the messenger's contacts are polled
  let n = 0;
  const ask = async (msg: Record<string, unknown>) => {
    const requestId = `r${++n}`;
    t.office.onClientMessage({ ...msg, requestId }, send, true);
    return vi.waitFor(() => {
      const r = got.find((m) => m.requestId === requestId && String(m.type).endsWith('Result'));
      expect(r).toBeDefined();
      return r!;
    }, WAIT);
  };
  const engine = (action: string, name: string, fields: Record<string, unknown> = {}) =>
    ask({ type: 'engineAction', action, name, ...fields });
  const folder = path.join(t.home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  expect(await engine('add', 'alpha', { folder, room: 'lab' })).toMatchObject({ ok: true });
  for (const name of ['alpha-a', 'alpha-b'])
    expect(await engine('add', name, { role: 'worker', project: 'alpha' })).toMatchObject({
      ok: true,
    });
  const bg = (name: string) => t.office.engine!.state().projects.find((p) => p.name === name)?.bgId;
  return { ...t, typed, got, ask, engine, folder, bg };
}

describe('D3: a Lead and Workers in the office and the messenger', () => {
  it('three characters, Workers under their project, the right session for each address', async () => {
    const t = await leadAndWorkersOffice();
    for (const name of ['alpha', 'alpha-a', 'alpha-b'])
      expect(await t.engine('start', name)).toMatchObject({ ok: true });

    // Three characters, all in the project's room.
    await vi.waitFor(() => {
      t.office.recompute();
      const orch = t.office.officeState().orchestrators.filter((o) => o.name.startsWith('alpha'));
      expect(orch.map((o) => [o.name, o.tab]).sort()).toEqual([
        ['alpha', 'lab'],
        ['alpha-a', 'lab'],
        ['alpha-b', 'lab'],
      ]);
    }, WAIT);

    // The messenger: the project's chat (its Lead) and its Workers under it.
    await vi.waitFor(() => {
      t.office.recompute();
      const contacts = (t.last('messengerContacts') as {
        contacts: Array<{ name: string; project?: string }>;
      }).contacts;
      expect(contacts.map((c) => [c.name, c.project ?? null]).sort()).toEqual([
        ['alpha', null],
        ['alpha-a', 'alpha'],
        ['alpha-b', 'alpha'],
      ]);
    }, WAIT);

    // The project's conversation reaches the Lead; a Worker's DM that Worker.
    expect(await t.ask({ type: 'chatSend', name: 'alpha', text: 'for the lead' })).toMatchObject({
      ok: true,
    });
    expect(await t.ask({ type: 'chatSend', name: 'alpha-b', text: 'for b' })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => expect(t.typed).toHaveLength(2), WAIT);
    expect(t.typed.map((x) => [x.id, x.text.split('\n').at(-1)])).toEqual([
      [t.bg('alpha'), 'for the lead'],
      [t.bg('alpha-b'), 'for b'],
    ]);

    // Rooms: 전체 stays the projects; a room may hold Workers by name; a mention reaches only its Worker.
    expect(
      await t.ask({ type: 'groupAction', action: 'create', name: 'dev', members: ['alpha', 'alpha-a', 'alpha-b'] }),
    ).toMatchObject({ ok: true });
    const rooms = (t.last('groupRooms') as { rooms: Array<{ id: string; name: string; members: string[] }> })
      .rooms;
    expect(rooms.find((r) => r.id === 'all')!.members).toEqual(['alpha']);
    expect(rooms.find((r) => r.name === 'dev')!.members).toEqual(['alpha', 'alpha-a', 'alpha-b']);
    t.typed.length = 0;
    expect(await t.ask({ type: 'groupPost', room: 'dev', text: '@alpha-a 리뷰 부탁' })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => expect(t.typed).toHaveLength(1), WAIT);
    await new Promise((r) => setTimeout(r, 300)); // and nobody else
    expect(t.typed.map((x) => x.id)).toEqual([t.bg('alpha-a')]);
    expect(t.typed[0].text).toContain("단톡방 'dev'");
  }, 60_000);
});

// D3b, EX-3j style: after a Lead swap every name-keyed store keeps its keys (names are slots).
describe('D3b: after promoting a Worker', () => {
  it('contacts, rooms, pins and characters keep their keys; the first prompt is typed first; the project chat scrolls into the old Lead', async () => {
    const t = await leadAndWorkersOffice();
    for (const name of ['alpha', 'alpha-a']) expect(await t.engine('start', name)).toMatchObject({ ok: true });
    const engine = t.office.engine!;
    const sid = (n: string) => engine.state().projects.find((p) => p.name === n)!.sessionId!;
    // The old Lead's conversation, on disk (the fake writes none).
    const oldLead = sid('alpha');
    const oldFile = transcriptPath(t.folder, oldLead, t.home);
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    const line = (role: 'user' | 'assistant', text: string, at: string, uuid: string) =>
      JSON.stringify({ type: role, uuid, timestamp: at, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } });
    fs.writeFileSync(oldFile, `${line('user', '예전 질문', '2026-10-24T01:00:00.000Z', 'u1')}\n${line('assistant', '이전 Lead 의 답', '2026-10-24T01:00:01.000Z', 'a1')}\n`);
    expect(await t.ask({ type: 'groupAction', action: 'create', name: 'dev', members: ['alpha', 'alpha-a'] })).toMatchObject({ ok: true });
    t.office.onClientMessage({ type: 'setConversationPin', key: 'alpha', pinned: true }, () => undefined, true);
    const view = () => {
      t.office.recompute();
      const contacts = (t.last('messengerContacts') as { contacts: Array<{ name: string; project?: string }> }).contacts;
      const rooms = (t.last('groupRooms') as { rooms: Array<{ name: string; members: string[] }> }).rooms;
      return {
        contacts: contacts.map((c) => [c.name, c.project ?? null]).sort(),
        rooms: rooms.map((r) => [r.name, r.members]),
        characters: t.office.officeState().orchestrators.map((o) => [o.name, o.tab]).sort(),
        pins: fs.readFileSync(path.join(t.home, '.config/agent-tycoon/pins.json'), 'utf8'),
      };
    };
    const before = await vi.waitFor(() => {
      const v = view();
      expect(v.contacts).toEqual([['alpha', null], ['alpha-a', 'alpha'], ['alpha-b', 'alpha']]);
      expect(v.pins).toContain('alpha');
      return v;
    }, WAIT);
    t.typed.length = 0;

    // C6: a Worker's proposal waits for the Lead (assigned to the Lead's assignment).
    const ids = Object.fromEntries(engine.roster().map((r) => [r.name, r.assignmentId]));
    const tasks = (t.office as unknown as { tasks: TaskStore }).tasks;
    const proposal = tasks.add(
      { project: 'alpha', title: '제안', status: 'proposed', assignee: { assignmentId: ids.alpha, name: 'alpha' } },
      'agent:alpha-b',
    ).task as { id: string };
    const assigned = tasks.add({ project: 'alpha', title: '맡은 일', assignee: { assignmentId: ids.alpha, name: 'alpha' } }, 'cli')
      .task as { id: string };

    expect(await t.engine('promote', 'alpha-a', { oldLead: 'worker' })).toMatchObject({ ok: true });
    // The proposal goes to the new Lead (the seat); an ordinary Task follows its agent (by id).
    expect(tasks.get(proposal.id)!.assignee).toEqual({ assignmentId: ids['alpha-a'], name: 'alpha' });
    expect(tasks.get(assigned.id)!.assignee).toEqual({ assignmentId: ids.alpha, name: 'alpha-a' });
    // The new Lead's first typed message is the swap prompt.
    await vi.waitFor(() => expect(t.typed.some((x) => x.id === t.bg('alpha'))).toBe(true), WAIT);
    expect(t.typed.find((x) => x.id === t.bg('alpha'))!.text).toMatch(/^\[cld-gui Lead 교체 · /);
    await vi.waitFor(() => expect(view()).toEqual(before), WAIT);

    // The project chat (its new Lead's fresh conversation) scrolls back into the old Lead's.
    const newFile = transcriptPath(t.folder, sid('alpha'), t.home);
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    fs.writeFileSync(newFile, `${line('assistant', '새 Lead 입니다', new Date().toISOString(), 'a2')}\n`);
    const page = await chatHistory(newFile);
    expect(page.items.map((i) => i.text)).toEqual(['예전 질문', '이전 Lead 의 답', '새 Lead 입니다']);
    expect(page.items[0].session).toBe(oldLead);
  }, 60_000);
});

// D3b fix round (D4, M1): the office's wiring at a swap.
describe('D3b: the office at a swap', () => {
  it('a message to the Worker’s name while the swap stops its session waits, then reaches the new Lead (held, re-addressed, the messenger re-read)', async () => {
    const t = await leadAndWorkersOffice();
    for (const name of ['alpha', 'alpha-a']) expect(await t.engine('start', name)).toMatchObject({ ok: true });
    const oldW = t.bg('alpha-a')!;
    const oldL = t.bg('alpha')!;
    t.typed.length = 0;
    const promote = t.engine('promote', 'alpha-a', { oldLead: 'worker' }); // holds both names now
    const sent = await t.ask({ type: 'chatSend', name: 'alpha-a', text: 'during the swap' });
    expect(sent).toMatchObject({ ok: true, delivered: 'queued' });
    expect(await promote).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(t.typed.some((x) => x.text.endsWith('during the swap'))).toBe(true), WAIT);
    const typedTo = t.typed.find((x) => x.text.endsWith('during the swap'))!.id;
    expect(typedTo).toBe(t.bg('alpha')); // the new Lead (it was for W, who answers to alpha now)
    expect([oldW, oldL, t.bg('alpha-a')]).not.toContain(typedTo);
  }, 60_000);

  it('the MCP tools forget the swapped names’ idempotency keys', async () => {
    const t = await leadAndWorkersOffice();
    for (const name of ['alpha', 'alpha-a', 'alpha-b']) expect(await t.engine('start', name)).toMatchObject({ ok: true });
    const mcp = (t.office as unknown as { mcp: McpTools }).mcp;
    const call = () => mcp.call('alpha', 'send_message', { to: 'alpha-b', text: 'once', idempotencyKey: 'k1' });
    expect(await call()).toMatchObject({ status: 'sent' });
    expect(await call()).toMatchObject({ status: 'duplicate' });
    expect(await t.engine('promote', 'alpha-a', { oldLead: 'stop' })).toMatchObject({ ok: true });
    expect(await call()).toMatchObject({ status: 'sent' }); // a new session answers to alpha
  }, 60_000);
});

describe('D3b: a swap finished at start', () => {
  it('L1: the project’s open proposals move to the new Lead then too', async () => {
    const t = await leadAndWorkersOffice();
    for (const name of ['alpha', 'alpha-a']) expect(await t.engine('start', name)).toMatchObject({ ok: true });
    const engine = t.office.engine!;
    const ids = Object.fromEntries(engine.roster().map((r) => [r.name, r.assignmentId]));
    const tasks = (t.office as unknown as { tasks: TaskStore }).tasks;
    const proposal = tasks.add(
      { project: 'alpha', title: '제안', status: 'proposed', assignee: { assignmentId: ids.alpha, name: 'alpha' } },
      'agent:alpha-b',
    ).task as { id: string };
    // The commit cannot write the registry (the folder read-only right after the token drops).
    const cfg = path.join(t.home, '.config', 'agent-tycoon');
    const drop = engine.tokens.drop.bind(engine.tokens);
    let drops = 0;
    engine.tokens.drop = (name: string) => {
      drop(name);
      if (++drops === 2) fs.chmodSync(cfg, 0o500);
    };
    const out = await t.engine('promote', 'alpha-a');
    fs.chmodSync(cfg, 0o700);
    expect(out).toMatchObject({ ok: false });
    expect(tasks.get(proposal.id)!.assignee!.assignmentId).toBe(ids.alpha);
    t.stop();
    const again = await startEngineOffice({ home: t.home, readOnly: false, chat: true });
    const after = (again.office as unknown as { tasks: TaskStore }).tasks;
    expect(again.office.engine!.roster().find((r) => r.name === 'alpha')!.assignmentId).toBe(ids['alpha-a']);
    expect(after.get(proposal.id)!.assignee).toEqual({ assignmentId: ids['alpha-a'], name: 'alpha' });
    again.stop();
  }, 60_000);
});

// D5: a Codex Worker (the fake codex, the real worker as an engine job) through the office:
// delegate_task → one run → its Task's Execution (exit, commits observed; summary reported) →
// one line to the Lead under the Worker's name, and only one across a daemon restart.
describe.runIf(GIT_AVAILABLE && process.platform !== 'win32')('D5: a Codex Worker in the office', () => {
  const FAKE_BIN = path.join(REPO_ROOT, 'cld/test/fake-codex');
  let worker = '';
  const keepPath = process.env.PATH;
  beforeAll(() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-worker-'));
    worker = path.join(out, 'cld-worker.js');
    buildSync({
      entryPoints: [path.join(REPO_ROOT, 'server/src/cld/engine/workerMain.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: worker,
      logLevel: 'silent',
    });
    // Never the user's PATH: the real codex lives there. node, git and the fake only.
    process.env.PATH = [FAKE_BIN, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
    if (findOnPath('codex', process.env.PATH) !== path.join(FAKE_BIN, 'codex')) throw new Error('not the fake codex');
  }, 120_000);
  afterAll(() => {
    process.env.PATH = keepPath;
  });

  it('delegate → run → Execution (exit 0, a commit, the report) → the Lead told once, also after a restart', async () => {
    const repo = makeTempRepo({ push: false });
    try {
      const typed: Array<{ id: string; text: string }> = [];
      const typist: Typist = { type: (id, text) => (typed.push({ id, text }), Promise.resolve('typed')) };
      const t = await startEngineOffice({ readOnly: false, chat: true, extra: { typist, worker, messengerTiming: { noticeBatchMs: 0 } } });
      fs.writeFileSync(path.join(t.home, 'fake-codex.json'), JSON.stringify({ message: '로그인 고쳤어요. 남은 일 없음' }));
      const office = t.office;
      const engine = office.engine!;
      const act = (action: string, name: string, f: Record<string, unknown> = {}) =>
        engine.run({ type: 'engineAction', requestId: `r-${action}-${name}`, action: action as 'add', name, ...f }, true);
      expect(await act('add', 'alpha', { folder: repo.folder })).toMatchObject({ ok: true });
      expect(await act('add', 'alpha-w1', { role: 'worker', project: 'alpha', provider: 'codex', model: 'model-a' })).toMatchObject({ ok: true });
      expect(await act('add', 'alpha-x', { role: 'worker', project: 'alpha', provider: 'codex', permissionMode: 'plan' })).toMatchObject({
        ok: false,
        error: 'Codex Worker 는 이 설정을 받지 않아요: permissionMode',
      });
      for (const n of ['alpha', 'alpha-w1']) expect(await act('start', n)).toMatchObject({ ok: true });
      const w1 = engine.roster().find((a) => a.name === 'alpha-w1')!;
      expect(w1).toMatchObject({ provider: 'codex', live: false, wantRunning: true });
      expect(engine.state().projects.find((p) => p.name === 'alpha-w1')).toMatchObject({ provider: 'codex', live: true });
      // F4: the first report to the Lead does not go (a write that failed): tried again later.
      const send = office.messenger!.send.bind(office.messenger!);
      let refused = 0;
      vi.spyOn(office.messenger!, 'send').mockImplementation((req) =>
        req.from === 'alpha-w1' && refused++ === 0
          ? Promise.resolve({ ok: false, code: 'queue_failed', error: 'test: not written' })
          : send(req),
      );
      const mcp = (office as unknown as { mcp: McpTools }).mcp;
      const r = await mcp.call('alpha', 'delegate_task', {
        idempotencyKey: 'd5-1',
        task: { title: '로그인 고치기', detail: '세션이 끊겨요' },
        target: { agentId: w1.assignmentId },
      });
      expect(r).toMatchObject({ status: 'accepted', agentId: w1.assignmentId });
      const tasks = (office as unknown as { tasks: TaskStore }).tasks;
      const taskId = r.taskId as string;
      const exec = () => tasks.get(taskId)!.executions!.find((e) => e.kind === 'codex');
      await vi.waitFor(() => expect(exec()?.exit).toBeDefined(), { timeout: 60_000, interval: 100 });
      expect(exec()).toMatchObject({
        exit: { value: 0, source: 'observed' },
        commits: { value: 1, source: 'observed' },
        summary: { value: '로그인 고쳤어요. 남은 일 없음', source: 'reported' },
      });
      expect(tasks.get(taskId)!.status).toBe('todo'); // a run never sets the status (D6)
      // The prompt: the office's header naming the Lead and the Task, and the Codex delivery line.
      const call = JSON.parse(fs.readFileSync(path.join(t.home, 'fake-codex.log'), 'utf-8').split('\n')[0]) as { argv: string[]; stdin: string };
      // C7b: a new thread's prompt starts with the shipped Worker rules, then `---`, then the message.
      expect(call.stdin.split('\n---\n').at(-1)!.trimStart()).toMatch(new RegExp(`^\\[cld-gui · alpha에게서 · Task ${taskId} · `));
      expect(call.stdin).toContain('마지막 메시지에 결과·커밋·남은 일을 짧게 적어 주세요');
      expect(call.argv).toContain('model-a');
      // The Lead: one line under the Worker's name with the facts and the report (the second try:
      // the safety refresh's beat, as the engine's 30 s timer calls it).
      const told = () => typed.filter((x) => x.text.includes('alpha-w1에게서'));
      await vi.waitFor(() => expect(refused).toBe(1), { timeout: 30_000, interval: 100 });
      await new Promise((x) => setTimeout(x, 300));
      expect(told()).toEqual([]);
      (office as unknown as { reportWorkerRuns(): void }).reportWorkerRuns();
      await vi.waitFor(() => expect(told()).toHaveLength(1), { timeout: 30_000, interval: 100 });
      expect(told()[0].text).toMatch(new RegExp(`^\\[cld-gui · alpha-w1에게서 · Task ${taskId} · `));
      expect(told()[0].text).toContain('끝남 · exit 0 · 커밋 1개');
      expect(told()[0].text).toContain('보고(Worker 의 말):\n로그인 고쳤어요. 남은 일 없음');
      // No contractor character for a Worker's run; its own character is there.
      office.recompute();
      expect(office.officeState().orchestrators.map((o) => o.name)).toContain('alpha-w1');
      expect((t.last('codexTasks') as { tasks: Array<{ agent?: string; agentId: number | null }> }).tasks).toEqual([
        expect.objectContaining({ agent: 'alpha-w1', task: taskId, agentId: null }),
      ]);
      // A daemon restart tells nobody again.
      t.stop();
      const typed2: string[] = [];
      const again = await startEngineOffice({
        home: t.home,
        readOnly: false,
        chat: true,
        extra: { typist: { type: (_id, text) => (typed2.push(text), Promise.resolve('typed')) }, worker },
      });
      await new Promise((x) => setTimeout(x, 3_000));
      expect(typed2.filter((x) => x.includes('alpha-w1에게서'))).toEqual([]);
      again.stop();
    } finally {
      repo.cleanup();
    }
  }, 120_000);
});
