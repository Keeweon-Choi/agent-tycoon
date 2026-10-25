/**
 * U-48 phase 1: the status table, ids, limits, masking, unknown and broken
 * formats, the mtime cache, read-only behaviour and "no viewer, no read".
 * Every file below is invented text in the shapes the design lists.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrackedItems } from '../../../../core/src/messages.js';
import type { AgentEntry } from '../providers/types.js';
import { TrackingFeed } from './feed.js';
import { parseListFile, parseProgress, progressStatus, TITLE_MAX, titleOf } from './parse.js';
import {
  CODEX_MAX,
  ENDED_FOLD_MS,
  MORE_AFTER,
  SESSIONS_MAX,
  Tracker,
  type TrackSession,
} from './tracker.js';

const DAY = 86_400_000;
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-track-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const sid = (n: number) => `s${String(n).padStart(7, '0')}-aaaa`;
const listDir = (s: string) => path.join(home, '.claude', 'tasks', s);
function writeTask(s: string, id: string, f: Record<string, unknown>, mtime?: number) {
  fs.mkdirSync(listDir(s), { recursive: true });
  const file = path.join(listDir(s), `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, description: 'never shown', blocks: [], blockedBy: [], ...f }));
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}
const session = (n: number, o: Partial<TrackSession> = {}): TrackSession => ({
  sessionId: sid(n),
  name: `agent ${n}`,
  project: 'alpha',
  live: true,
  busy: false,
  ...o,
});
const NOW = Date.now();
const items = (t: Tracker, sessions: TrackSession[], codex: Parameters<Tracker['refresh']>[0]['codex'] = []) =>
  t.refresh({ sessions, codex, now: NOW }).get('alpha')?.items ?? [];
const byTitle = (list: ReturnType<typeof items>, title: string) => list.find((i) => i.title === title);

describe('status table (design §4)', () => {
  it('Claude list words: reported, deleted hidden, unknown words kept as unknown with the raw word', () => {
    writeTask(sid(1), '1', { subject: 'pend', status: 'pending' });
    writeTask(sid(1), '2', { subject: 'run', status: 'in_progress' });
    writeTask(sid(1), '3', { subject: 'fin', status: 'completed' });
    writeTask(sid(1), '4', { subject: 'gone', status: 'deleted' });
    writeTask(sid(1), '5', { subject: 'odd', status: 'parked' });
    const list = items(new Tracker(home), [session(1)]);
    expect(list.filter((i) => i.kind === 'agentList').map((i) => [i.title, i.status, i.source, i.rawStatus])).toEqual([
      ['pend', 'todo', 'reported', 'pending'],
      ['run', 'doing', 'reported', 'in_progress'],
      ['odd', 'unknown', 'reported', 'parked'],
      ['fin', 'done', 'reported', 'completed'],
    ]);
    expect(list.find((i) => i.kind === 'agentList')?.reporter).toBe('agent 1');
  });

  it('a task waiting on an unfinished one is blocked, and that is inferred, not reported', () => {
    writeTask(sid(1), '1', { subject: 'first', status: 'in_progress' });
    writeTask(sid(1), '2', { subject: 'second', status: 'pending', blockedBy: ['1'] });
    writeTask(sid(1), '3', { subject: 'third', status: 'pending', blockedBy: ['9'] }); // 9 does not exist
    writeTask(sid(1), '4', { subject: 'fourth', status: 'pending', blockedBy: ['5'] });
    writeTask(sid(1), '5', { subject: 'fifth', status: 'completed' });
    const list = items(new Tracker(home), [session(1)]);
    const pick = (t: string) => byTitle(list, t)!;
    expect([pick('second').status, pick('second').source]).toEqual(['blocked', 'inferred']);
    expect(pick('third').status).toBe('todo');
    expect(pick('fourth').status).toBe('todo');
  });

  it('a session is observed: working = doing, resting = review, no word = unknown, gone = unknown and ended', () => {
    const t = new Tracker(home);
    const sessions = [session(1, { busy: true }), session(2, { busy: false }), session(3, { busy: null })];
    const rows = Object.fromEntries(items(t, sessions).filter((i) => i.kind === 'session').map((i) => [i.ref, [i.status, i.source, i.ended]]));
    expect(rows[sid(1).slice(0, 8)]).toEqual(['doing', 'observed', undefined]);
    expect(rows[sid(2).slice(0, 8)]).toEqual(['review', 'observed', undefined]);
    expect(rows[sid(3).slice(0, 8)]).toEqual(['unknown', 'observed', undefined]);
    // Session 2 ends while the tracker watches; it has a fresh list, so its card stays as ended.
    writeTask(sid(2), '1', { subject: 'left over', status: 'pending' });
    const after = items(t, [session(1, { busy: true })]);
    const ended = after.find((i) => i.key === `session:${sid(2)}`);
    expect(ended).toMatchObject({ status: 'unknown', source: 'observed', ended: true });
  });

  it('Codex checklist: [x] reported; the first open box is doing (inferred) while the run goes, else blocked (observed)', () => {
    expect(progressStatus('x', false, false, 'running')).toMatchObject({ status: 'done', source: 'reported' });
    expect(progressStatus(' ', true, false, 'running')).toMatchObject({ status: 'doing', source: 'inferred' });
    expect(progressStatus(' ', false, false, 'running')).toMatchObject({ status: 'todo', source: 'reported' });
    expect(progressStatus(' ', true, false, 'stopped')).toMatchObject({ status: 'blocked', source: 'observed', raw: 'stopped' });
    expect(progressStatus(' ', true, false, 'limit')).toMatchObject({ status: 'blocked', source: 'observed' });
    expect(progressStatus(' ', true, true, 'done')).toMatchObject({ status: 'todo', source: 'reported' });
    expect(progressStatus('~', true, false, 'running')).toMatchObject({ status: 'unknown', raw: '[~]' });
  });
});

describe('Codex progress files', () => {
  const wt = () => {
    const dir = path.join(home, 'wt');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const run = (state: string, dir: string) => [{ id: 'c1', project: 'alpha', state, dir, ended: null }];

  it('reads the checklist under the run, first open box first', () => {
    const dir = wt();
    fs.writeFileSync(path.join(dir, 'CODEX_PROGRESS.md'), '- [x] one\n- [ ] two\n- [ ] three\nsome prose\n');
    const list = items(new Tracker(home), [], run('running', dir));
    expect(list.map((i) => [i.title, i.status, i.source, i.parentKey])).toEqual([
      ['one', 'done', 'reported', 'codex:c1'],
      ['two', 'doing', 'inferred', 'codex:c1'],
      ['three', 'todo', 'reported', 'codex:c1'],
    ]);
  });

  it('a stopped run without ## DONE blocks the open box; with it the box stays todo', () => {
    const a = wt();
    fs.writeFileSync(path.join(a, 'CODEX_PROGRESS.md'), '- [x] one\n- [ ] two\n');
    expect(items(new Tracker(home), [], run('stopped', a)).map((i) => i.status)).toEqual(['done', 'blocked']);
    fs.writeFileSync(path.join(a, 'CODEX_PROGRESS.md'), '- [x] one\n- [ ] two\n\n## DONE\nsummary\n');
    expect(items(new Tracker(home), [], run('done', a)).map((i) => i.status)).toEqual(['done', 'todo']);
  });

  it('a binary or oversized file is one unreadable line; a missing file is nothing', () => {
    const dir = wt();
    fs.writeFileSync(path.join(dir, 'CODEX_PROGRESS.md'), 'a\0b');
    expect(items(new Tracker(home), [], run('running', dir)).map((i) => i.unreadable)).toEqual([true]);
    fs.writeFileSync(path.join(dir, 'CODEX_PROGRESS.md'), 'x'.repeat(300 * 1024));
    expect(items(new Tracker(home), [], run('running', dir)).map((i) => i.unreadable)).toEqual([true]);
    fs.rmSync(path.join(dir, 'CODEX_PROGRESS.md'));
    expect(items(new Tracker(home), [], run('running', dir))).toEqual([]);
  });

  it('keeps at most CODEX_MAX worktrees, running ones first', () => {
    const codex = Array.from({ length: CODEX_MAX + 5 }, (_, n) => {
      const dir = path.join(home, `w${n}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'CODEX_PROGRESS.md'), '- [ ] item\n');
      return { id: `c${n}`, project: 'alpha', state: n === CODEX_MAX + 4 ? 'running' : 'done', dir, ended: new Date(NOW - n * 1000).toISOString() };
    });
    const list = items(new Tracker(home), [], codex);
    expect(list).toHaveLength(CODEX_MAX);
    expect(list[0].parentKey).toBe(`codex:c${CODEX_MAX + 4}`);
  });
});

describe('ids: only an exact MCP Task id links', () => {
  it('T-n in a title is the link; other shapes are not', () => {
    writeTask(sid(1), '1', { subject: 'fix T-0123 now', status: 'pending' });
    writeTask(sid(1), '2', { subject: 'see U-48 and XT-9 and T-123456 and T-x', status: 'pending' });
    writeTask(sid(1), '3', { subject: 'first T-7, then T-8', status: 'pending' });
    const list = items(new Tracker(home), [session(1)]).filter((i) => i.kind === 'agentList');
    expect(list.map((i) => i.taskId)).toEqual(['T-0123', undefined, 'T-7']);
    expect(parseProgress('- [ ] do T-12\n')).toMatchObject({ lines: [{ title: 'do T-12' }] });
  });
});

describe('privacy: titles only, masked, 200 characters', () => {
  it('masks secrets, folds whitespace and cuts', () => {
    expect(titleOf('deploy with password=hunter2 and token: abcd1234')).not.toMatch(/hunter2|abcd1234/);
    expect(titleOf('a\n\tb   c')).toBe('a b c');
    const long = titleOf('x'.repeat(500));
    expect(long).toHaveLength(TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('a list file’s description never reaches an item, and a session name is masked too', () => {
    writeTask(sid(1), '1', { subject: 'plain', description: 'SECRET-BODY-TEXT', status: 'pending' });
    const list = items(new Tracker(home), [session(1, { name: 'run with api_key=abc123xyz' })]);
    const json = JSON.stringify(list);
    expect(json).not.toContain('SECRET-BODY-TEXT');
    expect(json).not.toContain('abc123xyz');
    expect(json).not.toContain(home); // no absolute path
  });
});

describe('limits', () => {
  it('shows MORE_AFTER children and counts the rest', () => {
    for (let n = 1; n <= MORE_AFTER + 7; n++) writeTask(sid(1), String(n), { subject: `t${n}`, status: 'pending' });
    const r = new Tracker(home).refresh({ sessions: [session(1)], codex: [], now: NOW }).get('alpha')!;
    expect(r.items.filter((i) => i.kind === 'agentList')).toHaveLength(MORE_AFTER);
    expect(r.more).toEqual([{ parentKey: `session:${sid(1)}`, count: 7 }]);
  });

  it('open tasks come before finished ones when there are too many', () => {
    for (let n = 1; n <= MORE_AFTER; n++) writeTask(sid(1), String(n), { subject: `d${n}`, status: 'completed' });
    writeTask(sid(1), '99', { subject: 'open', status: 'pending' });
    const list = items(new Tracker(home), [session(1)]);
    expect(byTitle(list, 'open')).toBeDefined();
  });

  it('looks at no more than SESSIONS_MAX sessions, live ones first', () => {
    for (let n = 0; n < 6; n++) writeTask(sid(n), '1', { subject: 'old', status: 'pending' }); // ended, but with a fresh list
    const all = Array.from({ length: SESSIONS_MAX + 6 }, (_, n) => session(n, { live: n >= 6 }));
    const list = items(new Tracker(home), all);
    const cards = list.filter((i) => i.kind === 'session');
    expect(cards).toHaveLength(SESSIONS_MAX);
    expect(cards.every((i) => !i.ended)).toBe(true); // the ended ones come after the live ones and are cut
  });

  it('an ended session folds after 24 hours of no change', () => {
    const t = new Tracker(home);
    writeTask(sid(1), '1', { subject: 'old', status: 'pending' }, NOW - ENDED_FOLD_MS - 60_000);
    writeTask(sid(2), '1', { subject: 'new', status: 'pending' }, NOW - 60_000);
    const keys = items(t, [session(1, { live: false }), session(2, { live: false }), session(3, { live: false })]).map((i) => i.key);
    expect(keys).toContain(`session:${sid(2)}`);
    expect(keys).not.toContain(`session:${sid(1)}`);
    expect(keys).not.toContain(`session:${sid(3)}`); // nothing to show
  });

  it('the fold window is a day', () => expect(ENDED_FOLD_MS).toBe(DAY));
});

describe('unknown and broken formats (design §9)', () => {
  it('JSON in a shape this build does not know is one unreadable line, not a failure', () => {
    writeTask(sid(1), '1', { subject: 'fine', status: 'pending' });
    fs.writeFileSync(path.join(listDir(sid(1)), '2.json'), JSON.stringify({ todos: [{ content: 'x' }] }));
    fs.writeFileSync(path.join(listDir(sid(1)), '3.json'), JSON.stringify([1, 2]));
    const list = items(new Tracker(home), [session(1)]);
    expect(list.filter((i) => i.unreadable)).toHaveLength(1);
    expect(byTitle(list, 'fine')).toBeDefined();
  });

  it('a half-written file is skipped, then read once it is whole', () => {
    const t = new Tracker(home);
    const file = writeTask(sid(1), '1', { subject: 'whole', status: 'pending' });
    const text = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, text.slice(0, 20));
    expect(items(t, [session(1)]).filter((i) => i.kind === 'agentList')).toEqual([]);
    fs.writeFileSync(file, text);
    fs.utimesSync(file, (NOW + 5000) / 1000, (NOW + 5000) / 1000); // a later write
    expect(items(t, [session(1)]).filter((i) => i.kind === 'agentList').map((i) => i.title)).toEqual(['whole']);
    expect(parseListFile('{')).toBe('bad');
  });

  it('dot files (.lock, .highwatermark) are never read', () => {
    writeTask(sid(1), '1', { subject: 'x', status: 'pending' });
    fs.writeFileSync(path.join(listDir(sid(1)), '.lock'), '');
    fs.writeFileSync(path.join(listDir(sid(1)), '.highwatermark'), '1');
    const t = new Tracker(home);
    items(t, [session(1)]);
    expect(t.reads).toBe(1);
  });

  it('a session id that could leave the tasks folder is ignored', () => {
    expect(items(new Tracker(home), [session(1, { sessionId: '../../etc' })])).toEqual([]);
  });
});

describe('cache and read-only', () => {
  it('re-reads only a file whose mtime or size changed', () => {
    const t = new Tracker(home);
    const file = writeTask(sid(1), '1', { subject: 'one', status: 'pending' });
    writeTask(sid(1), '2', { subject: 'two', status: 'pending' });
    items(t, [session(1)]);
    expect(t.reads).toBe(2);
    items(t, [session(1)]);
    expect(t.reads).toBe(2);
    fs.writeFileSync(file, JSON.stringify({ id: '1', subject: 'one!', status: 'completed' }));
    expect(items(t, [session(1)]).find((i) => i.title === 'one!')?.status).toBe('done');
    expect(t.reads).toBe(3);
  });

  it('never writes, locks or touches the files it reads', () => {
    writeTask(sid(1), '1', { subject: 'a', status: 'pending' });
    const dir = listDir(sid(1));
    const before = () => fs.readdirSync(dir).map((n) => [n, fs.statSync(path.join(dir, n)).mtimeMs]);
    const was = before();
    const dirMtime = fs.statSync(dir).mtimeMs;
    const t = new Tracker(home);
    items(t, [session(1)]);
    items(t, [session(1)]);
    expect(before()).toEqual(was);
    expect(fs.statSync(dir).mtimeMs).toBe(dirMtime);
  });
});

describe('the feed: no viewer, no read', () => {
  const agent = (n: number, o: Partial<AgentEntry> = {}): AgentEntry =>
    ({ key: `sid:${n}`, name: `agent ${n}`, dir: '/p', tab: 'p', order: 1, state: 'running', busy: false, sessionId: sid(n), ...o }) as AgentEntry;
  function feed(watching: { n: number }, sent: TrackedItems[]) {
    return new TrackingFeed({
      home,
      watching: () => watching.n,
      broadcast: (m) => sent.push(m),
      projectOf: () => 'alpha',
      codexDir: () => null,
    });
  }

  it('reads nothing and sends nothing while nobody views', () => {
    writeTask(sid(1), '1', { subject: 'a', status: 'pending' });
    const sent: TrackedItems[] = [];
    const watching = { n: 0 };
    const f = feed(watching, sent);
    f.refresh([agent(1)], []);
    expect(f.reads).toBe(0);
    expect(sent).toEqual([]);
    watching.n = 1;
    f.refresh([agent(1)], []);
    expect(f.reads).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('sends a project only when it changed, keeps an ended session without its list, and forgets on clear', async () => {
    writeTask(sid(1), '1', { subject: 'a', status: 'pending' });
    const sent: TrackedItems[] = [];
    const f = feed({ n: 1 }, sent);
    f.refresh([agent(1)], []);
    await new Promise((r) => setTimeout(r, 5)); // a running session's message must not change with the clock
    f.refresh([agent(1)], []);
    expect(sent).toHaveLength(1);
    expect(f.snapshot()).toHaveLength(1);
    f.refresh([], []); // the session and its list are gone from the input; remembered as ended, list fresh
    expect(sent.at(-1)?.items.find((i) => i.kind === 'session')?.ended).toBe(true);
    fs.rmSync(listDir(sid(1)), { recursive: true });
    f.refresh([], []); // still remembered as ended for a day, now without its list
    expect(sent.at(-1)?.items.map((i) => [i.kind, i.ended])).toEqual([['session', true]]);
    f.refresh([agent(1)], []);
    f.clear();
    expect(f.snapshot()).toEqual([]);
  });

  it('a project that emptied while the office slept gets its empty message when it wakes (F6)', () => {
    const dir = listDir(sid(1));
    writeTask(sid(1), '1', { subject: 'a', status: 'pending' });
    const sent: TrackedItems[] = [];
    const f = feed({ n: 1 }, sent);
    f.refresh([agent(1)], []);
    expect(sent.at(-1)?.items.length).toBeGreaterThan(0);
    f.clear(); // the page was hidden: the office sleeps, the socket stays open
    expect(f.snapshot()).toEqual([]);
    fs.rmSync(dir, { recursive: true });
    f.refresh([], []); // woken: nothing left to show for the project
    expect(sent.at(-1)).toMatchObject({ project: 'alpha', items: [] });
    const count = sent.length;
    f.refresh([], []);
    expect(sent).toHaveLength(count); // said once
  });

  it('a project that still has items after waking is re-sent in full', () => {
    writeTask(sid(1), '1', { subject: 'a', status: 'pending' });
    const sent: TrackedItems[] = [];
    const f = feed({ n: 1 }, sent);
    f.refresh([agent(1)], []);
    f.clear();
    f.refresh([agent(1)], []);
    expect(sent).toHaveLength(2);
    expect(sent[1].items.length).toBeGreaterThan(0);
  });
});

describe('files that are not regular files, and hostile names and words (F1-F5)', () => {
  const posix = process.platform !== 'win32';

  it.runIf(posix)('a FIFO and a link to /dev/zero named like list files are skipped silently, promptly', () => {
    writeTask(sid(1), '2', { subject: 'real', status: 'pending' });
    execFileSync('mkfifo', [path.join(listDir(sid(1)), '1.json')]);
    fs.symlinkSync('/dev/zero', path.join(listDir(sid(1)), '3.json'));
    const t0 = Date.now();
    const t = new Tracker(home);
    const list = items(t, [session(1)]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(list.filter((i) => i.kind === 'agentList').map((i) => [i.title, i.unreadable])).toEqual([['real', undefined]]);
    expect(t.reads).toBe(1); // only the real file was opened
  });

  it.runIf(posix)('CODEX_PROGRESS.md as a link (to a file or to /dev/zero) or a FIFO is not read', () => {
    const run = (dir: string) => [{ id: 'c1', project: 'alpha', state: 'running', dir, ended: null }];
    const target = path.join(home, 'elsewhere.md');
    fs.writeFileSync(target, '- [ ] from a link\n');
    for (const make of [
      (f: string) => fs.symlinkSync(target, f),
      (f: string) => fs.symlinkSync('/dev/zero', f),
      (f: string) => execFileSync('mkfifo', [f]),
    ]) {
      const dir = fs.mkdtempSync(path.join(home, 'wt-'));
      make(path.join(dir, 'CODEX_PROGRESS.md'));
      const t0 = Date.now();
      const t = new Tracker(home);
      expect(items(t, [], run(dir))).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(t.reads).toBe(0);
    }
  });

  it('a list id that is not a short plain word makes the file unreadable and never reaches a key', () => {
    writeTask(sid(1), '1', { subject: 'ok', status: 'pending' });
    writeTask(sid(1), '2', { id: `password=hunter2 ${'Z'.repeat(5000)}`, subject: 'bad id', status: 'pending' });
    const list = items(new Tracker(home), [session(1)]);
    expect(list.filter((i) => i.unreadable)).toHaveLength(1);
    expect(byTitle(list, 'bad id')).toBeUndefined();
    expect(JSON.stringify(list)).not.toMatch(/hunter2|ZZZZ/);
    expect(parseListFile(JSON.stringify({ id: 'x'.repeat(41), subject: 's', status: 'pending' }))).toBe('unreadable');
    expect(parseListFile(JSON.stringify({ id: 'a-b_9', subject: 's', status: 'pending' }))).toMatchObject({ id: 'a-b_9' });
  });

  it('only plain short file names are listed, so a name never reaches the screen unmasked', () => {
    writeTask(sid(1), '1', { subject: 'ok', status: 'pending' });
    fs.writeFileSync(
      path.join(listDir(sid(1)), 'api_key=sk-abcdefghijklmnop1234567890.json'),
      JSON.stringify({ id: '2', subject: 'odd name', status: 'pending' }),
    );
    const list = items(new Tracker(home), [session(1)]);
    expect(byTitle(list, 'odd name')).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain('sk-abcdefghijklmnop');
  });

  it('a status word that names an inherited member is just an unknown word', () => {
    for (const [n, word] of ['constructor', '__proto__', 'toString', 'hasOwnProperty'].entries())
      writeTask(sid(1), String(n + 1), { subject: `w${n}`, status: word });
    const list = items(new Tracker(home), [session(1)]).filter((i) => i.kind === 'agentList');
    expect(list.map((i) => [i.status, i.rawStatus])).toEqual([
      ['unknown', 'constructor'],
      ['unknown', '__proto__'],
      ['unknown', 'toString'],
      ['unknown', 'hasOwnProperty'],
    ]);
    expect(JSON.parse(JSON.stringify(list)).every((i: { status?: string }) => typeof i.status === 'string')).toBe(true);
  });

  it('the source status word is masked and cut to 40 characters', () => {
    writeTask(sid(1), '1', { subject: 'odd', status: `token: abcd1234efgh5678${'x'.repeat(100)}` });
    const row = items(new Tracker(home), [session(1)]).find((i) => i.title === 'odd')!;
    expect(row.status).toBe('unknown');
    expect(row.rawStatus).not.toContain('abcd1234');
    expect(row.rawStatus!.length).toBeLessThanOrEqual(40);
  });

  it('a list file over 256 KB is one unreadable line, not read', () => {
    writeTask(sid(1), '1', { subject: 'big', status: 'pending', description: 'x'.repeat(300 * 1024) });
    writeTask(sid(1), '2', { subject: 'small', status: 'pending' });
    const list = items(new Tracker(home), [session(1)]);
    expect(list.filter((i) => i.unreadable)).toHaveLength(1);
    expect(byTitle(list, 'big')).toBeUndefined();
    expect(byTitle(list, 'small')).toBeDefined();
  });
});

describe('an ended session stays a day (F7)', () => {
  it('a session seen running and then gone keeps a card for 24 hours without a list, then folds', () => {
    const t = new Tracker(home);
    t.refresh({ sessions: [session(1, { busy: true })], codex: [], now: NOW });
    const later = (ms: number) => t.refresh({ sessions: [], codex: [], now: NOW + ms }).get('alpha')?.items ?? [];
    expect(later(60_000)).toMatchObject([{ key: `session:${sid(1)}`, status: 'unknown', ended: true, source: 'observed' }]);
    expect(later(ENDED_FOLD_MS - 60_000)).toHaveLength(1);
    expect(later(ENDED_FOLD_MS + 60_000)).toEqual([]);
  });

  it('a session only ever given as not running, with no list, has nothing to show', () => {
    expect(items(new Tracker(home), [session(1, { live: false })])).toEqual([]);
  });
});
