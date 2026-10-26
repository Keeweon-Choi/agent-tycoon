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
  return { ...t, typed, got, send, ask, bg, files };
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
