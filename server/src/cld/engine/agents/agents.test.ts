// D4: the agent provider seam. Claude's declared capabilities; the engine drives each agent
// through the provider its assignment names (a fake second provider here); an unknown one
// stops only its agent; and Claude's argv through the engine is what it was before the move.
import { randomUUID } from 'node:crypto';

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineAction, EngineActionKind } from '../../../../../core/src/messages.js';
import { ENTRY_DEFAULTS } from '../../providers/types.js';
import type { SpawnFn } from '../../spawnJson.js';
import { engineCalls, killFakeSessions, makeEngineHome, removeTestHome } from '../../testHome.js';
import type { EngineOptions } from '../engine.js';
import { CLD_BIN_DIR, cldBinPath, Engine } from '../engine.js';
import { EngineEvents, eventsPath } from '../events.js';
import { Messenger } from '../messenger.js';
import type { ProjectRecord } from '../registry.js';
import { loadRegistry, registryPath, saveRegistry, sessionName } from '../registry.js';
import { CLAUDE_CAPABILITIES, ClaudeAgent } from './claude/claude.js';
import type { AgentProvider, LiveSession, StartResult } from './types.js';

vi.setConfig({ testTimeout: 60_000 });

const FAST = {
  pollMs: 20,
  appearMs: 5_000,
  goneMs: 5_000,
  reviveGapMs: 50,
  safetyMs: 60_000,
  debounceMs: 50,
  watchMs: 0,
};

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

/** A provider that keeps its sessions in memory and records what it was asked. */
class FakeAgent implements AgentProvider {
  readonly id = 'fake';
  readonly protocol = 'pty' as const;
  readonly capabilities = { ...CLAUDE_CAPABILITIES, approvalPolicy: [], usage: null };
  readonly calls: Array<[string, string]> = [];
  protected sessions: LiveSession[] = [];
  protected n = 0;
  live = () => this.sessions.map((s) => ({ ...s }));
  liveUnsure = () => false;
  onChange = () => () => undefined;
  nameMatches = (name: string | null | undefined, base: string) => name === base;
  attachArgv = (id: string) => ['fake-attach', id];
  held = () => Promise.resolve(false);
  transcript = (s: Pick<LiveSession, 'cwd' | 'sessionId'>) => path.join(s.cwd, `${s.sessionId}.fake`);
  start(p: ProjectRecord): Promise<StartResult> {
    this.calls.push(['start', p.name]);
    const id = `fk${++this.n}`;
    this.sessions.push({
      id,
      pid: 4_000_000 + this.n,
      cwd: p.folder,
      kind: 'background',
      sessionId: randomUUID(),
      name: sessionName(p),
      status: 'idle',
      startedAt: Date.now(),
    });
    return Promise.resolve({ ok: true as const, id });
  }
  stop(s: LiveSession) {
    this.calls.push(['stop', s.id ?? '']);
    this.sessions = this.sessions.filter((x) => x.id !== s.id);
    return Promise.resolve({ ok: true as const });
  }
}

/** Project alpha: its Lead (Claude, the fake claude) and Worker alpha-a with `workerProvider`. */
function home(workerProvider: string | undefined, extra: Partial<EngineOptions> = {}, wantRunning = false) {
  const { home, claudePath } = makeEngineHome();
  const alpha = path.join(home, 'work', 'alpha');
  fs.mkdirSync(alpha, { recursive: true });
  saveRegistry(registryPath(home), [
    { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: alpha, wantRunning },
    {
      projectId: 'p_aaaaaaaaaa',
      role: 'worker',
      name: 'alpha-a',
      folder: alpha,
      wantRunning,
      ...(workerProvider && { provider: workerProvider }),
    },
  ]);
  const logs: string[] = [];
  const engines: Engine[] = [];
  const boot = () => {
    const e = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      log: (l) => logs.push(l),
      timing: FAST,
      env: process.env,
      binDir: null,
      writeInbox: () => true,
      ...extra,
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
  const claudeCalls = () => engineCalls(home).map((c) => c.argv);
  return { home, alpha, boot, act, agent, logs, claudeCalls };
}

describe('D4: the agent provider seam', () => {
  it("Claude's declared capabilities (F-11: approval policy and sandbox apart; Claude has no sandbox)", () => {
    expect(CLAUDE_CAPABILITIES).toEqual({
      approvalPolicy: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
      sandbox: null,
      attach: 'pty',
      resume: true,
      naming: 'numbered',
      usage: 'statusLine',
      lifetime: 'session',
    });
    const claude = new ClaudeAgent({
      claudePath: '/c/claude',
      home: '/h',
      env: {},
      systemdRun: null,
      cldBin: null,
      sessionPath: null,
      startMs: 1,
      stopMs: 1,
      log: () => undefined,
    });
    expect([claude.id, claude.protocol, claude.capabilities]).toEqual(['claude', 'claude', CLAUDE_CAPABILITIES]);
    expect(claude.attachArgv('1a2b3c4d')).toEqual(['/c/claude', 'attach', '1a2b3c4d']);
    expect(claude.nameMatches('alpha (2)', 'alpha')).toBe(true);
    expect(claude.nameMatches('alpha', 'alpha (2)')).toBe(false);
  });

  it("the engine drives each agent through its assignment's provider: the fake gets the Worker, Claude the Lead", async () => {
    const fake = new FakeAgent();
    const r = home('fake', { agents: [fake] });
    const e = r.boot();
    expect(e.registryProblem()).toBeNull();
    expect((await r.act(e, 'start', 'alpha')).ok).toBe(true);
    expect(await r.act(e, 'start', 'alpha-a')).toMatchObject({ ok: true, bgId: 'fk1' });
    expect(fake.calls).toEqual([['start', 'alpha-a']]);
    expect(r.claudeCalls().filter((a) => a[0] === '--bg')).toEqual([['--bg', '-n', 'alpha']]);
    expect([r.agent(e, 'alpha').live, r.agent(e, 'alpha-a').live]).toEqual([true, true]);
    expect(e.sessionOf('alpha-a')).toMatchObject({ id: 'fk1', transcript: expect.stringMatching(/\.fake$/) });
    expect((await r.act(e, 'stop', 'alpha-a')).ok).toBe(true);
    expect(fake.calls).toEqual([
      ['start', 'alpha-a'],
      ['stop', 'fk1'],
    ]);
    expect(r.claudeCalls().filter((a) => a[0] === 'stop')).toEqual([]);
    expect([r.agent(e, 'alpha').live, r.agent(e, 'alpha-a').live]).toEqual([true, false]);
    expect((await r.act(e, 'stop', 'alpha')).ok).toBe(true);
    expect(r.claudeCalls().filter((a) => a[0] === 'stop')).toHaveLength(1);
    expect(fake.calls).toHaveLength(2);
  });

  it('an unknown provider: that agent errors (log line, office note), the others start, the registry is not broken', async () => {
    const r = home('nope', {}, true);
    const e = r.boot(); // revive: both were on
    await vi.waitFor(() => expect(r.agent(e, 'alpha').live).toBe(true), { timeout: 8_000, interval: 25 });
    // D5 (6.3): revive leaves it alone (no start tried); a person's start says why.
    await vi.waitFor(() => expect(r.logs.some((l) => /"alpha-a": no agent provider "nope" in this build; not revived/.test(l))).toBe(true));
    expect(e.registryProblem()).toBeNull();
    expect(r.agent(e, 'alpha-a')).toMatchObject({ live: false, downNote: 'cld-gui가 모르는 에이전트(nope)라 켤 수 없어요' });
    expect(await r.act(e, 'start', 'alpha-a')).toMatchObject({
      ok: false,
      error: 'cld-gui가 모르는 에이전트(nope)라 켤 수 없어요',
    });
    expect(r.logs.filter((l) => l.includes('"alpha-a": no agent provider "nope" in this build; not started'))).toHaveLength(1);
    expect(r.claudeCalls().filter((a) => a[0] === '--bg')).toEqual([['--bg', '-n', 'alpha']]);
  });

  it("Claude's argv through the engine, Lead and Worker, is what it was before the move plus C5a's --mcp-config", async () => {
    const events: Array<Record<string, unknown>> = [];
    const r = home(undefined, { binDir: CLD_BIN_DIR, event: (type, _s, f) => events.push({ type, ...f }) });
    const e = r.boot();
    const rules = path.join(r.home, 'rules.md');
    fs.writeFileSync(rules, '# rules\n');
    expect(
      (
        await r.act(e, 'edit', 'alpha', {
          rulesFile: rules,
          model: 'm-1',
          permissionMode: 'plan',
          effort: 'high',
          title: 'alpha-orch',
          remoteControl: true,
        })
      ).ok,
    ).toBe(true);
    expect((await r.act(e, 'start', 'alpha')).ok).toBe(true);
    expect((await r.act(e, 'start', 'alpha-a')).ok).toBe(true);
    const [lead, worker] = r.claudeCalls().filter((a) => a[0] === '--bg');
    const cli = cldBinPath(CLD_BIN_DIR!);
    const mcp = path.join(r.home, '.config', 'cld-gui', 'mcp-config.json');
    const settings = (argv: string[]) => {
      const token = (JSON.parse(argv[argv.indexOf('--settings') + 1]) as { env: { CLD_AGENT_TOKEN: string } }).env
        .CLD_AGENT_TOKEN;
      expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      return JSON.stringify({
        env: { CLD_BIN: cli, CLD_AGENT_TOKEN: token },
        worktree: { bgIsolation: 'none' },
        statusLine: {
          type: 'command',
          command: `"${process.execPath}" "${path.join(CLD_BIN_DIR!, 'cld-gui-statusline.js')}"`,
        },
      });
    };
    // RULES-DEFAULT: every session gets ONE combined file (default + user + project rules).
    const combined = (name: string) =>
      path.join(r.home, '.config', 'cld-gui', 'rules-combined', name);
    const lf = lead[lead.indexOf('--append-system-prompt-file') + 1];
    expect(path.dirname(lf)).toBe(path.dirname(combined('x')));
    expect(fs.readFileSync(lf, 'utf-8')).toMatch(/^# (Agent Tycoon)[^]*\n# Lead [^]*# rules\n$/);
    // C7a: a Worker gets the shared defaults and the Worker playbook (not the Lead's), not the Lead's own rules.
    const wf = worker[worker.indexOf('--append-system-prompt-file') + 1];
    expect(wf).not.toBe(lf);
    expect(fs.readFileSync(wf, 'utf-8')).toMatch(/^# (Agent Tycoon)[^]*\n# Worker [^]*$/);
    expect(fs.readFileSync(wf, 'utf-8')).not.toMatch(/^# Lead |# rules/m);
    // C7a: the start event names the role and the playbook version.
    expect(events.filter((x) => x.type === 'orch_start').map((x) => [x.name, x.role, x.playbook])).toEqual([
      ['alpha', 'lead', expect.stringMatching(/^lead-[0-9a-f]{8}$/)],
      ['alpha-a', 'worker', expect.stringMatching(/^worker-[0-9a-f]{8}$/)],
    ]);
    expect(lead).toEqual([
      '--bg',
      '-n',
      'alpha-orch',
      '--append-system-prompt-file',
      lf,
      '--model',
      'm-1',
      '--permission-mode',
      'plan',
      '--effort',
      'high',
      '--remote-control',
      'alpha-orch',
      '--mcp-config',
      mcp,
      '--settings',
      settings(lead),
    ]);
    expect(worker).toEqual([
      '--bg',
      '-n',
      'alpha-a',
      '--append-system-prompt-file',
      wf,
      '--mcp-config',
      mcp,
      '--settings',
      settings(worker),
    ]);
    // C5a: the one file names our adapter on the daemon's Node, and no token (the session's env carries it).
    expect(JSON.parse(fs.readFileSync(mcp, 'utf-8'))).toEqual({
      mcpServers: { 'cld-gui': { command: process.execPath, args: [path.join(CLD_BIN_DIR!, 'cld-gui-mcp.js')] } },
    });
    expect(fs.existsSync(path.join(CLD_BIN_DIR!, 'cld-gui-mcp.js'))).toBe(true);
    for (const argv of [lead, worker]) expect(argv).not.toContain('--strict-mcp-config');
  });
});

describe('D5 (6.2): the printed id and the systemd-run fallback', () => {
  /** A provider whose start brings up two sessions of one name at once ('alpha', 'alpha (2)'),
   *  and prints the id of `printed` (0 or 1), or nothing. */
  class TwinAgent extends FakeAgent {
    printed: 0 | 1 | null = 0;
    override nameMatches = (name: string | null | undefined, base: string) => !!name && (name === base || name === `${base} (2)`);
    override start(p: ProjectRecord): Promise<StartResult> {
      this.calls.push(['start', p.name]);
      const twins = [0, 1].map((i) => ({
        id: `tw${i}`,
        pid: 4_100_000 + i,
        cwd: p.folder,
        kind: 'background',
        sessionId: randomUUID(),
        name: i ? `${sessionName(p)} (2)` : sessionName(p),
        status: 'idle',
        startedAt: Date.now() + i, // the second is the newer
      }));
      this.sessions.push(...twins);
      return Promise.resolve({ ok: true as const, id: this.printed === null ? null : `tw${this.printed}` });
    }
  }

  it('two new sessions of one name: the engine takes the one start() printed, else the newest by name', async () => {
    for (const printed of [0, 1, null] as const) {
      const twin = new TwinAgent();
      twin.printed = printed;
      const r = home('fake', { agents: [twin] });
      const e = r.boot();
      const want = printed ?? 1;
      const res = await r.act(e, 'start', 'alpha-a');
      const live = twin.live().find((s) => s.id === `tw${want}`)!;
      expect(res).toMatchObject({ ok: true, bgId: `tw${want}` });
      expect(loadRegistry(registryPath(r.home)).projects.find((a) => a.name === 'alpha-a')).toMatchObject({
        backgroundId: `tw${want}`,
        sessionId: live.sessionId,
      });
    }
  });

  /** A spawn that never runs claude or systemd-run: node prints what `answer` says for the call. */
  function scripted(answer: (file: string, args: string[]) => { code: number; out?: string; err?: string }) {
    const calls: Array<{ file: string; args: string[]; detached: boolean }> = [];
    const spawnFn = ((file: string, args: string[], o: { detached?: boolean }) => {
      calls.push({ file, args, detached: !!o.detached });
      const a = answer(file, args);
      const script = `process.stdout.write(${JSON.stringify(a.out ?? '')});process.stderr.write(${JSON.stringify(a.err ?? '')});process.exit(${a.code})`;
      return spawn(process.execPath, ['-e', script], { ...o, detached: false });
    }) as unknown as SpawnFn;
    return { calls, spawnFn };
  }
  const claudeWith = (spawnFn: SpawnFn, logs: string[]) =>
    new ClaudeAgent({
      claudePath: '/c/claude',
      home: fs.mkdtempSync(path.join(os.tmpdir(), 'cld-sdr-')),
      env: {},
      systemdRun: '/usr/bin/systemd-run',
      cldBin: null,
      sessionPath: null,
      startMs: 10_000,
      stopMs: 10_000,
      spawnFn,
      log: (l) => logs.push(l),
    });
  const p = { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: os.tmpdir(), wantRunning: false } as ProjectRecord;

  it('systemd-run first; a bus failure: one log line, the same claude argv detached, and claude directly from then on', async () => {
    const s = scripted((file) =>
      file === '/usr/bin/systemd-run'
        ? { code: 1, err: 'Failed to connect to bus: No medium found\n' }
        : { code: 0, out: 'backgrounded · ab12cd34 · alpha\n' },
    );
    const logs: string[] = [];
    const c = claudeWith(s.spawnFn, logs);
    expect(await c.start(p, { token: () => null })).toEqual({ ok: true, id: 'ab12cd34' });
    expect(s.calls).toEqual([
      {
        file: '/usr/bin/systemd-run',
        args: ['--user', '--scope', '--collect', '--quiet', '--', '/c/claude', '--bg', '-n', 'alpha'],
        detached: false,
      },
      { file: '/c/claude', args: ['--bg', '-n', 'alpha'], detached: true },
    ]);
    expect(logs).toEqual([
      'systemd-run failed (Failed to connect to bus: No medium found); running claude with setsid from now on',
    ]);
    expect(await c.stop({ id: 'ab12cd34', pid: 1, cwd: '/', kind: 'background', sessionId: 's' })).toEqual({ ok: true });
    expect(s.calls.slice(2)).toEqual([{ file: '/c/claude', args: ['stop', 'ab12cd34'], detached: true }]);
    expect(logs).toHaveLength(1);
  });

  it('a failure that is not the bus (an untrusted folder) is not run again: needsTrust', async () => {
    const s = scripted(() => ({ code: 1, err: 'Error: Workspace not trusted\n' }));
    const logs: string[] = [];
    const c = claudeWith(s.spawnFn, logs);
    expect(await c.start(p, { token: () => null })).toMatchObject({ ok: false, needsTrust: true });
    expect(s.calls.map((x) => x.file)).toEqual(['/usr/bin/systemd-run']);
    expect(logs).toEqual([]);
  });
});

describe('D5 (6.3): an assignment of an unknown provider gathers nothing', () => {
  it('revive and three watch passes skip it: no inbox, one log line, the Claude Lead on, its downNote as before', async () => {
    const inbox: Array<{ name: string; text: string }> = [];
    const r = home('nope', { writeInbox: (name, text) => (inbox.push({ name, text }), true) }, true);
    const e = r.boot();
    await vi.waitFor(() => expect(r.agent(e, 'alpha').live).toBe(true), { timeout: 8_000, interval: 25 });
    await vi.waitFor(() => expect(r.logs.some((l) => l.includes('"alpha-a"'))).toBe(true));
    await new Promise((x) => setTimeout(x, 200)); // revive's pass is over
    const watch = () => (e as unknown as { watch(): Promise<void> }).watch();
    for (let i = 0; i < 3; i++) await watch();
    expect(inbox.filter((m) => m.name === 'alpha-a')).toEqual([]);
    expect(r.logs.filter((l) => l.includes('"alpha-a"'))).toEqual([
      '[cld engine] "alpha-a": no agent provider "nope" in this build; not revived',
    ]);
    expect(r.agent(e, 'alpha-a')).toMatchObject({ live: false, wantRunning: true, downNote: 'cld-gui가 모르는 에이전트(nope)라 켤 수 없어요' });
    expect(e.providerReady('nope')).toBe(false);
    expect(e.providerReady('claude')).toBe(true);
    expect(e.refuses('alpha-a', { from: 'alpha', source: 'mcp' })).toEqual({
      code: 'unknown_provider',
      error: 'cld-gui가 모르는 에이전트(nope)라 받을 수 없어요',
    });
    expect(e.refuses('alpha', { from: null, source: 'messenger:mac' })).toBeNull();
  });
});

describe('D5 (F4): the safety refresh beat', () => {
  it('calls tick with each safety refresh', async () => {
    let ticks = 0;
    const r = home(undefined, { tick: () => ticks++, timing: { ...FAST, safetyMs: 40 } });
    r.boot();
    await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(3), { timeout: 5_000, interval: 20 });
  });
});

describe('D5 (F2): the claude CLI missing, then back', () => {
  it('start says why, revive and the watch skip it (one log line, no inbox), and the next watch after it is back revives', async () => {
    const inbox: Array<{ name: string; text: string }> = [];
    const r = home(undefined, { writeInbox: (name, text) => (inbox.push({ name, text }), true) }, true);
    const claude = path.join(r.home, 'bin', 'claude');
    const away = `${claude}.away`;
    fs.renameSync(claude, away); // the CLI is gone (uninstalled, off PATH)
    const e = r.boot(); // revive: both were on
    const why = 'claude 실행 파일을 찾지 못했어요';
    await vi.waitFor(() =>
      expect(r.logs.filter((l) => l.endsWith(`${why}; not revived`))).toHaveLength(2),
    );
    expect(await r.act(e, 'start', 'alpha')).toMatchObject({ ok: false, error: why });
    expect(r.agent(e, 'alpha')).toMatchObject({ live: false, downNote: why });
    const watch = () => (e as unknown as { watch(): Promise<void> }).watch();
    await watch();
    await watch();
    expect(r.logs.filter((l) => l.includes('not revived'))).toHaveLength(2); // once per agent
    expect(inbox).toEqual([]);
    expect(r.claudeCalls()).toEqual([]);
    fs.renameSync(away, claude);
    await watch();
    expect([r.agent(e, 'alpha').live, r.agent(e, 'alpha-a').live]).toEqual([true, true]);
    // Each gets the revive notice of a daemon start (F5), not of a session that died.
    expect(inbox.map((m) => m.name).sort()).toEqual(['alpha', 'alpha-a']);
    for (const m of inbox) expect(m.text).not.toContain('같은 부팅에서 세션이 꺼져');
  });
});

describe("D5 (step 2): a 'run' provider (one process per message) through the engine and the messenger", () => {
  /** Runs in memory: deliver() starts one per message (none while one runs); finish() ends them. */
  class RunAgent implements AgentProvider {
    readonly id = 'runner';
    readonly protocol = 'codex' as const;
    readonly capabilities = {
      ...CLAUDE_CAPABILITIES,
      approvalPolicy: ['never'],
      attach: null,
      naming: 'none' as const,
      usage: null,
      lifetime: 'run' as const,
    };
    readonly calls: string[] = [];
    readonly delivered: Array<{ name: string; text: string; task?: string }> = [];
    runs: LiveSession[] = [];
    private n = 0;
    private changed: () => void = () => undefined;
    live = () => this.runs.map((s) => ({ ...s }));
    liveUnsure = () => false;
    onChange = (cb: () => void) => ((this.changed = cb), () => undefined);
    nameMatches = () => false;
    held = () => Promise.resolve(false);
    transcript = () => '';
    start(p: ProjectRecord): Promise<StartResult> {
      this.calls.push(`start ${p.name}`);
      return Promise.resolve({ ok: true, id: null });
    }
    stop(s: LiveSession) {
      this.calls.push(`stop ${s.id ?? ''}`);
      this.runs = this.runs.filter((x) => x.id !== s.id);
      return Promise.resolve({ ok: true as const });
    }
    deliver(p: ProjectRecord, text: string, o: { task?: string }) {
      if (this.runs.some((r) => r.assignmentId === p.assignmentId)) return Promise.resolve('notReady' as const);
      this.delivered.push({ name: p.name, text, ...(o.task && { task: o.task }) });
      const id = `run${++this.n}`;
      this.runs.push({ id, pid: 4_200_000 + this.n, cwd: p.folder, kind: 'background', sessionId: id, name: p.name, status: 'busy', assignmentId: p.assignmentId });
      this.changed();
      return Promise.resolve('typed' as const);
    }
    finish() {
      this.runs = [];
      this.changed();
    }
  }

  function rig() {
    const run = new RunAgent();
    let m: Messenger | null = null;
    const typed: string[] = [];
    const r = home('runner', {
      agents: [run],
      started: (name) => m?.deliverInbox(name),
      writeInbox: (name, text) => m?.writeInbox(name, text) ?? false,
    });
    const e = r.boot();
    m = new Messenger({
      home: r.home,
      engine: e,
      typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed' as const)) },
      events: new EngineEvents(eventsPath(r.home)),
      timing: { tickMs: 20, retryMs: 50 },
      log: () => undefined,
    });
    m.start();
    cleanup.push(() => m?.dispose());
    const roster = () => e.roster().find((a) => a.name === 'alpha-a')!;
    return { ...r, e, m, run, typed, roster };
  }
  const fromLead = (text: string, task?: string) => ({ to: 'alpha-a', text, ifIdle: false, from: 'alpha', source: 'mcp', ...(task && { task }) });

  it('on = resting (no process): a message is one deliver with its header; one while it works waits, then one more', async () => {
    const t = rig();
    expect(t.roster()).toMatchObject({ live: false, wantRunning: false }); // stopped
    expect(await t.act(t.e, 'start', 'alpha-a')).toMatchObject({ ok: true });
    expect(t.run.calls).toEqual([]); // nothing is spawned for a 'run' agent
    expect(t.agent(t.e, 'alpha-a')).toMatchObject({ live: true, wantRunning: true, provider: 'runner' });
    expect(t.agent(t.e, 'alpha-a').bgId).toBeUndefined();
    expect(t.agent(t.e, 'alpha-a').sessionId).toBeUndefined();
    expect(JSON.stringify(t.e.state())).not.toContain('rest:');
    expect(t.roster()).toMatchObject({ live: false, busy: false, wantRunning: true }); // down
    const office = t.e.apply({ rooms: [], agents: [] }).agents.find((a) => a.name === 'alpha-a')!;
    expect(office).toMatchObject({ state: 'running', busy: false, pid: null, sessionId: null, bg: null, transcript: null });

    expect(await t.m.send(fromLead('첫 일', 'T-1'))).toMatchObject({ ok: true, delivered: 'pane' });
    expect(t.run.delivered).toHaveLength(1);
    expect(t.run.delivered[0]).toMatchObject({ name: 'alpha-a', task: 'T-1' });
    expect(t.run.delivered[0].text).toMatch(/^\[cld-gui · alpha에게서 · Task T-1 · .*\] ⟨m:[a-z2-7]{8}⟩\n첫 일$/);
    t.e.refresh();
    expect(t.roster()).toMatchObject({ live: true, busy: true });
    expect(await t.m.send(fromLead('둘째 일'))).toMatchObject({ ok: true, delivered: 'queued' });
    await new Promise((x) => setTimeout(x, 200));
    expect(t.run.delivered).toHaveLength(1);
    t.run.finish();
    await vi.waitFor(() => expect(t.run.delivered).toHaveLength(2));
    expect(t.run.delivered[1].text).toMatch(/\n둘째 일$/);
    expect(t.typed).toEqual([]); // never the Typist
    expect(t.run.calls).toEqual([]);
  });

  it('stopped: messages go to the inbox; started again, the inbox is one deliver; a person’s own message is refused', async () => {
    const t = rig();
    await t.act(t.e, 'start', 'alpha-a');
    expect(await t.act(t.e, 'stop', 'alpha-a')).toMatchObject({ ok: true });
    expect(t.run.calls).toEqual(['stop rest:' + loadRegistry(registryPath(t.home)).projects.find((p) => p.name === 'alpha-a')!.assignmentId]);
    expect(t.roster()).toMatchObject({ live: false, wantRunning: false });
    expect(await t.m.send(fromLead('a'))).toMatchObject({ ok: true, delivered: 'inbox' });
    expect(await t.m.send(fromLead('b'))).toMatchObject({ ok: true, delivered: 'inbox' });
    expect(await t.act(t.e, 'start', 'alpha-a')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(t.run.delivered).toHaveLength(1));
    expect(t.run.delivered[0].text).toMatch(/\na\n\n\[cld-gui · alpha에게서 · .*\nb$/);
    expect(await t.m.send({ to: 'alpha-a', text: '안녕', ifIdle: false, from: null, source: 'messenger:mac' })).toEqual({
      ok: false,
      code: 'no_direct_chat',
      error: 'Codex Worker 와는 직접 대화하지 않아요 · Lead 에게 맡기거나 단톡방에서 불러 주세요',
    });
    // The project (a Claude Lead) is not refused.
    expect(t.e.refuses('alpha', { from: null, source: 'messenger:mac' })).toBeNull();
  });

  it('revive and the watch never start it; it is never folded by name; promote is refused', async () => {
    const agentRun = new RunAgent();
    const r = home('runner', { agents: [agentRun] }, true);
    const e = r.boot();
    await vi.waitFor(() => expect(r.logs.some((l) => l.includes('revive "alpha-a": already live'))).toBe(true));
    for (let i = 0; i < 2; i++) await (e as unknown as { watch(): Promise<void> }).watch();
    expect(agentRun.calls).toEqual([]);
    const row = {
      ...ENTRY_DEFAULTS,
      key: 'name:alpha-a',
      name: 'alpha-a',
      dir: r.alpha,
      tab: 'alpha',
      order: 1,
      state: 'running' as const,
      busy: false,
      pid: 1,
      sessionId: 'x',
      remoteControl: { on: false, url: null },
      bg: { id: 'b', state: 'working', sessionId: 'x', started: null },
      transcript: null,
    };
    expect(e.apply({ rooms: [], agents: [row] }).agents.map((a) => a.key)).toContain('name:alpha-a');
    expect(await r.act(e, 'promote', 'alpha-a')).toMatchObject({ ok: false, error: 'Codex Worker 는 아직 Lead 가 될 수 없어요' });
  });
});
