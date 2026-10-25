/** O6 routes: record / test / forget the user's own address, behind the DuckDNS card's gates. */
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cldHooks } from '../hooks.js';
import { readCustom } from './custom.js';
import { answerFor } from './healthChallenge.js';
import { startRemote } from './index.js';

const TOKEN = 'host-token';
const URL_A = 'https://office.example.com/';
const HOOKS = ['registerRoutes', 'onListening', 'canonicalUrl', 'verifiedOutsideUrl', 'allowRemoteHost', 'dropRemoteHost'] as const;
const host: Record<string, string> = { authorization: `Bearer ${TOKEN}`, host: 'localhost:18256' };
/** A logged-in device on its own page (a remote one: not the host token). */
const device = { cookie: 'cld_session=valid', host: 'outside.example', origin: 'http://outside.example' };
/** What this daemon's /api/health says for a nonce its self-test issued (httpServer calls the same answerFor). */
const honest = async (url: string) => new Response(JSON.stringify({ cldReply: answerFor(new URL(url).searchParams.get('cldNonce')) }));

let configDir: string;
let allowed: Set<string>;
let saved: Partial<typeof cldHooks>;
let stepUp = false;
let remote: ReturnType<typeof startRemote>;
let app: ReturnType<typeof Fastify>;

async function boot(readOnly = false, customFetch: (url: string) => Promise<Response> = honest, connector: 'local' | 'tailscale' = 'local', allowedHosts: string[] = []) {
  remote = startRemote({
    connector, allowedHosts, readOnly, configDir, token: { current: TOKEN },
    deps: { lanIp: null, wslMode: async () => null, tailscaleServe: async () => null, setupCommand: async () => null, customFetch },
  });
  app = Fastify();
  cldHooks.registerRoutes?.(app, async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}` && request.headers.cookie !== 'cld_session=valid')
      void reply.code(401).send('unauthorized');
  }, () => stepUp);
  await app.ready();
  Object.defineProperty(app.server, 'address', { value: () => ({ port: 18256 }), configurable: true });
  cldHooks.onListening?.({ app, allowedHostnames: new Set() });
}
const call = (method: 'POST' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url: `/api/cld/connector/custom${url}`, headers, payload: payload as object });
const save = (headers = host, url: unknown = URL_A) => call('POST', '', headers, { url });

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-custom-api-'));
  allowed = new Set();
  saved = Object.fromEntries(HOOKS.map((k) => [k, cldHooks[k]]));
  stepUp = false;
  // What httpServer does with the Host allowlist.
  cldHooks.allowRemoteHost = (name) => void allowed.add(name);
  cldHooks.dropRemoteHost = (name) => void allowed.delete(name);
});
afterEach(async () => {
  await remote.dispose();
  await app.close();
  for (const key of HOOKS) {
    if (saved[key]) Object.assign(cldHooks, { [key]: saved[key] });
    else delete cldHooks[key];
  }
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('custom address card', () => {
  it('saves with the host token: 0600 file, Host allowed, not preferred until the self-test passes', async () => {
    await boot();
    const response = await save();
    expect(response.statusCode).toBe(200);
    expect(fs.statSync(path.join(configDir, 'custom-url.json')).mode & 0o777).toBe(0o600);
    expect(readCustom(configDir)).toEqual({ url: URL_A, active: true, test: null });
    expect([...allowed]).toEqual(['office.example.com']);
    expect(cldHooks.canonicalUrl?.()).toBe('http://localhost:18256/');
    const status = (await app.inject({ method: 'GET', url: '/api/cld/connector', headers: host })).json();
    expect(status.custom).toMatchObject({ url: URL_A, active: true, test: null, preferred: false });
  });

  it('validation: 400 and nothing stored', async () => {
    await boot();
    for (const url of ['http://example.com', 'https://u:p@example.com', 'x'.repeat(300), '', 7, 'https://example.com/?q=1']) {
      const r = await save(host, url);
      expect(r.statusCode, String(url)).toBe(400);
    }
    expect(readCustom(configDir)).toBeNull();
    expect(allowed.size).toBe(0);
  });

  it('self-test ok: invitations and device moves prefer the address; the saved file keeps the verdict', async () => {
    await boot();
    await save();
    const result = (await call('POST', '/test', host)).json();
    expect(result).toMatchObject({ verdict: 'ok', custom: { preferred: true }, url: 'https://office.example.com/' });
    expect(cldHooks.canonicalUrl?.()).toBe(URL_A);
    expect(cldHooks.verifiedOutsideUrl?.()).toBe('https://office.example.com');
    expect(readCustom(configDir)?.test?.verdict).toBe('ok');
  });

  it.each([
    ['wrong daemon', async () => new Response('{"status":"ok"}'), 'wrongDaemon'],
    ['timeout', async () => { throw new DOMException('t', 'TimeoutError'); }, 'unreachable'],
    ['TLS error', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }); }, 'certificate'],
  ])('self-test %s: reported, never preferred', async (_name, fake, verdict) => {
    await boot(false, fake as (url: string) => Promise<Response>);
    await save();
    expect((await call('POST', '/test', host)).json().verdict).toBe(verdict);
    expect(cldHooks.canonicalUrl?.()).toBe('http://localhost:18256/');
    expect(cldHooks.verifiedOutsideUrl?.()).toBeUndefined();
  });

  it('a failed re-test takes the preference away again', async () => {
    let up = true;
    await boot(false, async (url) => (up ? honest(url) : new Response('{}')));
    await save();
    await call('POST', '/test', host);
    expect(cldHooks.canonicalUrl?.()).toBe(URL_A);
    up = false;
    await call('POST', '/test', host);
    expect(cldHooks.canonicalUrl?.()).toBe('http://localhost:18256/');
  });

  it('removing forgets the file, the allowed Host and the preference', async () => {
    await boot();
    await save();
    await call('POST', '/test', host);
    expect((await call('DELETE', '', host)).statusCode).toBe(200);
    expect(readCustom(configDir)).toBeNull();
    expect(allowed.size).toBe(0);
    expect(cldHooks.canonicalUrl?.()).toBe('http://localhost:18256/');
  });

  it('a name another connector answers to stays allowed when the card goes', async () => {
    await boot(false, honest, 'tailscale', ['office.tail1234.ts.net']);
    await save(host, 'https://office.tail1234.ts.net/');
    expect((await call('DELETE', '', host)).statusCode).toBe(200);
    expect(allowed.has('office.tail1234.ts.net')).toBe(true);
  });

  it('turning remote access off (connector local) clears its use and its Host; a pass brings it back', async () => {
    await boot(false, honest, 'tailscale');
    await save();
    await call('POST', '/test', host);
    expect(cldHooks.canonicalUrl?.()).toBe(URL_A);
    const off = await app.inject({ method: 'POST', url: '/api/cld/connector/enable', headers: host, payload: { connector: 'local' } });
    expect(off.statusCode).toBe(200);
    expect(readCustom(configDir)).toEqual({ url: URL_A, active: false, test: null });
    expect(allowed.size).toBe(0);
    expect(cldHooks.canonicalUrl?.()).toBe('http://localhost:18256/');
    // Switching it on again widens the exposure: a remote device needs the step-up, the host does not.
    expect((await call('POST', '/test', device)).statusCode).toBe(403);
    expect((await call('POST', '/test', host)).json().verdict).toBe('ok');
    expect(readCustom(configDir)?.active).toBe(true);
    expect([...allowed]).toEqual(['office.example.com']);
  });

  it('survives a restart: active -> Host allowed again and preferred', async () => {
    await boot();
    await save();
    await call('POST', '/test', host);
    await remote.dispose();
    await app.close();
    allowed.clear();
    for (const key of HOOKS) if (saved[key]) Object.assign(cldHooks, { [key]: saved[key] }); else delete cldHooks[key];
    cldHooks.allowRemoteHost = (name) => void allowed.add(name);
    cldHooks.dropRemoteHost = (name) => void allowed.delete(name);
    await boot();
    expect([...allowed]).toEqual(['office.example.com']);
    expect(cldHooks.canonicalUrl?.()).toBe(URL_A);
  });

  it('read-only: a device is refused (save, test, remove); the host token still may', async () => {
    await boot(true);
    for (const r of [await save(device), await call('POST', '/test', device), await call('DELETE', '', device)]) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toContain('읽기 전용');
    }
    expect(readCustom(configDir)).toBeNull();
    expect((await save()).statusCode).toBe(200);
  });

  it('a remote device needs a fresh step-up to save or remove; the host token does not', async () => {
    await boot();
    for (const r of [await save(device), await call('DELETE', '', device)]) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('stepup');
    }
    expect(readCustom(configDir)).toBeNull();
    stepUp = true;
    expect((await save(device)).statusCode).toBe(200);
    expect((await call('DELETE', '', device)).statusCode).toBe(200);
  });

  it('a request from another origin (a sibling page) is refused', async () => {
    await boot();
    stepUp = true;
    const r = await save({ ...device, origin: 'http://evil.example' });
    expect(r.statusCode).toBe(403);
    expect(readCustom(configDir)).toBeNull();
  });
});
