// TOKEN-GUARD (directive 10-24 §6) in the office: a page reload, a reconnect or a status look
// types nothing into any session; a Codex Worker's summary copied into a room wakes nobody; the
// Lead's message to its Worker and the boss's messages go in as before.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import type { CodexRecord } from './engine/codex.js';
import type { McpTools } from './engine/mcpTools.js';
import type { Typist } from './engine/messenger.js';
import { startEngineOffice } from './officeTestKit.js';

const WAIT = { timeout: 15_000, interval: 50 };

async function office() {
  const typed: Array<{ id: string; text: string }> = [];
  const typist: Typist = { type: (id, text) => (typed.push({ id, text }), Promise.resolve('typed')) };
  const t = await startEngineOffice({ readOnly: false, chat: true, extra: { typist, messengerTiming: { noticeBatchMs: 0 } } });
  const got: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => got.push(m);
  let n = 0;
  const ask = async (msg: Record<string, unknown>, to = send) => {
    const requestId = `r${++n}`;
    t.office.onClientMessage({ ...msg, requestId }, to, true);
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
    expect(await engine('add', name, { role: 'worker', project: 'alpha' })).toMatchObject({ ok: true });
  for (const name of ['alpha', 'alpha-a', 'alpha-b'])
    expect(await engine('start', name)).toMatchObject({ ok: true });
  const bg = (name: string) => t.office.engine!.state().projects.find((p) => p.name === name)?.bgId;
  const config = path.join(t.home, '.config/agent-tycoon');
  const files = (dir: string) => {
    try {
      return fs.readdirSync(path.join(config, dir), { recursive: true }).map(String).filter((f) => /\.(json|md)$/.test(f));
    } catch {
      return [];
    }
  };
  return { ...t, typed, got, send, ask, bg, files, engine };
}

describe('TOKEN-GUARD in the office', () => {
  it('reloads, reconnects and status looks type nothing and queue nothing', async () => {
    const t = await office();
    const agentId = t.agentId('alpha');
    // Ten page loads / reconnects: every message the transport replays on a new socket (sessionKey).
    for (let i = 0; i < 10; i++) {
      const page = (m: Record<string, unknown>) => t.got.push(m);
      t.office.onClientOpened(page);
      for (const msg of [
        { type: 'webviewReady' },
        { type: 'viewerVisibility', visible: true },
        { type: 'statusView', name: 'alpha', on: true },
        { type: 'chatView', agentId, on: true },
        { type: 'workView', kind: 'tasks', agentId, on: true },
        { type: 'repoView', project: 'alpha', on: true },
        { type: 'groupView', room: 'all', on: true },
      ])
        t.office.onClientMessage(msg, page, true);
      t.office.onClientClosed(page);
    }
    await new Promise((r) => setTimeout(r, 2_500)); // more than one messenger tick
    expect(t.typed).toEqual([]);
    expect(t.files('queue')).toEqual([]);
    expect(t.files('inbox')).toEqual([]);
  }, 60_000);

  it('SPT-P1A: turning spec tracking on, its scans and its reads type nothing, queue nothing and wake nobody', async () => {
    const t = await office();
    const folder = path.join(t.home, 'work', 'alpha');
    fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'docs', 'SRS.md'), '| ID | x |\n|---|---|\n| FR-OFC-001 | ask the agent @alpha |\n');
    fs.writeFileSync(path.join(folder, 'TODO.md'), '- [ ] wake alpha-a\n');
    const p = t.office.spec.project('alpha');
    expect(p).toBeDefined();
    const sessions = () => t.office.engine!.state().projects.map((x) => [x.name, x.bgId, x.live]);
    const before = sessions();
    expect(t.office.spec.scans).toBe(0); // the office started and nobody read: no scan
    await t.office.spec.candidates(p!);
    expect(await t.office.spec.enable(p!, ['docs/SRS.md', 'TODO.md'])).toMatchObject({ ok: true });
    for (let i = 0; i < 5; i++) {
      await t.office.spec.summary(p!);
      await t.office.spec.docs(p!);
    }
    expect(t.office.spec.disable(p!)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 2_500)); // more than one messenger tick
    expect(t.typed).toEqual([]);
    expect(t.files('queue')).toEqual([]);
    expect(t.files('inbox')).toEqual([]);
    expect(sessions()).toEqual(before);
  }, 60_000);

  it('SPT-P1D: a remove deletes by projectId: without the purge box the cache goes and registry.json stays; with it spec/<projectId>/ goes; nothing typed', async () => {
    const t = await office();
    const folder = path.join(t.home, 'work', 'alpha');
    fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'docs', 'SRS.md'), '| ID | x |\n|---|---|\n| FR-OFC-001 | a requirement that stays |\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(folder, 'docs', 'SRS.md'), old, old);
    const spec = path.join(t.home, '.config/agent-tycoon/spec');
    const p1 = t.office.spec.project('alpha')!;
    expect(await t.office.spec.enable(p1, ['docs/SRS.md'])).toMatchObject({ ok: true });
    expect(fs.readdirSync(path.join(spec, p1.projectId)).sort()).toEqual(['match-cache.json.gz', 'registry.json']);
    // A rename keeps the projectId: nothing goes.
    expect(t.office.engine!.rename('alpha', 'alpha2', 'test')).toEqual({ ok: true });
    await vi.waitFor(() => expect(t.office.spec.project('alpha2')?.projectId).toBe(p1.projectId), { timeout: 30_000, interval: 100 });
    // The whole rename, not only its registry line: under load the remove met a rename half done (11-03 gate).
    await t.office.engine!.renameRun;
    expect(fs.readdirSync(path.join(spec, p1.projectId)).sort()).toEqual(['match-cache.json.gz', 'registry.json']);
    // Another project of the same name later must not lose it: the delete goes by projectId.
    expect(await t.engine('remove', 'alpha2')).toMatchObject({ ok: true });
    expect(fs.readdirSync(path.join(spec, p1.projectId))).toEqual(['registry.json']);
    const uids = ((await t.office.spec.items(p1, {})) as { ok: true; value: { items: Array<{ uid: string }> } }).value.items.map((i) => i.uid);
    // Added again from the same folder: offered, and only taken over when the owner accepts (TOKEN-GUARD: nobody typed to).
    expect(await t.engine('add', 'alpha', { folder, room: 'lab' })).toMatchObject({ ok: true });
    const p2 = t.office.spec.project('alpha')!;
    expect(p2.projectId).not.toBe(p1.projectId);
    expect(await t.office.spec.summary(p2)).toMatchObject({ enabled: false, inherit: [{ from: p1.projectId, why: 'samePath', name: 'alpha2' }] });
    expect(fs.existsSync(path.join(spec, p2.projectId))).toBe(false);
    expect(await t.office.spec.inherit(p2, { from: p1.projectId, answer: 'accept' })).toMatchObject({ ok: true });
    const after = (await t.office.spec.items(p2, {})) as { ok: true; value: { items: Array<{ uid: string }> } };
    expect(after.value.items.map((i) => i.uid)).toEqual(uids);
    fs.mkdirSync(path.join(spec, 'p_zzzzzzzzzz')); // somebody else's sidecar
    fs.writeFileSync(path.join(spec, 'p_zzzzzzzzzz', 'registry.json'), '{}');
    expect(await t.engine('remove', 'alpha', { purge: true })).toMatchObject({ ok: true });
    expect(fs.readdirSync(spec)).toEqual(['p_zzzzzzzzzz']); // 데이터까지 지우기: its folder only
    expect(t.typed).toEqual([]);
  }, 60_000);

  it('SPT-P1D: after a daemon restart, a remove before anyone opens the spec tabs still deletes (keep: the cache; purge: the folder)', async () => {
    const t = await office();
    const spec = path.join(t.home, '.config/agent-tycoon/spec');
    const ids: Record<string, string> = {};
    for (const name of ['alpha', 'beta']) {
      const folder = path.join(t.home, 'work', name);
      fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'docs', 'SRS.md'), '| ID | x |\n|---|---|\n| FR-OFC-001 | a requirement |\n');
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(folder, 'docs', 'SRS.md'), old, old);
      if (name === 'beta') expect(await t.engine('add', 'beta', { folder, room: 'lab' })).toMatchObject({ ok: true });
      const p = t.office.spec.project(name)!;
      ids[name] = p.projectId;
      expect(await t.office.spec.enable(p, ['docs/SRS.md'])).toMatchObject({ ok: true });
    }
    t.stop();
    // The same HOME, a new daemon: nothing reads a spec route before the removes.
    const typed: Array<{ id: string; text: string }> = [];
    const t2 = await startEngineOffice({ home: t.home, readOnly: false, chat: true, extra: { typist: { type: (id, text) => (typed.push({ id, text }), Promise.resolve('typed')) } } });
    const got: Array<Record<string, unknown>> = [];
    let n = 0;
    const engine2 = async (action: string, name: string, fields: Record<string, unknown> = {}) => {
      const requestId = `x${++n}`;
      t2.office.onClientMessage({ type: 'engineAction', action, name, ...fields, requestId }, (m) => got.push(m), true);
      return vi.waitFor(() => {
        const r = got.find((m) => m.requestId === requestId && String(m.type).endsWith('Result'));
        expect(r).toBeDefined();
        return r!;
      }, WAIT);
    };
    // The restart revives both first ("already busy" until it is done): the remove goes in once it may.
    const remove = (name: string, fields: Record<string, unknown> = {}) =>
      vi.waitFor(async () => {
        const r = await engine2('remove', name, fields);
        expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      }, { timeout: 30_000, interval: 250 });
    await remove('alpha');
    expect(fs.readdirSync(path.join(spec, ids.alpha))).toEqual(['registry.json']);
    await remove('beta', { purge: true });
    expect(fs.existsSync(path.join(spec, ids.beta))).toBe(false);
    expect(typed).toEqual([]);
  }, 60_000);

  it('TG-02b: a Codex Worker\'s summary mentioning @전체 goes to the room for reading; only the Lead is told', async () => {
    const t = await office();
    expect(
      await t.ask({ type: 'groupAction', action: 'create', name: 'dev', members: ['alpha', 'alpha-a', 'alpha-b'] }),
    ).toMatchObject({ ok: true });
    const room = (t.last('groupRooms') as { rooms: Array<{ id: string; name: string }> }).rooms.find((r) => r.name === 'dev')!;
    const record = {
      id: 'c0ffee01',
      project: 'alpha',
      model: null,
      state: 'done',
      dir: t.home,
      worktree: null,
      branch: null,
      base: null,
      spec: '',
      started: new Date().toISOString(),
      ended: new Date().toISOString(),
      exit: 0,
      resetAt: null,
      sid: null,
      commits: null,
      jobId: 'j1',
      log: '',
      pid: null,
      source: 'codex',
      agent: 'alpha-b',
      room: { id: room.id },
      summary: '@전체 다 됐어요. 다음은 @alpha-a 차례',
    } as CodexRecord;
    const told = path.join(t.home, 'c0ffee01.told');
    await (t.office as unknown as {
      tellWorkerRun(r: CodexRecord, mark: string, file: string): Promise<void>;
    }).tellWorkerRun(record, 'end', told);
    await vi.waitFor(() => expect(t.typed).toHaveLength(1), { timeout: 10_000, interval: 100 }); // K1: the tick types it
    await new Promise((r) => setTimeout(r, 1_000));
    expect(t.typed.map((x) => x.id)).toEqual([t.bg('alpha')]); // the Lead's one report
    expect(t.typed[0].text).toContain('alpha-b에게서');
    const timeline = t.office.groupMessages!.timeline(t.office.groupStore!.find('dev')!);
    expect(timeline.at(-1)).toMatchObject({ sender: 'alpha-b', text: '@전체 다 됐어요. 다음은 @alpha-a 차례', targets: [] });
  }, 60_000);

  it('liveness: the Lead messages its Worker, the Worker answers, the boss writes: all go in', async () => {
    const t = await office();
    const mcp = (t.office as unknown as { mcp: McpTools }).mcp;
    expect(await mcp.call('alpha', 'send_message', { to: 'alpha-a', text: '이 작업 맡아 줘', idempotencyKey: 'k1' })).toMatchObject({ status: 'sent' });
    expect(await mcp.call('alpha-a', 'send_message', { to: 'alpha', text: '네, 시작해요', idempotencyKey: 'k2' })).toMatchObject({ status: 'sent' });
    expect(await t.ask({ type: 'chatSend', name: 'alpha', text: '사장이에요' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(t.typed).toHaveLength(3), WAIT);
    expect(t.typed.map((x) => [x.id, x.text.split('\n').at(-1)])).toEqual([
      [t.bg('alpha-a'), '이 작업 맡아 줘'],
      [t.bg('alpha'), '네, 시작해요'],
      [t.bg('alpha'), '사장이에요'],
    ]);
  }, 60_000);

  it('C4: a delegation is one room line nobody is woken by; the room switches its lines off', async () => {
    const t = await office();
    expect(await t.ask({ type: 'groupAction', action: 'create', name: 'dev', members: ['alpha', 'alpha-a'] })).toMatchObject({ ok: true });
    const room = () => t.office.groupStore!.find('dev')!;
    const lines = () => t.office.groupMessages!.timeline(room()).map((p) => p.text);
    const line = (t.office as unknown as { systemLine(type: string, f: Record<string, unknown>): void }).systemLine.bind(t.office);
    line('delegate', { task: 'T-1', from: 'alpha', to: 'alpha-a', status: 'accepted' });
    line('delegation_decision', { task: 'T-1', from: 'alpha', to: 'alpha-a' }); // not a collaboration line
    expect(lines()).toEqual(['Task T-1 배정: alpha → alpha-a']);
    expect(await t.ask({ type: 'groupAction', action: 'systemLines', id: room().id, on: false })).toMatchObject({ ok: true });
    line('task_report', { task: 'T-1', from: 'alpha-a', status: 'review' });
    expect(lines()).toEqual([]);
    expect(t.typed).toEqual([]);
  }, 60_000);
});
