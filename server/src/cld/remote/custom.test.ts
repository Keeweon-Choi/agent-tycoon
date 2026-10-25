import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../../agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../../httpServer.js';
import { CUSTOM_URL_MAX, customPreferred, customSelfTest, parseCustomUrl, readCustom, writeCustom } from './custom.js';
import { answerFor, CHALLENGE_MAX, CHALLENGE_TTL_MS, issueChallenge, pendingChallenges } from './healthChallenge.js';
import { canonicalUrl } from './index.js';

describe('parseCustomUrl', () => {
  it('takes https anywhere and keeps a path, ending in a slash', () => {
    expect(parseCustomUrl(' https://office.example.com ')).toMatchObject({ ok: true, url: 'https://office.example.com/', host: 'office.example.com', plainHttp: false });
    expect(parseCustomUrl('https://example.com:8443/office')).toMatchObject({ ok: true, url: 'https://example.com:8443/office/' });
  });

  it('allows plain http only for a private or VPN address literal', () => {
    for (const ok of ['http://192.168.0.5:18240', 'http://10.1.2.3', 'http://100.101.102.103', 'http://127.0.0.1:1', 'http://[::1]:5', 'http://[fd12::1]/'])
      expect(parseCustomUrl(ok), ok).toMatchObject({ ok: true, plainHttp: true });
    for (const bad of ['http://example.com', 'http://8.8.8.8', 'http://office.lan', 'http://[2001:db8::1]'])
      expect(parseCustomUrl(bad), bad).toEqual({ ok: false, error: 'httpsOnly' });
  });

  it('refuses credentials, query, fragment, other schemes, empty, junk and long input', () => {
    expect(parseCustomUrl('https://user:pw@example.com')).toEqual({ ok: false, error: 'credentials' });
    expect(parseCustomUrl('https://user@example.com')).toEqual({ ok: false, error: 'credentials' });
    expect(parseCustomUrl('https://example.com/?a=1')).toEqual({ ok: false, error: 'invalid' });
    expect(parseCustomUrl('https://example.com/#x')).toEqual({ ok: false, error: 'invalid' });
    expect(parseCustomUrl('ftp://example.com')).toEqual({ ok: false, error: 'invalid' });
    expect(parseCustomUrl('not a url')).toEqual({ ok: false, error: 'invalid' });
    expect(parseCustomUrl('  ')).toEqual({ ok: false, error: 'empty' });
    expect(parseCustomUrl(42)).toEqual({ ok: false, error: 'empty' });
    expect(parseCustomUrl(`https://${'a'.repeat(CUSTOM_URL_MAX)}.com`)).toEqual({ ok: false, error: 'tooLong' });
  });
});

describe('customSelfTest (fake fetch)', () => {
  const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
  let server: HttpServerHandle | undefined;
  afterEach(async () => {
    await server?.app.close();
    server = undefined;
  });
  /** The real /api/health route, reached without a socket: what a proxy in front of this daemon would pass on. */
  const endpoint = async (url: string, init?: { redirect: string }) => {
    server ??= await createHttpServer({ embedded: true, token: 'host-token', store: new AgentStateStore(), listen: false });
    void init;
    const target = new URL(url);
    const res = await server.app.inject({ method: 'GET', url: `${target.pathname}${target.search}` });
    return new Response(res.body, { status: res.statusCode });
  };
  const nonceOf = (url: string) => new URL(url).searchParams.get('cldNonce') ?? '';
  const test = (fetchFn: Parameters<typeof customSelfTest>[1]) => customSelfTest('https://office.example.com/', fetchFn);

  it('ok through the real endpoint; asks <url>/api/health with a 32-hex nonce and never follows redirects', async () => {
    let seen: { url: string; redirect?: string } | undefined;
    expect(await test(async (url, init) => { seen = { url, redirect: init.redirect }; return endpoint(url); })).toBe('ok');
    expect(seen?.url).toMatch(/^https:\/\/office\.example\.com\/api\/health\?cldNonce=[0-9a-f]{32}$/);
    expect(seen?.redirect).toBe('manual');
  });

  it('wrong daemon: a server that only echoes the nonce, no reply, a wrong reply, an error status, a redirect, not JSON', async () => {
    expect(await test(async (url) => new Response(JSON.stringify({ status: 'ok', cldReply: nonceOf(url), cldNonce: nonceOf(url) })))).toBe('wrongDaemon');
    expect(await test(answer({ status: 'ok', service: 'cld-gui' }))).toBe('wrongDaemon');
    expect(await test(answer({ cldReply: 'a'.repeat(32) }))).toBe('wrongDaemon');
    expect(await test(async (url) => new Response(await (await endpoint(url)).text(), { status: 502 }))).toBe('wrongDaemon');
    expect(await test(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))).toBe('wrongDaemon');
    expect(await test(async () => new Response('<html>'))).toBe('wrongDaemon');
  });

  it('unreachable: timeout, refused, DNS', async () => {
    for (const error of [new DOMException('timed out', 'TimeoutError'), Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }), new TypeError('fetch failed')])
      expect(await test(async () => { throw error; })).toBe('unreachable');
  });

  it('certificate: expired, self-signed, wrong name', async () => {
    for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])
      expect(await test(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) }); }), code).toBe('certificate');
  });
});

describe('record and preference', () => {
  it('writes atomically with mode 0600, reads back, removes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-custom-'));
    try {
      expect(readCustom(dir)).toBeNull();
      const record = { url: 'https://office.example.com/', active: true, test: { verdict: 'ok' as const, checkedAt: 5 } };
      writeCustom(dir, record);
      expect(fs.statSync(path.join(dir, 'custom-url.json')).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(['custom-url.json']);
      expect(readCustom(dir)).toEqual(record);
      writeCustom(dir, null);
      expect(readCustom(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, 'custom-url.json'), '{"url":"http://example.com/","active":true}');
      expect(readCustom(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preferred only when on and the last self-test passed; then it wins the canonical address', () => {
    const base = { url: 'https://office.example.com/', active: true, test: { verdict: 'ok' as const, checkedAt: 1 } };
    expect(customPreferred(base)).toBe(base.url);
    expect(customPreferred({ ...base, active: false })).toBeUndefined();
    expect(customPreferred({ ...base, test: { verdict: 'unreachable', checkedAt: 1 } })).toBeUndefined();
    expect(customPreferred({ ...base, test: null })).toBeUndefined();
    expect(customPreferred(null)).toBeUndefined();
    const f = { connector: 'direct' as const, port: 18240, directUrl: 'https://203.0.113.7/s3cret/', tailscaleHost: null, lanIp: '192.168.0.2' };
    expect(canonicalUrl({ ...f, customUrl: base.url })).toBe(base.url);
    expect(canonicalUrl({ ...f, customUrl: null })).toBe('https://203.0.113.7/s3cret/');
  });
});

describe('review fixes', () => {
  it('a 200 whose body never ends is cut at 4 KB, not buffered (the fetch here has no timeout)', async () => {
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(1024).fill(0x61)) });
    expect(await customSelfTest('https://office.example.com/', async () => new Response(endless))).toBe('wrongDaemon');
  });

  it('refuses a host name the Host allowlist can never match', () => {
    for (const bad of ['https://*.com/', 'https://%2A.com/', 'https://a_b.example.com/'])
      expect(parseCustomUrl(bad), bad).toEqual({ ok: false, error: 'invalid' });
    expect(parseCustomUrl('https://[fd12::1]/')).toMatchObject({ ok: true, host: 'fd12::1' });
    expect(parseCustomUrl('https://Example.COM./')).toMatchObject({ ok: true, host: 'example.com.' });
  });
});

describe('health challenge', () => {
  afterEach(() => vi.useRealTimers());
  const health = async (query: string) => {
    const server = await createHttpServer({ embedded: true, token: 'host-token', store: new AgentStateStore(), listen: false });
    try {
      return (await server.app.inject({ method: 'GET', url: `/api/health${query}` })).json<Record<string, unknown>>();
    } finally {
      await server.app.close();
    }
  };

  it('answers only an issued nonce, once; an unknown, malformed or missing nonce gets the plain body', async () => {
    const plain = await health('');
    expect(Object.keys(plain).sort()).toEqual(['os', 'protocol', 'service', 'status', 'version']);
    const { nonce, reply } = issueChallenge();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await health(`?cldNonce=${'0'.repeat(32)}`)).toEqual(plain);
    expect(await health(`?cldNonce=${nonce.slice(0, 31)}`)).toEqual(plain);
    expect(await health(`?cldNonce=${nonce.toUpperCase()}`)).toEqual(plain);
    expect(await health(`?cldNonce=${nonce}&cldNonce=${nonce}`)).toEqual(plain);
    expect(await health(`?cldNonce=${nonce}`)).toEqual({ ...plain, cldReply: reply });
    // used up
    expect(await health(`?cldNonce=${nonce}`)).toEqual(plain);
  });

  it('an expired nonce gets nothing', () => {
    vi.useFakeTimers();
    const { nonce } = issueChallenge();
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    expect(answerFor(nonce)).toBeUndefined();
  });

  it('the map is capped: the oldest goes first', () => {
    const issued = Array.from({ length: CHALLENGE_MAX + 5 }, () => issueChallenge());
    expect(pendingChallenges()).toBeLessThanOrEqual(CHALLENGE_MAX);
    expect(answerFor(issued[0].nonce)).toBeUndefined();
    expect(answerFor(issued.at(-1)!.nonce)).toBe(issued.at(-1)!.reply);
  });
});
