import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PtySessionManager } from '../../terminal/ptySessionManager.js';
import { ClaudePtyAgent } from '../engine/agents/claude/claudePty.js';
import { PtyHostClient } from '../ptyhost/client.js';
import { ptyhostPaths } from '../ptyhost/protocol.js';
import { testPtyHost } from '../testHome.js';
import { ShellRegistry } from './registry.js';

const until = async (check: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !check(); ) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Joins shell `id` and types `line`; returns what it printed so far. */
const run = async (r: ShellRegistry, id: string, line: string) => {
  let text = '';
  const s = await r.join(id, (d) => (text += d), () => undefined);
  if (!s) throw new Error(`no shell ${id}`);
  s.write(`${line}\r`);
  return { text: () => text, stream: s };
};
const pidOf = async (r: ShellRegistry, id: string) => {
  const got = await run(r, id, 'echo "pid:$$:end"');
  await until(() => /pid:\d+:end/.test(got.text()));
  got.stream.off();
  return /pid:(\d+):end/.exec(got.text())![1];
};

/** HOME and SHELL for the login shell: a temp home's profile, /bin/sh. */
function tempHome(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'work'));
  const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL };
  process.env.HOME = root;
  process.env.SHELL = '/bin/sh';
  return {
    root,
    file: path.join(root, 'config', 'shells.json'),
    restore: () => {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const posix = process.platform === 'win32' ? describe.skip : describe;

posix('shells in our PTY host', () => {
  let kit: ReturnType<typeof testPtyHost>;
  let home: ReturnType<typeof tempHome>;
  const registries: ShellRegistry[] = [];
  const clients: PtyHostClient[] = [];

  beforeAll(() => {
    kit = testPtyHost();
    home = tempHome('agty-registry-host-');
    process.env.AGTY_REGISTRY_TEST_SECRET = 'service-only-value';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  }, 60_000);
  afterEach(async () => {
    for (const r of registries.splice(0)) {
      for (const s of r.list()) r.close(s.id);
      await r.disposeAll();
    }
  });
  afterAll(async () => {
    // Shells closed above; give the kills a moment, then the hosts this test started go.
    await new Promise((r) => setTimeout(r, 200));
    for (const c of clients) c.dispose();
    kit.done();
    vi.restoreAllMocks();
    delete process.env.AGTY_REGISTRY_TEST_SECRET;
    home.restore();
  });

  const client = () => {
    const c = new PtyHostClient({ home: home.root, launch: kit.launch(home.root), log: () => undefined });
    clients.push(c);
    return c;
  };
  const make = (host: PtyHostClient, idleMs = 30 * 60_000) => {
    const r = new ShellRegistry(new PtySessionManager(), undefined, Date.now, idleMs, {
      host,
      file: home.file,
    });
    registries.push(r);
    return { r };
  };
  const listed = () =>
    JSON.parse(fs.readFileSync(ptyhostPaths(home.root).terminals, 'utf8')) as Array<{
      id: string;
      meta: Record<string, string>;
    }>;

  it('a new shell lands in the host, marked a shell (the engine does not see it), with no tmux lookup', async () => {
    const host = client();
    const { r } = make(host);
    const work = path.join(home.root, 'work');
    const shell = await r.open('dev', 'handle', 'Laptop', work);
    const row = JSON.parse(fs.readFileSync(home.file, 'utf8')).shells[0];
    expect(row).toMatchObject({ id: shell.id, deviceId: 'dev', sessionHandle: 'handle', cwd: work });
    expect(listed()).toEqual([expect.objectContaining({ id: row.terminal, meta: { kind: 'shell', shell: shell.id } })]);
    expect(fs.statSync(home.file).mode & 0o777).toBe(0o600);
    // The engine's view of the same host: no agent terminal there.
    const engine = new ClaudePtyAgent({
      claudePath: '/nonexistent',
      home: home.root,
      env: {},
      systemdRun: null,
      agtyBin: null,
      hostScript: null,
      log: () => undefined,
      client: host,
    });
    expect(engine.terminals()).toEqual([]);
    expect(engine.has(row.terminal)).toBe(false);
    // Its folder, and the login environment only (the daemon's own variables stay out).
    const got = await run(r, shell.id, 'pwd; echo "[$AGTY_REGISTRY_TEST_SECRET]"');
    await until(() => got.text().includes('[]'));
    expect(got.text()).toContain(fs.realpathSync(work));
    expect(got.text()).not.toContain('service-only-value');
  });

  it('a restart keeps the shell: the same pid and owner, input and output again; exit ends it', async () => {
    const first = make(client()).r;
    const shell = await first.open('dev', 'handle', 'Laptop', path.join(home.root, 'work'));
    const pid = await pidOf(first, shell.id);
    await first.disposeAll(); // the deploy: the daemon's side goes, the host keeps the shell
    clients.at(-1)!.dispose();
    registries.splice(registries.indexOf(first), 1);

    const { r: second } = make(client());
    expect(second.restore()).toBe(1);
    expect(second.ownedBy(shell.id, 'dev', 'handle')).toBe(true);
    expect(second.ownedBy(shell.id, 'dev', 'someone-else')).toBe(false);
    expect(second.list()).toEqual([expect.objectContaining({ id: shell.id, label: 'Laptop' })]);
    expect(await pidOf(second, shell.id)).toBe(pid);

    const reasons: Array<[string, number | undefined]> = [];
    second.onClose(shell.id, (reason, code) => reasons.push([reason, code]));
    await run(second, shell.id, 'exit 3');
    await until(() => second.list().length === 0);
    expect(reasons).toEqual([['exit', 3]]);
    expect(JSON.parse(fs.readFileSync(home.file, 'utf8')).shells).toEqual([]);
  });

  it('closing kills the terminal; at start a host shell no row names is killed', async () => {
    const host = client();
    const { r } = make(host);
    const a = await r.open('dev', 'h', 'A', path.join(home.root, 'work'));
    const t = listed().find((x) => x.meta.shell === a.id)!.id;
    expect(r.close(a.id)).toBe(true);
    await until(() => !listed().some((x) => x.id === t));

    const b = await r.open('dev', 'h', 'B', path.join(home.root, 'work'));
    const tb = listed().find((x) => x.meta.shell === b.id)!.id;
    await r.disposeAll();
    registries.splice(registries.indexOf(r), 1);
    fs.writeFileSync(home.file, JSON.stringify({ version: 1, shells: [] }));
    const { r: again } = make(host);
    expect(again.restore()).toBe(0);
    await until(() => !listed().some((x) => x.id === tb));
  });
});

describe('a row an older tmux version wrote', () => {
  it('is not restored: shells.json rows without a host terminal are dropped (T-83)', () => {
    const home = tempHome('agty-registry-tmux-');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      fs.mkdirSync(path.dirname(home.file), { recursive: true });
      const row = { id: crypto.randomBytes(18).toString('base64url'), deviceId: 'dev', sessionHandle: 'h', label: 'Old', cwd: home.root, openedAt: 1, lastActivity: Date.now() };
      fs.writeFileSync(home.file, JSON.stringify({ version: 1, shells: [row] }));
      const r = new ShellRegistry(new PtySessionManager(), undefined, Date.now, 60_000, { file: home.file });
      expect(r.restore()).toBe(0);
      expect(r.list()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      home.restore();
    }
  });
});

describe('without a host', () => {
  it('a plain shell in the daemon, and nothing is persisted', async () => {
    const home = tempHome('agty-registry-plain-');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = new ShellRegistry(new PtySessionManager(), undefined, Date.now, 60_000, { file: home.file });
    try {
      const s = await r.open('dev', 'h', 'A', home.root);
      expect(await pidOf(r, s.id)).toMatch(/^\d+$/);
      expect(JSON.parse(fs.readFileSync(home.file, 'utf8')).shells).toEqual([]);
      expect(r.restore()).toBe(0);
    } finally {
      await r.disposeAll();
      vi.restoreAllMocks();
      home.restore();
    }
  });
});
