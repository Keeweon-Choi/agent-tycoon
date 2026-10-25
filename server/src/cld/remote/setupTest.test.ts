import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { anonymousWsRefused, outsideSelfTest, readRemoteTest, saveRemoteTest } from './setupTest.js';
import { testCa } from './testKit.js';

describe('outside self-test', () => {
  const url = 'https://office.example/secret/';
  it('checks health, login, and anonymous WebSocket at the real outside URL', async () => {
    const seen: string[] = [];
    const result = await outsideSelfTest(url, {
      dnsLookup: async (host) => { seen.push(host); },
      fetchFn: async (target) => {
        seen.push(target);
        return { status: target.endsWith('api/health') ? 200 : 401, text: async () => '로그인 코드' };
      },
      wsProbe: async (target) => { seen.push(target); return true; },
      now: () => 123,
    });
    expect(result.ok).toBe(true);
    expect(result.checkedAt).toBe(123);
    expect(seen).toEqual(['office.example', `${url}api/health`, url, 'wss://office.example/secret/ws']);
  });
  it('fails closed when an anonymous WebSocket is accepted', async () => {
    const result = await outsideSelfTest(url, {
      dnsLookup: async () => undefined,
      fetchFn: async () => ({ status: 200, text: async () => '<!doctype html>로그인 코드' }),
      wsProbe: async () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.text).toContain('거절되지');
  });
  it('does not mistake an arbitrary HTML page for the login page', async () => {
    const result = await outsideSelfTest(url, {
      dnsLookup: async () => undefined,
      fetchFn: async () => ({ status: 200, text: async () => '<!doctype html><title>other app</title>' }),
      wsProbe: async () => { throw new Error('must stop before /ws'); },
    });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.text).toContain('로그인 화면 확인 실패');
  });
  it('REMOTE-XPLAT: an address this PC cannot reach itself is "unknown from here" when the set-up was proven elsewhere', async () => {
    const unreachable = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    const proven = await outsideSelfTest(url, { dnsLookup: async () => undefined, fetchFn: unreachable, setUpProven: true });
    expect(proven.ok).toBe(true);
    expect(proven.steps.at(-1)).toMatchObject({ ok: true, unknown: true });
    expect(proven.steps.at(-1)?.text).toContain('ECONNREFUSED');
    // The quick tunnel has no other proof: still a failure.
    expect((await outsideSelfTest(url, { dnsLookup: async () => undefined, fetchFn: unreachable })).ok).toBe(false);
    // A certificate problem is never "unknown".
    const badCert = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }); };
    expect((await outsideSelfTest(url, { dnsLookup: async () => undefined, fetchFn: badCert, setUpProven: true })).ok).toBe(false);
    // Once the address answered, a later failure is real.
    let calls = 0;
    const thenFails = async () => { if (calls++ === 0) return { status: 200, text: async () => '' }; throw new Error('socket hang up'); };
    expect((await outsideSelfTest(url, { dnsLookup: async () => undefined, fetchFn: thenFails, setUpProven: true })).ok).toBe(false);
  });
  it('REMOTE-XPLAT review: a certificate nothing trusts (real fetch) fails; a closed port is "unknown from here"', async () => {
    const ca = await testCa();
    const leaf = await ca.issue('127.0.0.1');
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (_req, res) => res.end('x'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // fetch reports UNABLE_TO_VERIFY_LEAF_SIGNATURE: no "cert" in the code, the old deny-list missed it.
      const untrusted = await outsideSelfTest(`https://127.0.0.1:${port}/s/`, { setUpProven: true });
      expect(untrusted.ok).toBe(false);
      expect(untrusted.steps.some((step) => step.unknown)).toBe(false);
    } finally { server.close(); }
    const closed = await outsideSelfTest(`https://127.0.0.1:${port}/s/`, { setUpProven: true });
    expect(closed.ok).toBe(true);
    expect(closed.steps.at(-1)).toMatchObject({ unknown: true });
  });
  it('an IPv6 literal is looked up without its brackets', async () => {
    const seen: string[] = [];
    await outsideSelfTest('https://[2001:db8::1]/s/', {
      dnsLookup: async (host) => { seen.push(host); },
      fetchFn: async () => ({ status: 200, text: async () => '로그인 코드' }),
      wsProbe: async () => true,
    });
    expect(seen).toEqual(['2001:db8::1']);
  });
  it('stores and reads the result in a private file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-remote-test-'));
    try {
      const result = { ok: true, url, checkedAt: 123, steps: [{ ok: true, text: '확인' }] };
      saveRemoteTest(dir, result);
      expect(readRemoteTest(dir)).toEqual(result);
      expect(fs.statSync(path.join(dir, 'remote-test.json')).mode & 0o777).toBe(0o600);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('anonymous /ws probe against a real server', () => {
  const listen = async (server: http.Server) => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  };
  it('a refused upgrade (401, socket closed) is refused, quickly', async () => {
    const server = http.createServer();
    server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'));
    try {
      const started = Date.now();
      expect(await anonymousWsRefused(await listen(server))).toBe(true);
      expect(Date.now() - started).toBeLessThan(4000); // not the 8 s timeout
    } finally { server.close(); }
  });
  it('an accepted WebSocket is not refused', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    try {
      expect(await anonymousWsRefused(await listen(server))).toBe(false);
    } finally { wss.close(); server.close(); }
  });
});
