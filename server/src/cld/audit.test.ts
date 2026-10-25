/**
 * O3: the security record. The file itself (0600, the cap and one old file,
 * coalesced step-up failures, a failed write, a broken line), then the events
 * where they happen -- register, invite, step-up, revoke, passkey, lockout --
 * and that no secret reaches the file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUDIT_FILE,
  AUDIT_MAX_BYTES,
  AUDIT_STEPUP_WINDOW_MS,
  type AuditLine,
  AuditLog,
} from './audit.js';
import { NEW_DEVICE_NOTICE_MS } from './auth.js';
import {
  type AuthServer,
  cookieOf,
  funnel,
  makeFakeDist,
  proveSession,
  SoftAuthenticator,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
  TOKEN,
} from './authTestKit.js';
import { cldHooks } from './hooks.js';

const dist = makeFakeDist();
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-audit-'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
const file = () => path.join(dir, AUDIT_FILE);
const lines = (name = file()): AuditLine[] =>
  (fs.existsSync(name) ? fs.readFileSync(name, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditLine);

describe('the file', () => {
  it('appends one JSON line per event, 0600 on create, masked and cut labels', () => {
    const log = new AuditLog(dir);
    log.write({
      kind: 'deviceRegistered',
      device: { id: 'dev1', label: `phone token=SECRETVALUE ${'x'.repeat(100)}`, kind: 'phone' },
      by: 'host',
      via: 'lan',
      peer: 'listener:192.168.0.9',
      detail: 'new',
    });
    log.write({ kind: 'revokeOthers', detail: 3 });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    const [first, second] = lines();
    expect(first).toMatchObject({ v: 1, kind: 'deviceRegistered', by: 'host', via: 'lan', peer: '192.168.0.9', detail: 'new' });
    expect(first.at).toBeTypeOf('number');
    expect(first.device?.label).not.toContain('SECRETVALUE');
    expect([...(first.device?.label ?? '')].length).toBeLessThanOrEqual(60);
    expect(second).toMatchObject({ kind: 'revokeOthers', detail: 3 });
    expect(second.device).toBeUndefined();
  });

  it('every client-reachable field is masked and cut by the file itself: by, peer, device', () => {
    const log = new AuditLog(dir);
    const dirty = `x token=SECRETFIELD ${'y'.repeat(100)}`;
    log.write({ kind: 'lockout', by: dirty, peer: dirty, via: 'remote', detail: dirty, device: { id: dirty, label: dirty, kind: dirty } });
    const [line] = lines();
    for (const value of [line.by, line.peer, line.detail, line.device?.id, line.device?.label, line.device?.kind]) {
      expect(String(value)).not.toContain('SECRETFIELD');
      expect([...String(value)].length).toBeLessThanOrEqual(60);
    }
  });

  it('moves to audit.jsonl.1 at the cap and keeps just one old file', () => {
    const log = new AuditLog(dir);
    // A valid line that takes the file to just under the cap.
    const fill = () =>
      fs.appendFileSync(
        file(),
        `${JSON.stringify({ v: 1, at: 1, kind: 'lockout', detail: `pad${'x'.repeat(AUDIT_MAX_BYTES - fs.statSync(file(), { throwIfNoEntry: false })!.size - 100)}` })}\n`,
      );
    fs.writeFileSync(file(), '');
    fill();
    log.write({ kind: 'lockout', detail: 'short' });
    expect(lines(`${file()}.1`)).toMatchObject([{ detail: expect.stringMatching(/^padxxx/) }]);
    expect(lines()).toMatchObject([{ detail: 'short' }]);
    fill();
    log.write({ kind: 'lockout', detail: 'direct' });
    // The second rotation replaced the old file: it now holds the first new line (and the padding).
    expect(lines(`${file()}.1`).map((l) => l.detail)).toEqual(['short', expect.stringMatching(/^pad/)]);
    expect(lines()).toMatchObject([{ detail: 'direct' }]);
    expect(fs.readdirSync(dir).sort()).toEqual([AUDIT_FILE, `${AUDIT_FILE}.1`]);
  });

  it('counts a device\'s failed step-ups inside the window as one line', () => {
    vi.useFakeTimers();
    const log = new AuditLog(dir);
    const a = { id: 'a', label: 'Phone' };
    for (let i = 0; i < 4; i++) log.stepUpFailed(a, { via: 'remote' });
    log.stepUpFailed({ id: 'b', label: 'Laptop' }, {});
    expect(fs.existsSync(file())).toBe(false);
    vi.advanceTimersByTime(AUDIT_STEPUP_WINDOW_MS);
    expect(lines().map((l) => [l.kind, l.device?.id, l.detail, l.via])).toEqual([
      ['stepUpFailed', 'a', 4, 'remote'],
      ['stepUpFailed', 'b', 1, undefined],
    ]);
    // A new window starts afresh; flush writes what is still counting.
    log.stepUpFailed(a, {});
    log.flush();
    expect(lines()).toHaveLength(3);
  });

  it('0600 also for a file that already existed (and the old one), checked once', () => {
    for (const name of [file(), `${file()}.1`]) fs.writeFileSync(name, '', { mode: 0o644 });
    fs.chmodSync(file(), 0o644);
    fs.chmodSync(`${file()}.1`, 0o644);
    const log = new AuditLog(dir);
    log.write({ kind: 'lockout', detail: 'short' });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${file()}.1`).mode & 0o777).toBe(0o600);
    // A rotated file keeps 0600 too.
    fs.chmodSync(file(), 0o644);
    fs.appendFileSync(file(), `${'x'.repeat(AUDIT_MAX_BYTES)}\n`);
    log.write({ kind: 'lockout', detail: 'direct' });
    expect(fs.statSync(`${file()}.1`).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('`since` skips the lines written after the first page, in the same read', () => {
    const log = new AuditLog(dir);
    for (let i = 0; i < 5; i++) log.write({ kind: 'lockout', detail: i });
    // The first page saw 3 lines (0-2); 3 and 4 came after. Newest first: 4 3 | 2 1 0; skip 1 of the old ones.
    expect(log.read(1, 2, 3)).toMatchObject({ total: 5, lines: [{ detail: 1 }, { detail: 0 }] });
    expect(log.read(0, 2)).toMatchObject({ lines: [{ detail: 4 }, { detail: 3 }] });
  });

  it('a failed write is logged once and throws nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fs.mkdirSync(file()); // a directory where the file should be
    const log = new AuditLog(dir);
    expect(() => {
      log.write({ kind: 'lockout' });
      log.write({ kind: 'lockout' });
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the newest first, a page at a time, and skips a broken line', () => {
    fs.writeFileSync(
      `${file()}.1`,
      `${JSON.stringify({ v: 1, at: 1, kind: 'lockout', detail: 'old' })}\n`,
    );
    fs.writeFileSync(
      file(),
      [
        JSON.stringify({ v: 1, at: 2, kind: 'lockout', detail: 'a' }),
        '{"v":1,"at":3,"kind":"lock', // torn
        'not json',
        JSON.stringify({ v: 2, at: 4, kind: 'lockout' }), // not ours
        JSON.stringify({ v: 1, at: 5, kind: 'lockout', detail: 'b' }),
        '',
      ].join('\n'),
    );
    const log = new AuditLog(dir);
    expect(log.read(0, 2)).toMatchObject({ total: 3, lines: [{ detail: 'b' }, { detail: 'a' }] });
    expect(log.read(2, 2).lines).toMatchObject([{ detail: 'old' }]);
    expect(new AuditLog().read(0, 5)).toEqual({ lines: [], total: 0 });
  });
});

describe('the events', () => {
  const UA_WIN =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  let server: AuthServer;
  beforeEach(async () => {
    server = await startAuthServer(dist.staticDir, { configDir: dir });
  });
  afterEach(async () => {
    await stopAuthServer(server);
    delete cldHooks.allowRemoteHost;
  });
  const call = (
    cookie: string | undefined,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = funnel(),
  ) =>
    server.app.inject({
      method,
      url,
      headers: {
        ...headers,
        ...(cookie ? { cookie } : {}),
        origin: `${headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${headers.host}`,
      },
      payload,
    });

  /** A device that registered its key from a session, as the web app does after a login. */
  async function registered(label = 'Windows · Chrome') {
    const device = await SoftDevice.create();
    const session = server.auth.createSession('short', label);
    const cookie = `cld_session=${session.id}`;
    const res = await call(cookie, 'POST', '/api/auth/device', {
      deviceId: device.id,
      publicKey: await device.publicKey(),
    });
    expect(res.statusCode).toBe(200);
    return { device, cookie, session };
  }
  const stepUp = async (who: { device: SoftDevice; cookie: string }, device = who.device) => {
    const { nonce } = (await call(undefined, 'GET', '/login/device/challenge')).json();
    return call(who.cookie, 'POST', '/api/auth/stepup/device', {
      deviceId: device.id,
      nonce,
      signature: await device.sign(nonce),
    });
  };

  it('a registered key, a replaced key and a step-up pass or fail each leave their line', async () => {
    const owner = await registered();
    expect(lines()).toMatchObject([
      {
        kind: 'deviceRegistered',
        detail: 'new',
        device: { id: owner.device.id, label: 'Windows · Chrome' },
        by: 'Windows · Chrome',
        via: 'remote',
        peer: '203.0.113.7',
      },
    ]);
    expect((await stepUp(owner)).statusCode).toBe(200);
    expect(lines().at(-1)).toMatchObject({ kind: 'stepUpPassed', detail: 'key', device: { id: owner.device.id } });
    // A key swap (same device, same session) is its own line: a move, from the address it had.
    const moved = await SoftDevice.create(owner.device.id);
    server.auth.session(owner.session.id)!.method = 'move';
    server.auth.devices!.get(owner.device.id)!.origin = 'https://old.example';
    await call(owner.cookie, 'POST', '/api/auth/device', {
      deviceId: moved.id,
      publicKey: await moved.publicKey(),
    });
    expect(lines().at(-1)).toMatchObject({ kind: 'deviceRegistered', detail: 'replaced' });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stranger = await SoftDevice.create();
    for (let i = 0; i < 3; i++) expect((await stepUp(owner, stranger)).statusCode).toBe(403);
    const before = lines().length;
    server.auth.audit.flush();
    expect(lines().slice(before)).toMatchObject([
      { kind: 'stepUpFailed', detail: 3, device: { id: owner.device.id }, via: 'remote' },
    ]);
  });

  it('an invitation: created, used, cancelled, and refused when it has expired', async () => {
    const owner = await registered();
    proveSession(server.auth, owner.cookie);
    const invite = async () =>
      (await call(owner.cookie, 'POST', '/api/auth/device-code')).json() as {
        code: string;
        link: string;
        id: string;
      };
    const open = (code: string) =>
      server.app.inject({
        url: `/login?code=${encodeURIComponent(code)}`,
        headers: { ...funnel('203.0.113.9'), 'user-agent': UA_WIN },
      });
    const a = await invite();
    expect(lines().at(-1)).toMatchObject({ kind: 'inviteCreated', by: 'Windows · Chrome', via: 'remote' });
    expect((await open(a.code)).statusCode).toBe(303);
    expect(lines().at(-1)).toMatchObject({
      kind: 'inviteUsed',
      detail: 'short',
      via: 'remote',
      peer: '203.0.113.9',
      device: { label: 'Windows · Chrome' },
    });
    const b = await invite();
    await call(owner.cookie, 'POST', `/api/auth/device-invite/${b.id}/cancel`);
    await call(owner.cookie, 'POST', `/api/auth/device-invite/${b.id}/cancel`); // twice: still one line
    expect(lines().filter((l) => l.kind === 'inviteRefused')).toMatchObject([{ detail: 'cancelled' }]);
    const c = await invite();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await open(c.code)).statusCode).toBe(401);
    expect(lines().filter((l) => l.kind === 'inviteRefused')).toMatchObject([
      { detail: 'cancelled' },
      { detail: 'expired', via: 'remote' },
    ]);
  });

  it('a login that never becomes a known device is announced after 30 s, with how it came in', async () => {
    const owner = await registered();
    proveSession(server.auth, owner.cookie);
    const { code } = (await call(owner.cookie, 'POST', '/api/auth/device-code')).json();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await server.app.inject({
      url: `/login?code=${code}`,
      headers: { ...funnel('203.0.113.9'), 'user-agent': UA_WIN },
    });
    vi.advanceTimersByTime(NEW_DEVICE_NOTICE_MS);
    expect(lines().at(-1)).toMatchObject({
      kind: 'deviceRegistered',
      detail: 'unknown',
      via: 'remote',
      peer: '203.0.113.9',
      device: { label: 'Windows · Chrome' },
    });
  });

  it('signing a device out and signing the others out', async () => {
    const owner = await registered();
    const other = await registered('iPhone · Safari');
    const third = await registered('Android · Chrome');
    proveSession(server.auth, owner.cookie);
    await call(owner.cookie, 'POST', `/api/auth/sessions/${other.device.id}/nickname`, {
      name: 'my token=NICKSECRET phone',
    });
    expect((await call(owner.cookie, 'DELETE', `/api/auth/sessions/${other.device.id}`)).statusCode).toBe(200);
    const revoked = lines().at(-1)!;
    expect(revoked).toMatchObject({ kind: 'deviceRevoked', device: { id: other.device.id }, by: 'Windows · Chrome' });
    expect(revoked.device?.label).not.toContain('NICKSECRET');
    expect((await call(owner.cookie, 'POST', '/api/auth/sessions/revoke-others')).json()).toEqual({ count: 1 });
    expect(lines().at(-1)).toMatchObject({ kind: 'revokeOthers', detail: 1, by: 'Windows · Chrome' });
    expect(third.device.id).toBeTruthy();
  });

  it('a passkey added, used as a step-up and removed', async () => {
    const origin = 'http://localhost:18240';
    const local = { host: 'localhost:18240' };
    const owner = await registered();
    const key = new SoftAuthenticator();
    proveSession(server.auth, owner.cookie);
    const reg = (await call(owner.cookie, 'POST', '/api/auth/passkeys/options', undefined, local)).json();
    const added = await call(owner.cookie, 'POST', '/api/auth/passkeys', {
      ceremony: reg.ceremony,
      response: key.register(reg.options, origin),
      name: 'Face ID',
    }, local);
    expect(added.statusCode).toBe(200);
    expect(lines().at(-1)).toMatchObject({ kind: 'deviceRegistered', detail: 'passkey', via: 'local', device: { id: owner.device.id } });
    const verify = async (response?: Record<string, unknown>) => {
      const begin = (await call(owner.cookie, 'POST', '/api/auth/passkeys/verify/options', undefined, local)).json();
      return call(owner.cookie, 'POST', '/api/auth/passkeys/verify', {
        ceremony: begin.ceremony,
        response: response ?? key.login(begin.options, origin),
      }, local);
    };
    expect((await verify()).statusCode).toBe(200);
    expect(lines().at(-1)).toMatchObject({ kind: 'stepUpPassed', detail: 'passkey', via: 'local' });
    expect((await verify({ id: 'nope' })).statusCode).toBe(403);
    server.auth.audit.flush();
    expect(lines().at(-1)).toMatchObject({ kind: 'stepUpFailed', detail: 1 });
    const id = (await call(owner.cookie, 'GET', '/api/auth/passkeys', undefined, local)).json().passkeys[0].id as string;
    expect((await call(owner.cookie, 'DELETE', `/api/auth/passkeys/${id}`, undefined, local)).statusCode).toBe(200);
    expect(lines().at(-1)).toMatchObject({ kind: 'passkeyRemoved', device: { id: owner.device.id } });
  });

  it('the short-code lock (the direct listener lock is pinned in remote/access.test.ts)', async () => {
    for (let i = 0; i < 20; i++)
      await server.app.inject({ url: `/login?code=${String(10_000_000 + i)}`, headers: funnel(`198.51.100.${i + 1}`) });
    expect(lines().filter((l) => l.kind === 'lockout')).toMatchObject([{ detail: 'short', via: 'remote' }]);
  });

  it('a client-chosen address and name are masked and cut before they reach the file', async () => {
    const owner = await registered();
    proveSession(server.auth, owner.cookie);
    const forged = (xff: string) => ({ ...funnel(), 'x-forwarded-for': xff });
    await call(owner.cookie, 'POST', '/api/auth/device-code', undefined, forged(`token=SECRETPEER${'A'.repeat(190)}`));
    await call(owner.cookie, 'POST', '/api/auth/device-code', undefined, forged('9'.repeat(200)));
    const [secret, long] = lines().filter((l) => l.kind === 'inviteCreated');
    expect(secret.peer).not.toContain('SECRETPEER');
    expect(long.peer).toBeDefined();
    for (const l of [secret, long]) expect([...(l.peer ?? '')].length).toBeLessThanOrEqual(60);
    // The owner's own name for a device reaches `by`: masked all the same.
    await call(owner.cookie, 'POST', `/api/auth/sessions/${owner.device.id}/nickname`, {
      name: 'token=SECRETNICK phone',
    });
    await call(owner.cookie, 'POST', '/api/auth/device-code');
    const named = lines().filter((l) => l.kind === 'inviteCreated').at(-1)!;
    expect(named.by).toBeDefined();
    expect(named.by).not.toContain('SECRETNICK');
    expect(fs.readFileSync(file(), 'utf8')).not.toMatch(/SECRETPEER|SECRETNICK/);
  });

  it('signing a device out by its session handle still names the device', async () => {
    const owner = await registered();
    const other = await registered('iPhone · Safari');
    proveSession(server.auth, owner.cookie);
    expect(
      (await call(owner.cookie, 'DELETE', `/api/auth/sessions/${other.session.handle}`)).statusCode,
    ).toBe(200);
    expect(lines().at(-1)).toMatchObject({
      kind: 'deviceRevoked',
      device: { id: other.device.id, label: 'iPhone · Safari' },
    });
  });

  it("the host's login codes: created and used, never the code itself", async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/login-code',
      headers: { authorization: `Bearer ${TOKEN}`, host: 'localhost:18240' },
      payload: { short: true },
    });
    const { code } = res.json() as { code: string };
    expect(lines().at(-1)).toMatchObject({ kind: 'loginCodeCreated', detail: 'short', by: 'host', via: 'local' });
    const used = await server.app.inject({
      url: `/login?code=${code}`,
      headers: { host: 'localhost:18240', 'user-agent': UA_WIN },
    });
    expect(used.statusCode).toBe(303);
    expect(lines().at(-1)).toMatchObject({ kind: 'loginCodeUsed', detail: 'short', via: 'local', device: { label: 'Windows · Chrome' } });
    expect(fs.readFileSync(file(), 'utf8')).not.toContain(code);
  });

  it('a new allowed host is one line, with a count', () => {
    cldHooks.allowRemoteHost?.('fresh.tail0000.ts.net');
    cldHooks.allowRemoteHost?.('fresh.tail0000.ts.net');
    expect(lines().filter((l) => l.kind === 'allowedHosts')).toMatchObject([{ detail: expect.any(Number) }]);
  });

  it('no token, code, cookie, public key or credential id reaches the file', async () => {
    const owner = await registered();
    proveSession(server.auth, owner.cookie);
    const secrets = new Set<string>([TOKEN, owner.session.id, owner.cookie]);
    const invite = (await call(owner.cookie, 'POST', '/api/auth/device-code')).json() as {
      code: string;
      link: string;
    };
    secrets.add(invite.code);
    secrets.add(new URL(invite.link).searchParams.get('code')!);
    const x = (await owner.device.publicKey()).x as string;
    secrets.add(x);
    const opened = await server.app.inject({
      url: `/login?code=${invite.code}`,
      headers: { ...funnel('203.0.113.9'), 'user-agent': UA_WIN },
    });
    secrets.add(cookieOf(opened.headers['set-cookie']).split('=')[1]);
    await stepUp(owner, await SoftDevice.create()); // a failed step-up
    // The host's own login-code request, with the Bearer token, over loopback.
    await server.app.inject({
      method: 'POST',
      url: '/api/login-code',
      headers: { authorization: `Bearer ${TOKEN}`, host: 'localhost:18240' },
    });
    const key = new SoftAuthenticator();
    const local = { host: 'localhost:18240' };
    const reg = (await call(owner.cookie, 'POST', '/api/auth/passkeys/options', undefined, local)).json();
    const response = key.register(reg.options, 'http://localhost:18240');
    secrets.add(response.id as string);
    await call(owner.cookie, 'POST', '/api/auth/passkeys', { ceremony: reg.ceremony, response, name: 'Face ID' }, local);
    server.auth.audit.flush();
    const text = fs.readFileSync(file(), 'utf8');
    expect(text.length).toBeGreaterThan(0);
    for (const secret of secrets) if (secret) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[?&]token=|[?&]code=/);
  });

  it('a write that fails does not fail the request that caused it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fs.mkdirSync(file());
    const owner = await registered();
    expect((await stepUp(owner)).statusCode).toBe(200);
    expect(fs.statSync(file()).isDirectory()).toBe(true);
  });
});

describe('who may read the record', () => {
  let server: AuthServer;
  beforeEach(async () => {
    server = await startAuthServer(dist.staticDir, { configDir: dir });
    for (let i = 0; i < 120; i++) server.auth.audit.write({ kind: 'lockout', detail: i });
  });
  afterEach(async () => {
    await stopAuthServer(server);
  });
  const get = (url: string, cookie?: string, headers: Record<string, string> = funnel()) =>
    server.app.inject({ url, headers: { ...headers, ...(cookie ? { cookie } : {}) } });

  it('a signed-in session reads 50 lines, newest first, and the next 50', async () => {
    const cookie = `cld_session=${server.auth.createSession().id}`;
    const first = (await get('/api/auth/audit', cookie)).json() as { lines: AuditLine[]; total: number };
    expect(first.lines).toHaveLength(50);
    expect(first.total).toBe(120);
    expect(first.lines[0].detail).toBe(119);
    // A line written meanwhile does not shift the next page.
    server.auth.audit.write({ kind: 'lockout', detail: 'late' });
    const next = (await get(`/api/auth/audit?skip=50&since=${first.total}`, cookie)).json() as { lines: AuditLine[] };
    expect(next.lines).toHaveLength(50);
    expect(next.lines[0].detail).toBe(69);
    const rest = (await get(`/api/auth/audit?skip=100&since=${first.total}`, cookie)).json() as { lines: AuditLine[] };
    expect(rest.lines.map((l) => l.detail)).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i));
  });

  it('no session, a wrong cookie, the host token or a public request with only a token get no lines', async () => {
    for (const res of [
      await get('/api/auth/audit'),
      await get('/api/auth/audit', 'cld_session=forged'),
      await get('/api/auth/audit', undefined, { host: 'localhost:18240', authorization: `Bearer ${TOKEN}` }),
      await get('/api/auth/audit', undefined, { ...funnel(), authorization: `Bearer ${TOKEN}` }),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain('lockout');
    }
  });
});

describe('approvals of new devices', () => {
  let server: AuthServer;
  beforeEach(async () => {
    server = await startAuthServer(dist.staticDir, { configDir: dir, allowApprovalRequests: true });
  });
  afterEach(async () => {
    await stopAuthServer(server);
  });
  const local = { host: 'localhost:18240', origin: 'http://localhost:18240' };
  const ask = async () =>
    (await server.app.inject({ method: 'POST', url: '/login/approval', headers: local, payload: {} })).json() as {
      secret: string;
      code: string;
    };
  const asked = async (cookie: string) =>
    ((await server.app.inject({ url: '/api/auth/approvals', headers: { ...local, cookie } })).json() as {
      approvals: Array<{ id: string }>;
    }).approvals;

  it('an answer from a signed-in device and from the host each leave one line, without the code', async () => {
    const who = server.auth.createSession('short', 'iPhone · Safari');
    const cookie = `cld_session=${who.id}`;
    proveSession(server.auth, cookie);
    const first = await ask();
    const [pending] = await asked(cookie);
    const answer = (approve: boolean, code?: string) =>
      server.app.inject({
        method: 'POST',
        url: `/api/auth/approvals/${pending.id}`,
        headers: { ...local, cookie },
        payload: { approve, code },
      });
    expect((await answer(true, 'wrong')).json()).toEqual({ result: 'wrong-code' });
    expect(lines().filter((l) => l.kind === 'approvalAnswered')).toHaveLength(0);
    expect((await answer(true, first.code)).json()).toEqual({ result: 'approved' });
    expect(lines().at(-1)).toMatchObject({ kind: 'approvalAnswered', detail: 'approved', by: 'iPhone · Safari', via: 'local' });

    const second = await ask();
    const [next] = await asked(cookie);
    await server.app.inject({
      method: 'POST',
      url: `/api/auth/approvals/${next.id}`,
      headers: { ...local, cookie },
      payload: { approve: false },
    });
    expect(lines().at(-1)).toMatchObject({ kind: 'approvalAnswered', detail: 'refused' });

    const third = await ask();
    const byHost = await server.app.inject({
      method: 'POST',
      url: '/api/device-approval',
      headers: { authorization: `Bearer ${TOKEN}`, host: 'localhost:18240' },
      payload: { code: third.code },
    });
    expect(byHost.statusCode).toBe(200);
    expect(lines().at(-1)).toMatchObject({ kind: 'approvalAnswered', detail: 'approved', by: 'host', via: 'local' });
    const text = fs.readFileSync(file(), 'utf8');
    for (const secret of [first.code, first.secret, second.code, second.secret, third.code, third.secret])
      expect(text).not.toContain(secret);
  });
});
