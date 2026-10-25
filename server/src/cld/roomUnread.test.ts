import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import type { GroupRoom } from '../../../core/src/messages.js';
import {
  GroupMessages,
  type GroupTimelinePost,
  ROOM_SCAN_MAX_BYTES,
  roomEvents,
  roomReplyItems,
  roomTranscript,
} from './engine/groupMessages.js';
import { GroupStore, groupTimelineDir } from './engine/groups.js';
import {
  applyRoomReplies,
  ROOM_PUBLISH_MS,
  RoomSummaries,
  type RoomSummary,
} from './roomUnread.js';
import type { RoomReply } from './transcriptView.js';

const ROOM: GroupRoom = { id: 'room0001', name: '출시팀', members: ['alpha'] };
const HEADER = "[사장 · 단톡방 '출시팀' · 10-24 09:00] ⟨m:aaaaaaaa⟩\n@alpha 배포";
const rec = (type: 'user' | 'assistant', uuid: number, content: unknown) =>
  `${JSON.stringify({
    type,
    uuid: `${uuid.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    timestamp: new Date(Date.UTC(2026, 9, 24, 0, 0, 0) + uuid * 1000).toISOString(),
    message: { role: type, content },
  })}\n`;

/** A transcript of about `mb` MB: old turns of long tool-use text, then the room turn. */
function bigTranscript(mb: number): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-room-unread-')), 's.jsonl');
  const filler = 'x'.repeat(16 * 1024);
  const fd = fs.openSync(file, 'w');
  let n = 0;
  for (let written = 0; written < mb * 1024 * 1024;) {
    const chunk = rec('assistant', ++n, [{ type: 'text', text: filler }]);
    fs.writeSync(fd, chunk);
    written += chunk.length;
  }
  fs.writeSync(fd, rec('user', ++n, HEADER));
  fs.writeSync(fd, rec('assistant', ++n, [{ type: 'text', text: '첫 답' }]));
  fs.closeSync(fd);
  return file;
}

const POST = {
  id: 'post0001',
  at: new Date(2026, 9, 24, 9, 0).getTime(),
  sender: null,
  text: '@alpha 배포',
  targets: ['alpha'],
  delivery: { alpha: 'delivered' as const },
};

describe('C3: the room list keeps its unread without reading the transcripts again', () => {
  const file = bigTranscript(32);
  afterAll(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  let builds = 0;
  let now = 1_800_000_000_000;
  const build = (): RoomSummary => {
    builds++;
    const items = roomReplyItems(fs.readFileSync(file, 'utf8'), ROOM, POST, 'aaaaaaaa');
    const events = roomEvents([
      { ...POST, replies: [{ member: 'alpha', messageId: 'aaaaaaaa', items }] },
    ]);
    return { updates: events.filter((e) => e.counts).map((e) => e.id) };
  };
  const reply = (n: number): RoomReply => ({
    room: { name: '출시팀', id: 'room0001', post: 'post0001' },
    deliveryId: 'aaaaaaaa',
    item: { id: `${now + n}-live${n}-0`, at: now + n, kind: 'assistant', text: `답 ${n}` },
  });

  it('a 32 MB transcript is read once; 200 streamed replies cost no read and little time', () => {
    const summaries = new RoomSummaries(build, () => now);
    const t0 = performance.now();
    const first = summaries.get(ROOM);
    const buildMs = performance.now() - t0;
    expect(builds).toBe(1);
    expect(first.updates).toHaveLength(1); // the first reply (the boss's own post never counts, U-50)
    const t1 = performance.now();
    for (let i = 0; i < 200; i++) {
      now += 1_500; // a poll tick
      summaries.add(ROOM.id, reply(i), 'alpha');
      summaries.due();
      summaries.get(ROOM);
    }
    const streamMs = performance.now() - t1;
    expect(builds).toBe(1); // never read again
    expect(summaries.get(ROOM).updates).toHaveLength(201);
    // builds === 1 is the proof; the clock only guards a gross regression: 200 ticks together cost
    // less than ONE re-read (a floor for a loaded machine, where a stall can dwarf a fast build).
    expect(streamMs).toBeLessThan(Math.max(500, buildMs));
  });

  it('a post or delivery change reads that room again, once; a reply already in it is not added twice', () => {
    builds = 0;
    const summaries = new RoomSummaries(build, () => now);
    summaries.get(ROOM);
    summaries.invalidate(ROOM.id);
    summaries.get(ROOM);
    expect(builds).toBe(2);
    const r = reply(900);
    expect(summaries.add(ROOM.id, r, 'alpha')).toBe(true);
    expect(summaries.add(ROOM.id, r, 'alpha')).toBe(false);
    expect(summaries.get(ROOM).updates.filter((id) => id === r.item.id)).toHaveLength(1);
    expect(summaries.get(ROOM)).toMatchObject({ preview: 'alpha: 답 900' });
    expect(builds).toBe(2);
  });

  it('a room not built yet takes no add (its build will hold the reply)', () => {
    const summaries = new RoomSummaries(build, () => now);
    expect(summaries.add(ROOM.id, reply(1), 'alpha')).toBe(false);
    expect(summaries.due()).toEqual([]);
  });

  it(`a changed room is due at most once per ${ROOM_PUBLISH_MS} ms`, () => {
    const summaries = new RoomSummaries(
      () => ({ updates: ['p'] }),
      () => now,
    );
    summaries.get(ROOM);
    summaries.add(ROOM.id, reply(1), 'alpha');
    expect(summaries.due()).toEqual([ROOM.id]);
    summaries.add(ROOM.id, reply(2), 'alpha');
    expect(summaries.due()).toEqual([]); // too soon; stays due
    now += ROOM_PUBLISH_MS;
    expect(summaries.due()).toEqual([ROOM.id]);
    expect(summaries.due()).toEqual([]);
  });
});

describe('PERF-ROOM: a room reads the end of a member transcript, never the whole file', () => {
  // The bytes read while `fn` runs: every readSync, and readFileSync of the transcript (the room's
  // own record is read whole, as before), counted on the fs the code under test imports (its ESM
  // namespace is refreshed with syncBuiltinESMExports).
  const cjsFs = createRequire(__filename)('fs') as typeof fs;
  function counted<T>(file: string, fn: () => T): { value: T; bytes: number; ms: number } {
    const { readSync, readFileSync } = cjsFs;
    let bytes = 0;
    cjsFs.readSync = ((...a: Parameters<typeof readSync>) => {
      const n = readSync(...a);
      bytes += n;
      return n;
    }) as typeof readSync;
    cjsFs.readFileSync = ((...a: Parameters<typeof readFileSync>) => {
      const r = readFileSync(...a);
      if (a[0] === file) bytes += Buffer.byteLength(r as string | Buffer);
      return r;
    }) as typeof readFileSync;
    syncBuiltinESMExports();
    try {
      const t0 = performance.now();
      const value = fn();
      return { value, bytes, ms: performance.now() - t0 };
    } finally {
      Object.assign(cjsFs, { readSync, readFileSync });
      syncBuiltinESMExports();
    }
  }

  const T0 = new Date(2026, 9, 24, 9, 0).getTime();
  const pad = (v: number) => String(v).padStart(2, '0');
  const stamp = (at: number) => {
    const d = new Date(at);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const mid = (i: number) => `abcdef${'abcdefghijklmnopqrstuvwxyz234567'[i]}q`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-perf-room-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A 40 MB transcript: old filler, then (old post 0's turn, `gapMb` MB more filler) and posts
   *  1..10, each answered with text, a tool call, a 100 KB tool result and more text, then a DM turn. */
  function setup(name: string, gapMb: number) {
    const home = path.join(dir, name);
    const file = path.join(home, 's.jsonl');
    fs.mkdirSync(home);
    let n = 0;
    const line = (type: string, at: number, content: unknown) =>
      `${JSON.stringify({ type, uuid: `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, timestamp: new Date(at).toISOString(), message: { role: type, content } })}\n`;
    const fd = fs.openSync(file, 'w');
    const filler = (mb: number, at: number) => {
      for (let w = 0; w < mb * 1024 * 1024;) {
        const c = line('assistant', at, [{ type: 'text', text: 'x'.repeat(16 * 1024) }]);
        fs.writeSync(fd, c);
        w += c.length;
      }
    };
    const posts: string[] = [];
    const turn = (i: number, at: number) => {
      posts.push(JSON.stringify({ v: 1, kind: 'post', post: { id: `post${i}`, at, sender: null, roomName: '출시팀', text: `@alpha 일 ${i}`, targets: ['alpha'], delivery: { alpha: 'delivered' }, messageIds: { alpha: mid(i) } } }));
      fs.writeSync(fd, line('user', at + 1000, `[사장 · 단톡방 '출시팀' · ${stamp(at)}] ⟨m:${mid(i)}⟩\n@alpha 일 ${i}`));
      fs.writeSync(fd, line('assistant', at + 2000, [{ type: 'text', text: `답 ${i}` }, { type: 'tool_use', name: 'Bash', input: { command: `run ${i}` } }]));
      fs.writeSync(fd, line('user', at + 3000, [{ type: 'tool_result', content: 'y'.repeat(100_000) }]));
      fs.writeSync(fd, line('assistant', at + 4000, [{ type: 'text', text: `끝 ${i}` }]));
      fs.writeSync(fd, line('user', at + 5000, `다른 일 ${i}`));
      fs.writeSync(fd, line('assistant', at + 6000, [{ type: 'text', text: `DM 답 ${i}` }]));
    };
    filler(40 - gapMb, T0 - 86_400_000);
    turn(0, T0);
    filler(gapMb, T0 + 30_000);
    for (let i = 1; i <= 10; i++) turn(i, T0 + i * 60_000);
    fs.closeSync(fd);
    fs.mkdirSync(groupTimelineDir(home), { recursive: true });
    fs.writeFileSync(path.join(groupTimelineDir(home), 'room0001.jsonl'), `${posts.join('\n')}\n`);
    const store = new GroupStore(home, () => ['alpha'], () => 'room0001');
    store.create('출시팀', ['alpha']);
    const room = store.find('출시팀')!;
    const groups = new GroupMessages({ home, store, messenger: { send: async () => ({ ok: true, delivered: 'pane' }) } });
    // The office's reader (office.ts roomTimeline), and the whole-file read it replaced.
    const tail = () => groups.timelineWithReplies(room, (_m, since) => roomTranscript(file, since));
    const whole = () => groups.timelineWithReplies(room, () => fs.readFileSync(file, 'utf8'));
    return { file, tail, whole };
  }
  const texts = (posts: GroupTimelinePost[]) =>
    posts.map((post) => [post.id, post.replies.map((r) => r.items.map((item) => item.text))]);

  it('a room whose posts are recent: its build and its timeline read only the tail, fast, with the same replies', () => {
    const { file, tail, whole } = setup('recent', 1);
    expect(fs.statSync(file).size).toBeGreaterThan(40 * 1024 * 1024);
    const w0 = performance.now();
    const full = whole();
    const wholeMs = performance.now() - w0;
    for (let k = 0; k < 2; k++) {
      // the room list's summary (office buildRoomSummary) and the open timeline: the same read
      const { value, bytes, ms } = counted(file, () => {
        const posts = tail();
        return { posts, updates: roomEvents(posts).filter((e) => e.counts).map((e) => e.id) };
      });
      expect(bytes).toBeLessThanOrEqual(ROOM_SCAN_MAX_BYTES);
      expect(ms).toBeLessThan(Math.max(500, wholeMs)); // bytes above is the proof; this is a gross-regression guard
      expect(value.posts).toEqual(full);
      expect(value.updates).toEqual(roomEvents(full).filter((e) => e.counts).map((e) => e.id));
    }
    expect(texts(full).at(-1)).toEqual(['post10', [['답 10', 'Running: run 10', '끝 10']]]);
  });

  it(`a post whose turn is more than ${ROOM_SCAN_MAX_BYTES / 1024 / 1024} MB back keeps its post, without its replies; the newer ones are unchanged`, () => {
    const { file, tail, whole } = setup('old', 5);
    const w0 = performance.now();
    const full = whole();
    const wholeMs = performance.now() - w0;
    const { value, bytes, ms } = counted(file, tail);
    expect(bytes).toBeLessThanOrEqual(ROOM_SCAN_MAX_BYTES); // read up to the cap, no further
    expect(bytes).toBeGreaterThan(ROOM_SCAN_MAX_BYTES / 2);
    expect(ms).toBeLessThan(Math.max(500, wholeMs));
    expect(texts(full)[0]).toEqual(['post0', [['답 0', 'Running: run 0', '끝 0']]]);
    expect(value[0]).toEqual({ ...full[0], replies: [{ ...full[0].replies[0], items: [] }] });
    expect(value.slice(1)).toEqual(full.slice(1));
  });
});

describe('ROOM-UNREAD: the count follows the room view, not what a tail replays', () => {
  // A room turn answered long ago (5 MB of later transcript): the view (ROOM_SCAN_MAX_BYTES, 4 MB)
  // no longer reaches it, a tail that starts over (16 MB) reads it again.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-room-replay-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  let n = 0;
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, rec('user', ++n, HEADER));
  fs.writeSync(fd, rec('assistant', ++n, [{ type: 'text', text: '옛 답' }]));
  const oldItem = roomReplyItems(fs.readFileSync(file, 'utf8'), ROOM, POST, 'aaaaaaaa')[0];
  for (let written = 0; written < 5 * 1024 * 1024; ) {
    const chunk = rec('assistant', ++n, [{ type: 'text', text: 'x'.repeat(16 * 1024) }]);
    fs.writeSync(fd, chunk);
    written += chunk.length;
  }
  fs.closeSync(fd);
  // What the room view loads (office roomTimeline) and counts (buildRoomSummary).
  const viewUpdates = () => {
    const text = roomTranscript(file, POST.at);
    const items = text === null ? [] : roomReplyItems(text, ROOM, POST, 'aaaaaaaa');
    const post = { ...POST, replies: [{ member: 'alpha', messageId: 'aaaaaaaa', items }] };
    return roomEvents([post])
      .filter((e) => e.counts)
      .map((e) => e.id);
  };
  const replyOf = (item: typeof oldItem): RoomReply => ({
    room: { name: ROOM.name, id: ROOM.id, post: POST.id },
    deliveryId: 'aaaaaaaa',
    item,
  });
  const live = { id: '9-live-0', at: Date.now(), kind: 'assistant' as const, text: '새 답' };
  const find = (r: string) => (r === ROOM.id ? ROOM : undefined);

  it('the view does not show the old reply (so a tail replaying it must not count it)', () => {
    expect(oldItem.text).toBe('옛 답');
    expect(viewUpdates()).not.toContain(oldItem.id);
  });

  it('a replayed reply adds nothing (the room is read again by the view rule); a live one is added', () => {
    const summaries = new RoomSummaries(() => ({ updates: viewUpdates() }));
    expect(summaries.get(ROOM).updates).toEqual(viewUpdates());
    const replay = [{ member: 'alpha', reply: replyOf(oldItem), replayed: true }];
    expect(applyRoomReplies(summaries, replay, find)).toBe(true);
    expect(summaries.get(ROOM).updates).toEqual(viewUpdates()); // not +1
    expect(summaries.get(ROOM).updates).not.toContain(oldItem.id);
    const news = [{ member: 'alpha', reply: replyOf(live), replayed: false }];
    expect(applyRoomReplies(summaries, news, find)).toBe(false);
    expect(summaries.get(ROOM).updates).toEqual([...viewUpdates(), live.id]);
  });
});
