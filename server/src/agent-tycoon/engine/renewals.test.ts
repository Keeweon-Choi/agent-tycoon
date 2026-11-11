import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { fail, type Outcome } from './engineAction.js';
import type { LeadTerm } from './leadSwap.js';
import type { ProjectRecord } from './registry.js';
import { historyHop, Renewals, type RenewalsDeps, type RenewTerm, subagentsLeft } from './renewals.js';
import type { Live } from './sessionMatch.js';

describe('K1 (B3): the conversation before, by the recorded history', () => {
  const lead1: LeadTerm = { projectId: 'p_1', assignmentId: 'a_1', sessionId: 'L1', transcript: '/d/L1.jsonl', bytes: 10, endedAt: 1000 };
  const renew23: RenewTerm = { name: 'proj', projectId: 'p_1', sessionId: 'L2', next: 'L3', transcript: '/d/L2.jsonl', bytes: 20, endedAt: 5000 };
  // L3 leads p_1 now; L2 (its renewed-away conversation) no longer runs.
  const projectOf = (sid: string) => (sid === 'L3' ? 'p_1' : null);

  it('a Lead swapped in once, then renewed: back from L3 is L2 (the renew), then L1 (the swap)', () => {
    expect(historyHop('/d/L3.jsonl', 6000, [lead1], [renew23], projectOf)).toEqual({ file: '/d/L2.jsonl', end: 20 });
    expect(historyHop('/d/L2.jsonl', 1500, [lead1], [renew23], projectOf)).toEqual({ file: '/d/L1.jsonl', end: 10 });
    expect(historyHop('/d/L1.jsonl', 500, [lead1], [renew23], projectOf)).toBeNull();
  });

  it('the latest that ended by the start wins; a Worker renew does not join the Lead chain', () => {
    const later: LeadTerm = { ...lead1, sessionId: 'L2', transcript: '/d/L2b.jsonl', endedAt: 7000 };
    // A swap after the renew (ended 7000) is the one before a conversation started at 8000.
    expect(historyHop('/d/L3.jsonl', 8000, [lead1, later], [renew23], projectOf)).toEqual({ file: '/d/L2b.jsonl', end: 10 });
    const worker: RenewTerm = { name: 'w', sessionId: 'W1', next: 'W2', transcript: '/d/W1.jsonl', bytes: 5, endedAt: 3000 };
    expect(historyHop('/d/W2.jsonl', 4000, [lead1], [worker], () => null)).toEqual({ file: '/d/W1.jsonl', end: 5 });
    expect(historyHop('/d/W1.jsonl', 2000, [lead1], [worker], () => null)).toBeNull();
  });
});

/** T-95: a failed renew tells the Lead whose conversation is still there, once, with its reason. */
describe('T-95: the failed-renew notice', () => {
  const homes: string[] = [];
  afterEach(() => homes.splice(0).forEach((h) => fs.rmSync(h, { recursive: true, force: true })));
  const p = { name: 'alpha', sessionId: 'old1' } as unknown as ProjectRecord;

  function rig(over: Partial<RenewalsDeps> & { status?: string; kind?: string } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'renewals-'));
    homes.push(home);
    const told: Array<[string, string]> = [];
    const events: Array<Record<string, unknown>> = [];
    const live = { kind: over.kind ?? 'background', status: over.status ?? 'idle' } as unknown as Live;
    const r = new Renewals({
      home,
      timing: { renewWaitMs: 60, renewPollMs: 10 },
      running: new Set(),
      disposed: () => false,
      broken: () => null,
      find: () => p,
      rereadLive: () => {},
      holder: () => live,
      refresh: () => {},
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      enqueue: (fn) => fn(),
      stopSession: () => Promise.resolve<Outcome>({ ok: true }),
      startProject: () => Promise.resolve<Outcome>({ ok: true }),
      log: () => {},
      event: (_t, _s, f) => events.push(f),
      writeInbox: () => true,
      compose: () => Promise.resolve({ text: 'T', base: { head: null, branch: null }, refs: [], transcript: null }),
      failed: (name, text) => told.push([name, text]),
      ...over,
    });
    const done = () => new Promise<void>((res) => {
      const t = setInterval(() => events.length && (clearInterval(t), res()), 5);
    });
    const run = async (file: string | null = '/w/handoff.md') => {
      expect(r.request('alpha', 'HANDOFF', 'cli', file)).toEqual({ ok: true });
      await done();
      await new Promise((res) => setTimeout(res, 60)); // a second notice would show by now
    };
    return { r, home, told, events, run };
  }
  const kept = (home: string) => path.join(home, '.config', 'agent-tycoon', 'renewals');

  it('not_idle on the turn: said once, with the turn as the reason, this conversation goes on, the kept copy and the next step', async () => {
    const t = rig({ status: 'busy' });
    await t.run();
    expect(t.events[0]).toMatchObject({ ok: false, code: 'not_idle' });
    expect(t.told).toHaveLength(1);
    const [name, text] = t.told[0];
    expect(name).toBe('alpha');
    expect(text).toContain('(not_idle)');
    expect(text).toContain('턴이 끝나지 않아');
    expect(text).toContain('이 대화가 그대로 이어진다');
    expect(text).toMatch(/alpha\.json\.failed 에 보관했다/);
    expect(fs.existsSync(text.match(/(\S+\.failed) 에 보관/)![1])).toBe(true); // the path it names exists
    expect(text).toContain('"$AGTY_BIN" renew <파일> 을 다시 실행');
    expect(text).not.toContain('SendMessage');
  });

  it('not_idle on sub-agents: names how many it waited for; unknown count says so', async () => {
    const two = rig({ subagents: () => 2 });
    await two.run();
    expect(two.told).toHaveLength(1);
    expect(two.told[0][1]).toContain('서브에이전트 2개가 끝나지 않아'); // no names known: no parentheses
    expect(two.told[0][1]).toContain(
      '끝난 것처럼 보이는 서브에이전트는 SendMessage 로 메시지를 보내면 그다음 알림에 끝난 것으로 잡히고, 60분 동안 조용히 멈춰 있는 서브에이전트는 더 세지 않는다.',
    );
    expect(two.events[0]).toMatchObject({ code: 'not_idle', error: expect.stringContaining('서브에이전트 2개') });
    const unknown = rig({ subagents: () => null });
    await unknown.run();
    expect(unknown.told).toHaveLength(1);
    expect(unknown.told[0][1]).toContain('몇 개 도는지 아직 몰라');
    expect(unknown.told[0][1]).not.toContain('SendMessage');
  });

  it('not_idle on sub-agents names the counted ones: at most 3, each cut to 40 characters, then the rest', async () => {
    const long = '가'.repeat(45);
    const t = rig({ subagents: () => 5, subagentNames: () => [long, 'b', 'c', 'd'] });
    await t.run();
    expect(t.events[0]).toMatchObject({ code: 'not_idle', error: `서브에이전트 5개(${'가'.repeat(40)}, b, c 외 2개)가 끝나지 않아 새 대화로 넘기지 않았어요` });
    expect(t.told[0][1]).toContain('SendMessage');
    expect(subagentsLeft(2, ['x', 'y'])).toBe('서브에이전트 2개(x, y)가 끝나지 않아 새 대화로 넘기지 않았어요');
    expect(subagentsLeft(3, ['x'])).toBe('서브에이전트 3개(x 외 2개)가 끝나지 않아 새 대화로 넘기지 않았어요');
    expect(subagentsLeft(1, [])).toBe('서브에이전트 1개가 끝나지 않아 새 대화로 넘기지 않았어요');
  });

  it('terminal: not said (the messenger cannot type into a terminal; a queued notice would arrive stale)', async () => {
    const t = rig({ kind: 'interactive' });
    await t.run();
    expect(t.events[0]).toMatchObject({ ok: false, code: 'terminal' });
    expect(t.told).toEqual([]);
  });

  it('queue_failed: said once, the kept copy named', async () => {
    const t = rig({ writeInbox: () => false });
    await t.run();
    expect(t.told).toHaveLength(1);
    expect(t.told[0][1]).toContain('(queue_failed)');
    expect(fs.readdirSync(kept(t.home))).toEqual(['alpha.json.failed']);
    expect(t.told[0][1]).toContain(path.join(kept(t.home), 'alpha.json.failed'));
  });

  it('stop_failed: said once; no .failed copy, so the Lead\'s own file is named (none when it gave none)', async () => {
    const t = rig({ stopSession: () => Promise.resolve(fail('kill_refused')) });
    await t.run();
    expect(t.told).toHaveLength(1);
    expect(t.told[0][1]).toContain('(stop_failed): kill_refused');
    expect(t.told[0][1]).toContain('인수인계 파일 /w/handoff.md 은 그대로 있다');
    expect(t.told[0][1]).not.toContain('.failed');
    const bare = rig({ stopSession: () => Promise.resolve(fail('kill_refused')) });
    await bare.run(null);
    expect(bare.told[0][1]).not.toContain('인수인계 파일');
    expect(bare.told[0][1]).not.toContain('보관했다');
  });

  it('success, cancelled and start_failed tell nobody', async () => {
    const ok = rig();
    await ok.run();
    expect(ok.events[0]).toMatchObject({ ok: true });
    expect(ok.told).toEqual([]);

    const start = rig({ startProject: () => Promise.resolve(fail('boom')) });
    await start.run();
    expect(start.events[0]).toMatchObject({ ok: false, code: 'start_failed' });
    expect(start.told).toEqual([]);

    const cancelled = rig({ status: 'busy' });
    expect(cancelled.r.request('alpha', 'HANDOFF', 'cli')).toEqual({ ok: true });
    cancelled.r.cancel('alpha');
    await new Promise((res) => setTimeout(res, 120));
    expect(cancelled.events[0]).toMatchObject({ ok: false, code: 'cancelled' });
    expect(cancelled.told).toEqual([]);
  });
});
