/** ROOM-THREADS: an open room shows the replies to its old threads, also those before a renew. */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Conversations, Lead } from '../conversations.js';
import {
  EARLIER_ENTRY_MAX_BYTES,
  EARLIER_RETRY_MS,
  GroupMessages,
  ROOM_EARLIER_FILES,
  ROOM_SCAN_MAX_BYTES,
} from '../engine/groupMessages.js';
import { GroupStore, groupTimelineDir } from '../engine/groups.js';
import type { TurnLedger } from '../engine/turnLedger.js';
import { OfficeRooms } from './rooms.js';

const cjsFs = createRequire(__filename)('fs') as typeof fs;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-room-threads-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = new Date(2026, 9, 24, 9, 0).getTime();
const H = 3_600_000;
const MB = 1024 * 1024;
const pad = (v: number) => String(v).padStart(2, '0');
const stamp = (at: number) => {
  const d = new Date(at);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const mid = (i: number, m = 0) => `abcde${'abcdefghijklmnopqrstuvwxyz234567'[m]}${'abcdefghijklmnopqrstuvwxyz234567'[i]}q`;
let n = 0;
const line = (type: string, at: number, content: unknown) =>
  `${JSON.stringify({ type, uuid: `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, timestamp: new Date(at).toISOString(), message: { role: type, content } })}\n`;
/** A member's room turn for post `i` (with its delivery mark, or a pre-C2 header without), its reply, the next turn. */
const turn = (i: number, reply: string, mark: string | null = mid(i), text = `@alpha 일 ${i}`) => {
  const at = T0 + i * H;
  return (
    line('user', at + 1000, `[사장 · 단톡방 '출시팀' · ${stamp(at)}]${mark ? ` ⟨m:${mark}⟩` : ''}\n${text}`) +
    line('assistant', at + 2000, [{ type: 'text', text: reply }]) +
    line('user', at + 2500, `다른 일 ${i}`)
  );
};
const filler = (at: number, mb: number) => {
  const c = line('assistant', at, [{ type: 'text', text: 'x'.repeat(16 * 1024) }]);
  return c.repeat(Math.ceil((mb * MB) / c.length));
};
const post = (i: number, ids: Record<string, string> | null, text = `@alpha 일 ${i}`) => {
  const targets = ids ? Object.keys(ids) : ['alpha'];
  return { id: `post${i}`, at: T0 + i * H, sender: null, roomName: '출시팀', text, targets, delivery: Object.fromEntries(targets.map((m) => [m, 'delivered'])), ...(ids && { messageIds: ids }) };
};

/** An office whose members' transcripts are `files` of one folder (`current`: each member's now). */
function office(
  name: string,
  files: Record<string, string>,
  current: Record<string, string>,
  posts: object[],
  now?: () => number,
) {
  const home = path.join(dir, name);
  const folder = path.join(home, 'transcripts');
  fs.mkdirSync(folder, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, file), text);
  fs.mkdirSync(groupTimelineDir(home), { recursive: true });
  fs.writeFileSync(path.join(groupTimelineDir(home), 'room0001.jsonl'), `${posts.map((p) => JSON.stringify({ v: 1, kind: 'post', post: p })).join('\n')}\n`);
  const members = Object.keys(current);
  const store = new GroupStore(home, () => members, () => 'room0001');
  store.create('출시팀', members);
  const groupMessages = new GroupMessages({ home, store, now, messenger: { send: async () => ({ ok: true, delivered: 'pane' }) } });
  const leads = members.map((m, k) => ({ agentId: k + 1, key: m, name: m, transcript: path.join(folder, current[m]), canSend: true }) as Lead);
  const rooms = new OfficeRooms({
    opts: { chat: true },
    groupStore: store,
    groupMessages,
    conversations: { takeRoomReplies: () => [] } as unknown as Conversations,
    turnLedger: {} as TurnLedger,
    entryOf: () => null,
    leads: () => leads,
    noticeEmployee: () => undefined,
    publish: () => undefined,
  });
  type Sent = { posts: Array<{ id: string; replies: Array<{ member: string; items: Array<{ text: string }> }> }> };
  const sent: Sent[] = [];
  const send = (msg: unknown) => void sent.push(msg as Sent);
  /** The room opened (groupView), then `polls` more 1.5 s view polls: what the last one shows. */
  const view = (polls = 0) => {
    rooms.onClientMessage({ type: 'groupView', room: 'room0001', on: true }, { send, privileged: true });
    for (let k = 0; k < polls; k++) rooms.poll();
    return sent.at(-1)!.posts.map((p) => [p.id, p.replies.map((r) => `${r.member}: ${r.items.map((i) => i.text).join(' | ')}`)]);
  };
  const close = () => rooms.onClientMessage({ type: 'groupView', room: 'room0001', on: false }, { send, privileged: true });
  return { folder, view, close, rooms };
}

/** Bytes read (readSync / readFileSync) while `fn` runs. */
function counted<T>(fn: () => T): { value: T; bytes: number } {
  const { readSync, readFileSync } = cjsFs;
  let bytes = 0;
  cjsFs.readSync = ((...a: Parameters<typeof readSync>) => {
    const r = readSync(...a);
    bytes += r;
    return r;
  }) as typeof readSync;
  cjsFs.readFileSync = ((...a: Parameters<typeof readFileSync>) => {
    const r = readFileSync(...a);
    if (String(a[0]).endsWith('.jsonl')) bytes += Buffer.byteLength(r as string | Buffer);
    return r;
  }) as typeof readFileSync;
  syncBuiltinESMExports();
  try {
    return { value: fn(), bytes };
  } finally {
    Object.assign(cjsFs, { readSync, readFileSync });
    syncBuiltinESMExports();
  }
}

const start = (at: number) => line('user', at, '시작');

describe('ROOM-THREADS: an open room shows its old threads\' replies', () => {
  it('a thread answered before a renew shows its reply (the new conversation holds only the newer one)', () => {
    const { view } = office(
      'renew',
      {
        'old.jsonl': start(T0 - 60_000) + turn(0, '답 0') + turn(1, '답 1'),
        'current.jsonl': start(T0 + 2 * H - 60_000) + turn(2, '답 2'),
      },
      { alpha: 'current.jsonl' },
      [0, 1, 2].map((i) => post(i, { alpha: mid(i) })),
    );
    expect(view()).toEqual([
      ['post0', ['alpha: 답 0']],
      ['post1', ['alpha: 답 1']],
      ['post2', ['alpha: 답 2']],
    ]);
  });

  it(`a thread more than ${ROOM_SCAN_MAX_BYTES / MB} MB back in the transcript shows its reply, one window per build`, () => {
    const { view } = office(
      'grown',
      { 's.jsonl': start(T0 - 60_000) + [0, 1, 2].map((i) => turn(i, `답 ${i}`) + filler(T0 + i * H + 3000, 5)).join('') },
      { alpha: 's.jsonl' },
      [0, 1, 2].map((i) => post(i, { alpha: mid(i) })),
    );
    const { value, bytes } = counted(() => view(2));
    expect(value).toEqual([
      ['post0', ['alpha: 답 0']],
      ['post1', ['alpha: 답 1']],
      ['post2', ['alpha: 답 2']],
    ]);
    // Per build: the tail and one window (ROOM_SCAN_MAX_BYTES each) and the binary search's probes.
    expect(bytes).toBeLessThanOrEqual(3 * (2 * ROOM_SCAN_MAX_BYTES + 2 * MB));
    const again = counted(() => view(1));
    expect(again.value).toEqual(value);
    expect(again.bytes).toBeLessThanOrEqual(2 * (ROOM_SCAN_MAX_BYTES + 64 * 1024)); // the tails only: kept
  });

  it('two members in one folder: each shows its own reply, never the other\'s', () => {
    // alpha's pre-renew conversation began first; beta's (still running) later; alpha renewed since.
    const both = (m: number) => ({ alpha: mid(0, 0), beta: mid(0, 1) })[m === 0 ? 'alpha' : 'beta'];
    const { view } = office(
      'shared',
      {
        'alpha-old.jsonl': start(T0 - 120_000) + turn(0, 'ALPHA 의 답', both(0), '@전체 질문') + line('user', T0 + 600_000, '끝'),
        'beta.jsonl': start(T0 - 60_000) + turn(0, 'BETA 의 답', both(1), '@전체 질문') + line('user', T0 + 3 * H, '진행 중'),
        'alpha-new.jsonl': line('user', T0 + H, '새 대화'),
      },
      { alpha: 'alpha-new.jsonl', beta: 'beta.jsonl' },
      [post(0, { alpha: both(0), beta: both(1) }, '@전체 질문')],
    );
    // beta's later-begun session is looked in first; alpha's own the build after.
    expect(view(ROOM_EARLIER_FILES)).toEqual([['post0', ['alpha: ALPHA 의 답', 'beta: BETA 의 답']]]);
  });

  it('a post without delivery ids (before C2) is not looked for in earlier transcripts: no one else\'s words', () => {
    const { view } = office(
      'no-ids',
      {
        'alpha-old.jsonl': start(T0 - 120_000) + turn(0, 'ALPHA 의 답', null, '@전체 질문') + line('user', T0 + 600_000, '끝'),
        'beta.jsonl': start(T0 - 60_000) + turn(0, 'BETA 의 답', null, '@전체 질문') + line('user', T0 + 3 * H, '진행 중'),
        'alpha-new.jsonl': line('user', T0 + H, '새 대화'),
      },
      { alpha: 'alpha-new.jsonl', beta: 'beta.jsonl' },
      [{ ...post(0, null, '@전체 질문'), targets: ['alpha', 'beta'], delivery: { alpha: 'delivered', beta: 'delivered' } }],
    );
    // beta's own is in its current conversation (the header's words, as before); alpha's is not shown.
    expect(view(ROOM_EARLIER_FILES)).toEqual([['post0', ['alpha: ', 'beta: BETA 의 답']]]);
  });

  it('a later-begun session of someone else in the folder (a hand-run one) does not hide the reply for good', () => {
    const { view } = office(
      'hand-run',
      {
        'old.jsonl': start(T0 - 60_000) + turn(0, '답 0') + line('user', T0 + 600_000, '끝'),
        'hand.jsonl': start(T0 - 30_000) + line('user', T0 + 2 * H, '사람이 직접 연 세션'),
        'current.jsonl': start(T0 + H),
      },
      { alpha: 'current.jsonl' },
      [post(0, { alpha: mid(0) })],
    );
    expect(view(ROOM_EARLIER_FILES)).toEqual([['post0', ['alpha: 답 0']]]);
  });

  it('a folder of 300 transcripts: the first open reads a few KB of each, not their ends', () => {
    const files: Record<string, string> = {};
    for (let k = 0; k < 300; k++) files[`other-${k}.jsonl`] = start(T0 - 3 * 24 * H + k * 1000) + filler(T0 - 3 * 24 * H + k * 1000 + 500, 0.25);
    files['old.jsonl'] = start(T0 - 60_000) + turn(0, '답 0') + filler(T0 + 3000, 6);
    files['current.jsonl'] = start(T0 + H);
    const { view } = office('three-hundred', files, { alpha: 'current.jsonl' }, [post(0, { alpha: mid(0) })]);
    const { value, bytes } = counted(() => view());
    expect(value).toEqual([['post0', ['alpha: 답 0']]]);
    // The window and its probes, and a first-record read of each file: no 256 KB head and tail of each.
    expect(bytes).toBeLessThanOrEqual(ROOM_SCAN_MAX_BYTES + 2 * MB + 300 * 4 * 1024);
  });

  it('a FIFO, a directory or a link named *.jsonl is skipped (an open of a FIFO would block the daemon)', () => {
    const { folder, view } = office(
      'odd-entries',
      { 'old.jsonl': start(T0 - 60_000) + turn(0, '답 0') + line('user', T0 + 600_000, '끝'), 'current.jsonl': start(T0 + H) },
      { alpha: 'current.jsonl' },
      [post(0, { alpha: mid(0) })],
    );
    execFileSync('mkfifo', [path.join(folder, 'pipe.jsonl')]);
    fs.mkdirSync(path.join(folder, 'dir.jsonl'));
    fs.symlinkSync('/dev/zero', path.join(folder, 'zero.jsonl'));
    expect(view(ROOM_EARLIER_FILES)).toEqual([['post0', ['alpha: 답 0']]]);
  });

  it('memory: a kept reply holds at most EARLIER_ENTRY_MAX_BYTES; no viewer, none kept (the next open reads again)', () => {
    const long = '긴 답 '.repeat(20_000);
    const { view, close } = office(
      'memory',
      { 'old.jsonl': start(T0 - 60_000) + turn(0, long) + filler(T0 + 3000, 5) },
      { alpha: 'old.jsonl' },
      [post(0, { alpha: mid(0) })],
    );
    const shown = view()[0][1][0] as string;
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(EARLIER_ENTRY_MAX_BYTES);
    expect(shown.endsWith('…')).toBe(true);
    expect(counted(() => view()).bytes).toBeLessThanOrEqual(ROOM_SCAN_MAX_BYTES + 64 * 1024); // kept: the tail only
    close();
    expect(counted(() => view()).bytes).toBeGreaterThan(ROOM_SCAN_MAX_BYTES + 64 * 1024); // let go: read again
  });

  it('a turn cut off at the end of another post\'s window is not kept empty: its own window shows it', () => {
    // post0's window (from the file's start) ends just after post1's question line, inside its reply.
    const head = start(T0 - 60_000) + turn(0, '답 0');
    const at1 = T0 + H;
    const question = line('user', at1 + 1000, `[사장 · 단톡방 '출시팀' · ${stamp(at1)}] ⟨m:${mid(1)}⟩\n@alpha 일 1`);
    const pad = (k: number) => line('assistant', T0 + 3000, [{ type: 'text', text: 'x'.repeat(k) }]);
    const block = pad(16 * 1024);
    const room = ROOM_SCAN_MAX_BYTES - 10 - Buffer.byteLength(head + question);
    const blocks = Math.floor(room / Buffer.byteLength(block)) - 1;
    const rest = room - blocks * Buffer.byteLength(block);
    const fill = block.repeat(blocks) + pad(rest - Buffer.byteLength(pad(0)));
    expect(Buffer.byteLength(head + fill + question)).toBe(ROOM_SCAN_MAX_BYTES - 10);
    const old = head + fill + question + line('assistant', at1 + 2000, [{ type: 'text', text: '답 1' }]) + line('user', at1 + 2500, '다른 일 1') + line('user', T0 + 2 * H, '끝');
    const { view } = office('cut', { 'old.jsonl': old, 'current.jsonl': start(T0 + 3 * H) }, { alpha: 'current.jsonl' }, [0, 1].map((i) => post(i, { alpha: mid(i) })));
    expect(view(1)).toEqual([
      ['post0', ['alpha: 답 0']],
      ['post1', ['alpha: 답 1']],
    ]);
    expect(view(3).at(-1)).toEqual(['post1', ['alpha: 답 1']]); // and stays: kept whole
  });

  it('posts never found are read again only when a transcript changes, and only those that reached the member', () => {
    let clock = T0 + 30 * 24 * H;
    // 10 delivered to alpha, 10 never (still queued): no transcript holds a turn for any of them.
    const posts = Array.from({ length: 20 }, (_, i) => ({
      ...post(i, { alpha: mid(i % 32) }),
      at: T0 + i * 60_000,
      delivery: { alpha: i < 10 ? 'delivered' : 'pending' },
    }));
    const { folder, view, close, rooms } = office(
      'unfound',
      { 'old.jsonl': start(T0 - 60_000) + filler(T0, 8), 'current.jsonl': start(T0 + 24 * H) },
      { alpha: 'current.jsonl' },
      posts,
      () => clock,
    );
    view();
    let reading = 0;
    const poll = () => {
      clock += 1500;
      if (counted(() => rooms.poll()).bytes > MB) reading++;
    };
    for (let k = 0; k < 400; k++) poll(); // ten minutes of view polls
    // One window per delivered post, once; then nothing (the transcripts stay as they were).
    expect(reading).toBeLessThanOrEqual(12);
    // A transcript changes: after the wait each delivered post is looked in once more.
    fs.appendFileSync(path.join(folder, 'old.jsonl'), line('user', T0 + 2 * H, '더'));
    reading = 0;
    clock += 30 * 60_000;
    for (let k = 0; k < 40; k++) poll();
    expect(reading).toBeGreaterThan(0);
    expect(reading).toBeLessThanOrEqual(12);
    expect(EARLIER_RETRY_MS).toBeLessThan(30 * 60_000);
    // Closed and opened again (a phone does it often): the grown wait stays, nothing is reread.
    close();
    view();
    reading = 0;
    for (let k = 0; k < 40; k++) poll();
    expect(reading).toBe(0);
  });
});

describe('chatSearchAll: the messenger-wide search route', () => {
  const reply = (sent: unknown[], requestId: string) =>
    new Promise<{ groups: Array<{ agentId?: number; roomId?: string; hits: Array<{ snippet: string }> }>; error?: string }>((resolve) => {
      const tick = () => {
        const found = sent.find((m) => (m as { requestId?: string }).requestId === requestId);
        found ? resolve(found as never) : setTimeout(tick, 5);
      };
      tick();
    });

  it('answers a member\'s transcript and the room\'s post; a newer request cancels the older; an unprivileged client is refused', async () => {
    const { rooms } = office(
      'search-all',
      { 's.jsonl': line('user', T0 - 60_000, '키워드 직접 대화') + turn(0, '키워드 방 답') },
      { alpha: 's.jsonl' },
      [post(0, { alpha: mid(0) }, '@alpha 키워드 글')],
    );
    const sent: unknown[] = [];
    const send = (msg: unknown) => void sent.push(msg);
    const ask = (requestId: string, privileged = true) =>
      rooms.onClientMessage({ type: 'chatSearchAll', requestId, query: '키워드' }, { send, privileged });
    expect(ask('a')).toBe(true);
    expect(ask('b')).toBe(true); // replaces 'a' before it answers
    const answer = await reply(sent, 'b');
    expect(answer.groups.map((g) => g.roomId ?? g.agentId).sort()).toEqual([1, 'room0001']);
    expect(answer.groups.find((g) => g.agentId === 1)?.hits.map((h) => h.snippet)).toEqual(['키워드 직접 대화']); // the room turn's reply is not a DM
    expect(answer.groups.find((g) => g.roomId)?.hits[0].snippet).toContain('키워드 글');
    expect(sent.some((m) => (m as { requestId?: string }).requestId === 'a')).toBe(false);
    ask('c', false);
    expect((await reply(sent, 'c')).error).toBeTruthy();
    expect(sent.filter((m) => (m as { requestId?: string }).requestId === 'c')).toHaveLength(1);
  });
});
