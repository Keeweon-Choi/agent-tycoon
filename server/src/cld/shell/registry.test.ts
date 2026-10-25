import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PtySessionManager } from '../../terminal/ptySessionManager.js';
import { NO_TMUX_NOTICE, ShellRegistry } from './registry.js';
import {
  findTmux,
  SHELL_TMUX_SOCKET,
  SHELL_TMUX_SOCKET_ENV,
  Tmux,
  tmuxSocketName,
} from './tmux.js';

describe('the tmux argv', () => {
  const calls: string[][] = [];
  const fake = new Tmux('/usr/bin/tmux', SHELL_TMUX_SOCKET, (_bin, argv) => {
    calls.push(argv);
    return { status: 0, stdout: 'a\nb\n' };
  });

  it('every call names our own socket and no config, and addresses a session by exact name', () => {
    fake.newSession('id1', {
      cols: 80,
      rows: 24,
      cwd: '/w',
      command: '/bin/sh',
      args: ['-l'],
      env: { HOME: '/h', PATH: '/bin' },
    });
    fake.hasSession('id1');
    fake.killSession('id1');
    expect(fake.sessions()).toEqual(new Set(['a', 'b']));
    expect(fake.attachCommand('id1')).toEqual({
      file: '/usr/bin/tmux',
      args: ['-L', 'cld-gui-shell', '-f', '/dev/null', '-u', 'attach-session', '-t', '=id1'],
    });
    expect(calls).toHaveLength(4);
    for (const argv of calls)
      expect(argv.slice(0, 4)).toEqual(['-L', 'cld-gui-shell', '-f', '/dev/null']);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        'new-session',
        '-d',
        '-s',
        'id1',
        '-c',
        '/w',
        '-e',
        'HOME=/h',
        '--',
        '/bin/sh',
        '-l',
      ]),
    );
    expect(calls[1]).toEqual([
      '-L',
      'cld-gui-shell',
      '-f',
      '/dev/null',
      'has-session',
      '-t',
      '=id1',
    ]);
    expect(calls[2]).toEqual([
      '-L',
      'cld-gui-shell',
      '-f',
      '/dev/null',
      'kill-session',
      '-t',
      '=id1',
    ]);
  });

  it('the socket is ours unless the environment names a cld-test- one', () => {
    expect(tmuxSocketName({})).toBe('cld-gui-shell');
    expect(tmuxSocketName({ [SHELL_TMUX_SOCKET_ENV]: 'cld-test-abc123' })).toBe('cld-test-abc123');
    for (const bad of ['default', 'office', 'cld-gui-shell2', 'cld-test-', '../x', 'cld-test-a b'])
      expect(tmuxSocketName({ [SHELL_TMUX_SOCKET_ENV]: bad }), bad).toBe('cld-gui-shell');
  });

  it('kill-server only on a test socket', () => {
    expect(() => fake.killServer()).toThrow();
  });
});

const tmuxBin = findTmux();
const real = tmuxBin ? describe : describe.skip;

real('shells in a real tmux server (a test socket of their own)', () => {
  const socket = `cld-test-${crypto.randomBytes(6).toString('hex')}`;
  let tmux: Tmux;
  let root: string;
  let file: string;
  const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL };
  const registries: ShellRegistry[] = [];

  beforeAll(() => {
    tmux = new Tmux(tmuxBin!, socket);
  });
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.disposeAll();
    vi.restoreAllMocks();
    for (const s of tmux.sessions()) tmux.killSession(s);
    fs.rmSync(root, { recursive: true, force: true });
  });
  afterAll(() => {
    tmux.killServer();
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  const make = (idleMs = 30 * 60_000, now = Date.now) => {
    if (!root || !fs.existsSync(root)) {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-registry-test-'));
      file = path.join(root, 'config', 'shells.json');
      fs.mkdirSync(path.join(root, 'work'));
      process.env.HOME = root;
      process.env.SHELL = '/bin/sh';
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
    }
    const r = new ShellRegistry(new PtySessionManager(), undefined, now, idleMs, { tmux, file });
    registries.push(r);
    return r;
  };
  const until = async (check: () => boolean, ms = 8_000) => {
    for (const end = Date.now() + ms; !check();) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const run = async (r: ShellRegistry, id: string, line: string) => {
    let text = '';
    r.get(id)!.onData((d) => (text += d));
    r.get(id)!.write(`${line}\r`);
    return () => text;
  };
  const pidOf = async (r: ShellRegistry, id: string) => {
    const out = path.join(root, `pid-${crypto.randomBytes(3).toString('hex')}`);
    await run(r, id, `echo $$ > ${out}`);
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim() !== '');
    return fs.readFileSync(out, 'utf8').trim();
  };

  it('a shell runs inside tmux, and shells.json (0600) names it', async () => {
    const r = make();
    const work = path.join(root, 'work');
    const shell = r.open('dev', 'handle', 'Laptop', work);
    expect(tmux.hasSession(shell.id)).toBe(true);
    // The daemon's PTY is only the tmux client: a restart can drop it, the shell stays.
    expect(await pidOf(r, shell.id)).toMatch(/^\d+$/);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.shells).toHaveLength(1);
    expect(saved.shells[0]).toMatchObject({
      id: shell.id,
      deviceId: 'dev',
      sessionHandle: 'handle',
      cwd: work,
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(r.noticeFor(shell.id)).toBeUndefined();
  });

  it('a folder name is only a folder (no tmux format, no command separator), and Ctrl+B reaches the shell', async () => {
    const r = make();
    const marker = path.join(root, 'ran');
    const odd = path.join(root, `w#{session_name}#(touch ${path.basename(marker)})x;`);
    fs.mkdirSync(odd);
    const shell = r.open('dev', 'handle', 'Laptop', odd);
    expect(tmux.hasSession(shell.id)).toBe(true);
    const ask = (...rest: string[]) =>
      spawnSync(tmuxBin!, tmux.argv(...rest), { encoding: 'utf8' }).stdout.trim();
    expect(ask('display-message', '-p', '-t', `=${shell.id}:`, '#{pane_current_path}')).toBe(odd);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readdirSync(odd)).toEqual([]);
    // tmux takes no key and no right-click: the root table holds only its mouse plumbing.
    const rootKeys = ask('list-keys', '-T', 'root')
      .split('\n')
      .map((line) => line.split(/\s+/)[3]);
    expect(rootKeys.length).toBeGreaterThan(0);
    expect(rootKeys.filter((k) => !/Mouse|Wheel|Click/.test(k))).toEqual([]);
    expect(rootKeys).not.toContain('MouseDown3Pane');
    expect(rootKeys).not.toContain('M-MouseDown3Pane');
    // No prefix key: Ctrl+B is the shell's (readline's backward-char, vim, less).
    const got = path.join(root, 'keys');
    await run(r, shell.id, `cat > ${got}`);
    await new Promise((res) => setTimeout(res, 300));
    r.get(shell.id)!.write('\x02x\r\x04');
    await until(() => fs.existsSync(got) && fs.readFileSync(got, 'utf8').length >= 3);
    expect(fs.readFileSync(got, 'utf8')).toBe('\x02x\n');
  });

  it('a restart keeps the shell: the same pid, the same owner', async () => {
    const first = make();
    const shell = first.open('dev', 'handle', 'Laptop', path.join(root, 'work'));
    const pid = await pidOf(first, shell.id);
    await first.disposeAll(); // the deploy: the daemon's attach goes, the session stays
    expect(tmux.hasSession(shell.id)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).shells).toHaveLength(1);

    const second = make();
    expect(second.restore()).toBe(1);
    expect(second.ownedBy(shell.id, 'dev', 'handle')).toBe(true);
    expect(second.ownedBy(shell.id, 'dev', 'someone-else')).toBe(false);
    expect(second.list()).toEqual([expect.objectContaining({ id: shell.id, label: 'Laptop' })]);
    expect(await pidOf(second, shell.id)).toBe(pid);
  });

  it('start-up pruning: a missing session, junk rows and a corrupt file are dropped; an idle one is killed', async () => {
    const r = make(1_000, () => 10_000_000);
    const keep = r.open('dev', 'h', 'A', path.join(root, 'work'));
    await r.disposeAll();
    const idle = 'idleidleidleidleidle';
    const gone = 'gonegonegonegonegone';
    const row = (id: string, lastActivity: number) => ({
      id,
      deviceId: 'dev',
      sessionHandle: 'h',
      label: 'x',
      cwd: root,
      openedAt: 1,
      lastActivity,
    });
    tmux.newSession(idle, {
      cols: 80,
      rows: 24,
      cwd: root,
      command: '/bin/sh',
      args: ['-l'],
      env: { PATH: process.env.PATH! },
    });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      shells: Array<Record<string, unknown>>;
    };
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        shells: [
          ...saved.shells.map((s) => ({ ...s, lastActivity: 10_000_000 - 500 })),
          row(gone, 10_000_000), // its session is not there
          row(idle, 10_000_000 - 5_000), // there, but idle for longer than idleMs
          {
            id: '../../etc/passwd',
            deviceId: 'd',
            sessionHandle: 'h',
            label: '',
            cwd: root,
            openedAt: 1,
            lastActivity: 1,
          },
          { nonsense: true },
          null,
        ],
      }),
    );
    const again = make(1_000, () => 10_000_000);
    expect(again.restore()).toBe(1);
    expect(again.list().map((s) => s.id)).toEqual([keep.id]);
    expect(tmux.hasSession(idle)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(file, 'utf8')).shells.map((s: { id: string }) => s.id),
    ).toEqual([keep.id]);

    fs.writeFileSync(file, '{ not json');
    const third = make();
    expect(third.restore()).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ shells: 'no' }));
    expect(make().restore()).toBe(0);
  });

  it('closing kills the session; so do the idle timeout and a shell that exits by itself', async () => {
    const r = make(400);
    const closed: string[] = [];
    const a = r.open('dev', 'h', 'A', path.join(root, 'work'));
    r.onClose(a.id, (reason) => closed.push(reason));
    expect(r.close(a.id, 'requested')).toBe(true);
    expect(tmux.hasSession(a.id)).toBe(false);
    expect(closed).toEqual(['requested']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).shells).toEqual([]);

    const b = r.open('dev', 'h', 'B', path.join(root, 'work'));
    await until(() => r.list().length === 0, 3_000); // idleMs 400 and a prompt's output only
    expect(tmux.hasSession(b.id)).toBe(false);

    const long = make();
    const c = long.open('dev', 'h', 'C', path.join(root, 'work'));
    const reasons: string[] = [];
    long.onClose(c.id, (reason) => reasons.push(reason));
    long.get(c.id)!.write('exit\r');
    await until(() => long.list().length === 0);
    expect(reasons).toEqual(['exit']);
    expect(tmux.hasSession(c.id)).toBe(false);
  });

  it('a shell opens in its folder with the login environment only', async () => {
    process.env.CLD_REGISTRY_TEST_SECRET = 'service-only-value';
    try {
      const r = make();
      const work = path.join(root, 'work');
      const s = r.open('dev', 'h', 'A', work);
      const get = await run(r, s.id, 'pwd; echo "[$CLD_REGISTRY_TEST_SECRET]"');
      await until(() => get().includes('[]'));
      expect(get()).toContain(fs.realpathSync(work));
      expect(get()).not.toContain('service-only-value');
    } finally {
      delete process.env.CLD_REGISTRY_TEST_SECRET;
    }
  });
});

describe('without tmux', () => {
  it('a plain shell, said so in one line, and nothing is persisted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-registry-plain-'));
    const file = path.join(root, 'shells.json');
    const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL };
    process.env.HOME = root;
    process.env.SHELL = '/bin/sh';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = new ShellRegistry(new PtySessionManager(), undefined, Date.now, 60_000, { file });
    try {
      const s = r.open('dev', 'h', 'A', root);
      expect(r.noticeFor(s.id)).toBe(NO_TMUX_NOTICE);
      expect(r.get(s.id)!.hasExited).toBe(false);
      expect(fs.existsSync(file)).toBe(false);
      expect(r.restore()).toBe(0);
    } finally {
      await r.disposeAll();
      vi.restoreAllMocks();
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
