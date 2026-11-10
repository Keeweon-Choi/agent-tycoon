import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { GroupMessages } from './engine/groupMessages.js';
import { GroupStore, groupTimelineDir } from './engine/groups.js';
import { DEFAULT_LIMITS, searchAll, type SearchAllLimits, type SearchAllSources } from './searchAll.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agty-search-all-'));
const T0 = 1_790_000_000_000;
const record = (n: number, text: string, type = n % 2 ? 'assistant' : 'user') =>
  JSON.stringify({
    type,
    uuid: `${String(n).padStart(8, '0')}-record`,
    timestamp: new Date(T0 + n * 1000).toISOString(),
    message: { content: type === 'assistant' ? [{ type: 'text', text }] : text },
  }) + '\n';
const transcript = (dir: string, name: string, rows: string[]) => {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, rows.join(''));
  return file;
};
const noRooms: SearchAllSources['roomPosts'] = () => ({ hits: [], truncated: false });
const sources = (leads: SearchAllSources['leads'], rooms: SearchAllSources['rooms'] = [], roomPosts = noRooms): SearchAllSources => ({
  leads,
  rooms,
  roomPosts,
});
const never = () => false;

describe('searchAll: the messenger-wide search', () => {
  it('finds the words in several conversations, grouped, newest first, with a snippet around the match', async () => {
    const dir = root();
    const a = transcript(dir, 'a', [record(0, 'deploy plan'), record(1, 'the Deploy went fine, thanks'), record(2, 'unrelated')]);
    const b = transcript(dir, 'b', [record(10, 'long ago'), record(11, `${'x'.repeat(100)} deploy ${'y'.repeat(100)}`), record(12, '배포 끝')]);
    const result = await searchAll('DEPLOY', sources([{ agentId: 1, transcript: a }, { agentId: 2, transcript: b }]), never);
    expect(result.error).toBeUndefined();
    expect(result.groups.map((g) => g.agentId)).toEqual([2, 1]); // b's match (11) is newer than a's (1)
    expect(result.groups[1].hits.map((h) => h.snippet)).toEqual(['the Deploy went fine, thanks', 'deploy plan']);
    const snippet = result.groups[0].hits[0].snippet;
    expect(snippet.startsWith('…') && snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(100);
    expect(snippet).toContain('deploy');
    expect(result.truncated).toBe(false);
    expect((await searchAll('배포', sources([{ agentId: 2, transcript: b }]), never)).groups[0].hits[0].kind).toBe('user');
  });

  it('refuses a query that is too short or too long and skips conversations without a transcript', async () => {
    expect((await searchAll('a', sources([]), never)).error).toBeTruthy();
    expect((await searchAll('x'.repeat(101), sources([]), never)).error).toBeTruthy();
    expect((await searchAll('needle', sources([{ agentId: 1, transcript: null }, { agentId: 2, transcript: '/nonexistent/x.jsonl' }]), never)).groups).toEqual([]);
  });

  it('lists group room posts with their sender, and a room reply stays out of a one-to-one conversation', async () => {
    const dir = root();
    const file = transcript(dir, 'lead', [
      record(0, "[peer · 단톡방 '출시팀' · 11-04 21:50] ⟨m:roomroom⟩\nlaunch checklist", 'user'),
      record(1, 'launch checklist answered in the room'),
      record(2, 'launch in a direct chat'),
    ]);
    const room = { id: 'r1', name: '출시팀', members: ['lead'] };
    const posts = (r: { id: string }) =>
      r.id === 'r1'
        ? { hits: [{ id: 'p1', at: T0 + 5000, sender: 'lead', snippet: 'launch tag' }, { id: 'p0', at: T0 + 1, sender: null, snippet: 'launch first' }], truncated: false }
        : { hits: [], truncated: false };
    const result = await searchAll('launch', sources([{ agentId: 1, transcript: file }], [room], posts), never);
    expect(result.groups.map((g) => g.roomId ?? g.agentId)).toEqual(['r1', 1]);
    expect(result.groups[0].hits.map((h) => [h.id, h.kind, h.sender])).toEqual([
      ['p1', 'assistant', 'lead'],
      ['p0', 'user', undefined],
    ]);
    expect(result.groups[1].hits.map((h) => h.snippet)).toEqual(['launch in a direct chat']); // the room turn is not a DM
  });

  it('masks secrets in snippets and never confirms a secret by finding it', async () => {
    const dir = root();
    const file = transcript(dir, 'a', [
      record(0, 'set token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 and password=hunter2hunter2 before the deploy'),
      record(1, 'deploy ok'),
    ]);
    const src = sources([{ agentId: 1, transcript: file }]);
    const found = await searchAll('deploy', src, never);
    const texts = found.groups[0].hits.map((h) => h.snippet).join('\n');
    expect(texts).toContain('token=***');
    expect(texts).toContain('password=***');
    expect(texts).not.toMatch(/ghp_|hunter2/);
    expect((await searchAll('hunter2hunter2', src, never)).groups).toEqual([]);
    expect((await searchAll('ghp_abcdefgh', src, never)).groups).toEqual([]);
  });

  it('caps results per conversation and in all, and says so', async () => {
    const dir = root();
    const rows = Array.from({ length: 30 }, (_, n) => record(n, `needle ${n}`));
    const files = [1, 2, 3].map((id) => ({ agentId: id, transcript: transcript(dir, `c${id}`, rows) }));
    const limits: SearchAllLimits = { ...DEFAULT_LIMITS, hitsPerConversation: 4, maxHits: 10 };
    const result = await searchAll('needle', sources(files), never, limits);
    expect(result.groups.map((g) => g.hits.length)).toEqual([4, 4, 2]);
    expect(result.groups.every((g) => g.more)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.groups[0].hits[0].snippet).toContain('needle 29'); // newest first
    const small = await searchAll('needle 7', sources(files.slice(0, 1)), never, limits);
    expect(small.truncated).toBe(false);
    expect(small.groups[0].more).toBe(false);
  });

  it('reads only the newest bytes of a big history and ends within the time limit', async () => {
    const dir = root();
    // ~24 MB: 2000 lines of 12 KB, the word only in the first (oldest) and the last 5 lines.
    const filler = 'z'.repeat(12_000);
    const rows = Array.from({ length: 2000 }, (_, n) => record(n, n === 3 || n >= 1995 ? `needle ${n} ${filler}` : filler));
    const big = transcript(dir, 'big', rows);
    expect(fs.statSync(big).size).toBeGreaterThan(20 * 1024 * 1024);
    const limits: SearchAllLimits = { ...DEFAULT_LIMITS, bytesPerConversation: 1024 * 1024 };
    const before = Date.now();
    const result = await searchAll('needle', sources([{ agentId: 1, transcript: big }]), never, limits);
    expect(Date.now() - before).toBeLessThan(DEFAULT_LIMITS.maxMs);
    const ids = result.groups[0].hits.map((h) => h.snippet.match(/needle (\d+)/)?.[1]);
    expect(ids).toEqual(['1999', '1998', '1997', '1996']);
    expect(result.groups[0].more).toBe(true);
    expect(result.truncated).toBe(true);
    // The old match lies past the window: the next word found nowhere in it is not found.
    const old = sources([{ agentId: 1, transcript: big }]);
    expect((await searchAll('needle 3 ', old, never, limits)).groups).toEqual([]);
    expect((await searchAll('needle 3 ', old, never, { ...DEFAULT_LIMITS, bytesPerConversation: 64 * 1024 * 1024 })).groups[0].hits).toHaveLength(1);
  });

  it('a room turn inside the window of a big file stays out of a one-to-one result, though the file is read from the middle', async () => {
    const dir = root();
    const filler = (from: number) => Array.from({ length: 200 }, (_, n) => record(from + n, 'f'.repeat(12_000)));
    const file = transcript(dir, 'big', [
      ...filler(0),
      record(300, "[peer · 단톡방 '출시팀' · 11-04 21:50] ⟨m:roomroom⟩", 'user'),
      record(301, 'keyword said in the room'),
      record(302, 'keyword typed at the terminal', 'user'),
      ...filler(400).slice(0, 50),
    ]);
    const limits: SearchAllLimits = { ...DEFAULT_LIMITS, bytesPerConversation: 1024 * 1024 };
    const result = await searchAll('keyword', sources([{ agentId: 1, transcript: file }]), never, limits);
    expect(result.groups[0].hits.map((h) => h.snippet)).toEqual(['keyword typed at the terminal']);
  });

  it('stops at the time limit with what it has, the most recently written conversation first', async () => {
    const dir = root();
    const old = transcript(dir, 'old', [record(0, 'needle in the old one')]);
    const fresh = transcript(dir, 'fresh', [record(0, 'needle in the fresh one')]);
    fs.utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    let clock = 0;
    // The clock moves 1 s per look: the limit is 1.5 s, so the second conversation is not reached.
    const now = () => (clock += 1000);
    const result = await searchAll(
      'needle',
      sources([{ agentId: 1, transcript: old }, { agentId: 2, transcript: fresh }]),
      never,
      { ...DEFAULT_LIMITS, maxMs: 2500 },
      now,
    );
    expect(result.groups.map((g) => g.agentId)).toEqual([2]);
    expect(result.truncated).toBe(true);
  });

  it('a newer request cancels: nothing comes back', async () => {
    const dir = root();
    const file = transcript(dir, 'a', [record(0, 'needle')]);
    const result = await searchAll('needle', sources([{ agentId: 1, transcript: file }]), () => true);
    expect(result).toEqual({ groups: [], truncated: false });
  });

  it('room posts: newest first from the room log, system lines and delivery records left out, secrets masked', async () => {
    const home = root();
    fs.mkdirSync(groupTimelineDir(home), { recursive: true });
    const post = (id: string, at: number, text: string, extra: object = {}) =>
      JSON.stringify({ v: 1, kind: 'post', post: { id, at, sender: null, text, targets: [], delivery: {}, ...extra } });
    fs.writeFileSync(
      path.join(groupTimelineDir(home), 'room0001.2026-10.jsonl'),
      [post('old', T0 - 1000, 'ship it later')].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(groupTimelineDir(home), 'room0001.2026-11.jsonl'),
      [
        post('a', T0, 'ship it now'),
        JSON.stringify({ v: 1, kind: 'delivery', id: 'a', member: 'lead', state: 'delivered' }),
        post('b', T0 + 1, 'ship notice: api_key=abc123secret999', { sender: 'lead' }),
        post('c', T0 + 2, 'ship system line', { system: true }),
      ].join('\n') + '\n',
    );
    const store = new GroupStore(home, () => ['lead'], () => 'room0001');
    store.create('출시팀', ['lead']);
    const messages = new GroupMessages({ home, store, messenger: { send: async () => ({ ok: true, delivered: 'pane' }) } });
    const room = store.list().find((r) => r.id === 'room0001')!;
    const result = await searchAll(
      'ship',
      sources([], [room], (r, folded, opts) => messages.searchPosts(r, folded, opts)),
      never,
    );
    expect(result.groups[0].roomId).toBe('room0001');
    expect(result.groups[0].hits.map((h) => h.id)).toEqual(['b', 'a', 'old']);
    expect(result.groups[0].hits[0]).toMatchObject({ kind: 'assistant', sender: 'lead' });
    expect(result.groups[0].hits[0].snippet).toContain('api_key=***');
    expect(result.groups[0].hits[0].snippet).not.toContain('abc123secret999');
    // Only the newest log file: the older month is a further segment the limit leaves unread.
    const one = await searchAll('ship', sources([], [room], (r, f, o) => messages.searchPosts(r, f, { ...o, segments: 1 })), never);
    expect(one.groups[0].hits.map((h) => h.id)).toEqual(['b', 'a']);
    expect(one.truncated).toBe(true);
  });
});
