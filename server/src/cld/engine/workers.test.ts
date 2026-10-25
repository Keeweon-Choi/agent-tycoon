// D3: one project, its Lead and two Workers, each its own Claude session (the fake
// claude): sessions, revive, idle retirement and wake, renew, compaction counts and
// tokens are per agent, and a message to the project's name reaches its Lead.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineAction, EngineActionKind } from '../../../../core/src/messages.js';
import { transcriptPath } from '../providers/claudeProvider.js';
import type { AgentEntry, World } from '../providers/types.js';
import { ENTRY_DEFAULTS } from '../providers/types.js';
import type { SpawnFn } from '../spawnJson.js';
import { engineCalls, killFakeSessions, makeEngineHome, removeTestHome } from '../testHome.js';
import { readLiveSessions } from './agents/claude/sessions.js';
import type { EngineOptions } from './engine.js';
import { CLD_BIN_DIR, Engine, parseEngineAction, SWAP_UNFINISHED } from './engine.js';
import { EngineEvents, eventsPath } from './events.js';
import { Messenger } from './messenger.js';
import type { ProjectRecord } from './registry.js';
import { loadRegistry, registryFault, registryPath, saveRegistry } from './registry.js';

const FAST = {
  pollMs: 20,
  appearMs: 5_000,
  goneMs: 5_000,
  reviveGapMs: 50,
  safetyMs: 60_000,
  debounceMs: 50,
  watchMs: 0,
  renewPollMs: 20,
};
const WAIT = { timeout: 8_000, interval: 25 };

let cleanup: Array<() => void> = [];
afterEach(() => {
  delete registryFault.afterWrite;
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

/** A home whose registry holds project `alpha` (its Lead) with Workers `alpha-a`, `alpha-b`
 *  (alpha-b in a worktree of the project), and project `beta`. */
function leadAndWorkers(extra: Partial<EngineOptions> = {}, records = (r: ProjectRecord[]) => r) {
  const { home, claudePath } = makeEngineHome();
  const folder = (...parts: string[]) => {
    const d = path.join(home, 'work', ...parts);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const alpha = folder('alpha');
  const tree = folder('alpha', '.worktrees', 'b');
  saveRegistry(
    registryPath(home),
    records([
      { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: alpha, room: 'lab', wantRunning: false },
      { projectId: 'p_bbbbbbbbbb', name: 'beta', folder: folder('beta'), wantRunning: false },
      { projectId: 'p_aaaaaaaaaa', role: 'worker', name: 'alpha-a', folder: alpha, wantRunning: false },
      {
        projectId: 'p_aaaaaaaaaa',
        role: 'worker',
        name: 'alpha-b',
        folder: tree,
        workFolder: tree,
        wantRunning: false,
      },
    ]),
  );
  const inbox: Array<{ name: string; text: string }> = [];
  const started: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const nudges: Array<[string, number]> = [];
  const logs: string[] = [];
  const engines: Engine[] = [];
  const boot = (over: Partial<EngineOptions> = {}) => {
    const e = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      log: (l) => logs.push(l),
      timing: FAST,
      env: process.env,
      binDir: CLD_BIN_DIR,
      writeInbox: (name, text) => (inbox.push({ name, text }), true),
      started: (name) => started.push(name),
      event: (type, source, fields) => events.push({ type, source, ...fields }),
      nudge: (name, n) => nudges.push([name, n]),
      ...extra,
      ...over,
    });
    engines.push(e);
    e.start();
    return e;
  };
  cleanup.push(() => {
    for (const e of engines) e.dispose();
    killFakeSessions(home);
    removeTestHome(home);
  });
  let n = 0;
  const act = (e: Engine, action: EngineActionKind, name: string, fields: Partial<EngineAction> = {}) =>
    e.run({ type: 'engineAction', requestId: `r${++n}`, action, name, ...fields }, true, 'linux');
  const agent = (e: Engine, name: string) => e.state().projects.find((p) => p.name === name)!;
  /** The CLD_AGENT_TOKEN of the newest `--bg` start in `cwd`. */
  const tokenIn = (cwd: string, name: string) => {
    const call = engineCalls(home)
      .filter((c) => c.argv[0] === '--bg' && c.argv[2] === name && c.cwd === cwd)
      .at(-1)!;
    const settings = JSON.parse(call.argv[call.argv.indexOf('--settings') + 1]) as {
      env: Record<string, string>;
    };
    return settings.env.CLD_AGENT_TOKEN;
  };
  return { home, alpha, tree, boot, act, agent, tokenIn, inbox, started, events, nudges, logs };
}

/** A messenger on this engine whose typist records which session got what. */
function messengerOf(home: string, e: Engine) {
  const typed: Array<{ id: string; text: string }> = [];
  const m = new Messenger({
    home,
    engine: e,
    typist: { type: (id, text) => (typed.push({ id, text }), Promise.resolve('typed')) },
    events: new EngineEvents(eventsPath(home)),
    timing: { tickMs: 20, retryMs: 50, ifIdleMs: 10 * 60_000, quietMs: 5_000 },
  });
  m.start();
  cleanup.push(() => m.dispose());
  return { m, typed };
}

describe('D3: a project’s Lead and Workers are separate agents', () => {
  it('parses a Worker add: role and project, nothing else', () => {
    const base = { type: 'engineAction', requestId: 'r', action: 'add', name: 'alpha-a' };
    expect(parseEngineAction({ ...base, role: 'reviewer', project: 'alpha' })).toEqual({
      ...base,
      role: 'reviewer',
      project: 'alpha',
    });
    expect(parseEngineAction({ ...base, role: 'lead', project: 'alpha' })).toBeNull();
    expect(parseEngineAction({ ...base, role: 'worker', project: 7 })).toBeNull();
  });

  it('names, projects, folders and rooms: the project name is its Lead; Workers by their own name', () => {
    const r = leadAndWorkers();
    const e = r.boot();
    expect(e.names()).toEqual(['alpha', 'beta', 'alpha-a', 'alpha-b']);
    expect(e.projectNames()).toEqual(['alpha', 'beta']);
    expect(e.folders().map((f) => f.name)).toEqual(['alpha', 'beta']);
    expect(['alpha', 'alpha-a', 'alpha-b', 'beta', 'ghost'].map((n) => e.projectOf(n))).toEqual([
      'alpha',
      'alpha',
      'alpha',
      'beta',
      null,
    ]);
    expect(e.folderOf('alpha-b')).toBe(r.tree);
    expect(e.folderOf('alpha-a')).toBe(r.alpha);
    // "Which project" from a folder, even a Worker's worktree; never "which agent".
    expect(e.projectAt(r.tree)).toBe('alpha');
    // One office entry per agent, the Workers in their project's room.
    const office = e.apply({ rooms: [], agents: [] });
    expect(office.agents.map((a) => [a.key, a.tab, a.dir])).toEqual([
      ['engine:alpha', 'lab', r.alpha],
      ['engine:beta', 'beta', path.join(r.home, 'work', 'beta')],
      ['engine:alpha-a', 'lab', r.alpha],
      ['engine:alpha-b', 'lab', r.tree],
    ]);
  });

  it('start and stop a Worker and the Lead independently, each with its own session and token', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    expect((await r.act(e, 'start', 'alpha-b')).ok).toBe(true);
    expect(r.agent(e, 'alpha-b').live).toBe(true);
    expect(r.agent(e, 'alpha').live).toBe(false);
    expect((await r.act(e, 'start', 'alpha')).ok).toBe(true);
    expect((await r.act(e, 'start', 'alpha-a')).ok).toBe(true);
    const sessions = ['alpha', 'alpha-a', 'alpha-b'].map((n) => r.agent(e, n).sessionId);
    expect(new Set(sessions).size).toBe(3);
    // Each session is named after its agent, in its own folder.
    const live = readLiveSessions(r.home).filter((s) => s.kind === 'background');
    expect(live.map((s) => [s.name, s.cwd]).sort()).toEqual([
      ['alpha', r.alpha],
      ['alpha-a', r.alpha],
      ['alpha-b', r.tree],
    ]);
    // S7: each token identifies its own agent.
    const tokens = {
      alpha: r.tokenIn(r.alpha, 'alpha'),
      'alpha-a': r.tokenIn(r.alpha, 'alpha-a'),
      'alpha-b': r.tokenIn(r.tree, 'alpha-b'),
    };
    for (const [name, token] of Object.entries(tokens)) expect(e.tokens.agentOf(token)).toBe(name);
    expect(r.started).toEqual(['alpha-b', 'alpha', 'alpha-a']);

    expect((await r.act(e, 'stop', 'alpha-a')).ok).toBe(true);
    expect(['alpha', 'alpha-a', 'alpha-b'].map((n) => r.agent(e, n).live)).toEqual([
      true,
      false,
      true,
    ]);
    const stored = loadRegistry(registryPath(r.home)).projects;
    expect(stored.map((p) => [p.name, p.wantRunning])).toEqual([
      ['alpha', true],
      ['beta', false],
      ['alpha-a', false],
      ['alpha-b', true],
    ]);
  });

  it('revive after a restart: each agent that was on comes back with its own notice', async () => {
    const r = leadAndWorkers();
    const e1 = r.boot();
    await r.act(e1, 'start', 'alpha');
    await r.act(e1, 'start', 'alpha-b');
    const before = { lead: r.agent(e1, 'alpha').sessionId, worker: r.agent(e1, 'alpha-b').sessionId };
    e1.dispose();
    killFakeSessions(r.home);
    await vi.waitFor(() => expect(readLiveSessions(r.home)).toEqual([]), WAIT);
    const e2 = r.boot();
    await vi.waitFor(() => {
      expect(r.agent(e2, 'alpha').live).toBe(true);
      expect(r.agent(e2, 'alpha-b').live).toBe(true);
    }, WAIT);
    expect(r.agent(e2, 'alpha-a').live).toBe(false); // it was off
    expect(r.inbox.map((x) => x.name)).toEqual(['alpha', 'alpha-b']);
    expect(r.agent(e2, 'alpha').sessionId).not.toBe(before.worker);
    expect(r.agent(e2, 'alpha-b').sessionId).not.toBe(before.lead);
  });

  it('a Worker Claude retired for idleness rests alone; a message to its name wakes only it', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    const sid = r.agent(e, 'alpha-a').sessionId!;
    const lead = r.agent(e, 'alpha');
    // Claude retires the Worker's session (its daemon log says so) and it goes.
    fs.writeFileSync(
      path.join(r.home, '.claude', 'daemon.log'),
      `[2026-10-24T01:05:10Z] bg retire ${sid.slice(0, 8)}: idle-prompt, idle 8h\n`,
    );
    const workerPid = readLiveSessions(r.home).find((s) => s.name === 'alpha-a')!.pid;
    process.kill(workerPid, 'SIGKILL');
    await vi.waitFor(() => {
      e.refresh(); // its file stays: only the pid is gone
      expect(r.agent(e, 'alpha-a').live).toBe(false);
    }, WAIT);
    await e.revive(); // the watch's pass: it rests, nothing is started
    expect(r.agent(e, 'alpha-a').downNote).toBe('Claude 가 오래 쉬어 내림 · 메시지가 오면 다시 켬');
    expect(r.agent(e, 'alpha')).toMatchObject({ live: true, sessionId: lead.sessionId });
    const starts = engineCalls(r.home).filter((c) => c.argv[0] === '--bg').length;

    const { m, typed } = messengerOf(r.home, e);
    expect(
      await m.send({ to: 'alpha-a', text: 'go on', from: null, source: 'cli', ifIdle: false }),
    ).toMatchObject({ ok: true, delivered: 'pane' });
    const woke = engineCalls(r.home).filter((c) => c.argv[0] === '--bg').slice(starts);
    expect(woke.map((c) => c.argv.slice(0, 3))).toEqual([['--bg', '-n', 'alpha-a']]);
    expect(typed.map((t) => t.id)).toEqual([r.agent(e, 'alpha-a').bgId]);
    expect(r.agent(e, 'alpha')).toMatchObject({ live: true, sessionId: lead.sessionId });
  });

  it('renew a Worker: a new conversation for it, the Lead’s untouched', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    const lead = r.agent(e, 'alpha').sessionId;
    const old = r.agent(e, 'alpha-a').sessionId;
    expect(e.renew('alpha-a', 'HANDOFF', 'cli')).toEqual({ ok: true });
    expect(e.renewing('alpha-a')).toBe(true);
    expect(e.renewing('alpha')).toBe(false);
    await vi.waitFor(() => expect(r.events.some((x) => x.type === 'orch_renew')).toBe(true), WAIT);
    expect(r.events.find((x) => x.type === 'orch_renew')).toMatchObject({
      name: 'alpha-a',
      ok: true,
    });
    expect(r.agent(e, 'alpha-a').sessionId).not.toBe(old);
    expect(r.agent(e, 'alpha').sessionId).toBe(lead);
    expect(r.inbox).toEqual([{ name: 'alpha-a', text: 'HANDOFF' }]);
  });

  it('compaction counts and the opt-in nudge are per agent', async () => {
    const r = leadAndWorkers({}, (records) =>
      records.map((p) => (p.name === 'alpha-a' ? { ...p, compactionNudge: 1 } : p)),
    );
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    const t = (name: string) => transcriptPath(r.alpha, r.agent(e, name).sessionId!, r.home);
    const mark = '{"type":"system","subtype":"compact_boundary"}\n';
    const usage = (tokens: number) =>
      `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: tokens } } })}\n`;
    for (const name of ['alpha', 'alpha-a']) {
      fs.mkdirSync(path.dirname(t(name)), { recursive: true });
      fs.writeFileSync(t(name), '{}\n');
    }
    e.refresh();
    fs.appendFileSync(t('alpha-a'), mark);
    e.refresh();
    fs.appendFileSync(t('alpha-a'), usage(900_000));
    e.refresh();
    expect(r.nudges).toEqual([['alpha-a', 1]]);
    const counts = Object.fromEntries(
      e.apply({ rooms: [], agents: [] }).agents.map((a) => [a.name, a.compactions]),
    );
    expect(counts).toEqual({ alpha: 0, beta: 0, 'alpha-a': 1, 'alpha-b': 0 });
  });

  it('engine actions: add a Worker (refused: a taken name, a project’s name, no project, a room, a folder outside the repository)', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    const add = (name: string, fields: Partial<EngineAction> = {}) =>
      r.act(e, 'add', name, { role: 'worker', project: 'alpha', ...fields });
    expect((await add('beta')).error).toBe('이미 있는 이름이에요'); // a project's name
    expect((await add('alpha-a')).error).toBe('이미 있는 이름이에요');
    expect((await add('alpha-c', { project: 'ghost' })).error).toBe('모르는 프로젝트예요');
    expect((await add('alpha-c', { project: 'alpha-a' })).error).toBe('모르는 프로젝트예요');
    expect((await add('alpha-c', { room: 'x' })).error).toMatch(/프로젝트의 방/);
    expect((await add('alpha-c', { folder: path.join(r.home, 'work', 'beta') })).error).toMatch(
      /프로젝트 폴더 안/,
    );
    // A project folder inside a repository: that repository's .worktrees/ is fine too.
    fs.mkdirSync(path.join(r.home, 'work', '.git'));
    const outer = path.join(r.home, 'work', '.worktrees', 'd');
    expect((await add('alpha-d', { folder: outer, mkdir: true })).ok).toBe(true);
    expect((await add('alpha-e', { folder: path.join(r.home, 'work', 'beta') })).error).toMatch(
      /프로젝트 폴더 안/,
    );
    expect((await r.act(e, 'remove', 'alpha-d')).ok).toBe(true);
    expect((await add('alpha-c', { role: 'boss' as never })).error).toMatch(/역할/);
    const tree = path.join(r.alpha, '.worktrees', 'c');
    expect(await add('alpha-c', { folder: tree })).toMatchObject({ ok: false, folderMissing: true });
    expect((await add('alpha-c', { folder: tree, mkdir: true, model: 'sonnet' })).ok).toBe(true);
    expect(r.agent(e, 'alpha-c')).toMatchObject({
      role: 'worker',
      project: 'alpha',
      folder: tree,
      room: 'lab',
      model: 'sonnet',
      wantRunning: false,
      live: false,
    });
    // A Lead is a plain add, as before; its name may not be a Worker's either.
    expect((await r.act(e, 'add', 'alpha-c', { folder: r.alpha })).error).toBe('이미 있는 이름이에요');
    expect(loadRegistry(registryPath(r.home)).projects.map((p) => p.name)).toEqual([
      'alpha',
      'beta',
      'alpha-a',
      'alpha-b',
      'alpha-c',
    ]);
  });

  it('engine actions: a name or title whose session name would match another agent’s in the same folder is refused', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    const add = (name: string, fields: Partial<EngineAction> = {}) =>
      r.act(e, 'add', name, { role: 'worker', project: 'alpha', ...fields });
    const clash = /세션 이름.*겹쳐요/;
    expect((await add('alpha-c', { title: 'alpha' })).error).toMatch(clash); // the Lead's
    expect((await add('alpha-c', { title: 'alpha (2)' })).error).toMatch(clash); // Claude's <base> (N)
    expect((await r.act(e, 'edit', 'alpha-a', { title: 'alpha' })).error).toMatch(clash);
    expect((await r.act(e, 'edit', 'alpha', { title: 'alpha-a' })).error).toMatch(clash);
    expect((await r.act(e, 'add', 'gamma', { folder: r.alpha, title: 'alpha-a' })).error).toMatch(clash);
    // Another folder (alpha-b's worktree) is another session namespace.
    expect((await add('alpha-c', { title: 'alpha', folder: r.tree })).ok).toBe(true);
    expect(loadRegistry(registryPath(r.home)).projects.map((p) => [p.name, p.title])).toEqual([
      ['alpha', undefined],
      ['beta', undefined],
      ['alpha-a', undefined],
      ['alpha-b', undefined],
      ['alpha-c', 'alpha'],
    ]);
  });

  it('a hand-written clash still loads, and the Lead never follows the Worker’s session', async () => {
    const lead = '0123abcd-0000-4000-8000-0123456789ab';
    const r = leadAndWorkers({}, (records) =>
      records.map((p) =>
        p.name === 'alpha' ? { ...p, sessionId: lead } : p.name === 'alpha-a' ? { ...p, title: 'alpha' } : p,
      ),
    );
    const e = r.boot();
    expect(e.registryProblem()).toBeNull();
    expect((await r.act(e, 'start', 'alpha-a')).ok).toBe(true);
    const live = readLiveSessions(r.home).filter((s) => s.kind === 'background');
    expect(live.map((s) => [s.name, s.cwd])).toEqual([['alpha', r.alpha]]);
    e.refresh();
    e.refresh();
    // Its conversation id as saved (and holder() does not take the session either).
    expect(loadRegistry(registryPath(r.home)).projects.find((p) => p.name === 'alpha')?.sessionId).toBe(lead);
    expect(r.logs.filter((l) => /also matches "alpha-a".*not followed/.test(l))).toHaveLength(1);
  });

  it('a D2 store whose two Leads share a session name in one folder: the other Lead’s session is never this one’s', async () => {
    const r = leadAndWorkers({}, ([alpha]) => [
      alpha,
      { projectId: 'p_gggggggggg', name: 'gamma', folder: alpha.folder, title: 'alpha', wantRunning: false },
    ]);
    // D2-shaped: no Worker, so assignments.json stays v1.
    expect(
      JSON.parse(fs.readFileSync(path.join(r.home, '.config/cld-gui/assignments.json'), 'utf8')),
    ).toMatchObject({ v: 1 });
    const e = r.boot();
    expect(e.registryProblem()).toBeNull();
    expect((await r.act(e, 'start', 'gamma')).ok).toBe(true);
    const gamma = e.sessionOf('gamma');
    expect(gamma).toMatchObject({ id: expect.any(String) });
    expect(e.sessionOf('alpha')).toBeNull();
    expect(r.agent(e, 'alpha').live).toBe(false);
    const office = e.apply({ agents: [], rooms: [] }).agents;
    expect(office.map((a) => [a.name, a.state])).toEqual([
      ['alpha', 'off'],
      ['gamma', 'running'],
    ]);
    expect(await r.act(e, 'stop', 'alpha')).toMatchObject({ ok: true, note: '이미 꺼져 있어요' });
    expect(readLiveSessions(r.home).filter((s) => s.kind === 'background')).toHaveLength(1);
    expect(e.sessionOf('gamma')).toEqual(gamma);
    expect(r.logs.filter((l) => /^\[cld engine\] "alpha": .*also matches "gamma"/.test(l))).toHaveLength(1);
  });

  it('D5 (6.1): apply() folds a contested office row by its conversation id only; one log line per agent and session', async () => {
    const r = leadAndWorkers({}, ([alpha]) => [
      alpha,
      { projectId: 'p_gggggggggg', name: 'gamma', folder: alpha.folder, title: 'alpha', wantRunning: false },
    ]);
    const e = r.boot();
    expect((await r.act(e, 'start', 'gamma')).ok).toBe(true);
    const sid = r.agent(e, 'gamma').sessionId!;
    const row = (key: string, sessionId: string): AgentEntry => ({
      ...ENTRY_DEFAULTS,
      key,
      name: 'alpha',
      dir: r.alpha,
      tab: 'alpha',
      order: 1,
      state: 'running',
      busy: false,
      pid: 4242,
      sessionId,
      remoteControl: { on: false, url: null },
      bg: { id: 'bg1', state: 'working', sessionId, started: null },
      transcript: `/t/${sessionId}.jsonl`,
    });
    const stranger = '99999999-0000-4000-8000-000000000000';
    const world: World = { rooms: [], agents: [row('name:a', sid), row('name:b', stranger)] };
    const before = r.logs.filter((l) => l.includes('also matches')).length;
    const out = e.apply(world).agents;
    expect(out.map((a) => a.key)).toEqual(['name:b', 'engine:alpha', 'engine:gamma']);
    const byKey = (k: string) => out.find((a) => a.key === k)!;
    expect(byKey('engine:gamma')).toMatchObject({ state: 'running', sessionId: sid, transcript: `/t/${sid}.jsonl` });
    expect(byKey('engine:alpha')).toMatchObject({ state: 'off', pid: null, transcript: null, bg: null });
    expect(byKey('name:b')).toEqual(world.agents[1]);
    // Row b: both agents claim it by name; each says so once (agent + session), never again.
    const said = r.logs.filter((l) => l.includes('also matches')).slice(before);
    expect(said).toHaveLength(2);
    expect(said.every((l) => l.includes(stranger.slice(0, 8)))).toBe(true);
    e.apply(world);
    expect(r.logs.filter((l) => l.includes('also matches')).length).toBe(before + 2);
  });

  it('engine actions: a name refused when another agent’s session name matches it the other way (zeta beside “zeta (2)”)', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    expect((await r.act(e, 'edit', 'alpha-a', { title: 'zeta (2)' })).ok).toBe(true);
    const clash = /세션 이름\(zeta, zeta \(2\)\)이 겹쳐요/;
    expect((await r.act(e, 'add', 'zeta', { folder: r.alpha })).error).toMatch(clash);
    expect((await r.act(e, 'add', 'zeta', { role: 'worker', project: 'alpha' })).error).toMatch(clash);
    expect(e.names()).toEqual(['alpha', 'beta', 'alpha-a', 'alpha-b']);
  });

  it('engine actions: a Lead’s move refused when a Worker it drags along would clash in the new folder', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    // beta is titled as alpha's Worker alpha-a (no folder of its own: it moves with alpha).
    expect((await r.act(e, 'edit', 'beta', { title: 'alpha-a' })).ok).toBe(true);
    const beta = r.agent(e, 'beta').folder;
    expect((await r.act(e, 'edit', 'alpha', { folder: beta })).error).toMatch(
      /'beta'와 같은 폴더에서 세션 이름\(alpha-a, alpha-a\)이 겹쳐요/,
    );
    expect(['alpha', 'alpha-a'].map((n) => r.agent(e, n).folder)).toEqual([r.alpha, r.alpha]);
  });

  it('engine actions: edit a Worker; a project’s folder carries its Workers without their own', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    expect((await r.act(e, 'edit', 'alpha-a', { room: 'x' })).error).toMatch(/프로젝트의 방/);
    expect((await r.act(e, 'edit', 'alpha-a', { model: 'opus' })).ok).toBe(true);
    expect(r.agent(e, 'alpha-a').model).toBe('opus');
    await r.act(e, 'start', 'alpha-a');
    const moved = path.join(r.home, 'work', 'alpha2');
    fs.mkdirSync(moved);
    expect((await r.act(e, 'edit', 'alpha', { folder: moved })).error).toBe(
      '켜져 있는 동안에는 폴더를 바꿀 수 없어요',
    );
    await r.act(e, 'stop', 'alpha-a');
    expect((await r.act(e, 'edit', 'alpha', { folder: moved, room: 'lab2' })).ok).toBe(true);
    expect(['alpha', 'alpha-a', 'alpha-b'].map((n) => [r.agent(e, n).folder, r.agent(e, n).room])).toEqual([
      [moved, 'lab2'],
      [moved, 'lab2'],
      [r.tree, 'lab2'], // its own worktree stays
    ]);
  });

  it('W2: a Worker given a Task’s worktree starts there next time; a running session is never moved; the Lead never', async () => {
    const given: Record<string, string> = {};
    const asked: string[] = [];
    const r = leadAndWorkers({ assignedFolder: (p) => (asked.push(p.name), given[p.name] ?? null) });
    const e = r.boot();
    const wt = path.join(r.alpha, '.worktrees', 't-1-login');
    fs.mkdirSync(wt, { recursive: true });
    const cwdOf = (name: string) => readLiveSessions(r.home).find((s) => s.kind === 'background' && s.name === name)?.cwd;
    expect((await r.act(e, 'start', 'alpha-a')).ok).toBe(true);
    expect(cwdOf('alpha-a')).toBe(r.alpha);
    // Given while it runs: nothing moves (the session, its record).
    given['alpha-a'] = wt;
    expect(await r.act(e, 'start', 'alpha-a')).toMatchObject({ ok: true, note: '이미 켜져 있어요' });
    expect([cwdOf('alpha-a'), r.agent(e, 'alpha-a').folder]).toEqual([r.alpha, r.alpha]);
    // Its next start: in the worktree, a new conversation there (the old one's transcript is the project folder's).
    await r.act(e, 'stop', 'alpha-a');
    expect(await r.act(e, 'start', 'alpha-a')).toMatchObject({ ok: true, note: '이전 대화 기록이 없어 새 대화로 켰어요' });
    expect(cwdOf('alpha-a')).toBe(wt);
    const stored = loadRegistry(registryPath(r.home)).projects.find((p) => p.name === 'alpha-a')!;
    expect([stored.folder, stored.workFolder]).toEqual([wt, wt]);
    expect(r.logs).toContain(`[cld engine] "alpha-a": starts in ${wt} (W2: its Task's worktree)`);
    // The worktree removed: back to the project's folder (its own folder cleared).
    await r.act(e, 'stop', 'alpha-a');
    given['alpha-a'] = r.alpha;
    expect((await r.act(e, 'start', 'alpha-a')).ok).toBe(true);
    expect(cwdOf('alpha-a')).toBe(r.alpha);
    expect(loadRegistry(registryPath(r.home)).projects.find((p) => p.name === 'alpha-a')!.workFolder).toBeUndefined();
    // A folder outside the project's repository is not taken, whatever the record says.
    await r.act(e, 'stop', 'alpha-a');
    const outside = path.join(r.home, 'elsewhere');
    fs.mkdirSync(outside);
    given['alpha-a'] = outside;
    expect((await r.act(e, 'start', 'alpha-a')).ok).toBe(true);
    expect(cwdOf('alpha-a')).toBe(r.alpha);
    expect(r.logs.some((l) => l.startsWith(`[cld engine] "alpha-a": not moved to ${outside}`))).toBe(true);
    // The Lead's folder is the project's: never asked.
    given.alpha = wt;
    expect((await r.act(e, 'start', 'alpha')).ok).toBe(true);
    expect(cwdOf('alpha')).toBe(r.alpha);
    expect(asked).not.toContain('alpha');
  });

  it('engine actions: removing a project stops and removes its Workers; removing a Worker leaves the Lead', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    const token = r.tokenIn(r.alpha, 'alpha-a');
    expect((await r.act(e, 'remove', 'alpha-b')).ok).toBe(true);
    expect(e.names()).toEqual(['alpha', 'beta', 'alpha-a']);
    expect(r.agent(e, 'alpha').live).toBe(true);
    expect((await r.act(e, 'remove', 'alpha')).ok).toBe(true);
    expect(e.names()).toEqual(['beta']);
    expect(readLiveSessions(r.home).filter((s) => s.kind === 'background')).toEqual([]);
    expect(e.tokens.agentOf(token)).toBeNull();
    const stored = JSON.parse(
      fs.readFileSync(path.join(r.home, '.config/cld-gui/assignments.json'), 'utf8'),
    ) as { v: number; assignments: unknown[] };
    expect(stored).toMatchObject({ v: 1, assignments: [{ role: 'lead' }] });
  });

  it('the messenger: the project’s name reaches its Lead’s session, a Worker’s name that Worker’s', async () => {
    const r = leadAndWorkers();
    const e = r.boot();
    for (const n of ['alpha', 'alpha-a', 'alpha-b']) await r.act(e, 'start', n);
    const { m, typed } = messengerOf(r.home, e);
    for (const to of ['alpha', 'alpha-b'])
      expect(
        await m.send({ to, text: `for ${to}`, from: null, source: 'cli', ifIdle: false }),
      ).toMatchObject({ ok: true, delivered: 'pane' });
    expect(typed.map((t) => [t.id, t.text.split('\n').at(-1)])).toEqual([
      [r.agent(e, 'alpha').bgId, 'for alpha'],
      [r.agent(e, 'alpha-b').bgId, 'for alpha-b'],
    ]);
  });
});

// D3b (design-d3b §3.2, §3.4): promote swaps the two assignments' names.
describe('D3b: promoting a Worker to its project’s Lead', () => {
  /** alpha's Lead with a seat title equal to its name (as the ops Lead has: kept with L, it would
   *  collide with the new Lead's session name in the same folder). */
  const seated = () =>
    leadAndWorkers({}, (rs) =>
      rs.map((p) => (p.name === 'alpha' ? { ...p, title: 'alpha', remoteControl: true, model: 'lead-m' } : p.name === 'alpha-a' ? { ...p, model: 'worker-m' } : p)),
    );
  const ids = (home: string) =>
    loadRegistry(registryPath(home)).projects.map((p) => [p.name, p.role ?? 'lead', p.role ? p.assignmentId : p.leadAssignmentId]);
  const cfgFile = (home: string, ...p: string[]) => path.join(home, '.config', 'cld-gui', ...p);

  it('parses promote with oldLead worker or stop, nothing else', () => {
    const base = { type: 'engineAction', requestId: 'r', action: 'promote', name: 'alpha-a' };
    expect(parseEngineAction({ ...base, oldLead: 'stop' })).toEqual({ ...base, oldLead: 'stop' });
    expect(parseEngineAction(base)).toEqual(base);
    expect(parseEngineAction({ ...base, oldLead: 'lead' })).toBeNull();
  });

  it('oldLead worker: W restarts fresh as the project, L resumes as the Worker; tokens reissued; the prompts wait in the inboxes', async () => {
    const r = seated();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    const before = ids(r.home);
    const old = { lead: r.agent(e, 'alpha').sessionId!, worker: r.agent(e, 'alpha-a').sessionId! };
    const tokens = { lead: r.tokenIn(r.alpha, 'alpha'), worker: r.tokenIn(r.alpha, 'alpha-a') };
    // Both conversations have a transcript (the old Lead's is resumed from it).
    for (const sid of [old.lead, old.worker]) {
      const t = transcriptPath(r.alpha, sid, r.home);
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } })}\n`);
    }
    const calls = engineCalls(r.home).length;

    const out = await r.act(e, 'promote', 'alpha-a', { oldLead: 'worker' });
    expect(out).toMatchObject({ ok: true });
    // The ids swapped slots: alpha is W's assignment, alpha-a the old Lead's.
    const after = ids(r.home);
    expect(after.find((x) => x[0] === 'alpha')![2]).toBe(before.find((x) => x[0] === 'alpha-a')![2]);
    expect(after.find((x) => x[0] === 'alpha-a')![2]).toBe(before.find((x) => x[0] === 'alpha')![2]);
    expect(after.filter((x) => x[1] === 'lead').map((x) => x[0])).toEqual(['alpha', 'beta']);
    const stored = loadRegistry(registryPath(r.home)).projects;
    expect(stored.find((p) => p.name === 'alpha')).toMatchObject({ title: 'alpha', remoteControl: true, model: 'worker-m' });
    expect(stored.find((p) => p.name === 'alpha-a')).toMatchObject({ role: 'worker', model: 'lead-m' });
    // Sessions: alpha a fresh conversation (no --resume), alpha-a the old Lead's resumed.
    const starts = engineCalls(r.home).slice(calls).filter((c) => c.argv[0] === '--bg');
    expect(starts[0].argv.slice(0, 3)).toEqual(['--bg', '-n', 'alpha']);
    expect(starts[0].argv).not.toContain('--resume');
    // The old Lead: never a bare wake (that keeps its old -n, flags and token, ADR-0013 §12) but
    // its conversation under the Worker's own -n and flags and a fresh token; no Lead-seat flags.
    const second = starts[1].argv;
    expect(second.slice(0, 5)).toEqual(['--bg', '-n', 'alpha-a', '--resume', old.lead]);
    expect(second).toEqual(expect.arrayContaining(['--model', 'lead-m', '--mcp-config', '--settings']));
    expect(second).not.toContain('--remote-control');
    // C7a: a Worker gets its own composed rules (the Worker playbook), never the Lead seat's file.
    const rules = second.indexOf('--append-system-prompt-file');
    if (rules >= 0) expect(second[rules + 1]).toContain('alpha-a');
    expect(r.agent(e, 'alpha')).toMatchObject({ live: true });
    expect([old.lead, old.worker]).not.toContain(r.agent(e, 'alpha').sessionId);
    // Claude continues it in a copy: the Worker's assignment holds the copy's id, the term the old one.
    expect(r.agent(e, 'alpha-a')).toMatchObject({ live: true, role: 'worker' });
    expect(r.agent(e, 'alpha-a').sessionId).not.toBe(old.lead);
    expect(stored.find((p) => p.name === 'alpha-a')!.sessionId).toBeDefined();
    expect(loadRegistry(registryPath(r.home)).projects.find((p) => p.name === 'alpha-a')!.sessionId).toBe(r.agent(e, 'alpha-a').sessionId);
    // Tokens: the old ones map to nobody, each new one to its slot.
    expect(e.tokens.agentOf(tokens.lead)).toBeNull();
    expect(e.tokens.agentOf(tokens.worker)).toBeNull();
    const tokenOf = (argv: string[]) =>
      (JSON.parse(argv[argv.indexOf('--settings') + 1]) as { env: Record<string, string> }).env.CLD_AGENT_TOKEN;
    expect(starts.map((c) => e.tokens.agentOf(tokenOf(c.argv)))).toEqual(['alpha', 'alpha-a']);
    // No live session but the new Lead's answers to the Lead seat's session name.
    const seatName = readLiveSessions(r.home).filter((x) => x.name === 'alpha' || /^alpha \(\d+\)$/.test(x.name ?? ''));
    expect(seatName.map((x) => x.sessionId)).toEqual([r.agent(e, 'alpha').sessionId]);
    // The prompts, the old Lead's term, the event.
    const lead = fs.readdirSync(cfgFile(r.home, 'inbox', 'alpha')).filter((f) => f.startsWith('0-lead-'));
    expect(lead).toHaveLength(1);
    expect(fs.readFileSync(cfgFile(r.home, 'inbox', 'alpha', lead[0]), 'utf8')).toMatch(/^\[cld-gui Lead 교체 · .*\] 이제 너는 프로젝트 'alpha' 의 Lead 다/);
    expect(fs.readdirSync(cfgFile(r.home, 'inbox', 'alpha-a')).filter((f) => f.startsWith('0-role-'))).toHaveLength(1);
    const history = JSON.parse(fs.readFileSync(cfgFile(r.home, 'lead-history.json'), 'utf8')) as { terms: Array<{ sessionId: string }> };
    expect(history.terms.map((t) => t.sessionId)).toEqual([old.lead]);
    expect(fs.existsSync(cfgFile(r.home, 'lead-swap.json'))).toBe(false);
    expect(r.started.slice(-2)).toEqual(['alpha', 'alpha-a']);
    expect(r.events.find((x) => x.type === 'lead_swap')).toMatchObject({ project: 'alpha', oldLead: 'worker', ok: true });
  });

  it('oldLead stop: the old Lead stays off as the Worker and neither old token identifies anyone; promoting back restores the original pair', async () => {
    const r = seated();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    const original = loadRegistry(registryPath(r.home)).projects;
    const tokens = { lead: r.tokenIn(r.alpha, 'alpha'), worker: r.tokenIn(r.alpha, 'alpha-a') };
    expect(await r.act(e, 'promote', 'alpha-a', { oldLead: 'stop' })).toMatchObject({ ok: true });
    expect(r.agent(e, 'alpha-a')).toMatchObject({ live: false, wantRunning: false, role: 'worker' });
    expect(r.agent(e, 'alpha').live).toBe(true);
    expect(e.tokens.agentOf(tokens.lead)).toBeNull();
    expect(e.tokens.agentOf(tokens.worker)).toBeNull(); // not "alpha-a": that name is the old Lead's now
    const roleNotices = () => fs.existsSync(cfgFile(r.home, 'inbox', 'alpha-a')) ? fs.readdirSync(cfgFile(r.home, 'inbox', 'alpha-a')).filter((f) => f.startsWith('0-role-')) : [];
    expect(roleNotices()).toHaveLength(0);

    expect(await r.act(e, 'promote', 'alpha-a')).toMatchObject({ ok: true });
    const seat = (p: ProjectRecord) => [p.name, p.role ?? 'lead', p.role ? p.assignmentId : p.leadAssignmentId, p.title, p.remoteControl, p.model];
    expect(loadRegistry(registryPath(r.home)).projects.map(seat)).toEqual(original.map(seat));
    expect(r.agent(e, 'alpha').live).toBe(true);
    expect(r.agent(e, 'alpha-a').live).toBe(true);
  });

  it('refused, nothing changed: a Lead, an unknown name, or while another action holds either agent', async () => {
    const r = seated();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    const files = () => ['projects.json', 'assignments.json'].map((f) => fs.readFileSync(cfgFile(r.home, f), 'utf8'));
    const was = files();
    expect(await r.act(e, 'promote', 'alpha')).toMatchObject({ ok: false });
    expect(await r.act(e, 'promote', 'ghost')).toMatchObject({ ok: false });
    expect(files()).toEqual(was);
    const restart = r.act(e, 'restart', 'alpha');
    expect(await r.act(e, 'promote', 'alpha-a')).toMatchObject({ ok: false, error: expect.stringContaining('alpha: 이미 다른 조작') });
    await restart;
    expect(ids(r.home).filter((x) => x[1] === 'lead').map((x) => x[0])).toEqual(['alpha', 'beta']);
    expect(fs.existsSync(cfgFile(r.home, 'lead-history.json'))).toBe(false);
  });

  it('a message to the project after the swap reaches the new Lead, to the Worker’s name the old Lead', async () => {
    const r = seated();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    expect(await r.act(e, 'promote', 'alpha-a')).toMatchObject({ ok: true });
    const { m, typed } = messengerOf(r.home, e);
    for (const to of ['alpha', 'alpha-a'])
      expect(await m.send({ to, text: `for ${to}`, from: null, source: 'cli', ifIdle: false })).toMatchObject({ ok: true, delivered: 'pane' });
    expect(typed.map((t) => [t.id, t.text.split('\n').at(-1)])).toEqual([
      [r.agent(e, 'alpha').bgId, 'for alpha'],
      [r.agent(e, 'alpha-a').bgId, 'for alpha-a'],
    ]);
  });
});

// D3b fix round: the verification's D1 (a later start of the demoted Worker), D2 (a failed
// stop keeps MCP identity) and D3 (a commit cut short after the registry is never replayed).
describe('D3b: after the swap', () => {
  /** The next `claude` call whose args match fails (exit 1): a failed start or stop. */
  const failing: { when: ((args: string[]) => boolean) | null } = { when: null };
  const spawnFn = ((cmd: string, args: string[], o: object) => {
    if (failing.when?.(args)) {
      failing.when = null;
      return spawn(process.execPath, ['-e', 'process.exit(1)'], o);
    }
    return spawn(cmd, args, o);
  }) as unknown as SpawnFn;
  const seated = () =>
    leadAndWorkers({ spawnFn }, (rs) =>
      rs.map((p) => (p.name === 'alpha' ? { ...p, title: 'alpha', remoteControl: true, model: 'lead-m' } : p.name === 'alpha-a' ? { ...p, model: 'worker-m' } : p)),
    );
  const stored = (home: string, name: string) => loadRegistry(registryPath(home)).projects.find((p) => p.name === name)!;
  const writeTranscript = (dir: string, sid: string, home: string) => {
    const t = transcriptPath(dir, sid, home);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } })}\n`);
  };
  const tokenOf = (argv: string[]) =>
    (JSON.parse(argv[argv.indexOf('--settings') + 1]) as { env: Record<string, string> }).env.CLD_AGENT_TOKEN;
  /** alpha-a promoted; the old Lead, now Worker alpha-a, holds the old Lead's conversation:
   *  'stop' (left off) or 'failed' (its copy start failed: off, wantRunning). */
  async function demoted(mode: 'stop' | 'failed') {
    failing.when = null;
    const r = seated();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    const oldLead = r.agent(e, 'alpha').sessionId!;
    for (const n of ['alpha', 'alpha-a']) writeTranscript(r.alpha, r.agent(e, n).sessionId!, r.home);
    if (mode === 'failed') failing.when = (a) => a.includes('--resume') && a.includes('alpha-a');
    expect(await r.act(e, 'promote', 'alpha-a', { oldLead: mode === 'stop' ? 'stop' : 'worker' })).toMatchObject({ ok: true });
    expect(failing.when).toBeNull();
    expect(stored(r.home, 'alpha-a')).toMatchObject({ resumeAsCopy: true, sessionId: oldLead, wantRunning: mode === 'failed' });
    expect(r.agent(e, 'alpha-a').live).toBe(false);
    return { r, e, oldLead, calls: engineCalls(r.home).length };
  }
  /** The start that brought alpha-a back: a copy under its own -n, flags and a fresh token;
   *  no live session but the new Lead's answers to the Lead seat's name; the bit cleared. */
  function copyStarted(t: Awaited<ReturnType<typeof demoted>>) {
    const { r, e, oldLead, calls } = t;
    const starts = engineCalls(r.home).slice(calls).filter((c) => c.argv[0] === '--bg');
    expect(starts).toHaveLength(1);
    const argv = starts[0].argv;
    expect(argv.slice(0, 5)).toEqual(['--bg', '-n', 'alpha-a', '--resume', oldLead]);
    expect(argv).not.toContain('--remote-control');
    expect(e.tokens.agentOf(tokenOf(argv))).toBe('alpha-a');
    const seat = readLiveSessions(r.home).filter((x) => x.name === 'alpha' || /^alpha \(\d+\)$/.test(x.name ?? ''));
    expect(seat.map((x) => x.sessionId)).toEqual([r.agent(e, 'alpha').sessionId]);
    expect(r.agent(e, 'alpha-a')).toMatchObject({ live: true, role: 'worker' });
    expect(r.agent(e, 'alpha-a').sessionId).not.toBe(oldLead);
    expect(stored(r.home, 'alpha-a').resumeAsCopy).toBeUndefined();
  }
  const noStart = (t: Awaited<ReturnType<typeof demoted>>) =>
    expect(engineCalls(t.r.home).slice(t.calls).filter((c) => c.argv[0] === '--bg')).toEqual([]);
  const retire = (t: Awaited<ReturnType<typeof demoted>>) =>
    fs.writeFileSync(
      path.join(t.r.home, '.claude', 'daemon.log'),
      `[2026-10-24T01:05:10Z] bg retire ${t.oldLead.slice(0, 8)}: idle-prompt, idle 8h\n`,
    );
  const watch = (e: Engine) => (e as unknown as { watch(): Promise<void> }).watch();

  for (const mode of ['stop', 'failed'] as const) {
    it(`D1 (${mode}): start and delegate_task's auto-start continue the old Lead's conversation as a copy, never a bare wake`, async () => {
      const a = await demoted(mode);
      expect(await a.r.act(a.e, 'start', 'alpha-a')).toMatchObject({ ok: true });
      copyStarted(a);
      // From now on its own conversation: a restart is an ordinary one (a wake of its own job).
      const own = a.r.agent(a.e, 'alpha-a').sessionId!;
      writeTranscript(a.r.alpha, own, a.r.home);
      const before = engineCalls(a.r.home).length;
      expect(await a.r.act(a.e, 'restart', 'alpha-a')).toMatchObject({ ok: true });
      expect(engineCalls(a.r.home).slice(before).filter((c) => c.argv[0] === '--bg').map((c) => c.argv)).toEqual([['--bg', '--resume', own]]);

      const b = await demoted(mode);
      // delegate_task's startAgent (office.ts): the engine's own start action from 'mcp'.
      expect(await b.e.run({ type: 'engineAction', requestId: 'mcp-start-1', action: 'start', name: 'alpha-a' }, true, 'mcp')).toMatchObject({ ok: true });
      copyStarted(b);
    });

    it(`D1 (${mode}): the messenger's wake, revive and the watch never bare-wake the old Lead's job`, async () => {
      for (const path_ of ['wake', 'revive', 'watch'] as const) {
        const t = await demoted(mode);
        if (path_ === 'wake') {
          retire(t);
          expect(await t.e.wake('alpha-a')).toBe(mode === 'failed'); // stop: off, nothing to wake
        } else if (path_ === 'revive') await t.e.revive();
        else await watch(t.e);
        if (mode === 'stop') noStart(t); // the user turned it off: none of them starts it
        else copyStarted(t);
      }
    });
  }

  it('D2: a failed stop restarts what was stopped and keeps both MCP identities (nothing changed)', async () => {
    failing.when = null;
    const r = seated();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    const tokens = { lead: r.tokenIn(r.alpha, 'alpha'), worker: r.tokenIn(r.alpha, 'alpha-a') };
    for (const n of ['alpha', 'alpha-a']) writeTranscript(r.alpha, r.agent(e, n).sessionId!, r.home);
    const files = () => ['projects.json', 'assignments.json'].map((f) => fs.readFileSync(path.join(r.home, '.config/cld-gui', f), 'utf8'));
    const was = files();
    const leadBg = r.agent(e, 'alpha').bgId!;
    failing.when = (a) => a.includes('stop') && a.includes(leadBg); // W stops, then L's stop fails
    const out = await r.act(e, 'promote', 'alpha-a');
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('아무것도 바꾸지 않았어요') });
    expect(e.tokens.agentOf(tokens.lead)).toBe('alpha');
    expect(e.tokens.agentOf(tokens.worker)).toBe('alpha-a');
    expect(['alpha', 'alpha-a'].map((n) => r.agent(e, n).live)).toEqual([true, true]);
    expect(files()).toEqual(was);
    expect(fs.existsSync(path.join(r.home, '.config/cld-gui/lead-swap.json'))).toBe(false);
  });

  it('D3 (J2): an I/O error after the registry phase; a Worker added after it survives the next start, which only finishes the effects', async () => {
    failing.when = null;
    const r = seated();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    const queue = path.join(r.home, '.config', 'cld-gui', 'queue');
    registryFault.afterWrite = (f) => {
      if (f === queue) {
        delete registryFault.afterWrite;
        throw new Error('EIO: i/o error at the re-addressing step');
      }
    };
    expect(await r.act(e, 'promote', 'alpha-a')).toMatchObject({ ok: true });
    expect(r.logs.some((l) => l.includes('the commit stopped'))).toBe(true);
    const journal = path.join(r.home, '.config', 'cld-gui', 'lead-swap.json');
    expect(JSON.parse(fs.readFileSync(journal, 'utf8'))).toMatchObject({ phase: 'effects', projects: '', assignments: '' });
    expect(await r.act(e, 'add', 'alpha-c', { role: 'worker', project: 'alpha' })).toMatchObject({ ok: true });
    const lead = r.agent(e, 'alpha').sessionId;
    expect(lead).toBeDefined();
    // The two sessions the swap started, with their fresh tokens.
    const started = (n: string) =>
      tokenOf(engineCalls(r.home).filter((c) => c.argv[0] === '--bg' && c.argv[c.argv.indexOf('-n') + 1] === n).at(-1)!.argv);
    const live = { lead: started('alpha'), worker: started('alpha-a') };
    expect([e.tokens.agentOf(live.lead), e.tokens.agentOf(live.worker)]).toEqual(['alpha', 'alpha-a']);
    e.dispose();
    const e2 = r.boot();
    expect(e2.names()).toEqual(['alpha', 'beta', 'alpha-a', 'alpha-b', 'alpha-c']);
    expect(stored(r.home, 'alpha').sessionId).toBe(lead);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.readdirSync(path.join(r.home, '.config', 'cld-gui', 'inbox', 'alpha')).filter((f) => f.startsWith('0-lead-'))).toHaveLength(1);
    // F2: finishing an 'effects'-phase journal keeps the live sessions' fresh tokens.
    expect([e2.tokens.agentOf(live.lead), e2.tokens.agentOf(live.worker)]).toEqual(['alpha', 'alpha-a']);
  });

  /** F1's probe: the config folder becomes read-only right after the swap drops its tokens,
   *  so the commit cannot write even assignments.json (the journal is in its first phase). */
  async function cutBeforeRegistry() {
    failing.when = null;
    const r = seated();
    const e = r.boot();
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'alpha-a');
    for (const n of ['alpha', 'alpha-a']) writeTranscript(r.alpha, r.agent(e, n).sessionId!, r.home);
    const cfg = path.join(r.home, '.config', 'cld-gui');
    const ids = { lead: stored(r.home, 'alpha').leadAssignmentId!, worker: stored(r.home, 'alpha-a').assignmentId! };
    const sids = { lead: r.agent(e, 'alpha').sessionId!, worker: r.agent(e, 'alpha-a').sessionId! };
    const drop = e.tokens.drop.bind(e.tokens);
    let drops = 0;
    e.tokens.drop = (name: string) => {
      drop(name);
      if (++drops === 2) fs.chmodSync(cfg, 0o500);
    };
    cleanup.push(() => fs.chmodSync(cfg, 0o700));
    const calls = engineCalls(r.home).length;
    const out = await r.act(e, 'promote', 'alpha-a');
    fs.chmodSync(cfg, 0o700);
    return { r, e, cfg, ids, sids, out, calls };
  }

  it('F1: a commit that cannot write the registry fails, starts nothing and refuses every change until a restart rolls it forward', async () => {
    const t = await cutBeforeRegistry();
    const { r, e } = t;
    expect(t.out).toMatchObject({ ok: false, error: '교체를 끝내지 못했어요. cld-gui 를 다시 시작하면 이어서 끝내요' });
    expect(engineCalls(r.home).slice(t.calls).filter((c) => c.argv[0] === '--bg')).toEqual([]); // nothing started
    expect(['alpha', 'alpha-a'].map((n) => r.agent(e, n).live)).toEqual([false, false]);
    const journal = JSON.parse(fs.readFileSync(path.join(t.cfg, 'lead-swap.json'), 'utf8')) as { phase?: string };
    expect(journal.phase).toBeUndefined();
    // The old pair on disk, untouched.
    expect(stored(r.home, 'alpha')).toMatchObject({ leadAssignmentId: t.ids.lead, sessionId: t.sids.lead });
    expect(stored(r.home, 'alpha-a')).toMatchObject({ assignmentId: t.ids.worker, sessionId: t.sids.worker });
    // Broken until the restart: no add, start or promote; no wake; the state says why.
    for (const [action, name, fields] of [
      ['add', 'alpha-c', { role: 'worker', project: 'alpha' }],
      ['start', 'alpha', {}],
      ['promote', 'alpha-a', {}],
    ] as const)
      expect(await r.act(e, action, name, fields)).toMatchObject({ ok: false, error: SWAP_UNFINISHED });
    expect(await e.wake('alpha')).toBe(false);
    expect(e.state().warnings?.join(' ')).toContain('Lead 교체가 끝나지 않았어요(lead-swap.json)');
    expect(engineCalls(r.home).slice(t.calls).filter((c) => c.argv[0] === '--bg')).toEqual([]);

    // The restart finishes the swap with both sessions stopped, then revives both.
    e.dispose();
    const e2 = r.boot();
    expect(fs.existsSync(path.join(t.cfg, 'lead-swap.json'))).toBe(false);
    expect(stored(r.home, 'alpha').leadAssignmentId).toBe(t.ids.worker);
    expect(stored(r.home, 'alpha-a').assignmentId).toBe(t.ids.lead);
    await vi.waitFor(() => expect(['alpha', 'alpha-a'].map((n) => r.agent(e2, n).live)).toEqual([true, true]), WAIT);
    const starts = engineCalls(r.home).slice(t.calls).filter((c) => c.argv[0] === '--bg');
    expect(starts.map((c) => c.argv.slice(0, 3))).toEqual([['--bg', '-n', 'alpha'], ['--bg', '-n', 'alpha-a']]);
    expect(starts[0].argv).not.toContain('--resume'); // the new Lead: a fresh conversation
    expect(starts[1].argv.slice(3, 5)).toEqual(['--resume', t.sids.lead]); // the old Lead's, as a copy
    expect(starts.map((c) => e2.tokens.agentOf(tokenOf(c.argv)))).toEqual(['alpha', 'alpha-a']);
    expect([t.sids.lead, t.sids.worker]).not.toContain(r.agent(e2, 'alpha').sessionId);
  });

  it('L2: a read-only daemon leaves an unfinished swap as it is (no registry, token or journal write)', async () => {
    const t = await cutBeforeRegistry();
    t.e.dispose();
    const snap = () =>
      Object.fromEntries(
        ['projects.json', 'assignments.json', 'agent-tokens.json', 'lead-swap.json'].map((f) => [f, fs.readFileSync(path.join(t.cfg, f), 'utf8')]),
      );
    const before = snap();
    const ro = t.r.boot({ readOnly: true });
    expect(ro.names()).toEqual(['alpha', 'beta', 'alpha-a', 'alpha-b']);
    expect(snap()).toEqual(before);
  });
});
