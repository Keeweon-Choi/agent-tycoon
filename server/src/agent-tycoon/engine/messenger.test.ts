import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROOM_NOTICE_LINE } from '../../../../core/src/agent-tycoon/serverText.js';
import { ChatManager } from '../chat.js';
import { killFakeSessions, makeEngineHome, removeTestHome } from '../testHome.js';
import { chatItems, lineItems, RoomTurnFilter } from '../transcriptView.js';
import { Engine } from './engine.js';
import { EngineEvents, eventsPath } from './events.js';
import type {
  MessengerEngine,
  QueuedSend,
  SessionInfo,
  TypeOptions,
  TypeResult,
} from './messenger.js';
import {
  alreadyTyped,
  answeredSince,
  cleanText,
  fullQuote,
  header,
  messageOf,
  Messenger,
  newMessageId,
  parseQueued,
  pasteOf,
  replyRef,
  TEXT_MAX,
  turnOver,
} from './messenger.js';
import { registryPath, saveRegistry } from './registry.js';
import { TurnLedger } from './turnLedger.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

const FAST = { tickMs: 20, retryMs: 50, ifIdleMs: 10 * 60_000, quietMs: 5_000 };
/** C2: a message id, and its mark at the end of a header line. */
const ID = expect.stringMatching(/^[a-z2-7]{8}$/);
const MARK = ' ⟨m:[a-z2-7]{8}⟩';

/** Transcript records (Claude Code 2.1.306 shapes): a prompt, a tool call and its result, a turn's end. */
const PROMPT = JSON.stringify({ type: 'user', message: { role: 'user', content: '배포해 줘' } });
const TOOL_CALL = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
});
const TOOL_RESULT = JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
});
const TURN_END = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1234 });

/** A messenger over an in-memory engine: sessions are set by hand. */
function rig(
  opts: {
    names?: string[];
    typed?: TypeResult;
    timing?: Partial<typeof FAST>;
    type?: (id: string, text: string, o?: TypeOptions) => Promise<TypeResult>;
    ledger?: TurnLedger;
  } = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-msg-'));
  const sessions = new Map<string, SessionInfo>();
  const renewing = new Set<string>();
  const blocked = new Set<string>();
  const engine: MessengerEngine = {
    names: () => opts.names ?? ['alpha', 'beta'],
    sessionOf: (n) => sessions.get(n) ?? null,
    renewing: (n) => renewing.has(n),
    held: (n) => Promise.resolve(blocked.has(n)),
  };
  const typed: Array<{ id: string; text: string; whileWorking?: boolean; earlier?: string[] }> = [];
  let result: TypeResult = opts.typed ?? 'typed';
  const events = new EngineEvents(eventsPath(home));
  let now = Date.parse('2026-10-21T23:05:00+09:00');
  const m = new Messenger({
    home,
    engine,
    typist: {
      type: (id, text, o) => {
        typed.push({
          id,
          text,
          ...(o?.whileWorking && { whileWorking: true }),
          ...(o?.earlier?.length && { earlier: o.earlier }),
        });
        o?.onTyped?.();
        return opts.type?.(id, text, o) ?? Promise.resolve(result);
      },
    },
    events,
    timing: { ...FAST, ...opts.timing },
    now: () => now,
    log: () => undefined,
    ...(opts.ledger && { ledger: opts.ledger }),
  });
  m.start();
  cleanup.push(() => {
    m.dispose();
    removeTestHome(home);
  });
  const inbox = (name: string) => {
    try {
      return fs
        .readdirSync(path.join(home, '.config/agent-tycoon/inbox', name))
        .filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }
  };
  const readInbox = (name: string) =>
    inbox(name).map((f) =>
      fs.readFileSync(path.join(home, '.config/agent-tycoon/inbox', name, f), 'utf-8'),
    );
  const events_ = () =>
    fs
      .readFileSync(eventsPath(home), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    home,
    m,
    engine,
    sessions,
    renewing,
    blocked,
    typed,
    inbox,
    readInbox,
    events: events_,
    setResult: (r: TypeResult) => (result = r),
    advance: (ms: number) => (now += ms),
    queueFiles: () => fs.readdirSync(m.queueDir).filter((f) => f.endsWith('.json')),
  };
}

const send = (to: string, text: string, ifIdle = false, from: string | null = 'beta') => ({
  to,
  text,
  ifIdle,
  from,
  source: 'cli',
});
/** The boss, from the office messenger (`now`: Ctrl+Enter / 즉시). */
const boss = (to: string, text: string, now = false) => ({
  to,
  text,
  ifIdle: false,
  from: null,
  source: 'messenger:mac',
  ...(now && { now }),
});
const bodies = (typed: Array<{ text: string }>) => typed.map((t) => t.text.split('\n')[1]);

describe('messages', () => {
  it('cleans text: newlines kept, control characters (a paste end too) gone', () => {
    expect(cleanText('a\r\nb\rc\x1b[201~\x07d\te')).toBe('a\nb\nc[201~d\te');
  });

  it('header: the sender, the app user, or agty (office header, MM-DD HH:MM)', () => {
    const created = new Date(2026, 9, 21, 23, 5).getTime();
    expect(header({ from: 'beta', source: 'cli', created })).toBe(
      '[agty · beta에게서 · 10-21 23:05]',
    );
    expect(header({ from: null, source: 'gui:iphone', created })).toBe(
      '[사용자 · 앱(gui:iphone) · 10-21 23:05]',
    );
    expect(header({ from: null, source: 'cli', created })).toBe('[agty · 보냄 · 10-21 23:05]');
    // Any sender reads the same, orchestrators and office's own names alike (NFR-CMP-009).
    expect(header({ from: 'codex', source: 'cli', created })).toBe(
      '[agty · codex에게서 · 10-21 23:05]',
    );
    expect(header({ from: 'ops', source: 'cli', created })).toBe(
      '[agty · ops에게서 · 10-21 23:05]',
    );
    // C6: a delegated Task names its id and the delegating agent; with no agent, no Task part.
    expect(header({ from: 'alpha', source: 'mcp', created, task: 'T-12', messageId: 'abcdefgh' })).toBe(
      '[agty · alpha에게서 · Task T-12 · 10-21 23:05] ⟨m:abcdefgh⟩',
    );
    expect(header({ from: null, source: 'engine', created, task: 'T-12' })).toBe(
      '[agty · 보냄 · 10-21 23:05]',
    );
  });

  it('C6: a queue file keeps its Task id; a malformed one is not a queue file', () => {
    const q = { v: 1, to: 'alpha-a', text: 'x', from: 'alpha', source: 'mcp', ifIdle: false, created: 1, task: 'T-3' };
    expect(parseQueued(JSON.stringify(q))).toEqual(q);
    expect(parseQueued(JSON.stringify({ ...q, task: '../x' }))).toBeNull();
  });

  it('C3: the turn ledger is told the moment a message is typed: a room delivery, then a one-to-one one', async () => {
    const ledger = new TurnLedger();
    const r = rig({ ledger });
    r.sessions.set('alpha', { id: 'a0000016', status: 'idle' });
    expect(ledger.current('alpha')).toBeUndefined();
    await r.m.send({
      ...send('alpha', '@alpha 배포'),
      group: { roomId: 'room0001', roomName: '출시팀', messageId: 'post0001' },
    });
    expect(ledger.current('alpha')).toEqual({ id: 'room0001', name: '출시팀', post: 'post0001' });
    expect(ledger.unseen('alpha')).toEqual({
      room: { id: 'room0001', name: '출시팀', post: 'post0001' },
    });
    await r.m.send(boss('alpha', '개인 질문'));
    expect(ledger.current('alpha')).toBeNull();
    // The delivery id in the header's mark is how the DM view looks the turn up.
    const mark = /⟨m:([a-z2-7]{8})⟩/.exec(r.typed[0].text)![1];
    expect(ledger.classify(mark)).toEqual({ id: 'room0001', name: '출시팀', post: 'post0001' });
    // A message that waits (the session works) has not started a turn: nothing changes yet.
    r.sessions.set('alpha', { id: 'a0000016', status: 'busy' });
    ledger.onChange = () => {
      throw new Error('a waiting message must not touch the ledger');
    };
    await r.m.send({
      ...send('alpha', '@alpha 또'),
      group: { roomId: 'room0001', roomName: '출시팀', messageId: 'post0002' },
    });
    expect(ledger.current('alpha')).toBeNull();
  });

  it('keeps typed messages per project across a recreated manager', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a0000016', status: 'idle' });
    await r.m.send(send('alpha', '먼저 보낸 말'));
    const first = r.typed[0].text;
    expect(JSON.parse(fs.readFileSync(path.join(r.m.typedDir, 'alpha.json'), 'utf-8'))).toEqual([
      { text: first, at: expect.any(Number) },
    ]);

    r.m.dispose();
    const earlier: string[][] = [];
    const m = new Messenger({
      home: r.home,
      engine: r.engine,
      typist: {
        type: (_id: string, _text: string, o?: TypeOptions) => {
          earlier.push(o?.earlier ?? []);
          return Promise.resolve('typed');
        },
      },
      events: new EngineEvents(eventsPath(r.home)),
      timing: FAST,
      log: () => undefined,
    });
    cleanup.push(() => m.dispose());
    await m.send(send('alpha', '그 다음 말'));
    expect(earlier).toEqual([[first]]);
  });

  it('reads a queue file, and nothing else', () => {
    const q: QueuedSend = {
      v: 1,
      to: 'alpha',
      text: 'hi',
      from: null,
      source: 'cli',
      ifIdle: true,
      created: 1,
    };
    expect(parseQueued(JSON.stringify(q))).toEqual(q);
    expect(parseQueued('{"v":1,"to":"alpha"}')).toBeNull();
    expect(parseQueued('nope')).toBeNull();
  });

  it('C2: the header ends with the mark of its id; a queue file keeps a valid id only', () => {
    const created = new Date(2026, 9, 21, 23, 5).getTime();
    expect(header({ from: null, source: 'messenger:pc', created, messageId: 'ab2cd3ef' })).toBe(
      '[사장 · 메신저 · 10-21 23:05] ⟨m:ab2cd3ef⟩',
    );
    expect(newMessageId()).toMatch(/^[a-z2-7]{8}$/);
    expect(new Set(Array.from({ length: 200 }, newMessageId)).size).toBe(200);
    const q = { v: 1, to: 'alpha', text: 'hi', from: null, source: 'cli', ifIdle: true, created };
    expect(parseQueued(JSON.stringify({ ...q, messageId: 'ab2cd3ef' }))).toMatchObject({
      messageId: 'ab2cd3ef',
    });
    // Not ours: a mark that could not be written into a header is no queue file.
    for (const bad of ['AB2CD3EF', 'ab2cd3e', 'ab2cd3ef⟩', 7])
      expect(parseQueued(JSON.stringify({ ...q, messageId: bad }))).toBeNull();
  });

  it('MSG-ACTIONS: a reply names its message after the mark and quotes it first; replyRef makes it safe', () => {
    const created = new Date(2026, 9, 21, 23, 5).getTime();
    const q: QueuedSend = { v: 1, to: 'alpha', text: '다시 해 줘', from: null, source: 'messenger:pc', ifIdle: false, created, messageId: 'ab2cd3ef' };
    const replyTo = replyRef({ id: 'post0001', sender: 'al:pha\nx', text: 'token: password=hunter2 ' + 'x'.repeat(200) })!;
    expect(replyTo.sender).toBe('al pha x');
    expect(replyTo.text).not.toContain('hunter2'); // masked like every other preview (mask.ts)
    expect(replyTo.text).toMatch(/\*\*\* x+…$/);
    expect(replyTo.text.length).toBe(121);
    expect(header({ ...q, replyTo })).toBe('[사장 · 메신저 · 10-21 23:05] ⟨m:ab2cd3ef⟩ ⟨re:post0001⟩');
    expect(messageOf({ ...q, replyTo: { id: 'abcd2345', text: '내 질문' } })).toBe(
      '[사장 · 메신저 · 10-21 23:05] ⟨m:ab2cd3ef⟩ ⟨re:abcd2345⟩\n> 사장: 내 질문\n다시 해 줘',
    );
    // Not a reference: an id that could break the header, a missing text, a non-object.
    for (const bad of [{ id: 'a b', text: 'x' }, { id: 'a⟩', text: 'x' }, { id: 'ok' }, 'ok', null, ['ok']])
      expect(replyRef(bad)).toBeUndefined();
    expect(replyRef({ id: 'x', sender: '사장', text: 'y' })).toEqual({ id: 'x', text: 'y' });
    // A token across the quote's cut is masked whole (the app sends the text uncut, masking runs first).
    expect(replyRef({ id: 'x', text: `${'x'.repeat(100)} ghp_${'a'.repeat(36)}` })!.text).toBe(`${'x'.repeat(100)} ***`);
    // A queue file keeps a reference exactly as replyRef makes it, else it is no queue file.
    expect(parseQueued(JSON.stringify({ ...q, replyTo }))).toMatchObject({ replyTo });
    expect(parseQueued(JSON.stringify({ ...q, replyTo: { id: 'a b', text: 'x' } }))).toBeNull();
    expect(parseQueued(JSON.stringify({ ...q, replyTo: { id: 'x', text: 'y'.repeat(300) } }))).toBeNull();
  });

  it('MSG-ACTIONS: send() keeps the reference in the queue (and in what the queue shows)', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const queued = await r.m.send({ ...boss('alpha', '이거 봐 줘'), replyTo: { id: 'abcd2345', text: '원문' } });
    expect(queued).toMatchObject({ ok: true, delivered: 'queued' });
    expect(r.m.queuedFor('alpha')[0]).toMatchObject({ replyTo: { id: 'abcd2345', text: '원문' } });
  });

  it('C2 restart: a queued message keeps its id in its file and goes in with that mark', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const queued = await r.m.send(boss('alpha', '나중에 봐 줘'));
    expect(queued).toMatchObject({ delivered: 'queued', messageId: ID });
    const id = (queued as { messageId: string }).messageId;
    const [file] = r.queueFiles();
    expect(JSON.parse(fs.readFileSync(path.join(r.m.queueDir, file), 'utf-8')).messageId).toBe(id);
    r.m.dispose(); // the daemon stops; the queue file stays
    const typed: string[] = [];
    const again = new Messenger({
      home: r.home,
      engine: r.engine,
      typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed')) },
      events: new EngineEvents(eventsPath(r.home)),
      timing: FAST,
      log: () => undefined,
    });
    cleanup.push(() => again.dispose());
    again.start();
    expect(again.queuedFor('alpha')).toEqual([expect.objectContaining({ messageId: id })]);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await vi.waitFor(() => expect(typed).toHaveLength(1));
    expect(typed[0]).toMatch(new RegExp(`^\\[사장 · 메신저 · [^\\]]+\\] ⟨m:${id}⟩\\n나중에 봐 줘$`));
  });

  it('C2: a queue file from before C2 (no id) is left as it is and goes in unmarked', async () => {
    const r = rig();
    const created = Date.parse('2026-10-21T23:00:00+09:00');
    const old = JSON.stringify({ v: 1, to: 'alpha', text: '옛 글', from: null, source: 'messenger:pc', ifIdle: false, created });
    const file = path.join(r.m.queueDir, `${created}-abc123.json`);
    fs.writeFileSync(file, old);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    r.m.start(); // picks it up (as at a daemon start)
    expect(r.m.queuedFor('alpha')).toEqual([{ id: path.basename(file), text: '옛 글', at: created }]);
    expect(fs.readFileSync(file, 'utf-8')).toBe(old); // not rewritten
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await vi.waitFor(() => expect(r.typed).toHaveLength(1));
    expect(r.typed[0].text).toBe('[사장 · 메신저 · 10-21 23:00]\n옛 글');
  });

  it('refuses an unknown project, an empty and an oversized message (codes)', async () => {
    const r = rig();
    expect(await r.m.send(send('gamma', 'hi'))).toMatchObject({
      ok: false,
      code: 'unknown_project',
    });
    expect(await r.m.send(send('alpha', ' \n\x07'))).toMatchObject({
      ok: false,
      code: 'empty_message',
    });
    expect(await r.m.send(send('alpha', 'x'.repeat(TEXT_MAX + 1)))).toMatchObject({
      ok: false,
      code: 'too_large',
    });
    expect(r.typed).toHaveLength(0);
  });

  it('D5 (6.3): an agent of an unknown provider: refused (no queue or inbox file); its queued files wait untouched', async () => {
    const r = rig();
    r.engine.refuses = (n) =>
      n === 'beta' ? { code: 'unknown_provider', error: 'agty가 모르는 에이전트(nope)라 받을 수 없어요' } : null;
    expect(await r.m.send(send('beta', 'hi', false, 'alpha'))).toEqual({
      ok: false,
      code: 'unknown_provider',
      error: 'agty가 모르는 에이전트(nope)라 받을 수 없어요',
    });
    expect(r.queueFiles()).toEqual([]);
    expect(r.inbox('beta')).toEqual([]);
    // A file `agty send` queued while the daemon was off: no inbox move, no drop.
    fs.writeFileSync(
      path.join(r.m.queueDir, '20261021-230000-000-aaaa.json'),
      JSON.stringify({ v: 1, to: 'beta', text: 'old', from: null, source: 'cli', ifIdle: false, created: 1 }),
    );
    r.m.start();
    for (let i = 0; i < 3; i++) await r.m.tick();
    expect(r.queueFiles()).toEqual(['20261021-230000-000-aaaa.json']);
    expect(r.inbox('beta')).toEqual([]);
    expect(r.typed).toEqual([]);
  });

  it('off: into the inbox with its header (reason off); in a terminal: reason terminal', async () => {
    const r = rig();
    const off = await r.m.send(send('alpha', 'build is green'));
    expect(off).toEqual({ ok: true, delivered: 'inbox', reason: 'off', messageId: ID });
    // The inbox file carries the same header, mark and all (C2).
    expect(r.readInbox('alpha')).toEqual([
      `[agty · beta에게서 · 10-21 23:05] ⟨m:${(off as { messageId: string }).messageId}⟩\nbuild is green`,
    ]);
    r.sessions.set('beta', 'terminal');
    expect(await r.m.send(send('beta', 'x', false, null))).toMatchObject({
      delivered: 'inbox',
      reason: 'terminal',
    });
    expect(r.typed).toHaveLength(0);
    expect(r.events().map((e) => [e.type, e.to, e.delivered, e.reason])).toEqual([
      ['send', 'alpha', 'inbox', 'off'],
      ['send', 'beta', 'inbox', 'terminal'],
    ]);
  });

  it('idle: typed now (delivered pane), the HIF send event', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    const sent = await r.m.send(send('alpha', 'line one\nline two'));
    expect(sent).toEqual({ ok: true, delivered: 'pane', messageId: ID });
    expect(r.typed).toEqual([
      {
        id: 'a1b2c3d4',
        text: `[agty · beta에게서 · 10-21 23:05] ⟨m:${(sent as { messageId: string }).messageId}⟩\nline one\nline two`,
      },
    ]);
    const [e] = r.events();
    expect(e).toMatchObject({
      v: 1,
      type: 'send',
      source: 'cli',
      from: 'beta',
      to: 'alpha',
      delivered: 'pane',
    });
    expect(e.preview).toBe('line one');
    expect(e.bytes).toBe(Buffer.byteLength(r.typed[0].text));
    expect(e.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });

  it('a validated boss slash command is typed raw; without raw delivery and from a peer it keeps its header', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    expect(await r.m.send({ ...boss('alpha', '/compact'), raw: true })).toMatchObject({
      ok: true,
      delivered: 'pane',
    });
    expect(r.typed).toEqual([{ id: 'a1b2c3d4', text: '/compact' }]);
    expect(await r.m.send(boss('alpha', '/compact'))).toMatchObject({
      ok: true,
      delivered: 'pane',
    });
    expect(r.typed[1].text).toMatch(/^\[사장 · 메신저 · /);
    expect(r.typed[1].text).toMatch(/\n\/compact$/);
    expect(
      await r.m.send({ ...send('alpha', '/compact', false, 'beta'), raw: true }),
    ).toMatchObject({ ok: true, delivered: 'pane' });
    expect(r.typed[2].text).toMatch(/^\[agty · beta에게서 · /);
    expect(r.typed[2].text).toMatch(/\n\/compact$/);
  });

  it('a slash command never uses the now path: it waits for the busy turn and cannot be promoted', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const queued = await r.m.send({ ...boss('alpha', '/compact', true), raw: true });
    expect(queued).toMatchObject({ ok: true, delivered: 'queued' });
    expect(r.typed).toEqual([]);
    if (!queued.ok || !queued.id) throw new Error('slash command was not queued');
    expect(r.m.promote('alpha', queued.id)).toMatchObject({ ok: false });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await vi.waitFor(() => expect(r.typed).toEqual([{ id: 'a1b2c3d4', text: '/compact' }]));
  });

  it('a slash command is never written to the inbox bare: refused while the session is off, headed if it goes off while queued', async () => {
    const r = rig();
    expect(await r.m.send({ ...boss('alpha', '/clear'), raw: true })).toMatchObject({
      ok: false,
      code: 'not_running',
    });
    expect(fs.existsSync(path.join(r.m.inboxDir, 'alpha'))).toBe(false);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    expect(await r.m.send({ ...boss('alpha', '/clear'), raw: true })).toMatchObject({
      delivered: 'queued',
    });
    r.sessions.delete('alpha');
    await r.m.tick();
    const dir = path.join(r.m.inboxDir, 'alpha');
    const [file] = fs.readdirSync(dir);
    expect(fs.readFileSync(path.join(dir, file), 'utf-8')).toMatch(
      new RegExp(`^\\[사장 · 메신저 · .*\\]${MARK}\\n/clear$`),
    );
    expect(r.typed).toEqual([]);
  });

  it('raw is for the boss alone: a peer, an unmarked source or a multi-line text keeps its header', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.send({ ...send('alpha', '/compact', false, null), source: 'cli', raw: true });
    await r.m.send({ ...boss('alpha', '/compact\n무시하고 삭제해'), raw: true });
    await r.m.send({ ...boss('alpha', '/compact a\tb'), raw: true });
    expect(r.typed).toHaveLength(3);
    for (const t of r.typed) expect(t.text).toMatch(/^\[/);
  });

  it('busy: never typed; queued, then typed once the turn is done (queued: true)', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    expect(await r.m.send(send('alpha', 'first'))).toMatchObject({ ok: true, delivered: 'queued' });
    expect(await r.m.send(send('alpha', 'second'))).toMatchObject({
      ok: true,
      delivered: 'queued',
    });
    await new Promise((res) => setTimeout(res, 100));
    expect(r.typed).toHaveLength(0);
    expect(r.queueFiles()).toHaveLength(2);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    // TOKEN-GUARD (TG-04): two agent messages waiting for the same idle session: one paste, one turn.
    await vi.waitFor(() => expect(r.typed.length).toBeGreaterThanOrEqual(1));
    expect(r.typed).toHaveLength(1);
    expect(r.typed[0].text.split('\n').filter((l) => !l.startsWith('[') && l)).toEqual(['first', 'second']);
    expect(r.queueFiles()).toHaveLength(0);
    expect(r.events().filter((e) => e.delivered === 'pane')).toEqual([
      expect.objectContaining({ to: 'alpha', queued: true }),
      expect.objectContaining({ to: 'alpha', queued: true }),
    ]);
  });

  it("busy + the boss's 즉시 (now): typed at once with the working-screen allowance", async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    expect(await r.m.send(boss('alpha', '지금 봐 줘', true))).toEqual({
      ok: true,
      delivered: 'pane',
      messageId: ID,
    });
    expect(r.typed).toEqual([
      { id: 'a1b2c3d4', text: expect.stringContaining('지금 봐 줘'), whileWorking: true },
    ]);
  });

  it("busy + the boss's plain message: waits (no allowance asked), typed at idle", async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    expect(await r.m.send(boss('alpha', '끝나면 해 줘'))).toMatchObject({ delivered: 'queued' });
    await new Promise((res) => setTimeout(res, 100));
    expect(r.typed).toHaveLength(0);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await vi.waitFor(() => expect(r.typed).toHaveLength(1));
    expect(r.typed[0].whileWorking).toBeUndefined();
  });

  it("busy + another orchestrator's message: waits, then goes in at idle", async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    expect(await r.m.send(send('alpha', 'from beta'))).toMatchObject({ delivered: 'queued' });
    await new Promise((res) => setTimeout(res, 100));
    expect(r.typed).toHaveLength(0);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await vi.waitFor(() => expect(bodies(r.typed)).toEqual(['from beta']));
  });

  it("busy + an agent's message queued first, then the boss's now: the boss's first, the agent's at idle", async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(send('alpha', 'from beta'));
    expect(await r.m.send(boss('alpha', 'boss now', true))).toMatchObject({ delivered: 'pane' });
    await new Promise((res) => setTimeout(res, 100));
    expect(bodies(r.typed)).toEqual(['boss now']);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await vi.waitFor(() => expect(bodies(r.typed)).toEqual(['boss now', 'from beta']));
  });

  it("지금 보내기: the boss's waiting messages are listed (a fresh messenger too), and a promoted one goes in while busy", async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(send('alpha', 'from beta'));
    const queued = await r.m.send(boss('alpha', '나중에'));
    expect(queued).toMatchObject({ delivered: 'queued', id: expect.stringMatching(/\.json$/) });
    const id = (queued as { id: string }).id;
    // Only the boss's, with the text as sent: what a reloaded app shows as 보냄(대기 중).
    expect(queued).toMatchObject({ messageId: ID });
    expect(r.m.queuedFor('alpha')).toEqual([
      {
        id,
        text: '나중에',
        at: expect.any(Number),
        messageId: (queued as { messageId: string }).messageId,
      },
    ]);
    const fresh = new Messenger({
      home: r.home,
      engine: { names: () => ['alpha'], sessionOf: () => null, renewing: () => false },
      typist: { type: () => Promise.resolve('failed') },
      events: new EngineEvents(eventsPath(r.home)),
      timing: { ...FAST, tickMs: 60_000 },
      log: () => undefined,
    });
    fresh.start();
    expect(fresh.queuedFor('alpha')).toEqual(r.m.queuedFor('alpha'));
    fresh.dispose();
    expect(r.m.promote('alpha', 'nope.json')).toMatchObject({ ok: false, code: 'not_queued' });
    expect(r.m.promote('beta', id)).toMatchObject({ ok: false, code: 'not_queued' });
    expect(r.m.queuedFor('alpha')[0].now).toBeUndefined();
    expect(r.m.promote('alpha', id)).toEqual({ ok: true, delivered: 'queued', id });
    await vi.waitFor(() => expect(bodies(r.typed)).toEqual(['나중에']));
    expect(r.typed[0].whileWorking).toBe(true);
    expect(r.m.queuedFor('alpha')).toEqual([]);
    expect(r.queueFiles()).toHaveLength(1); // the agent's still waits for idle
  });

  // 11-01 08:54: a miss paused the target for retryMs; 지금 보내기 then waited the pause out (58 s).
  it('즉시 skips the pause after a miss: a promoted waiting message', async () => {
    const r = rig({ typed: 'notReady', timing: { retryMs: 600_000 } });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    const queued = await r.m.send(boss('alpha', 'normal'));
    if (!queued.ok || !queued.id) throw new Error('message was not queued');
    await vi.waitFor(() => expect(r.typed).toHaveLength(1)); // the miss: paused
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    r.setResult('typed');
    expect(r.m.promote('alpha', queued.id)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(bodies(r.typed)).toEqual(['normal', 'normal']));
    expect(r.typed[1].whileWorking).toBe(true);
  });

  it('즉시 skips the pause after a miss: a new now message', async () => {
    const r = rig({ typed: 'notReady', timing: { retryMs: 600_000 } });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.send(boss('alpha', 'normal'));
    await vi.waitFor(() => expect(r.typed).toHaveLength(1)); // the miss: paused
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    r.setResult('typed');
    await r.m.send(boss('alpha', 'urgent', true));
    await vi.waitFor(() => expect(bodies(r.typed)).toEqual(['normal', 'urgent']));
  });

  it('an edit may point the queued message at another message to answer; without one the old reference stays', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const first = await r.m.send({ ...boss('alpha', 'old words'), replyTo: { id: 'first001', sender: 'alpha', text: 'one' } });
    if (!first.ok || !first.id) throw new Error('message was not queued');
    const quoted = () => r.m.queuedFor('alpha').find((q) => q.id === first.id)?.replyTo?.id;
    expect(r.m.edit('alpha', first.id, 'same quote')).toMatchObject({ ok: true });
    expect(quoted()).toBe('first001');
    expect(r.m.edit('alpha', first.id, 'new quote', { id: 'second02', sender: 'alpha', text: 'two' })).toMatchObject({ ok: true });
    expect(quoted()).toBe('second02');
  });

  it('the boss can edit or cancel a queued message in place; a peer cannot', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const first = await r.m.send(boss('alpha', 'old words'));
    const second = await r.m.send(boss('alpha', 'remove me'));
    await r.m.send(send('alpha', 'peer words'));
    if (!first.ok || !first.id || !second.ok || !second.id)
      throw new Error('messages were not queued');
    expect(r.m.edit('alpha', first.id, ' \n')).toMatchObject({ ok: false, code: 'empty_message' });
    expect(r.m.edit('alpha', first.id, 'x'.repeat(TEXT_MAX + 1))).toMatchObject({
      ok: false,
      code: 'too_large',
    });
    const before = r.queueFiles();
    expect(r.m.edit('alpha', first.id, 'new words')).toEqual({
      ok: true,
      delivered: 'queued',
      id: first.id,
    });
    expect(r.queueFiles()).toEqual(before); // the sorted queue-file name did not move
    expect(r.m.queuedFor('alpha')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, text: 'new words', edited: true }),
      ]),
    );
    expect(r.m.cancel('alpha', second.id)).toEqual({
      ok: true,
      delivered: 'queued',
      id: second.id,
    });
    expect(r.m.queuedFor('alpha')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: second.id, text: 'remove me', cancelled: true }),
      ]),
    );
    const peerId = r.queueFiles().find((id) => id !== first.id)!;
    expect(r.m.edit('alpha', peerId, 'no')).toMatchObject({ ok: false, code: 'not_queued' });
    expect(r.m.cancel('alpha', peerId)).toMatchObject({ ok: false, code: 'not_queued' });
    expect(
      r
        .events()
        .filter((e) => /^send_(edit|cancel)$/.test(String(e.type)))
        .map((e) => e.type),
    ).toEqual(['send_edit', 'send_cancel']);
  });

  it('EDIT-ATTACH: an edit keeps the uploaded files and takes the ones it adds, once each', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const one = '[\ucca8\ubd80] /p/.agty-inbox/a.png (image/png, 1 KB)';
    const two = '[\ucca8\ubd80] /p/.agty-inbox/b.pdf (application/pdf, 2 KB)';
    const first = await r.m.send(boss('alpha', `old words\n${one}`));
    if (!first.ok || !first.id) throw new Error('message was not queued');
    // The edit may repeat the old line (the box held it) and carries the new one after it.
    expect(r.m.edit('alpha', first.id, `new words\n${one}\n${two}`)).toMatchObject({ ok: true });
    expect(r.m.queuedFor('alpha')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, text: `new words\n${one}\n${two}`, edited: true }),
      ]),
    );
    expect(r.m.edit('alpha', first.id, 'newer words')).toMatchObject({ ok: true });
    expect(r.m.queuedFor('alpha')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, text: `newer words\n${one}\n${two}` }),
      ]),
    );
  });

  it('holds an edited queue entry and the later entries behind it until edit saves', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const first = await r.m.send(boss('alpha', 'old words'));
    await r.m.send(boss('alpha', 'after it'));
    if (!first.ok || !first.id) throw new Error('message was not queued');
    expect(r.m.hold('alpha', first.id, true)).toBe(true);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.tick();
    expect(r.typed).toEqual([]);

    expect(r.m.edit('alpha', first.id, 'new words')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(bodies(r.typed)).toEqual(['new words', 'after it']));
  });

  it('releases an edit hold when it is turned off; it never expires by itself (MSG-HOLD2)', async () => {
    const off = rig();
    off.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const turnedOff = await off.m.send(boss('alpha', 'turn off'));
    if (!turnedOff.ok || !turnedOff.id) throw new Error('message was not queued');
    expect(off.m.hold('alpha', turnedOff.id, true)).toBe(true);
    expect(off.m.hold('alpha', turnedOff.id, false)).toBe(true);
    off.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await vi.waitFor(() => expect(bodies(off.typed)).toEqual(['turn off']));

    const kept = rig();
    kept.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const stays = await kept.m.send(boss('alpha', 'stays'));
    if (!stays.ok || !stays.id) throw new Error('message was not queued');
    expect(kept.m.hold('alpha', stays.id, true)).toBe(true);
    kept.advance(24 * 60 * 60_000);
    kept.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await kept.m.tick();
    expect(kept.typed).toEqual([]);
    expect(kept.m.queuedFor('alpha')).toEqual([expect.objectContaining({ text: 'stays', held: true })]);
  });

  it('keeps a held item and every item behind it out of the inbox', async () => {
    const r = rig({ timing: { ifIdleMs: 1 } });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const first = await r.m.send(boss('alpha', 'stay queued'));
    await r.m.send(boss('alpha', 'wait behind'));
    if (!first.ok || !first.id) throw new Error('message was not queued');
    expect(r.m.hold('alpha', first.id, true)).toBe(true);
    r.advance(1);
    await r.m.tick();
    expect(r.inbox('alpha')).toEqual([]);
    r.sessions.delete('alpha');
    await r.m.tick();
    expect(r.inbox('alpha')).toEqual([]);
    expect(r.m.queuedFor('alpha')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'stay queued' }),
        expect.objectContaining({ text: 'wait behind' }),
      ]),
    );
  });

  it('does not hold an unknown or already typed queue id', async () => {
    const r = rig();
    expect(r.m.hold('alpha', 'missing.json', true)).toBe(false);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const sent = await r.m.send(boss('alpha', 'already sent'));
    if (!sent.ok || !sent.id) throw new Error('message did not send');
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await vi.waitFor(() => expect(bodies(r.typed)).toEqual(['already sent']));
    expect(r.m.hold('alpha', sent.id, true)).toBe(false);
  });

  it('the boss can edit or cancel an inbox message in place', async () => {
    const r = rig(); // alpha is off, so the boss message waits in inbox/alpha/
    const attachment = '[첨부] /work/alpha/.agty-inbox/receipt.txt (text/plain, 1 KB)';
    expect(await r.m.send(boss('alpha', `old inbox\n${attachment}`))).toMatchObject({
      delivered: 'inbox',
    });
    const [queued] = r.m.queuedFor('alpha');
    expect(queued.id).toMatch(/^inbox:.*\.md$/);
    const before = r.inbox('alpha');
    expect(r.m.edit('alpha', queued.id, 'new inbox')).toMatchObject({ ok: true });
    expect(r.inbox('alpha')).toEqual(before); // the delivery file keeps its place and name
    expect(r.readInbox('alpha')).toEqual([
      expect.stringMatching(
        new RegExp(`\\nnew inbox\\n${attachment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      ),
    ]);
    expect(r.m.queuedFor('alpha')).toEqual([
      expect.objectContaining({ id: queued.id, text: `new inbox\n${attachment}`, edited: true }),
    ]);
    expect(r.m.cancel('alpha', queued.id)).toMatchObject({ ok: true });
    expect(r.inbox('alpha')).toEqual([]);
    expect(r.m.queuedFor('alpha')).toEqual([
      expect.objectContaining({ id: queued.id, text: `new inbox\n${attachment}`, cancelled: true }),
    ]);
  });

  it('C2: editing a waiting inbox message keeps its mark in the .md and its id after a reload', async () => {
    const r = rig(); // alpha is off: the message waits in inbox/alpha/
    const sent = await r.m.send(boss('alpha', '처음 글'));
    const id = (sent as { messageId: string }).messageId;
    const [queued] = r.m.queuedFor('alpha');
    expect(queued).toMatchObject({ messageId: id });
    expect(r.m.edit('alpha', queued.id, '고친 글')).toMatchObject({ ok: true });
    expect(r.readInbox('alpha')).toEqual([`[사장 · 메신저 · 10-21 23:05] ⟨m:${id}⟩\n고친 글`]);
    const fresh = new Messenger({
      home: r.home,
      engine: r.engine,
      typist: { type: () => Promise.resolve('failed') },
      events: new EngineEvents(eventsPath(r.home)),
      timing: { ...FAST, tickMs: 60_000 },
      log: () => undefined,
    });
    cleanup.push(() => fresh.dispose());
    expect(fresh.queuedFor('alpha')).toEqual([
      expect.objectContaining({ id: queued.id, text: '고친 글', edited: true, messageId: id }),
    ]);
  });

  it('a message is locked once the Typist starts: its old text is what gets entered', async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const r = rig({
      type: async () => {
        started?.();
        await slow;
        return 'typed';
      },
    });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const queued = await r.m.send(boss('alpha', 'old text'));
    if (!queued.ok || !queued.id) throw new Error('message was not queued');
    const typing = new Promise<void>((resolve) => (started = resolve));
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    const tick = r.m.tick();
    await typing;
    expect(r.m.edit('alpha', queued.id, 'new text')).toMatchObject({
      ok: false,
      code: 'typing',
      error: '이미 입력하고 있어요',
    });
    release!();
    await tick;
    expect(bodies(r.typed)).toEqual(['old text']);
  });

  it('busy with background work, its main turn over: plain messages go in (no working allowance)', async () => {
    const r = rig();
    const transcript = path.join(r.home, 't.jsonl');
    fs.writeFileSync(transcript, [PROMPT, TOOL_CALL, TOOL_RESULT, TURN_END].join('\n') + '\n');
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript });
    expect(await r.m.send(send('alpha', 'from beta'))).toEqual({
      ok: true,
      delivered: 'pane',
      messageId: ID,
    });
    expect(r.typed).toEqual([{ id: 'a1b2c3d4', text: expect.stringContaining('from beta') }]);
  });

  it('busy, its turn running (a prompt after the last turn end): waits, nothing attached', async () => {
    const r = rig();
    const transcript = path.join(r.home, 't.jsonl');
    fs.writeFileSync(transcript, [PROMPT, TURN_END, PROMPT, TOOL_CALL].join('\n') + '\n');
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript });
    expect(await r.m.send(send('alpha', 'later'))).toMatchObject({ delivered: 'queued' });
    await new Promise((res) => setTimeout(res, 100));
    expect(r.typed).toHaveLength(0);
    fs.appendFileSync(transcript, `${TOOL_RESULT}\n${TURN_END}\n`);
    await vi.waitFor(() => expect(r.typed).toHaveLength(1));
  });

  it('busy, turn over by the transcript but the screen still works: waits, one attach per retry pause', async () => {
    const r = rig({ typed: 'notReady', timing: { retryMs: 60_000 } });
    const transcript = path.join(r.home, 't.jsonl');
    fs.writeFileSync(transcript, [PROMPT, TURN_END].join('\n') + '\n');
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript });
    expect(await r.m.send(send('alpha', 'hi'))).toMatchObject({ delivered: 'queued' });
    await new Promise((res) => setTimeout(res, 200)); // ~10 ticks
    expect(r.typed).toHaveLength(1);
    expect(r.queueFiles()).toHaveLength(1);
  });

  // 10-22 12:28-12:30: a long background Bash ran, the main turn had ended
  // (these records, the last at 12:26:15); plain and 즉시 messages waited 90 s.
  const rec = (o: object) => JSON.stringify(o);
  const ENDED_WITH_BACKGROUND_BASH = [
    PROMPT,
    rec({ type: 'assistant', message: { content: [{ type: 'thinking' }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'thinking' }] } }),
    TOOL_CALL,
    TOOL_RESULT,
    rec({ type: 'api-request', id: 'req_1' }),
    rec({ type: 'attachment', attachment: { type: 'todo_reminder' } }),
    rec({
      type: 'assistant',
      timestamp: '2026-10-22T03:26:13.000Z',
      message: { content: [{ type: 'text', text: '13:02에 깨웁니다' }] },
    }),
    TURN_END,
  ];
  describe.each([
    ['busy', 'busy'],
    ['waiting', 'waiting'],
    ['without a status', undefined],
  ])('main turn over, session %s (agents: working)', (_name, status) => {
    it.each([
      ['plain', false],
      ['즉시', true],
    ])("the boss's %s message is typed", async (_kind, now) => {
      const r = rig();
      const transcript = path.join(r.home, 't.jsonl');
      fs.writeFileSync(transcript, ENDED_WITH_BACKGROUND_BASH.join('\n') + '\n');
      r.sessions.set('alpha', { id: 'a1b2c3d4', ...(status && { status }), transcript });
      expect(await r.m.send(boss('alpha', '지금 어때', now))).toEqual({
        ok: true,
        delivered: 'pane',
        messageId: ID,
      });
      expect(r.typed).toHaveLength(1);
    });
  });

  it('a session without a busy or idle status still waits while its turn runs', async () => {
    const r = rig();
    const transcript = path.join(r.home, 't.jsonl');
    fs.writeFileSync(
      transcript,
      [...ENDED_WITH_BACKGROUND_BASH, PROMPT, TOOL_CALL].join('\n') + '\n',
    );
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'waiting', transcript });
    expect(await r.m.send(boss('alpha', '나중에', true))).toMatchObject({ delivered: 'queued' });
    await new Promise((res) => setTimeout(res, 100));
    expect(r.typed).toHaveLength(0);
  });

  it('turnOver: turn_duration or a quiet text-only reply after the latest prompt', () => {
    const now = Date.parse('2026-10-22T11:50:00Z');
    const at = (ms: number) => new Date(now - ms).toISOString();
    const text = (ms: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: at(ms),
        message: { content: [{ type: 'text', text: 'done' }] },
      });
    const lines = (...l: string[]) => l.join('\n') + '\n';
    expect(turnOver(lines(PROMPT, TOOL_CALL, TOOL_RESULT, TURN_END), now, 5_000)).toBe(true);
    expect(turnOver(lines(PROMPT, TOOL_CALL, TOOL_RESULT), now, 5_000)).toBe(false);
    expect(turnOver(lines(TURN_END, PROMPT), now, 5_000)).toBe(false);
    expect(turnOver(lines(PROMPT, text(6_000)), now, 5_000)).toBe(true);
    expect(turnOver(lines(PROMPT, text(1_000)), now, 5_000)).toBe(false);
    // Sub-agents' sidechain records and meta records do not start or end the main turn.
    const side = JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'sub' } });
    const meta = JSON.stringify({ type: 'user', isMeta: true, message: { content: 'caveat' } });
    expect(turnOver(lines(PROMPT, TURN_END, side, meta), now, 5_000)).toBe(true);
    expect(turnOver('{"type":"system","subtype":"turn_dur', now, 5_000)).toBe(false); // cut
    expect(turnOver('', now, 5_000)).toBe(false);
  });

  it('a session waiting on its terminal (blocked): no attach, held for the app; resumes after', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    r.blocked.add('alpha');
    expect(await r.m.send(boss('alpha', '끝나면 알려줘'))).toMatchObject({ delivered: 'queued' });
    expect(await r.m.send(boss('alpha', '급해', true))).toMatchObject({ delivered: 'queued' });
    r.advance(60);
    await new Promise((res) => setTimeout(res, 100));
    expect(r.typed).toHaveLength(0);
    expect(r.m.held('alpha')).toBe(true);
    r.blocked.delete('alpha');
    r.advance(60); // past the retry pause: asked again
    await vi.waitFor(() => expect(r.typed).toHaveLength(2));
    expect(r.m.held('alpha')).toBe(false);
  });

  it('answeredSince: an assistant record from the session start on (a fresh one has none)', () => {
    const rec = (at: string, sidechain = false) =>
      JSON.stringify({ type: 'assistant', timestamp: at, isSidechain: sidechain, message: {} });
    const since = Date.parse('2026-10-22T12:00:00Z');
    expect(answeredSince(rec('2026-10-22T12:01:00Z'), since)).toBe(true);
    expect(answeredSince(rec('2026-10-22T11:59:00Z'), since)).toBe(false); // before a resume
    expect(answeredSince(rec('2026-10-22T12:01:00Z', true), since)).toBe(false);
    expect(answeredSince(PROMPT, since)).toBe(false);
  });

  it('a draft or dialog on screen: waits, tries again later', async () => {
    const r = rig({ typed: 'notReady' });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    expect(await r.m.send(send('alpha', 'hi'))).toMatchObject({ ok: true, delivered: 'queued' });
    r.setResult('typed');
    r.advance(60); // past retryMs
    await vi.waitFor(() => expect(r.queueFiles()).toHaveLength(0));
    expect(r.typed).toHaveLength(2);
  });

  it('--if-idle gives up after 10 minutes: inbox (input_busy); plain send keeps waiting', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(send('alpha', 'patient', false));
    await r.m.send(send('alpha', 'hurried', true));
    r.advance(10 * 60_000);
    await vi.waitFor(() => expect(r.inbox('alpha')).toHaveLength(1));
    expect(r.readInbox('alpha')[0]).toContain('hurried');
    expect(r.queueFiles()).toHaveLength(1); // the plain one still waits
    expect(r.events().at(-1)).toMatchObject({
      delivered: 'inbox',
      reason: 'input_busy',
      queued: true,
    });
  });

  it('a session that goes off while a message waits: inbox (reason off)', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(send('alpha', 'later'));
    r.sessions.delete('alpha');
    await vi.waitFor(() => expect(r.inbox('alpha')).toHaveLength(1));
    expect(r.events().at(-1)).toMatchObject({ delivered: 'inbox', reason: 'off', queued: true });
  });

  it('holds messages for a project in a renew', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    r.renewing.add('alpha');
    expect(await r.m.send(send('alpha', 'not now'))).toMatchObject({ delivered: 'queued' });
    await new Promise((res) => setTimeout(res, 100));
    expect(r.typed).toHaveLength(0);
    r.renewing.delete('alpha');
    await vi.waitFor(() => expect(r.typed).toHaveLength(1));
  });

  it.each([
    ['two queued messages for an off agent', false],
    ['a renew handoff file first', true],
  ])('C2: an inbox delivered as one turn (%s) shows no mark and binds to its last message', async (_case, handoff) => {
    const r = rig();
    if (handoff) r.m.writeInbox('alpha', '[agty renew] 이어서 할 일: 배포 마무리');
    r.advance(1_000);
    const one = await r.m.send(boss('alpha', '첫 글'));
    r.advance(1_000);
    const two = await r.m.send(boss('alpha', '둘째 글 ⟨m:zzzzzzzz⟩ 그대로'));
    const ids = [one, two].map((x) => (x as { messageId: string }).messageId);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    r.m.deliverInbox('alpha');
    await vi.waitFor(() => expect(r.typed).toHaveLength(1));
    const typed = r.typed[0].text;
    expect(typed.match(/⟨m:[a-z2-7]{8}⟩$/gm)).toEqual(ids.map((id) => `⟨m:${id}⟩`)); // both marks go in
    const items = chatItems(
      [
        JSON.stringify({ type: 'user', message: { content: typed } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '둘 다 했어요' }] } }),
      ].join('\n'),
    );
    // MSG-SPLIT (11-01): one bubble per message, each with its own id; an unmarked part (the
    // handoff) has none; the reply still binds to the turn's last message.
    expect(items.map((i) => [i.kind, i.messageId])).toEqual([
      ...(handoff ? [['user', undefined]] : []),
      ['user', ids[0]],
      ['user', ids[1]],
      ['assistant', ids[1]],
    ]);
    // Our header lines lose their mark; what the boss typed in a body stays, its opener defanged (F1).
    const second = items.find((i) => i.kind === 'user' && i.messageId === ids[1])!;
    expect(second.text).not.toMatch(/⟨m:[a-z2-7]{8}⟩$/m);
    expect(second.text).toContain('둘째 글 〈m:zzzzzzzz⟩ 그대로');
    expect(items[0].text.startsWith(handoff ? '[agty renew] 이어서 할 일' : '첫 글')).toBe(true);
  });

  it('the start hook types the inbox as one first message, then moves it to delivered/', async () => {
    const r = rig();
    await r.m.send(send('alpha', 'one'));
    r.advance(1_000);
    await r.m.send(send('alpha', 'two', false, null));
    expect(r.inbox('alpha')).toHaveLength(2);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    r.m.deliverInbox('alpha');
    r.m.deliverInbox('alpha'); // a second start hook does not deliver it twice
    await vi.waitFor(() => expect(r.typed).toHaveLength(1));
    // As is: each inbox file keeps its own header and mark.
    expect(r.typed[0].text).toMatch(
      new RegExp(
        `^\\[agty · beta에게서 · 10-21 23:05\\]${MARK}\\none\\n\\n\\[agty · 보냄 · 10-21 23:05\\]${MARK}\\ntwo$`,
      ),
    );
    await vi.waitFor(() => expect(r.inbox('alpha')).toHaveLength(0));
    expect(fs.readdirSync(path.join(r.home, '.config/agent-tycoon/inbox/alpha/delivered'))).toHaveLength(
      2,
    );
    expect(r.events().at(-1)).toMatchObject({ type: 'inbox_deliver', to: 'alpha', count: 2 });
  });

  it('a broken registry is not "every project is gone": queued messages wait, then go', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-msg-'));
    cleanup.push(() => removeTestHome(home));
    const queue = path.join(home, '.config/agent-tycoon/queue');
    fs.mkdirSync(queue, { recursive: true });
    for (const [i, to] of ['alpha', 'beta'].entries()) {
      const q: QueuedSend = {
        v: 1,
        to,
        text: `for ${to}`,
        from: null,
        source: 'cli',
        ifIdle: false,
        created: Date.now() + i,
      };
      fs.writeFileSync(path.join(queue, `${q.created}-abcde${i}.json`), JSON.stringify(q));
    }
    // As the engine reads a broken registry: no names, no sessions.
    let problem: string | null = 'not JSON';
    const typed: string[] = [];
    const logs: string[] = [];
    const m = new Messenger({
      home,
      engine: {
        names: () => (problem ? [] : ['alpha', 'beta']),
        registryProblem: () => problem,
        sessionOf: () => (problem ? null : { id: 'a1b2c3d4', status: 'idle' }),
        renewing: () => false,
      },
      typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed')) },
      events: new EngineEvents(eventsPath(home)),
      timing: FAST,
      log: (l) => logs.push(l),
    });
    m.start();
    cleanup.push(() => m.dispose());
    for (let i = 0; i < 5; i++) await m.tick();
    await new Promise((r) => setTimeout(r, 10 * FAST.tickMs)); // its own ticks too

    expect(fs.readdirSync(queue).filter((f) => f.endsWith('.json'))).toHaveLength(2);
    expect(fs.existsSync(path.join(home, '.config/agent-tycoon/inbox'))).toBe(false);
    expect(typed).toEqual([]);
    expect(logs.filter((l) => /dropped/.test(l))).toEqual([]);

    problem = null; // fixed (the engine reads it at its next start)
    await vi.waitFor(() =>
      expect(typed.map((t) => t.split('\n')[1]).sort()).toEqual(['for alpha', 'for beta']),
    );
    await vi.waitFor(() =>
      expect(fs.readdirSync(queue).filter((f) => f.endsWith('.json'))).toEqual([]),
    );
  });

  it('resumes queue files written while the daemon was off (agty send)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-msg-'));
    cleanup.push(() => removeTestHome(home));
    const q: QueuedSend = {
      v: 1,
      to: 'alpha',
      text: 'while off',
      from: null,
      source: 'cli',
      ifIdle: false,
      created: Date.now(),
    };
    fs.mkdirSync(path.join(home, '.config/agent-tycoon/queue'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config/agent-tycoon/queue', `${q.created}-abcdef.json`),
      JSON.stringify(q),
    );
    const typed: string[] = [];
    const m = new Messenger({
      home,
      engine: {
        names: () => ['alpha'],
        sessionOf: () => ({ id: 'a1b2c3d4', status: 'idle' }),
        renewing: () => false,
      },
      typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed')) },
      events: new EngineEvents(eventsPath(home)),
      timing: FAST,
      log: () => undefined,
    });
    m.start();
    cleanup.push(() => m.dispose());
    await vi.waitFor(() => expect(typed).toEqual([`${header(q)}\nwhile off`]));
    expect(messageOf(q)).toBe(typed[0]);
  });
});

describe('messages through the attach (fake claude, real PTY)', () => {
  // A loaded gate machine (parallel workers plus runners) has taken over 15 s to type a queued message
  // after the fake turn and its quiet window: the waits check order, not speed.
  // 40 s was not enough on 11-01 when the gate ran beside four subagents (the 5th message came after 60 s);
  // the test is ~34 s alone. The waits are a ceiling for a loaded machine, not the expected time.
  const LOADED_MS = 90_000;
  it('types into an idle session, waits while it works or holds a draft', async () => {
    const { home, claudePath } = makeEngineHome();
    const folder = path.join(home, 'work', 'alpha');
    fs.mkdirSync(folder, { recursive: true });
    saveRegistry(registryPath(home), [{ name: 'alpha', folder, wantRunning: false }]);
    const events = new EngineEvents(eventsPath(home));
    let messenger: Messenger | null = null;
    const engine = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      log: () => undefined,
      timing: { pollMs: 20, appearMs: 5_000, goneMs: 5_000, debounceMs: 50 },
      env: { ...process.env, HOME: home },
      binDir: null,
      started: (n) => messenger?.deliverInbox(n),
      writeInbox: (n, t) => messenger!.writeInbox(n, t),
      event: (t, s, f) => events.append(t, s, f),
    });
    const chat = new ChatManager({
      claudePath,
      env: { HOME: home, FAKE_TURN_MS: '600' },
      log: () => undefined,
      typeTiming: { readyMs: 5_000 },
    });
    messenger = new Messenger({
      home,
      engine,
      typist: chat,
      events,
      timing: FAST,
      log: () => undefined,
    });
    cleanup.push(() => {
      messenger?.dispose();
      engine.dispose();
      void chat.disposeAll();
      killFakeSessions(home);
      removeTestHome(home);
    });
    const typedLog = () => {
      try {
        return fs
          .readFileSync(path.join(home, 'fake-claude-typed.log'), 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { text: string }).text);
      } catch {
        return [];
      }
    };
    engine.start();
    messenger.start();
    // Off: the inbox; started: the inbox comes in first.
    expect(await messenger.send(send('alpha', 'waiting for you', false, null))).toMatchObject({
      delivered: 'inbox',
    });
    const started = await engine.run(
      { type: 'engineAction', requestId: 'r1', action: 'start', name: 'alpha' },
      true,
      'test',
    );
    expect(started).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(typedLog()).toHaveLength(1), LOADED_MS);
    expect(typedLog()[0]).toMatch(
      new RegExp(`^\\[agty · 보냄 · \\d\\d-\\d\\d \\d\\d:\\d\\d\\]${MARK}\\rwaiting for you$`),
    );
    // Its turn (FAKE_TURN_MS) is running: queued, typed when it is done.
    const busy = await messenger.send(send('alpha', 'second', false, null));
    expect(busy).toMatchObject({ delivered: 'queued' });
    await vi.waitFor(() => expect(typedLog()).toHaveLength(2), LOADED_MS);
    expect(typedLog()[1]).toContain('second');
    // A draft in the input line: not typed over.
    const id = engine.sessionOf('alpha');
    if (!id || id === 'terminal') throw new Error('alpha is not live');
    await vi.waitFor(
      () => expect(engine.sessionOf('alpha')).toMatchObject({ status: 'idle' }),
      5_000,
    );
    fs.writeFileSync(path.join(home, `fake-draft-${id.id}`), 'half a thought');
    expect(await messenger.send(send('alpha', 'third', false, null))).toMatchObject({
      delivered: 'queued',
    });
    await new Promise((res) => setTimeout(res, 400));
    expect(typedLog()).toHaveLength(2);
    fs.rmSync(path.join(home, `fake-draft-${id.id}`));
    await vi.waitFor(() => expect(typedLog()).toHaveLength(3), LOADED_MS);
    expect(typedLog()[2]).toContain('third');
    expect(fs.readFileSync(eventsPath(home), 'utf-8')).toContain('"type":"inbox_deliver"');
    // A long turn (status busy: the fake draws "esc to interrupt" above the input box).
    await vi.waitFor(
      () => expect(engine.sessionOf('alpha')).toMatchObject({ status: 'idle' }),
      5_000,
    );
    const sessDir = path.join(home, '.claude/sessions');
    const sessFile = fs
      .readdirSync(sessDir)
      .map((f) => path.join(sessDir, f))
      .find(
        (f) => (JSON.parse(fs.readFileSync(f, 'utf-8')) as { jobId?: string }).jobId === id.id,
      )!;
    const sess = JSON.parse(fs.readFileSync(sessFile, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(sessFile, JSON.stringify({ ...sess, status: 'busy' }));
    await vi.waitFor(() => expect(engine.sessionOf('alpha')).toMatchObject({ status: 'busy' }));
    // The boss's plain message waits; 즉시 under a question dialog is not typed either.
    expect(await messenger.send(boss('alpha', 'plain'))).toMatchObject({ delivered: 'queued' });
    fs.writeFileSync(path.join(home, `fake-dialog-${id.id}`), '');
    expect(await messenger.send(boss('alpha', 'urgent', true))).toMatchObject({
      delivered: 'queued',
    });
    expect(typedLog()).toHaveLength(3);
    // The dialog answered: 즉시 goes in while the turn still runs, ahead of the plain one.
    fs.rmSync(path.join(home, `fake-dialog-${id.id}`));
    await vi.waitFor(() => expect(typedLog()).toHaveLength(4), LOADED_MS);
    expect(typedLog()[3]).toMatch(new RegExp(`^\\[사장 · 메신저 · .*\\]${MARK}\\rurgent$`));
    // ...submitted with chat:sendNow: Enter would only queue it for the turn's end (10-22 18:33).
    const raw = fs
      .readFileSync(path.join(home, 'fake-claude-typed.log'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { now?: boolean });
    expect([raw[2].now, raw[3].now]).toEqual([undefined, true]);
    // Its own turn ends (FAKE_TURN_MS): then the plain one.
    await vi.waitFor(() => expect(typedLog()).toHaveLength(5), LOADED_MS);
    expect(typedLog()[4]).toContain('plain');
    // Busy with background sub-agents: the transcript says the main turn ended.
    await vi.waitFor(
      () => expect(engine.sessionOf('alpha')).toMatchObject({ status: 'idle' }),
      5_000,
    );
    fs.writeFileSync(sessFile, JSON.stringify({ ...sess, status: 'busy' }));
    const live = engine.sessionOf('alpha');
    if (!live || live === 'terminal' || !live.transcript) throw new Error('no transcript path');
    fs.mkdirSync(path.dirname(live.transcript), { recursive: true });
    fs.appendFileSync(
      live.transcript,
      [PROMPT, TOOL_CALL, TOOL_RESULT, TURN_END].join('\n') + '\n',
    );
    // ...but the screen still shows the working line: not typed.
    expect(await messenger.send(send('alpha', 'after the turn', false, null))).toMatchObject({
      delivered: 'queued',
    });
    await new Promise((res) => setTimeout(res, 400));
    expect(typedLog()).toHaveLength(5);
    // The working line gone (only background work left): typed while still busy.
    fs.writeFileSync(path.join(home, `fake-bg-${id.id}`), '');
    await vi.waitFor(() => expect(typedLog()).toHaveLength(6), LOADED_MS);
    expect(typedLog()[5]).toContain('after the turn');
    fs.rmSync(path.join(home, `fake-bg-${id.id}`));
    // claude agents says blocked: a fresh answer-less session is not held (its first
    // message is what it waits for); once it answered since its start with its turn
    // open on a tool call (a question or permission at its terminal), it is.
    await vi.waitFor(
      () => expect(engine.sessionOf('alpha')).toMatchObject({ status: 'idle' }),
      5_000,
    );
    fs.writeFileSync(path.join(home, `fake-blocked-${id.id}`), '');
    expect(await engine.held('alpha')).toBe(false);
    const ask = {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: {} }] },
    };
    fs.appendFileSync(live.transcript, `${PROMPT}\n${JSON.stringify(ask)}\n`);
    expect(await engine.held('alpha')).toBe(true);
    expect(await messenger.send(boss('alpha', 'while blocked'))).toMatchObject({
      delivered: 'queued',
    });
    await new Promise((res) => setTimeout(res, 400));
    expect(typedLog()).toHaveLength(6);
    expect(messenger.held('alpha')).toBe(true);
    // Still `blocked`, but the turn is over (pearl 10-22 14:28: "Worked for 20s", an
    // empty input line): it waits for a reply, and the message goes in.
    const answered = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'A' }] },
    });
    fs.appendFileSync(live.transcript, `${answered}\n${TURN_END}\n`);
    expect(await engine.held('alpha')).toBe(false);
    await vi.waitFor(() => expect(typedLog()).toHaveLength(7), LOADED_MS);
    expect(typedLog()[6]).toContain('while blocked');
    expect(messenger.held('alpha')).toBe(false);
    fs.rmSync(path.join(home, `fake-blocked-${id.id}`));
  }, 300_000);

  it('PERM-PROMPT: answers a permission dialog only when it is on screen and about the same call', async () => {
    const { home, claudePath } = makeEngineHome();
    const folder = path.join(home, 'work', 'alpha');
    fs.mkdirSync(folder, { recursive: true });
    saveRegistry(registryPath(home), [{ name: 'alpha', folder, wantRunning: false }]);
    const engine = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      log: () => undefined,
      timing: { pollMs: 20, appearMs: 5_000, goneMs: 5_000, debounceMs: 50 },
      env: { ...process.env, HOME: home },
      binDir: null,
    });
    const lines: string[] = [];
    const chat = new ChatManager({
      claudePath,
      env: { HOME: home },
      log: (l) => lines.push(l),
      typeTiming: { readyMs: 5_000 },
    });
    cleanup.push(() => {
      engine.dispose();
      void chat.disposeAll();
      killFakeSessions(home);
      removeTestHome(home);
    });
    engine.start();
    expect(
      await engine.run({ type: 'engineAction', requestId: 'r1', action: 'start', name: 'alpha' }, true, 'test'),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(engine.sessionOf('alpha')).toMatchObject({ id: expect.any(String) }), 10_000);
    const live = engine.sessionOf('alpha');
    if (!live || live === 'terminal') throw new Error('alpha is not live');
    const answers = () => {
      try {
        return fs
          .readFileSync(path.join(home, 'fake-claude-answers.log'), 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { answer: string }).answer);
      } catch {
        return [];
      }
    };
    const perm = path.join(home, `fake-perm-${live.id}`);
    const ask = (desc: string, command: string) =>
      fs.writeFileSync(perm, JSON.stringify({ title: 'Bash command · from the general-purpose agent', desc, command }));
    const card = ['Clean the marks', 'rm -f $M/*'];

    // Negative control 1: no dialog at all (an empty input line): nothing sent.
    expect(await chat.answerPermission(live.id, card, true)).toBe('noDialog');
    // Negative control 2: a question dialog is no permission dialog: nothing sent.
    fs.writeFileSync(path.join(home, `fake-dialog-${live.id}`), '');
    expect(await chat.answerPermission(live.id, card, true)).toBe('noDialog');
    fs.rmSync(path.join(home, `fake-dialog-${live.id}`));
    // Negative control 3: a permission dialog about another call: nothing sent, it stays.
    ask('List the files', 'ls -la');
    expect(await chat.answerPermission(live.id, card, true)).toBe('otherDialog');
    // Negative control 4: same description, another command: still another call.
    ask('Clean the marks', 'rm -rf /tmp/other/*');
    expect(await chat.answerPermission(live.id, card, true)).toBe('otherDialog');
    // Negative control 5: nothing to match (a call the transcript did not describe).
    ask('Clean the marks', 'rm -f $M/*');
    expect(await chat.answerPermission(live.id, [], true)).toBe('failed');
    expect(answers()).toEqual([]);
    expect(fs.existsSync(perm)).toBe(true);
    // claude agents lists it waiting for a permission prompt: held, whatever the transcript says.
    expect(await engine.held('alpha')).toBe(true);

    // The same call's dialog: "1. Yes", and it went away.
    ask('Clean the marks', 'rm -f $M/*\necho done');
    expect(await chat.answerPermission(live.id, card, true)).toBe('answered');
    expect(answers()).toEqual(['yes']);
    expect(fs.existsSync(perm)).toBe(false);
    expect(await engine.held('alpha')).toBe(false);
    // Deny: Esc.
    ask('Clean the marks', 'rm -f $M/*');
    expect(await chat.answerPermission(live.id, card, false)).toBe('answered');
    expect(answers()).toEqual(['yes', 'no']);
    // One log line per answer, no terminal content.
    const permLines = lines.filter((l) => l.startsWith('permission '));
    expect(permLines).toHaveLength(6);
    expect(permLines.join('\n')).not.toMatch(/rm -f|Clean|ls -la/);
  }, 120_000);

  it('PERM-PROMPT: two answers at once (a double press, two devices) press one key: the next queued dialog is not approved', async () => {
    const { home, claudePath } = makeEngineHome();
    const folder = path.join(home, 'work', 'alpha');
    fs.mkdirSync(folder, { recursive: true });
    saveRegistry(registryPath(home), [{ name: 'alpha', folder, wantRunning: false }]);
    const engine = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      log: () => undefined,
      timing: { pollMs: 20, appearMs: 5_000, goneMs: 5_000, debounceMs: 50 },
      env: { ...process.env, HOME: home },
      binDir: null,
    });
    const chat = new ChatManager({ claudePath, env: { HOME: home }, log: () => undefined, typeTiming: { readyMs: 5_000 } });
    cleanup.push(() => {
      engine.dispose();
      void chat.disposeAll();
      killFakeSessions(home);
      removeTestHome(home);
    });
    engine.start();
    expect(
      await engine.run({ type: 'engineAction', requestId: 'r1', action: 'start', name: 'alpha' }, true, 'test'),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(engine.sessionOf('alpha')).toMatchObject({ id: expect.any(String) }), 10_000);
    const live = engine.sessionOf('alpha');
    if (!live || live === 'terminal') throw new Error('alpha is not live');
    const perm = path.join(home, `fake-perm-${live.id}`);
    // The card's dialog, and another sub-agent's queued behind it (Claude shows it once the first is answered).
    fs.writeFileSync(perm, JSON.stringify({ title: 'Bash command', desc: 'Clean the marks', command: 'rm -f $M/*' }));
    fs.writeFileSync(`${perm}.next`, JSON.stringify({ title: 'Bash command', desc: 'Wipe it', command: 'rm -rf $HOME/x' }));
    const card = ['Clean the marks', 'rm -f $M/*'];
    const results = await Promise.all([
      chat.answerPermission(live.id, card, true),
      chat.answerPermission(live.id, card, true),
    ]);
    expect(results).toContain('answered');
    const answers = fs.readFileSync(path.join(home, 'fake-claude-answers.log'), 'utf-8').trim().split('\n');
    expect(answers).toHaveLength(1);
    expect(fs.readFileSync(perm, 'utf-8')).toContain('Wipe it'); // the second dialog still waits for its owner
  }, 120_000);

  it('PERM-PROMPT: a card read off the screen answers exactly that dialog; a changed dialog gets nothing', async () => {
    const { home, claudePath } = makeEngineHome();
    const folder = path.join(home, 'work', 'alpha');
    fs.mkdirSync(folder, { recursive: true });
    saveRegistry(registryPath(home), [{ name: 'alpha', folder, wantRunning: false }]);
    const engine = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      log: () => undefined,
      timing: { pollMs: 20, appearMs: 5_000, goneMs: 5_000, debounceMs: 50 },
      env: { ...process.env, HOME: home },
      binDir: null,
    });
    const chat = new ChatManager({ claudePath, env: { HOME: home }, log: () => undefined, typeTiming: { readyMs: 5_000 } });
    cleanup.push(() => {
      engine.dispose();
      void chat.disposeAll();
      killFakeSessions(home);
      removeTestHome(home);
    });
    engine.start();
    expect(
      await engine.run({ type: 'engineAction', requestId: 'r1', action: 'start', name: 'alpha' }, true, 'test'),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(engine.sessionOf('alpha')).toMatchObject({ id: expect.any(String) }), 10_000);
    const live = engine.sessionOf('alpha');
    if (!live || live === 'terminal') throw new Error('alpha is not live');
    const perm = path.join(home, `fake-perm-${live.id}`);
    const answers = () => {
      const f = path.join(home, 'fake-claude-answers.log');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean) : [];
    };
    // No dialog: nothing to read (and nothing written).
    expect(await chat.readPermissionDialog(live.id)).toBeNull();
    // The dialog of the live case (10-25 01:56): read off the screen, attach gone after.
    const dangerous = {
      title: 'Bash command · from the general-purpose agent',
      desc: 'Run shell command',
      command: 'cd /work/ui-audit && npm run -s build:webview && rm -f agent-tycoon/artifacts/ui-audit/* && npx tsx run.ts',
    };
    fs.writeFileSync(perm, JSON.stringify(dangerous));
    const dialog = await chat.readPermissionDialog(live.id);
    expect(dialog).toContain('rm -f agent-tycoon/artifacts/ui-audit/*');
    expect(dialog).toContain('Bash command · from the general-purpose agent');
    expect(chat.size).toBe(0);
    // Negative control: the dialog changed since it was read (the next call's): nothing pressed.
    fs.writeFileSync(perm, JSON.stringify({ ...dangerous, command: 'cd /work/ui-audit && python3 - <<E' }));
    expect(await chat.answerPermission(live.id, { dialog: dialog! }, true)).toBe('otherDialog');
    expect(answers()).toEqual([]);
    // Negative control: a question dialog is no permission dialog.
    fs.writeFileSync(perm, JSON.stringify(dangerous));
    fs.writeFileSync(path.join(home, `fake-dialog-${live.id}`), '');
    fs.renameSync(perm, `${perm}.hold`);
    expect(await chat.answerPermission(live.id, { dialog: dialog! }, true)).toBe('noDialog');
    fs.renameSync(`${perm}.hold`, perm);
    fs.unlinkSync(path.join(home, `fake-dialog-${live.id}`));
    expect(answers()).toEqual([]);
    // The same dialog: "1. Yes", gone.
    expect(await chat.answerPermission(live.id, { dialog: dialog! }, true)).toBe('answered');
    expect(answers()).toEqual([JSON.stringify({ id: live.id, answer: 'yes' })]);
    expect(fs.existsSync(perm)).toBe(false);
  }, 120_000);
});

// TOKEN-GUARD (directive 10-24): the engine never types what nobody asked for, never twice,
// and never stands in the way of approved work (owner, agents, Lead → Worker).
describe('TOKEN-GUARD: the messenger', () => {
  /** A daemon restart: a second Messenger over the same home (the first one is gone). */
  const restart = (r: ReturnType<typeof rig>, typed: string[] = []) => {
    r.m.dispose();
    const m = new Messenger({
      home: r.home,
      engine: r.engine,
      typist: { type: (_id, text, o) => (typed.push(text), o?.onTyped?.(), Promise.resolve('typed')) },
      events: new EngineEvents(eventsPath(r.home)),
      timing: FAST,
      now: () => Date.parse('2026-10-21T23:05:00+09:00'),
      log: () => undefined,
    });
    m.start();
    cleanup.push(() => m.dispose());
    return { m, typed };
  };
  /** The session's transcript with the user turn a typed message made (its header carries the mark). */
  const userTurn = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const guards = (r: ReturnType<typeof rig>) => r.events().filter((e) => e.type === 'token_guard');

  it('TG-09: an agent cannot send to itself (CLI and every other path go through send)', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    expect(await r.m.send(send('alpha', 'remind me', false, 'alpha'))).toMatchObject({
      ok: false,
      code: 'self_send',
    });
    expect(r.typed).toEqual([]);
    expect(r.queueFiles()).toEqual([]);
    expect(guards(r)).toEqual([
      expect.objectContaining({ trigger: 'send', to: 'alpha', from: 'alpha', allowed: false, reason: 'self_send' }),
    ]);
    // Negative: the boss (from null) and another agent still reach alpha.
    expect(await r.m.send(boss('alpha', 'from the boss'))).toMatchObject({ delivered: 'pane' });
    expect(await r.m.send(send('alpha', 'from beta'))).toMatchObject({ delivered: 'pane' });
    expect(bodies(r.typed)).toEqual(['from the boss', 'from beta']);
  });

  it('a message already in the transcript (typed just before a daemon restart) is not typed again', async () => {
    const r = rig();
    const transcript = path.join(r.home, 't.jsonl');
    fs.writeFileSync(transcript, `${PROMPT}\n${TOOL_CALL}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript });
    const sent = await r.m.send(send('alpha', 'review done'));
    if (!sent.ok || !sent.messageId) throw new Error('not queued');
    const file = r.queueFiles()[0];
    const item = parseQueued(fs.readFileSync(path.join(r.m.queueDir, file), 'utf-8'))!;
    // The Typist pasted and submitted it; the daemon died before it removed the queue file.
    fs.appendFileSync(transcript, `${userTurn(messageOf(item))}\n${TURN_END}\n`);
    const again = restart(r);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript });
    await again.m.tick();
    expect(again.typed).toEqual([]);
    expect(r.queueFiles()).toEqual([]);
    expect(guards(r)).toEqual([
      expect.objectContaining({ trigger: 'tick', to: 'alpha', messageId: sent.messageId, allowed: false, reason: 'already_typed' }),
    ]);
  });

  it('a mark seen only in a tool result (the agent read a log or another transcript) does not drop the message', async () => {
    const r = rig();
    const transcript = path.join(r.home, 't.jsonl');
    fs.writeFileSync(transcript, `${PROMPT}\n${TOOL_CALL}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript });
    const sent = await r.m.send(send('alpha', 'not seen yet'));
    if (!sent.ok || !sent.messageId) throw new Error('not queued');
    const out = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `grep: x ⟨m:${sent.messageId}⟩` }] },
    });
    fs.appendFileSync(transcript, `${out}\n${TURN_END}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript });
    await r.m.tick();
    expect(bodies(r.typed)).toEqual(['not seen yet']);
  });

  it('a paste whose submit was unsure is not typed again once the transcript shows it', async () => {
    let n = 0;
    const transcript = (r: ReturnType<typeof rig>) => path.join(r.home, 't.jsonl');
    const r: ReturnType<typeof rig> = rig({
      // The first try pastes, the submit is not seen in time (notReady), but it went in.
      type: (_id, text) => {
        if (n++ === 0) {
          fs.appendFileSync(transcript(r), `${userTurn(text)}\n${TURN_END}\n`);
          return Promise.resolve('notReady');
        }
        return Promise.resolve('typed');
      },
    });
    fs.writeFileSync(transcript(r), `${PROMPT}\n${TURN_END}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript: transcript(r) });
    expect(await r.m.send(send('alpha', 'once only'))).toMatchObject({ delivered: 'queued' });
    r.advance(FAST.retryMs * 10);
    await r.m.tick();
    expect(r.typed).toHaveLength(1);
    expect(r.queueFiles()).toEqual([]);
  });

  it('the same words sent again are a new message (a new id): typed again', async () => {
    const r = rig();
    const transcript = path.join(r.home, 't.jsonl');
    fs.writeFileSync(transcript, `${PROMPT}\n${TURN_END}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript });
    expect(await r.m.send(boss('alpha', 'ok'))).toMatchObject({ delivered: 'pane' });
    fs.appendFileSync(transcript, `${userTurn(r.typed[0].text)}\n${TURN_END}\n`);
    expect(await r.m.send(boss('alpha', 'ok'))).toMatchObject({ delivered: 'pane' });
    expect(bodies(r.typed)).toEqual(['ok', 'ok']);
  });

  it('TG-04: notices waiting for an idle session go in as one paste (one turn), each with its mark', async () => {
    const r = rig({ names: ['alpha', 'beta', 'gamma'] });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(send('alpha', 'report 1'));
    await r.m.send(send('alpha', 'report 2', false, 'gamma'));
    await r.m.send({ ...send('alpha', 'notice 3', false, null), source: 'engine' });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.tick();
    expect(r.typed).toHaveLength(1);
    const text = r.typed[0].text;
    expect(text.match(/⟨m:[a-z2-7]{8}⟩/g)).toHaveLength(3);
    expect(text).toMatch(/report 1\n\n\[agty · gamma에게서 · [^\]]+\] ⟨m:[a-z2-7]{8}⟩\nreport 2\n\n\[agty · 보냄 · /);
    expect(r.queueFiles()).toEqual([]);
    expect(r.events().filter((e) => e.type === 'send' && e.delivered === 'pane')).toHaveLength(3);
  });

  it('TG-04 negative: the boss\'s messages, rooms and commands are never merged with others', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(boss('alpha', 'boss 1'));
    await r.m.send(send('alpha', 'agent 1'));
    await r.m.send(send('alpha', 'agent 2'));
    await r.m.send(boss('alpha', 'boss 2'));
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    for (let i = 0; i < 4; i++) await r.m.tick();
    expect(r.typed.map((t) => t.text.match(/⟨m:/g)?.length)).toEqual([1, 2, 1]);
    expect(bodies(r.typed)).toEqual(['boss 1', 'agent 1', 'boss 2']);
  });

  it('TG-04 negative: the boss\'s own terminal (`agty send` with no sender) is never merged either', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(send('alpha', 'agent 1'));
    await r.m.send(send('alpha', 'boss from the terminal', false, null)); // source 'cli', no sender
    await r.m.send(send('alpha', 'agent 2'));
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    for (let i = 0; i < 4; i++) await r.m.tick();
    expect(r.typed.map((t) => t.text.match(/⟨m:/g)?.length)).toEqual([1, 1, 1]);
    expect(bodies(r.typed)).toEqual(['agent 1', 'boss from the terminal', 'agent 2']);
  });

  it('a target that never gets ready: retries back off and are reported once (no endless 30 s loop)', async () => {
    const r = rig({ typed: 'notReady' });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    expect(await r.m.send(send('alpha', 'waits'))).toMatchObject({ delivered: 'queued' });
    const tries = () => r.typed.length;
    for (let i = 0; i < 40; i++) {
      r.advance(FAST.retryMs);
      await r.m.tick();
    }
    // 40 pauses of retryMs: doubling pauses (1, 2, 4, 8, 16, capped) leave far fewer attaches.
    expect(tries()).toBeLessThanOrEqual(12);
    expect(tries()).toBeGreaterThan(3);
    expect(r.events().filter((e) => e.type === 'send_stuck')).toEqual([
      expect.objectContaining({ to: 'alpha', misses: 5 }),
    ]);
    // Liveness: it still goes in once the session is ready, and the pause resets.
    r.setResult('typed');
    r.advance(FAST.retryMs * 64);
    await r.m.tick();
    expect(r.queueFiles()).toEqual([]);
  });
});

describe('TOKEN-GUARD liveness: approved work is never capped', () => {
  it('two agents talking at length: every message goes in, nothing is held or refused', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    r.sessions.set('beta', { id: 'b1b2c3d4', status: 'idle' });
    for (let i = 0; i < 100; i++) {
      const [to, from] = i % 2 ? ['alpha', 'beta'] : ['beta', 'alpha'];
      expect(await r.m.send(send(to, `turn ${i}`, false, from))).toMatchObject({ ok: true, delivered: 'pane' });
      r.advance(30_000);
    }
    expect(r.typed).toHaveLength(100);
    expect(r.events().filter((e) => e.type === 'token_guard' || e.type === 'send_stuck')).toEqual([]);
  });

  it('a session busy for hours: its messages just wait (no hold, no drop, no inbox), then go in', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(boss('alpha', 'when you are done'));
    await r.m.send(send('alpha', 'lead → worker: next step'));
    for (let h = 0; h < 6 * 60; h++) {
      r.advance(60_000);
      await r.m.tick();
    }
    expect(r.typed).toEqual([]);
    expect(r.queueFiles()).toHaveLength(2);
    expect(r.inbox('alpha')).toEqual([]);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.tick();
    await r.m.tick();
    expect(bodies(r.typed)).toEqual(['when you are done', 'lead → worker: next step']);
  });
});

// MSG-HOLD2 (10-24 16:57: a deploy restart delivered the original mid-edit) with the owner's
// additions (17:15): the hold is on disk, checked again at the last step, ends only by a decision.
describe('MSG-HOLD2: an edit hold is a decision, not a timer', () => {
  const restartWith = (r: ReturnType<typeof rig>, opts: { held?: () => Promise<boolean> } = {}) => {
    r.m.dispose();
    const typed: string[] = [];
    const m = new Messenger({
      home: r.home,
      engine: { ...r.engine, ...(opts.held && { held: opts.held }) },
      typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed')) },
      events: new EngineEvents(eventsPath(r.home)),
      timing: FAST,
      log: () => undefined,
    });
    m.start();
    cleanup.push(() => m.dispose());
    return { m, typed };
  };
  const queued = async (r: ReturnType<typeof rig>, text: string) => {
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    const q = await r.m.send(boss('alpha', text));
    if (!q.ok || !q.id) throw new Error('not queued');
    return q.id;
  };

  it('held → daemon restart → idle session: not delivered, shown held to every page; an edit saved after the restart goes in', async () => {
    const r = rig();
    const id = await queued(r, 'original');
    expect(r.m.hold('alpha', id, true)).toBe(true);
    const again = restartWith(r);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await again.m.tick();
    await new Promise((x) => setTimeout(x, 100));
    expect(again.typed).toEqual([]);
    expect(again.m.queuedFor('alpha')).toEqual([expect.objectContaining({ id, text: 'original', held: true })]);
    expect(again.m.edit('alpha', id, 'final words')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(again.typed.map((t) => t.split('\n')[1])).toEqual(['final words']));
    expect(again.typed).toHaveLength(1); // the original never, the edit once
  });

  it('a hold stuck after a restart (its page is gone) is resolved by any page: the original approved goes in', async () => {
    const r = rig();
    const id = await queued(r, 'approve me');
    expect(r.m.hold('alpha', id, true)).toBe(true);
    const again = restartWith(r);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await again.m.tick();
    expect(again.typed).toEqual([]);
    expect(again.m.hold('alpha', id, false)).toBe(true); // 원래대로 보내기, from another device
    await vi.waitFor(() => expect(again.typed.map((t) => t.split('\n')[1])).toEqual(['approve me']));
  });

  it('a hold that lands while the messenger waits to type: the last look at the file wins (no send)', async () => {
    const r = rig();
    const id = await queued(r, 'raced');
    let answer: (v: boolean) => void = () => undefined;
    const asked = new Promise<boolean>((res) => (answer = res));
    const again = restartWith(r, { held: () => asked });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    const tick = again.m.tick(); // picked the message, now awaiting engine.held()
    await new Promise((x) => setTimeout(x, 10));
    expect(again.m.hold('alpha', id, true)).toBe(true); // the boss opens it for editing just then
    answer(false);
    await tick;
    expect(again.typed).toEqual([]);
    expect(again.m.queuedFor('alpha')).toEqual([expect.objectContaining({ id, held: true })]);
  });

  it('an edit saved while the messenger waits to type: the edited words go in, never the original', async () => {
    const r = rig();
    const id = await queued(r, 'original');
    let answer: (v: boolean) => void = () => undefined;
    const asked = new Promise<boolean>((res) => (answer = res));
    const again = restartWith(r, { held: () => asked });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    const tick = again.m.tick(); // picked the message, now awaiting engine.held()
    await new Promise((x) => setTimeout(x, 10));
    // The page held it, the boss typed fast and saved: the hold is gone, the file has the new words.
    expect(again.m.hold('alpha', id, true)).toBe(true);
    expect(again.m.edit('alpha', id, 'edited words')).toMatchObject({ ok: true });
    answer(false);
    await tick;
    await vi.waitFor(() => expect(again.typed).toHaveLength(1));
    expect(again.typed[0]).toContain('edited words');
    expect(again.typed[0]).not.toContain('original');
  });

  it('liveness: a held message lets agents\' messages and engine notices past; the boss\'s later words wait behind it', async () => {
    const r = rig();
    const id = await queued(r, 'being edited');
    expect(r.m.hold('alpha', id, true)).toBe(true);
    await r.m.send(send('alpha', 'lead → worker', false, 'beta'));
    await r.m.send({ ...send('alpha', 'engine notice', false, null), source: 'engine' });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    for (let i = 0; i < 3; i++) await r.m.tick();
    const all = r.typed.map((t) => t.text).join('\n');
    expect(all).toContain('lead → worker');
    expect(all).toContain('engine notice');
    expect(all).not.toContain('being edited');
    expect(r.m.queuedFor('alpha')).toEqual([expect.objectContaining({ id, held: true })]);
  });

  it('liveness negative: the boss\'s later words (app or terminal) never pass the held one', async () => {
    const r = rig();
    const id = await queued(r, 'being edited');
    expect(r.m.hold('alpha', id, true)).toBe(true);
    await r.m.send(boss('alpha', 'boss later'));
    await r.m.send(send('alpha', 'boss terminal later', false, null));
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    for (let i = 0; i < 3; i++) await r.m.tick();
    expect(r.typed).toEqual([]);
    expect(r.m.hold('alpha', id, false)).toBe(true); // 원래대로 보내기
    for (let i = 0; i < 4; i++) await r.m.tick();
    await vi.waitFor(() => expect(bodies(r.typed)).toEqual(['being edited', 'boss later', 'boss terminal later']));
  });

  it('a hold asked while the Typist is entering it is refused (it is going in; the page offers a correction)', async () => {
    let release: () => void = () => undefined;
    const r = rig({ type: () => new Promise((res) => (release = () => res('typed'))) });
    const id = await queued(r, 'going in');
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    const tick = r.m.tick();
    await vi.waitFor(() => expect(r.typed).toHaveLength(1));
    expect(r.m.hold('alpha', id, true)).toBe(false);
    expect(r.m.edit('alpha', id, 'too late')).toMatchObject({ ok: false, code: 'typing' });
    release();
    await tick;
    expect(r.m.edit('alpha', id, 'too late')).toMatchObject({ ok: false, code: 'not_queued' });
    expect(r.typed).toHaveLength(1);
  });
});

// S-05 (safety audit 10-24): the compaction nudge belongs to the conversation it was made for. A
// renewal under way (or the session gone) makes it stale: it is dropped, never carried into the
// new conversation, which would be told to renew again.
describe('S-05: a queued compaction nudge does not survive a renewal', () => {
  const nudge = { to: 'alpha', text: 'renew 를 실행하고 턴을 끝내세요', ifIdle: false, from: null, source: 'engine', kind: 'nudge' as const };

  it('renewal under way, the old session stops: the nudge is dropped, not moved to the inbox', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    expect(await r.m.send(nudge)).toMatchObject({ delivered: 'queued' });
    await r.m.send(boss('alpha', 'boss words'));
    r.renewing.add('alpha'); // the agent renewed on its own in that same turn
    await r.m.tick();
    r.sessions.delete('alpha'); // the old conversation is stopped
    await r.m.tick();
    expect(r.readInbox('alpha').map((t) => t.split('\n')[1])).toEqual(['boss words']);
    expect(r.queueFiles()).toEqual([]);
    expect(r.events().filter((e) => e.type === 'token_guard')).toEqual([
      expect.objectContaining({ trigger: 'tick', to: 'alpha', allowed: false, reason: 'stale_nudge' }),
    ]);
  });

  it('negative: without a renewal the nudge goes in as before', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    expect(await r.m.send(nudge)).toMatchObject({ delivered: 'pane' });
    expect(bodies(r.typed)).toEqual(['renew 를 실행하고 턴을 끝내세요']);
  });
});

describe('K1: quiet notices (F-12)', () => {
  const notice = (to: string, text: string, kind: 'action' | 'fyi', from: string | null = null) => ({
    to,
    text,
    ifIdle: false,
    from,
    source: from ? 'codex' : 'engine',
    notice: kind,
  });

  it('an FYI never wakes a resting session (idle or off) and rides in its next paste', async () => {
    const r = rig();
    const wake = vi.fn(() => Promise.resolve(true));
    r.engine.wake = wake;
    // Off: no wake, no inbox; it waits in the queue.
    expect(await r.m.send(notice('alpha', 'limit wait', 'fyi', 'beta'))).toMatchObject({ delivered: 'queued' });
    expect(wake).not.toHaveBeenCalled();
    await r.m.tick();
    expect(r.inbox('alpha')).toEqual([]);
    // Idle: still nothing typed, however long it waits.
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.send(notice('alpha', 'proposal taken', 'fyi'));
    r.advance(10 * 60_000);
    for (let i = 0; i < 3; i++) await r.m.tick();
    expect(r.typed).toEqual([]);
    expect(r.queueFiles()).toHaveLength(2);
    // The next turn an agent starts carries both, after its own message (one paste).
    await r.m.send(send('alpha', 'look at this'));
    await r.m.tick();
    expect(r.typed).toHaveLength(1);
    expect(r.typed[0].text.split('\n')[1]).toBe('look at this');
    expect(r.typed[0].text).toContain('limit wait');
    expect(r.typed[0].text).toContain('proposal taken');
    expect(r.queueFiles()).toEqual([]);
  });

  it('a burst of action-needed notices wakes a resting session once, after the 30 s window', async () => {
    const r = rig({ names: ['alpha', 'beta', 'gamma'] });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    expect(await r.m.send(notice('alpha', 'run 1 done', 'action', 'beta'))).toMatchObject({ delivered: 'queued' });
    r.advance(10_000);
    await r.m.tick();
    await r.m.send(notice('alpha', 'run 2 done', 'action', 'gamma'));
    await r.m.send(notice('alpha', 'approval answered', 'action'));
    await r.m.send(notice('alpha', 'fyi too', 'fyi'));
    r.advance(19_000);
    await r.m.tick();
    expect(r.typed).toEqual([]); // still inside the window
    r.advance(1_000);
    await r.m.tick();
    await r.m.tick();
    expect(r.typed).toHaveLength(1);
    expect(r.typed[0].text.match(/⟨m:[a-z2-7]{8}⟩/g)).toHaveLength(4);
    expect(r.queueFiles()).toEqual([]);
  });

  it('nothing is lost across a daemon restart: the window and the FYI come back from the queue', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.send(notice('alpha', 'fyi before', 'fyi'));
    await r.m.send(notice('alpha', 'decide this', 'action', 'beta'));
    r.m.dispose();
    const typed: string[] = [];
    let now = Date.parse('2026-10-21T23:05:00+09:00');
    const again = new Messenger({
      home: r.home,
      engine: r.engine,
      typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed' as const)) },
      events: new EngineEvents(eventsPath(r.home)),
      timing: FAST,
      now: () => now,
      log: () => undefined,
    });
    again.start();
    cleanup.push(() => again.dispose());
    expect(again.queued.map((q) => q.notice)).toEqual(['fyi', 'action']);
    await again.tick();
    expect(typed).toEqual([]);
    now += 30_000;
    await again.tick();
    expect(typed).toHaveLength(1);
    expect(typed[0].split('\n')[1]).toBe('decide this');
    expect(typed[0]).toContain('fyi before');
  });

  it('negative control: the owner\'s words ignore a notice class: typed at once, and they wake', async () => {
    const r = rig();
    const wake = vi.fn(() => {
      r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
      return Promise.resolve(true);
    });
    r.engine.wake = wake;
    expect(await r.m.send({ ...boss('alpha', 'do it'), notice: 'fyi' as const })).toMatchObject({ delivered: 'pane' });
    expect(wake).toHaveBeenCalledOnce();
    expect(r.m.queued).toEqual([]);
    // A plain agent message (no class) is typed at once too, as before K1.
    await r.m.send(send('alpha', 'plain'));
    expect(bodies(r.typed)).toEqual(['do it', 'plain']);
  });
});

describe('ROOM-MODES: a room 공지 rides with the member\'s next message', () => {
  const group = { roomId: 'room0001', roomName: '출시팀', messageId: 'post0001' };
  const notice = (to: string, text: string, from: string | null = null) => ({
    to,
    text,
    ifIdle: false,
    from,
    source: from ? 'mcp' : 'messenger:mac',
    group,
    notice: 'fyi' as const,
  });
  const turn = (text: string) =>
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-21T14:06:00Z', message: { content: `<pasted_content id="p1">\n${text}\n</pasted_content id="p1">` } });

  it('queues, wakes nobody, then goes after the owner\'s words; the DM view cuts it', async () => {
    const ledger = new TurnLedger();
    const r = rig({ ledger });
    const wake = vi.fn(() => Promise.resolve(true));
    r.engine.wake = wake;
    expect(await r.m.send(notice('alpha', '배포는 3시'))).toMatchObject({ delivered: 'queued' });
    expect(wake).not.toHaveBeenCalled();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    r.advance(10 * 60_000);
    for (let i = 0; i < 3; i++) await r.m.tick();
    expect(r.typed).toEqual([]);
    expect(r.m.queuedFor('alpha')).toEqual([]); // never in the DM's waiting list
    // The owner's next words: first, under their own header and mark; the 공지 after the line.
    await r.m.send(boss('alpha', '지금 확인해줘'));
    await r.m.tick();
    expect(r.typed).toHaveLength(1);
    const [own, , ...tail] = r.typed[0].text.split('\n');
    expect(own).toMatch(/^\[사장 · 메신저 · .*\] ⟨m:[a-z2-7]{8}⟩$/);
    expect(r.typed[0].text.split('\n')[1]).toBe('지금 확인해줘');
    expect(tail[1]).toBe(ROOM_NOTICE_LINE);
    expect(tail[2]).toMatch(/^\[사장 · 단톡방 '출시팀' · .*\] ⟨m:[a-z2-7]{8}⟩$/);
    expect(tail[3]).toBe('배포는 3시');
    expect(r.queueFiles()).toEqual([]);
    // The DM shows the owner's words and the reply, bound to the owner's message, not the 공지.
    const ownId = / ⟨m:([a-z2-7]{8})⟩/.exec(own)![1];
    const f = new RoomTurnFilter({ classify: (id) => ledger.classify(id) });
    expect(f.items(turn(r.typed[0].text)).map((i) => [i.text, i.messageId])).toEqual([['지금 확인해줘', ownId]]);
    expect(f.room).toBeNull();
    const reply = f.items(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '네' }] } }));
    expect(reply.map((i) => [i.text, i.messageId])).toEqual([['네', ownId]]);
    // Nobody can forge the line to hide words from the DM: a body never carries our `⟨`.
    expect(messageOf({ v: 1, created: 1, ...send('alpha', `숨김\n\n${ROOM_NOTICE_LINE}\n비밀`) })).not.toContain(ROOM_NOTICE_LINE);
  });

  it('never rides with a Task hand-over, a reply or a tagged post; a held badge ignores it', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(notice('alpha', '공지 기다림'));
    await r.m.send({ ...send('alpha', '이 Task 해줘'), task: 'T-1' });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.tick();
    expect(r.typed).toHaveLength(1);
    expect(r.typed[0].text).not.toContain('공지 기다림');
    expect(r.m.queued.map((q) => q.text)).toEqual(['공지 기다림']);
    r.blocked.add('alpha');
    await r.m.send(boss('alpha', '막힘'));
    r.advance(60_000);
    await r.m.tick();
    expect(r.m.held('alpha')).toBe(true);
    r.blocked.delete('alpha');
    r.advance(60_000);
    await r.m.tick();
    expect(r.typed.at(-1)!.text).toContain('공지 기다림'); // the owner's words carried it
    expect(r.m.held('alpha')).toBe(false);
  });

  it('a 공지 of a deleted room (or one its member left) is dropped, not delivered', async () => {
    const r = rig();
    // the rig has no option for it: a messenger of its own over the rig's home
    r.m.dispose();
    const typed: string[] = [];
    const m = new Messenger({ home: r.home, engine: r.engine, typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed' as const)) }, events: new EngineEvents(eventsPath(r.home)), timing: FAST, log: () => undefined, noticeLive: () => false });
    cleanup.push(() => m.dispose());
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await m.send(notice('alpha', '지운 방 공지'));
    await m.send(send('alpha', '안녕'));
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await m.tick();
    expect(m.queued).toEqual([]);
    expect(typed).toHaveLength(1);
    expect(typed[0]).not.toContain('지운 방 공지');
  });

  it('the DM keeps whatever Claude Code joins after a 공지 tail (a message, typing, a task notice)', () => {
    const at = Date.parse('2026-11-01T10:57:00');
    const owner = (text: string, messageId: string): QueuedSend => ({ v: 1, to: 'a', text, from: null, source: 'messenger:x', ifIdle: false, created: at, messageId });
    const a = pasteOf([owner('첫 말', 'aaaaaaaa'), { ...owner('공지 본문', 'nnnnnnnn'), group, notice: 'fyi' }]);
    const b = pasteOf([owner('둘째 말', 'bbbbbbbb')]);
    const wrap = (t: string, id: string) => `<pasted_content id="${id}">\n${t}\n</pasted_content id="${id}">`;
    const rec = (content: string) => JSON.stringify({ type: 'user', uuid: 'abcdef12', timestamp: '2026-11-01T01:58:00Z', message: { content } });
    const texts = (c: string) => lineItems(rec(c)).map((i) => i.text);
    for (const c of [`${a}\n\n${b}`, `${a}\n${b}`, `${wrap(a, 'p1')}\n${wrap(b, 'p2')}`])
      expect(texts(c)).toEqual(['첫 말', '둘째 말']);
    expect(texts(`${a}\n\n직접 친 말`)).toEqual(['첫 말', '직접 친 말']);
    expect(texts(`${a}\n<task-notification>\n<summary>done</summary>\n</task-notification>`)).toEqual(['첫 말', '**done**']);
    expect(texts(a)).toEqual(['첫 말']);
  });

  it('rides with an agent\'s message, never with a command; a tagged post still wakes', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy' });
    await r.m.send(notice('alpha', '공지 하나', 'beta'));
    await r.m.send(notice('alpha', '공지 둘\n\n둘째 줄'));
    await r.m.send({ ...boss('alpha', '/compact'), raw: true });
    await r.m.send(send('alpha', '이거 봐'));
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.tick();
    await r.m.tick();
    expect(r.typed.map((t) => t.text.includes(ROOM_NOTICE_LINE))).toEqual([false, true]);
    expect(r.typed[0].text).toBe('/compact');
    // Both 공지 in one tail, one line apart (a blank line in a body is closed up).
    expect(r.typed[1].text.split(`${ROOM_NOTICE_LINE}\n`)[1].split('\n').filter((l) => !/^[[⟨]/.test(l))).toEqual([
      '공지 하나',
      '공지 둘',
      '둘째 줄',
    ]);
    expect(r.queueFiles()).toEqual([]);
    // A tagged post is typed at once (it wakes), as before.
    const tagged = await r.m.send({ ...boss('alpha', '@alpha 지금'), group, messageId: newMessageId() });
    expect(tagged).toMatchObject({ delivered: 'pane' });
  });
});

describe('MSG-RECALL: a delivery whose prompt is not its own (11-01 14:51)', () => {
  const parseMark = (text: string) => /⟨m:([a-z2-7]{8})⟩/.exec(text)![1];
  const userTurn = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

  it('lost once: told and tried once more; lost again: 전달 실패 (failed) until 다시 보내기, never 대기 중 forever', async () => {
    const r = rig({ typed: 'lost' });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    const sent = await r.m.send(boss('alpha', '새 메시지'));
    expect(sent).toMatchObject({ ok: true, delivered: 'queued' });
    expect(r.typed).toHaveLength(1);
    expect(r.m.queuedFor('alpha')).toEqual([expect.not.objectContaining({ failed: true })]);
    r.advance(FAST.retryMs * 2);
    await r.m.tick();
    expect(r.typed).toHaveLength(2); // the one retry
    expect(r.events().filter((e) => e.type === 'send_lost').map((e) => e.again)).toEqual([true, false]);
    expect(r.m.queuedFor('alpha')).toEqual([expect.objectContaining({ failed: true })]);
    // It is not typed again by itself...
    for (let i = 0; i < 5; i++) {
      r.advance(FAST.retryMs * 8);
      await r.m.tick();
    }
    expect(r.typed).toHaveLength(2);
    // ...and survives a restart as failed (the queue file says so).
    expect(parseQueued(fs.readFileSync(path.join(r.m.queueDir, r.queueFiles()[0]), 'utf-8'))?.failed).toBe(true);
    // 다시 보내기 (the 지금 보내기 request) sends it again as it was, with no miss pause first
    // (the clock stands still from here: a pause left in place would hold it).
    r.setResult('typed');
    expect(r.m.promote('alpha', r.m.queuedFor('alpha')[0].id)).toMatchObject({ ok: true });
    for (let i = 0; i < 100 && r.queueFiles().length; i++) await new Promise((res) => setTimeout(res, 5));
    expect(r.typed).toHaveLength(3);
    expect(r.queueFiles()).toEqual([]);
  });

  it('다시 보내기 right after the second loss goes at once: the miss pause (60 s by then) is cleared', async () => {
    const r = rig({ typed: 'lost', timing: { retryMs: 30_000 } });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.send(boss('alpha', '두 번 엇갈린 메시지'));
    r.advance(30_000);
    await r.m.tick();
    expect(r.m.queuedFor('alpha')).toEqual([expect.objectContaining({ failed: true })]);
    r.setResult('typed');
    expect(r.m.promote('alpha', r.m.queuedFor('alpha')[0].id)).toMatchObject({ ok: true });
    for (let i = 0; i < 100 && r.queueFiles().length; i++) await new Promise((res) => setTimeout(res, 5));
    expect(r.typed).toHaveLength(3);
    expect(r.queueFiles()).toEqual([]);
  });

  it('unconfirmed (Enter went in while the session works): confirmed by its mark at the turn end, never typed twice', async () => {
    const transcript = (r: ReturnType<typeof rig>) => path.join(r.home, 't.jsonl');
    const r: ReturnType<typeof rig> = rig({ typed: 'unconfirmed' });
    fs.writeFileSync(transcript(r), `${PROMPT}\n${TURN_END}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript: transcript(r) });
    expect(await r.m.send(boss('alpha', '바쁠 때 들어간 메시지'))).toMatchObject({ delivered: 'queued' });
    // A task notification's turn took the session; ours waits in Claude's queue.
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript: transcript(r) });
    fs.appendFileSync(transcript(r), `${JSON.stringify({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'n' } })}\n${TOOL_CALL}\n`);
    for (let i = 0; i < 3; i++) {
      r.advance(FAST.retryMs * 4);
      await r.m.tick();
    }
    expect(r.typed).toHaveLength(1);
    // It cannot be cancelled meanwhile: it is in Claude's hands.
    expect(r.m.queuedFor('alpha')).toHaveLength(1);
    // The turn ends and Claude takes ours: its mark settles it.
    fs.appendFileSync(transcript(r), `${TURN_END}\n${userTurn(r.typed[0].text)}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript: transcript(r) });
    await r.m.tick();
    expect(r.queueFiles()).toEqual([]);
    expect(r.typed).toHaveLength(1);
    expect(r.events().filter((e) => e.type === 'send_lost')).toEqual([]);
  });

  it('unconfirmed with no mark once the turn has been over a while: lost (told, tried once more)', async () => {
    const transcript = (r: ReturnType<typeof rig>) => path.join(r.home, 't.jsonl');
    const r: ReturnType<typeof rig> = rig({ typed: 'unconfirmed' });
    fs.writeFileSync(transcript(r), `${PROMPT}\n${TURN_END}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript: transcript(r) });
    await r.m.send(boss('alpha', '사라진 메시지'));
    await r.m.tick(); // the turn is over: seen once, not yet lost (Claude writes a queued prompt as it takes it)
    expect(r.events().filter((e) => e.type === 'send_lost')).toEqual([]);
    r.advance(FAST.quietMs);
    await r.m.tick();
    expect(r.events().filter((e) => e.type === 'send_lost').map((e) => e.again)).toEqual([true]);
    r.setResult('typed');
    r.advance(FAST.retryMs * 2);
    await r.m.tick();
    expect(r.typed).toHaveLength(2);
    expect(r.queueFiles()).toEqual([]);
  });

  it('지금 보내기 on a message waiting for the input box: delivered without the box check; the wait says why after 2 min', async () => {
    const r = rig();
    const calls: Array<{ force?: boolean }> = [];
    r.engine.deliver = (_name, _text, o) => {
      calls.push({ ...(o.force && { force: true }) });
      return Promise.resolve(o.force ? 'typed' : 'inputBusy');
    };
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    expect(await r.m.send(boss('alpha', '입력칸 대기'))).toMatchObject({ delivered: 'queued' });
    expect(r.m.queuedFor('alpha')).toEqual([expect.objectContaining({ inputWait: true })]);
    expect(r.m.queuedFor('alpha')[0].inputWaitLong).toBeUndefined();
    r.advance(2 * 60_000);
    expect(r.m.queuedFor('alpha')).toEqual([expect.objectContaining({ inputWait: true, inputWaitLong: true })]);
    expect(r.m.promote('alpha', r.m.queuedFor('alpha')[0].id)).toMatchObject({ ok: true });
    for (let i = 0; i < 100 && r.queueFiles().length; i++) await new Promise((res) => setTimeout(res, 5));
    expect(calls).toEqual([{}, { force: true }]);
    expect(r.queueFiles()).toEqual([]);
  });

  it("TYPIST-STALE: 지금 보내기 on the boss's message behind an engine message the box holds back: the pressed one goes in first, with force, then the rest", async () => {
    const r = rig();
    const calls: Array<[string, boolean]> = [];
    let busy = true; // a draft in the box, until a forced paste takes it along
    r.engine.deliver = (_name, text, o) => {
      calls.push([text.split('\n').at(-1)!, !!o.force]);
      if (o.force) busy = false;
      return Promise.resolve(o.force || !busy ? 'typed' : 'inputBusy');
    };
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.send({ ...send('alpha', 'engine notice', false, null), source: 'engine' });
    expect(await r.m.send(boss('alpha', '사장 말'))).toMatchObject({ delivered: 'queued' });
    expect(r.m.queuedFor('alpha')).toEqual([expect.objectContaining({ text: '사장 말', inputWait: true })]);
    expect(calls).toEqual([['engine notice', false]]);
    expect(r.m.promote('alpha', r.m.queuedFor('alpha')[0].id)).toMatchObject({ ok: true });
    for (let i = 0; i < 100 && r.queueFiles().length; i++) await new Promise((res) => setTimeout(res, 5));
    r.advance(FAST.retryMs * 2);
    await r.m.tick();
    expect(calls.slice(1)).toEqual([['사장 말', true], ['engine notice', false]]);
    expect(r.queueFiles()).toEqual([]);
  });

  it("TYPIST-STALE: 지금 보내기 (force) on a message the box held back does not skip the already-typed check: the owner's own Enter put it in meanwhile", async () => {
    const r = rig();
    const transcript = path.join(r.home, 't.jsonl');
    fs.writeFileSync(transcript, `${PROMPT}\n${TURN_END}\n`);
    const calls: Array<{ force?: boolean }> = [];
    r.engine.deliver = (_name, _text, o) => {
      calls.push({ ...(o.force && { force: true }) });
      return Promise.resolve('inputBusy');
    };
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript });
    const sent = await r.m.send(boss('alpha', '입력칸 대기'));
    if (!sent.ok || !sent.messageId) throw new Error('not queued');
    expect(calls).toEqual([{}]);
    // Our unsubmitted paste sat in the box; the owner pressed Enter at the terminal, then 지금 보내기 in the app.
    const item = parseQueued(fs.readFileSync(path.join(r.m.queueDir, r.queueFiles()[0]), 'utf-8'))!;
    fs.appendFileSync(transcript, `${userTurn(messageOf(item))}\n${TURN_END}\n`);
    expect(r.m.promote('alpha', r.m.queuedFor('alpha')[0].id)).toMatchObject({ ok: true });
    for (let i = 0; i < 100 && r.queueFiles().length; i++) await new Promise((res) => setTimeout(res, 5));
    expect(calls).toEqual([{}]); // never typed again, forced or not
    expect(r.queueFiles()).toEqual([]);
    expect(r.events().filter((e) => e.type === 'token_guard')).toEqual([
      expect.objectContaining({ trigger: 'tick', to: 'alpha', messageId: sent.messageId, allowed: false, reason: 'already_typed' }),
    ]);
  });

  /** Claude Code 2.1.316's record of a prompt a busy session took mid-turn (no `user` record);
   *  `humanTurn` comes only under its remote flag tengu_parsed_willow. */
  const queuedTurn = (prompt: string, humanTurn = true) =>
    [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-01T05:51:23.000Z', sessionId: 's', content: prompt }),
      JSON.stringify({
        parentUuid: 'p',
        isSidechain: false,
        attachment: { type: 'queued_command', prompt, source_uuid: 'x', delivery_id: 'd', commandMode: 'prompt', origin: { kind: 'human' }, ...(humanTurn && { humanTurn }) },
        type: 'attachment',
        uuid: 'q1',
        timestamp: '2026-11-01T05:51:30.000Z',
        renderedRole: 'system',
      }),
    ].join('\n');

  it('a busy session takes ours mid-turn (an attachment queued_command, no user record): delivered once, never typed again', async () => {
    const transcript = (r: ReturnType<typeof rig>) => path.join(r.home, 't.jsonl');
    const r: ReturnType<typeof rig> = rig({ typed: 'unconfirmed' });
    fs.writeFileSync(transcript(r), `${PROMPT}\n${TOOL_CALL}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript: transcript(r) });
    expect(await r.m.send(boss('alpha', '바쁠 때 보낸 말', true))).toMatchObject({ delivered: 'queued' });
    // Its next tool step picks it up, then the turn goes on and ends.
    fs.appendFileSync(transcript(r), `${TOOL_RESULT}\n${queuedTurn(r.typed[0].text)}\n${TOOL_CALL}\n${TOOL_RESULT}\n${TURN_END}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript: transcript(r) });
    for (let i = 0; i < 4; i++) {
      r.advance(FAST.quietMs + FAST.retryMs * 4);
      await r.m.tick();
    }
    expect(r.typed).toHaveLength(1);
    expect(r.queueFiles()).toEqual([]);
    expect(r.events().filter((e) => e.type === 'send_lost')).toEqual([]);
    // After a restart the queue check reads it so too.
    expect(alreadyTyped(fs.readFileSync(transcript(r), 'utf-8'), parseMark(r.typed[0].text))).toBe(true);
  });

  it('the same queued_command without humanTurn (its remote flag off) still confirms; a task notification never does', async () => {
    const transcript = (r: ReturnType<typeof rig>) => path.join(r.home, 't.jsonl');
    const r: ReturnType<typeof rig> = rig({ typed: 'unconfirmed' });
    fs.writeFileSync(transcript(r), `${PROMPT}\n${TOOL_CALL}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript: transcript(r) });
    await r.m.send(boss('alpha', '플래그 꺼진 때', true));
    const id = parseMark(r.typed[0].text);
    const notice = JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: `x ⟨m:${id}⟩` } });
    expect(alreadyTyped(notice, id)).toBe(false);
    fs.appendFileSync(transcript(r), `${TOOL_RESULT}\n${queuedTurn(r.typed[0].text, false)}\n${TURN_END}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript: transcript(r) });
    for (let i = 0; i < 4; i++) {
      r.advance(FAST.quietMs + FAST.retryMs * 4);
      await r.m.tick();
    }
    expect(r.typed).toHaveLength(1);
    expect(r.queueFiles()).toEqual([]);
    expect(r.events().filter((e) => e.type === 'send_lost')).toEqual([]);
  });

  it('an unconfirmed paste never confirmed (no status, no transcript yet): taken as delivered after 10 minutes, the session free again', async () => {
    const r = rig({ typed: 'unconfirmed' });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.send(boss('alpha', '확인 안 되는 메시지', true));
    // Then its session file says nothing and its transcript is not there yet.
    r.sessions.set('alpha', { id: 'a1b2c3d4' });
    await r.m.send(boss('alpha', '그 다음 메시지', true));
    for (let i = 0; i < 3; i++) {
      r.advance(60_000);
      await r.m.tick();
    }
    expect(r.typed).toHaveLength(1); // the next waits behind it, even once the session is idle
    r.setResult('typed');
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.tick();
    expect(r.typed).toHaveLength(1);
    r.sessions.set('alpha', { id: 'a1b2c3d4' });
    r.advance(10 * 60_000);
    await r.m.tick(); // settled at the cap
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.tick();
    expect(r.typed).toHaveLength(2); // the first settled as delivered (not typed again), the next went in
    expect(r.queueFiles()).toEqual([]);
    expect(r.events().filter((e) => e.type === 'send_lost')).toEqual([]);
  });

  it('a 지금 보내기 that found the session not ready keeps its force for the next try', async () => {
    const r = rig();
    const calls: Array<{ force?: boolean }> = [];
    let busyOnce = true;
    r.engine.deliver = (_name, _text, o) => {
      calls.push({ ...(o.force && { force: true }) });
      if (!o.force) return Promise.resolve('inputBusy');
      if (busyOnce) {
        busyOnce = false;
        return Promise.resolve('notReady');
      }
      return Promise.resolve('typed');
    };
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.send(boss('alpha', '입력칸 대기'));
    r.m.promote('alpha', r.m.queuedFor('alpha')[0].id);
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((res) => setTimeout(res, 5));
    r.advance(FAST.retryMs * 4);
    await r.m.tick();
    expect(calls).toEqual([{}, { force: true }, { force: true }]);
    expect(r.queueFiles()).toEqual([]);
  });

  it('lost, but it did arrive after all: the retry finds its mark and types nothing twice', async () => {
    const transcript = (r: ReturnType<typeof rig>) => path.join(r.home, 't.jsonl');
    const r: ReturnType<typeof rig> = rig({
      type: (_id, text) => {
        fs.appendFileSync(transcript(r), `${userTurn(text)}\n${TURN_END}\n`); // it went in, late
        return Promise.resolve('lost');
      },
    });
    fs.writeFileSync(transcript(r), `${PROMPT}\n${TURN_END}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript: transcript(r) });
    expect(await r.m.send(boss('alpha', '한 번만'))).toMatchObject({ delivered: 'queued' });
    r.advance(FAST.retryMs * 2);
    await r.m.tick();
    expect(r.typed).toHaveLength(1);
    expect(r.queueFiles()).toEqual([]);
  });

  it('a draft or a recalled prompt in the box: the message waits (inputWait), with no miss counted, then goes in', async () => {
    const r = rig({ typed: 'inputBusy' });
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    expect(await r.m.send(boss('alpha', '기다릴 메시지'))).toMatchObject({ delivered: 'queued' });
    expect(r.m.queuedFor('alpha')).toEqual([expect.objectContaining({ inputWait: true })]);
    for (let i = 0; i < 6; i++) {
      r.advance(FAST.retryMs);
      await r.m.tick();
    }
    // A fixed pause, never the miss backoff or its stuck report: the owner's box is no stuck session.
    expect(r.typed).toHaveLength(7);
    expect(r.events().filter((e) => e.type === 'send_stuck')).toEqual([]);
    r.setResult('typed');
    r.advance(FAST.retryMs);
    await r.m.tick();
    expect(r.queueFiles()).toEqual([]);
    expect(r.m.queuedFor('alpha')).toEqual([]);
  });
});

describe('TYPIST-STALE: stale input, piled notices and a queue that waits past the turn (11-04 laptop)', () => {
  const REVIVE = '[agty 자동 복구 · ';

  it('a new revive notice replaces one still waiting in the inbox; other inbox files stay (negative: without replaces both pile up)', () => {
    const r = rig();
    expect(r.m.writeInbox('alpha', `${REVIVE}11-02 20:37] 다시 띄웠다.`, REVIVE)).toBe(true);
    expect(r.m.writeInbox('alpha', '[사장 · 메신저 · 10-28 21:38] ⟨m:z44duxtf⟩\n안뇽')).toBe(true);
    expect(r.m.writeInbox('alpha', `${REVIVE}11-03 09:51] 다시 띄웠다.`, REVIVE)).toBe(true);
    expect(r.readInbox('alpha')).toEqual([
      '[사장 · 메신저 · 10-28 21:38] ⟨m:z44duxtf⟩\n안뇽',
      `${REVIVE}11-03 09:51] 다시 띄웠다.`,
    ]);
    r.m.writeInbox('beta', `${REVIVE}a]`);
    r.m.writeInbox('beta', `${REVIVE}b]`);
    expect(r.readInbox('beta')).toHaveLength(2);
  });

  it('a revive notice a start already queued is replaced too; the other inbox messages it held go with the next start', () => {
    const r = rig();
    const queued = () => r.queueFiles().map((f) => (JSON.parse(fs.readFileSync(path.join(r.m.queueDir, f), 'utf-8')) as { text: string }).text);
    r.m.writeInbox('alpha', `${REVIVE}11-02 20:37] 다시 띄웠다.`, REVIVE);
    r.m.writeInbox('alpha', '[사장 · 메신저 · 10-28 21:38] ⟨m:z44duxtf⟩\n안뇽');
    r.m.deliverInbox('alpha'); // the start that died before its first prompt went in
    expect(queued()).toHaveLength(1);
    r.m.writeInbox('alpha', `${REVIVE}11-03 09:51] 다시 띄웠다.`, REVIVE);
    expect(queued()).toEqual([]);
    r.m.deliverInbox('alpha');
    expect(queued()).toEqual([`[사장 · 메신저 · 10-28 21:38] ⟨m:z44duxtf⟩\n안뇽\n\n${REVIVE}11-03 09:51] 다시 띄웠다.`]);
  });

  it('a message held back by the input box goes as soon as that box went in and its turn ended, not after the pause', async () => {
    const r = rig({ timing: { retryMs: 60 * 60_000 } });
    const file = path.join(r.home, 't.jsonl');
    fs.writeFileSync(file, `${PROMPT}\n${TURN_END}\n`);
    const calls: string[] = [];
    let result: TypeResult = 'inputBusy';
    r.engine.deliver = (_name, text) => {
      calls.push(text);
      return Promise.resolve(result);
    };
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript: file });
    await r.m.send(boss('alpha', 'ㅎㅇ')); // its try finds the box taken
    expect(calls).toHaveLength(1);
    // Negative control: nothing went in, so the pause holds.
    await r.m.tick();
    expect(calls).toHaveLength(1);
    // The stale draft is submitted, its turn runs (busy) and ends: ours goes at once.
    fs.appendFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u2', message: { content: '묵은 글' } })}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'busy', transcript: file });
    await r.m.tick();
    expect(calls).toHaveLength(1); // its turn is running
    fs.appendFileSync(file, `${TURN_END}\n`);
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle', transcript: file });
    result = 'typed';
    await r.m.tick();
    expect(calls).toHaveLength(2);
    expect(r.queueFiles()).toEqual([]);
  });

  it('no earlier pastes go to the provider (MSG-RECALL); one left unsubmitted is told, tried again, then shown failed with its own notice', async () => {
    const r = rig();
    const seen: Array<string[] | undefined> = [];
    let result: TypeResult = 'typed';
    r.engine.deliver = (_name, _text, o) => {
      seen.push((o as { earlier?: string[] }).earlier);
      return Promise.resolve(result);
    };
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    await r.m.send(boss('alpha', '첫 말'));
    result = 'unsubmitted';
    await r.m.send(boss('alpha', '둘째 말'));
    expect(seen).toEqual([undefined, undefined]);
    r.advance(FAST.retryMs * 4);
    await r.m.tick();
    const lost = r.events().filter((e) => e.type === 'send_lost');
    expect(lost.map((e) => [e.again, e.unsubmitted])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(r.m.queuedFor('alpha')).toEqual([expect.objectContaining({ failed: true })]);
  });
});

describe('REPLY-FULL: a reply quotes the original whole when the agent no longer has it', () => {
  const reply = { id: 'aaaaaaaa', text: '원래 메시지 첫 줄' };
  const quoted = (r: ReturnType<typeof rig>) => r.typed.at(-1)!.text.split('\n')[1];

  it('old (session start or compaction): the whole text; recent or unknown: the short quote; gone: marked', async () => {
    const r = rig();
    r.sessions.set('alpha', { id: 'a1b2c3d4', status: 'idle' });
    let found: 'recent' | 'missing' | { text: string } | null = { text: '원래 메시지 첫 줄\n둘째 줄 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    r.engine.replied = () => Promise.resolve(found);
    await r.m.send({ ...boss('alpha', '답'), replyTo: reply });
    expect(quoted(r)).toMatch(/^> 사장: 원래 메시지 첫 줄 ⏎ 둘째 줄 /);
    expect(quoted(r)).not.toContain('AAAAAAAAAAAAAAAAAAAA'); // masked like the app's quote
    for (const [state, line] of [
      ['recent', '> 사장: 원래 메시지 첫 줄'],
      [null, '> 사장: 원래 메시지 첫 줄'],
      ['missing', '> 사장: 원래 메시지 첫 줄 (원문 없음)'],
    ] as const) {
      found = state;
      await r.m.send({ ...boss('alpha', '답'), replyTo: reply });
      expect(quoted(r)).toBe(line);
    }
  });

  it('a whole quote stops at 1,000 characters and says how long the original was', () => {
    const long = '가'.repeat(1500);
    const q = fullQuote('사장', long);
    expect(q).toBe(`> 사장: ${'가'.repeat(1000)}… (원문 1500자 중 1000자)`);
    expect(fullQuote('사장', '가'.repeat(1000))).toBe(`> 사장: ${'가'.repeat(1000)}`);
  });
});
