import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../agentStateStore.js';
import { WS_CLOSE_FORBIDDEN_ORIGIN, WS_CLOSE_NO_SESSION } from '../constants.js';
import { createHttpServer, type HttpServerHandle } from '../httpServer.js';
import type { IPty, PtyModule, PtySpawnOptions } from '../terminal/ptyModule.js';
import { StandaloneAuth } from './auth.js';
import type { ChatSocket } from './chat.js';
import {
  attachable,
  CHAT_IDLE_MS,
  CHAT_TEXT,
  ChatManager,
  dialogMatches,
  filterInput,
  foldsWhenPasted,
  inputLineEmpty,
  loginEnvFrom,
  permissionDialog,
  sessionProcessAlive,
} from './chat.js';
import { openToolCall } from './permissionWait.js';
import type { ClaudeSession } from './providers/claudeProvider.js';
import { parseAgents } from './providers/claudeProvider.js';
import { FAKE_CLAUDE, fakeBin } from './testHome.js';
import { waitFor } from './waitKit.js';

/** No ~/.claude/sessions records here: only the live-pid rule applies. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-chat-home-'));
/** C-4: interactive alpha-orchestrator and an unnamed one; background
 *  beta-task, gamma-review and old-job (a0000016..18), here alive as this
 *  test process. */
const C4 = parseAgents(
  JSON.parse(fs.readFileSync(path.join(FAKE_CLAUDE, 'C-4/agents.json'), 'utf-8')),
).map((s) => (s.kind === 'background' ? { ...s, pid: process.pid } : s));
const bg = (id: string, sessionId = `${id}-0000-4000-8000-000000000099`): ClaudeSession => ({
  id,
  cwd: '/work/x',
  kind: 'background',
  sessionId,
  name: `bg-${id}`,
  state: 'blocked',
  pid: process.pid,
});
const SESSIONS = [...C4, bg('a0000019')];
/** A pid that is not running: a child that has exited. */
const DEAD_PID = spawnSync('true').pid!;

class FakePty implements IPty {
  readonly pid = 4242;
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  killed: Array<string | undefined> = [];
  private dataListener?: (data: string) => void;
  private exitListener?: (e: { exitCode: number; signal?: number }) => void;
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  /** Tests: what the terminal draws back for a write (the paste shown as a draft). */
  echo?: (data: string) => string | undefined;
  write(data: string): void {
    this.written.push(data);
    const back = this.echo?.(data);
    if (back !== undefined) this.emit(back);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  /** Dies on the first signal, like `claude attach` on SIGHUP. */
  kill(signal?: string): void {
    this.killed.push(signal);
    queueMicrotask(() => this.exit(0, 1));
  }
  emit(data: string): void {
    this.dataListener?.(data);
  }
  exit(exitCode = 0, signal?: number): void {
    const l = this.exitListener;
    this.exitListener = undefined;
    l?.({ exitCode, signal });
  }
}

class FakeSocket implements ChatSocket {
  readyState = 1;
  frames: Array<{ type: string; data?: string; exitCode?: number }> = [];
  closed: [number | undefined, string | undefined] | null = null;
  private messageListeners: Array<(data: Buffer | string) => void> = [];
  private closeListeners: Array<() => void> = [];
  send(data: string): void {
    this.frames.push(JSON.parse(data) as FakeSocket['frames'][number]);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = [code, reason];
    this.readyState = 3;
    for (const l of this.closeListeners) l();
  }
  on(event: 'message', listener: (data: Buffer | string) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'message' | 'close', listener: (data: Buffer | string) => void): void {
    if (event === 'message') this.messageListeners.push(listener);
    else this.closeListeners.push(listener as () => void);
  }
  frame(frame: Record<string, unknown>): void {
    for (const l of this.messageListeners) l(JSON.stringify(frame));
  }
  input(data: string): void {
    this.frame({ type: 'input', data });
  }
  text(): string {
    return this.frames.map((f) => f.data ?? '').join('');
  }
}

function setup(
  opts: {
    sessions?: () => ClaudeSession[];
    idleMs?: number;
    maxPtys?: number;
    settingsFile?: string;
  } = {},
) {
  const ptys: FakePty[] = [];
  const spawns: Array<{ file: string; args: string[]; opts: PtySpawnOptions }> = [];
  const logs: string[] = [];
  let listCalls = 0;
  const pty: PtyModule = {
    spawn: (file, args, spawnOpts) => {
      spawns.push({ file, args, opts: spawnOpts });
      const p = new FakePty();
      ptys.push(p);
      return p;
    },
  };
  const chat = new ChatManager({
    claudePath: '/abs/bin/claude',
    home: HOME,
    list: async () => {
      listCalls++;
      return opts.sessions?.() ?? SESSIONS;
    },
    pty,
    idleMs: opts.idleMs,
    maxPtys: opts.maxPtys,
    settingsFile: opts.settingsFile,
    log: (line) => logs.push(line),
  });
  return { chat, ptys, spawns, logs, listCalls: () => listCalls };
}

/** Let the screen mirrors parse what the fake PTY emitted. */
const parsed = () => new Promise((r) => setTimeout(r, 30));

const INJECTED = [
  'abc; touch PWNED',
  '$(touch PWNED)',
  '`touch PWNED`',
  '-h',
  '--help',
  '../x',
  'a0000016 ',
  ' a0000016',
  'a0000016\n',
  'a00\u00000016',
  'a0000016a', // 9 characters
  'A0000016', // only the exact id passes
  'beta-task', // a session name (attach would accept part of one)
  'a0000001', // interactive alpha's session id prefix
  '',
];

describe('chat: login environment', () => {
  const base = {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
    TEMP: 'C:\\Users\\Ada\\AppData\\Local\\Temp',
    PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    CLD_AGENT_TOKEN: 'secret',
    NODE_OPTIONS: '--inspect',
    AGENT_TYCOON_X: 'session',
  };

  it('keeps Windows logon variables with the spelling Windows supplied', () => {
    expect(loginEnvFrom(base, 'win32', () => 'C:\\Windows\\System32;C:\\Users\\Ada\\.local\\bin')).toEqual({
      Path: 'C:\\Windows\\System32;C:\\Users\\Ada\\.local\\bin',
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      TEMP: 'C:\\Users\\Ada\\AppData\\Local\\Temp',
      PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
      PROCESSOR_ARCHITECTURE: 'AMD64',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    });
  });

  it('uses the fresh Windows logon PATH instead of the daemon PATH', () => {
    expect(loginEnvFrom(base, 'win32', () => 'C:\\Windows\\System32;C:\\Users\\Ada\\.local\\bin').Path).toBe(
      'C:\\Windows\\System32;C:\\Users\\Ada\\.local\\bin',
    );
  });

  it('does not add Windows logon variables on Linux', () => {
    expect(loginEnvFrom(base, 'linux')).toEqual({});
  });

  it('does not replace Linux PATH with a Windows logon PATH', () => {
    let called = false;
    expect(
      loginEnvFrom({ PATH: '/usr/local/bin:/usr/bin' }, 'linux', () => {
        called = true;
        return 'C:\\Windows\\System32';
      }),
    ).toEqual({ PATH: '/usr/local/bin:/usr/bin' });
    expect(called).toBe(false);
  });
});

describe('chat: which sessions can be attached', () => {
  it('only the exact id of a background session in the list', () => {
    expect(attachable(SESSIONS, 'a0000016', HOME)).toMatchObject({ name: 'beta-task' });
    expect(attachable(SESSIONS, 'a0000018', HOME)).toMatchObject({ name: 'old-job' }); // done = idle
    expect(attachable(SESSIONS, 'a00000ff', HOME)).toBe(CHAT_TEXT.notLive); // unknown
    for (const id of INJECTED)
      expect(attachable(SESSIONS, id, HOME), JSON.stringify(id)).toBe(CHAT_TEXT.notLive);
    // An interactive row never qualifies, even one that carries an id.
    expect(attachable([{ ...C4[0], id: 'a0000001' }], 'a0000001', HOME)).toBe(CHAT_TEXT.notLive);
  });

  it('never a row without a live process: no pid (killed by a reboot; attach would resume it), a dead pid, a reused pid', () => {
    const row = bg('b0000002');
    const { pid: _pid, ...noPid } = row;
    expect(attachable([noPid], 'b0000002', HOME)).toBe(CHAT_TEXT.notLive);
    expect(attachable([{ ...row, pid: DEAD_PID }], 'b0000002', HOME)).toBe(CHAT_TEXT.notLive);
    expect(attachable([{ ...row, pid: 0 }], 'b0000002', HOME)).toBe(CHAT_TEXT.notLive);
  });

  // ponytail: macOS and Windows tell a reused pid by nothing yet (no /proc start time; R5/P7).
  it.runIf(process.platform === 'linux')('a reused pid: the /proc start time differs from the one Claude recorded', () => {
    const row = bg('b0000002');
    expect(attachable([{ ...row, procStart: '1' }], 'b0000002', HOME)).toBe(CHAT_TEXT.notLive);
    const started = fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[19];
    expect(attachable([{ ...row, procStart: started }], 'b0000002', HOME)).toMatchObject({
      id: 'b0000002',
    });
    // The record in ~/.claude/sessions/<pid>.json counts the same way.
    const sessions = path.join(HOME, '.claude', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const record = path.join(sessions, `${process.pid}.json`);
    fs.writeFileSync(record, JSON.stringify({ pid: process.pid, procStart: '1' }));
    expect(sessionProcessAlive(row, HOME)).toBe(false);
    fs.writeFileSync(record, JSON.stringify({ pid: process.pid, procStart: started }));
    expect(sessionProcessAlive(row, HOME)).toBe(true);
    fs.rmSync(record);
  });

  it('refuses a background row whose conversation is open in a terminal', () => {
    const shared = [bg('b0000001', 'sid-1'), { ...C4[0], sessionId: 'sid-1' }];
    expect(attachable(shared, 'b0000001', HOME)).toBe(CHAT_TEXT.inTerminal);
  });
});

describe('chat: input filter', () => {
  it('drops every Ctrl+Z, also inside a pasted chunk, and keeps the rest in order', () => {
    expect(filterInput('a\x1ab', false)).toBe('ab');
    expect(filterInput('\x1a', false)).toBe('');
    expect(filterInput('\x1a\x1a', false)).toBe('');
    expect(filterInput(`${'x'.repeat(5000)}\x1a${'y'.repeat(5000)}`, false)).toBe(
      `${'x'.repeat(5000)}${'y'.repeat(5000)}`,
    );
  });

  it('drops ← only while the agent view is offered', () => {
    expect(filterInput('\x1b[D\x1bOD\x1b[1;5Dx', false)).toBe('\x1b[D\x1bOD\x1b[1;5Dx');
    expect(filterInput('\x1b[D\x1bOD\x1b[1;5Dx\x1b[C', true)).toBe('x\x1b[C');
  });
});

describe('chat manager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs exactly [claude, attach, id] in the home dir with a login env, and nothing for a refused id', async () => {
    const t = setup();
    // This service's own environment must not reach Claude's daemon.
    Object.assign(process.env, { CLAUDE_PID: '1', OFFICE_START: 'x', TMUX: '/tmp/t,1,0' });
    for (const id of INJECTED) {
      const s = new FakeSocket();
      await t.chat.join(id, s, 'ios');
      expect(s.closed?.[0], JSON.stringify(id)).toBe(WS_CLOSE_NO_SESSION);
      expect(s.text()).toContain(CHAT_TEXT.notLive);
    }
    expect(t.spawns).toHaveLength(0);
    expect(t.listCalls()).toBe(1); // only 'a0000001' is well-formed enough to look up
    await t.chat.join('a0000016', new FakeSocket(), 'mac');
    expect(t.spawns).toHaveLength(1);
    expect(t.spawns[0].file).toBe('/abs/bin/claude');
    expect(t.spawns[0].args).toEqual(['attach', 'a0000016']);
    expect(t.spawns[0].opts.cwd).toBe(os.homedir());
    expect(t.spawns[0].opts.env.TERM).toBe('xterm-256color');
    expect(t.spawns[0].opts.env.HOME).toBe(process.env.HOME);
    expect(t.spawns[0].opts.env.PATH).toBe(process.env.PATH);
    for (const k of ['CLAUDE_PID', 'OFFICE_START', 'TMUX', 'FAKE_CLAUDE_LOG']) {
      expect(t.spawns[0].opts.env[k], k).toBeUndefined();
    }
    delete process.env.CLAUDE_PID;
    delete process.env.OFFICE_START;
    delete process.env.TMUX;
    expect(t.logs.some((l) => l.startsWith('refused') && l.includes('gui:ios'))).toBe(true);
  });

  it('checks a fresh list on every request: a session gone from it is refused, even with its attach open', async () => {
    let sessions = SESSIONS;
    const t = setup({ sessions: () => sessions });
    const a = new FakeSocket();
    await t.chat.join('a0000016', a);
    sessions = SESSIONS.filter((s) => s.id !== 'a0000016');
    const b = new FakeSocket();
    await t.chat.join('a0000016', b);
    expect(t.listCalls()).toBe(2);
    expect(b.closed?.[0]).toBe(WS_CLOSE_NO_SESSION);
    expect(a.closed).toBeNull();
  });

  it('shares one PTY per session; a late viewer starts with a replay; resizes reach the PTY', async () => {
    const t = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    await t.chat.join('a0000016', a);
    t.ptys[0].emit('hello from claude');
    await t.chat.join('a0000016', b);
    await waitFor(() => expect(b.frames[0]?.type).toBe('replay'));
    expect(t.spawns).toHaveLength(1);
    expect(b.frames[0].data).toContain('hello from claude');
    a.input('x');
    expect(t.ptys[0].written).toEqual(['x']);
    b.frame({ type: 'resize', cols: 100, rows: 30 });
    expect(t.ptys[0].resizes).toEqual([[100, 30]]);
  });

  it('holds input sent while the session is being checked', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ptys: FakePty[] = [];
    const chat = new ChatManager({
      claudePath: '/abs/bin/claude',
      home: HOME,
      list: async () => {
        await gate;
        return SESSIONS;
      },
      pty: { spawn: () => ptys[ptys.push(new FakePty()) - 1] },
      log: () => {},
    });
    const s = new FakeSocket();
    const joined = chat.join('a0000016', s);
    s.frame({ type: 'resize', cols: 120, rows: 40 });
    s.input('early');
    release();
    await joined;
    expect(ptys[0].resizes).toEqual([[120, 40]]);
    expect(ptys[0].written).toEqual(['early']);
  });

  it('gates: one attach by default, the next session refused in Korean', async () => {
    const t = setup();
    const first = new FakeSocket();
    await t.chat.join('a0000016', first);
    const second = new FakeSocket();
    await t.chat.join('a0000017', second);
    expect(t.spawns).toHaveLength(1);
    expect(second.closed?.[0]).toBe(WS_CLOSE_NO_SESSION);
    expect(second.text()).toContain('동시에 열 수 있는 대화는 1개까지예요');
    expect(first.closed).toBeNull();
    const viewer = new FakeSocket();
    await t.chat.join('a0000016', viewer); // another viewer of the open one still joins
    expect(viewer.closed).toBeNull();
    // Switching chats: the old sockets close, then the new session joins.
    first.close();
    viewer.close();
    const switched = new FakeSocket();
    await t.chat.join('a0000017', switched);
    expect(switched.closed).toBeNull();
    expect(t.spawns.map((x) => x.args[1])).toEqual(['a0000016', 'a0000017']);
  });

  it('gates: --chat-attaches 3 allows three, the 4th refused; the 3 keep running', async () => {
    const t = setup({ maxPtys: 3 });
    const open = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    for (const [i, id] of ['a0000016', 'a0000017', 'a0000018'].entries()) {
      await t.chat.join(id, open[i]);
    }
    const fourth = new FakeSocket();
    await t.chat.join('a0000019', fourth);
    expect(t.spawns).toHaveLength(3);
    expect(fourth.closed?.[0]).toBe(WS_CLOSE_NO_SESSION);
    expect(fourth.text()).toContain('동시에 열 수 있는 대화는 3개까지예요');
    expect(open.every((s) => s.closed === null)).toBe(true);
    expect(t.ptys.every((p) => p.killed.length === 0)).toBe(true);
    const viewer = new FakeSocket();
    await t.chat.join('a0000017', viewer); // a viewer of an open one still joins
    expect(viewer.closed).toBeNull();
    expect(t.chat.size).toBe(3);
  });

  it('the 설정 cap: 1 to 4 only, kept in terminal.json (0600), applied live, never kills an open attach', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-chat-cap-'));
    const file = path.join(dir, 'config', 'terminal.json');
    const t = setup({ maxPtys: 1, settingsFile: file });
    expect(t.chat.maxAttaches).toBe(1);
    expect(t.chat.defaultAttaches).toBe(1);
    for (const bad of [0, 5, -1, 1.5, '2', null, undefined, NaN])
      expect(t.chat.setMaxAttaches(bad), String(bad)).toBe(false);
    expect(t.chat.maxAttaches).toBe(1);
    expect(fs.existsSync(file)).toBe(false);

    const a = new FakeSocket();
    await t.chat.join('a0000016', a);
    const refused = new FakeSocket();
    await t.chat.join('a0000017', refused);
    expect(refused.closed).toEqual([WS_CLOSE_NO_SESSION, 'cap']); // a pane offers 이 터미널로 바꾸기
    // Without a restart the second one fits.
    expect(t.chat.setMaxAttaches(2)).toBe(true);
    const b = new FakeSocket();
    await t.chat.join('a0000017', b);
    expect(b.closed).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ chatAttaches: 2 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Lowering it again keeps both attaches; a third session is what is refused.
    expect(t.chat.setMaxAttaches(1)).toBe(true);
    expect(t.chat.size).toBe(2);
    expect(t.ptys.every((p) => p.killed.length === 0)).toBe(true);
    const c = new FakeSocket();
    await t.chat.join('a0000018', c);
    expect(c.closed).toEqual([WS_CLOSE_NO_SESSION, 'cap']);
    // A restart keeps the chosen value, not the flag's; a broken file falls back to the flag.
    expect(setup({ maxPtys: 3, settingsFile: file }).chat.maxAttaches).toBe(1);
    expect(setup({ maxPtys: 3, settingsFile: file }).chat.defaultAttaches).toBe(3);
    fs.writeFileSync(file, '{"chatAttaches": 9}');
    expect(setup({ maxPtys: 3, settingsFile: file }).chat.maxAttaches).toBe(3);
    fs.writeFileSync(file, 'nonsense');
    expect(setup({ settingsFile: file }).chat.maxAttaches).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never passes Ctrl+Z to the PTY', async () => {
    const t = setup();
    const s = new FakeSocket();
    await t.chat.join('a0000016', s);
    s.input('a\x1ab');
    s.input('\x1a');
    s.input('\x1a\x1a');
    expect(t.ptys[0].written).toEqual(['ab']);
  });

  it('drops ← while Claude offers its agent view, and ends the attach if the view shows', async () => {
    const t = setup();
    const s = new FakeSocket();
    await t.chat.join('a0000016', s);
    const pty = t.ptys[0];
    pty.emit('❯ \r\n  ⏵⏵ auto mode on · ← 2 agents');
    await parsed();
    s.input('\x1b[D');
    expect(pty.written).toEqual([]);
    pty.emit('\x1b[2J\x1b[H❯ ab');
    await parsed();
    s.input('\x1b[D');
    expect(pty.written).toEqual(['\x1b[D']);
    pty.emit('\x1b[2J\x1b[H\r\n  Press ← again to go back to agents');
    await parsed();
    s.input('\x1b[D');
    expect(pty.written).toEqual(['\x1b[D']);
    // The view itself (its footer on the bottom row) ends the attach.
    pty.emit('\x1b[24;1Henter to return · space to reply · ctrl+x to delete');
    await waitFor(() => expect(s.closed?.[0]).toBe(WS_CLOSE_NO_SESSION));
    expect(pty.killed).toEqual([undefined]);
    expect(s.text()).toContain(CHAT_TEXT.agentView);
    expect(s.frames.at(-1)?.type).toBe('exit');
    expect(t.chat.size).toBe(0);
  });

  it('kills the PTY when the last viewer leaves, and logs no terminal content', async () => {
    const t = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    await t.chat.join('a0000016', a, 'ios');
    await t.chat.join('a0000016', b, 'mac');
    t.ptys[0].emit('SECRET-OUT-1234');
    a.input('SECRET-1234');
    a.close();
    expect(t.ptys[0].killed).toEqual([]);
    b.close();
    expect(t.ptys[0].killed).toEqual([undefined]);
    expect(t.chat.size).toBe(0);
    expect(t.logs).toEqual([
      'attach "beta-task" gui:ios',
      'attach "beta-task" gui:mac',
      'detach "beta-task" gui:ios after 0s',
      'detach "beta-task" gui:mac after 0s',
    ]);
    await t.chat.join('a0000016', new FakeSocket());
    expect(t.spawns).toHaveLength(2); // a new viewer gets a fresh attach
  });

  it('safety net: no open viewer for 2 minutes ends it; input restarts the clock', async () => {
    vi.useFakeTimers();
    const t = setup();
    const s = new FakeSocket();
    await t.chat.join('a0000016', s);
    const pty = t.ptys[0];
    // An open viewer keeps the attach however idle it is.
    vi.advanceTimersByTime(25 * 60_000);
    expect(pty.killed).toEqual([]);
    s.input('x'); // the clock restarts here
    s.readyState = 3; // ...and the viewer goes without a close we hear about
    vi.advanceTimersByTime(CHAT_IDLE_MS - 1_000);
    expect(pty.killed).toEqual([]);
    vi.advanceTimersByTime(2_000); // 2:01
    expect(pty.killed).toEqual([undefined]);
    expect(t.chat.size).toBe(0);
  });

  it('closes every viewer when the child exits', async () => {
    const t = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    await t.chat.join('a0000016', a);
    await t.chat.join('a0000016', b);
    t.ptys[0].exit(0);
    await waitFor(() => expect(b.closed?.[0]).toBe(WS_CLOSE_NO_SESSION));
    expect(a.closed?.[0]).toBe(WS_CLOSE_NO_SESSION);
    expect(a.frames.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
    expect(t.chat.size).toBe(0);
  });

  it('spawns nothing for a socket that left while the session was checked', async () => {
    const t = setup();
    const s = new FakeSocket();
    const joined = t.chat.join('a0000016', s);
    s.close();
    await joined;
    expect(t.spawns).toHaveLength(0);
  });
});

/** Claude Code's screen as cld-gui send reads it (fake-claude/session-tui.cjs, 2.1.306). */
const RULE = '─'.repeat(60);
const SUGGESTION = '❯ \x1b[7mT\x1b[27m\x1b[2mry "fix lint errors"\x1b[22m';
const screenOf = (input: string[], above = '') =>
  `\x1b[H\x1b[2J Claude Code\r\n${above}\r\n${RULE}\r\n${input.join('\r\n')}\r\n${RULE}\r\n  ⏵⏵ bypass permissions on\r\n`;
const DIALOG = `\x1b[H\x1b[2J ${RULE}\r\n Bash command\r\n   rm -rf build\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n`;
/** A turn running: the spinner line above the input box (fake-claude/session-tui.cjs). */
const WORKING = '✻ Working… (esc to interrupt)';
/** A question (AskUserQuestion) asked mid-turn, under the spinner line. */
const WORKING_DIALOG = `\x1b[H\x1b[2J Claude Code\r\n${WORKING}\r\n${RULE}\r\n Which one?\r\n\r\n ❯ 1. Option A\r\n   2. Option B\r\n${RULE}\r\n   3. Chat about this\r\n Enter to select · Esc to cancel\r\n`;

describe('chat: the permission dialog an answer from the messenger may press (PERM-PROMPT)', () => {
  const read = async (data: string, rows = 24) => {
    const term = new HeadlessTerminal({ cols: 80, rows, allowProposedApi: true });
    await new Promise<void>((r) => term.write(data, r));
    const out = permissionDialog(term);
    term.dispose();
    return out;
  };
  // Claude Code 2.1.31x's dialog for a background sub-agent's Bash (the owner's screenshot, 10-24).
  const perm = (desc: string, command: string, above = '') =>
    `\x1b[H\x1b[2J${above} Running 3 shell commands\r\n${RULE}\r\n Bash command · from the general-purpose agent\r\n ${desc}\r\n\r\n   ${command}\r\n ╌╌╌╌\r\n Dangerous rm operation on possibly-empty variable path\r\n\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n\r\n Esc to cancel · Tab to amend\r\n`;
  const card = ['Experiment: log.showSignature', 'rm -f $M/*'];
  it('reads the dialog from its rule down to its question and matches the same call only', async () => {
    const d = await read(perm('Experiment: log.showSignature', 'rm -f $M/*'));
    expect(d).toContain('Bash command');
    expect(d).not.toContain('Running 3 shell commands');
    expect(dialogMatches(d!, card)).toBe(true);
    // Another command, another description, nothing to match: no.
    expect(dialogMatches((await read(perm('Experiment: log.showSignature', 'rm -rf /')))!, card)).toBe(false);
    expect(dialogMatches((await read(perm('Something else', 'rm -f $M/*')))!, card)).toBe(false);
    expect(dialogMatches(d!, [])).toBe(false);
    expect(dialogMatches(d!, ['  '])).toBe(false);
  });
  it("a multi-line call's words do not match a dialog that shares only its first line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-perm-'));
    try {
      const file = path.join(dir, 's.jsonl');
      const input = { description: 'Run tests', command: 'cd /repo\nnpm test' };
      fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input }] } })}\n`);
      const words = openToolCall(file, 't1')!.match;
      const other = perm('Run tests', 'cd /repo\r\n   rm -rf node_modules /');
      expect(dialogMatches((await read(other))!, words)).toBe(false);
      expect(dialogMatches((await read(perm('Run tests', 'cd /repo\r\n   npm test')))!, words)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('the same words above the dialog (the transcript) do not make another dialog ours', async () => {
    const above = ' ● Bash(rm -f $M/*)\r\n   Experiment: log.showSignature\r\n';
    const d = await read(perm('List files', 'ls -la', above));
    expect(d).not.toBeNull();
    expect(dialogMatches(d!, card)).toBe(false);
  });
  it('whole: a dialog whose rule scrolled off (taller than the screen) is not read as a whole one', async () => {
    const tall = perm('Experiment: log.showSignature', Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n   '));
    expect(await read(tall)).not.toBeNull(); // the words-match fallback still sees its bottom
    const term = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((r) => term.write(tall, r));
    expect(permissionDialog(term, true)).toBeNull();
    await new Promise<void>((r) => term.write(perm('Short', 'ls'), r));
    expect(permissionDialog(term, true)).toContain('Bash command');
    term.dispose();
  });
  it('no permission dialog: an input line, a question dialog, a "1. Yes, and don\'t ask again" first option', async () => {
    expect(await read(screenOf([SUGGESTION]))).toBeNull();
    expect(await read(WORKING_DIALOG)).toBeNull();
    expect(
      await read(DIALOG.replace('❯ 1. Yes', "❯ 1. Yes, and don't ask again for rm commands")),
    ).toBeNull();
    expect(await read(DIALOG)).toContain('rm -rf build');
  });
});

describe('chat: the input line cld-gui send types into', () => {
  const empty = async (data: string, whileWorking = false) => {
    const term = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((r) => term.write(data, r));
    const out = inputLineEmpty(term, whileWorking);
    term.dispose();
    return out;
  };
  it('empty: the suggestion (dim) and the cursor, or nothing', async () => {
    expect(await empty(screenOf([SUGGESTION]))).toBe(true);
    expect(await empty(screenOf(['❯ \x1b[7m \x1b[27m']))).toBe(true);
  });
  it('not empty: a draft, one letter under the cursor, a draft on a later line', async () => {
    expect(await empty(screenOf(['❯ half a thought\x1b[7m \x1b[27m']))).toBe(false);
    expect(await empty(screenOf(['❯ \x1b[7ma\x1b[27m']))).toBe(false);
    expect(await empty(screenOf(['❯ \x1b[7m \x1b[27m', '  second line of a draft']))).toBe(false);
  });
  it('not a prompt: a dialog, a turn running, the agent view, an unknown shape', async () => {
    expect(await empty(DIALOG)).toBe(false);
    expect(await empty(screenOf([SUGGESTION], '✻ Working… (esc to interrupt)'))).toBe(false);
    expect(await empty(screenOf([SUGGESTION], 'enter to return · space to reply'))).toBe(false);
    expect(await empty(`\x1b[H\x1b[2J${RULE}\r\n❯ \r\n`)).toBe(false); // no rule under it
  });
  it('whileWorking (즉시 보내기): a running turn counts, nothing else is let through', async () => {
    expect(await empty(screenOf([SUGGESTION], WORKING), true)).toBe(true);
    expect(await empty(screenOf(['❯ \x1b[7m \x1b[27m'], WORKING), true)).toBe(true);
    // A draft, a dialog, the agent view: refused with or without the allowance.
    expect(await empty(screenOf(['❯ half a thought\x1b[7m \x1b[27m'], WORKING), true)).toBe(false);
    for (const whileWorking of [false, true]) {
      expect(await empty(WORKING_DIALOG, whileWorking)).toBe(false);
      expect(await empty(DIALOG, whileWorking)).toBe(false);
      expect(
        await empty(screenOf([SUGGESTION], 'enter to return · space to reply'), whileWorking),
      ).toBe(false);
    }
  });
});

/** The input box with a pasted draft in it, as Claude Code shows it (its first line, the cursor). */
const draftScreen = (paste: string) =>
  screenOf(paste.split('\r').map((l, i) => `${i ? '  ' : '❯ '}${l}`));

it('foldsWhenPasted: short one-liners never become a placeholder, long or tall texts may (U-37)', () => {
  const header = '[cld-gui · ops에게서 · 10-22 11:57]\n배포해 줘';
  expect(foldsWhenPasted('배포해 줘', 24)).toBe(false);
  expect(foldsWhenPasted(header, 24)).toBe(false);
  expect(foldsWhenPasted('a\nb\nc', 24)).toBe(true);
  expect(foldsWhenPasted('x'.repeat(100), 24)).toBe(true);
  // A terminal of 10 rows or fewer folds every multi-line paste, a header + one line included.
  expect(foldsWhenPasted(header, 10)).toBe(true);
  expect(foldsWhenPasted(header, 11)).toBe(false);
  expect(foldsWhenPasted('배포해 줘', 8)).toBe(false);
});

describe('chat: typing a cld-gui send', () => {
  /**
   * `shows`: the screen after a paste (default: the draft, all its lines, in the input box).
   * `patient`: for a send that is meant to go through. Its readyMs/showMs only bound how long the
   * test waits for a screen it has already supplied, so on a starved CPU (a >1 s stall between the
   * emit and the poll that should see it) the short defaults ended it as 'notReady'. The tests that
   * expect 'notReady' keep them short: there they are the thing being waited out.
   */
  const make = (shows: (paste: string) => string = draftScreen, patient = false) => {
    const ptys: FakePty[] = [];
    const timing = { readyMs: 1_000, enterMs: 150, submitMs: 100, pollMs: 10, ...(patient ? PATIENT : {}) };
    const spawn = () => {
      const pty = new FakePty();
      pty.echo = (data) => (data.startsWith('\x1b[200~') ? shows(data.slice(6, -6)) : undefined);
      return ptys[ptys.push(pty) - 1];
    };
    const chat = new ChatManager({
      claudePath: '/abs/bin/claude',
      home: HOME,
      list: async () => SESSIONS,
      pty: { spawn },
      log: () => {},
      typeTiming: timing,
    });
    return { chat, ptys, timing };
  };
  const PATIENT = { readyMs: 30_000, showMs: 30_000 };

  it('one bracketed paste with no control characters in it, then one Enter', async () => {
    const { chat, ptys } = make(draftScreen, true);
    const typed = chat.type('a0000016', 'hi\x1b[201~\x03\x1b\x1a\x9bx\r\nnext\tline\x7f');
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(screenOf([SUGGESTION]));
    expect(await typed).toBe('typed');
    expect(ptys[0].written).toEqual(['\x1b[200~hi[201~x\rnext\tline\x1b[201~', '\r']);
  });

  it('a viewer typing meanwhile: its keys come after the Enter, never inside the message', async () => {
    const { chat, ptys } = make(draftScreen, true);
    const viewer = new FakeSocket();
    await chat.join('a0000016', viewer);
    ptys[0].emit(screenOf([SUGGESTION]));
    await parsed();
    const typed = chat.type('a0000016', 'message');
    await new Promise((r) => setTimeout(r, 50));
    viewer.input('y');
    expect(await typed).toBe('typed');
    expect(ptys[0].written).toEqual(['\x1b[200~message\x1b[201~', '\r', 'y']);
  });

  it('a dialog or a running turn shows up before the Enter: no Enter (never into a dialog)', async () => {
    const { chat, ptys } = make();
    const viewer = new FakeSocket();
    await chat.join('a0000016', viewer);
    ptys[0].emit(screenOf([SUGGESTION]));
    await parsed();
    const typed = chat.type('a0000016', 'message');
    await new Promise((r) => setTimeout(r, 50));
    ptys[0].emit(DIALOG);
    expect(await typed).toBe('notReady');
    expect(ptys[0].written).toEqual(['\x1b[200~message\x1b[201~']);
  });

  it('a running turn: nothing written, unless whileWorking (then paste and chat:sendNow, which Enter would only queue)', async () => {
    const { chat, ptys, timing } = make();
    const plain = chat.type('a0000016', 'message');
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(screenOf([SUGGESTION], WORKING));
    expect(await plain).toBe('notReady');
    expect(ptys[0].written).toEqual([]);
    Object.assign(timing, PATIENT); // from here every send is meant to go through
    const now = chat.type('a0000016', 'message', { whileWorking: true });
    await new Promise((r) => setTimeout(r, 20));
    ptys[1].emit(screenOf([SUGGESTION], WORKING));
    expect(await now).toBe('typed');
    expect(ptys[1].written).toEqual(['\x1b[200~message\x1b[201~', '\x18', '\x13']); // the chord as two key presses (U-31)
    // A phone-width viewer folds the spinner line in two: still a running turn (10-22 20:57).
    const folded = chat.type('a0000016', 'message', { whileWorking: true });
    await new Promise((r) => setTimeout(r, 20));
    ptys[ptys.length - 1].emit(
      screenOf([SUGGESTION], '✻ Combobulating… (12s · esc to\r\ninterrupt)'),
    );
    expect(await folded).toBe('typed');
    expect(ptys[2].written.slice(-2)).toEqual(['\x18', '\x13']);
    // No turn running: a 즉시 보내기 is submitted with Enter like any message.
    const idle = chat.type('a0000016', 'message', { whileWorking: true });
    await new Promise((r) => setTimeout(r, 20));
    ptys[3].emit(screenOf([SUGGESTION]));
    expect(await idle).toBe('typed');
    expect(ptys[3].written).toEqual(['\x1b[200~message\x1b[201~', '\r']);
  });

  it('U-31: the engine says busy though no spinner text is recognised: chat:sendNow anyway; Enter that only queued is followed by the chord', async () => {
    const { chat, ptys } = make(draftScreen, true);
    const busy = chat.type('a0000016', 'message', { whileWorking: true, busy: true });
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(screenOf([SUGGESTION]));
    expect(await busy).toBe('typed');
    expect(ptys[0].written).toEqual(['\x1b[200~message\x1b[201~', '\x18', '\x13']);
    // Not known busy: Enter, then Claude Code shows its queued hint, so the chord follows.
    const queued = chat.type('a0000016', 'message', { whileWorking: true });
    await new Promise((r) => setTimeout(r, 20));
    ptys[1].emit(screenOf([SUGGESTION]));
    await waitFor(() => expect(ptys[1].written).toContain('\r'));
    ptys[1].emit(screenOf([SUGGESTION], 'Press Ctrl+X Ctrl+S to send now'));
    expect(await queued).toBe('typed');
    expect(ptys[1].written.slice(-2)).toEqual(['\x18', '\x13']);
  });

  it('a question dialog mid-turn: nothing written, even whileWorking', async () => {
    const { chat, ptys } = make();
    const typed = chat.type('a0000016', 'message', { whileWorking: true });
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(WORKING_DIALOG);
    expect(await typed).toBe('notReady');
    expect(ptys[0].written).toEqual([]);
  });

  it('Enter only when the input line shows our paste: a dialog-shaped screen instead, no Enter', async () => {
    // A question dialog whose last option sits right under a rule: an "input row", not ours.
    const { chat, ptys } = make(() => screenOf(['❯ 3. Chat about this']));
    const typed = chat.type('a0000016', '[사장 · 메신저 · 10-22 11:32]\n배포해 줘');
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(screenOf([SUGGESTION]));
    expect(await typed).toBe('notReady');
    expect(ptys[0].written).toEqual(['\x1b[200~[사장 · 메신저 · 10-22 11:32]\r배포해 줘\x1b[201~']);
  });

  it('Enter for our draft shown: Korean text, a wrapped line, the long-paste placeholder', async () => {
    const korean = '[사장 · 메신저 · 10-22 11:32]\n배포 상태 알려줘';
    const long = Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n');
    for (const [text, shows] of [
      [korean, draftScreen],
      ['한글로 아주 긴 첫 줄이 화면 너비를 넘어 다음 줄로 접혀서 보이는 메시지입니다', draftScreen],
      [long, () => screenOf(['❯ [Pasted text #1 +12 lines]\x1b[7m \x1b[27m'])],
    ] as const) {
      const { chat, ptys } = make(shows, true);
      const typed = chat.type('a0000016', text);
      await new Promise((r) => setTimeout(r, 20));
      ptys[0].emit(screenOf([SUGGESTION]));
      expect(await typed).toBe('typed');
      expect(ptys[0].written.at(-1)).toBe('\r');
    }
  });

  it('a 20,000-character message: pasted whole, its placeholder is our paste, one Enter (U-37)', async () => {
    const big = `[cld-gui · ops에게서 · 10-22 11:57]\n${'배포 상태를 알려줘 '.repeat(2_000)}`.slice(
      0,
      20_000,
    );
    const { chat, ptys } = make((paste) =>
      screenOf([`❯ [Pasted text #1 +${paste.split('\r').length - 1} lines]\x1b[7m \x1b[27m`]),
      true,
    );
    const typed = chat.type('a0000016', big);
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(screenOf([SUGGESTION]));
    expect(await typed).toBe('typed');
    expect(ptys[0].written).toEqual([`\x1b[200~${big.replaceAll('\n', '\r')}\x1b[201~`, '\r']);
  });

  it('a placeholder is no proof for a short message of ours: no Enter (U-37)', async () => {
    const { chat, ptys } = make(() => screenOf(['❯ [Pasted text #1 +12 lines]\x1b[7m \x1b[27m']));
    const typed = chat.type('a0000016', '배포해 줘');
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(screenOf([SUGGESTION]));
    expect(await typed).toBe('notReady');
    expect(ptys[0].written).toEqual(['\x1b[200~배포해 줘\x1b[201~']);
  });

  it("a placeholder-only draft: our earlier long message's, Enter; a stranger's paste, untouched (U-37)", async () => {
    const earlier = `[cld-gui · ops에게서 · 10-22 11:57]\n${'긴 글 '.repeat(400)}`;
    const placeholder = screenOf(['❯ [Pasted text #1]\x1b[7m \x1b[27m']);
    const mine = make();
    const first = mine.chat.type('a0000016', '다음 글', { earlier: [earlier] });
    mine.ptys[0].echo = (data) => (data === '\r' ? screenOf([SUGGESTION]) : undefined);
    await new Promise((r) => setTimeout(r, 20));
    mine.ptys[0].emit(placeholder);
    expect(await first).toBe('notReady');
    expect(mine.ptys[0].written).toEqual(['\r']);
    // The same box with only short messages of ours known: not ours, nothing written.
    const other = make();
    const second = other.chat.type('a0000016', '다음 글', { earlier: ['짧은 글'] });
    await new Promise((r) => setTimeout(r, 20));
    other.ptys[0].emit(placeholder);
    expect(await second).toBe('notReady');
    expect(other.ptys[0].written).toEqual([]);
  });

  it('a paste that takes 1 s to show: waited for, then Enter', async () => {
    const { chat, ptys } = make(draftScreen, true);
    const typed = chat.type('a0000016', '[cld-gui · ops에게서 · 10-22 11:57]\n첫 줄\n둘째 줄');
    const pty = ptys[0];
    pty.echo = (data) => {
      if (data.startsWith('\x1b[200~'))
        setTimeout(() => pty.emit(draftScreen(data.slice(6, -6))), 1_000);
      return undefined;
    };
    await new Promise((r) => setTimeout(r, 20));
    pty.emit(screenOf([SUGGESTION]));
    expect(await typed).toBe('typed');
    expect(pty.written.at(-1)).toBe('\r');
  });

  it.each([
    ['[cld-gui · ops에게서 · 10-22 11:57]'],
    ['[cld-gui · ops에게서 · 10-22 11:57] ⟨m:ab2cd3ef⟩'], // C2: the mark is part of the header line
  ])('a long draft scrolled in its box (the ❯ row shows a later line): ours, Enter (%s)', async (head) => {
    const body = Array.from({ length: 6 }, (_, i) => `${i + 1}번째 줄은 배포 상태를 정리한 내용`);
    const text = [head, ...body].join('\n');
    const { chat, ptys } = make((paste) => draftScreen(paste.split('\r').slice(2).join('\r')), true);
    const typed = chat.type('a0000016', text);
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(screenOf([SUGGESTION]));
    expect(await typed).toBe('typed');
    expect(ptys[0].written.at(-1)).toBe('\r');
  });

  it('our own draft left in the box by an earlier try: Enter only (no second paste), delivered', async () => {
    const text = '[cld-gui · ops에게서 · 10-22 11:57]\n배포 상태를 정리해 줘';
    const { chat, ptys } = make(draftScreen, true);
    const typed = chat.type('a0000016', text);
    const pty = ptys[0];
    pty.echo = (data) => {
      if (data === '\r') return screenOf([SUGGESTION]);
      if (data.startsWith('\x1b[200~')) return draftScreen(data.slice(6, -6));
      return undefined;
    };
    await new Promise((r) => setTimeout(r, 20));
    pty.emit(draftScreen(text.replaceAll('\n', '\r')));
    expect(await typed).toBe('typed');
    expect(pty.written).toEqual(['\r']);
  });

  it("an earlier message's exact draft: Enter it, then leave this message for the next try", async () => {
    const earlier = '[cld-gui · ops에게서 · 10-22 11:57]\n배포 상태를 정리해 줘';
    const current = '[cld-gui · beta에게서 · 10-22 14:56]\n다음 배포도 확인해 줘';
    const { chat, ptys } = make(draftScreen, true);
    const first = chat.type('a0000016', current, { earlier: [earlier] });
    const pty = ptys[0];
    pty.echo = (data) => {
      if (data === '\r') return screenOf([SUGGESTION]);
      if (data.startsWith('\x1b[200~')) return draftScreen(data.slice(6, -6));
      return undefined;
    };
    await new Promise((r) => setTimeout(r, 20));
    pty.emit(draftScreen(earlier.replaceAll('\n', '\r')));
    expect(await first).toBe('notReady');
    expect(pty.written).toEqual(['\r']);

    const second = chat.type('a0000016', current);
    const nextPty = ptys[1];
    nextPty.echo = (data) => {
      if (data === '\r') return screenOf([SUGGESTION]);
      if (data.startsWith('\x1b[200~')) return draftScreen(data.slice(6, -6));
      return undefined;
    };
    nextPty.emit(screenOf([SUGGESTION]));
    expect(await second).toBe('typed');
    expect(nextPty.written).toEqual([`\x1b[200~${current.replaceAll('\n', '\r')}\x1b[201~`, '\r']);
  });

  it("without an earlier-draft history, another message's draft stays stuck", async () => {
    const earlier = '[cld-gui · ops에게서 · 10-22 11:57]\n배포 상태를 정리해 줘';
    const { chat, ptys } = make();
    const typed = chat.type(
      'a0000016',
      '[cld-gui · beta에게서 · 10-22 14:56]\n다음 배포도 확인해 줘',
    );
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(draftScreen(earlier.replaceAll('\n', '\r')));
    expect(await typed).toBe('notReady');
    expect(ptys[0].written).toEqual([]);
  });

  it("an earlier draft with added words, or a stranger's draft: untouched", async () => {
    const earlier = '[cld-gui · ops에게서 · 10-22 11:57]\n배포 상태를 정리해 줘';
    const current = '[cld-gui · beta에게서 · 10-22 14:56]\n다음 배포도 확인해 줘';
    for (const box of [
      draftScreen(`${earlier.replaceAll('\n', '\r')} 그리고 하나 더`),
      draftScreen('지금 쓰고 있는 다른 글이에요'),
    ]) {
      const { chat, ptys } = make();
      const typed = chat.type('a0000016', current, { earlier: [earlier] });
      await new Promise((r) => setTimeout(r, 20));
      ptys[0].emit(box);
      expect(await typed).toBe('notReady');
      expect(ptys[0].written).toEqual([]);
    }
  });

  it('a draft someone is typing that is only part of our message (earlier or this one): untouched', async () => {
    const earlier = '[cld-gui · ops에게서 · 10-22 11:57]\n배포 상태를 정리해 줘';
    const current = '[cld-gui · beta에게서 · 10-22 14:56]\n다음 배포도 확인해 줘';
    for (const box of [
      draftScreen('배포 상태를'), // the start of its body, typed by hand
      draftScreen('배'), // one letter
      draftScreen('[cld-gui · ops에게서 · 10-22 11:57]'), // its header line alone
      draftScreen('[cld-gui · ops에게서 · 10-22 11:57]\r배포'), // cut short
      draftScreen('다음 배포도'), // the start of THIS message's body, typed by hand
    ]) {
      const { chat, ptys } = make();
      const typed = chat.type('a0000016', current, { earlier: [earlier] });
      await new Promise((r) => setTimeout(r, 20));
      ptys[0].emit(box);
      expect(await typed).toBe('notReady');
      expect(ptys[0].written).toEqual([]);
    }
  });

  it("our draft with someone's words added, or a stranger's draft: untouched", async () => {
    const text = '[cld-gui · ops에게서 · 10-22 11:57]\n배포 상태를 정리해 줘';
    for (const box of [
      draftScreen(`${text.replaceAll('\n', '\r')} 그리고 하나 더`),
      draftScreen('지금 쓰고 있는 다른 글이에요'),
    ]) {
      const { chat, ptys } = make();
      const typed = chat.type('a0000016', text);
      await new Promise((r) => setTimeout(r, 20));
      ptys[0].emit(box);
      expect(await typed).toBe('notReady');
      expect(ptys[0].written).toEqual([]);
    }
  });

  it('a draft on screen: nothing written', async () => {
    const { chat, ptys } = make();
    const typed = chat.type('a0000016', 'message');
    await new Promise((r) => setTimeout(r, 20));
    ptys[0].emit(screenOf(['❯ half a thought\x1b[7m \x1b[27m']));
    expect(await typed).toBe('notReady');
    expect(ptys[0].written).toEqual([]);
  });
});

describe('chat route', () => {
  let server: HttpServerHandle | undefined;
  const savedEnv = { ...process.env };
  afterEach(async () => {
    await server?.app.close();
    server = undefined;
    process.env = { ...savedEnv };
  });

  async function start(chat?: ChatManager) {
    const auth = new StandaloneAuth();
    server = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      token: 'test-server-token',
      store: new AgentStateStore(),
      auth,
      chat,
    });
    return { port: server.port, cookie: `cld_session=${auth.createSession().id}` };
  }

  /** Upgrade status, or the close code once opened. */
  function attempt(port: number, id: string, headers: Record<string, string>) {
    return new Promise<{ status?: number; close?: number }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/cld/attach/${id}`, { headers });
      ws.once('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode });
        ws.terminate();
      });
      ws.once('close', (code) => resolve({ close: code }));
      ws.once('error', () => undefined);
      setTimeout(() => reject(new Error('timed out')), 30_000); // a guard against a hang only: the upgrade answers at once
    });
  }

  it('chat off: no route answers, even for a logged-in browser', async () => {
    const { port, cookie } = await start();
    expect(await attempt(port, 'a0000016', { cookie })).toEqual({ status: 404 });
  });

  it("/api/chat-attaches: a login to read, the page's own origin to change, 1 to 4 only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-chat-cap-'));
    const t = setup({ settingsFile: path.join(dir, 'terminal.json') });
    const { port, cookie } = await start(t.chat);
    const url = `http://127.0.0.1:${String(port)}/api/chat-attaches`;
    const ok = {
      cookie,
      origin: `http://127.0.0.1:${String(port)}`,
      'content-type': 'application/json',
    };
    expect((await fetch(url)).status).toBe(401);
    const got = await fetch(url, { headers: { cookie } });
    expect(await got.json()).toEqual({ attaches: 1, default: 1, min: 1, max: 4, live: 0 });
    const put = (attaches: unknown, headers: Record<string, string> = ok) =>
      fetch(url, { method: 'PUT', headers, body: JSON.stringify({ attaches }) });
    expect((await put(2, { 'content-type': 'application/json' })).status).toBe(401);
    expect((await put(2, { ...ok, origin: 'http://evil.example' })).status).toBe(403);
    for (const bad of [0, 5, '3', null]) expect((await put(bad)).status, String(bad)).toBe(400);
    expect(t.chat.maxAttaches).toBe(1);
    expect((await put(3)).status).toBe(200);
    expect(t.chat.maxAttaches).toBe(3);
    expect((await (await fetch(url, { headers: { cookie } })).json()).attaches).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the /ws gate: no cookie, a wrong one or a token are 401; a foreign Origin closes 4003', async () => {
    const t = setup();
    const { port, cookie } = await start(t.chat);
    expect(await attempt(port, 'a0000016', {})).toEqual({ status: 401 });
    expect(await attempt(port, 'a0000016', { cookie: 'cld_session=forged' })).toEqual({
      status: 401,
    });
    expect(await attempt(port, 'a0000016?token=test-server-token', {})).toEqual({ status: 401 });
    expect(await attempt(port, 'a0000016', { cookie, origin: 'http://evil.example' })).toEqual({
      close: WS_CLOSE_FORBIDDEN_ORIGIN,
    });
    expect(t.spawns).toHaveLength(0);
    expect(t.listCalls()).toBe(0);
  });

  it('streams the fake claude attach end to end (prompt, echo, resize, filters, exit on leave)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-chat-'));
    process.env.FAKE_CLAUDE_SCENARIO = path.join(FAKE_CLAUDE, 'S-chat'); // live pids
    process.env.FAKE_CLAUDE_LOG = path.join(home, 'claude.log');
    const logs: string[] = [];
    // Real PTY (node-pty) and the fake claude script; nothing else is run.
    const chat = new ChatManager({
      claudePath: path.join(FAKE_CLAUDE, fakeBin('claude')),
      home: HOME,
      env: { FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG! },
      log: (l) => logs.push(l),
    });
    const { port, cookie } = await start(chat);
    const url = (id: string) =>
      `ws://127.0.0.1:${String(port)}/cld/attach/${encodeURIComponent(id)}`;
    // ...also old-job: a background row without a pid (killed by a reboot).
    for (const id of ['abc; touch PWNED', '$(touch PWNED)', '-h', 'a0000001', 'a0000018']) {
      expect(await attempt(port, encodeURIComponent(id), { cookie })).toEqual({
        close: WS_CLOSE_NO_SESSION,
      });
    }
    const ws = new WebSocket(url('a0000016'), {
      headers: { cookie, 'user-agent': 'Mozilla/5.0 (iPhone)' },
    });
    let text = '';
    ws.on('message', (raw) => {
      text += (JSON.parse(String(raw)) as { data?: string }).data ?? '';
    });
    const send = (frame: Record<string, unknown>) => ws.send(JSON.stringify(frame));
    const input = (data: string) => send({ type: 'input', data });
    const attachRunning = () =>
      spawnSync('pgrep', ['-f', `${FAKE_CLAUDE}/attach.cjs a0000016`]).status === 0;
    try {
      await waitFor(() => expect(text).toContain('fake claude attach a0000016'));
      expect(attachRunning()).toBe(true);
      send({ type: 'resize', cols: 100, rows: 30 });
      await waitFor(() => expect(text).toContain('[size 100x30]'));
      input('\x1a'); // would make the fake exit
      input('SECRET-1234');
      await waitFor(() => expect(text).toContain('> SECRET-1234'));
      input('\r');
      await waitFor(() => expect(text).toContain('you said: SECRET-1234'));
      input('\x1b[D');
      await waitFor(() => expect(text).toContain('go back to agents'));
      await parsed();
      input('\x1b[D'); // dropped: would draw the agent view
      input('ok\r');
      await waitFor(() => expect(text).toContain('you said: ok'));
      expect(text).not.toContain('space to reply');
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
    await waitFor(() => expect(attachRunning()).toBe(false));
    expect(chat.size).toBe(0);
    expect(fs.readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf-8').split('\n')).toEqual([
      'agents --json', // a0000001: well-formed, so it is looked up (and refused)
      'agents --json', // a0000018: listed, but no pid
      'agents --json',
      'attach a0000016',
      '',
    ]);
    expect(logs.filter((l) => !l.startsWith('refused'))).toEqual([
      'attach "beta-task" gui:ios',
      expect.stringMatching(/^detach "beta-task" gui:ios after \d+s$/),
    ]);
    expect(logs.join('\n')).not.toContain('SECRET-1234');
    expect(fs.existsSync(path.join(os.homedir(), 'PWNED'))).toBe(false);
    // A real `fake claude` process is started and stopped here; on a starved CPU that outlasts 10 s.
  }, 60_000);
});
