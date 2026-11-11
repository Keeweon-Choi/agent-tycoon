// STALE-CLI (T-82): a live session older than the installed CLI, and its restart once it is idle.
// The engine runs with an in-memory provider (no process) and a fake clock: nothing really waits.
import { randomUUID } from 'node:crypto';

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineAction } from '../../../../core/src/messages.js';
import { sessionFromFile } from '../providers/claudeProvider.js';
import { makeEngineHome, removeTestHome } from '../testHome.js';
import { CLAUDE_CAPABILITIES } from './agents/claude/claude.js';
import type { AgentProvider, LiveSession, StartResult } from './agents/types.js';
import { Engine } from './engine.js';
import { cliUpdateOf } from './engineView.js';
import { EngineEvents, eventsPath } from './events.js';
import { Messenger } from './messenger.js';
import type { ProjectRecord } from './registry.js';
import { registryPath, saveRegistry, sessionName } from './registry.js';

const MIN = 60_000;

describe('STALE-CLI: the version a session runs against the installed one', () => {
  const claude = { protocol: 'claude' as const };
  const installed = { claude: { version: '2.1.322', models: [], efforts: [] } };

  const bg = (version?: string) => ({ kind: 'background', ...(version && { version }) });

  it('an older session gets the mark; the same, a newer or an unknown one does not', () => {
    expect(cliUpdateOf(bg('2.1.319'), claude, installed)).toEqual({
      cli: 'claude',
      running: '2.1.319',
      installed: '2.1.322',
    });
    expect(cliUpdateOf(bg('2.1.322'), claude, installed)).toBeUndefined();
    expect(cliUpdateOf(bg('2.1.330'), claude, installed)).toBeUndefined();
    expect(cliUpdateOf(bg(), claude, installed)).toBeUndefined(); // the file had no version
    expect(cliUpdateOf(bg('2.1.319'), claude, {})).toBeUndefined(); // the installed one unknown
    expect(cliUpdateOf(null, claude, installed)).toBeUndefined(); // no live session
    // Claude in our PTY host reads the same file; Codex and ACP agents never carry one.
    expect(cliUpdateOf(bg('2.1.319'), { protocol: 'pty' }, installed)).toBeDefined();
    expect(cliUpdateOf(bg('2.1.319'), { protocol: 'acp' }, installed)).toBeUndefined();
    // 2.1.99 is older than 2.1.100 (numbers, not text).
    expect(cliUpdateOf(bg('2.1.99'), claude, { claude: { version: '2.1.100', models: [], efforts: [] } })).toBeDefined();
  });

  it('a conversation open in a terminal gets no mark: the engine cannot restart it', () => {
    expect(cliUpdateOf({ kind: 'interactive', version: '2.1.319' }, claude, installed)).toBeUndefined();
  });

  it("reads `version` from the session's own file; a file without one has none", () => {
    const file = { pid: 4242, sessionId: 's1', cwd: '/w', kind: 'bg', procStart: '7', version: '2.1.319' };
    const alive = () => true;
    expect(sessionFromFile(file, 4242, alive)).toMatchObject({ sessionId: 's1', version: '2.1.319' });
    const { version: _v, ...without } = file;
    const row = sessionFromFile(without, 4242, alive);
    expect(row).toMatchObject({ sessionId: 's1' });
    expect(row && row !== 'unknown' && 'version' in row).toBe(false);
  });
});

/** Claude as an in-memory provider: a start resumes the conversation it is given and runs `version`. */
class Agent implements AgentProvider {
  readonly id = 'claude';
  readonly protocol = 'claude' as const;
  readonly capabilities = { ...CLAUDE_CAPABILITIES, usage: null };
  readonly calls: string[] = [];
  sessions: LiveSession[] = [];
  status = 'idle';
  version = '2.1.319';
  private n = 0;
  live = () => this.sessions.map((s) => ({ ...s }));
  liveUnsure = () => false;
  onChange = () => () => undefined;
  nameMatches = (name: string | null | undefined, base: string) => name === base;
  attachArgv = (id: string) => ['fake-attach', id];
  /** A permission dialog is open (claude agents --json says blocked). */
  dialog = false;
  heldCalls = 0;
  /** The next held() waits for this (the window between the idle look and the stop). */
  gate: Promise<void> | null = null;
  held = async () => {
    this.heldCalls++;
    const g = this.gate;
    this.gate = null;
    if (g) await g;
    return this.dialog;
  };
  transcript = (s: Pick<LiveSession, 'cwd' | 'sessionId'>) => path.join(s.cwd, `${s.sessionId}.fake`);
  start(p: ProjectRecord, o?: { resume?: string }): Promise<StartResult> {
    const sessionId = o?.resume ?? randomUUID();
    this.calls.push(`start ${o?.resume ? 'resume' : 'new'}`);
    fs.writeFileSync(this.transcript({ cwd: p.folder, sessionId }), '');
    const id = `bg${++this.n}`;
    this.sessions.push({
      id,
      pid: 4_300_000 + this.n,
      cwd: p.folder,
      kind: 'background',
      sessionId,
      name: sessionName(p),
      status: this.status,
      version: this.version,
      startedAt: Date.now(),
    });
    return Promise.resolve({ ok: true as const, id });
  }
  stop(s: LiveSession) {
    this.calls.push('stop');
    this.sessions = this.sessions.filter((x) => x.id !== s.id);
    return Promise.resolve({ ok: true as const });
  }
  setStatus(status: string) {
    for (const s of this.sessions) s.status = status;
  }
  /** The live session comes back as another process on the same conversation (a revive). */
  replace(version: string) {
    const s = this.sessions.pop()!;
    this.sessions.push({ ...s, id: `bg${++this.n}`, pid: 4_300_000 + this.n, version });
  }
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
  vi.useRealTimers();
});

describe('STALE-CLI: 재시작 waits for the turn and the background sub-agents (fake clock)', () => {
  async function rig() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { home, claudePath } = makeEngineHome();
    const folder = path.join(home, 'work', 'alpha');
    fs.mkdirSync(folder, { recursive: true });
    saveRegistry(registryPath(home), [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder, wantRunning: false }]);
    const agent = new Agent();
    const subs: { n: number | null } = { n: 0 };
    const e = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      log: () => undefined,
      // The real wait (30 minutes, a look every 10 s): the clock is fake.
      timing: { pollMs: 20, appearMs: 5_000, goneMs: 5_000, reviveGapMs: 50, safetyMs: MIN, debounceMs: 50, watchMs: 0 },
      env: process.env,
      binDir: null,
      writeInbox: () => true,
      agents: [agent],
      agentChoices: { discover: () => ({ claude: { version: '2.1.322', models: [], efforts: [] } }) },
      subagents: () => subs.n,
    });
    e.start();
    cleanup.push(() => {
      e.dispose();
      removeTestHome(home);
    });
    let n = 0;
    const act = (fields: Partial<EngineAction> = {}, action: EngineAction['action'] = 'restart') =>
      e.run({ type: 'engineAction', requestId: `r${++n}`, action, name: 'alpha', ...fields }, true, 'linux');
    const alpha = () => e.state().projects.find((p) => p.name === 'alpha')!;
    expect(await act({}, 'start')).toMatchObject({ ok: true });
    const sessionId = alpha().sessionId;
    expect(alpha().cliUpdate).toEqual({ cli: 'claude', running: '2.1.319', installed: '2.1.322', waitMin: 30 });
    agent.calls.length = 0;
    agent.version = '2.1.322'; // the CLI updated itself; the running session did not
    const restarted = () => agent.calls.join(',') === 'stop,start resume';
    return { e, home, agent, subs, act, alpha, sessionId, restarted };
  }

  it('idle now: restarts at once, in the same conversation, and the mark goes', async () => {
    const r = await rig();
    const out = await r.act({ whenIdle: 'wait' });
    expect(out).toMatchObject({ ok: true });
    expect(out.note).toBeUndefined();
    expect(r.restarted()).toBe(true);
    expect(r.alpha().sessionId).toBe(r.sessionId);
    expect(r.alpha().cliUpdate).toBeUndefined();
    expect(r.alpha().restartWhenIdle).toBeUndefined();
  });

  it('busy: waits (the state says so), and restarts once the turn has ended', async () => {
    const r = await rig();
    r.agent.setStatus('busy');
    expect(await r.act({ whenIdle: 'wait' })).toMatchObject({ ok: true, note: expect.stringContaining('최대 30분') });
    expect(r.alpha().restartWhenIdle).toBe('waiting');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.agent.calls).toEqual([]); // never cuts the turn
    // A second press while it waits changes nothing.
    expect(await r.act({ whenIdle: 'wait' })).toMatchObject({ ok: true, note: expect.stringContaining('최대 30분') });
    r.agent.setStatus('idle');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(r.restarted()).toBe(true);
    expect(r.alpha().sessionId).toBe(r.sessionId);
    expect(r.alpha().restartWhenIdle).toBeUndefined();
    expect(r.alpha().cliUpdate).toBeUndefined();
  });

  it('the turn over but background sub-agents running (or not known yet): waits until there are none', async () => {
    const r = await rig();
    r.subs.n = 2;
    expect(await r.act({ whenIdle: 'wait' })).toMatchObject({ ok: true, note: expect.any(String) });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    r.subs.n = null;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(r.agent.calls).toEqual([]);
    r.subs.n = 0;
    await vi.advanceTimersByTimeAsync(11_000);
    expect(r.restarted()).toBe(true);
  });

  it('busy past 30 minutes: does not restart by itself, says so, and the next press tries again', async () => {
    const r = await rig();
    r.agent.setStatus('busy');
    await r.act({ whenIdle: 'wait' });
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(r.alpha().restartWhenIdle).toBe('waiting');
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(r.alpha().restartWhenIdle).toBe('timedOut');
    r.agent.setStatus('idle');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.agent.calls).toEqual([]); // the limit passed: nothing restarts on its own
    expect(r.alpha().cliUpdate).toBeDefined();
    expect(await r.act({ whenIdle: 'wait' })).toMatchObject({ ok: true });
    expect(r.restarted()).toBe(true);
    expect(r.alpha().restartWhenIdle).toBeUndefined();
  });

  it('cancelled (or the person stops it meanwhile): the wait ends and nothing restarts', async () => {
    const r = await rig();
    r.agent.setStatus('busy');
    await r.act({ whenIdle: 'wait' });
    expect(await r.act({ whenIdle: 'cancel' })).toMatchObject({ ok: true, note: expect.stringContaining('취소') });
    expect(r.alpha().restartWhenIdle).toBeUndefined();
    r.agent.setStatus('idle');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.agent.calls).toEqual([]);
    // A 끄기 during a wait ends it too: the wait never starts the session again.
    r.agent.setStatus('busy');
    await r.act({ whenIdle: 'wait' });
    expect(await r.act({}, 'stop')).toMatchObject({ ok: true });
    expect(r.alpha().restartWhenIdle).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.agent.calls).toEqual(['stop']);
  });

  it('a permission dialog open (held): waits; once answered, restarts', async () => {
    const r = await rig();
    r.agent.dialog = true;
    expect(await r.act({ whenIdle: 'wait' })).toMatchObject({ ok: true, note: expect.stringContaining('최대 30분') });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(r.agent.calls).toEqual([]);
    r.agent.dialog = false;
    await vi.advanceTimersByTimeAsync(11_000);
    expect(r.restarted()).toBe(true);
  });

  it('sub-agents running: their count is looked at before held(), so no `claude agents --json` every 10 s', async () => {
    const r = await rig();
    r.subs.n = 1;
    await r.act({ whenIdle: 'wait' });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.agent.heldCalls).toBe(0);
    expect(r.agent.calls).toEqual([]);
  });

  it('a background shell after the turn (status shell) is work: waits, and past 30 minutes says so', async () => {
    const r = await rig();
    r.agent.setStatus('shell');
    expect(await r.act({ whenIdle: 'wait' })).toMatchObject({ ok: true, note: expect.stringContaining('최대 30분') });
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(r.agent.calls).toEqual([]);
    expect(r.alpha().restartWhenIdle).toBe('timedOut');
    expect(r.alpha().cliUpdate).toMatchObject({ running: '2.1.319', waitMin: 30 });
  });

  it('the session it waited for became current (same process): gives up silently, nothing restarted', async () => {
    const r = await rig();
    r.agent.setStatus('busy');
    await r.act({ whenIdle: 'wait' });
    r.agent.sessions[0].version = '2.1.322';
    r.agent.setStatus('idle');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(r.agent.calls).toEqual([]);
    expect(r.alpha().restartWhenIdle).toBeUndefined();
    expect(r.alpha().cliUpdate).toBeUndefined();
  });

  it('the session it waited for was replaced (a revive: another pid, still old): gives up, nothing restarted', async () => {
    const r = await rig();
    r.agent.setStatus('busy');
    await r.act({ whenIdle: 'wait' });
    r.agent.replace('2.1.319');
    r.agent.setStatus('idle');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(r.agent.calls).toEqual([]);
    expect(r.alpha().restartWhenIdle).toBeUndefined();
    expect(r.alpha().cliUpdate).toBeDefined(); // still old: the band offers 재시작 again
  });

  it('the session it waited for is gone (stopped elsewhere): gives up, never starts it', async () => {
    const r = await rig();
    r.agent.setStatus('busy');
    await r.act({ whenIdle: 'wait' });
    r.agent.sessions = [];
    await vi.advanceTimersByTimeAsync(11_000);
    expect(r.agent.calls).toEqual([]);
    expect(r.alpha().restartWhenIdle).toBeUndefined();
  });

  it('an accepted renew drops the wait: its new conversation is never restarted by it', async () => {
    const r = await rig();
    r.agent.setStatus('busy');
    await r.act({ whenIdle: 'wait' });
    expect(r.e.renew('alpha', '## 목표\n- x', 'cli')).toEqual({ ok: true });
    expect(r.alpha().restartWhenIdle).toBeUndefined();
    r.agent.setStatus('idle');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.agent.calls).not.toContain('start resume'); // the renew's own stop and new start only
  });

  it('a message that comes while it looks and restarts waits, then reaches the restarted session', async () => {
    const r = await rig();
    const typed: Array<[string, string]> = [];
    const m = new Messenger({
      home: r.home,
      engine: r.e,
      typist: { type: (id, text) => (typed.push([id, text]), Promise.resolve('typed' as const)) },
      events: new EngineEvents(eventsPath(r.home)),
      timing: { tickMs: 20, retryMs: 50 },
      log: () => undefined,
    });
    m.start();
    cleanup.push(() => m.dispose());
    const old = r.agent.sessions[0].id!;
    let open!: () => void;
    r.agent.gate = new Promise<void>((res) => (open = res));
    const pressed = r.act({ whenIdle: 'wait' }); // idle now: it looks (held() waits on the gate)
    await vi.advanceTimersByTimeAsync(50);
    expect((await m.send({ to: 'alpha', text: 'are you there', ifIdle: false, from: null, source: 'engine' })).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(typed).toEqual([]); // held while the restart is under way
    open();
    expect(await pressed).toMatchObject({ ok: true });
    expect(r.restarted()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    const now = r.agent.sessions[0].id!;
    expect(now).not.toBe(old);
    expect(typed.map(([id]) => id)).toEqual([now]);
    expect(typed[0][1]).toContain('are you there');
  });
});
