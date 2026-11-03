/**
 * TERM-P1 (ADR-0018): the host's wire framing, the OSC 7501 parser and probe order, and the host
 * itself (built with esbuild, its own process) running the fake interactive claude
 * (cld/test/fake-claude/pty-tui.cjs) in a temp HOME on its own socket.
 * TERM-P2: the endpoint per platform, Windows ConPTY's startup check; the host tests also run on
 * Windows (a named pipe, the same token check) and macOS in CI (.github/workflows/ci.yml, `ptyhost`).
 */
import { Terminal } from '@xterm/headless';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClaudePtyAgent } from '../engine/agents/claude/claudePty.js';
import { processAlive } from '../providers/claudeProvider.js';
import { FAKE_CLAUDE, makeEngineHome, removeTestHome, REPO_ROOT } from '../testHome.js';
import { PtyHostClient } from './client.js';
import type { StartingTerminal } from './conpty.js';
import { classifyConptyStartup, resetConptyTrust, spawnWithInputReader } from './conpty.js';
import { parseProgramStatus, PROBE_REPLY, watchProgramStatus } from './programStatus.js';
import { endpointFor, frame, lineReader, ptyhostPaths } from './protocol.js';

const WIN = process.platform === 'win32';

describe('endpoint per platform', () => {
  it('Linux and macOS: a socket in the 0700 folder; Windows: a named pipe no other user can name', () => {
    const dir = ptyhostPaths('/home/u').dir;
    for (const platform of ['linux', 'darwin'] as const) expect(endpointFor(dir, 't', platform)).toBe(path.join(dir, 'host.sock'));
    const win = 'C:\\Users\\u\\.config\\agent-tycoon\\ptyhost';
    const pipe = endpointFor(win, 't1', 'win32');
    expect(pipe).toMatch(/^\\\\\.\\pipe\\cld-gui-ptyhost-[0-9a-f]{16}$/);
    // Windows paths ignore case: one host per folder however it is spelled; another HOME, another pipe.
    expect(endpointFor('c:\\users\\U\\.config\\agent-tycoon\\ptyhost', 't1', 'win32')).toBe(pipe);
    expect(endpointFor('C:\\Users\\other\\.config\\agent-tycoon\\ptyhost', 't1', 'win32')).not.toBe(pipe);
    // The name needs the token (in the user's profile): another user cannot make the pipe first.
    expect(endpointFor(win, 't2', 'win32')).not.toBe(pipe);
  });
});

describe('Windows ConPTY startup check', () => {
  it('DA1 or CPR first (after visibility reports) reads input; other output first does not; a split sequence waits', () => {
    expect(classifyConptyStartup('\x1b[c')).toBe('input-reader');
    expect(classifyConptyStartup('\x1b[1t\x1b[6n rest')).toBe('input-reader');
    expect(classifyConptyStartup('\x1b[')).toBe('pending');
    expect(classifyConptyStartup('\x1b[2t')).toBe('pending');
    expect(classifyConptyStartup('\x1b]7501;?\x07\x1b[c')).toBe('no-input-reader');
    expect(classifyConptyStartup('hello')).toBe('no-input-reader');
  });

  /** A terminal whose first output is `first` (or nothing); disposing it exits it a little later. */
  const fake = (first: string | null, made: string[]) => {
    let exited: (() => void) | null = null;
    const t: StartingTerminal & { disposed: boolean } = {
      disposed: false,
      onData: (cb) => {
        if (first !== null) setTimeout(() => cb(first), 5);
        return () => undefined;
      },
      onExit: (cb) => {
        exited = cb;
        return () => (exited = null);
      },
      dispose: () => {
        t.disposed = true;
        setTimeout(() => {
          made.push('exit');
          exited?.();
        }, 20);
      },
    };
    made.push(first ?? 'silent');
    return t;
  };

  it('starts a silent ConPTY again once; turns the check off when no terminal ever asked', async () => {
    resetConptyTrust();
    const logs: string[] = [];
    const made: string[] = [];
    // Never asked anywhere: one respawn, then the check is off (a newer ConPTY, not a broken one).
    const outputs = ['claude', 'claude', 'claude'];
    let t = await spawnWithInputReader(() => fake(outputs.shift() ?? null, made), (l) => logs.push(l), 200);
    expect(made).toEqual(['claude', 'exit', 'claude']); // the first is gone before the second starts
    expect(logs.at(-1)).toMatch(/startup check off/);
    t = await spawnWithInputReader(() => fake(outputs.shift() ?? null, made), (l) => logs.push(l), 200);
    expect(made).toHaveLength(4); // off: handed out at once
    void t;

    resetConptyTrust();
    made.length = 0;
    logs.length = 0;
    const first = await spawnWithInputReader(() => fake('\x1b[c', made), (l) => logs.push(l), 200);
    expect(first.disposed).toBe(false);
    expect(logs).toEqual([]);
    // Once one asked, a silent one is broken: started again, and the first is disposed.
    const seq = ['x', '\x1b[c'];
    const kept: Array<ReturnType<typeof fake>> = [];
    const again = await spawnWithInputReader(
      () => {
        const f = fake(seq.shift() ?? null, made);
        kept.push(f);
        return f;
      },
      (l) => logs.push(l),
      200,
    );
    expect(kept[0].disposed).toBe(true);
    expect(again).toBe(kept[1]);
    // No output within the limit: handed out unchecked, not started again.
    const before = made.length;
    await spawnWithInputReader(() => fake(null, made), (l) => logs.push(l), 100);
    expect(made.length).toBe(before + 1);
    resetConptyTrust();
  });
});

describe('wire framing', () => {
  it('reads whole objects across chunks, UTF-8 split included, and skips junk', () => {
    const got: unknown[] = [];
    const feed = lineReader((m) => got.push(m), () => got.push('TOO LONG'));
    const bytes = Buffer.from(frame({ d: '한글 ✻' }) + 'not json\n[1]\n' + frame({ n: 2 }));
    for (let i = 0; i < bytes.length; i += 3) feed(bytes.subarray(i, i + 3));
    expect(got).toEqual([{ d: '한글 ✻' }, { n: 2 }]);
  });

  it('drops a line over the limit', () => {
    let tooLong = 0;
    const feed = lineReader(() => undefined, () => tooLong++);
    feed(Buffer.alloc(9 * 1024 * 1024, 'x'));
    expect(tooLong).toBe(1);
  });
});

describe('OSC 7501', () => {
  it('parses the probe, root reports and kinds; ignores sub-records and junk', () => {
    expect(parseProgramStatus('?')).toBe('query');
    expect(parseProgramStatus('state=idle:app=claude-code')).toEqual({ state: 'idle' });
    expect(parseProgramStatus('state=working:msg=aGk=')).toEqual({ state: 'working' });
    expect(parseProgramStatus('state=blocked:kind=permission:msg=eA==')).toEqual({ state: 'blocked', kind: 'permission' });
    expect(parseProgramStatus('state=done')).toEqual({ state: 'done' });
    expect(parseProgramStatus('state=clear')).toEqual({ state: 'clear' });
    expect(parseProgramStatus('state=idle:id=sub/1')).toBeNull();
    expect(parseProgramStatus('state=nope')).toBeNull();
    expect(parseProgramStatus('x'.repeat(5000))).toBeNull();
  });

  it('answers the probe before DA1 in one write, and reports split across chunks', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const wire: string[] = [];
    const reports: unknown[] = [];
    term.onData((d) => wire.push(d));
    watchProgramStatus(term, (d) => wire.push(d), (s) => reports.push(s));
    const write = (s: string) => new Promise<void>((r) => term.write(s, r));
    await write('\x1b]7501;?\x07\x1b[c');
    expect(wire[0]).toBe(PROBE_REPLY);
    expect(wire[1]).toMatch(/^\x1b\[\?[\d;]*c$/);
    for (const part of ['\x1b]75', '01;sta', 'te=blocked:ki', 'nd=question\x07']) await write(part);
    await write('\x1b]7501;state=done\x1b\\');
    expect(reports).toEqual([{ state: 'blocked', kind: 'question' }, { state: 'done' }]);
    term.dispose();
  });
});

describe('screen (COMPACT-COFFEE)', () => {
  it('a host from before the screen op: a subscription snapshot, dropped at once; another failure: null', async () => {
    const c = new PtyHostClient({ home: os.tmpdir(), launch: () => undefined, log: () => undefined });
    const offs: string[] = [];
    let reply: Record<string, unknown> = { ok: false, error: 'unknown op' };
    c.call = () => Promise.resolve(reply as never);
    c.subscribe = () => Promise.resolve({ snapshot: 'S', cols: 80, rows: 24, off: () => void offs.push('off') });
    expect(await c.screen('t1')).toMatchObject({ snapshot: 'S', cols: 80, rows: 24 });
    expect(offs).toEqual(['off']);
    reply = { ok: false, error: 'no terminal' };
    expect(await c.screen('t1')).toBeNull();
    expect(offs).toEqual(['off']);
  });
});

describe('the host', () => {
  let hostJs = '';
  let home = '';
  let claude = '';
  const hosts: ChildProcess[] = [];
  const launch = () => {
    const child = spawn(process.execPath, [hostJs, ptyhostPaths(home).dir], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NODE_PATH: path.join(REPO_ROOT, 'node_modules') },
    });
    child.unref();
    hosts.push(child);
  };
  const until = async (what: string, fn: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, 'utf-8');
    } catch {
      return '';
    }
  };

  beforeAll(() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-ptyhost-'));
    hostJs = path.join(out, 'cld-ptyhost.js');
    buildSync({
      entryPoints: [path.join(REPO_ROOT, 'server/src/cld/ptyhost/hostMain.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: hostJs,
      external: ['@lydell/node-pty', 'node-pty'],
      logLevel: 'silent',
    });
    ({ home, claudePath: claude } = makeEngineHome());
  }, 60_000);

  afterAll(() => {
    // Only the hosts this test started (their own ChildProcess handles).
    for (const h of hosts) if (h.exitCode === null) h.kill('SIGKILL');
    removeTestHome(home);
  });

  it('runs a fake claude: probe answered, session file, paste and Enter, survives a client, kill', async () => {
    const work = path.join(home, 'work');
    fs.mkdirSync(work, { recursive: true });
    const client = new PtyHostClient({ home, launch, log: () => undefined });
    // Windows: node itself (the fake's .cmd, whose pid is cmd.exe's, has its own test below).
    const r = await client.spawn({
      file: WIN ? process.execPath : claude,
      args: [...(WIN ? [path.join(FAKE_CLAUDE, 'engine.cjs')] : []), '-n', 'alpha', '--permission-mode', 'default'],
      cwd: work,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? '',
        TERM: 'xterm-256color',
        ...(WIN && { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }),
      },
      meta: { assignment: 'a-1' },
    });
    expect(r.ok).toBe(true);
    const id = r.id as string;
    const pid = r.pid as number;
    const sessFile = path.join(home, '.claude/sessions', `${pid}.json`);
    await until('session file', () => read(sessFile).includes('"status":"idle"'));
    await until('OSC idle', () => client.status.get(id)?.state === 'idle');
    expect(read(path.join(home, 'fake-pty-osc.log'))).toContain(`${pid} answered`);
    const listed = JSON.parse(read(ptyhostPaths(home).terminals)) as Array<{ id: string; pid: number; meta: object }>;
    expect(listed).toEqual([expect.objectContaining({ id, pid, meta: { assignment: 'a-1' } })]);

    const seen: string[] = [];
    const sub = await client.subscribe(id, (d) => seen.push(d), () => seen.push('END'));
    expect(sub?.snapshot).toContain('fake Claude Code (pty)');
    await client.write(id, '\x1b[200~hello 한글\x1b[201~');
    await new Promise((r) => setTimeout(r, 50));
    await client.write(id, '\r');
    await until('typed', () => read(path.join(home, 'fake-claude-typed.log')).includes('hello 한글'));
    await until('done', () => client.status.get(id)?.state === 'done');
    expect(seen.join('')).toContain('hello');
    // COMPACT-COFFEE: the visible screen alone, no subscription, no scrollback.
    const scr = await client.screen(id);
    expect(scr?.snapshot).toContain('fake Claude Code (pty)');
    expect(client.viewers(id)).toBe(1); // the subscription above only
    expect(await client.screen('nope')).toBeNull();

    // A second daemon (a restart): the same terminal, its status from the host's list.
    client.dispose();
    const again = new PtyHostClient({ home, launch, log: () => undefined });
    await again.connect(false);
    expect(again.status.get(id)?.state).toBe('done');
    expect((await again.call('list')).terminals).toEqual([expect.objectContaining({ id, pid })]);

    await again.call('kill', { t: id });
    // Windows ends the process outright: no signal, so the fake leaves its session file.
    if (!WIN) await until('session file gone', () => !fs.existsSync(sessFile));
    await until('list empty', () => read(ptyhostPaths(home).terminals).trim() === '[]');
    again.dispose();
  }, 60_000);

  it('any launcher (TERM-P2): Claude found by the session id it was started with, also when the terminal is a launcher holding Claude as its child', async () => {
    const work = path.join(home, 'work');
    fs.mkdirSync(work, { recursive: true });
    const bin = fs.mkdtempSync(path.join(home, 'launchers-'));
    const node = process.execPath;
    const engine = path.join(FAKE_CLAUDE, 'engine.cjs');
    const shim = (name: string, body: string) => {
      const f = path.join(bin, name);
      fs.writeFileSync(f, body, { mode: 0o755 });
      return f;
    };
    // Windows: npm's .cmd (cmd.exe holds node as its child), and node itself (the native binary's case).
    // Elsewhere: a launcher that execs (npm's symlink, nvm/asdf/mise) and one that waits on its child (bun, volta).
    const launchers: Array<{ kind: string; file: string; args: string[]; child: boolean }> = WIN
      ? [
          { kind: 'cmd', file: shim('claude.cmd', `@echo off\r\n"${node}" "${engine}" %*\r\n`), args: [], child: true },
          { kind: 'direct', file: node, args: [engine], child: false },
        ]
      : [
          { kind: 'exec', file: shim('claude-exec', `#!/bin/sh\nexec "${node}" "${engine}" "$@"\n`), args: [], child: false },
          { kind: 'child', file: shim('claude-child', `#!/bin/sh\n"${node}" "${engine}" "$@"\nexit $?\n`), args: [], child: true },
        ];
    const client = new PtyHostClient({ home, launch, log: () => undefined });
    const agent = new ClaudePtyAgent({
      claudePath: 'unused', home, env: {}, systemdRun: null, cldBin: null, hostScript: 'unused',
      log: () => undefined, client, platform: process.platform,
    });
    for (const l of launchers) {
      const session = randomUUID();
      const r = await client.spawn({
        file: l.file,
        // A settings argument as the engine passes it: quotes and a space must reach Claude whole.
        args: [...l.args, '-n', `l ${l.kind}`, '--settings', '{"a":"b c"}', '--session-id', session],
        cwd: work,
        env: {
          HOME: home,
          PATH: process.env.PATH ?? '',
          TERM: 'xterm-256color',
          ...(WIN && { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }),
        },
        meta: { assignment: `a-${l.kind}`, session },
      });
      expect(r.ok, l.kind).toBe(true);
      const id = r.id as string;
      await until(`${l.kind}: live`, () => agent.live().some((s) => s.id === id && s.sessionId === session));
      const s = agent.live().find((x) => x.id === id);
      expect(s, l.kind).toEqual(expect.objectContaining({ assignmentId: `a-${l.kind}`, name: `l ${l.kind}` }));
      if (l.child) expect(s?.pid, l.kind).not.toBe(r.pid);
      else expect(s?.pid, l.kind).toBe(r.pid);
      // Claude's own pid is ours too: the plain Claude provider leaves it out.
      expect(agent.pids().has(s?.pid ?? 0), l.kind).toBe(true);
      // Joined for good: a /clear (a new id in the same process) keeps it found, a restarted daemon too.
      const file = path.join(home, '.claude/sessions', `${s?.pid}.json`);
      fs.writeFileSync(file, read(file).replace(session, randomUUID()));
      const later = new ClaudePtyAgent({
        claudePath: 'unused', home, env: {}, systemdRun: null, cldBin: null, hostScript: 'unused',
        log: () => undefined, client, platform: process.platform,
      });
      expect(later.live().find((x) => x.id === id)?.pid, l.kind).toBe(s?.pid);
      await client.call('kill', { t: id });
      // Claude itself ends with its terminal, not only the launcher (Windows: ConPTY closing ends the console's processes).
      await until(`${l.kind}: Claude ended with its terminal`, () => !processAlive(s?.pid ?? 0));
      if (!WIN) expect(fs.existsSync(file), l.kind).toBe(false);
      await until(`${l.kind}: gone`, () => !agent.live().some((x) => x.id === id));
    }
    client.dispose();
  }, 60_000);

  it('a long message (5 KB and 20 KB, Korean, many lines) goes in whole and is submitted once, with the real timing', async () => {
    const work = path.join(home, 'work');
    fs.mkdirSync(work, { recursive: true });
    const client = new PtyHostClient({ home, launch, log: () => undefined });
    const agent = new ClaudePtyAgent({
      claudePath: 'unused', home, env: {}, systemdRun: null, cldBin: null, hostScript: 'unused',
      log: () => undefined, client, platform: process.platform,
    });
    const session = randomUUID();
    const r = await client.spawn({
      file: WIN ? process.execPath : claude,
      args: [...(WIN ? [path.join(FAKE_CLAUDE, 'engine.cjs')] : []), '-n', 'long', '--session-id', session],
      cwd: work,
      env: { HOME: home, PATH: process.env.PATH ?? '', TERM: 'xterm-256color', ...(WIN && { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }) },
      meta: { assignment: 'a-long', session },
    });
    expect(r.ok).toBe(true);
    const p = { projectId: 'p_long', leadAssignmentId: 'a-long', name: 'long', folder: work, wantRunning: true };
    await until('idle', () => agent.live().some((s) => s.id === r.id && s.status === 'idle'));
    const line = (i: number) => `${i}번째 줄: 긴 메시지가 잘리지 않고 한 번만 들어가는지 봅니다 (paste + Enter)`;
    const text = (bytes: number) => {
      const out: string[] = [];
      for (let i = 0; Buffer.byteLength(out.join('\n')) < bytes; i++) out.push(line(i));
      return out.join('\n');
    };
    const typedLog = path.join(home, 'fake-claude-typed.log');
    for (const t of [text(5_000), text(20_000)]) {
      const before = read(typedLog).split('\n').filter(Boolean).length;
      expect(await agent.deliver(p, t, {})).toBe('typed');
      await until('turn done', () => agent.live().some((s) => s.id === r.id && s.status === 'idle'));
      const got = read(typedLog).split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l) as { sessionId: string; text: string });
      expect(got.map((g) => g.text === t && g.sessionId === session)).toEqual([true]);
    }
    await client.call('kill', { t: r.id });
    client.dispose();
  }, 60_000);

  it('serves nobody without the token: a wrong one, or a request before hello, closes the socket unanswered', async () => {
    const client = new PtyHostClient({ home, launch, log: () => undefined });
    await client.connect(true); // a host is up
    const sockPath = endpointFor(ptyhostPaths(home).dir, fs.readFileSync(ptyhostPaths(home).token, 'utf-8').trim());
    // Windows: a named pipe (no file mode); the token in the user's profile is the gate.
    if (WIN) expect(sockPath).toMatch(/^\\\\\.\\pipe\\/);
    else {
      expect(fs.statSync(ptyhostPaths(home).dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(ptyhostPaths(home).token).mode & 0o777).toBe(0o600);
    }
    const token = fs.readFileSync(ptyhostPaths(home).token, 'utf-8').trim();
    const marker = path.join(home, 'spawned-without-token');
    const raw = (lines: object[]) =>
      new Promise<{ got: string; closed: boolean }>((resolve) => {
        const s = net.connect(sockPath);
        let got = '';
        let closed = false;
        s.on('data', (d) => (got += String(d)));
        s.on('close', () => (closed = true));
        s.on('error', () => undefined);
        s.on('connect', () => s.write(lines.map(frame).join('')));
        setTimeout(() => {
          s.destroy();
          resolve({ got, closed });
        }, 500);
      });
    const spawnReq = { r: 2, op: 'spawn', file: '/bin/sh', args: ['-c', `touch ${marker}`], cwd: home, env: {} };
    const wrong = token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    for (const lines of [[spawnReq], [{ r: 1, op: 'hello', token: wrong, version: 1 }, spawnReq], [{ r: 1, op: 'hello', version: 1 }, spawnReq]])
      expect(await raw(lines)).toEqual({ got: '', closed: true });
    expect(fs.existsSync(marker)).toBe(false);
    expect(read(ptyhostPaths(home).log)).not.toContain(token);
    expect((await raw([{ r: 1, op: 'hello', token, version: 1 }])).got).toContain('"ok":true');
    client.dispose();
  }, 30_000);

  it('with no terminal it ends after its idle time, though a daemon stays connected', async () => {
    const dir = path.join(home, 'idle-host');
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'token'), 'idle-token\n', { mode: 0o600 });
    const child = spawn(
      process.execPath,
      ['-e', `require(${JSON.stringify(hostJs)}).runHost(${JSON.stringify(dir)}, { idleMs: 300 })`],
      { stdio: 'ignore', env: { ...process.env, NODE_PATH: path.join(REPO_ROOT, 'node_modules') } },
    );
    hosts.push(child);
    const ep = endpointFor(dir, 'idle-token');
    await until('listening', () => read(path.join(dir, 'host.log')).includes('listening'));
    const sock = net.connect(ep);
    sock.on('error', () => undefined);
    sock.write(frame({ r: 1, op: 'hello', token: 'idle-token', version: 1 }));
    await until('host exits with the daemon still connected', () => child.exitCode !== null, 5_000);
    expect(child.exitCode).toBe(0);
    if (!WIN) expect(fs.existsSync(ep)).toBe(false);
    sock.destroy();
  }, 30_000);

  it('a second host on the same folder leaves; a stale socket is replaced', async () => {
    const before = hosts.length;
    launch();
    await until('second host exits', () => hosts[before].exitCode !== null);
    expect(hosts[before].exitCode).toBe(0);
    const first = hosts.find((h) => h.exitCode === null);
    first?.kill('SIGKILL');
    await until('first host gone', () => first?.exitCode !== null || first?.signalCode !== null);
    // Its socket file stays behind; a new client launches a host that replaces it.
    const client = new PtyHostClient({ home, launch, log: () => undefined });
    await client.connect(true);
    expect(client.connected).toBe(true);
    client.dispose();
  }, 30_000);
});
