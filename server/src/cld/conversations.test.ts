import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { MessengerContact } from '../../../core/src/messages.js';
import type { Lead } from './conversations.js';
import { Conversations, MAX_OPEN_PER_CLIENT, MAX_TAILS } from './conversations.js';
import { TurnLedger } from './engine/turnLedger.js';
import { RosterStore } from './roster.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cld-conv-'));
const line = (type: 'user' | 'assistant', text: string, n: number) =>
  `${JSON.stringify({
    type,
    uuid: `${type[0]}${String(n).padStart(7, '0')}`,
    timestamp: new Date(Date.UTC(2026, 9, 22, 1, 0, n)).toISOString(),
    message: { content: type === 'user' ? text : [{ type: 'text', text }] },
  })}\n`;

function setup(count: number, ledger?: TurnLedger, employeeOf?: ConstructorParameters<typeof Conversations>[4]) {
  const d = dir();
  const leads: Lead[] = Array.from({ length: count }, (_, i) => {
    const transcript = path.join(d, `lead${i}.jsonl`);
    fs.writeFileSync(transcript, line('user', `hello ${i}`, 1) + line('assistant', `hi ${i}`, 2));
    return {
      agentId: 100 + i,
      key: `engine:lead${i}`,
      name: `lead${i}`,
      transcript,
      canSend: true,
    };
  });
  let contacts: MessengerContact[] = [];
  const logs: string[] = [];
  const conv = new Conversations(
    () => leads,
    (c) => (contacts = c),
    (l) => logs.push(l),
    ledger,
    employeeOf,
  );
  const got: Array<Record<string, unknown>> = [];
  const client = (m: Record<string, unknown>) => got.push(m);
  return { leads, conv, got, client, logs, contacts: () => contacts };
}

describe('messenger conversations', () => {
  it('an open conversation gets everything once, then only appended items', () => {
    const t = setup(2);
    t.conv.view(t.client, 100, true);
    expect(t.got).toHaveLength(1);
    expect(t.got[0]).toMatchObject({ type: 'chatTranscript', agentId: 100, canSend: true });
    expect((t.got[0].items as Array<{ text: string }>).map((i) => i.text)).toEqual([
      'hello 0',
      'hi 0',
    ]);
    t.conv.poll();
    expect(t.got).toHaveLength(1); // nothing new
    fs.appendFileSync(t.leads[0].transcript!, line('assistant', 'done', 3));
    fs.appendFileSync(t.leads[1].transcript!, line('assistant', 'closed one', 3));
    t.conv.poll();
    expect(t.got).toHaveLength(2); // lead1 is not open here
    expect(t.got[1]).toMatchObject({ append: true, items: [{ text: 'done' }] });
    t.conv.view(t.client, 100, false);
    fs.appendFileSync(t.leads[0].transcript!, line('assistant', 'later', 4));
    t.conv.poll();
    expect(t.got).toHaveLength(2);
  });

  it("the boss's queued messages: in every transcript message, and alone when only they changed", () => {
    const t = setup(1);
    t.leads[0].queued = [{ id: 'q1.json', text: '끝나면 알려줘', at: 5 }];
    t.conv.view(t.client, 100, true);
    expect(t.got[0]).toMatchObject({ queued: [{ id: 'q1.json', text: '끝나면 알려줘' }] });
    t.conv.poll();
    expect(t.got).toHaveLength(1); // unchanged
    t.leads[0].queued = [];
    t.conv.poll();
    expect(t.got[1]).toEqual({
      type: 'chatTranscript',
      agentId: 100,
      items: [],
      canSend: true,
      append: true,
      queued: [],
    });
  });

  it('a held lead (its session waits on its terminal) says so in the contacts, on change', () => {
    const t = setup(1);
    t.conv.poll();
    expect(t.contacts()[0].held).toBeUndefined();
    t.leads[0].held = true;
    t.conv.poll();
    expect(t.contacts()[0].held).toBe(true);
  });

  it('contacts: a last message from a peer or the system says so (T-0087)', () => {
    const t = setup(1);
    t.conv.poll();
    expect(t.contacts()[0].lastFrom).toBeUndefined();
    fs.appendFileSync(
      t.leads[0].transcript!,
      line('user', '[cld-gui · ops에게서 · 10-22 14:15]\n규칙 추가했다', 3),
    );
    t.conv.poll();
    expect(t.contacts()[0]).toMatchObject({
      preview: '규칙 추가했다',
      lastKind: 'user',
      lastFrom: 'peer',
      lastFromName: 'ops',
    });
    fs.appendFileSync(t.leads[0].transcript!, line('user', '[cld-gui codex] 작업 a1 끝', 4));
    t.conv.poll();
    const c = t.contacts()[0];
    expect(c.lastFrom).toBe('system');
    expect(c.lastFromName).toBeUndefined();
  });

  it('contacts: a task completion notice is a named peer preview', () => {
    const t = setup(1);
    fs.appendFileSync(
      t.leads[0].transcript!,
      `${JSON.stringify({
        type: 'user',
        origin: { kind: 'task-notification' },
        uuid: 'task0001-0000',
        timestamp: '2026-10-22T01:00:03.000Z',
        message: {
          content: '<task-notification><summary>Finished the report.</summary><result>Saved it.</result></task-notification>',
        },
      })}\n`,
    );
    t.conv.poll();
    expect(t.contacts()[0]).toMatchObject({
      preview: 'Finished the report.',
      lastKind: 'user',
      lastFrom: 'peer',
      lastFromName: '작업 알림',
    });
  });

  it("MSG-ALIGN: a task notice keeps its run's employee after the employee is reused for a newer run", () => {
    const roster = new RosterStore(path.join(dir(), 'roster.json'));
    const first = roster.bind('alpha', 'claude:toolu_old', { provider: 'claude' })!;
    roster.release('claude:toolu_old');
    const again = roster.bind('alpha', 'claude:toolu_new', { provider: 'claude' })!;
    expect(again.id).toBe(first.id); // the same employee, now on a newer run
    const t = setup(1, undefined, (execution) => {
      const e = roster.employeeOf(execution);
      return e && { employeeId: e.id, nameId: e.nameId };
    });
    const notice = (tool: string, n: number) =>
      line(
        'user',
        `<task-notification><tool-use-id>${tool}</tool-use-id><summary>Agent finished</summary></task-notification>`,
        n,
      );
    fs.appendFileSync(t.leads[0].transcript!, notice('toolu_old', 3) + notice('toolu_new', 4) + notice('toolu_none', 5));
    t.conv.view(t.client, 100, true);
    const items = t.got[0].items as Array<{ execution?: string; employee?: unknown }>;
    const named = { employeeId: first.id, nameId: first.nameId };
    expect(items.find((i) => i.execution === 'claude:toolu_old')?.employee).toEqual(named);
    expect(items.find((i) => i.execution === 'claude:toolu_new')?.employee).toEqual(named);
    expect(items.find((i) => i.execution === 'claude:toolu_none')?.employee).toBeUndefined();
  });

  it('contacts: last message, its time and the latest reply ids, closed conversations too', () => {
    const t = setup(2);
    t.conv.poll();
    expect(t.contacts().map((c) => [c.name, c.preview, c.lastKind, c.replies.length])).toEqual([
      ['lead0', 'hi 0', 'assistant', 1],
      ['lead1', 'hi 1', 'assistant', 1],
    ]);
    fs.appendFileSync(t.leads[1].transcript!, line('assistant', 'new reply\nsecond line', 5));
    t.conv.poll();
    const c1 = t.contacts()[1];
    expect(c1.preview).toBe('new reply');
    expect(c1.lastAt).toBe(Date.UTC(2026, 9, 22, 1, 0, 5));
    expect(c1.replies).toHaveLength(2);
    expect(c1.replies[1].startsWith(`${c1.lastAt}-`)).toBe(true);
  });

  it(`at most ${MAX_OPEN_PER_CLIENT} open per client; another client has its own`, () => {
    const t = setup(6);
    for (let i = 0; i < 5; i++) t.conv.view(t.client, 100 + i, true);
    expect(new Set(t.got.map((m) => m.agentId))).toEqual(new Set([100, 101, 102, 103]));
    expect(t.logs).toEqual([`conversation 104 refused: ${MAX_OPEN_PER_CLIENT} already open`]);
    const other: Array<Record<string, unknown>> = [];
    t.conv.view((m) => other.push(m), 104, true);
    expect(other.map((m) => m.agentId)).toEqual([104]);
    // Closing one makes room.
    t.conv.view(t.client, 100, false);
    t.conv.view(t.client, 105, true);
    expect(t.got.at(-1)).toMatchObject({ agentId: 105 });
  });

  it(`at most ${MAX_TAILS} tails per daemon, open conversations first`, () => {
    const t = setup(MAX_TAILS + 3);
    t.conv.view(t.client, 100 + MAX_TAILS + 2, true); // the last lead, open
    expect(t.conv.size).toBe(MAX_TAILS);
    const withPreview = t.contacts().filter((c) => c.preview);
    expect(withPreview).toHaveLength(MAX_TAILS);
    expect(withPreview.map((c) => c.name)).toContain(`lead${MAX_TAILS + 2}`);
    expect(t.got).toHaveLength(1);
  });

  it('a lead without a transcript yet: an empty conversation, then its first lines', () => {
    const t = setup(1);
    const file = t.leads[0].transcript!;
    t.leads[0].transcript = null;
    t.conv.view(t.client, 100, true);
    expect(t.got[0]).toMatchObject({ items: [] });
    t.leads[0].transcript = file;
    t.conv.poll();
    expect(t.got[1]).toMatchObject({ items: [{ text: 'hello 0' }, { text: 'hi 0' }] });
    expect(t.got[1].append).toBeUndefined();
  });
});

describe('messenger history requests', () => {
  it('answers one history request per client and lead; refuses an overlapping request', async () => {
    const t = setup(1);
    t.conv.history(t.client, 100, 'first');
    t.conv.history(t.client, 100, 'second');
    expect(t.got[0]).toMatchObject({
      type: 'chatHistoryResult',
      requestId: 'second',
      error: expect.any(String),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.got.find((m) => m.requestId === 'first')).toMatchObject({
      type: 'chatHistoryResult',
      items: [{ text: 'hello 0' }, { text: 'hi 0' }],
      done: true,
    });
  });

  it('answers an unknown lead with an error, reading nothing', async () => {
    const t = setup(1);
    t.conv.history(t.client, 999, 'missing');
    t.conv.search(t.client, 999, 'missing', 'hello');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.got).toMatchObject([
      { type: 'chatHistoryResult', requestId: 'missing', error: expect.any(String) },
      { type: 'chatSearchResult', requestId: 'missing', error: expect.any(String) },
    ]);
  });
});

describe('C3: a turn answering a room post counts for the room, never for the DM', () => {
  const ROOM = "[사장 · 단톡방 '출시팀' · 10-22 10:05] ⟨m:aaaaaaaa⟩\n@lead0 배포 상태";
  const DM = '[사장 · 메신저 · 10-22 10:09] ⟨m:bbbbbbbb⟩\n개인 질문';
  const ROOM_DELIVERY = {
    messageId: 'aaaaaaaa',
    group: { roomId: 'room0001', roomName: '출시팀', messageId: 'post0001' },
  };
  const write = (t: ReturnType<typeof setup>, ...lines: string[]) =>
    fs.appendFileSync(t.leads[0].transcript!, lines.join(''));

  it('a room-bound reply: no DM reply, the contact names the room, the room gets the reply', () => {
    const t = setup(1);
    t.conv.poll();
    expect(t.contacts()[0].room).toBeUndefined();
    const before = t.contacts()[0].replies;
    write(t, line('user', ROOM, 3), line('assistant', '준비됐어요', 4));
    t.conv.poll();
    const c = t.contacts()[0];
    expect(c.replies).toEqual(before); // not a DM reply: no DM unread
    expect(c.room).toBe('출시팀'); // the end of this turn notifies the room
    expect(c.preview).toBe('hi 0'); // the DM's last message is still the DM's
    const got = t.conv.takeRoomReplies();
    expect(got.map((r) => [r.member, r.reply.room.name, r.reply.item.text])).toEqual([
      ['lead0', '출시팀', '준비됐어요'],
    ]);
    expect(t.conv.takeRoomReplies()).toEqual([]); // taken once
  });

  it('a tail that starts over (new, or a jump past one read) replays old room replies: they are marked replayed, the live one is not', () => {
    const t = setup(1);
    write(t, line('user', ROOM, 3), line('assistant', '옛 방 답', 4));
    t.conv.poll(); // the first poll reads the file from its end back: a replay
    expect(t.conv.takeRoomReplies().map((r) => [r.reply.item.text, r.replayed])).toEqual([
      ['옛 방 답', true],
    ]);
    write(t, line('assistant', '새 방 답', 5));
    t.conv.poll();
    expect(t.conv.takeRoomReplies().map((r) => [r.reply.item.text, r.replayed])).toEqual([
      ['새 방 답', false],
    ]);
    write(t, line('assistant', 'x'.repeat(300 * 1024), 6)); // more than one read: the tail starts over
    t.conv.poll();
    expect(t.conv.takeRoomReplies().every((r) => r.replayed)).toBe(true);
  });

  it('a DM-bound reply after it: counted for the DM only, the room mark is gone', () => {
    const t = setup(1);
    write(t, line('user', ROOM, 3), line('assistant', '방 답', 4));
    t.conv.poll();
    expect(t.contacts()[0].room).toBe('출시팀');
    t.conv.takeRoomReplies();
    write(t, line('user', DM, 5), line('assistant', '개인 답', 6));
    t.conv.poll();
    const c = t.contacts()[0];
    expect(c.room).toBeUndefined();
    expect(c.replies).toHaveLength(2); // hi 0 and 개인 답
    expect(c.preview).toBe('개인 답');
    expect(t.conv.takeRoomReplies()).toEqual([]); // a DM turn moves no room's unread
  });

  it('an unbound turn (no header of ours, an old record) is a DM turn, as before', () => {
    const t = setup(1);
    write(t, line('user', '그냥 터미널에서 침', 3), line('assistant', '네', 4));
    t.conv.poll();
    const c = t.contacts()[0];
    expect(c.room).toBeUndefined();
    expect(c.replies).toHaveLength(2);
  });

  describe('what the messenger typed is the record (TurnLedger)', () => {
    it('interleaved: the room reply lands between DM tail polls and never enters the DM', () => {
      const ledger = new TurnLedger();
      const t = setup(1, ledger);
      ledger.onChange = () => t.conv.republish();
      // A system turn (the engine's recovery notice) with its reply: a DM turn, read by the first poll.
      write(
        t,
        line('user', '[cld-gui 자동 복구 · 10-22 09:00] 다시 띄웠다', 3),
        line('assistant', '확인', 4),
      );
      t.conv.poll();
      const dm = t.contacts()[0].replies;
      expect(dm).toHaveLength(2);
      // The messenger types a room post; its turn is not in the transcript yet.
      ledger.typed('lead0', ROOM_DELIVERY);
      expect(t.contacts()[0]).toMatchObject({
        room: '출시팀',
        roomId: 'room0001',
        roomPost: 'post0001',
      });
      // A poll between the user line and the reply, then one after it, then one after a tool line.
      write(t, line('user', ROOM, 5));
      t.conv.poll();
      expect(t.contacts()[0]).toMatchObject({ room: '출시팀', roomPost: 'post0001' });
      write(t, line('assistant', '방 답', 6));
      t.conv.poll();
      write(t, line('assistant', '방 답 2', 7));
      t.conv.poll();
      expect(t.contacts()[0].replies).toEqual(dm); // no room reply is a DM reply
      expect(t.contacts()[0].room).toBe('출시팀');
      expect(t.conv.takeRoomReplies().map((r) => r.reply.item.text)).toEqual(['방 답', '방 답 2']);
      // ROOM-NOTICE: the contact carries the newest reply's preview, with a new id for each.
      expect(t.contacts()[0].roomReply?.text).toBe('방 답 2');
      const newest = t.contacts()[0].roomReply?.id;
      write(t, line('assistant', '방 답 3', 8));
      t.conv.poll();
      expect(t.contacts()[0].roomReply?.text).toBe('방 답 3');
      expect(t.contacts()[0].roomReply?.id).not.toBe(newest);
      // A DM message typed afterwards ends the room turn at once, and its reply is the DM's.
      ledger.typed('lead0', { messageId: 'bbbbbbbb' });
      expect(t.contacts()[0].room).toBeUndefined();
      write(t, line('user', DM, 8), line('assistant', '개인 답', 9));
      t.conv.poll();
      expect(t.contacts()[0].replies).toHaveLength(3);
      expect(t.contacts()[0].room).toBeUndefined();
    });

    it('a turn that ends within one poll: the contact already names the room when it is typed', () => {
      const ledger = new TurnLedger();
      const t = setup(1, ledger);
      ledger.onChange = () => t.conv.republish();
      ledger.typed('lead0', ROOM_DELIVERY);
      // Nothing was polled: the room is known from the typing alone.
      expect(t.contacts()[0].room).toBe('출시팀');
    });

    it('a lead beyond the tailed ones still has its room turn (no tail to read it from)', () => {
      const ledger = new TurnLedger();
      const t = setup(MAX_TAILS + 1, ledger);
      ledger.onChange = () => t.conv.republish();
      t.conv.poll();
      ledger.typed(`lead${MAX_TAILS}`, ROOM_DELIVERY);
      expect(t.contacts()[MAX_TAILS]).toMatchObject({ name: `lead${MAX_TAILS}`, room: '출시팀' });
      expect(t.contacts()[0].room).toBeUndefined();
    });

    it('a joined inbox turn is not a typed room turn: the transcript decides', () => {
      const ledger = new TurnLedger();
      const t = setup(1, ledger);
      ledger.typed('lead0', ROOM_DELIVERY);
      ledger.typed('lead0', { inbox: ['0-1.md'], messageId: 'cccccccc' });
      expect(ledger.current('lead0')).toBeUndefined();
      expect(ledger.unseen('lead0')).toBeUndefined();
      t.conv.poll();
      expect(t.contacts()[0].room).toBeUndefined();
    });
  });
});
