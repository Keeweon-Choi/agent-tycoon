import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { StandaloneAuth } from '../auth.js';
import {
  ATTACH_MAX,
  cleanOldAttachments,
  hasStoredMagic,
  storeAttachment,
  STORED_TYPES,
  VIDEO_ATTACH_MAX,
} from './attachments.js';
import { registerProjectFileRoutes } from './routes.js';

let root: string;
let app: ReturnType<typeof Fastify>;
let cookie: string;
const upload = (name: string, type: string, payload: Buffer, origin = 'http://office.test') =>
  app.inject({
    method: 'POST',
    url: '/agty/attach/lead',
    payload,
    headers: {
      host: 'office.test',
      cookie,
      origin,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
      'x-file-type': type,
    },
  });

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 't0067-'));
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  const auth = new StandaloneAuth();
  cookie = `agty_session=${auth.createSession('link', 'phone').id}`;
  app = Fastify();
  registerProjectFileRoutes(app, auth, () => [{ name: 'lead', folder: root }]);
  await app.ready();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it('stores allowed files, logs only metadata and excludes inbox once', async () => {
  for (const name of ['note.txt', 'picture.png', 'photo.jfif']) {
    const data = Buffer.from(name === 'note.txt' ? 'private text' : 'private image bytes');
    const type = name.endsWith('.txt')
      ? 'text/plain'
      : name.endsWith('.png')
        ? 'image/png'
        : 'image/jpeg';
    const reply = await upload(name, type, data);
    expect(reply.statusCode).toBe(200);
    const saved = reply.json();
    expect(saved.path).toMatch(new RegExp(`^${root}/\\.agty-inbox/`));
    expect(fs.readFileSync(saved.path)).toEqual(data);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(`device="phone" project="lead" path=".agty-inbox/`),
    );
  }
  expect(
    fs
      .readFileSync(path.join(root, '.git/info/exclude'), 'utf8')
      .split('\n')
      .filter((x) => x === '.agty-inbox/'),
  ).toHaveLength(1);
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('private text');
});

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const TAR = (() => {
  const body = Buffer.alloc(262);
  body.write('ustar', 257);
  return body;
})();
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]);
const storedBodies: Record<string, Buffer> = {
  '.zip': ZIP,
  '.7z': Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  '.tar': TAR,
  '.gz': Buffer.from([0x1f, 0x8b]),
  '.tgz': Buffer.from([0x1f, 0x8b]),
  '.docx': ZIP,
  '.xlsx': ZIP,
  '.pptx': ZIP,
  '.odt': ZIP,
  '.ods': ZIP,
  '.odp': ZIP,
  '.hwpx': ZIP,
  '.doc': OLE,
  '.xls': OLE,
  '.ppt': OLE,
  '.hwp': OLE,
  '.rtf': Buffer.from('{\\rtf1'),
  '.mp4': MP4,
  '.m4v': MP4,
  '.mov': MP4,
  '.webm': Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]),
};

it('stores signed archive and office files with their canonical types regardless of declaration', async () => {
  let n = 0;
  for (const [ext, stored] of Object.entries(STORED_TYPES)) {
    for (const declared of ['', 'application/octet-stream', 'application/x-zip-compressed']) {
      const reply = await upload(`file-${n++}${ext}`, declared, storedBodies[ext]);
      expect(reply.statusCode).toBe(200);
      expect(reply.json().type).toBe(stored.type);
    }
  }
  expect(hasStoredMagic('empty.zip', Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
});

it('refuses stored files whose body does not match their extension before writing', async () => {
  for (const [name, body] of [
    ['program.zip', Buffer.from('MZ')],
    ['archive.hwp', ZIP],
    ['letter.docx', Buffer.from('plain text')],
  ] as const) {
    const reply = await upload(name, 'application/octet-stream', body);
    expect(reply.statusCode).toBe(415);
    expect(reply.json().error).toBe('파일 내용이 확장자와 맞지 않아요');
  }
  expect(fs.existsSync(path.join(root, '.agty-inbox'))).toBe(false);
});

it('refuses unauthorized, cross origin, huge, unknown and unsafe files', async () => {
  const noCookie = await app.inject({
    method: 'POST',
    url: '/agty/attach/lead',
    payload: 'x',
    headers: {
      host: 'office.test',
      origin: 'http://office.test',
      'content-type': 'application/octet-stream',
      'x-file-name': 'a.txt',
      'x-file-type': 'text/plain',
    },
  });
  expect(noCookie.statusCode).toBe(401);
  expect(
    (await upload('a.txt', 'text/plain', Buffer.from('x'), 'http://bad.test')).statusCode,
  ).toBe(403);
  expect((await upload('a.exe', 'application/octet-stream', Buffer.from('x'))).statusCode).toBe(
    415,
  );
  for (const name of ['../x.txt', '.hidden.txt', 'bad\\name.txt'])
    expect((await upload(name, 'text/plain', Buffer.from('x'))).statusCode).toBe(400);
  expect((await upload('huge.txt', 'text/plain', Buffer.alloc(21 * 1024 * 1024))).statusCode).toBe(
    413,
  );
  expect(fs.existsSync(path.join(root, '.agty-inbox'))).toBe(false);
});

it('refuses a symlinked inbox and cleans only old regular files', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 't0067-out-'));
  fs.symlinkSync(outside, path.join(root, '.agty-inbox'));
  expect((await upload('x.txt', 'text/plain', Buffer.from('x'))).statusCode).toBe(403);
  fs.unlinkSync(path.join(root, '.agty-inbox'));
  const inbox = path.join(root, '.agty-inbox');
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, 'old'), 'x');
  fs.writeFileSync(path.join(inbox, 'fresh'), 'x');
  fs.mkdirSync(path.join(inbox, 'directory'));
  fs.writeFileSync(path.join(inbox, 'directory/old'), 'x');
  fs.symlinkSync(path.join(inbox, 'directory/old'), path.join(inbox, 'link'));
  const now = Date.now();
  fs.utimesSync(
    path.join(inbox, 'old'),
    new Date(now - 31 * 86400000),
    new Date(now - 31 * 86400000),
  );
  cleanOldAttachments(root, now);
  expect(fs.existsSync(path.join(inbox, 'old'))).toBe(false);
  for (const name of ['fresh', 'directory', 'link'])
    expect(fs.existsSync(path.join(inbox, name))).toBe(true);
  fs.rmSync(outside, { recursive: true, force: true });
});

it('limits a message batch to five uploads', async () => {
  const headers = {
    host: 'office.test',
    cookie,
    origin: 'http://office.test',
    'content-type': 'application/octet-stream',
    'x-file-name': 'note.txt',
    'x-file-type': 'text/plain',
    'x-attachment-batch': 'one-message',
  };
  for (let n = 0; n < 5; n++)
    expect(
      (await app.inject({ method: 'POST', url: '/agty/attach/lead', headers, payload: 'x' }))
        .statusCode,
    ).toBe(200);
  expect(
    (await app.inject({ method: 'POST', url: '/agty/attach/lead', headers, payload: 'x' }))
      .statusCode,
  ).toBe(429);
});

it('removes old inbox files when routes register at daemon start', async () => {
  const inbox = path.join(root, '.agty-inbox');
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, 'old.txt'), 'old');
  fs.writeFileSync(path.join(inbox, 'new.txt'), 'new');
  const old = new Date(Date.now() - 31 * 86400000);
  fs.utimesSync(path.join(inbox, 'old.txt'), old, old);
  const restarted = Fastify();
  registerProjectFileRoutes(restarted, new StandaloneAuth(), () => [
    { name: 'lead', folder: root },
  ]);
  await restarted.ready();
  expect(fs.existsSync(path.join(inbox, 'old.txt'))).toBe(false);
  expect(fs.existsSync(path.join(inbox, 'new.txt'))).toBe(true);
  await restarted.close();
});

it('refuses an unauthenticated or cross-origin upload before reading its body', async () => {
  const huge = Buffer.alloc(21 * 1024 * 1024);
  const noCookie = await app.inject({
    method: 'POST',
    url: '/agty/attach/lead',
    payload: huge,
    headers: {
      host: 'office.test',
      origin: 'http://office.test',
      'content-type': 'application/octet-stream',
      'x-file-name': 'a.txt',
      'x-file-type': 'text/plain',
    },
  });
  expect(noCookie.statusCode).toBe(401);
  expect((await upload('a.txt', 'text/plain', huge, 'http://bad.test')).statusCode).toBe(403);
});

it('keeps the 20 MB octet-stream parser to the upload route', async () => {
  const other = Fastify();
  registerProjectFileRoutes(other, new StandaloneAuth(), () => [{ name: 'lead', folder: root }]);
  other.post('/elsewhere', async () => ({ ok: true }));
  const reply = await other.inject({
    method: 'POST',
    url: '/elsewhere',
    payload: Buffer.from('x'),
    headers: { 'content-type': 'application/octet-stream' },
  });
  expect(reply.statusCode).toBe(415);
  await other.close();
});

/** A body that arrives in 1 MiB parts, `total` bytes in all, starting with `first`. */
async function* parts(total: number, first = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(1024 * 1024);
  if (first.length) {
    yield first;
    total -= first.length;
  }
  for (; total > 0; total -= chunk.length) yield chunk.subarray(0, Math.min(total, chunk.length));
}
const inboxFiles = () =>
  fs.existsSync(path.join(root, '.agty-inbox')) ? fs.readdirSync(path.join(root, '.agty-inbox')) : [];

it('stores a video above the general limit and refuses other files there', async () => {
  const video = await upload('clip.mp4', 'video/mp4', Buffer.concat([MP4, Buffer.alloc(ATTACH_MAX)]));
  expect(video.statusCode).toBe(200);
  expect(video.json()).toMatchObject({ type: 'video/mp4', size: MP4.length + ATTACH_MAX });
  expect(fs.statSync(video.json().path).size).toBe(MP4.length + ATTACH_MAX);
  const other = await upload('big.txt', 'text/plain', Buffer.alloc(ATTACH_MAX + 1));
  expect(other.statusCode).toBe(413);
  expect(other.json().error).toBe('파일은 20 MB 이하만 첨부할 수 있어요');
  expect(inboxFiles()).toHaveLength(1);
});

it('refuses a video body whose first bytes are not a video', async () => {
  const reply = await upload('clip.mp4', 'video/mp4', Buffer.from('not a video at all'));
  expect(reply.statusCode).toBe(415);
  expect(inboxFiles()).toEqual([]);
});

it('refuses an over-limit video from its declared length without reading it', async () => {
  const body = parts(0);
  await expect(
    storeAttachment(root, 'clip.mp4', 'video/mp4', body, VIDEO_ATTACH_MAX + 1),
  ).rejects.toMatchObject({ status: 413, message: '동영상은 300 MB 이하만 첨부할 수 있어요' });
  await expect(
    storeAttachment(root, 'note.txt', 'text/plain', parts(0), ATTACH_MAX + 1),
  ).rejects.toMatchObject({ status: 413, message: '파일은 20 MB 이하만 첨부할 수 있어요' });
  expect(inboxFiles()).toEqual([]);
});

it('streams to disk and leaves no partial file when a video passes the limit mid-stream', async () => {
  await expect(
    storeAttachment(root, 'clip.mp4', 'video/mp4', parts(VIDEO_ATTACH_MAX + 1, MP4)),
  ).rejects.toMatchObject({ status: 413 });
  expect(inboxFiles()).toEqual([]);
  // The same video within the limit is stored whole.
  const saved = await storeAttachment(root, 'clip.mp4', 'video/mp4', parts(5 * 1024 * 1024, MP4));
  expect(fs.statSync(saved.path).size).toBe(5 * 1024 * 1024);
  expect(inboxFiles()).toHaveLength(1);
});

it('leaves no partial file when the upload is cut off', async () => {
  async function* cut() {
    yield MP4;
    yield Buffer.alloc(2 * 1024 * 1024);
    throw new Error('aborted');
  }
  await expect(storeAttachment(root, 'clip.mp4', 'video/mp4', cut())).rejects.toThrow('aborted');
  expect(inboxFiles()).toEqual([]);
});
