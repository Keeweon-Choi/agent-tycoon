import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { StandaloneAuth } from '../auth.js';
import { registerProjectFileRoutes } from './routes.js';

let app: FastifyInstance;
let temp: string;
let cookie: string;
const headers = () => ({ host: 'office.test', cookie });
const postHeaders = () => ({ ...headers(), origin: 'http://office.test' });

beforeEach(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 't0044-route-'));
  expect(
    spawnSync('git', ['init', '-q'], { cwd: temp, env: { ...process.env, HOME: temp } }).status,
  ).toBe(0);
  fs.writeFileSync(path.join(temp, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(temp, 'hello.md'), '# Hello');
  fs.writeFileSync(path.join(temp, '.env'), 'SECRET=hidden');
  fs.writeFileSync(path.join(temp, 'report.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(temp, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.symlinkSync(path.join(process.cwd(), 'package.json'), path.join(temp, 'outside'));
  const auth = new StandaloneAuth();
  cookie = `cld_session=${auth.createSession('link', 'phone').id}`;
  app = Fastify();
  // The temp folder stands in for home, the root a chosen folder must stay under.
  const host = {
    type: 'hostInfo' as const,
    os: 'linux' as const,
    home: temp,
    pathStyle: 'posix' as const,
    sep: '/' as const,
    caseInsensitive: false,
  };
  registerProjectFileRoutes(app, auth, () => [{ name: 'p', folder: temp }], host);
  await app.ready();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

it('requires a cookie session, confines browsing, and blocks sensitive preview', async () => {
  expect((await app.inject({ url: '/api/cld/files/p/list' })).statusCode).toBe(401);
  const list = await app.inject({ url: '/api/cld/files/p/list', headers: headers() });
  expect(list.statusCode).toBe(200);
  const recent = await app.inject({ url: '/api/cld/files/p/recent', headers: headers() });
  expect(recent.json()).toMatchObject({ partial: false, ignored: [] });
  const hiddenRecent = await app.inject({
    url: '/api/cld/files/p/recent?hidden=1',
    headers: headers(),
  });
  expect(hiddenRecent.json().ignored).toContain('.env');
  expect(list.json().entries.map((entry: { name: string }) => entry.name)).toContain('hello.md');
  expect(list.json().entries.map((entry: { name: string }) => entry.name)).not.toContain('outside');
  const preview = await app.inject({
    url: '/api/cld/files/p/preview?path=hello.md',
    headers: headers(),
  });
  expect(preview.json().text).toBe('# Hello');
  expect(preview.headers['cache-control']).toBe('private, no-store');
  expect(preview.headers['x-content-type-options']).toBe('nosniff');
  expect(
    (await app.inject({ url: '/api/cld/files/p/preview?path=.env', headers: headers() }))
      .statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ url: '/api/cld/files/p/preview?path=outside', headers: headers() }))
      .statusCode,
  ).toBe(403);
});

it('serves a chosen folder with the same preview and one-use download gates', async () => {
  const base = '/api/cld/files/~folder';
  const root = encodeURIComponent(temp);
  const list = await app.inject({ url: `${base}/list?root=${root}`, headers: headers() });
  expect(list.statusCode).toBe(200);
  expect(list.json().entries.map((entry: { name: string }) => entry.name)).toContain('hello.md');
  const ignored = await app.inject({ url: `${base}/ignored?root=${root}`, headers: headers() });
  expect(ignored.json().ignored).toContain('.env');
  fs.writeFileSync(path.join(temp, 'vault.KDBX'), 'secret');
  expect(
    (await app.inject({ url: `${base}/preview?root=${root}&path=vault.KDBX`, headers: headers() }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${base}/ticket`,
        headers: postHeaders(),
        payload: { root: temp, path: 'vault.KDBX', mode: 'download' },
      })
    ).statusCode,
  ).toBe(403);
  const preview = await app.inject({
    url: `${base}/preview?root=${root}&path=hello.md`,
    headers: headers(),
  });
  expect(preview.json().text).toBe('# Hello');
  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining(`project=${JSON.stringify(temp)}`),
  );
  const minted = await app.inject({
    method: 'POST',
    url: `${base}/ticket`,
    headers: postHeaders(),
    payload: { root: temp, path: 'hello.md', mode: 'download' },
  });
  expect(minted.statusCode).toBe(200);
  expect((await app.inject({ url: minted.json().url, headers: headers() })).body).toBe('# Hello');
  expect((await app.inject({ url: minted.json().url, headers: headers() })).statusCode).toBe(404);
  fs.mkdirSync(path.join(temp, '.AWS'));
  expect(
    (await app.inject({ url: `${base}/list?root=${root}&hidden=1`, headers: headers() }))
      .json()
      .entries.map((entry: { name: string }) => entry.name),
  ).not.toContain('.AWS');
  expect(
    (await app.inject({ url: `${base}/list?root=%2Fetc`, headers: headers() })).statusCode,
  ).toBe(403);
});

it('refuses protected folders in a chosen root: ., .., encoding, case, symlinks, tickets', async () => {
  const base = '/api/cld/files/~folder';
  for (const dir of ['.ssh', '.claude', '.config/cld-gui', '.pixel-agents', 'work/.Aws'])
    fs.mkdirSync(path.join(temp, dir), { recursive: true });
  fs.writeFileSync(path.join(temp, '.ssh', 'config'), 'Host x');
  fs.writeFileSync(path.join(temp, '.claude', '.credentials.json'), 'token');
  fs.writeFileSync(path.join(temp, '.config', 'cld-gui', 'auth.json'), 'token');
  fs.writeFileSync(path.join(temp, 'work', '.Aws', 'credentials'), 'token');
  fs.symlinkSync(path.join(temp, '.ssh'), path.join(temp, 'keys'));
  const enc = encodeURIComponent;
  const status = async (url: string) => (await app.inject({ url, headers: headers() })).statusCode;
  for (const root of [
    `${temp}/.ssh`,
    `${temp}/.SSH`,
    `${temp}/.claude`,
    `${temp}/.ClAuDe`,
    `${temp}/.config/CLD-GUI`,
    `${temp}/.pixel-agents`,
    `${temp}/work/.aws`,
    `${temp}/keys`,
    `${temp}/work/../.ssh`,
    `${temp}/./.ssh`,
    '/etc',
    '/',
    `${temp}/../`,
    'relative/path',
  ]) {
    expect(await status(`${base}/list?root=${enc(root)}`), root).toBe(403);
    expect(await status(`${base}/list?root=${enc(enc(root))}`), root).toBe(403);
  }
  for (const bad of [
    '.ssh',
    '.ssh%2Fconfig',
    '.SSH/config',
    '%2Essh/config',
    'keys/config',
    'work/.aws/credentials',
    '.claude/.credentials.json',
    '.config/cld-gui/auth.json',
    'work/..%2F.ssh/config',
    'x/%2E%2E/.ssh/config',
    '..%2F' + path.basename(temp) + '/.ssh/config',
  ]) {
    expect([403, 404], bad).toContain(await status(`${base}/list?root=${enc(temp)}&path=${bad}`));
    expect([403, 404], bad).toContain(
      await status(`${base}/preview?root=${enc(temp)}&path=${bad}`),
    );
  }
  const listed = await app.inject({
    url: `${base}/list?root=${enc(temp)}&hidden=1`,
    headers: headers(),
  });
  const names = listed.json().entries.map((entry: { name: string }) => entry.name);
  for (const hidden of ['.ssh', '.claude', '.pixel-agents', 'keys'])
    expect(names).not.toContain(hidden);
  expect(names).toContain('.config');
  const config = await app.inject({
    url: `${base}/list?root=${enc(temp)}&path=.config&hidden=1`,
    headers: headers(),
  });
  expect(config.json().entries).toEqual([]);
  for (const payload of [
    { root: `${temp}/.ssh`, path: 'config' },
    { root: temp, path: 'keys/config' },
    { root: temp, path: '.claude/.credentials.json' },
    { root: '/etc', path: 'hostname' },
  ]) {
    const minted = await app.inject({
      method: 'POST',
      url: `${base}/ticket`,
      headers: postHeaders(),
      payload: { ...payload, mode: 'download' },
    });
    expect(minted.statusCode, JSON.stringify(payload)).toBe(403);
  }
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[cld files]'));
});

it('requires Origin for ticket creation and consumes a same-session URL once', async () => {
  const body = { path: 'hello.md', mode: 'download' };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/cld/files/p/ticket',
        headers: headers(),
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/cld/files/p/ticket',
    headers: postHeaders(),
    payload: body,
  });
  expect(minted.statusCode).toBe(200);
  const url = minted.json().url as string;
  expect((await app.inject({ url })).statusCode).toBe(401);
  const file = await app.inject({ url, headers: headers() });
  expect(file.statusCode).toBe(200);
  expect(file.body).toBe('# Hello');
  expect(file.headers['content-disposition']).toContain('attachment');
  expect(file.headers['cache-control']).toBe('private, no-store');
  expect((await app.inject({ url, headers: headers() })).statusCode).toBe(404);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('device="phone"'));
});

it('allows SVG image tickets, sandboxes inline HTML, and scopes the sensitive switch to the session', async () => {
  const image = await app.inject({
    method: 'POST',
    url: '/api/cld/files/p/ticket',
    headers: postHeaders(),
    payload: { path: 'image.svg', mode: 'preview' },
  });
  const loaded = await app.inject({ url: image.json().url, headers: headers() });
  expect(loaded.headers['content-type']).toContain('image/svg+xml');
  expect(loaded.headers['content-security-policy']).toContain("script-src 'none'");
  const report = await app.inject({
    method: 'POST',
    url: '/api/cld/files/p/ticket',
    headers: postHeaders(),
    payload: { path: 'report.html', mode: 'preview' },
  });
  const inline = await app.inject({ url: report.json().url, headers: headers() });
  expect(inline.headers['content-disposition']).toContain('inline');
  expect(inline.headers['content-type']).toContain('text/html');
  expect(inline.headers['content-security-policy']).toMatch(/default-src 'none'.*; sandbox$/);
  expect(inline.headers['content-security-policy']).not.toContain('allow-scripts');
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[cld files] preview'));
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('alert(1)'));
  const html = await app.inject({
    method: 'POST',
    url: '/api/cld/files/p/ticket',
    headers: postHeaders(),
    payload: { path: 'report.html', mode: 'download' },
  });
  expect(
    (await app.inject({ url: html.json().url, headers: headers() })).headers['content-type'],
  ).toContain('application/octet-stream');
  expect(
    (await app.inject({ url: '/api/cld/files/p/preview?path=.env', headers: headers() }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/cld/files/settings',
        headers: postHeaders(),
        payload: { allowSensitive: true },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ url: '/api/cld/files/p/preview?path=.env', headers: headers() }))
      .statusCode,
  ).toBe(415);
  const secret = await app.inject({
    method: 'POST',
    url: '/api/cld/files/p/ticket',
    headers: postHeaders(),
    payload: { path: '.env', mode: 'download' },
  });
  expect(secret.statusCode).toBe(200);
});

it('refuses encoded traversal, absolute paths, a folder symlink out, and other sessions', async () => {
  fs.symlinkSync(path.dirname(process.cwd()), path.join(temp, 'up'));
  for (const bad of [
    '..%2Fpackage.json',
    '%2E%2E/package.json',
    'a/..%2F..%2Fpackage.json',
    encodeURIComponent(path.join(process.cwd(), 'package.json')),
    'up/package.json',
    '.git/config',
    '.GIT/HEAD',
  ]) {
    const preview = await app.inject({
      url: `/api/cld/files/p/preview?path=${bad}`,
      headers: headers(),
    });
    expect([403, 404]).toContain(preview.statusCode);
    const list = await app.inject({ url: `/api/cld/files/p/list?path=${bad}`, headers: headers() });
    expect([403, 404]).toContain(list.statusCode);
  }
  expect(
    (await app.inject({ url: '/api/cld/files/..%2F..%2Fetc/list', headers: headers() })).statusCode,
  ).toBe(404);
  // A forwarded https origin is this site too (requestIsHttps); a sibling is not.
  const https = { ...headers(), 'x-forwarded-proto': 'https', origin: 'https://office.test' };
  const minted = await app.inject({
    method: 'POST',
    url: '/api/cld/files/p/ticket',
    headers: https,
    payload: { path: 'hello.md', mode: 'download' },
  });
  expect(minted.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/cld/files/settings',
        headers: { ...headers(), origin: 'https://evil.office.test' },
        payload: { allowSensitive: true },
      })
    ).statusCode,
  ).toBe(403);
  const auth2 = new StandaloneAuth();
  const other = `cld_session=${auth2.createSession('link', 'other').id}`;
  expect(
    (await app.inject({ url: minted.json().url, headers: { host: 'office.test', cookie: other } }))
      .statusCode,
  ).toBe(401);
});

it('serves a project whose registered folder is itself a symlink, confined to its target', async () => {
  const link = `${temp}-link`;
  fs.symlinkSync(temp, link);
  try {
    const auth = new StandaloneAuth();
    const own = `cld_session=${auth.createSession('link', 'x').id}`;
    const linked = Fastify();
    registerProjectFileRoutes(linked, auth, () => [{ name: 'q', folder: link }]);
    const list = await linked.inject({
      url: '/api/cld/files/q/list',
      headers: { host: 'office.test', cookie: own },
    });
    expect(list.json().entries.map((e: { name: string }) => e.name)).toContain('hello.md');
    expect(
      (
        await linked.inject({
          url: '/api/cld/files/q/preview?path=outside',
          headers: { host: 'office.test', cookie: own },
        })
      ).statusCode,
    ).toBe(403);
    await linked.close();
  } finally {
    fs.unlinkSync(link);
  }
});
