import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FAKE_CLAUDE, fakeBin, makeFakeHome, REPO_ROOT } from '../testHome.js';
import type { ClaudeSession } from './claudeProvider.js';
import {
  ClaudeAgentsSource,
  ClaudeSessions,
  entriesFromSessions,
  findOnPath,
  parseAgents,
  processAlive,
  sessionFromFile,
  transcriptPath,
} from './claudeProvider.js';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

const c4 = () =>
  parseAgents(
    JSON.parse(
      fs.readFileSync(path.join(FAKE_CLAUDE, 'C-4/agents.json'), 'utf-8').replace(/@HOME@/g, '/h'),
    ),
  );

describe('claude provider', () => {
  it('parses `claude agents --json` and drops rows without cwd/sessionId', () => {
    expect(c4()).toHaveLength(5);
    expect(parseAgents([{ cwd: '/x' }, null, { cwd: '/y', sessionId: 's' }])).toHaveLength(1);
    expect(() => parseAgents({})).toThrow();
  });

  it('one character per session, rooms by project dir, labels = name or folder', () => {
    const { rooms, agents } = entriesFromSessions(c4(), (cwd, sid) => `/t${cwd}/${sid}.jsonl`);
    expect(rooms.map((r) => r.name)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect(agents.map((a) => [a.name, a.tab, a.state, a.busy])).toEqual([
      ['alpha-orchestrator', 'alpha', 'running', true],
      ['alpha', 'alpha', 'running', false], // unnamed -> folder basename
      ['beta-task', 'beta', 'running', true], // background working
      ['gamma-review', 'gamma', 'running', false], // background blocked
      ['old-job', 'delta', 'running', false], // background done = turn finished, still alive
    ]);
    expect(agents[0].transcript).toBe('/t/work/alpha/a0000001-0000-4000-8000-000000000001.jsonl');
    expect(agents[4].transcript).toBe('/t/work/delta/a0000018-0000-4000-8000-000000000024.jsonl');
    expect(agents.map((a) => a.order)).toEqual([1, 2, 1, 1, 1]);
    expect(new Set(agents.map((a) => a.key)).size).toBe(5);
    // The fields only some entries fill in are neutral.
    expect(agents[0]).toMatchObject({ compactions: 0, alive: false, title: null, bg: null });
    expect(agents[2].bg).toMatchObject({ state: 'working' });
  });

  it('widens colliding folder names and de-duplicates keys', () => {
    const { rooms, agents } = entriesFromSessions(
      [
        { cwd: '/a/app', kind: 'interactive', sessionId: 's1', name: 'x' },
        { cwd: '/b/app', kind: 'interactive', sessionId: 's2', name: 'x' },
      ],
      () => 't',
    );
    expect(rooms.map((r) => r.name)).toEqual(['a/app', 'b/app']);
    expect(agents[0].key).not.toBe(agents[1].key);
  });

  it('finds the transcript under ~/.claude/projects, also in another project dir', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-tp-'));
    const other = path.join(home, '.claude/projects/-elsewhere');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'sid.jsonl'), '');
    expect(transcriptPath('/work/a', 'sid', home)).toBe(path.join(other, 'sid.jsonl'));
    expect(transcriptPath('/work/a', 'none', home)).toBe(
      path.join(home, '.claude/projects/-work-a/none.jsonl'),
    );
  });

  it('which: absolute path of an executable on PATH', () => {
    expect(findOnPath('claude', `/nonexistent${path.delimiter}${FAKE_CLAUDE}`)).toBe(
      path.join(FAKE_CLAUDE, fakeBin('claude')),
    );
    expect(findOnPath('claude', 'relative/dir')).toBeNull();
  });

  it('which on Windows: claude.exe or npm\'s claude.cmd, never the sh script beside them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'which-'));
    for (const f of ['claude', 'claude.cmd']) fs.writeFileSync(path.join(dir, f), '', { mode: 0o755 });
    expect(findOnPath('claude', dir)).toBe(path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude'));
    expect(findOnPath('claude', dir, 'linux')).toBe(path.join(dir, 'claude'));
  });

  it('runs the fake claude: `agents --json` only, by absolute path', async () => {
    const fake = makeFakeHome({ claude: 'C-4' });
    Object.assign(process.env, fake.env);
    const src = new ClaudeAgentsSource(fake.claudePath);
    const [a, b] = await Promise.all([src.list(), src.list()]);
    expect(a).toHaveLength(5);
    expect(b).toBe(a); // one call in flight
    expect(fs.readFileSync(fake.claudeLog, 'utf-8')).toBe('agents --json\n');
  });
});

/** Real ~/.claude/sessions files, anonymized (cld/test/record-claude-sessions.mjs). */
const RECORDED = path.join(REPO_ROOT, 'cld/test/claude-sessions');
const recorded = (n: string) =>
  JSON.parse(fs.readFileSync(path.join(RECORDED, n), 'utf-8')) as Record<string, unknown>;
const anyAlive = () => true;
/** What a format change looks like first: a key, kind or status this build never saw. */
const KNOWN_KEYS = [
  'agent',
  'bridgeSessionId',
  'cwd',
  'entrypoint',
  'jobId',
  'kind',
  'messagingSocketPath',
  'name',
  'nameSince',
  'nameSource',
  'parkedJobId',
  'peerFeatures',
  'peerProtocol',
  'pid',
  'pidDomain',
  'procStart',
  'sessionId',
  'spare',
  'startedAt',
  'status',
  'statusUpdatedAt',
  'tmux',
  'updatedAt',
  'version',
  'waitingFor',
];

describe('~/.claude/sessions files (contract: Claude Code 2.1.273 to 2.1.306)', () => {
  const files = fs.readdirSync(RECORDED).sort();

  it('every recorded file is read, field by field, and nothing in it is new', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const n of files) {
      const f = recorded(n);
      expect(KNOWN_KEYS).toEqual(expect.arrayContaining(Object.keys(f)));
      expect(['interactive', 'bg']).toContain(f.kind);
      expect(['busy', 'idle', 'waiting', 'shell']).toContain(f.status);
      expect(sessionFromFile(f, Number.parseInt(n, 10), anyAlive)).toEqual({
        pid: f.pid,
        cwd: f.cwd,
        kind: f.kind === 'bg' ? 'background' : 'interactive',
        sessionId: f.sessionId,
        startedAt: f.startedAt,
        name: f.name,
        status: f.parkedJobId ? undefined : f.status,
        id: f.jobId,
      });
    }
  });

  it('a parked conversation drops its frozen status; a spare worker is no session', () => {
    const parked = files.map(recorded).find((f) => f.parkedJobId)!;
    expect(sessionFromFile(parked, 0, anyAlive)).toMatchObject({ status: undefined });
    // A prewarmed background worker as seen on 10-21 (its file left with it).
    const bg = files.map(recorded).find((f) => f.kind === 'bg')!;
    const spare = { ...bg, name: bg.jobId, agent: 'claude', spare: true };
    expect(sessionFromFile(spare, 0, anyAlive)).toBeNull();
  });

  it('a live file of another shape is unknown; a dead one is skipped', () => {
    const f = recorded(files[0]);
    const pid = f.pid as number;
    const { sessionId: _s, ...noSession } = f;
    expect(sessionFromFile(noSession, pid, anyAlive)).toBe('unknown');
    expect(sessionFromFile({ ...f, kind: 'robot' }, pid, anyAlive)).toBe('unknown');
    expect(sessionFromFile({ ...f, pid: String(pid) }, pid, anyAlive)).toBe('unknown');
    expect(sessionFromFile('{', pid, anyAlive)).toBe('unknown');
    expect(sessionFromFile(f, pid, () => false)).toBeNull();
    expect(sessionFromFile({ ...f, kind: 'robot' }, pid, () => false)).toBeNull();
    if (process.platform === 'linux') {
      const { procStart: _p, ...noStart } = f;
      expect(sessionFromFile(noStart, pid, anyAlive)).toBe('unknown');
    }
  });

  it.runIf(process.platform === 'linux')(
    'liveness: the pid runs and its start time is procStart',
    () => {
      const stat = fs.readFileSync('/proc/self/stat', 'utf-8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      expect(processAlive(process.pid, start)).toBe(true);
      expect(processAlive(process.pid, `${start}0`)).toBe(false); // a reused pid
      expect(processAlive(process.pid)).toBe(true);
      expect(processAlive(4_194_305)).toBe(false); // above Linux's pid_max
    },
  );
});

describe('ClaudeSessions', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  /** A sessions dir with these recorded files. */
  const sessionsDir = (...names: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-sessions-'));
    dirs.push(dir);
    for (const n of names) fs.copyFileSync(path.join(RECORDED, n), path.join(dir, n));
    return dir;
  };
  const interactive = () =>
    fs.readdirSync(RECORDED).filter((n) => {
      const f = recorded(n);
      return f.kind === 'interactive' && !f.parkedJobId;
    });
  const bgFile = () => fs.readdirSync(RECORDED).find((n) => recorded(n).kind === 'bg')!;

  it('named interactive sessions come from the files alone, never from a spawn', async () => {
    const fallback = { list: vi.fn(async (): Promise<ClaudeSession[]> => []) };
    const s = new ClaudeSessions(sessionsDir(...interactive()), fallback, anyAlive);
    const rows = await s.list(true);
    expect(rows.map((r) => r.name)).toEqual(interactive().map((n) => recorded(n).name));
    expect(fallback.list).not.toHaveBeenCalled();
  });

  it('a background job takes its state from claude agents --json: only when allowed, at most every 30 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const bg = recorded(bgFile());
    const fallback = {
      list: vi.fn(async (): Promise<ClaudeSession[]> => [
        {
          kind: 'background',
          id: bg.jobId as string,
          cwd: bg.cwd as string,
          sessionId: bg.sessionId as string,
          state: 'blocked',
        },
      ]),
    };
    const s = new ClaudeSessions(sessionsDir(bgFile(), interactive()[0]), fallback, anyAlive);
    const bgRow = async (spawn: boolean) => (await s.list(spawn)).find((r) => r.id === bg.jobId);
    const unviewed = await bgRow(false);
    expect(unviewed?.kind).toBe('background');
    expect(unviewed?.state).toBeUndefined();
    expect(fallback.list).not.toHaveBeenCalled(); // nobody viewing
    expect(await bgRow(true)).toMatchObject({ kind: 'background', state: 'blocked' });
    vi.advanceTimersByTime(29_000);
    expect(await bgRow(true)).toMatchObject({ state: 'blocked' });
    expect(fallback.list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await s.list(true);
    expect(fallback.list).toHaveBeenCalledTimes(2);
  });

  it('an unknown live file switches to claude agents --json, with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = sessionsDir(interactive()[0]);
    fs.writeFileSync(
      path.join(dir, '4242.json'),
      JSON.stringify({ pid: 4242, sessionId: 'x', cwd: '/w', kind: 'robot', procStart: '1' }),
    );
    const agents = parseAgents(
      JSON.parse(fs.readFileSync(path.join(FAKE_CLAUDE, 'C-4/agents.json'), 'utf-8')),
    );
    const fallback = { list: vi.fn(async () => agents) };
    const s = new ClaudeSessions(dir, fallback, anyAlive);
    expect(await s.list(false)).toHaveLength(1); // no answer yet: the files it can read
    expect(await s.list(true)).toBe(agents);
    expect(await s.list(true)).toBe(agents);
    expect(fallback.list).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a background job is busy by its state when known, else by its file status', () => {
    const row = { kind: 'background', cwd: '/w', sessionId: 's1', status: 'busy' };
    expect(entriesFromSessions([row], () => '').agents[0].busy).toBe(true);
    expect(entriesFromSessions([{ ...row, state: 'blocked' }], () => '').agents[0].busy).toBe(
      false,
    );
    expect(entriesFromSessions([{ ...row, state: 'working' }], () => '').agents[0].busy).toBe(true);
  });

  it('a file read mid-write keeps its last good read; a removed file is gone', async () => {
    const n = interactive()[0];
    const dir = sessionsDir(n);
    const s = new ClaudeSessions(dir, null, anyAlive);
    expect(await s.list(true)).toHaveLength(1);
    fs.writeFileSync(path.join(dir, n), '{"pid": 11');
    expect(await s.list(true)).toHaveLength(1);
    fs.rmSync(path.join(dir, n));
    expect(await s.list(true)).toHaveLength(0);
  });
});
