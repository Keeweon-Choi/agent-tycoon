import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, expect, it } from 'vitest';

import { PtySessionManager } from '../../terminal/ptySessionManager.js';
import {
  type AuthServer,
  cookieOf,
  deviceSession,
  makeFakeDist,
  SoftAuthenticator,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
} from '../authTestKit.js';
import { ShellRegistry } from './registry.js';

const origin = 'http://localhost:18240';
const headers = { host: 'localhost:18240', origin };
const dist = makeFakeDist();
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));
let server: AuthServer | undefined;
let configDir: string | undefined;
afterEach(async () => {
  await stopAuthServer(server);
  server = undefined;
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

it('only the current registered device can step up, and proof is memory only', async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-shell-stepup-'));
  server = await startAuthServer(dist.staticDir, { configDir, allowTerminal: true });
  const device = await SoftDevice.create();
  const other = await SoftDevice.create();
  server.auth.devices!.register(device.id, await device.publicKey(), origin, 'Laptop', false);
  server.auth.devices!.register(other.id, await other.publicKey(), origin, 'Phone', false);
  const login = server.auth.createSession('link', 'Laptop', device.id);
  const cookie = cookieOf(`cld_session=${login.id}; Path=/`);
  const prove = async (key: SoftDevice) => {
    const nonce = (
      await server!.app.inject({ method: 'GET', url: '/login/device/challenge', headers })
    ).json().nonce as string;
    return server!.app.inject({
      method: 'POST',
      url: '/api/auth/stepup/device',
      headers: { ...headers, cookie },
      payload: { deviceId: key.id, nonce, signature: await key.sign(nonce) },
    });
  };
  expect((await prove(other)).statusCode).toBe(403);
  expect(server.auth.session(login.id)?.shellProofAt).toBeUndefined();
  expect((await prove(device)).statusCode).toBe(200);
  expect(server.auth.session(login.id)?.shellProofAt).toBeTypeOf('number');
  const disk = fs.readFileSync(path.join(configDir, 'sessions.json'), 'utf8');
  expect(disk).not.toContain('shellProofAt');
});

it('device step-up is not a terminal feature (S1): it answers with the opt-in off, shells stay hidden', async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-shell-off-'));
  server = await startAuthServer(dist.staticDir, { configDir });
  const session = server.auth.createSession();
  const reply = await server.app.inject({
    method: 'POST',
    url: '/api/auth/stepup/device',
    headers: { ...headers, cookie: `cld_session=${session.id}` },
    payload: {},
  });
  expect(reply.statusCode).toBe(403); // no device key proved, but the route is there
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/shell',
        headers: { ...headers, cookie: `cld_session=${session.id}` },
        payload: { cwd: configDir },
      })
    ).statusCode,
  ).toBe(404);
});

it('a passkey session: Face ID is the step-up, and a code session with a passkey assertion is still no device', async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-shell-passkey-'));
  const home = path.join(configDir, 'home');
  fs.mkdirSync(home);
  // A fake PTY: this test opens no real shell.
  const pty = { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const registry = new ShellRegistry(
    new PtySessionManager(() => ({ module: { spawn: () => pty }, moduleId: 'fake', reason: null })),
  );
  server = await startAuthServer(dist.staticDir, {
    configDir,
    allowTerminal: true,
    shellHome: home,
    shellRegistry: registry,
  });
  const app = server.app;
  const key = new SoftAuthenticator();
  // Registered from a logged-in session, as 보안 → 패스키 등록 does.
  // S5: and the passkey is tied to the device that session is.
  const owner = (await deviceSession(server.auth, origin)).cookie;
  const registerOptions = () =>
    app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/options',
      headers: { ...headers, cookie: owner },
    });
  // S1: a cookie alone cannot add a passkey; a fresh step-up can.
  expect((await registerOptions()).json()).toEqual({ error: 'stepup' });
  server.auth.session(owner.slice('cld_session='.length))!.shellProofAt = Date.now();
  const reg = (await registerOptions()).json();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/passkeys',
        headers: { ...headers, cookie: owner },
        payload: {
          ceremony: reg.ceremony,
          response: key.register(reg.options, origin),
          name: 'iPhone',
        },
      })
    ).statusCode,
  ).toBe(200);
  // A new passkey is a step-up too, so the other devices are told.
  expect(server.broadcasts).toContainEqual(
    expect.objectContaining({ type: 'newDeviceLogin', label: '패스키가 추가됐어요: iPhone' }),
  );
  // A login with it (the login page).
  const opts = (
    await app.inject({
      method: 'POST',
      url: '/login/passkey/options',
      headers: { host: headers.host },
    })
  ).json();
  const login = await app.inject({
    method: 'POST',
    url: '/login/passkey',
    headers: { host: headers.host },
    payload: { ceremony: opts.ceremony, response: key.login(opts.options, origin) },
  });
  expect(login.statusCode).toBe(200);
  const verify = async (cookie: string) => {
    const begin = (
      await app.inject({
        method: 'POST',
        url: '/api/auth/passkeys/verify/options',
        headers: { ...headers, cookie },
      })
    ).json();
    return app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/verify',
      headers: { ...headers, cookie },
      payload: { ceremony: begin.ceremony, response: key.login(begin.options, origin) },
    });
  };
  const open = (cookie: string) =>
    app.inject({
      method: 'POST',
      url: '/api/shell',
      headers: { ...headers, cookie },
      payload: { cwd: home },
    });
  const passkey = cookieOf(login.headers['set-cookie']);
  const id = passkey.slice('cld_session='.length);
  expect(server.auth.session(id)!.shellProofAt).toBeUndefined(); // the login itself is not a step-up
  expect((await open(passkey)).json()).toEqual({ error: 'proof' });
  expect((await verify(passkey)).statusCode).toBe(200);
  expect(server.auth.session(id)?.shellProofAt).toBeTypeOf('number');
  const opened = await open(passkey);
  expect(opened.statusCode).toBe(201);
  await app.inject({
    method: 'DELETE',
    url: `/api/shell/${opened.json().id as string}`,
    headers: { ...headers, cookie: passkey },
  });
  // A code session verifies with it too, but stays a code session (no device key).
  const code = `cld_session=${server.auth.createSession('short', 'iPhone').id}`;
  expect((await verify(code)).statusCode).toBe(200);
  expect((await open(code)).json()).toEqual({ error: 'device' });
});
