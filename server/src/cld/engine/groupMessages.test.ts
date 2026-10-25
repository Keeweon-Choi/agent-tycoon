import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { GroupMessages, type GroupMessenger,roomEvents, roomMentions, roomReplyItems } from './groupMessages.js';
import { GroupStore, groupTimelineDir } from './groups.js';
import { messageOf, type QueuedSend } from './messenger.js';

let homes: string[] = [];
afterEach(() => { for (const home of homes) fs.rmSync(home, { recursive: true, force: true }); homes = []; });
const home = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-group-post-')); homes.push(value); return value; };

describe('room mentions', () => {
  it('handles Korean names and punctuation, all, and an unknown member', () => {
    expect(roomMentions('@가나다, @alpha!', ['가나다', 'alpha', 'beta']).targets).toEqual(['가나다', 'alpha']);
    expect(roomMentions('@전체 점검', ['가나다', 'alpha']).targets).toEqual(['가나다', 'alpha']);
    expect(roomMentions('@없는이름 확인', ['가나다']).error).toBe("방에 '없는이름' 구성원이 없어요");
  });
});

describe('GroupMessages', () => {
  it('keeps an untagged post as a record and fans tagged members out with room headers', async () => {
    const h = home();
    const store = new GroupStore(h, () => ['alpha', 'beta'], () => 'room0001');
    store.create('출시팀', ['alpha', 'beta']);
    const calls: Parameters<GroupMessenger['send']>[0][] = [];
    const messenger: GroupMessenger = { send: async (request) => { calls.push(request); return { ok: true, delivered: 'pane' }; } };
    const groups = new GroupMessages({ home: h, store, messenger, now: () => 1_700_000_000_000, ids: () => 'post0001' });
    expect(await groups.post({ room: '출시팀', text: 'FYI: 배포 예정', from: null, source: 'messenger:test' })).toMatchObject({ ok: true });
    expect(calls).toEqual([]);
    const sent = await groups.post({ room: '출시팀', text: '@alpha, @beta 준비', from: null, source: 'messenger:test' });
    expect(sent).toMatchObject({ ok: true, post: { targets: ['alpha', 'beta'], delivery: { alpha: 'delivered', beta: 'delivered' } } });
    expect(calls.map((call) => call.to)).toEqual(['alpha', 'beta']);
    expect(calls[0].group).toEqual({ roomId: 'room0001', roomName: '출시팀', messageId: 'post0001' });
  });

  it('MSG-ACTIONS: a reply post keeps its reference and every tagged member receives it', async () => {
    const h = home();
    const store = new GroupStore(h, () => ['alpha', 'beta'], () => 'room0009');
    store.create('출시팀', ['alpha', 'beta']);
    const calls: Parameters<GroupMessenger['send']>[0][] = [];
    const messenger: GroupMessenger = { send: async (request) => { calls.push(request); return { ok: true, delivered: 'pane' }; } };
    let n = 0;
    const groups = new GroupMessages({ home: h, store, messenger, ids: () => `post000${++n}` });
    const replyTo = { id: '1729738800000-abcd1234-3', sender: 'alpha', text: '배포 끝났어요' };
    const sent = await groups.post({ room: '출시팀', text: '@전체 확인해 줘', from: null, source: 'messenger:test', replyTo });
    expect(sent).toMatchObject({ ok: true, post: { replyTo } });
    expect(calls.map((call) => [call.to, call.replyTo])).toEqual([['alpha', replyTo], ['beta', replyTo]]);
    // What a member is typed: the reference after its own mark, then the quote line.
    const typed = messageOf({ v: 1, created: 1, ...calls[1] } as QueuedSend);
    expect(typed).toMatch(/ ⟨m:[a-z2-7]{8}⟩ ⟨re:1729738800000-abcd1234-3⟩\n> alpha: 배포 끝났어요\n@전체 확인해 줘$/);
    // Read back from the room's file (and a malformed reference is not a reference).
    const room = store.find('출시팀')!;
    expect(groups.timeline(room)[0].replyTo).toEqual(replyTo);
    expect((await groups.post({ room: '출시팀', text: '그냥 글', from: null, source: 'messenger:test', replyTo: { id: 'a b', text: 'x' } }))).toMatchObject({ ok: true });
    expect(groups.timeline(room).map((post) => post.replyTo ?? null)).toEqual([replyTo, null]);
  });

  it('gathers the full room turn, including tool calls, but not a later unrelated turn', () => {
    const room = { id: 'room0003', name: '출시팀', members: ['alpha'] };
    const post = { id: 'post0003', at: new Date(2026, 9, 22, 15, 5).getTime(), sender: null, text: '@alpha 배포해', targets: ['alpha'], delivery: { alpha: 'delivered' as const } };
    const line = (value: object) => `${JSON.stringify(value)}\n`;
    const transcript =
      line({ type: 'user', message: { content: "[사장 · 단톡방 '출시팀' · 10-22 15:05]\n@alpha 배포해" } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '배포를 시작합니다' }, { type: 'tool_use', name: 'Bash', input: { command: 'deploy' } }] } }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: '완료' }] } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '배포가 끝났습니다' }] } }) +
      line({ type: 'user', message: { content: '다른 일입니다' } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '이 줄은 답장이 아니에요' }] } });
    expect(roomReplyItems(transcript, room, post).map((item) => item.text)).toEqual(['배포를 시작합니다', 'Running: deploy', '배포가 끝났습니다']);
  });

  it('folds a held delivery then its eventual inbox state without rewriting the post', async () => {
    const h = home();
    const store = new GroupStore(h, () => ['alpha'], () => 'room0002');
    store.create('출시팀', ['alpha']);
    const groups = new GroupMessages({ home: h, store, messenger: { send: async () => ({ ok: true, delivered: 'queued' }) }, ids: () => 'post0002' });
    await groups.post({ room: '출시팀', text: '@alpha 확인', from: 'ops', source: 'cli' });
    const item = { v: 1 as const, to: 'alpha', text: '@alpha 확인', from: 'ops', source: 'cli', ifIdle: false, created: 1, group: { roomId: 'room0002', roomName: '출시팀', messageId: 'post0002' } };
    groups.observe(item, 'held');
    groups.observe(item, 'queued');
    expect(groups.timeline(store.find('출시팀')!)[0].delivery).toEqual({ alpha: 'held' });
    groups.observe(item, 'inbox');
    expect(groups.timeline(store.find('출시팀')!)[0].delivery).toEqual({ alpha: 'off' });
  });

  it('never lets the CLI write the boss header or name', async () => {
    const h = home();
    const store = new GroupStore(h, () => ['alpha'], () => 'room0004');
    store.create('출시팀', ['alpha']);
    const calls: Parameters<GroupMessenger['send']>[0][] = [];
    const messenger: GroupMessenger = { send: async (request) => { calls.push(request); return { ok: true, delivered: 'pane' }; } };
    const groups = new GroupMessages({ home: h, store, messenger });
    expect(await groups.post({ room: '출시팀', text: '@alpha 시켜', from: '사장', source: 'cli' })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    expect(await groups.post({ room: '출시팀', text: '@alpha 시켜', from: null, source: 'cli' })).toMatchObject({ ok: true, post: { sender: 'cld-gui' } });
    expect(await groups.post({ room: '출시팀', text: '@alpha 시켜', from: null, source: 'messenger:pc' })).toMatchObject({ ok: true, post: { sender: null } });
  });

  it('still gathers replies after the room is renamed', async () => {
    const h = home();
    const store = new GroupStore(h, () => ['alpha'], () => 'room0005');
    store.create('출시팀', ['alpha']);
    const calls: Parameters<GroupMessenger['send']>[0][] = [];
    const groups = new GroupMessages({ home: h, store, messenger: { send: async (r) => (calls.push(r), { ok: true, delivered: 'pane' }) }, now: () => new Date(2026, 9, 22, 15, 5).getTime() });
    await groups.post({ room: '출시팀', text: '@alpha 배포해', from: null, source: 'messenger:pc' });
    store.rename('room0005', '새이름');
    const typed = messageOf({ v: 1, ...calls[0] } as QueuedSend); // the old name's header, and its mark
    expect(typed.split('\n')[0]).toMatch(/^\[사장 · 단톡방 '출시팀' · 10-22 15:05\] ⟨m:[a-z2-7]{8}⟩$/);
    const transcript = `${JSON.stringify({ type: 'user', message: { content: typed } })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '했어요' }] } })}\n`;
    const [post] = groups.timelineWithReplies(store.find('새이름')!, () => transcript);
    expect(post.replies[0].items.map((i) => i.text)).toEqual(['했어요']);
    expect('roomName' in post).toBe(false);
    expect('messageIds' in post).toBe(false);
  });

  it('C2: a room record whose delivery ids are not ours is read without them (header text, as before)', () => {
    const h = home();
    const store = new GroupStore(h, () => ['alpha', 'beta'], () => 'room0007');
    store.create('출시팀', ['alpha', 'beta']);
    const at = new Date(2026, 9, 22, 15, 5).getTime();
    const post = (id: string, messageIds: unknown) =>
      JSON.stringify({ v: 1, kind: 'post', post: { id, at, roomName: '출시팀', sender: null, text: '@alpha 배포해', targets: ['alpha'], delivery: { alpha: 'delivered' }, messageIds } });
    fs.mkdirSync(groupTimelineDir(h), { recursive: true });
    fs.writeFileSync(
      path.join(groupTimelineDir(h), 'room0007.jsonl'),
      [post('p1', { alpha: 'NOT-AN-ID' }), post('p2', ['ab2cd3ef']), post('p3', { alpha: 'ab2cd3ef' })].join('\n') + '\n',
    );
    const groups = new GroupMessages({ home: h, store, messenger: { send: async () => ({ ok: true, delivered: 'pane' }) } });
    const room = store.find('출시팀')!;
    expect(groups.timeline(room).map((p) => p.messageIds ?? null)).toEqual([null, null, { alpha: 'ab2cd3ef' }]);
    const transcript = `${JSON.stringify({ type: 'user', message: { content: "[사장 · 단톡방 '출시팀' · 10-22 15:05]\n@alpha 배포해" } })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '했어요' }] } })}\n`;
    const posts = groups.timelineWithReplies(room, () => transcript);
    expect(posts.map((p) => p.replies.map((r) => [r.messageId ?? null, r.items.map((i) => i.text)]))).toEqual([
      [[null, ['했어요']]],
      [[null, ['했어요']]],
      [['ab2cd3ef', []]], // a valid id finds only its own marked turn
    ]);
  });

  it('C2: two identical posts in the same minute: each member\'s reply attaches to its own post', async () => {
    const h = home();
    const store = new GroupStore(h, () => ['alpha', 'beta'], () => 'room0006');
    store.create('출시팀', ['alpha', 'beta']);
    const calls: Parameters<GroupMessenger['send']>[0][] = [];
    let n = 0;
    const groups = new GroupMessages({
      home: h,
      store,
      messenger: { send: async (r) => (calls.push(r), { ok: true, delivered: 'pane' }) },
      now: () => new Date(2026, 9, 22, 15, 5, n++).getTime(), // the same minute
      ids: () => `post000${n}`,
    });
    const first = await groups.post({ room: '출시팀', text: '@alpha @beta 배포 확인', from: null, source: 'messenger:pc' });
    const second = await groups.post({ room: '출시팀', text: '@alpha @beta 배포 확인', from: null, source: 'messenger:pc' });
    if (!first.ok || !second.ok) throw new Error('not posted');
    // One post id per post, one delivery id per member, each recorded with the post.
    expect(calls.map((c) => [c.to, c.group?.messageId])).toEqual([
      ['alpha', first.post.id],
      ['beta', first.post.id],
      ['alpha', second.post.id],
      ['beta', second.post.id],
    ]);
    const ids = calls.map((c) => c.messageId);
    expect(new Set(ids).size).toBe(4);
    const line = (value: object) => `${JSON.stringify(value)}\n`;
    const turn = (call: (typeof calls)[number], answer: string) =>
      line({ type: 'user', message: { content: messageOf({ v: 1, ...call } as QueuedSend) } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
    const transcripts: Record<string, string> = {
      alpha: turn(calls[0], 'alpha: 첫 글에 답') + turn(calls[2], 'alpha: 둘째 글에 답'),
      // beta answers the second post first: a reply is found by its mark, not by its place.
      beta: turn(calls[3], 'beta: 둘째 글에 답') + turn(calls[1], 'beta: 첫 글에 답'),
    };
    const posts = groups.timelineWithReplies(store.find('출시팀')!, (member) => transcripts[member]);
    expect(
      posts.map((p) => p.replies.map((r) => [r.member, r.messageId, r.items.map((i) => i.text)])),
    ).toEqual([
      [
        ['alpha', ids[0], ['alpha: 첫 글에 답']],
        ['beta', ids[1], ['beta: 첫 글에 답']],
      ],
      [
        ['alpha', ids[2], ['alpha: 둘째 글에 답']],
        ['beta', ids[3], ['beta: 둘째 글에 답']],
      ],
    ]);
    expect(posts[0].replies[0].items[0].messageId).toBe(ids[0]);
  });
});

describe('C3: what the room list counts as unread', () => {
  it('named posts and member text count; the boss post and tool line do not', () => {
    const item = (id: string, kind: 'assistant' | 'tool', at: number) => ({ id, at, kind, text: id });
    const replies = [
      { member: 'alpha', items: [item('a-tool', 'tool', 1100), item('a-text', 'assistant', 1200)] },
      { member: 'beta', items: [item('b-text', 'assistant', 1300)] },
    ];
    const events = roomEvents([
      {
        id: 'boss0001',
        at: 1000,
        sender: null,
        text: '@alpha @beta 배포',
        targets: ['alpha', 'beta'],
        delivery: { alpha: 'delivered' as const, beta: 'delivered' as const },
        replies,
      },
      {
        id: 'ops00001',
        at: 1400,
        sender: 'ops-lead',
        text: '배포 상태',
        targets: [],
        delivery: {},
        replies: [],
      },
    ]);
    expect(events.filter((event) => event.counts).map((event) => event.id)).toEqual([
      'a-text',
      'b-text',
      '1400-ops00001',
    ]);
    expect(events.map((event) => event.id)).toContain('a-tool'); // still the preview's and the last time's
  });
});

// TOKEN-GUARD (directive 10-24): a room never echoes a post to its own sender, and the daemon's
// own summary posts wake nobody; the boss's and agents' mentions still reach everyone else.
describe('TOKEN-GUARD: rooms', () => {
  const rig = (members = ['alpha', 'beta', 'gamma']) => {
    const h = home();
    const store = new GroupStore(h, () => members, () => 'room0100');
    store.create('개발', members);
    const calls: Parameters<GroupMessenger['send']>[0][] = [];
    const guards: Array<Record<string, unknown>> = [];
    const messenger: GroupMessenger = {
      send: async (request) => { calls.push(request); return { ok: true, delivered: 'pane' }; },
      guard: (fields) => guards.push(fields),
    };
    let n = 0;
    const groups = new GroupMessages({ home: h, store, messenger, ids: () => `post0${++n}` });
    return { groups, calls, guards, store };
  };

  it('TG-02a: an agent\'s @전체 (or a self-mention) never comes back to the agent itself', async () => {
    const r = rig();
    const sent = await r.groups.post({ room: '개발', text: '@전체 @alpha 끝났어요', from: 'alpha', source: 'mcp' });
    expect(sent).toMatchObject({ ok: true, post: { targets: ['beta', 'gamma'] } });
    expect(r.calls.map((c) => c.to)).toEqual(['beta', 'gamma']);
    expect(r.guards).toEqual([
      expect.objectContaining({ trigger: 'room', to: 'alpha', from: 'alpha', allowed: false, reason: 'room_echo' }),
    ]);
    // Negative: the boss's @전체 reaches every member.
    r.calls.length = 0;
    await r.groups.post({ room: '개발', text: '@전체 점검', from: null, source: 'messenger:test' });
    expect(r.calls.map((c) => c.to)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('TG-02b: the daemon\'s copy of a Codex Worker\'s summary is shown in the room but wakes nobody', async () => {
    const r = rig();
    const sent = await r.groups.post({ room: '개발', text: '@전체 다음은 @beta 차례', from: 'gamma', source: 'codex', quiet: true });
    expect(sent).toMatchObject({ ok: true, post: { targets: [], text: '@전체 다음은 @beta 차례' } });
    expect(r.calls).toEqual([]);
    expect(r.guards).toEqual([
      expect.objectContaining({ trigger: 'room_summary', from: 'gamma', allowed: false, reason: 'summary_post', targets: 3 }),
    ]);
  });
});

describe('C4: system lines in rooms (F-18)', () => {
  it('one short line in each room holding both parties, delivered to nobody, no unread; the room can turn them off', () => {
    const h = home();
    let n = 0;
    const store = new GroupStore(h, () => ['alpha', 'alpha-w1', 'beta'], () => `room000${++n}`, () => ['alpha', 'beta']);
    const dev = store.create('개발', ['alpha', 'alpha-w1']);
    store.create('리드', ['alpha', 'beta']); // no Worker in it: the assignment is not its business
    const calls: unknown[] = [];
    const messenger: GroupMessenger = { send: async (r) => { calls.push(r); return { ok: true, delivered: 'pane' }; } };
    const groups = new GroupMessages({ home: h, store, messenger, now: () => 1_700_000_000_000 });
    groups.system({ kind: 'assigned', task: 'T-7', from: 'alpha', to: 'alpha-w1', detail: '로그인\n고치기' });
    const room = store.find('개발')!;
    expect(groups.timeline(room)).toEqual([
      expect.objectContaining({ sender: 'cld-gui', text: 'Task T-7 배정: alpha → alpha-w1 · 로그인 고치기', targets: [], system: true }),
    ]);
    expect(groups.timeline(store.find('리드')!)).toEqual([]);
    expect(groups.timeline(store.find('전체')!)).toEqual([]);
    expect(calls).toEqual([]); // wakes nobody
    expect(roomEvents(groups.timeline(room).map((p) => ({ ...p, replies: [] }))).map((e) => e.counts)).toEqual([false]);
    // Off: no new line, and the old one is hidden; on again: both show.
    expect(store.setSystemLines(dev.ok ? dev.value.id : '', false)).toMatchObject({ ok: true, value: { systemLines: false } });
    groups.system({ kind: 'reported', task: 'T-7', from: 'alpha-w1', to: 'alpha', detail: 'review' });
    expect(groups.timeline(store.find('개발')!)).toEqual([]);
    store.load(); // kept on disk
    expect(store.find('개발')!.systemLines).toBe(false);
    store.setSystemLines(store.find('개발')!.id, true);
    expect(groups.timeline(store.find('개발')!).map((p) => p.text)).toEqual(['Task T-7 배정: alpha → alpha-w1 · 로그인 고치기']);
    expect(store.setSystemLines('all', false)).toMatchObject({ ok: false });
  });
});
