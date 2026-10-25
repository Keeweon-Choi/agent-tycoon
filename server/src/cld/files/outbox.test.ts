import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { normalizeProjectPath } from '../../../../core/src/normalizeProjectPath.js';
import { StandaloneAuth } from '../auth.js';
import { Conversations, readOptions } from '../conversations.js';
import { GroupMessages, type GroupMessenger } from '../engine/groupMessages.js';
import { GroupStore } from '../engine/groups.js';
import { messageOf, type QueuedSend } from '../engine/messenger.js';
import { chatHistory } from '../transcriptHistory.js';
import { chatItems, lineItems, TranscriptTail } from '../transcriptView.js';
import { ATTACH_MAX, STORED_TYPES } from './attachments.js';
import { OUTBOX, sendOutbox, sentLines, typeOf, uncOutside } from './outbox.js';
import { registerProjectFileRoutes } from './routes.js';

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
let project: string;
let outside: string;
/** Where the lead's own files sit (inside its project). */
let shots: string;
const outboxFiles = () =>
  fs.existsSync(path.join(project, OUTBOX)) ? fs.readdirSync(path.join(project, OUTBOX)) : [];

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 't0105-p-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 't0105-o-'));
  spawnSync('git', ['init', '-q'], { cwd: project });
  shots = path.join(project, 'shots');
  fs.mkdirSync(shots);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(claudeTmp(), { recursive: true, force: true });
});

/** Claude Code's scratchpad root for this project. */
const claudeTmp = () =>
  path.join(os.tmpdir(), `claude-${process.getuid!()}`, normalizeProjectPath(project));
const scratchpad = () => {
  const dir = path.join(claudeTmp(), 'session', 'scratchpad');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const png = (name: string, folder = shots) => {
  const file = path.join(folder, name);
  fs.writeFileSync(file, PNG);
  return file;
};

it('assigns canonical types to stored archive and office files', () => {
  for (const [ext, stored] of Object.entries(STORED_TYPES))
    expect(typeOf(`file${ext}`)).toBe(stored.type);
});

it('copies a sent file once into a 0700 .cld-outbox with a 0600 copy, git-excluded', () => {
  const src = png('shot.png');
  const first = sendOutbox(project, src);
  expect(first).toMatchObject({ name: 'shot.png', type: 'image/png', sizeKb: 1 });
  expect(first.path?.startsWith(path.join(project, OUTBOX) + path.sep)).toBe(true);
  expect(fs.readFileSync(first.path!)).toEqual(PNG);
  expect(fs.statSync(first.path!).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.join(project, OUTBOX)).mode & 0o777).toBe(0o700);
  expect(fs.readFileSync(path.join(project, '.git/info/exclude'), 'utf8')).toContain(
    '.cld-outbox/',
  );
  // Same source and mtime: the same copy, not a second one.
  expect(sendOutbox(project, src)).toEqual(first);
  expect(outboxFiles()).toHaveLength(1);
  // The source changed: a new copy beside it.
  fs.writeFileSync(src, Buffer.concat([PNG, Buffer.from('x')]));
  fs.utimesSync(src, new Date(), new Date(Date.now() + 5000));
  const second = sendOutbox(project, src);
  expect(second.path).not.toBe(first.path);
  expect(outboxFiles()).toHaveLength(2);
});

it('resolves a relative source against the project folder', () => {
  fs.writeFileSync(path.join(project, 'a.png'), PNG);
  expect(sendOutbox(project, 'a.png').path).toBeDefined();
});

it('refuses missing, too big, symlink, directory, FIFO and protected sources: no copy', () => {
  const big = path.join(shots, 'big.png');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, ATTACH_MAX + 1);
  const link = path.join(shots, 'link.png');
  fs.symlinkSync(png('real.png'), link);
  const dir = path.join(shots, 'dir.png');
  fs.mkdirSync(dir);
  const fifo = path.join(shots, 'fifo.png');
  spawnSync('mkfifo', [fifo]);
  fs.mkdirSync(path.join(shots, '.ssh'));
  fs.writeFileSync(path.join(shots, '.ssh', 'known.png'), PNG);
  fs.writeFileSync(path.join(shots, '.env'), 'SECRET=1');
  for (const source of [
    path.join(shots, 'missing.png'),
    big,
    link,
    dir,
    fifo,
    path.join(shots, '.ssh', 'known.png'),
    path.join(shots, '.env'),
  ]) {
    const got = sendOutbox(project, source);
    expect(got).toEqual({ name: path.basename(source), unavailable: true });
  }
  expect(outboxFiles()).toEqual([]);
});

it('copies only from the project, its worktrees and its Claude scratchpad', () => {
  // Elsewhere: another folder, the daemon's own environment, a project folder
  // symlinked out (at any depth of the path), and `..` out of the project.
  fs.mkdirSync(path.join(project, 'deep'));
  fs.symlinkSync(outside, path.join(project, 'deep', 'out'));
  png('away.png', outside);
  for (const source of [
    path.join(outside, 'away.png'),
    '/proc/self/environ',
    path.join(project, 'deep', 'out', 'away.png'),
    path.join(project, '..', path.basename(outside), 'away.png'),
    `../${path.basename(outside)}/away.png`,
  ])
    expect(sendOutbox(project, source).unavailable).toBe(true);
  expect(outboxFiles()).toEqual([]);
  // Inside: the project, a git worktree of it, the scratchpad.
  fs.writeFileSync(path.join(project, 'f.txt'), 'x');
  spawnSync('git', ['add', 'f.txt'], { cwd: project });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], {
    cwd: project,
  });
  const tree = path.join(outside, 'wt');
  expect(spawnSync('git', ['worktree', 'add', '-q', tree], { cwd: project }).status).toBe(0);
  for (const source of [png('in.png'), png('wt.png', tree), png('pad.png', scratchpad())])
    expect(sendOutbox(project, source).path).toBeDefined();
  expect(outboxFiles()).toHaveLength(3);
});

it('a symlinked outbox is not written through', () => {
  fs.symlinkSync(outside, path.join(project, OUTBOX));
  expect(sendOutbox(project, png('a.png')).unavailable).toBe(true);
  expect(fs.readdirSync(outside).filter((n) => n !== 'a.png')).toEqual([]);
});

it('reads [첨부] lines, with or without the (type, size) tail', () => {
  expect(
    sentLines(
      '보냈어요\n[첨부] /a/b c.png (image/png, 3 KB)\n[첨부] /d/e.pdf\n[첨부] relative.png',
    ),
  ).toEqual({ text: '보냈어요\n[첨부] relative.png', paths: ['/a/b c.png', '/d/e.pdf'] });
});

it('R5: [첨부] lines with a Windows path (drive or \\\\wsl.localhost UNC) are attachments too', () => {
  expect(
    sentLines('[첨부] C:\\Users\\u\\a b.png (image/png, 3 KB)\n[첨부] \\\\wsl.localhost\\Ubuntu\\home\\u\\r.pdf\n[첨부] C:rel.txt'),
  ).toEqual({ text: '[첨부] C:rel.txt', paths: ['C:\\Users\\u\\a b.png', '\\\\wsl.localhost\\Ubuntu\\home\\u\\r.pdf'] });
});

it('R5: a Windows UNC or device path outside the project is refused before it is opened (no SMB to another host)', () => {
  const w = (from: string, dir = 'C:\\proj') => uncOutside(from, dir, '\\');
  expect(w('\\\\attacker\\share\\x.png')).toBe(true);
  expect(w('\\\\.\\pipe\\x')).toBe(true);
  expect(w('\\\\?\\C:\\proj\\a.png')).toBe(true);
  expect(w('\\\\wsl.localhost\\Ubuntu\\home\\u\\a.png')).toBe(true);
  expect(w('\\\\wsl.localhost\\Ubuntu\\p\\a.png', '\\\\wsl.localhost\\Ubuntu\\p')).toBe(false);
  expect(w('\\\\wsl.localhost\\Ubuntu\\p2\\a.png', '\\\\wsl.localhost\\Ubuntu\\p')).toBe(true);
  expect(w('C:\\proj\\a.png')).toBe(false);
});

const sendCall = (files: string[], caption = '화면입니다') =>
  JSON.stringify({
    type: 'assistant',
    uuid: 'u1',
    timestamp: '2026-10-22T08:00:00.000Z',
    message: {
      content: [{ type: 'tool_use', id: 't', name: 'SendUserFile', input: { files, caption } }],
    },
  });

it('a SendUserFile call and a [첨부] line both become attachments of an assistant item', () => {
  const a = png('a.png');
  const b = png('b.png');
  const opts = { outbox: (s: string) => sendOutbox(project, s) };
  const call = lineItems(sendCall([a, b]), 0, opts);
  expect(call).toHaveLength(1);
  expect(call[0]).toMatchObject({ kind: 'assistant', text: '화면입니다' });
  expect(call[0].attachments?.map((f) => f.name)).toEqual(['a.png', 'b.png']);
  expect(call[0].attachments?.every((f) => f.path?.includes(OUTBOX))).toBe(true);

  const text = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `여기요\n[첨부] ${a}` }] },
  });
  const item = lineItems(text, 0, opts)[0];
  expect(item).toMatchObject({ kind: 'assistant', text: '여기요' });
  expect(item.attachments?.[0].path).toBe(call[0].attachments?.[0].path);
  expect(outboxFiles()).toHaveLength(2); // a.png once, b.png once
  // Only the file line: still an item, with no text.
  const only = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `[첨부] ${b}` }] },
  });
  expect(lineItems(only, 0, opts)[0]).toMatchObject({ text: '' });
  // A user's [첨부] line is the boss's own attachment: left alone.
  const boss = JSON.stringify({ type: 'user', message: { content: `hi\n[첨부] ${a}` } });
  expect(lineItems(boss, 0, opts)[0].attachments).toBeUndefined();
});

it('without a reader the call stays a tool line and the text stays as written', () => {
  expect(lineItems(sendCall([png('a.png')]))[0].kind).toBe('tool');
  expect(chatItems(sendCall([png('a.png')]) + '\n')).toHaveLength(1);
  expect(outboxFiles()).toEqual([]);
});

it('an unreadable file is an unavailable entry beside the good one', () => {
  const opts = { outbox: (s: string) => sendOutbox(project, s) };
  const [item] = lineItems(sendCall([path.join(shots, 'gone.png'), png('ok.png')]), 0, opts);
  expect(item.attachments?.[0]).toEqual({ name: 'gone.png', unavailable: true });
  expect(item.attachments?.[1].path).toBeDefined();
});

it('the messenger tail and the history page carry the attachments, copying once', async () => {
  const transcript = path.join(outside, 't.jsonl');
  fs.writeFileSync(transcript, `${sendCall([png('a.png'), png('b.png')])}\n`);
  const send = vi.fn();
  const conversations = new Conversations(
    () => [{ agentId: 7, key: 'k', name: 'p', transcript, dir: project, canSend: false }],
    () => undefined,
    () => undefined,
  );
  conversations.view(send, 7, true);
  const told = send.mock.calls[0][0] as {
    items: Array<{ attachments?: Array<{ path?: string }> }>;
  };
  expect(told.items[0].attachments).toHaveLength(2);
  expect(JSON.stringify(told)).not.toContain(shots);
  const tail = new TranscriptTail(undefined, (l, n) =>
    lineItems(l, n, { outbox: (s) => sendOutbox(project, s) }),
  );
  tail.poll(transcript);
  const page = await chatHistory(transcript, undefined, undefined, undefined, {
    outbox: (s) => sendOutbox(project, s),
  });
  expect(page.items[0].attachments?.map((f) => f.path)).toEqual(
    tail.items[0].attachments?.map((f) => f.path),
  );
  expect(outboxFiles()).toHaveLength(2);
  // A lead with no known folder shows nothing special.
  const bare = new Conversations(
    () => [{ agentId: 8, key: 'k2', name: 'q', transcript, canSend: false }],
    () => undefined,
    () => undefined,
  );
  const quiet = vi.fn();
  bare.view(quiet, 8, true);
  expect(quiet.mock.calls[0][0].items[0].kind).toBe('tool');
});

it('a room turn shows a SendUserFile mid-turn as an attachment, like the lead\'s DM', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msf-h-'));
  try {
    const store = new GroupStore(home, () => ['alpha'], () => 'room0001');
    store.create('팀', ['alpha']);
    const at = new Date(2026, 9, 24, 13, 35).getTime();
    const calls: Parameters<GroupMessenger['send']>[0][] = [];
    const groups = new GroupMessages({
      home,
      store,
      messenger: { send: async (r) => (calls.push(r), { ok: true, delivered: 'pane' }) },
      now: () => at,
      ids: () => 'post0001',
    });
    await groups.post({ room: '팀', text: '@alpha 시안', from: null, source: 'messenger:test' });
    const rec = (type: string, content: unknown) => JSON.stringify({ type, message: { content } });
    const transcript = [
      rec('user', messageOf({ v: 1, ...calls[0] } as QueuedSend)),
      rec('assistant', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }]),
      rec('user', [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }]),
      rec('assistant', [{ type: 'tool_use', id: 'b', name: 'SendUserFile', input: { files: [png('d.png')], caption: '시안' } }]),
      rec('user', [{ type: 'tool_result', tool_use_id: 'b', content: 'sent' }]),
      rec('assistant', [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'ls' } }]),
    ].join('\n');
    const lead = { agentId: 1, key: 'k', name: 'alpha', transcript: null, dir: project, canSend: false };
    const [post] = groups.timelineWithReplies(store.find('팀')!, () => transcript, undefined, () =>
      readOptions(lead),
    );
    const sent = post.replies[0].items.filter((i) => i.attachments);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'assistant', text: '시안' });
    expect(sent[0].attachments?.[0].path).toContain(OUTBOX);
    expect(post.replies[0].items.some((i) => i.toolName === 'SendUserFile')).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

let app: FastifyInstance;
let cookie: string;
const headers = () => ({ host: 'office.test', cookie, origin: 'http://office.test' });
const ticket = (relative: string, mode: 'preview' | 'download' = 'preview') =>
  app.inject({
    method: 'POST',
    url: '/api/cld/files/p/ticket',
    headers: headers(),
    payload: { path: relative, mode },
});

it('serves archive and office outbox copies as downloads', async () => {
  const auth = new StandaloneAuth();
  cookie = `cld_session=${auth.createSession('link', 'phone').id}`;
  app = Fastify();
  registerProjectFileRoutes(app, auth, () => [{ name: 'p', folder: project }]);
  await app.ready();
  try {
    for (const ext of Object.keys(STORED_TYPES)) {
      const source = path.join(shots, `sent${ext}`);
      fs.writeFileSync(source, 'stored file');
      const sent = sendOutbox(project, source);
      const minted = await ticket(path.relative(project, sent.path!), 'download');
      expect(minted.statusCode).toBe(200);
      const served = await app.inject({ url: minted.json().url, headers: headers() });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-disposition']).toContain('attachment');
      expect(served.headers['content-disposition']).not.toContain('inline');
    }
  } finally {
    await app.close();
  }
});

it('tickets serve the copy, never the original or anything the copy dir links out to', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const auth = new StandaloneAuth();
  cookie = `cld_session=${auth.createSession('link', 'phone').id}`;
  app = Fastify();
  registerProjectFileRoutes(app, auth, () => [{ name: 'p', folder: project }]);
  await app.ready();
  try {
    // A screenshot in Claude Code's scratchpad for this project: outside the project folder.
    const src = png('shot.png', scratchpad());
    const got = sendOutbox(project, src);
    const relative = path.relative(project, got.path!);
    const ok = await ticket(relative);
    expect(ok.statusCode).toBe(200);
    const served = await app.inject({ url: ok.json().url, headers: headers() });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(PNG);
    // The original's own path is not a project path.
    expect((await ticket(src)).statusCode).toBe(403);
    expect((await ticket(path.relative(project, src))).statusCode).toBeGreaterThanOrEqual(400);
    // A link planted in the outbox to a file outside the project.
    fs.symlinkSync(png('away.png', outside), path.join(project, OUTBOX, 'planted.png'));
    expect((await ticket(`${OUTBOX}/planted.png`)).statusCode).toBe(403);
  } finally {
    await app.close();
  }
});
