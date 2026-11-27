/** ROOM-THREADS: an open room shows the replies to its old threads, also those before a renew. */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Conversations, Lead, RoomReplyRead } from '../conversations.js';
import {
  EARLIER_ENTRY_MAX_BYTES,
  EARLIER_RETRY_MAX_MS,
  EARLIER_RETRY_MS,
  GroupMessages,
  ROOM_EARLIER_FILES,
  ROOM_SCAN_MAX_BYTES,
} from '../engine/groupMessages.js';
import { GroupStore, groupTimelineDir } from '../engine/groups.js';
import type { TurnLedger } from '../engine/turnLedger.js';
import { OfficeRooms } from './rooms.js';

const cjsFs = createRequire(__filename)('fs') as typeof fs;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-room-threads-'));
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
  posts: object[] | null,
  now?: () => number,
  /** T-113: what the tails read (takeRoomReplies), handed out on the next poll. */
  tailed: RoomReplyRead[] = [],
) {
  const home = path.join(dir, name);
  const folder = path.join(home, 'transcripts');
  fs.mkdirSync(folder, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, file), text);
  fs.mkdirSync(groupTimelineDir(home), { recursive: true });
  // posts null: the office again on the same files (a restart)
  if (posts) fs.writeFileSync(path.join(groupTimelineDir(home), 'room0001.jsonl'), `${posts.map((p) => JSON.stringify({ v: 1, kind: 'post', post: p })).join('\n')}\n`);
  const members = Object.keys(current);
  const store = new GroupStore(home, () => members, () => 'room0001');
  store.create('출시팀', members);
  const groupMessages = new GroupMessages({ home, store, now, messenger: { send: async () => ({ ok: true, delivered: 'pane' }) } });
  const leads = members.map((m, k) => ({ agentId: k + 1, key: m, name: m, transcript: path.join(folder, current[m]), canSend: true }) as Lead);
  const rooms = new OfficeRooms({
    opts: { chat: true },
    groupStore: store,
    groupMessages,
    conversations: { takeRoomReplies: () => tailed.splice(0) } as unknown as Conversations,
    turnLedger: {} as TurnLedger,
    entryOf: () => null,
    leads: () => leads,
    noticeEmployee: () => undefined,
    publish: () => undefined,
  });
  type Sent = {
    type: string;
    ok?: boolean;
    posts: Array<{ id: string; loaded?: true; replies: Array<{ member: string; items: Array<{ text: string }>; seen?: string[]; lastAt?: number }> }>;
  };
  const sent: Sent[] = [];
  const send = (msg: unknown) => void sent.push(msg as Sent);
  const timelines = () => sent.filter((m) => m.type === 'groupTimeline');
  const open = () => rooms.onClientMessage({ type: 'groupView', room: 'room0001', on: true }, { send, privileged: true });
  /** T-113: the reader opens these posts' threads (groupThread). */
  const load = (ids: string[], room = 'room0001', mode?: 'probe' | 'fold') =>
    rooms.onClientMessage({ type: 'groupThread', requestId: `t${sent.length}`, room, posts: ids, ...(mode && { mode }) }, { send, privileged: true });
  /** The room opened (groupView) and every thread in it opened, then `polls` more 1.5 s view polls: what the last one shows. */
  const view = (polls = 0) => {
    open();
    const unread = timelines().at(-1)!.posts.filter((p) => !p.loaded).map((p) => p.id);
    if (unread.length) load(unread); // the threads already open stay loaded: nothing to ask
    for (let k = 0; k < polls; k++) rooms.poll();
    return timelines().at(-1)!.posts.map((p) => [p.id, p.replies.map((r) => `${r.member}: ${r.items.map((i) => i.text).join(' | ')}`)]);
  };
  const close = () => rooms.onClientMessage({ type: 'groupView', room: 'room0001', on: false }, { send, privileged: true });
  /** Each post's recorded reply count per member, as the last timeline carries it. */
  const counts = () => timelines().at(-1)!.posts.map((p) => [p.id, p.replies.map((r) => `${r.member}: ${r.seen?.length ?? 0}`)]);
  /** The background count of earlier posts is done (or never started). */
  const counted = () => vi.waitFor(() => expect((rooms as unknown as { backfilling: Set<string> }).backfilling.size).toBe(0), { timeout: 10_000, interval: 10 });
  return { home, folder, view, close, rooms, open, load, sent, timelines, counts, store, counted, leads };
}

/** The transcripts opened or listed while `fn` runs (the room's own log is not a transcript). */
function transcriptReads<T>(folder: string, fn: () => T): { value: T; reads: number } {
  const { openSync, readdirSync } = cjsFs;
  let reads = 0;
  const mine = (p: unknown) => String(p).startsWith(folder) && reads++;
  cjsFs.openSync = ((...a: Parameters<typeof openSync>) => (mine(a[0]), openSync(...a))) as typeof openSync;
  cjsFs.readdirSync = ((...a: Parameters<typeof readdirSync>) => (mine(a[0]), readdirSync(...a))) as typeof readdirSync;
  syncBuiltinESMExports();
  try {
    return { value: fn(), reads };
  } finally {
    Object.assign(cjsFs, { openSync, readdirSync });
    syncBuiltinESMExports();
  }
}
/** The room's log lines, every segment, as written. */
const logLines = (home: string) =>
  fs.existsSync(groupTimelineDir(home))
    ? fs
        .readdirSync(groupTimelineDir(home))
        .sort()
        .flatMap((f) => fs.readFileSync(path.join(groupTimelineDir(home), f), 'utf8').split('\n').filter(Boolean))
    : [];

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

describe('P3.1: an open room with an opened old thread', () => {
  it('a poll with nothing changed reads no transcript and sends nothing; a change is read and sent once', () => {
    const o = office(
      'unchanged',
      { 's.jsonl': start(T0 - 60_000) + turn(0, '답 0') + filler(T0 + 3000, 5) },
      { alpha: 's.jsonl' },
      [post(0, { alpha: mid(0) })],
    );
    expect(o.view(1)).toEqual([['post0', ['alpha: 답 0']]]);
    const frames = o.timelines().length;
    for (let k = 0; k < 3; k++) expect(counted(() => o.rooms.poll()).bytes).toBe(0);
    expect(o.timelines()).toHaveLength(frames);
    fs.appendFileSync(path.join(o.folder, 's.jsonl'), line('user', T0 + 5 * H, '다른 일'));
    expect(counted(() => o.rooms.poll()).bytes).toBeGreaterThan(MB); // the thread's member read again
    expect(o.timelines()).toHaveLength(frames); // the same timeline: not sent again
    expect(counted(() => o.rooms.poll()).bytes).toBe(0);
    // A second client: its own first frame, then quiet too.
    const sent: unknown[] = [];
    o.rooms.onClientMessage({ type: 'groupView', room: 'room0001', on: true }, { send: (m) => void sent.push(m), privileged: true });
    o.rooms.poll();
    o.rooms.poll();
    expect(sent).toHaveLength(1);
  });
});

describe('P3.1: a post never found whose member no build reads any more', () => {
  it('does not make every poll build again once its wait is over', () => {
    let clock = T0 + 30 * 24 * H;
    const { view, rooms, leads } = office(
      'stale-miss',
      {
        'old.jsonl': start(T0 - 60_000) + filler(T0, 1),
        'current.jsonl': start(T0 + 24 * H),
        'beta.jsonl': start(T0 + 24 * H),
      },
      { alpha: 'current.jsonl', beta: 'beta.jsonl' },
      [{ ...post(0, { alpha: mid(0), beta: mid(0, 1) }), delivery: { alpha: 'delivered', beta: 'pending' } }],
      () => clock,
    );
    view();
    for (let k = 0; k < 400; k++) (clock += 1500), rooms.poll();
    // alpha leaves the office: no build asks for its post again, its old mark stays.
    leads.splice(0, 1);
    rooms.poll();
    clock += EARLIER_RETRY_MAX_MS + 1;
    const build = vi.spyOn(GroupMessages.prototype, 'timelineWithReplies');
    for (let k = 0; k < 100; k++) (clock += 1500), rooms.poll();
    expect(build.mock.calls.length).toBeLessThanOrEqual(1);
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

// post1's answer is two lines (the second at T0 + H + 2200), then the member's next turn.
const two = () => ({
    's.jsonl':
      start(T0 - 60_000) +
      turn(0, '답 0') +
      turn(1, '답 1').replace(/(\n)(?=[^\n]*다른 일 1)/, `$1${line('assistant', T0 + H + 2200, [{ type: 'text', text: '답 1 더' }]).trimEnd()}\n`),
  });
const posts = () => [0, 1].map((i) => post(i, { alpha: mid(i) }));

describe('T-113: a room\'s reply counts come with its posts; a thread\'s replies are read when it is opened', () => {

  it('opening a room reads no transcript; the first frame has the counts recorded, also after a restart', async () => {
    const first = office('count-first', two(), { alpha: 's.jsonl' }, posts());
    first.view(); // a reader opened both threads: what was read is recorded
    expect(first.counts()).toEqual([['post0', ['alpha: 1']], ['post1', ['alpha: 2']]]);
    await first.counted();
    // The daemon starts again on the same files.
    const again = office('count-first', two(), { alpha: 's.jsonl' }, null);
    const { reads } = transcriptReads(again.folder, () => again.open());
    expect(reads).toBe(0);
    const [frame] = again.timelines();
    expect(again.counts()).toEqual([['post0', ['alpha: 1']], ['post1', ['alpha: 2']]]);
    expect(frame.posts.every((p) => !p.loaded && p.replies.every((r) => r.items.length === 0))).toBe(true);
    expect(frame.posts[1].replies[0].lastAt).toBe(T0 + H + 2200);
    // The 1.5 s polls of a room with no thread opened: the first looks at each member's transcript end once
    // (M2: new reply lines stay live), the others read nothing while the transcripts do not grow.
    expect(transcriptReads(again.folder, () => again.rooms.poll()).reads).toBe(1);
    expect(transcriptReads(again.folder, () => [0, 1, 2].forEach(() => again.rooms.poll())).reads).toBe(0);
    await again.counted();
    expect(transcriptReads(again.folder, () => again.rooms.poll()).reads).toBe(0); // and no backfill: it was counted
  });

  it('opening a thread reads its replies (loaded) and keeps them while the room is open; a failed ask is refused', () => {
    const o = office('count-load', two(), { alpha: 's.jsonl' }, posts());
    o.open();
    o.load(['post1']);
    const frame = o.timelines().at(-1)!;
    expect(frame.posts.map((p) => [p.id, !!p.loaded, p.replies[0].items.map((i) => i.text)])).toEqual([
      ['post0', false, []],
      ['post1', true, ['답 1', '답 1 더']],
    ]);
    expect(o.sent.at(-1)).toMatchObject({ type: 'groupThreadResult', ok: true });
    o.rooms.poll();
    expect(o.timelines().at(-1)!.posts[1]).toMatchObject({ loaded: true });
    // A room not open, or one that is not there: refused (the client shows its retry line).
    o.load(['post0'], 'nope');
    expect(o.sent.at(-1)).toMatchObject({ type: 'groupThreadResult', ok: false });
    o.close();
    o.load(['post0']);
    expect(o.sent.at(-1)).toMatchObject({ type: 'groupThreadResult', ok: false });
    // Opened again: nothing is loaded until asked.
    o.open();
    expect(o.timelines().at(-1)!.posts.some((p) => p.loaded)).toBe(false);
  });

  it('a reply a tail reads grows the open room\'s count live, without reading a transcript; each line once', async () => {
    const tailed: RoomReplyRead[] = [];
    const o = office('count-live', two(), { alpha: 's.jsonl' }, posts(), undefined, tailed);
    o.view();
    await o.counted();
    o.close();
    o.open();
    const item = (k: number) => ({ id: `${T0 + 2 * H + k}-0000000${k}-0`, at: T0 + 2 * H + k, kind: 'assistant' as const, text: `늦은 답 ${k}` });
    const read = (k: number, replayed = false): RoomReplyRead => ({
      member: 'alpha',
      reply: { room: { name: '출시팀', id: 'room0001' }, deliveryId: mid(1), item: item(k) },
      replayed,
    });
    o.rooms.poll(); // the open room's first look at its member's transcript end
    tailed.push(read(1), read(2), read(1, true));
    expect(transcriptReads(o.folder, () => o.rooms.poll()).reads).toBe(0);
    expect(o.counts()).toEqual([['post0', ['alpha: 1']], ['post1', ['alpha: 4']]]);
    expect(o.timelines().at(-1)!.posts[1].replies[0].lastAt).toBe(T0 + 2 * H + 2);
  });

  it('posts from before T-113 (nothing recorded) are counted once in the background, then never read for it again', async () => {
    const o = office('count-old', two(), { alpha: 's.jsonl' }, posts());
    o.open();
    expect(o.counts()).toEqual([['post0', ['alpha: 0']], ['post1', ['alpha: 0']]]); // the first frame: nothing known yet
    await o.counted();
    expect(o.counts()).toEqual([['post0', ['alpha: 1']], ['post1', ['alpha: 2']]]); // sent as they were found
    const log = fs.readdirSync(groupTimelineDir(o.home)).flatMap((f) => fs.readFileSync(path.join(groupTimelineDir(o.home), f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l) as { v: number; kind: string });
    expect(log.filter((r) => r.kind === 'counted')).toHaveLength(1);
    // An older build reads v 1 only: what T-113 writes is v 2, and the posts' own lines are as they were.
    expect(log.filter((r) => r.v !== 1).every((r) => r.v === 2 && ['reply', 'counted'].includes(r.kind))).toBe(true);
    expect(log.filter((r) => r.v === 1)).toHaveLength(2);
    o.close();
    const again = office('count-old', two(), { alpha: 's.jsonl' }, null);
    again.open();
    await again.counted();
    expect(again.counts()).toEqual([['post0', ['alpha: 1']], ['post1', ['alpha: 2']]]);
    expect(transcriptReads(again.folder, () => again.open()).reads).toBe(0);
  });
});

describe('T-113 review fixes', () => {
  it('H1: a room with nothing to count is never written: viewing it creates no log file', async () => {
    const empty = office('count-empty', { 's.jsonl': start(T0) }, { alpha: 's.jsonl' }, null);
    empty.open();
    await empty.counted();
    expect(fs.readdirSync(groupTimelineDir(empty.home))).toEqual([]);
    // An untagged post only (a 공지 of nobody, a record): nothing to count, the file stays as it was.
    const plain = office('count-plain', { 's.jsonl': start(T0) }, { alpha: 's.jsonl' }, [{ ...post(0, null), targets: [], delivery: {} }]);
    const before = logLines(plain.home);
    plain.open();
    await plain.counted();
    plain.rooms.groupRooms();
    expect(logLines(plain.home)).toEqual(before);
  });

  it('H2: the earlier posts are counted until each is found or has nothing left to try, then the room is marked', async () => {
    // Seven delivered posts no transcript answers, while four conversations ran; the eighth's answer is in a
    // conversation begun after the seventh (so nothing opened for the others reaches it).
    const files: Record<string, string> = {};
    for (let k = 1; k <= 4; k++) files[`f${k}.jsonl`] = start(T0 - k * 60_000) + line('user', T0 + 7 * H + k, '다른 일');
    files['late.jsonl'] = start(T0 + 6 * H + H / 2) + turn(7, '답 7') + line('user', T0 + 7 * H + 9000, '끝');
    files['current.jsonl'] = start(T0 + 8 * H);
    const o = office('count-early-stop', files, { alpha: 'current.jsonl' }, Array.from({ length: 8 }, (_, i) => post(i, { alpha: mid(i) })));
    o.open();
    await o.counted();
    expect(o.counts().at(-1)).toEqual(['post7', ['alpha: 1']]);
    expect(logLines(o.home).filter((l) => l.includes('"counted"'))).toHaveLength(1);
  });

  it('H2 (the client end): a probe reads posts that show no count until each is found or has nothing left, and keeps none loaded', async () => {
    const files: Record<string, string> = {};
    for (let k = 1; k <= 4; k++) files[`f${k}.jsonl`] = start(T0 - k * 60_000) + line('user', T0 + 7 * H + k, '다른 일');
    files['late.jsonl'] = start(T0 + 6 * H + H / 2) + turn(7, '답 7') + line('user', T0 + 7 * H + 9000, '끝');
    files['current.jsonl'] = start(T0 + 8 * H);
    const o = office('count-probe', files, { alpha: 'current.jsonl' }, Array.from({ length: 8 }, (_, i) => post(i, { alpha: mid(i) })));
    // counted already (an earlier build's mark): only the probe can find post7's reply
    fs.appendFileSync(path.join(groupTimelineDir(o.home), 'room0001.jsonl'), `${JSON.stringify({ v: 2, kind: 'counted', at: T0 + 100 * H })}\n`);
    o.open();
    await o.counted();
    expect(o.counts().at(-1)).toEqual(['post7', ['alpha: 0']]);
    o.load(Array.from({ length: 8 }, (_, i) => `post${i}`), 'room0001', 'probe');
    expect(o.sent.at(-1)).toMatchObject({ type: 'groupThreadResult', ok: true });
    await o.counted();
    expect(o.counts().at(-1)).toEqual(['post7', ['alpha: 1']]);
    const views = (o.rooms as unknown as { groupViews: Map<unknown, Map<string, Set<string>>> }).groupViews;
    expect([...views.values()].every((v) => v.get('room0001')!.size === 0)).toBe(true);
  });

  it('M2: an open room counts a new reply of a member no tail reads, within a poll, after a room rename too, without re-reading the transcript', async () => {
    const o = office('count-untailed', { 's.jsonl': start(T0 - 60_000) + turn(0, '답 0').replace(/[^\n]*다른 일 0[^\n]*\n$/, '') }, { alpha: 's.jsonl' }, [post(0, { alpha: mid(0) })]);
    o.open();
    await o.counted();
    o.rooms.poll(); // the open room's first look at its members' transcripts
    expect(o.counts()).toEqual([['post0', ['alpha: 1']]]);
    o.store.rename('room0001', '새이름');
    fs.appendFileSync(path.join(o.folder, 's.jsonl'), line('assistant', T0 + 3000, [{ type: 'text', text: '답 0 더' }]));
    const { bytes } = counted(() => o.rooms.poll());
    expect(o.counts()).toEqual([['post0', ['alpha: 2']]]);
    expect(bytes).toBeLessThan(64 * 1024); // what was added, and the room's log
  });

  it('L6: one turn that answers two posts counts for both, live', async () => {
    const at0 = T0;
    const at1 = T0 + 60_000;
    const head = (i: number, at: number) => `[사장 · 단톡방 '출시팀' · ${stamp(at)}] ⟨m:${mid(i)}⟩\n@alpha 일 ${i}`;
    const o = office('count-joined', { 's.jsonl': start(T0 - 60_000) }, { alpha: 's.jsonl' }, [post(0, { alpha: mid(0) }), { ...post(1, { alpha: mid(1) }), at: at1 }]);
    o.open();
    await o.counted();
    o.rooms.poll();
    fs.appendFileSync(path.join(o.folder, 's.jsonl'), line('user', at1 + 1000, `${head(0, at0)}\n\n${head(1, at1)}`) + line('assistant', at1 + 2000, [{ type: 'text', text: '둘 다 했어요' }]));
    o.rooms.poll();
    expect(o.counts()).toEqual([['post0', ['alpha: 1']], ['post1', ['alpha: 1']]]);
  });

  it('L3: groupThread keeps only the room\'s own post ids, and at most the posts it shows', () => {
    const o = office('count-ids', two(), { alpha: 's.jsonl' }, posts());
    o.open();
    o.load(['post1', 'nope', ...Array.from({ length: 500 }, (_, k) => `junk${k}`)]);
    const views = (o.rooms as unknown as { groupViews: Map<unknown, Map<string, Set<string>>> }).groupViews;
    expect([...[...views.values()][0].get('room0001')!]).toEqual(['post1']);
  });
});

describe('T-113 review round 2', () => {
  const KB = 1024;
  const FOLLOW = 256 * KB; // what an open room reads of a member's transcript at most (CHAT_TAIL_BYTES)
  const korean = (at: number, n: number) => line('assistant', at, [{ type: 'text', text: '한글로 쓴 긴 작업 기록입니다 '.repeat(n) }]);
  /** `text` ended with a short ASCII line padded so the byte `back` bytes before the end continues a Korean character. */
  const cutInKorean = (text: string, back: number, after = '') => {
    for (let pad = 0; pad < 3; pad++) {
      const t = `${text}${JSON.stringify({ pad: 'x'.repeat(pad) })}\n${after}`;
      const b = Buffer.from(t);
      if (b.length > back && (b[b.length - back] & 0xc0) === 0x80) return t;
    }
    throw new Error('no cut inside a character');
  };
  const header = (i: number) => line('user', T0 + i * H + 1000, `[사장 · 단톡방 '출시팀' · ${stamp(T0 + i * H)}] ⟨m:${mid(i)}⟩\n@alpha 일 ${i}`);
  const answer = (i: number) => line('assistant', T0 + i * H + 2000, [{ type: 'text', text: `답 ${i}` }]);

  it('N2: an open room\'s first look that starts inside a Korean character still binds the next reply', async () => {
    let body = start(T0 - 60_000);
    while (Buffer.byteLength(body) < FOLLOW + 64 * KB) body += korean(T0 - 30_000, 40);
    const o = office('follow-cut-first', { 's.jsonl': cutInKorean(body, FOLLOW) }, { alpha: 's.jsonl' }, [post(0, { alpha: mid(0) })]);
    o.open();
    await o.counted();
    o.rooms.poll(); // the first look: from 256 KB before the end, inside a character
    fs.appendFileSync(path.join(o.folder, 's.jsonl'), header(0) + answer(0));
    o.rooms.poll();
    expect(o.counts()).toEqual([['post0', ['alpha: 1']]]);
  });

  it('N2: a look that skips a burst and lands inside a Korean character keeps its place on the bytes', async () => {
    const o = office('follow-cut-skip', { 's.jsonl': start(T0 - 60_000) }, { alpha: 's.jsonl' }, [post(0, { alpha: mid(0) })]);
    o.open();
    await o.counted();
    o.rooms.poll();
    const file = path.join(o.folder, 's.jsonl');
    let burst = '';
    while (Buffer.byteLength(burst) < FOLLOW + 64 * KB) burst += korean(T0 - 30_000, 40);
    const tail = header(0) + answer(0);
    // padded until the look's cut (256 KB before the new end) falls inside a character of the burst
    fs.appendFileSync(file, cutInKorean(burst, FOLLOW, tail));
    o.rooms.poll(); // skips the burst's head: the reply after it is bound
    expect(o.counts()).toEqual([['post0', ['alpha: 1']]]);
    fs.appendFileSync(file, line('assistant', T0 + 3000, [{ type: 'text', text: '답 0 더' }]));
    o.rooms.poll(); // the next read starts where the last one ended, on a line
    expect(o.counts()).toEqual([['post0', ['alpha: 2']]]);
  });

  it('N2: a line written in two parts (cut inside a character) counts once it is whole', async () => {
    const o = office('follow-split', { 's.jsonl': start(T0 - 60_000) }, { alpha: 's.jsonl' }, [post(0, { alpha: mid(0) })]);
    o.open();
    await o.counted();
    o.rooms.poll();
    const file = path.join(o.folder, 's.jsonl');
    const reply = Buffer.from(line('assistant', T0 + 2000, [{ type: 'text', text: '한글 답이에요' }]));
    const cut = reply.indexOf(Buffer.from('글')) + 1; // inside 글
    fs.appendFileSync(file, Buffer.concat([Buffer.from(header(0)), reply.subarray(0, cut)]));
    o.rooms.poll();
    expect(o.counts()).toEqual([['post0', ['alpha: 0']]]);
    fs.appendFileSync(file, reply.subarray(cut));
    o.rooms.poll();
    expect(o.counts()).toEqual([['post0', ['alpha: 1']]]);
    fs.appendFileSync(file, answer(0));
    o.rooms.poll();
    expect(o.counts()).toEqual([['post0', ['alpha: 2']]]); // and the position stayed on the bytes
  });

  it('N4: a groupThread with a mode the protocol does not list is refused, and loads nothing', () => {
    const o = office('mode-unknown', two(), { alpha: 's.jsonl' }, posts());
    o.open();
    o.load(['post1'], 'room0001', 'peek' as never);
    expect(o.sent.at(-1)).toMatchObject({ type: 'groupThreadResult', ok: false, errorCode: 'bad_request' });
  });
});
