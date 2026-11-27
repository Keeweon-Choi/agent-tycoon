import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { StandaloneAuth } from '../auth.js';
import { registerProjectFileRoutes } from './routes.js';
import { bytesHash, saveEdit } from './save.js';

let temp: string;
let app: FastifyInstance;
let cookie: string;
const headers = () => ({ host: 'office.test', cookie, origin: 'http://office.test' });
const url = '/api/agty/files/p/text';

beforeEach(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4s5-')));
  fs.writeFileSync(path.join(temp, 'a.ts'), 'one\n');
  fs.writeFileSync(path.join(temp, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(temp, 'bin.dat'), Buffer.from([1, 0, 2]));
  const wt = path.join(temp, '.worktrees', 'cart-total');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: elsewhere\n');
  fs.writeFileSync(path.join(wt, 'Cart.tsx'), 'old\n');
  const auth = new StandaloneAuth();
  cookie = `agty_session=${auth.createSession('link', 'phone').id}`;
  app = Fastify();
  registerProjectFileRoutes(app, auth, () => [{ name: 'p', folder: temp }]);
  await app.ready();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

it('saves only while the file still has the hash it was opened with', () => {
  const opened = bytesHash(Buffer.from('one\n'));
  const first = saveEdit(temp, 'a.ts', false, 'two\n', opened);
  expect(first).toMatchObject({ ok: true, hash: bytesHash(Buffer.from('two\n')) });
  expect(fs.readFileSync(path.join(temp, 'a.ts'), 'utf8')).toBe('two\n');
  // The same (now stale) hash again: refused, the disk's hash handed back, file untouched.
  const stale = saveEdit(temp, 'a.ts', false, 'three\n', opened);
  expect(stale).toMatchObject({ ok: false, hash: bytesHash(Buffer.from('two\n')) });
  expect(fs.readFileSync(path.join(temp, 'a.ts'), 'utf8')).toBe('two\n');
});

/** The builtin's own object: a spy on it reaches save.ts's ESM bindings after syncBuiltinESMExports. */
const fsObject = createRequire(__filename)('node:fs') as typeof fs;

it('U1.4: a write that comes up short and then fails leaves the old file whole and no temp file', () => {
  const file = path.join(temp, 'a.ts');
  const real = fsObject.writeSync;
  let calls = 0;
  // One byte lands, then the disk is full: a short write followed by ENOSPC.
  const spy = vi.spyOn(fsObject, 'writeSync').mockImplementation(((fd: number, buffer: Buffer, offset: number) => {
    if (++calls > 1) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return real(fd, buffer, offset, 1);
  }) as typeof fs.writeSync);
  syncBuiltinESMExports();
  try {
    expect(() => saveEdit(temp, 'a.ts', false, 'two lines\n', bytesHash(Buffer.from('one\n')))).toThrow(/ENOSPC/);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(fs.readFileSync(file, 'utf8')).toBe('one\n');
  expect(fs.readdirSync(temp).filter((name) => name.includes('.tmp'))).toEqual([]);
});

it('U1.4: a save keeps the file mode and writes through a symbolic link to its target', () => {
  const file = path.join(temp, 'a.ts');
  fs.chmodSync(file, 0o640);
  fs.symlinkSync('a.ts', path.join(temp, 'link.ts'));
  expect(saveEdit(temp, 'link.ts', false, 'two\n', bytesHash(Buffer.from('one\n')))).toMatchObject({ ok: true });
  expect(fs.lstatSync(path.join(temp, 'link.ts')).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe('two\n');
  expect(fs.statSync(file).mode & 0o777).toBe(0o640);
});

it('U1.4 race: a folder swapped for a link after the check is refused, nothing is written outside', () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4s5-out-')));
  fs.mkdirSync(path.join(temp, 'sub'));
  fs.writeFileSync(path.join(temp, 'sub', 'b.ts'), 'one\n');
  const cryptoObject = createRequire(__filename)('node:crypto') as typeof import('node:crypto');
  const real = cryptoObject.randomBytes;
  let swapped = false;
  // The swap lands between the checked open (closed again) and the temp file's open.
  const spy = vi.spyOn(cryptoObject, 'randomBytes').mockImplementation(((size: number) => {
    if (!swapped) {
      swapped = true;
      fs.renameSync(path.join(temp, 'sub'), path.join(temp, 'sub-moved'));
      fs.symlinkSync(outside, path.join(temp, 'sub'));
    }
    return real(size);
  }) as typeof real);
  syncBuiltinESMExports();
  try {
    expect(() => saveEdit(temp, 'sub/b.ts', false, 'two\n', bytesHash(Buffer.from('one\n')))).toThrow();
    expect(swapped).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(temp, 'sub-moved', 'b.ts'), 'utf8')).toBe('one\n');
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it('keeps the existing path rules: sensitive, non-text and escaping paths are refused', () => {
  expect(() => saveEdit(temp, '.env', false, 'x', 'h')).toThrow();
  expect(() => saveEdit(temp, 'bin.dat', false, 'x', 'h')).toThrow();
  expect(() => saveEdit(temp, '../a.ts', false, 'x', 'h')).toThrow();
  expect(fs.readFileSync(path.join(temp, '.env'), 'utf8')).toBe('SECRET=1');
});

it('edits a task worktree over HTTP and answers 409 with the disk hash on a stale save', async () => {
  const query = '?task=cart-total&path=Cart.tsx';
  const opened = (await app.inject({ url: url + query, headers: headers() })).json();
  expect(opened.text).toBe('old\n');
  const put = (text: string, baseHash: string) =>
    app.inject({
      method: 'PUT',
      url,
      headers: headers(),
      payload: { task: 'cart-total', path: 'Cart.tsx', text, baseHash },
    });
  const saved = await put('mine\n', opened.hash);
  expect(saved.statusCode).toBe(200);
  const file = path.join(temp, '.worktrees', 'cart-total', 'Cart.tsx');
  expect(fs.readFileSync(file, 'utf8')).toBe('mine\n');
  fs.writeFileSync(file, 'agent\n');
  const refused = await put('late\n', saved.json().hash);
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toMatchObject({
    errorCode: 'file_changed_on_disk',
    hash: bytesHash(Buffer.from('agent\n')),
  });
  expect(fs.readFileSync(file, 'utf8')).toBe('agent\n');
  const hashOnly = await app.inject({ url: `${url}${query}&hashOnly=1`, headers: headers() });
  expect(hashOnly.json()).toEqual({ path: 'Cart.tsx', hash: bytesHash(Buffer.from('agent\n')) });
});

it('needs a session and the same origin, and only names real task worktrees', async () => {
  const body = { path: 'a.ts', text: 'x', baseHash: 'h' };
  expect((await app.inject({ method: 'PUT', url, payload: body })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers: { ...headers(), origin: 'http://evil.test' },
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
  for (const task of ['../p', 'nope', 'cart-total/../..'])
    expect(
      (await app.inject({ url: `${url}?task=${encodeURIComponent(task)}&path=a.ts`, headers: headers() }))
        .statusCode,
    ).toBeGreaterThanOrEqual(400);
});
