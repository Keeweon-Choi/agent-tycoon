import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { parseServerFrame } from '../../../../core/src/terminalFrames.js';
import { WS_CLOSE_NO_SESSION, WS_CLOSE_UNAUTHORIZED } from '../../constants.js';
import type { IPty, PtyModule } from '../../terminal/ptyModule.js';
import { PtySessionManager } from '../../terminal/ptySessionManager.js';
import {
  type AuthServer,
  makeFakeDist,
  SoftAuthenticator,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
} from '../authTestKit.js';
import { ShellRegistry } from './registry.js';
import { findTmux, Tmux } from './tmux.js';

const dist = makeFakeDist();
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));
const origin = 'http://localhost:18240';
const headers = { host: 'localhost:18240', origin };
let root: string;
let home: string;
let server: AuthServer | undefined;
let registry: ShellRegistry;
let notices: Record<string, unknown>[];
let fakes: FakePty[];

class FakePty implements IPty {
  pid = 12345;
  written: string[] = [];
  killed = false;
  private data?: (chunk: string) => void;
  private exit?: (status: { exitCode: number }) => void;
  onData(listener: (chunk: string) => void) {
    this.data = listener;
  }
  onExit(listener: (status: { exitCode: number }) => void) {
    this.exit = listener;
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(_cols: number, _rows: number) {}
  kill(_signal?: string) {
    this.killed = true;
    this.exit?.({ exitCode: 0 });
  }
  output(data: string) {
    this.data?.(data);
  }
}

/** `real`: node-pty and a real /bin/sh (only in a temp dir); otherwise fake PTYs. */
async function start(
  options: { allowTerminal?: boolean; real?: boolean; listen?: boolean; tmux?: Tmux } = {},
) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-shell-test-'));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'));
  notices = [];
  fakes = [];
  const module: PtyModule = {
    spawn: () => {
      const pty = new FakePty();
      fakes.push(pty);
      return pty;
    },
  };
  registry = new ShellRegistry(
    options.real
      ? new PtySessionManager()
      : new PtySessionManager(() => ({ module, moduleId: 'fake', reason: null })),
    (m) => notices.push({ ...m }),
    Date.now,
    30 * 60_000,
    { tmux: options.tmux, file: path.join(root, 'config', 'shells.json') },
  );
  server = await startAuthServer(dist.staticDir, {
    configDir: path.join(root, 'config'),
    allowTerminal: options.allowTerminal ?? true,
    shellRegistry: registry,
    shellHome: home,
    listen: options.listen ?? false,
  });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await stopAuthServer(server);
  server = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (cookie: string, cwd: unknown, extra: Record<string, string> = {}) =>
  server!.app.inject({
    method: 'POST',
    url: '/api/shell',
    headers: { ...headers, cookie, ...extra },
    payload: { cwd },
  });
const sessionOf = (cookie: string) => server!.auth.session(cookie.slice('cld_session='.length))!;
/** A registered device's session with a fresh step-up. */
const trusted = async (label = 'Laptop') => {
  const device = await SoftDevice.create();
  const key = server!.auth.devices!.register(
    device.id,
    await device.publicKey(),
    origin,
    label,
    false,
  );
  expect('device' in key).toBe(true);
  const login = server!.auth.createSession('link', label, device.id);
  server!.auth.session(login.id)!.shellProofAt = Date.now();
  return { cookie: `cld_session=${login.id}`, deviceId: device.id, device };
};

/** The upgrade's HTTP status, or the close code once the socket opened. */
function attempt(port: number, id: string, extra: Record<string, string>) {
  return new Promise<{ status?: number; close?: number }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/cld/shell/${id}`, {
      headers: { origin: `http://127.0.0.1:${String(port)}`, ...extra },
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.once('close', (code) => resolve({ close: code }));
    ws.once('error', () => undefined);
    setTimeout(() => reject(new Error('timed out')), 5_000);
  });
}

/** An attached socket and the output it received so far. */
async function attach(port: number, id: string, cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/cld/shell/${id}`, {
    headers: { origin: `http://127.0.0.1:${String(port)}`, cookie },
  });
  const frames: string[] = [];
  let closed: number | undefined;
  ws.on('message', (raw) => {
    const frame = parseServerFrame(String(raw));
    if (frame && frame.type !== 'exit') frames.push(frame.data);
  });
  ws.on('close', (code) => {
    closed = code;
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, text: () => frames.join(''), closed: () => closed };
}

const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('the host opt-in', () => {
  it('off: every shell route answers 404, even to a trusted device with a fresh proof', async () => {
    await start({ allowTerminal: false, listen: true });
    const { cookie } = await trusted();
    const h = { ...headers, cookie };
    for (const [method, url] of [
      ['GET', '/api/shell'],
      ['POST', '/api/shell'],
      ['DELETE', '/api/shell/x'],
    ] as const)
      expect(
        (
          await server!.app.inject({
            method,
            url,
            headers: h,
            payload: method === 'POST' ? { cwd: home } : undefined,
          })
        ).statusCode,
        `${method} ${url}`,
      ).toBe(404);
    expect(await attempt(server!.port, 'x', { cookie })).toEqual({ status: 404 });
    // Before login too: the route's existence is not even disclosed as a 401.
    expect(await attempt(server!.port, 'x', {})).toEqual({ status: 404 });
    expect(
      (await server!.app.inject({ method: 'POST', url: '/api/shell', headers })).statusCode,
    ).toBe(404);
    expect(fakes).toHaveLength(0);
  });

  it('a server built without a registry gets a plain one: no tmux, no shells.json (tests share the machine with the daemon)', async () => {
    // A spy, not a temp HOME: os.homedir() in a worker thread ignores a stubbed HOME.
    const seen: unknown[] = [];
    vi.spyOn(ShellRegistry.prototype, 'restore').mockImplementation(function (this: unknown) {
      seen.push(this);
      return 0;
    });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-shell-plain-'));
    server = await startAuthServer(dist.staticDir, { allowTerminal: true });
    expect(seen).toHaveLength(1);
    const made = seen[0] as { tmux: unknown; file: unknown };
    expect(made.tmux).toBeNull();
    expect(made.file).toBeUndefined();
  });
});

describe('the gate', () => {
  it('refuses a code-only session, a stale proof, another origin or host, and cwd outside the picker', async () => {
    await start();
    const code = server!.auth.createSession('link');
    server!.auth.session(code.id)!.shellProofAt = Date.now(); // a proof alone is not a device
    expect((await post(`cld_session=${code.id}`, home)).statusCode).toBe(403);
    const { cookie } = await trusted();
    const session = sessionOf(cookie);
    session.shellProofAt = Date.now() - 121_000;
    expect((await post(cookie, home)).json()).toEqual({ error: 'proof' });
    session.shellProofAt = undefined;
    expect((await post(cookie, home)).statusCode).toBe(403);
    session.shellProofAt = Date.now();
    expect((await post(cookie, home, { origin: 'http://evil.example' })).statusCode).toBe(403);
    expect(
      (await post(cookie, home, { host: 'evil.example', origin: 'http://evil.example' }))
        .statusCode,
    ).toBe(403);
    // Outside the bounds: above home, a symlink out of it, a missing folder, not a string.
    fs.symlinkSync(root, path.join(home, 'out'));
    expect((await post(cookie, root)).statusCode).toBe(403);
    expect((await post(cookie, path.join(home, 'out'))).statusCode).toBe(403);
    expect((await post(cookie, path.join(home, 'missing'))).statusCode).toBe(403);
    expect((await post(cookie, 7)).statusCode).toBe(400);
    expect(registry.list()).toHaveLength(0);
    expect(fakes).toHaveLength(0);
  });

  it('a proof 119 s old opens; 121 s old does not', async () => {
    await start();
    const { cookie } = await trusted();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    sessionOf(cookie).shellProofAt = now - 121_000;
    expect((await post(cookie, home)).statusCode).toBe(403);
    sessionOf(cookie).shellProofAt = now - 119_000;
    expect((await post(cookie, home)).statusCode).toBe(201);
  });

  it('a passkey-only session needs a passkey that still exists', async () => {
    await start();
    const s = server!.auth.createSession('passkey', 'Phone');
    const session = server!.auth.session(s.id)!;
    session.shellProofAt = Date.now();
    session.shellPasskeyId = 'gone';
    expect((await post(`cld_session=${s.id}`, home)).statusCode).toBe(403);
  });

  it('the per-client rate limit: 20 attempts a minute, refused ones included', async () => {
    await start();
    const { cookie } = await trusted();
    sessionOf(cookie).shellProofAt = undefined;
    for (let i = 0; i < 20; i++) expect((await post(cookie, home)).statusCode).toBe(403);
    expect((await post(cookie, home)).statusCode).toBe(429);
  });

  it('"패스키 필수" refuses the device-key step-up of a device with its own passkey here', async () => {
    await start();
    const { cookie, device } = await trusted();
    // Its passkey, registered as 보안 → 패스키 등록 does (a step-up first).
    sessionOf(cookie).shellProofAt = Date.now();
    const begin = (
      await server!.app.inject({
        method: 'POST',
        url: '/api/auth/passkeys/options',
        headers: { ...headers, cookie },
      })
    ).json();
    const added = await server!.app.inject({
      method: 'POST',
      url: '/api/auth/passkeys',
      headers: { ...headers, cookie },
      payload: {
        ceremony: begin.ceremony,
        response: new SoftAuthenticator().register(begin.options, origin),
        name: 'Face ID',
      },
    });
    expect(added.json().passkey.deviceId).toBe(device.id);
    sessionOf(cookie).shellProofAt = undefined;
    server!.auth.devices!.setPasskeyRequired(true);
    const nonce = (
      await server!.app.inject({ method: 'GET', url: '/login/device/challenge', headers })
    ).json().nonce as string;
    const reply = await server!.app.inject({
      method: 'POST',
      url: '/api/auth/stepup/device',
      headers: { ...headers, cookie },
      payload: { deviceId: device.id, nonce, signature: await device.sign(nonce) },
    });
    expect(reply.statusCode).toBe(403);
    expect(sessionOf(cookie).shellProofAt).toBeUndefined();
  });
});

describe('shells', () => {
  it('caps a device at three (joining one of them still works), revoking it kills them, and the audit holds no I/O', async () => {
    await start({ listen: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { cookie, deviceId } = await trusted();
    const other = await trusted('Phone');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const reply = await post(cookie, path.join(home, 'work'));
      expect(reply.statusCode).toBe(201);
      ids.push(reply.json().id);
    }
    expect((await post(cookie, home)).statusCode).toBe(409);
    // Another device has its own three.
    expect((await post(other.cookie, home)).statusCode).toBe(201);
    // Attaching to a shell is not opening one: the cap does not refuse it.
    const live = await attach(server!.port, ids[2], cookie);
    live.ws.send(JSON.stringify({ type: 'input', data: 'echo secret-input\r' }));
    await until(() => fakes[2].written.length > 0);
    expect(fakes[2].written.join('')).toBe('echo secret-input\r');
    fakes[2].output('secret terminal output');
    await until(() => live.text().includes('secret terminal output'));
    // Someone else's shell, even by id: refused.
    expect(await attempt(server!.port, ids[0], { cookie: other.cookie })).toEqual({
      close: WS_CLOSE_NO_SESSION,
    });
    const listed = await server!.app.inject({
      method: 'GET',
      url: '/api/shell',
      headers: { ...headers, cookie: other.cookie },
    });
    expect(listed.json().shells).toHaveLength(4);
    expect(listed.json().shells[0]).toMatchObject({
      deviceId,
      label: 'Laptop',
      cwd: path.join(home, 'work'),
    });

    server!.auth.revoke(deviceId);
    expect(registry.list().map((s) => s.label)).toEqual(['Phone']);
    expect(fakes.slice(0, 3).every((f) => f.killed)).toBe(true);
    expect(fakes[3].killed).toBe(false);
    await until(() => live.closed() !== undefined);
    expect(notices.filter((m) => m.action === 'open')).toHaveLength(4);
    expect(notices.filter((m) => m.action === 'close' && m.deviceId === deviceId)).toHaveLength(3);
    expect(notices[0]).toMatchObject({
      type: 'shellNotice',
      action: 'open',
      deviceId,
      label: 'Laptop',
    });
    const audit = log.mock.calls.flat().join('\n');
    expect(audit).toContain('[cld shell] open device="Laptop"');
    expect(audit).toContain('reason=revoked');
    expect(audit).not.toContain('secret');
  });

  it('ending the session (the device logs in anew) kills its shells', async () => {
    await start();
    const { cookie, deviceId } = await trusted();
    expect((await post(cookie, home)).statusCode).toBe(201);
    server!.auth.deviceLogin(server!.auth.devices!.get(deviceId)!);
    expect(registry.list()).toHaveLength(0);
    expect(fakes[0].killed).toBe(true);
  });

  it('attaching needs a fresh proof too, and 닫기 from another device closes it', async () => {
    await start({ listen: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { cookie } = await trusted();
    const id = (await post(cookie, home)).json().id as string;
    sessionOf(cookie).shellProofAt = Date.now() - 121_000;
    expect(await attempt(server!.port, id, { cookie })).toEqual({ close: WS_CLOSE_UNAUTHORIZED });
    expect(await attempt(server!.port, id, {})).toEqual({ status: 401 });
    // A code-only session sees the list (the device list shows it) and may close one.
    const code = server!.auth.createSession('link', 'Tablet');
    const codeCookie = `cld_session=${code.id}`;
    const list = await server!.app.inject({
      method: 'GET',
      url: '/api/shell',
      headers: { ...headers, cookie: codeCookie },
    });
    expect(list.json()).toMatchObject({ canOpen: false });
    expect(
      (
        await server!.app.inject({
          method: 'DELETE',
          url: `/api/shell/${id}`,
          headers: { ...headers, cookie: codeCookie, origin: 'http://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server!.app.inject({
          method: 'DELETE',
          url: `/api/shell/${id}`,
          headers: { ...headers, cookie: codeCookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(registry.list()).toHaveLength(0);
    expect(log.mock.calls.flat().join('\n')).toContain('reason=requested by="Tablet"');
  });

  it('closes an idle shell after thirty minutes', async () => {
    await start();
    const { cookie } = await trusted();
    expect((await post(cookie, home)).statusCode).toBe(201);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    registry.touch(registry.list()[0].id);
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(registry.list()).toHaveLength(1);
    fakes[0].output('x'); // output counts as activity
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(registry.list()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(registry.list()).toHaveLength(0);
    expect(fakes[0].killed).toBe(true);
  });

  it('a real /bin/sh in a temp folder: pwd, no service environment, closed by DELETE', async () => {
    const saved = {
      HOME: process.env.HOME,
      SHELL: process.env.SHELL,
      CLD_SHELL_TEST_SECRET: process.env.CLD_SHELL_TEST_SECRET,
    };
    try {
      await start({ real: true, listen: true });
      process.env.HOME = home; // the login shell reads this temp home's profile, not the user's
      process.env.SHELL = '/bin/sh';
      process.env.CLD_SHELL_TEST_SECRET = 'service-only-value';
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { cookie } = await trusted();
      const work = path.join(home, 'work');
      const reply = await post(cookie, work);
      expect(reply.statusCode).toBe(201);
      const live = await attach(server!.port, reply.json().id, cookie);
      live.ws.send(
        JSON.stringify({ type: 'input', data: 'pwd; echo "[$CLD_SHELL_TEST_SECRET]"\r' }),
      );
      await until(() => live.text().includes('[]'));
      expect(live.text()).toContain(fs.realpathSync(work));
      expect(live.text()).not.toContain('service-only-value');
      const del = await server!.app.inject({
        method: 'DELETE',
        url: `/api/shell/${reply.json().id as string}`,
        headers: { ...headers, cookie },
      });
      expect(del.statusCode).toBe(200);
      await until(() => live.closed() !== undefined);
      expect(registry.list()).toHaveLength(0);
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });
});

const tmuxBin = findTmux();
(tmuxBin ? describe : describe.skip)('shells in tmux, over the socket', () => {
  const tmux = tmuxBin
    ? new Tmux(tmuxBin, `cld-test-${crypto.randomBytes(6).toString('hex')}`)
    : undefined;
  const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL };
  afterAll(() => {
    tmux?.killServer();
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('x detaches only: the shell, its pid and its session stay; 닫기 and a typed exit end them', async () => {
    await start({ real: true, listen: true, tmux });
    process.env.HOME = home;
    process.env.SHELL = '/bin/sh';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { cookie } = await trusted();
    const id = (await post(cookie, path.join(home, 'work'))).json().id as string;
    expect(tmux!.hasSession(id)).toBe(true);

    const first = await attach(server!.port, id, cookie);
    first.ws.send(JSON.stringify({ type: 'input', data: 'echo "pid:$$:end"\r' }));
    await until(() => /pid:\d+:end/.test(first.text()));
    const pid = /pid:(\d+):end/.exec(first.text())![1];
    first.ws.close(); // the tab's x
    await until(() => first.closed() !== undefined);
    await new Promise((r) => setTimeout(r, 200));
    expect(registry.list()).toHaveLength(1);
    expect(tmux!.hasSession(id)).toBe(true);

    const again = await attach(server!.port, id, cookie); // reopened from 닫은 터미널
    again.ws.send(JSON.stringify({ type: 'input', data: 'echo "again:$$:end"\r' }));
    await until(() => /again:\d+:end/.test(again.text()));
    expect(/again:(\d+):end/.exec(again.text())![1]).toBe(pid);

    again.ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }));
    await until(() => again.closed() !== undefined);
    expect(again.closed()).toBe(WS_CLOSE_NO_SESSION);
    expect(registry.list()).toHaveLength(0);
    expect(tmux!.hasSession(id)).toBe(false);
  });
});
