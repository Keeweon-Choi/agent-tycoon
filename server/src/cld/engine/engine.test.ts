import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  EngineAction,
  EngineActionKind,
  EngineActionResult,
} from '../../../../core/src/messages.js';
import { transcriptPath } from '../providers/claudeProvider.js';
import type { AgentEntry, World } from '../providers/types.js';
import { ENTRY_DEFAULTS } from '../providers/types.js';
import { engineCalls, killFakeSessions, makeEngineHome, removeTestHome, REPO_ROOT } from '../testHome.js';
import { waitFor } from '../waitKit.js';
import {
  claudeCommand,
  printedId,
  startArgs,
  statusLineCommand,
  TRUST_NEEDED,
} from './agents/claude/claude.js';
import { readLiveSessions } from './agents/claude/sessions.js';
import type { EngineOptions } from './engine.js';
import {
  CLD_BIN_DIR,
  cldBinPath,
  cleanEnv,
  Engine,
  engineOn,
  findSystemdRun,
  parseEngineAction,
} from './engine.js';
import { EngineEvents, eventsPath } from './events.js';
import { Messenger } from './messenger.js';
import type { ProjectRecord } from './registry.js';
import { loadRegistry, PROJECT_ID_RE, registryPath, saveRegistry } from './registry.js';

const FAST = {
  pollMs: 20,
  appearMs: 30_000, // only the longest a start waits for its session: it is over the moment the session shows
  goneMs: 30_000,
  reviveGapMs: 150,
  safetyMs: 60_000,
  debounceMs: 50,
  watchMs: 0,
};
// What the daemon's own environment may hold when it was started from a session.
const DIRTY = {
  CLAUDECODE: '1',
  CLAUDE_PID: '4174',
  CLAUDE_EFFORT: 'max',
  OFFICE_START: '1',
  TMUX: 't',
};
const SESSION_VAR = /^(CLAUDE)|^TMUX/;

// Every test starts real fake-claude processes (a `--bg` start, a kill, a revive each spawn one), and
// the watch tests wait for several in a row; on a starved CPU (the deploy gate: two nice'd cores)
// that outlasts the 10 s default while nothing is wrong. The waits end as soon as their state holds.
vi.setConfig({ testTimeout: 90_000 });

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function setup(
  opts: {
    readOnly?: boolean;
    projects?: ProjectRecord[];
    binDir?: string;
    extra?: Partial<EngineOptions>;
  } = {},
) {
  const { home, claudePath } = makeEngineHome();
  if (opts.projects) saveRegistry(registryPath(home), opts.projects);
  const logs: string[] = [];
  const make = () =>
    new Engine({
      claudePath,
      home,
      readOnly: opts.readOnly ?? false,
      systemdRun: null,
      log: (l) => logs.push(l),
      timing: FAST,
      env: { ...process.env, ...DIRTY },
      binDir: opts.binDir ?? null,
      ...opts.extra,
    });
  const engines: Engine[] = [];
  const boot = () => {
    const e = make();
    engines.push(e);
    e.start();
    return e;
  };
  cleanup.push(() => {
    for (const e of engines) e.dispose();
    killFakeSessions(home);
    // A fake session can still write one last job file while it exits (ENOTEMPTY under load): the shared retry.
    removeTestHome(home);
  });
  let n = 0;
  const act = (
    engine: Engine,
    action: EngineActionKind,
    name: string,
    fields: Partial<EngineAction> = {},
    privileged = true,
  ): Promise<EngineActionResult> =>
    engine.run(
      { type: 'engineAction', requestId: `r${++n}`, action, name, ...fields },
      privileged,
      'linux',
    );
  const folder = (name: string) => {
    const d = path.join(home, 'work', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const project = (engine: Engine, name: string) =>
    engine.state().projects.find((p) => p.name === name);
  /** Claude writes a transcript once the conversation has a message. */
  const transcript = (cwd: string, sessionId: string) => {
    const t = transcriptPath(cwd, sessionId, home);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, '{}\n');
  };
  const fake = (args: string[], cwd = home) =>
    spawnSync(claudePath, args, { cwd, env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  const bgCalls = () => engineCalls(home).filter((c) => c.argv[0] === '--bg');
  return { home, boot, act, folder, project, transcript, fake, logs, bgCalls };
}

/** A live process for a hand-written session file, killed after the test. */
function liveProcess(env?: NodeJS.ProcessEnv): number {
  const child = spawn('sleep', ['300'], { stdio: 'ignore', env });
  cleanup.push(() => child.kill('SIGKILL'));
  return child.pid!;
}

/** /proc start time; none off Linux, where liveness is the pid alone (claudeProvider.processAlive). */
function procStart(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
}

describe('engine pieces', () => {
  it('argv: the chosen options, nothing by default; a woken job gets --resume alone', () => {
    const p: ProjectRecord = {
      projectId: 'p_abcdefghij',
      name: 'alpha',
      folder: '/w/alpha',
      wantRunning: false,
    };
    expect(startArgs(p)).toEqual(['--bg', '-n', 'alpha']);
    expect(
      startArgs(
        {
          ...p,
          rulesFile: '/r/rules.md',
          model: 'm-1',
          permissionMode: 'plan',
          effort: 'high',
          remoteControl: true,
          title: 'alpha-orchestrator',
        },
        'sid-1',
      ),
    ).toEqual([
      '--bg',
      '-n',
      'alpha-orchestrator',
      '--resume',
      'sid-1',
      '--append-system-prompt-file',
      '/r/rules.md',
      '--model',
      'm-1',
      '--permission-mode',
      'plan',
      '--effort',
      'high',
      '--remote-control',
      'alpha-orchestrator',
    ]);
    expect(startArgs({ ...p, model: 'm-1' }, 'sid-1', true)).toEqual(['--bg', '--resume', 'sid-1']);
  });

  it("argv leaves the user's own skills, hooks, plugins and MCP servers in place (10-24 02:31)", () => {
    const p: ProjectRecord = { projectId: 'p_abcdefghij', name: 'alpha', folder: '/w/alpha', wantRunning: false };
    const args = startArgs(p, undefined, false, '/x/cld-gui', '/usr/bin', 't'.repeat(43), '/h/mcp.json');
    // Flags that would narrow what a normal `claude` loads from the user's and the project's settings.
    for (const flag of ['--strict-mcp-config', '--setting-sources', '--disallowedTools', '--tools'])
      expect(args).not.toContain(flag);
    // C5a: our MCP adapter is added beside the user's own servers, not instead of them.
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual([
      '--mcp-config',
      '/h/mcp.json',
    ]);
    // Our --settings only adds session-scoped keys: no hooks, permissions, plugins or MCP of our own.
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]) as Record<string, unknown>;
    expect(Object.keys(settings).sort()).toEqual(['env', 'promptSuggestionEnabled', 'statusLine', 'worktree']);
  });

  it('claude runs in its own systemd user scope, or in a new session without one', () => {
    expect(claudeCommand('/c/claude', ['stop', 'ab12'], '/usr/bin/systemd-run')).toEqual({
      file: '/usr/bin/systemd-run',
      args: ['--user', '--scope', '--collect', '--quiet', '--', '/c/claude', 'stop', 'ab12'],
      detached: false,
    });
    expect(claudeCommand('/c/claude', ['stop', 'ab12'], null)).toEqual({
      file: '/c/claude',
      args: ['stop', 'ab12'],
      detached: true,
    });
    // systemd-run only with a running user manager (its private socket) on Linux.
    const { home } = setup();
    const run = path.join(home, 'xdg');
    fs.mkdirSync(path.join(run, 'systemd'), { recursive: true });
    const bin = path.join(home, 'sbin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'systemd-run'), '#!/bin/sh\n', { mode: 0o755 });
    const env = { XDG_RUNTIME_DIR: run, PATH: bin };
    expect(findSystemdRun(env, 'linux')).toBeNull();
    fs.writeFileSync(path.join(run, 'systemd', 'private'), '');
    expect(findSystemdRun(env, 'linux')).toBe(path.join(bin, 'systemd-run'));
    expect(findSystemdRun(env, 'darwin')).toBeNull();
    expect(findSystemdRun({ PATH: bin }, 'linux')).toBeNull();
  });

  it('a clean environment: the user’s, never a session’s', () => {
    const env = cleanEnv(
      {
        HOME: '/x',
        PATH: '/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C',
        USER: 'u',
        SHELL: '/bin/bash',
        TERM: 'xterm',
        XDG_RUNTIME_DIR: '/run/user/1',
        CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
        ...DIRTY,
      },
      '/home/t',
      'linux',
      null,
    );
    expect(Object.keys(env).sort()).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'SHELL',
      'TERM',
      'USER',
      'XDG_RUNTIME_DIR',
    ]);
    expect(env.HOME).toBe('/home/t');
    expect(
      cleanEnv(
        {
          Path: 'C:\\b',
          SystemRoot: 'C:\\W',
          LOCALAPPDATA: 'C:\\u\\AppData\\Local',
          PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
          PROCESSOR_ARCHITECTURE: 'AMD64',
          CLAUDE_PID: '1',
          CLD_GUI_SECRET: 'daemon-only',
        },
        'C:\\u',
        'win32',
        null,
        undefined,
        () => ({
          Path: 'C:\\Windows\\System32;C:\\Users\\최\\bin',
          JAVA_HOME: 'C:\\Java\\user',
          SHARED: 'user',
          KOREAN_HOME: 'C:\\Users\\최\\tools',
          home: 'C:\\registry-home',
        }),
      ),
    ).toEqual({
      Path: 'C:\\Windows\\System32;C:\\Users\\최\\bin',
      SystemRoot: 'C:\\W',
      LOCALAPPDATA: 'C:\\u\\AppData\\Local',
      PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
      PROCESSOR_ARCHITECTURE: 'AMD64',
      JAVA_HOME: 'C:\\Java\\user',
      SHARED: 'user',
      KOREAN_HOME: 'C:\\Users\\최\\tools',
      HOME: 'C:\\u',
    });
  });

  it('T-0019: CLD_BIN and the cld-gui bin folder first on PATH, whatever the shell config', () => {
    const env = cleanEnv(
      { PATH: '/usr/bin:/bin', CLAUDECODE: '1' },
      '/home/t',
      'linux',
      '/r/cld/bin',
      '/opt/node/bin',
    );
    expect(env.CLD_BIN).toBe('/r/cld/bin/cld-gui');
    // ENV-1: the daemon's Node last, for the `#!/usr/bin/env node` CLI on a machine without one.
    expect(env.PATH).toBe('/r/cld/bin:/usr/bin:/bin:/opt/node/bin');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(cleanEnv({}, '/home/t', 'linux', '/r/cld/bin', '/usr/bin').PATH).toBe(
      '/r/cld/bin:/usr/bin',
    );
    expect(
      cleanEnv({ PATH: '/usr/bin' }, '/home/t', 'linux', '/r/cld/bin', '/usr/bin').PATH,
    ).toBe('/r/cld/bin:/usr/bin');
    // The session's own values beat the registry's (a machine's USERNAME is SYSTEM); PATH is the registry's.
    const session = cleanEnv(
      { USERNAME: 'Ada', Path: 'C:\\daemon' },
      'C:\\u',
      'win32',
      null,
      undefined,
      () => ({ USERNAME: 'SYSTEM', Path: 'C:\\Windows;C:\\Users\\Ada\\bin', JAVA_HOME: 'C:\\Java' }),
    );
    expect(session.USERNAME).toBe('Ada');
    expect(session.Path).toBe('C:\\Windows;C:\\Users\\Ada\\bin');
    expect(session.JAVA_HOME).toBe('C:\\Java');
    // Windows keeps its own spelling of Path; the CLI is the .cmd next to the script.
    const win = cleanEnv(
      { Path: 'C:\\b' },
      'C:\\u',
      'win32',
      'C:\\r\\cld\\bin',
      'C:\\b',
      () => ({
        Path: 'C:\\Windows\\System32;C:\\Users\\최\\bin',
        cld_bin: 'C:\\registry\\cld-gui.cmd',
      }),
    );
    expect(win.Path).toBe('C:\\r\\cld\\bin;C:\\Windows\\System32;C:\\Users\\최\\bin;C:\\b');
    expect(win.CLD_BIN).toMatch(/cld-gui\.cmd$/);
    expect(win.cld_bin).toBeUndefined();
    // This checkout's CLI, found from the module (dist/ or the source tree).
    expect(CLD_BIN_DIR).toBe(path.join(REPO_ROOT, 'cld', 'bin'));
    expect(fs.existsSync(cldBinPath(CLD_BIN_DIR!, 'linux'))).toBe(true);
  });

  it('T-0019: CLD_BIN reaches a new session through --settings env (not PATH); a woken job keeps its own', () => {
    const p: ProjectRecord = {
      projectId: 'p_abcdefghij',
      name: 'alpha',
      folder: '/w/alpha',
      wantRunning: false,
    };
    expect(startArgs(p, undefined, false, '/r/cld/bin/cld-gui')).toEqual([
      '--bg',
      '-n',
      'alpha',
      '--settings',
      JSON.stringify({
        env: { CLD_BIN: '/r/cld/bin/cld-gui' },
        worktree: { bgIsolation: 'none' },
        statusLine: { type: 'command', command: statusLineCommand('/r/cld/bin/cld-gui') },
        // Undimmed on a Windows 10 ConPTY, a suggestion reads as a draft and holds messages (10-28).
        promptSuggestionEnabled: false,
      }),
    ]);
    expect(startArgs(p, 'sid', true, '/r/cld/bin/cld-gui')).toEqual(['--bg', '--resume', 'sid']);
  });

  it('ENV-2: the status line is our Node on cld-gui-statusline.js beside the CLI, quoted', () => {
    expect(statusLineCommand('/r a/cld/bin/cld-gui', '/n/node')).toBe(
      '"/n/node" "/r a/cld/bin/cld-gui-statusline.js"',
    );
    expect(fs.existsSync(path.join(CLD_BIN_DIR!, 'cld-gui-statusline.js'))).toBe(true);
  });

  it('parses only well-formed engineActions', () => {
    const ok = { type: 'engineAction', requestId: 'r1', action: 'add', name: 'alpha' };
    expect(parseEngineAction({ ...ok, folder: '/w', remoteControl: true, mkdir: true })).toEqual({
      ...ok,
      folder: '/w',
      remoteControl: true,
      mkdir: true,
    });
    expect(parseEngineAction({ ...ok, extra: 1 })).toEqual(ok);
    for (const bad of [
      { ...ok, requestId: '' },
      { ...ok, requestId: 'x'.repeat(129) },
      { ...ok, action: 'rm' },
      { ...ok, name: 3 },
      { ...ok, folder: ['/w'] },
      { ...ok, mkdir: 'yes' },
    ])
      expect(parseEngineAction(bad)).toBeNull();
  });

  it('the printed id, with or without colours', () => {
    expect(
      printedId('backgrounded \u00b7 \x1b[36m1a2b3c4d\x1b[39m \u00b7 alpha\n  claude agents'),
    ).toBe('1a2b3c4d');
    expect(printedId('nothing')).toBeNull();
    expect(engineOn('auto')).toBe(true);
    expect(engineOn('on')).toBe(true);
    expect(engineOn('off')).toBe(false);
  });
});

describe('engine with the fake claude', () => {
  it('registry: refuses bad names, folders, rules files and options before writing', async () => {
    const { home, boot, act, folder } = setup();
    const e = boot();
    const f = folder('alpha');
    expect((await act(e, 'add', '-rf', { folder: f })).error).toMatch(/^이름은/);
    expect((await act(e, 'add', 'a b', { folder: f })).ok).toBe(false);
    expect((await act(e, 'add', 'x'.repeat(42), { folder: f })).ok).toBe(false);
    expect((await act(e, 'add', 'alpha', { folder: 'work/alpha' })).error).toMatch(
      /^폴더는 \/ 나 ~\//,
    );
    expect(await act(e, 'add', 'alpha', { folder: path.join(home, 'none') })).toMatchObject({
      ok: false,
      error: '폴더가 없어요',
      folderMissing: true,
    });
    expect((await act(e, 'add', 'alpha', { folder: f, rulesFile: '/nope.md' })).error).toBe(
      '규칙 파일을 읽을 수 없어요',
    );
    expect((await act(e, 'add', 'alpha', { folder: f, model: '--dangerous' })).error).toBe(
      '모델 이름이 올바르지 않아요',
    );
    expect((await act(e, 'add', 'alpha', { folder: f, title: '-x' })).ok).toBe(false);
    expect((await act(e, 'add', 'alpha', { folder: f, permissionMode: 'a b' })).ok).toBe(false);
    expect((await act(e, 'add', 'alpha', { folder: f, effort: '--max' })).ok).toBe(false);
    expect((await act(e, 'add', 'alpha', { folder: f, room: '\u0007' })).ok).toBe(false);
    // mkdir never climbs out with a dot segment, however it is written (T-0035's 새 폴더).
    for (const up of [`${home}/a/../../escape`, '~/../escape', `${home}/..`])
      expect((await act(e, 'add', 'alpha', { folder: up, mkdir: true })).ok).toBe(false);
    expect(fs.existsSync(path.join(home, '..', 'escape'))).toBe(false);
    expect(fs.existsSync(registryPath(home))).toBe(false);
    expect(fs.existsSync(path.join(home, 'none'))).toBe(false);

    // The user agreed to create the folder; ~ is the home; options are kept as given.
    const rules = path.join(home, 'rules.md');
    fs.writeFileSync(rules, 'be brief');
    expect(
      await act(e, 'add', '한글-proj.1', {
        folder: '~/work/new',
        mkdir: true,
        room: '연구실',
        rulesFile: rules,
        model: 'some-model',
        remoteControl: true,
      }),
    ).toMatchObject({ ok: true });
    expect(fs.statSync(path.join(home, 'work/new')).isDirectory()).toBe(true);
    expect(loadRegistry(registryPath(home))).toMatchObject({
      broken: null,
      migrated: false,
      projects: [
        {
          name: '한글-proj.1',
          folder: path.join(home, 'work/new'),
          room: '연구실',
          rulesFile: rules,
          model: 'some-model',
          remoteControl: true,
          wantRunning: false,
        },
      ],
    });
    expect(loadRegistry(registryPath(home)).projects[0].projectId).toMatch(PROJECT_ID_RE);
    expect(fs.statSync(registryPath(home)).mode & 0o777).toBe(0o600);
    expect((await act(e, 'add', '한글-proj.1', { folder: f })).error).toBe('이미 있는 이름이에요');
    expect(e.state().projects[0]).toMatchObject({
      room: '연구실',
      live: false,
      model: 'some-model',
    });
    expect(engineCalls(home)).toEqual([]); // nothing ran claude
  });

  it('a projects.json it cannot read is never rewritten', async () => {
    const { home, boot, act, folder } = setup();
    const file = registryPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bad = JSON.stringify([
      { name: 'ok', folder: folder('ok'), wantRunning: true },
      { name: '-x', folder: '/w', wantRunning: false },
    ]);
    fs.writeFileSync(file, bad);
    const e = boot();
    expect(e.state().projects.map((p) => p.name)).toEqual(['ok']);
    expect(e.state().warnings?.[0]).toMatch(/읽지 못해 바꿀 수 없어요/);
    expect((await act(e, 'add', 'beta', { folder: folder('beta') })).error).toBe(
      '프로젝트 목록 파일을 읽지 못해 바꿀 수 없어요',
    );
    expect(fs.readFileSync(file, 'utf-8')).toBe(bad);
    expect(engineCalls(home)).toEqual([]); // and no revive either
  });

  it('migrates a legacy registry once, retaining its bytes and ids across restarts', () => {
    const { home, boot, folder, logs } = setup();
    const file = registryPath(home);
    const legacy = `${JSON.stringify([
      { name: 'alpha', folder: folder('alpha'), wantRunning: false, room: 'room' },
    ])}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, legacy);

    const first = boot();
    expect(first.hostId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const id = loadRegistry(file).projects[0].projectId;
    expect(id).toMatch(PROJECT_ID_RE);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      v: 2,
      projects: [{ projectId: id, name: 'alpha', folder: folder('alpha'), room: 'room' }],
    });
    expect(fs.readFileSync(`${file}.v0`, 'utf8')).toBe(legacy);
    expect(logs.some((line) => line.includes('projects.json: migrated to v1'))).toBe(true);

    boot();
    expect(loadRegistry(file).projects[0].projectId).toBe(id);
    expect(fs.readFileSync(`${file}.v0`, 'utf8')).toBe(legacy);
  });

  it('a read-only engine migrates (it writes its own bookkeeping)', () => {
    const { home, boot, folder } = setup({ readOnly: true });
    const file = registryPath(home);
    const legacy = `${JSON.stringify([{ name: 'alpha', folder: folder('alpha'), wantRunning: false }])}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, legacy);
    boot();
    expect(fs.readFileSync(`${file}.v0`, 'utf8')).toBe(legacy);
    expect(loadRegistry(file)).toMatchObject({ broken: null, version: 2 });
  });

  it('never rewrites a registry written by a future version', () => {
    const { home, boot } = setup();
    const file = registryPath(home);
    const bytes = '{"v":2,"projects":[]}\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);

    boot();

    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('keeps a project id on edit and gives a new project another id', async () => {
    const { home, boot, act, folder } = setup();
    const engine = boot();
    await act(engine, 'add', 'alpha', { folder: folder('alpha') });
    const alphaId = loadRegistry(registryPath(home)).projects[0].projectId;
    await act(engine, 'edit', 'alpha', { room: 'changed' });
    await act(engine, 'add', 'gamma', { folder: folder('gamma') });

    const stored = loadRegistry(registryPath(home)).projects;
    expect(stored.find((p) => p.name === 'alpha')!.projectId).toBe(alphaId);
    expect(stored.find((p) => p.name === 'gamma')!.projectId).not.toBe(alphaId);
  });

  it('an office add starts its new orchestrator, while a CLI add leaves it off', async () => {
    const { boot, folder, project, bgCalls } = setup();
    const e = boot();

    expect(
      await e.run(
        { type: 'engineAction', requestId: 'office-add', action: 'add', name: 'office', folder: folder('office') },
        true,
        'web',
        true,
      ),
    ).toMatchObject({ ok: true, action: 'add', name: 'office', bgId: expect.any(String) });
    expect(project(e, 'office')).toMatchObject({ live: true, wantRunning: true });
    expect(bgCalls()).toHaveLength(1);

    expect(
      await e.run(
        { type: 'engineAction', requestId: 'cli-add', action: 'add', name: 'cli', folder: folder('cli') },
        true,
        'cli',
      ),
    ).toMatchObject({ ok: true, action: 'add', name: 'cli' });
    expect(project(e, 'cli')).toMatchObject({ live: false, wantRunning: false });
    expect(bgCalls()).toHaveLength(1);
  });

  it('a messenger message starts an off orchestrator once and delivers its inbox', async () => {
    let messenger: Messenger | undefined;
    const typed: string[] = [];
    const r = setup({
      extra: { started: (name) => messenger?.deliverInbox(name) },
    });
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    messenger = new Messenger({
      home: r.home,
      engine: e,
      typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed')) },
      events: new EngineEvents(eventsPath(r.home)),
      timing: { tickMs: 20, retryMs: 50, ifIdleMs: 10 * 60_000, quietMs: 5_000 },
      log: () => undefined,
    });
    messenger.start();
    cleanup.push(() => messenger?.dispose());

    const first = messenger.send({ to: 'alpha', text: 'first', from: null, source: 'cli', ifIdle: false });
    const second = messenger.send({ to: 'alpha', text: 'second', from: null, source: 'cli', ifIdle: false });
    await expect(first).resolves.toMatchObject({ ok: true, delivered: 'inbox', reason: 'off' });
    await expect(second).resolves.toMatchObject({ ok: true, delivered: 'inbox', reason: 'off' });
    await waitFor(() => expect(typed).toHaveLength(1));

    expect(r.bgCalls()).toHaveLength(1);
    expect(typed[0]).toContain('\nfirst');
    expect(typed[0]).toContain('\nsecond');
    expect(r.logs.filter((line) => line.includes('inbox start "alpha"'))).toHaveLength(1);
  });

  it('start, then start again (no duplicate), stop, fresh vs resume, restart', async () => {
    const { home, boot, act, folder, project, transcript, bgCalls } = setup();
    const e = boot();
    const f = folder('alpha');
    await act(e, 'add', 'alpha', { folder: f, model: 'm-1' });
    const r1 = await act(e, 'start', 'alpha');
    expect(r1).toMatchObject({ ok: true });
    expect(r1.bgId).toMatch(/^[0-9a-f]{8}$/);
    const sid = project(e, 'alpha')!.sessionId!;
    expect(sid.startsWith(r1.bgId!)).toBe(true);
    expect(project(e, 'alpha')).toMatchObject({ live: true, bgId: r1.bgId, wantRunning: true });
    // argv, cwd and a clean environment
    expect(bgCalls()[0]).toMatchObject({ argv: ['--bg', '-n', 'alpha', '--model', 'm-1'], cwd: f });
    expect(bgCalls()[0].env.filter((k) => SESSION_VAR.test(k))).toEqual([]);

    // Already live: nothing changes, the same id comes back.
    expect(await act(e, 'start', 'alpha')).toMatchObject({
      ok: true,
      bgId: r1.bgId,
      note: '이미 켜져 있어요',
    });
    expect(bgCalls()).toHaveLength(1);
    expect(readLiveSessions(home).filter((s) => s.kind === 'background')).toHaveLength(1);

    // stop: the exact id, wantRunning off, the conversation id kept.
    expect(await act(e, 'stop', 'alpha')).toEqual(
      expect.objectContaining({ ok: true, action: 'stop', name: 'alpha' }),
    );
    expect(engineCalls(home).at(-1)!.argv).toEqual(['stop', r1.bgId]);
    expect(project(e, 'alpha')).toMatchObject({ live: false, wantRunning: false, sessionId: sid });
    expect(await act(e, 'stop', 'alpha')).toMatchObject({ ok: true, note: '이미 꺼져 있어요' });

    // No transcript yet (nothing was said): a fresh conversation, and it says so.
    expect(await act(e, 'start', 'alpha')).toMatchObject({
      ok: true,
      note: '이전 대화 기록이 없어 새 대화로 켰어요',
    });
    expect(bgCalls().at(-1)!.argv).toEqual(['--bg', '-n', 'alpha', '--model', 'm-1']);
    const sid2 = project(e, 'alpha')!.sessionId!;
    expect(sid2).not.toBe(sid);

    // With a transcript: restart stops, waits, and wakes the same job with --resume alone.
    transcript(f, sid2);
    const r2 = await act(e, 'restart', 'alpha');
    expect(r2).toMatchObject({ ok: true, bgId: sid2.slice(0, 8) });
    expect(r2.note).toBeUndefined();
    expect(
      engineCalls(home)
        .slice(-2)
        .map((c) => c.argv),
    ).toEqual([
      ['stop', sid2.slice(0, 8)],
      ['--bg', '--resume', sid2],
    ]);
    expect(project(e, 'alpha')).toMatchObject({ live: true, sessionId: sid2, wantRunning: true });
  });

  it('a conversation whose job is gone resumes with its options; a copy is reported', async () => {
    const { boot, act, folder, project, transcript, fake, bgCalls } = setup();
    const e = boot();
    const f = folder('alpha');
    await act(e, 'add', 'alpha', { folder: f, effort: 'low' });
    await act(e, 'start', 'alpha');
    const sid = project(e, 'alpha')!.sessionId!;
    transcript(f, sid);
    await act(e, 'stop', 'alpha');
    fake(['rm', sid.slice(0, 8)]); // `claude rm`: the job goes, the conversation stays
    expect(await act(e, 'start', 'alpha')).toMatchObject({ ok: true, bgId: sid.slice(0, 8) });
    expect(bgCalls().at(-1)!.argv).toEqual([
      '--bg',
      '-n',
      'alpha',
      '--resume',
      sid,
      '--effort',
      'low',
    ]);
    expect(project(e, 'alpha')!.sessionId).toBe(sid);
  });

  it('an untrusted folder: Claude refuses, the project says why, nothing is answered for the user', async () => {
    const { boot, act, folder, project, bgCalls } = setup();
    const e = boot();
    const f = folder('alpha');
    fs.writeFileSync(path.join(f, '.fake-untrusted'), '');
    await act(e, 'add', 'alpha', { folder: f });
    expect(await act(e, 'start', 'alpha')).toMatchObject({ ok: false, error: TRUST_NEEDED });
    expect(project(e, 'alpha')).toMatchObject({
      live: false,
      needsTrust: true,
      wantRunning: false,
    });
    expect(bgCalls()).toHaveLength(1);
    fs.rmSync(path.join(f, '.fake-untrusted')); // the user ran claude there and trusted it
    expect(await act(e, 'start', 'alpha')).toMatchObject({ ok: true });
    expect(project(e, 'alpha')!.needsTrust).toBeUndefined();
  });

  it('a conversation open in a terminal is never started, stopped or restarted', async () => {
    const { home, boot, act, folder, bgCalls } = setup();
    const f = folder('alpha');
    const sid = '11111111-2222-4333-8444-555555555555';
    saveRegistry(registryPath(home), [
      { name: 'alpha', folder: f, wantRunning: true, sessionId: sid },
    ]);
    const pid = liveProcess();
    fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(home, `.claude/sessions/${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: sid,
        cwd: f,
        kind: 'interactive',
        name: 'alpha',
        procStart: procStart(pid),
      }),
    );
    const e = boot(); // revive finds it live
    await waitFor(() => expect(e.state().projects[0].live).toBe(true));
    expect(e.state().projects[0].bgId).toBeUndefined();
    expect(await act(e, 'start', 'alpha')).toMatchObject({
      ok: true,
      note: '이 대화는 이미 터미널에서 열려 있어요',
    });
    expect((await act(e, 'stop', 'alpha')).error).toBe(
      '터미널에서 열린 대화는 여기서 끌 수 없어요',
    );
    expect((await act(e, 'restart', 'alpha')).error).toBe(
      '터미널에서 열린 대화는 여기서 다시 켤 수 없어요',
    );
    expect(bgCalls()).toEqual([]);
    expect(engineCalls(home).filter((c) => c.argv[0] === 'stop')).toEqual([]);
  });

  it('liveness is a live pid: what a reboot leaves behind does not count', async () => {
    const { home, boot, act, folder, project, fake } = setup();
    const e = boot();
    const f = folder('alpha');
    await act(e, 'add', 'alpha', { folder: f });
    const { bgId } = await act(e, 'start', 'alpha');
    killFakeSessions(home); // the reboot: session files and the job stay, the pids are gone
    await waitFor(() => {
      e.refresh();
      expect(project(e, 'alpha')!.live).toBe(false);
    });
    expect(fs.readdirSync(path.join(home, '.claude/sessions'))).toHaveLength(1);
    // `claude agents --json` still lists it, without a pid.
    const rows = JSON.parse(fake(['agents', '--json']).stdout) as Array<Record<string, unknown>>;
    expect(rows).toEqual([expect.objectContaining({ id: bgId, kind: 'background' })]);
    expect(rows[0].pid).toBeUndefined();
    // A pid that is alive but started at another time is not the session either.
    const pid = liveProcess();
    fs.writeFileSync(
      path.join(home, `.claude/sessions/${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: project(e, 'alpha')!.sessionId,
        cwd: f,
        kind: 'bg',
        name: 'alpha',
        jobId: bgId,
        procStart: '1',
      }),
    );
    e.refresh();
    expect(project(e, 'alpha')!.live).toBe(false);
  });

  it('revive after a reboot: what was on comes back, one at a time; what was off stays off', async () => {
    const { home, boot, act, folder, project, transcript, logs, bgCalls } = setup();
    const e1 = boot();
    for (const n of ['alpha', 'beta', 'gamma']) await act(e1, 'add', n, { folder: folder(n) });
    await act(e1, 'start', 'alpha');
    await act(e1, 'start', 'gamma');
    const sids = {
      alpha: project(e1, 'alpha')!.sessionId!,
      gamma: project(e1, 'gamma')!.sessionId!,
    };
    transcript(folder('alpha'), sids.alpha);
    transcript(folder('gamma'), sids.gamma);
    e1.dispose();
    killFakeSessions(home); // reboot
    await waitFor(() => expect(readLiveSessions(home)).toEqual([]));
    const before = bgCalls().length;

    const e2 = boot();
    await waitFor(() => {
      expect(project(e2, 'alpha')!.live).toBe(true);
      expect(project(e2, 'gamma')!.live).toBe(true);
    });
    // A session is live as soon as its file shows; the revive logs its line when it has noticed that.
    await waitFor(() => expect(logs.filter((l) => l.includes('revive'))).toHaveLength(2));
    const revived = bgCalls().slice(before);
    expect(revived.map((c) => c.argv)).toEqual([
      ['--bg', '--resume', sids.alpha],
      ['--bg', '--resume', sids.gamma],
    ]);
    expect(revived[1].t - revived[0].t).toBeGreaterThanOrEqual(FAST.reviveGapMs);
    expect(project(e2, 'beta')!.live).toBe(false);
    expect(project(e2, 'alpha')!.sessionId).toBe(sids.alpha);
    expect(logs.filter((l) => l.includes('revive'))).toEqual([
      `[cld engine] revive "alpha": ok bg=${sids.alpha.slice(0, 8)}`,
      `[cld engine] revive "gamma": ok bg=${sids.gamma.slice(0, 8)}`,
    ]);
  });

  it('gates: read-only daemon, unprivileged client, unknown project, one action per project', async () => {
    const ro = setup({ readOnly: true });
    const r = ro.boot();
    expect((await ro.act(r, 'add', 'alpha', { folder: ro.folder('a') })).error).toBe(
      '읽기 전용 모드라 조작할 수 없어요',
    );
    expect(fs.existsSync(registryPath(ro.home))).toBe(false);

    const { boot, act, folder, logs, bgCalls } = setup();
    const e = boot();
    expect((await act(e, 'add', 'alpha', { folder: folder('a') }, false)).error).toBe(
      '이 접속에는 조작 권한이 없어요',
    );
    expect((await act(e, 'start', 'nope')).error).toBe('모르는 프로젝트예요');
    await act(e, 'add', 'alpha', { folder: folder('a') });
    const [a, b] = await Promise.all([act(e, 'start', 'alpha'), act(e, 'start', 'alpha')]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, error: 'alpha: 이미 다른 조작이 진행 중이에요' });
    expect(bgCalls()).toHaveLength(1);
    // One line per action, with the device.
    expect(logs.filter((l) => l.includes(' action '))).toEqual([
      '[cld engine] action add "alpha" gui:linux: refused (이 접속에는 조작 권한이 없어요)',
      '[cld engine] action start "nope" gui:linux: refused (모르는 프로젝트예요)',
      expect.stringMatching(/^\[cld engine\] action add "alpha" gui:linux: ok \d+\.\ds$/),
      '[cld engine] action start "alpha" gui:linux: refused (alpha: 이미 다른 조작이 진행 중이에요)',
      expect.stringMatching(
        /^\[cld engine\] action start "alpha" gui:linux: ok bg=[0-9a-f]{8} \d+\.\ds$/,
      ),
    ]);
  });

  it('a live session with the name: suffixed " (2)" in the folder is ours, elsewhere a refusal', async () => {
    const { boot, act, folder, project, fake, bgCalls } = setup();
    const e = boot();
    const f = folder('alpha');
    await act(e, 'add', 'alpha', { folder: f });
    // Started by hand elsewhere under the same name: no second "alpha".
    const other = printedId(fake(['--bg', '-n', 'alpha'], folder('elsewhere')).stdout);
    expect(await act(e, 'start', 'alpha')).toMatchObject({
      ok: false,
      bgId: other,
      error: '같은 이름의 백그라운드 세션이 다른 폴더에서 켜져 있어요',
    });
    expect(bgCalls()).toHaveLength(1); // only the hand-started one
    // In its folder Claude names it "alpha (2)": that one is the project's.
    const mine = printedId(fake(['--bg', '-n', 'alpha'], f).stdout);
    e.refresh();
    expect(project(e, 'alpha')).toMatchObject({ live: true, bgId: mine });
    expect(project(e, 'alpha')!.sessionId!.startsWith(mine!)).toBe(true);
  });

  it('remove stops the session and keeps the conversation; edit rules', async () => {
    const { home, boot, act, folder, project, transcript } = setup();
    const e = boot();
    const f = folder('alpha');
    await act(e, 'add', 'alpha', { folder: f, model: 'm-1', room: 'Lab' });
    const { bgId } = await act(e, 'start', 'alpha');
    transcript(f, project(e, 'alpha')!.sessionId!);
    // edit: no folder change while live; '' clears; a launch option applies later.
    expect((await act(e, 'edit', 'alpha', { folder: folder('beta') })).error).toBe(
      '켜져 있는 동안에는 폴더를 바꿀 수 없어요',
    );
    expect(await act(e, 'edit', 'alpha', { model: '', room: '' })).toMatchObject({
      ok: true,
      note: '바꾼 실행 옵션은 새 대화부터 적용돼요',
    });
    expect(project(e, 'alpha')).toMatchObject({ room: 'alpha' });
    expect(project(e, 'alpha')!.model).toBeUndefined();
    expect(await act(e, 'remove', 'alpha')).toMatchObject({ ok: true, note: '대화 기록은 남아요' });
    expect(engineCalls(home).at(-1)!.argv).toEqual(['stop', bgId]);
    expect(e.state().projects).toEqual([]);
    expect(readLiveSessions(home)).toEqual([]);
    expect(fs.existsSync(path.join(home, '.claude/jobs', bgId!, 'state.json'))).toBe(true);
  });

  it('a Claude daemon carrying session variables is reported, never their values', async () => {
    if (process.platform !== 'linux') return;
    const { home, boot } = setup();
    const pid = liveProcess({
      PATH: process.env.PATH,
      ...DIRTY,
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude/daemon.lock'),
      JSON.stringify({ pid, procStart: procStart(pid) }),
    );
    const e = boot();
    const [w] = e.state().warnings ?? [];
    expect(w).toContain(`pid ${pid}`);
    expect(w).toContain(
      'CLAUDECODE, CLAUDE_CODE_MESSAGING_TOKEN, CLAUDE_EFFORT, CLAUDE_PID, TMUX',
    );
    expect(w).not.toContain('secret');
  });

  it('apply(): one entry per project in its room; its conversation’s rows fold in', async () => {
    const { boot, act, folder } = setup();
    const e = boot();
    const f = folder('alpha');
    await act(e, 'add', 'alpha', { folder: f, room: 'Lab' });
    await act(e, 'add', 'beta', { folder: folder('beta') });
    const { bgId } = await act(e, 'start', 'alpha');
    const sid = e.state().projects[0].sessionId!;
    const row = (
      key: string,
      name: string,
      dir: string,
      sessionId: string,
      extra: Partial<AgentEntry> = {},
    ): AgentEntry => ({
      ...ENTRY_DEFAULTS,
      key,
      name,
      dir,
      tab: path.basename(dir),
      order: 1,
      state: 'running',
      busy: true,
      pid: null,
      sessionId,
      remoteControl: { on: false, url: null },
      transcript: `/t/${sessionId}.jsonl`,
      ...extra,
    });
    const world: World = {
      rooms: [
        { name: 'alpha', kind: 'orch', order: 1 },
        { name: 'other', kind: 'orch', order: 2 },
      ],
      agents: [
        row('name:alpha', 'alpha', f, sid, {
          bg: { id: bgId!, state: 'working', sessionId: sid, started: null },
        }),
        row('name:x', 'x', '/w/other', 'zzz'),
      ],
    };
    const out = e.apply(world);
    expect(out.agents.map((a) => a.key)).toEqual(['name:x', 'engine:alpha', 'engine:beta']);
    expect(out.rooms.map((r) => [r.name, r.order])).toEqual([
      ['other', 1],
      ['Lab', 2],
      ['beta', 3],
    ]);
    const [, alpha, beta] = out.agents;
    expect(alpha).toMatchObject({
      tab: 'Lab',
      state: 'running',
      busy: false, // the session file says idle (T-0043): it wins over the row's busy
      bg: { id: bgId, state: 'working', sessionId: sid },
      transcript: `/t/${sid}.jsonl`,
    });
    expect(beta).toMatchObject({
      tab: 'beta',
      state: 'off',
      busy: null,
      bg: null,
      transcript: null,
    });
  });
});

describe('apply(): the 관리실', () => {
  it('a project whose room is the 관리실 makes it an ops room', async () => {
    const { boot, act, folder } = setup();
    const e = boot();
    await act(e, 'add', 'ops-desk', { folder: folder('ops'), room: '관리실' });
    await act(e, 'add', 'plain', { folder: folder('plain') });
    const out = e.apply({ rooms: [], agents: [] });
    expect(out.agents.map((a) => [a.key, a.tab])).toEqual([
      ['engine:ops-desk', '관리실'],
      ['engine:plain', 'plain'],
    ]);
    expect(out.rooms.map((r) => [r.name, r.kind])).toEqual([
      ['관리실', 'ops'],
      ['plain', 'orch'],
    ]);
  });
});

describe('apply(): busy with background work only', () => {
  const PROMPT = JSON.stringify({ type: 'user', message: { content: '배포해 줘' } });
  const TOOL = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
  });
  const END = JSON.stringify({ type: 'system', subtype: 'turn_duration' });

  it('a busy session whose main turn ended rests; a running turn works; no transcript keeps busy', async () => {
    const { home, boot, act, folder } = setup();
    const e = boot();
    await act(e, 'add', 'alpha', { folder: folder('alpha') });
    const { bgId } = await act(e, 'start', 'alpha');
    const sessDir = path.join(home, '.claude/sessions');
    const file = fs
      .readdirSync(sessDir)
      .map((f) => path.join(sessDir, f))
      .find((f) => (JSON.parse(fs.readFileSync(f, 'utf-8')) as { jobId?: string }).jobId === bgId)!;
    const sess = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...sess, status: 'busy' })); // a background task runs
    const transcript = path.join(home, 't.jsonl');
    const busyOf = () => {
      const row: AgentEntry = {
        ...ENTRY_DEFAULTS,
        key: 'name:alpha',
        name: 'alpha',
        dir: folder('alpha'),
        tab: 'alpha',
        order: 1,
        state: 'running',
        busy: true,
        pid: null,
        sessionId: e.state().projects[0].sessionId!,
        remoteControl: { on: false, url: null },
        transcript,
      };
      const world: World = {
        rooms: [],
        agents: [row],
      };
      return e.apply(world).agents.find((a) => a.key === 'engine:alpha')!.busy;
    };
    await waitFor(() => expect(e.sessionOf('alpha')).toMatchObject({ status: 'busy' }));
    expect(busyOf()).toBe(true); // no transcript to say otherwise
    fs.writeFileSync(transcript, [PROMPT, TOOL].join('\n') + '\n');
    expect(busyOf()).toBe(true); // its turn is running
    fs.appendFileSync(transcript, `${END}\n`);
    expect(busyOf()).toBe(false); // the turn ended; only the background task runs
    fs.appendFileSync(transcript, `${PROMPT}\n`);
    expect(busyOf()).toBe(true); // a new prompt: working again
  });
});

describe('engine E2 (T-0019): events, start hook, revive notice, renew, compaction nudge', () => {
  /** An engine whose hooks are recorded. */
  function rig(projects?: ProjectRecord[], timing: Partial<EngineOptions['timing']> = {}) {
    const events: Array<{ type: string; source: string } & Record<string, unknown>> = [];
    const inbox: Array<{ name: string; text: string }> = [];
    const started: string[] = [];
    const nudges: Array<[string, number, number]> = [];
    const s = setup({
      projects,
      extra: {
        timing: { ...FAST, renewPollMs: 20, ...timing },
        event: (type, source, fields) => events.push({ type, source, ...fields }),
        started: (name) => started.push(name),
        writeInbox: (name, text) => (inbox.push({ name, text }), true),
        nudge: (name, n, fillPct) => nudges.push([name, n, fillPct]),
      },
    });
    return { ...s, events, inbox, started, nudges };
  }
  /** The fake's session file for a live job: status set by hand (a turn running). */
  function setStatus(home: string, id: string, status: string) {
    const dir = path.join(home, '.claude', 'sessions');
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      const j = JSON.parse(fs.readFileSync(file, 'utf-8')) as { jobId?: string };
      if (j.jobId === id) fs.writeFileSync(file, JSON.stringify({ ...j, status }));
    }
  }

  it('orch_start (with source) and the start hook; orch_exit when the session goes', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const sid = r.project(e, 'alpha')!.sessionId;
    expect(r.started).toEqual(['alpha']);
    expect(r.events).toEqual([
      {
        type: 'orch_start',
        source: 'gui:linux',
        name: 'alpha',
        session_id: sid,
        resumed: false,
        remote_control: false,
        by: 'person', // TOKEN-GUARD provenance
      },
    ]);
    await r.act(e, 'stop', 'alpha');
    expect(r.events.at(-1)).toEqual({
      type: 'orch_exit',
      source: 'engine',
      name: 'alpha',
      code: null,
    });
  });

  it('revive puts the reason into the inbox before it starts (reboot, or only cld-gui restarted)', async () => {
    const r = rig();
    const e1 = r.boot();
    await r.act(e1, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e1, 'start', 'alpha');
    e1.dispose();
    killFakeSessions(r.home);
    await waitFor(() => expect(readLiveSessions(r.home)).toEqual([]));
    const e2 = r.boot(); // same boot: cld-gui restarted
    await waitFor(() => expect(r.project(e2, 'alpha')!.live).toBe(true));
    // Live as soon as the session file shows; the revive's own record follows once it has noticed that.
    await waitFor(() => expect(r.started).toEqual(['alpha', 'alpha']));
    expect(r.inbox).toEqual([
      {
        name: 'alpha',
        text: expect.stringMatching(
          /^\[cld-gui 자동 복구 · \d\d-\d\d \d\d:\d\d\] cld-gui가 다시 뜰 때/,
        ),
      },
    ]);
    expect(r.inbox[0].text).toContain('하던 일을 확인하고 이어서 해 달라');
    expect(r.started).toEqual(['alpha', 'alpha']);
    expect(r.events.filter((x) => x.type === 'orch_start').map((x) => x.source)).toEqual([
      'gui:linux',
      'revive',
    ]);
    // Another boot id: a reboot.
    e2.dispose();
    killFakeSessions(r.home);
    await waitFor(() => expect(readLiveSessions(r.home)).toEqual([]));
    fs.writeFileSync(path.join(r.home, '.config/agent-tycoon/engine.boot'), 'another-boot\n');
    const e3 = r.boot();
    await waitFor(() => expect(r.project(e3, 'alpha')!.live).toBe(true));
    expect(r.inbox[1].text).toContain('컴퓨터가 다시 켜져서');
  });

  it('renew: waits for the turn, handoff to the inbox, old stopped and gone BEFORE the new start (no " (2)")', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const old = r.project(e, 'alpha')!;
    setStatus(r.home, old.bgId!, 'busy'); // the orchestrator's turn is still running
    expect(e.renew('alpha', 'HANDOFF', 'cli')).toEqual({ ok: true });
    expect(e.renew('alpha', 'again', 'cli')).toMatchObject({ ok: false, code: 'renew_pending' });
    expect(e.renewing('alpha')).toBe(true);
    // Engine actions wait too (a stop cancels it instead: TOKEN-GUARD S-02, its own test).
    expect(await r.act(e, 'restart', 'alpha')).toMatchObject({ ok: false });
    await new Promise((res) => setTimeout(res, 150));
    expect(r.inbox).toEqual([]); // nothing while busy
    setStatus(r.home, old.bgId!, 'idle'); // the turn ends
    await waitFor(
      () => expect(r.events.some((x) => x.type === 'orch_renew')).toBe(true),
    );
    const now = r.project(e, 'alpha')!;
    expect(now.sessionId).not.toBe(old.sessionId);
    expect(r.inbox).toEqual([{ name: 'alpha', text: 'HANDOFF' }]);
    const calls = engineCalls(r.home).map((c) => c.argv.join(' '));
    const stopAt = calls.indexOf(`stop ${old.bgId}`);
    const startAt = calls.lastIndexOf('--bg -n alpha');
    expect(stopAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(stopAt); // stopped first, then a new conversation without --resume
    expect(calls.filter((c) => c.includes('--resume'))).toEqual([]);
    const live = readLiveSessions(r.home).filter((x) => x.kind === 'background');
    expect(live.map((x) => x.name)).toEqual(['alpha']); // not "alpha (2)"
    expect(r.events.find((x) => x.type === 'orch_renew')).toEqual({
      type: 'orch_renew',
      source: 'cli',
      name: 'alpha',
      old_session_id: old.sessionId,
      session_id: now.sessionId,
      ok: true,
    });
    expect(r.started).toEqual(['alpha', 'alpha']); // the inbox goes in after the new start
    expect(e.renewing('alpha')).toBe(false);
  });

  it('renew whose new start fails: the handoff stays in the inbox, the old conversation stays resumable', async () => {
    const r = rig();
    const e = r.boot();
    const dir = r.folder('alpha');
    await r.act(e, 'add', 'alpha', { folder: dir });
    await r.act(e, 'start', 'alpha');
    const old = r.project(e, 'alpha')!;
    fs.writeFileSync(path.join(dir, '.fake-untrusted'), ''); // Claude will refuse the new start
    expect(e.renew('alpha', 'HANDOFF', 'cli')).toEqual({ ok: true });
    await waitFor(
      () => expect(r.events.some((x) => x.type === 'orch_renew')).toBe(true),
    );
    expect(r.events.find((x) => x.type === 'orch_renew')).toMatchObject({
      ok: false,
      code: 'start_failed',
      old_session_id: old.sessionId,
      session_id: null,
    });
    expect(r.inbox).toEqual([{ name: 'alpha', text: 'HANDOFF' }]);
    expect(r.project(e, 'alpha')!.sessionId).toBe(old.sessionId);
    expect(r.project(e, 'alpha')!.live).toBe(false);
    // Over: the record goes (the handoff is in the inbox).
    expect(fs.readdirSync(renewals(r.home))).toEqual([]);
  });

  /** RENEW-STUCK: where pending renewals are kept. */
  const renewals = (home: string) => path.join(home, '.config/agent-tycoon/renewals');

  it('renew survives a daemon restart: the new daemon resumes it, handoff once, record gone', async () => {
    const r = rig();
    const e1 = r.boot();
    await r.act(e1, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e1, 'start', 'alpha');
    const old = r.project(e1, 'alpha')!;
    setStatus(r.home, old.bgId!, 'busy');
    expect(e1.renew('alpha', 'HANDOFF', 'cli')).toEqual({ ok: true });
    const rec = path.join(renewals(r.home), 'alpha.json');
    expect(JSON.parse(fs.readFileSync(rec, 'utf-8'))).toMatchObject({
      name: 'alpha',
      message: 'HANDOFF',
      source: 'cli',
    });
    expect((fs.statSync(rec).mode & 0o777).toString(8)).toBe('600');
    e1.dispose(); // the deploy restarts the daemon; the session lives on
    const e2 = r.boot();
    expect(e2.renewing('alpha')).toBe(true);
    expect(e2.renewPending('alpha')).toBe(true);
    await new Promise((res) => setTimeout(res, 150));
    expect(r.inbox).toEqual([]); // still waits for the turn
    setStatus(r.home, old.bgId!, 'idle');
    await waitFor(() => expect(r.events.some((x) => x.type === 'orch_renew')).toBe(true));
    expect(r.events.find((x) => x.type === 'orch_renew')).toMatchObject({ ok: true, source: 'cli' });
    expect(r.project(e2, 'alpha')!.sessionId).not.toBe(old.sessionId);
    expect(r.inbox).toEqual([{ name: 'alpha', text: 'HANDOFF' }]);
    expect(fs.readdirSync(renewals(r.home))).toEqual([]);
    expect(e2.renewing('alpha')).toBe(false);
  });

  it('TOKEN-GUARD (S-02): 멈추기 during a pending renewal cancels it: no new conversation, none after a restart', async () => {
    const r = rig();
    const e1 = r.boot();
    await r.act(e1, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e1, 'start', 'alpha');
    const old = r.project(e1, 'alpha')!;
    setStatus(r.home, old.bgId!, 'busy');
    expect(e1.renew('alpha', 'HANDOFF', 'cli')).toEqual({ ok: true });
    const starts = r.bgCalls().length;
    const out = await r.act(e1, 'stop', 'alpha');
    expect(out.ok).toBe(true);
    await waitFor(() => expect(e1.renewing('alpha')).toBe(false));
    expect(r.events.find((x) => x.type === 'orch_renew')).toMatchObject({ ok: false, code: 'cancelled' });
    expect(r.project(e1, 'alpha')).toMatchObject({ live: false, wantRunning: false });
    expect(fs.readdirSync(renewals(r.home)).filter((f) => f.endsWith('.json'))).toEqual([]);
    e1.dispose();
    const e2 = r.boot(); // a restart resumes nothing
    await new Promise((res) => setTimeout(res, 300));
    expect(e2.renewing('alpha')).toBe(false);
    expect(r.bgCalls()).toHaveLength(starts);
    expect(r.inbox).toEqual([]);
  });

  it("renew proceeds on 'shell' (turn over, a background shell still alive)", async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const old = r.project(e, 'alpha')!;
    setStatus(r.home, old.bgId!, 'shell');
    expect(e.renew('alpha', 'HANDOFF', 'cli')).toEqual({ ok: true });
    await waitFor(() => expect(r.events.some((x) => x.type === 'orch_renew')).toBe(true));
    expect(r.events.find((x) => x.type === 'orch_renew')).toMatchObject({ ok: true });
    expect(r.logs).toContain('[cld engine] renew "alpha": turn over (status shell)');
    expect(r.inbox).toEqual([{ name: 'alpha', text: 'HANDOFF' }]);
  });

  it("renew on 'busy' waits until its timeout, then fails: record cleared, the handoff kept", async () => {
    // 2 s: the 200 ms "still waiting" check must not race the timeout on a loaded machine.
    const r = rig(undefined, { renewWaitMs: 2000 });
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const old = r.project(e, 'alpha')!;
    setStatus(r.home, old.bgId!, 'busy');
    expect(e.renew('alpha', 'HANDOFF', 'cli')).toEqual({ ok: true });
    await new Promise((res) => setTimeout(res, 200));
    expect(e.renewing('alpha')).toBe(true); // still waiting
    await waitFor(() => expect(r.events.some((x) => x.type === 'orch_renew')).toBe(true));
    expect(r.events.find((x) => x.type === 'orch_renew')).toMatchObject({
      ok: false,
      code: 'not_idle',
    });
    expect(r.inbox).toEqual([]);
    expect(r.project(e, 'alpha')!.sessionId).toBe(old.sessionId); // untouched
    expect(fs.readdirSync(renewals(r.home))).toEqual(['alpha.json.failed']);
    expect(
      JSON.parse(fs.readFileSync(path.join(renewals(r.home), 'alpha.json.failed'), 'utf-8')),
    ).toMatchObject({ message: 'HANDOFF' });
    expect(e.renewing('alpha')).toBe(false);
    // A restart does not resume a renewal that is over.
    e.dispose();
    const e2 = r.boot();
    expect(e2.renewing('alpha')).toBe(false);
  });

  it('renew of an unknown project or one in a terminal', async () => {
    const r = rig();
    const e = r.boot();
    expect(e.renew('ghost', '', 'cli')).toMatchObject({ ok: false, code: 'unknown_project' });
  });

  it('compaction nudge: after N boundaries, waits for an 85% refill once per conversation', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha'), compactionNudge: 2 } as never);
    await r.act(e, 'add', 'beta', { folder: r.folder('beta') });
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'start', 'beta');
    expect(r.project(e, 'alpha')).toMatchObject({ compactionNudge: 2 });
    const t = (name: string) =>
      transcriptPath(r.folder(name), r.project(e, name)!.sessionId!, r.home);
    const mark = '{"type":"system","subtype":"compact_boundary"}\n';
    const usage = (tokens: number) =>
      `${JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: tokens } },
      })}\n`;
    for (const n of ['alpha', 'beta']) {
      fs.mkdirSync(path.dirname(t(n)), { recursive: true });
      fs.writeFileSync(t(n), `{}\n${mark}`); // one compaction before the engine looked
    }
    e.refresh();
    expect(r.nudges).toEqual([]);
    // beta is intentionally not opted in: checkCompactions skips it before
    // opening or tail-reading its transcript.
    fs.appendFileSync(t('alpha'), mark);
    e.refresh();
    // Negative control: the former count >= N rule would nudge here.
    expect(r.nudges).toEqual([]);
    expect(r.events.filter((x) => x.type === 'compacted')).toEqual([
      { type: 'compacted', source: 'engine', name: 'alpha', count: 2 },
    ]);
    // The office row carries the same count, so the stat's 압축 N/M agrees with the board (10-22 18:26).
    const counts = () =>
      Object.fromEntries(
        e.apply({ rooms: [], agents: [] }).agents.map((a) => [a.name, a.compactions]),
      );
    expect(counts()).toEqual({ alpha: 2, beta: 0 });
    fs.appendFileSync(t('alpha'), usage(100));
    e.refresh();
    expect(r.nudges).toEqual([]);
    fs.appendFileSync(t('alpha'), usage(850_000));
    e.refresh();
    expect(r.nudges).toEqual([['alpha', 2, 85]]);
    fs.appendFileSync(t('alpha'), usage(900_000));
    e.refresh();
    expect(r.nudges).toEqual([['alpha', 2, 85]]); // only one per session

    // renew starts a new conversation, whose counter and one-shot nudge reset.
    const old = r.project(e, 'alpha')!.sessionId;
    expect(e.renew('alpha', 'HANDOFF', 'test')).toEqual({ ok: true });
    await waitFor(() => expect(r.project(e, 'alpha')!.sessionId).not.toBe(old));
    fs.writeFileSync(t('alpha'), `{}\n${mark}`);
    e.refresh();
    fs.appendFileSync(t('alpha'), mark);
    e.refresh();
    expect(r.nudges).toEqual([['alpha', 2, 85]]);
    fs.appendFileSync(t('alpha'), usage(850_000));
    e.refresh();
    expect(r.nudges).toEqual([
      ['alpha', 2, 85],
      ['alpha', 2, 85],
    ]);
  });

  it('compaction nudge: the fill from before the Mth boundary, or a sub-agent, is not a refill', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha'), compactionNudge: 2 } as never);
    await r.act(e, 'start', 'alpha');
    const transcript = transcriptPath(r.folder('alpha'), r.project(e, 'alpha')!.sessionId!, r.home);
    const mark = '{"type":"system","subtype":"compact_boundary"}\n';
    const usage = (tokens: number, sidechain = false) =>
      `${JSON.stringify({
        type: 'assistant',
        ...(sidechain && { isSidechain: true }),
        message: { model: 'claude-opus-4-8', usage: { input_tokens: tokens } },
      })}\n`;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `{}\n${mark}`);
    e.refresh();
    fs.appendFileSync(transcript, `${usage(950_000)}${mark}`); // full, then the Mth compaction
    e.refresh();
    // The summary lands before the next turn: the newest usage is still the full one.
    fs.appendFileSync(transcript, '{"type":"user","message":{"content":"summary"}}\n');
    e.refresh();
    expect(r.nudges).toEqual([]);
    fs.appendFileSync(transcript, usage(100_000)); // the main chain, after the compaction
    fs.appendFileSync(transcript, usage(950_000, true)); // a sub-agent's turn
    e.refresh();
    expect(r.nudges).toEqual([]);
    // No model named: no window, so no fill.
    fs.appendFileSync(
      transcript,
      '{"type":"assistant","message":{"usage":{"input_tokens":950000}}}\n',
    );
    e.refresh();
    expect(r.nudges).toEqual([]);
    fs.appendFileSync(transcript, usage(870_000));
    e.refresh();
    expect(r.nudges).toEqual([['alpha', 2, 87]]);
  });

  it('compaction nudge: a daemon restart does not nudge again a conversation already refilled', async () => {
    const r = rig();
    const e1 = r.boot();
    await r.act(e1, 'add', 'alpha', { folder: r.folder('alpha'), compactionNudge: 2 } as never);
    await r.act(e1, 'start', 'alpha');
    const transcript = transcriptPath(
      r.folder('alpha'),
      r.project(e1, 'alpha')!.sessionId!,
      r.home,
    );
    const mark = '{"type":"system","subtype":"compact_boundary"}\n';
    const usage = (tokens: number) =>
      `${JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: tokens } },
      })}\n`;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `{}\n${mark}${mark}`);
    e1.refresh();
    fs.appendFileSync(transcript, usage(900_000));
    e1.refresh();
    expect(r.nudges).toEqual([['alpha', 2, 90]]);
    e1.dispose(); // the daemon restarts; the session keeps running (writing its handoff)

    const e2 = r.boot();
    await waitFor(() => expect(r.project(e2, 'alpha')!.live).toBe(true));
    e2.refresh();
    fs.appendFileSync(transcript, usage(910_000));
    e2.refresh();
    expect(r.nudges).toEqual([['alpha', 2, 90]]);
    // It compacted anyway: the fallback still reminds it.
    fs.appendFileSync(transcript, mark);
    e2.refresh();
    expect(r.nudges).toEqual([
      ['alpha', 2, 90],
      ['alpha', 3, 85],
    ]);
  });

  it('compaction nudge falls back at the next boundary when the refill was missed', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha'), compactionNudge: 2 } as never);
    await r.act(e, 'start', 'alpha');
    const transcript = transcriptPath(r.folder('alpha'), r.project(e, 'alpha')!.sessionId!, r.home);
    const mark = '{"type":"system","subtype":"compact_boundary"}\n';
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `{}\n${mark}`);
    e.refresh(); // baseline: pre-existing compaction is never a nudge
    fs.appendFileSync(transcript, mark);
    e.refresh(); // Mth boundary leaves an empty context
    expect(r.nudges).toEqual([]);
    // The daemon did not refresh while the context was full; its next boundary
    // must replace a fourth compaction with the renew reminder.
    fs.appendFileSync(transcript, mark);
    e.refresh();
    expect(r.nudges).toEqual([['alpha', 3, 85]]);
    // 0 turns it off.
    expect(await r.act(e, 'edit', 'alpha', { compactionNudge: 0 } as never)).toMatchObject({
      ok: true,
    });
    expect(r.project(e, 'alpha')!.compactionNudge).toBeUndefined();
  });
});

describe('engine watch (T-0091): a wantRunning session that dies while the daemon runs comes back', () => {
  const WATCH = { ...FAST, watchMs: 100, adoptMs: 500 };
  const WAIT = { timeout: 30_000, interval: 25 };
  /** An engine that watches; hooks recorded; a clock tests can move. */
  function rig(timing: Partial<typeof WATCH> = WATCH) {
    const inbox: Array<{ name: string; text: string }> = [];
    const events: Array<Record<string, unknown>> = [];
    const clock = { t: Date.now() };
    const s = setup({
      extra: {
        timing,
        now: () => clock.t,
        writeInbox: (name, text) => (inbox.push({ name, text }), true),
        event: (type, source, fields) => events.push({ type, source, ...fields }),
      },
    });
    return { ...s, inbox, events, clock };
  }
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('adopts a Claude daemon respawn of the same background session without reviving it', async () => {
    // The replacement is written by this test after it spawns a process: the adoption window must not
    // close on a starved CPU while that happens (a revive would then win, which is another test).
    const r = rig({ ...WATCH, adoptMs: 10_000 });
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const sid = r.project(e, 'alpha')!.sessionId!;
    r.transcript(r.folder('alpha'), sid);
    const [oldFile] = fs.readdirSync(path.join(r.home, '.claude', 'sessions'));
    const old = JSON.parse(
      fs.readFileSync(path.join(r.home, '.claude', 'sessions', oldFile), 'utf-8'),
    ) as Record<string, unknown>;
    const starts = r.bgCalls().length;
    const events = r.events.length;

    killFakeSessions(r.home);
    await pause(150); // the watcher sees the old pid gone before Claude's replacement appears
    const pid = liveProcess({ ...process.env, HOME: r.home });
    fs.writeFileSync(
      path.join(r.home, '.claude', 'sessions', `${pid}.json`),
      JSON.stringify({ ...old, pid, procStart: procStart(pid) }),
    );

    await waitFor(() => {
      expect(r.project(e, 'alpha')).toMatchObject({ live: true, sessionId: sid });
    }, WAIT);
    // The session shows as live from its file; the adoption's own event follows when the engine has matched it.
    await waitFor(() => expect(r.events.length).toBeGreaterThan(events), WAIT);
    expect(r.bgCalls()).toHaveLength(starts);
    expect(readLiveSessions(r.home).find((s) => s.sessionId === sid)?.pid).toBe(pid);
    expect(r.inbox).toEqual([]);
    expect(r.events.slice(events)).toEqual([
      {
        type: 'orch_start',
        source: 'engine',
        name: 'alpha',
        session_id: sid,
        resumed: true,
        remote_control: false,
      },
    ]);
  });

  it('negative control: a killed session with no replacement goes through the existing revive path', async () => {
    const r = rig({ ...WATCH, adoptMs: 100 });
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const sid = r.project(e, 'alpha')!.sessionId!;
    r.transcript(r.folder('alpha'), sid); // the conversation has a message: it resumes
    const before = r.bgCalls().length;
    killFakeSessions(r.home); // OOM kill / the claude daemon died: file and job stay, pid gone
    await waitFor(() => expect(r.bgCalls().length).toBeGreaterThan(before), WAIT);
    await waitFor(() => expect(r.project(e, 'alpha')!.live).toBe(true), WAIT);
    expect(
      r
        .bgCalls()
        .slice(before)
        .map((c) => c.argv),
    ).toEqual([['--bg', '--resume', sid]]);
    expect(r.inbox).toEqual([
      {
        name: 'alpha',
        text: expect.stringMatching(
          /^\[cld-gui 자동 복구 · [\d: -]+\] 같은 부팅에서 세션이 꺼져 다시 띄웠다/,
        ),
      },
    ]);
    await pause(400); // more checks, all alive
    expect(r.logs.filter((l) => l.includes('revive'))).toEqual([
      `[cld engine] revive "alpha": ok bg=${sid.slice(0, 8)}`,
    ]);
  });

  it('an idle retirement rests with no revive prompt; the next messenger message wakes and types directly', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const sid = r.project(e, 'alpha')!.sessionId!;
    fs.writeFileSync(
      path.join(r.home, '.claude', 'daemon.log'),
      `[2026-10-22T19:05:10Z] bg retire ${sid.slice(0, 8)}: idle-prompt, idle 8h\n`,
    );
    const before = r.bgCalls().length;
    killFakeSessions(r.home);
    await waitFor(
      () =>
        expect(r.project(e, 'alpha')).toMatchObject({
          live: false,
          downNote: 'Claude 가 오래 쉬어 내림 · 메시지가 오면 다시 켬',
        }),
      WAIT,
    );
    expect(r.bgCalls()).toHaveLength(before);
    expect(r.inbox).toEqual([]);

    const typed: string[] = [];
    const messenger = new Messenger({
      home: r.home,
      engine: e,
      typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed')) },
      events: new EngineEvents(eventsPath(r.home)),
      timing: { tickMs: 20, retryMs: 50, ifIdleMs: 10 * 60_000, quietMs: 5_000 },
    });
    messenger.start();
    cleanup.push(() => messenger.dispose());
    expect(
      await messenger.send({ to: 'alpha', text: 'continue from here', from: null, source: 'cli', ifIdle: false }),
    ).toMatchObject({ ok: true, delivered: 'pane' });
    expect(r.bgCalls()).toHaveLength(before + 1);
    await waitFor(() => expect(typed).toHaveLength(1));
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain('\ncontinue from here');
    expect(typed[0]).not.toContain('자동 복구');
    expect(r.inbox).toEqual([]);
  });

  it('an always-on idle retirement resumes without a prompt and does not consume revive attempts', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha'), alwaysOn: true });
    await r.act(e, 'start', 'alpha');
    const sid = r.project(e, 'alpha')!.sessionId!;
    r.transcript(r.folder('alpha'), sid);
    fs.writeFileSync(
      path.join(r.home, '.claude', 'daemon.log'),
      `[2026-10-22T19:05:10Z] bg retire ${sid.slice(0, 8)}: settled, idle 8h\n`,
    );
    const before = r.bgCalls().length;
    killFakeSessions(r.home);
    await waitFor(() => expect(r.bgCalls()).toHaveLength(before + 1), WAIT);
    await waitFor(() => expect(r.project(e, 'alpha')!.live).toBe(true), WAIT);
    expect(r.inbox).toEqual([]);
    expect(r.bgCalls().at(-1)).toMatchObject({ argv: ['--bg', '--resume', sid], stdin: '' });
    expect(r.project(e, 'alpha')!.downNote).toBeUndefined();
  });

  it('TOKEN-GUARD (S-04): an always-on session that keeps dying behind a stale idle-retire line is bounded', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha'), alwaysOn: true });
    await r.act(e, 'start', 'alpha');
    const sid = r.project(e, 'alpha')!.sessionId!;
    r.transcript(r.folder('alpha'), sid);
    fs.writeFileSync(
      path.join(r.home, '.claude', 'daemon.log'),
      `[2026-10-22T19:05:10Z] bg retire ${sid.slice(0, 8)}: settled, idle 8h\n`,
    );
    // Dies a minute after every resume: the old line still names the conversation.
    for (let i = 0; i < 12; i++) {
      if (r.project(e, 'alpha')!.live) killFakeSessions(r.home);
      r.clock.t += 60_000;
      await pause(1_200);
    }
    expect(r.bgCalls().length).toBeLessThanOrEqual(1 + 4);
    expect(r.project(e, 'alpha')!.downNote).toBeDefined();
    expect(r.inbox).toEqual([]); // these resumes carry no prompt either way
  });

  it('startup recognizes an idle-retire log and keeps the persisted resting project down after restart', async () => {
    const r = rig();
    const folder = r.folder('alpha');
    const sid = '377f7c98-aabb-4cdd-8eff-001122334455';
    saveRegistry(registryPath(r.home), [
      { name: 'alpha', folder, wantRunning: true, sessionId: sid, backgroundId: sid.slice(0, 8) },
    ]);
    fs.mkdirSync(path.join(r.home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(r.home, '.claude', 'daemon.log'),
      `[2026-10-22T19:05:10Z] bg retire ${sid.slice(0, 8)}: settled, idle 8h\n`,
    );
    const e = r.boot();
    await waitFor(
      () => expect(r.project(e, 'alpha')!.downNote).toBe('Claude 가 오래 쉬어 내림 · 메시지가 오면 다시 켬'),
      WAIT,
    );
    expect(r.bgCalls()).toEqual([]);
    e.dispose();
    const afterRestart = r.boot();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(r.project(afterRestart, 'alpha')!.downNote).toBe(
      'Claude 가 오래 쉬어 내림 · 메시지가 오면 다시 켬',
    );
    expect(r.bgCalls()).toEqual([]);
  });

  it('a check with everything alive spawns nothing', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const calls = engineCalls(r.home).length;
    await pause(600); // ~6 checks
    expect(engineCalls(r.home)).toHaveLength(calls);
    expect(r.logs.filter((l) => l.includes('watch') || l.includes('revive'))).toEqual([]);
  });

  it('a session the user stopped stays stopped; so does one that was never on', async () => {
    const r = rig();
    const e = r.boot();
    for (const n of ['alpha', 'beta']) await r.act(e, 'add', n, { folder: r.folder(n) });
    await r.act(e, 'start', 'alpha');
    await r.act(e, 'stop', 'alpha');
    const calls = engineCalls(r.home).length;
    await pause(600);
    expect(engineCalls(r.home)).toHaveLength(calls);
    expect(r.project(e, 'alpha')).toMatchObject({ live: false, wantRunning: false });
    expect(r.project(e, 'beta')!.live).toBe(false);
    expect(r.inbox).toEqual([]);
  });

  it('the Claude daemon gone: the sessions it held come back', async () => {
    if (process.platform !== 'linux') return;
    const r = rig();
    const e = r.boot();
    for (const n of ['alpha', 'beta']) {
      await r.act(e, 'add', n, { folder: r.folder(n) });
      await r.act(e, 'start', n);
    }
    const pid = liveProcess();
    fs.writeFileSync(
      path.join(r.home, '.claude/daemon.lock'),
      JSON.stringify({ pid, procStart: procStart(pid) }),
    );
    // The watch has seen the daemon up (a fixed 250 ms pause missed it on a loaded machine, 10-22 gate).
    await waitFor(
      () => expect((e as unknown as { daemonWasUp: boolean }).daemonWasUp).toBe(true),
      WAIT,
    );
    process.kill(pid, 'SIGKILL');
    const before = r.bgCalls().length;
    killFakeSessions(r.home);
    await waitFor(() => expect(r.bgCalls().length).toBe(before + 2), WAIT);
    await waitFor(() => {
      expect(r.project(e, 'alpha')!.live).toBe(true);
      expect(r.project(e, 'beta')!.live).toBe(true);
    }, WAIT);
    expect(r.logs.filter((l) => l.includes('claude daemon is gone'))).toHaveLength(1);
    expect(r.inbox.map((m) => m.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('3 deaths in 10 minutes: left down and marked, one log line, one notice; a manual start clears it', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    for (let n = 1; n <= 2; n++) {
      killFakeSessions(r.home);
      r.clock.t += 60_000;
      await waitFor(() => expect(r.bgCalls()).toHaveLength(1 + n), WAIT);
      await waitFor(() => expect(r.project(e, 'alpha')!.live).toBe(true), WAIT);
    }
    killFakeSessions(r.home); // the third death
    await waitFor(() => expect(r.project(e, 'alpha')!.downNote).toBeDefined(), WAIT);
    expect(r.project(e, 'alpha')).toMatchObject({
      live: false,
      wantRunning: true,
      downNote: expect.stringContaining('자꾸 꺼져서 다시 띄우지 않아요'),
    });
    const calls = engineCalls(r.home).length;
    await pause(500); // left down: no further tries, no further lines or notices
    expect(engineCalls(r.home)).toHaveLength(calls);
    expect(r.logs.filter((l) => l.includes('left down'))).toHaveLength(1);
    expect(r.events.filter((x) => x.type === 'orch_giveup')).toEqual([
      { type: 'orch_giveup', source: 'engine', name: 'alpha', error: expect.any(String), reason: 'crash_loop' },
    ]);
    const messenger = new Messenger({
      home: r.home,
      engine: e,
      typist: { type: () => Promise.resolve('typed') },
      events: new EngineEvents(eventsPath(r.home)),
      timing: { tickMs: 20, retryMs: 50, ifIdleMs: 10 * 60_000, quietMs: 5_000 },
      log: () => undefined,
    });
    cleanup.push(() => messenger.dispose());
    expect(await messenger.send({ to: 'alpha', text: 'do not restart', from: null, source: 'cli', ifIdle: false })).toMatchObject({
      ok: true,
      delivered: 'inbox',
      reason: 'off',
    });
    expect(r.bgCalls()).toHaveLength(3);
    // A manual start clears the mark, and the count starts over.
    expect((await r.act(e, 'start', 'alpha')).ok).toBe(true);
    expect(r.project(e, 'alpha')!.downNote).toBeUndefined();
    expect(r.project(e, 'alpha')!.live).toBe(true);
    const again = r.bgCalls().length;
    killFakeSessions(r.home);
    await waitFor(() => expect(r.bgCalls().length).toBeGreaterThan(again), WAIT); // revived again
  });

  it('deaths older than the window do not count', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    for (let n = 1; n <= 4; n++) {
      killFakeSessions(r.home);
      r.clock.t += 11 * 60_000;
      await waitFor(() => expect(r.bgCalls()).toHaveLength(1 + n), WAIT);
      await waitFor(() => expect(r.project(e, 'alpha')!.live).toBe(true), WAIT);
    }
    expect(r.project(e, 'alpha')!.downNote).toBeUndefined();
  });

  it('a revive that keeps failing is tried twice, then left down with its last error', async () => {
    const r = rig();
    const e = r.boot();
    const rules = path.join(r.home, 'rules.md');
    fs.writeFileSync(rules, '# rules\n');
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha'), rulesFile: rules });
    await r.act(e, 'start', 'alpha');
    killFakeSessions(r.home);
    fs.rmSync(rules); // every start now fails on the missing rules file
    await waitFor(() => expect(r.logs.filter((l) => l.includes('revive "alpha": failed'))).toHaveLength(1), WAIT);
    r.clock.t += 60_000; // TOKEN-GUARD: the second try waits out its backoff
    await waitFor(() => expect(r.project(e, 'alpha')!.downNote).toBeDefined(), WAIT);
    expect(r.project(e, 'alpha')!.downNote).toContain('규칙 파일');
    expect(r.logs.filter((l) => l.includes('revive "alpha": failed'))).toHaveLength(2);
    expect(r.logs.filter((l) => l.includes('left down'))).toHaveLength(1);
    expect(r.bgCalls()).toHaveLength(1); // no claude run was spent on a start that cannot work
  });

  it('a project waiting on a trust answer is not tried again', async () => {
    const r = rig();
    const e = r.boot();
    const f = r.folder('alpha');
    await r.act(e, 'add', 'alpha', { folder: f });
    await r.act(e, 'start', 'alpha');
    killFakeSessions(r.home);
    fs.writeFileSync(path.join(f, '.fake-untrusted'), ''); // every start now fails
    await waitFor(() => expect(r.project(e, 'alpha')!.needsTrust).toBe(true), WAIT);
    const calls = engineCalls(r.home).length;
    await pause(500);
    expect(engineCalls(r.home)).toHaveLength(calls); // trust is a person's answer
    expect(r.project(e, 'alpha')!.downNote).toBeUndefined();
  });

  it('a live session whose file cannot be read (mid-write, a newer shape) is not revived', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const dir = path.join(r.home, '.claude/sessions');
    const [file] = fs.readdirSync(dir).map((f) => path.join(dir, f));
    const json = fs.readFileSync(file, 'utf-8');
    const calls = engineCalls(r.home).length;
    // Claude Code rewrites the file in place; a newer build may write a shape this one does not read.
    for (const text of [json.slice(0, 20), JSON.stringify({ ...JSON.parse(json), kind: 'bg2' })]) {
      fs.writeFileSync(file, text);
      await pause(500); // several checks
      expect(engineCalls(r.home)).toHaveLength(calls); // no second process for the conversation
      expect(r.inbox).toEqual([]);
    }
    expect(r.project(e, 'alpha')!.downNote).toBeUndefined();
  });

  // TOKEN-GUARD (TG-03): every revive is a resumed conversation plus the 자동 복구 turn. A session
  // that dies every 6 minutes never made 3 deaths inside the 10-minute window, so it came back
  // forever; and the give-up lived in memory, so each daemon restart brought it back again.
  /** Kill the session whenever it is live, then let `step` of fake time pass; `n` times. */
  async function crashLoop(r: ReturnType<typeof rig>, e: Engine, n: number, step = 6 * 60_000) {
    for (let i = 0; i < n; i++) {
      if (r.project(e, 'alpha')!.live) killFakeSessions(r.home);
      r.clock.t += step;
      await pause(1_200); // past the adoption look (adoptMs) and several watch passes
    }
  }

  it('TOKEN-GUARD: a session dying every 6 minutes is left down after the day cap, reported once', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    await crashLoop(r, e, 14);
    expect(r.bgCalls().length).toBeLessThanOrEqual(1 + 6); // the start + at most 6 revives a day
    await waitFor(() => expect(r.project(e, 'alpha')!.downNote).toBeDefined(), WAIT);
    expect(r.inbox.length).toBeLessThanOrEqual(6);
    expect(r.events.filter((x) => x.type === 'orch_giveup')).toEqual([
      expect.objectContaining({ reason: 'day_cap' }),
    ]);
    // Every engine-made start says so (provenance), never a prompt body.
    const revives = r.events.filter((x) => x.type === 'orch_start' && x.source === 'revive');
    expect(revives.length).toBeGreaterThan(0);
    for (const x of revives) expect(x).toMatchObject({ by: 'engine', revives_24h: expect.any(Number) });
  });

  it('TOKEN-GUARD: the give-up survives a daemon restart: no revive, no notice, no second report', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    for (let n = 1; n <= 2; n++) {
      killFakeSessions(r.home);
      r.clock.t += 2 * 60_000;
      await waitFor(() => expect(r.bgCalls()).toHaveLength(1 + n), WAIT);
      await waitFor(() => expect(r.project(e, 'alpha')!.live).toBe(true), WAIT);
    }
    killFakeSessions(r.home); // the third death in 10 minutes
    await waitFor(() => expect(r.project(e, 'alpha')!.downNote).toBeDefined(), WAIT);
    e.dispose();
    const calls = r.bgCalls().length;
    const notices = r.inbox.length;
    const e2 = r.boot(); // the daemon restarts (a deploy)
    await pause(800);
    expect(r.bgCalls()).toHaveLength(calls);
    expect(r.inbox).toHaveLength(notices);
    expect(r.project(e2, 'alpha')!.downNote).toContain('자꾸 꺼져서 다시 띄우지 않아요');
    expect(r.events.filter((x) => x.type === 'orch_giveup')).toHaveLength(1);
    // A person's start still works and clears it, also for the next daemon.
    expect((await r.act(e2, 'start', 'alpha')).ok).toBe(true);
    expect(r.project(e2, 'alpha')!.downNote).toBeUndefined();
  });

  it('TOKEN-GUARD: daemon restarts with a session that keeps dying: the start-time revive is counted too', async () => {
    const r = rig({ ...WATCH, watchMs: 0 }); // only the start-time revive acts
    let e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    for (let n = 0; n < 9; n++) {
      killFakeSessions(r.home);
      e.dispose();
      r.clock.t += 6 * 60_000;
      e = r.boot();
      await pause(600);
    }
    expect(r.bgCalls().length).toBeLessThanOrEqual(1 + 6);
    expect(r.project(e, 'alpha')!.downNote).toBeDefined();
  });

  it('TOKEN-GUARD liveness: a turn busy for 12 hours and a user process beside it are left alone', async () => {
    const r = rig();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const dir = path.join(r.home, '.claude/sessions');
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), status: 'busy' }));
    }
    const mine = liveProcess(); // the user's own long build, never the engine's
    const calls = engineCalls(r.home).length;
    const events = r.events.length;
    for (let h = 0; h < 12; h++) {
      r.clock.t += 60 * 60_000;
      await pause(150);
    }
    expect(engineCalls(r.home)).toHaveLength(calls); // no stop, no start, no resume
    expect(r.inbox).toEqual([]);
    expect(r.events.slice(events)).toEqual([]);
    expect(r.project(e, 'alpha')).toMatchObject({ live: true });
    expect(() => process.kill(mine, 0)).not.toThrow(); // signal 0: only asks whether it lives
  });

  it('TOKEN-GUARD (S-03): a stop whose session is slow to exit stays a stop: the watch does not revive it', async () => {
    const r = rig({ ...WATCH, goneMs: 300 });
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    fs.writeFileSync(path.join(r.home, 'fake-slow-stop'), '');
    const out = await r.act(e, 'stop', 'alpha');
    expect(out).toMatchObject({ ok: false, error: '세션이 멈추지 않았어요' });
    fs.rmSync(path.join(r.home, 'fake-slow-stop'));
    killFakeSessions(r.home); // it exits a bit later
    await pause(1_500); // past the adoption look and many watch passes
    expect(r.bgCalls()).toHaveLength(1);
    expect(r.inbox).toEqual([]);
    expect(r.project(e, 'alpha')).toMatchObject({ live: false, wantRunning: false });
  });

  it('negative control: with the watch off a killed session stays dead', async () => {
    const r = rig({ ...WATCH, watchMs: 0 });
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    killFakeSessions(r.home);
    await pause(800);
    e.refresh();
    expect(r.project(e, 'alpha')!.live).toBe(false);
    expect(r.bgCalls()).toHaveLength(1);
  });
});

describe('S7: agent session tokens', () => {
  /** The CLD_AGENT_TOKEN the newest `--bg` start handed its session. */
  const tokenOf = (r: ReturnType<typeof setup>): string => {
    const argv = r.bgCalls().at(-1)!.argv;
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]) as {
      env: Record<string, string>;
    };
    return settings.env.CLD_AGENT_TOKEN;
  };

  it('each start hands its session a fresh token; restart rotates, a new daemon still knows it, remove drops it', async () => {
    const r = setup({ binDir: CLD_BIN_DIR! });
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const first = tokenOf(r);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(e.tokens.agentOf(first)).toBe('alpha');
    expect(fs.statSync(e.tokens.file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(e.tokens.file, 'utf-8')).not.toContain(first); // hashes only
    // A daemon restart: the session keeps its environment, the new engine knows it.
    expect(r.boot().tokens.agentOf(first)).toBe('alpha');

    await r.act(e, 'restart', 'alpha');
    const second = tokenOf(r);
    expect(second).not.toBe(first);
    expect(e.tokens.agentOf(first)).toBeNull();
    expect(e.tokens.agentOf(second)).toBe('alpha');
    expect(e.tokens.agentOf(`${second.slice(0, -1)}${second.endsWith('A') ? 'B' : 'A'}`)).toBeNull();

    await r.act(e, 'remove', 'alpha');
    expect(e.tokens.agentOf(second)).toBeNull();
    expect(r.boot().tokens.agentOf(second)).toBeNull();
  });

  it('a corrupt token file: no crash, nobody identified, the next start issues one that works', async () => {
    const r = setup({ binDir: CLD_BIN_DIR! });
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    await r.act(e, 'start', 'alpha');
    const old = tokenOf(r);
    fs.writeFileSync(e.tokens.file, '{not json');
    const again = r.boot();
    expect(again.tokens.agentOf(old)).toBeNull();
    expect(r.logs.some((l) => l.includes('agent-tokens.json: unreadable'))).toBe(true);
    await r.act(again, 'restart', 'alpha');
    expect(again.tokens.agentOf(tokenOf(r))).toBe('alpha');
  });
});

describe('S1: a remote session needs a fresh step-up for the risky engine actions', () => {
  const remote = (fresh: boolean) => ({ remote: true, fresh: () => fresh });
  /** The engineAction exactly as a browser sends it over /ws. */
  const viaWs = (
    e: Engine,
    n: number,
    action: EngineActionKind,
    name: string,
    fields: Partial<EngineAction>,
    stepUp?: { remote: boolean; fresh(): boolean },
  ) =>
    new Promise<EngineActionResult>((resolve) =>
      e.handle(
        { type: 'engineAction', requestId: `w${n}`, action, name, ...fields },
        (m) => resolve(m as unknown as EngineActionResult),
        true,
        'web',
        stepUp,
      ),
    );

  it('permission mode, rules file and folder: refused on a cookie alone, nothing changes; fine when fresh, local, or unchanged', async () => {
    const r = setup();
    const e = r.boot();
    const alpha = r.folder('alpha');
    await r.act(e, 'add', 'alpha', { folder: alpha, permissionMode: 'default' });
    const rules = path.join(r.home, 'rules.md');
    fs.writeFileSync(rules, 'be careful');
    const risky: Array<Partial<EngineAction>> = [
      { permissionMode: 'bypassPermissions' },
      { rulesFile: rules },
      { folder: r.folder('elsewhere') },
    ];
    let n = 0;
    for (const fields of risky) {
      const res = await viaWs(e, ++n, 'edit', 'alpha', fields, remote(false));
      expect(res, JSON.stringify(fields)).toMatchObject({ ok: false, error: 'stepup' });
    }
    expect(r.project(e, 'alpha')).toMatchObject({ folder: alpha, permissionMode: 'default' });
    expect(r.project(e, 'alpha')?.rulesFile).toBeUndefined();
    // adding an agent with a permission mode is the same change
    expect(await viaWs(e, ++n, 'add', 'beta', { folder: r.folder('beta'), permissionMode: 'bypassPermissions' }, remote(false)))
      .toMatchObject({ ok: false, error: 'stepup' });
    expect(r.project(e, 'beta')).toBeUndefined();
    // a form resent with what is already there is not a change
    expect(await viaWs(e, ++n, 'edit', 'alpha', { permissionMode: 'default', folder: alpha, title: 'A' }, remote(false)))
      .toMatchObject({ ok: true });
    // fresh: allowed
    expect(await viaWs(e, ++n, 'edit', 'alpha', { permissionMode: 'bypassPermissions' }, remote(true)))
      .toMatchObject({ ok: true });
    expect(r.project(e, 'alpha')?.permissionMode).toBe('bypassPermissions');
    // this PC's own browser and callers with no socket standing keep working as today
    expect(await viaWs(e, ++n, 'edit', 'alpha', { rulesFile: rules }, { remote: false, fresh: () => false }))
      .toMatchObject({ ok: true });
    expect(await viaWs(e, ++n, 'edit', 'alpha', { permissionMode: 'default' }))
      .toMatchObject({ ok: true });
  });

  it('starting an agent fresh asks; one that resumes a conversation does not', async () => {
    const r = setup();
    const e = r.boot();
    await r.act(e, 'add', 'alpha', { folder: r.folder('alpha') });
    for (const action of ['start', 'restart'] as const)
      expect(await viaWs(e, 1, action, 'alpha', {}, remote(false)), action).toMatchObject({ ok: false, error: 'stepup' });
    expect(r.bgCalls()).toHaveLength(0);
    expect(await viaWs(e, 2, 'start', 'alpha', {}, remote(true))).toMatchObject({ ok: true });
    expect(r.bgCalls()).toHaveLength(1);
    // stopping needs nothing, and a later start resumes the recorded conversation
    expect(await viaWs(e, 3, 'stop', 'alpha', {}, remote(false))).toMatchObject({ ok: true });
    expect(r.project(e, 'alpha')?.sessionId).toBeTruthy();
    expect(await viaWs(e, 4, 'start', 'alpha', {}, remote(false))).toMatchObject({ ok: true });
  });
});
