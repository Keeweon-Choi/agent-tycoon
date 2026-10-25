/**
 * U-48 phase 2a: the document shapes, the status word table, ids (definition vs
 * mention, duplicates, short ids), fenced code, the limits, unreadable files, masking,
 * tracking.json and the settings path checks. Every document here is invented text.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrackedItems, TrackingSources } from '../../../../core/src/messages.js';
import { claimOf, ITEMS_MAX, parseDoc, parseTaskmaster, STATUS_WORDS, statusWord } from './docs.js';
import { DIR_READS_MAX, DOCS_MAX, DocTracker, expand, GIT_LOG_ARGS, GONE_MS, resolveDocs } from './docTracker.js';
import { FOUND_SENT_MAX, TrackingFeed } from './feed.js';
import { RAW_MAX, TITLE_MAX } from './parse.js';
import { checkPath, DOCS_ON_MAX, NO_SETTINGS, trackingPath, TrackingSettingsStore } from './settings.js';
import { MORE_AFTER } from './tracker.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-docs-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const doc = (text: string, name = 'notes.md', shortIds = false) => {
  const d = parseDoc(text, name, shortIds);
  if (d === 'unreadable') throw new Error('unreadable');
  return d;
};
const write = (rel: string, text: string) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};
const settings = (o: Partial<typeof NO_SETTINGS> = {}) => ({ ...NO_SETTINGS, ...o });
const NOW = Date.now();
// No read-time budget: a loaded machine would stop after fewer documents than the test wrote (the
// budget has its own test below).
const itemsOf = (t: DocTracker, s = settings(), taskIds: Set<string> = new Set(), now = NOW) =>
  t.refresh([{ name: 'alpha', folder: dir, settings: s }], taskIds, now, Infinity).get('alpha') ?? { items: [], more: [] };

describe('status word table', () => {
  it('maps the Korean and English words, longest first, and nothing else', () => {
    const cases: Array<[string, string | null]> = [
      ['done', 'done'],
      ['완료', 'done'],
      ['끝남', 'done'],
      ['배포됨(10-24, 병합)', 'done'],
      ['**Merged**', 'done'],
      ['✅ 완료', 'done'],
      ['진행 중', 'doing'],
      ['In Progress', 'doing'],
      ['구현 중', 'doing'],
      ['검증 중', 'review'],
      ['review', 'review'],
      ['보류', 'blocked'],
      ['대기', 'blocked'],
      ['할 일', 'todo'],
      ['예정', 'todo'],
      ['계획', 'todo'],
      ['취소', 'cancelled'],
      ['버림', 'cancelled'],
      ['부분 구현', null],
      ['진행됨이라고 함', null], // a word must end at a non-letter
      ['완료 10-24', 'done'],
      ['done ✅', 'done'],
      // a status word followed by words that change its meaning is no status (unknown + the raw word)
      ['완료 예정', null],
      ['완료 안 됨', null],
      ['배포 대기', null],
      ['병합 대기', null],
      ['진행 예정', null],
      ['done soon', null],
      ['not done', null],
      ['merged, not deployed', null],
      ['', null],
    ];
    for (const [text, want] of cases) expect([text, statusWord(text)]).toEqual([text, want]);
    for (const [status, words] of Object.entries(STATUS_WORDS)) for (const w of words) expect(statusWord(w)).toBe(status);
  });

  it('strict matching (a cell that is not the status column) wants the whole text', () => {
    expect(statusWord('완료', true)).toBe('done');
    expect(statusWord('완료(10-24)', true)).toBe('done');
    expect(statusWord('완료 후 배포 계획', true)).toBeNull();
  });

  it('an unknown word stays unknown with the raw word, masked and capped on the way to the screen', () => {
    expect(claimOf('부분 구현')).toEqual({ status: 'unknown', raw: '부분 구현' });
    write('ROADMAP.md', `| ID | 상태 |\n|---|---|\n| U-1 | weird ${'x'.repeat(100)} |\n| U-2 | token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 |\n`);
    const rows = itemsOf(new DocTracker()).items.filter((i) => i.taskId);
    expect(rows[0]).toMatchObject({ status: 'unknown' });
    expect(rows[0].rawStatus!.length).toBe(RAW_MAX);
    expect(rows[1].rawStatus).not.toContain('abcdefghijklmnop');
  });
});

describe('checkboxes', () => {
  it('reads every mark under the nearest heading; the heading is the parent', () => {
    const d = doc('# Plan\n\n## Week one\n- [ ] write it\n- [x] read it\n* [X] star box\n- [~] maybe\n- [-] dropped?\n\n## Empty\nprose\n');
    const rows = d.entries.map((e) => [e.kind, e.title, e.status, e.raw, e.source, e.parent ? 'p' : '-']);
    expect(rows).toEqual([
      ['heading', 'Week one', 'unknown', undefined, 'unknown', '-'],
      ['check', 'write it', 'todo', '[ ]', 'reported', 'p'],
      ['check', 'read it', 'done', '[x]', 'reported', 'p'],
      ['check', 'star box', 'done', '[X]', 'reported', 'p'],
      ['check', 'maybe', 'unknown', '[~]', 'reported', 'p'],
      ['check', 'dropped?', 'unknown', '[-]', 'reported', 'p'],
    ]);
    expect(d.entries[1].parent).toBe(d.entries[0].key);
  });

  it('keys by text (a mark change keeps the key), a repeated text gets ~2', () => {
    const a = doc('- [ ] same\n- [ ] other\n- [ ] same\n').entries.map((e) => e.key);
    const b = doc('- [x] same\n- [ ] other\n- [ ] same\n').entries.map((e) => e.key);
    expect(a).toEqual(b);
    expect(a[2]).toBe(`${a[0]}~2`);
  });

  it('skips fenced code (``` and ~~~)', () => {
    const d = doc('- [ ] real\n```\n- [ ] in code\n| U-1 | done |\n```\n~~~md\n- [x] tilde code\n~~~\n- [x] after\n');
    expect(d.entries.map((e) => e.title)).toEqual(['real', 'after']);
  });

  it('masks titles and caps them at 200 characters on one line (what is sent)', () => {
    write('TODO.md', `- [ ] call with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now\n- [ ] ${'long '.repeat(80)}\n`);
    const lines = itemsOf(new DocTracker()).items.filter((i) => i.parentKey);
    expect(lines[0].title).not.toContain('abcdefghijklmnop');
    expect(lines[0].title).toContain('call with');
    expect(lines[1].title.length).toBe(TITLE_MAX);
    expect(JSON.stringify(itemsOf(new DocTracker()))).not.toContain('abcdefghijklmnop');
  });

  it('keeps ITEMS_MAX entries per file and counts the rest', () => {
    const d = doc(Array.from({ length: ITEMS_MAX + 7 }, (_, n) => `- [ ] item ${n}`).join('\n'));
    expect(d.entries).toHaveLength(ITEMS_MAX);
    expect(d.more).toBe(7);
  });
});

describe('tables', () => {
  it('an id in the first cell defines a row; the status column is the one with a status header', () => {
    const d = doc(
      [
        '| ID | 내용 | 상태 |',
        '| --- | --- | --- |',
        '| U-10 | first thing | 배포됨(10-20) |',
        '| **U-11** | second, see U-10 | 부분 구현 |',
        '| U-12 | third |  |',
        '| prose | no id here | 완료 |',
      ].join('\n'),
    );
    expect(d.entries.map((e) => [e.id, e.title, e.status, e.raw, e.source])).toEqual([
      ['U-10', 'first thing', 'done', '배포됨(10-20)', 'inferred'],
      ['U-11', 'second, see U-10', 'unknown', '부분 구현', 'inferred'],
      ['U-12', 'third', 'unknown', undefined, 'unknown'],
      // the table has a status column, so a row without an id is an item too, keyed by its text
      [undefined, 'prose', 'done', '완료', 'inferred'],
    ]);
    expect(d.entries[1].refs).toEqual(['U-11', 'U-10']);
    expect(d.entries[3].key).toMatch(/^h:[0-9a-f]{10}$/);
  });

  it('without a status header the status is the first cell that is a whole status word', () => {
    const d = doc('| Id | What | Note |\n|---|---|---|\n| AB-1 | 계획 세우기 | 진행 중 |\n| AB-2 | another | words only |\n');
    expect(d.entries.map((e) => [e.id, e.title, e.status])).toEqual([
      ['AB-1', '계획 세우기', 'doing'],
      ['AB-2', 'another', 'unknown'],
    ]);
  });

  it('a table with neither ids nor a status column makes no items; its ids are mentions only', () => {
    const d = doc('| Name | Link |\n|---|---|\n| thing | see U-48 |\n\nAlso U-49 in prose.\n');
    expect(d.entries).toEqual([]);
    expect(d.mentions.sort()).toEqual(['U-48', 'U-49']);
  });
});

describe('ids', () => {
  it('definitions: heading start, first table cell, file name, front-matter id; anywhere else a mention', () => {
    const d = doc('## T-0012 Heading defines\n\nWe talk about T-0013 here.\n\n- [ ] T-0014 checkbox names it\n', 'T-0015-some-task.md');
    expect(d.id).toBe('T-0015');
    expect(d.entries.map((e) => [e.kind, e.id, e.refs])).toEqual([
      ['heading', 'T-0012', ['T-0012']],
      ['check', undefined, ['T-0014']],
    ]);
    expect(d.mentions).toEqual(['T-0013']);
    expect(doc('---\nid: ADR-0007\ntitle: Pick a store\nstatus: accepted\n---\n# body\n', 'any.md')).toMatchObject({
      id: 'ADR-0007',
      title: 'Pick a store',
      status: { status: 'done', raw: 'accepted' },
    });
  });

  it('Spec Kit T001 is an id; short ids (D5, C3a) only when the project turns them on', () => {
    expect(doc('| T001 | setup | done |\n|---|---|---|\n').entries).toEqual([]); // the first line was the header
    expect(doc('| id | what | status |\n|---|---|---|\n| T001 | setup | done |\n').entries[0].id).toBe('T001');
    const table = '| id | what |\n|---|---|\n| D5 | engine work |\n| C3a | small |\n';
    expect(doc(table, 'r.md', false).entries).toEqual([]);
    expect(doc(table, 'r.md', true).entries.map((e) => e.id)).toEqual(['D5', 'C3a']);
    expect(doc('see D5\n', 'r.md', false).mentions).toEqual([]);
    expect(doc('see D5\n', 'r.md', true).mentions).toEqual(['D5']);
  });

  it('a mention never makes an item', () => {
    const d = doc('Paragraph naming U-48 and T-0001.\n\n> quote with AB-12\n\n| a | b |\n|---|---|\n| x | U-48 |\n');
    expect(d.entries).toEqual([]);
    expect(d.mentions.sort()).toEqual(['AB-12', 'T-0001', 'U-48']);
  });
});

describe('Taskmaster tasks.json', () => {
  it('reads tasks and subtasks (plain or tagged), status reported', () => {
    const tasks = [{ id: 1, title: 'Setup', status: 'done', subtasks: [{ id: 1, title: 'Init', status: 'in-progress' }] }, { id: 2, title: 'Later', status: 'deferred' }];
    for (const json of [{ tasks }, { master: { tasks } }]) {
      const d = parseTaskmaster(JSON.stringify(json));
      if (d === 'unreadable') throw new Error('unreadable');
      expect(d.entries.map((e) => [e.key, e.title, e.status, e.source, e.parent])).toEqual([
        ['tm:1', 'Setup', 'done', 'reported', undefined],
        ['tm:1.1', 'Init', 'doing', 'reported', 'tm:1'],
        ['tm:2', 'Later', 'blocked', 'reported', undefined],
      ]);
    }
    expect(parseTaskmaster('{nope')).toBe('unreadable');
    expect(parseTaskmaster('{"other": 1}')).toBe('unreadable');
  });
});

describe('which documents', () => {
  it('conventional names (any case), globs turned on, the ones turned off; no links, no skipped folders', () => {
    write('roadmap.md', '- [ ] a\n');
    write('Todo.MD', '- [ ] b\n');
    write('specs/001-x/tasks.md', '- [ ] c\n');
    write('.kiro/specs/feat/tasks.md', '- [ ] d\n');
    write('docs/adr/0001-pick.md', '---\nstatus: accepted\n---\n');
    write('tasks/T-0001-a.md', '# a\n');
    write('notes/plan/backlog-usage.md', '| ID | 상태 |\n|---|---|\n| U-1 | done |\n');
    write('node_modules/pkg/TODO.md', '- [ ] never\n');
    write('elsewhere/outside.md', '- [ ] secret\n');
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'docs', 'linked'));
    fs.symlinkSync(path.join(dir, 'elsewhere/outside.md'), path.join(dir, 'PLAN.md'));
    const found = resolveDocs(dir, settings({ on: ['notes/*/backlog-*.md', 'docs/linked/*.md', '*/pkg/TODO.md'], off: ['Todo.MD'] }));
    expect(found).toEqual([
      { path: 'Todo.MD', conventional: true, on: false },
      { path: 'roadmap.md', conventional: true, on: true },
      { path: 'specs/001-x/tasks.md', conventional: true, on: true },
      { path: '.kiro/specs/feat/tasks.md', conventional: true, on: true },
      { path: 'docs/adr/0001-pick.md', conventional: true, on: true },
      { path: 'tasks/T-0001-a.md', conventional: true, on: true },
      { path: 'notes/plan/backlog-usage.md', conventional: false, on: true },
    ]);
    expect(expand(dir, 'docs/*/outside.md')).toEqual([]); // a linked folder is not entered
  });

  it('a glob stops after DIR_READS_MAX directory listings', () => {
    for (let n = 0; n < DIR_READS_MAX + 50; n++) write(`notes/d${String(n).padStart(3, '0')}/x.md`, '- [ ] x\n');
    const hits = expand(dir, 'notes/*/x.md');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(DIR_READS_MAX);
  });

  it('reads at most DOCS_MAX documents per project', () => {
    for (let n = 0; n < DOCS_MAX + 5; n++) write(`tasks/t${String(n).padStart(3, '0')}.md`, `- [ ] item ${n}\n`);
    const cards = itemsOf(new DocTracker()).items.filter((i) => !i.parentKey);
    expect(cards).toHaveLength(DOCS_MAX);
  });

  it('a document over the size cap is one unreadable card; a FIFO or a link is never opened', () => {
    write('ROADMAP.md', `- [ ] ${'x'.repeat(300 * 1024)}\n`);
    execFileSync('mkfifo', [path.join(dir, 'TODO.md')]);
    write('real/plan.md', '- [ ] behind a link\n');
    fs.symlinkSync(path.join(dir, 'real/plan.md'), path.join(dir, 'BACKLOG.md'));
    const t = new DocTracker();
    const items = itemsOf(t).items;
    expect(items.map((i) => [i.key, i.unreadable])).toEqual([['doc:alpha/ROADMAP.md', true]]);
  });
});

describe('the doc items of a project', () => {
  it('a document card with its items, keys, path, line and an aggregate status', () => {
    write('ROADMAP.md', '# Road\n\n## Now\n- [x] one\n- [ ] two U-7\n\n| ID | 상태 |\n|---|---|\n| U-7 | 진행 중 |\n');
    const { items } = itemsOf(new DocTracker());
    expect(items.map((i) => [i.key.replace(/h:[0-9a-f]+/, 'h:*'), i.parentKey?.replace(/h:[0-9a-f]+/, 'h:*'), i.status, i.source, i.line])).toEqual([
      ['doc:alpha/ROADMAP.md', undefined, 'doing', 'inferred', undefined],
      ['doc:alpha/ROADMAP.md#h:*', 'doc:alpha/ROADMAP.md', 'unknown', 'unknown', 3],
      ['doc:alpha/ROADMAP.md#h:*', 'doc:alpha/ROADMAP.md#h:*', 'done', 'reported', 4],
      ['doc:alpha/ROADMAP.md#h:*', 'doc:alpha/ROADMAP.md#h:*', 'todo', 'reported', 5],
      ['doc:alpha/ROADMAP.md#U-7', 'doc:alpha/ROADMAP.md', 'doing', 'inferred', 9],
    ]);
    expect(items[0].path).toBe('ROADMAP.md');
    expect(items[4]).toMatchObject({ taskId: 'U-7', refs: ['U-7'] });
    expect(items[3]).toMatchObject({ refs: ['U-7'] });
    expect(items[3].taskId).toBeUndefined(); // a mention links, it does not define
    expect(JSON.stringify(items)).not.toContain(dir);
  });

  it('two definitions of one id in a project are both kept and marked', () => {
    write('ROADMAP.md', '| ID | 상태 |\n|---|---|\n| U-1 | done |\n');
    write('BACKLOG.md', '| ID | 상태 |\n|---|---|\n| U-1 | todo |\n| U-2 | todo |\n');
    const rows = itemsOf(new DocTracker()).items.filter((i) => i.taskId);
    expect(rows.map((i) => [i.path, i.taskId, i.duplicate])).toEqual([
      ['ROADMAP.md', 'U-1', true],
      ['BACKLOG.md', 'U-1', true],
      ['BACKLOG.md', 'U-2', undefined],
    ]);
  });

  it('sends MORE_AFTER lines per document, open ones first, plus every line a Task links', () => {
    const rows = Array.from({ length: 60 }, (_, n) => `| AB-${n + 1} | row ${n + 1} | ${n < 40 ? 'done' : 'todo'} |`);
    write('BACKLOG.md', `| ID | What | Status |\n|---|---|---|\n${rows.join('\n')}\n`);
    const { items, more } = itemsOf(new DocTracker(), settings(), new Set(['AB-2']));
    const lines = items.filter((i) => i.parentKey);
    expect(lines.filter((i) => i.status === 'todo')).toHaveLength(20);
    expect(lines.some((i) => i.taskId === 'AB-2')).toBe(true);
    expect(lines).toHaveLength(MORE_AFTER + 1);
    expect(more).toEqual([{ parentKey: 'doc:alpha/BACKLOG.md', count: 59 - MORE_AFTER }]);
  });

  it('hidden keys are not sent; a hidden document hides all of it', () => {
    write('ROADMAP.md', '- [ ] keep\n- [ ] hide me\n');
    write('TODO.md', '- [ ] all gone\n');
    const t = new DocTracker();
    const hideKey = itemsOf(t).items.find((i) => i.title === 'hide me')!.key;
    const after = itemsOf(t, settings({ hidden: [hideKey, 'doc:alpha/TODO.md'] })).items;
    expect(after.map((i) => i.title)).toEqual(['ROADMAP.md', 'keep']);
  });

  it('an item that vanished from a document still on shows as gone for a day; a re-read only when the file changed', () => {
    const file = write('ROADMAP.md', '- [ ] stays\n- [ ] leaves\n');
    const t = new DocTracker();
    itemsOf(t);
    const reads = t.reads;
    itemsOf(t);
    expect(t.reads).toBe(reads); // same mtime and size: not read again
    fs.writeFileSync(file, '- [ ] stays\n');
    fs.utimesSync(file, new Date(NOW + 5_000), new Date(NOW + 5_000));
    const gone = itemsOf(t).items.find((i) => i.title === 'leaves');
    expect(gone).toMatchObject({ gone: true });
    expect(itemsOf(t, settings(), new Set(), NOW + GONE_MS + 1).items.find((i) => i.title === 'leaves')).toBeUndefined();
    // turned off is not gone
    const t2 = new DocTracker();
    itemsOf(t2);
    expect(itemsOf(t2, settings({ off: ['ROADMAP.md'] })).items).toEqual([]);
  });

  it('a refresh stops reading when its time budget is spent and the next one goes on (one read at least)', () => {
    for (let n = 0; n < 5; n++) write(`tasks/t${n}.md`, `- [ ] item ${n}\n`);
    const t = new DocTracker();
    const s = settings();
    const cards = () => t.refresh([{ name: 'alpha', folder: dir, settings: s }], new Set(), NOW, 0).get('alpha')!.items.filter((i) => !i.parentKey);
    expect(cards()).toHaveLength(1);
    expect(t.pending).toBe(true);
    for (let n = 2; n <= 5; n++) expect(cards()).toHaveLength(n);
    expect(t.pending).toBe(false);
  });

  it('short ids follow the project setting (the parse is redone when it flips)', () => {
    write('ROADMAP.md', '| id | what |\n|---|---|\n| D5 | engine |\n');
    const t = new DocTracker();
    expect(itemsOf(t).items).toHaveLength(1); // the card only
    expect(itemsOf(t, settings({ shortIds: true })).items.map((i) => i.taskId)).toEqual([undefined, 'D5']);
    write('TODO.md', '| id | 상태 |\n|---|---|\n| E6 | done |\n');
    itemsOf(t, settings({ shortIds: false }));
    // flipping the rule re-keys the row, but the file did not change: nothing shows as gone
    expect(itemsOf(t, settings({ shortIds: true })).items.filter((i) => i.gone)).toEqual([]);
  });
});

describe('tracking.json and the settings', () => {
  it('path checks: inside the folder only, no .., no absolute path, no **, at most DOCS_ON_MAX', () => {
    expect(checkPath(dir, 'docs/plan/backlog.md')).toBeNull();
    expect(checkPath(dir, 'docs/*/tasks.md')).toBeNull();
    expect(checkPath(dir, '../other/TODO.md')).toBe('outside');
    expect(checkPath(dir, 'docs/../../x.md')).toBe('outside');
    expect(checkPath(dir, '/etc/passwd.md')).toBe('outside');
    expect(checkPath(dir, '~/notes.md')).toBe('outside');
    expect(checkPath(dir, 'C:/x.md')).toBe('outside');
    expect(checkPath(dir, 'docs/**/x.md')).toBe('path');
    expect(checkPath(dir, 'node_modules/x/TODO.md')).toBe('path');
    expect(checkPath(dir, 'secret.txt')).toBe('path');
    expect(checkPath(dir, 'a\\b.md')).toBe('path');
    const store = new TrackingSettingsStore(trackingPath(dir));
    const many = Array.from({ length: DOCS_ON_MAX + 1 }, (_, n) => `d${n}.md`);
    expect(store.set('alpha', dir, settings({ on: many }))).toBe('tooMany');
    expect(store.set('alpha', dir, settings({ on: ['../x.md'] }))).toBe('outside');
    expect(fs.existsSync(trackingPath(dir))).toBe(false); // nothing refused is written
  });

  it('is 0600, versioned, written through a temp file and a rename, and read back', () => {
    const file = trackingPath(dir);
    const store = new TrackingSettingsStore(file);
    expect(store.set('alpha', dir, settings({ on: ['notes/*.md'], shortIds: true }))).toBeNull();
    const inode = fs.statSync(file).ino;
    expect(store.hide('alpha', 'doc:alpha/ROADMAP.md#U-1')).toBeNull();
    expect(fs.statSync(file).ino).not.toBe(inode); // a new file renamed over the old one, never written in place
    expect(store.hide('alpha', 'doc:beta/ROADMAP.md')).toBe('key');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      v: 1,
      projects: { alpha: { docs: { on: ['notes/*.md'], off: [] }, shortIds: true, hidden: ['doc:alpha/ROADMAP.md#U-1'] } },
    });
    expect(new TrackingSettingsStore(file).get('alpha')).toEqual({ on: ['notes/*.md'], off: [], shortIds: true, hidden: ['doc:alpha/ROADMAP.md#U-1'] });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tracking.json']);
  });
});

const gitIn = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });

describe('the "켤까요?" candidates', () => {
  let tools: string;
  beforeEach(() => {
    tools = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-docs-tools-'));
  });
  afterEach(() => fs.rmSync(tools, { recursive: true, force: true }));

  it('a repository config never makes the git query run a program (gpg.program + log.showSignature)', async () => {
    const marker = path.join(tools, 'marker');
    const gpg = path.join(tools, 'gpg.sh');
    // Signs when asked to (so the commit carries a signature); anything else (verifying) leaves the marker.
    fs.writeFileSync(
      gpg,
      `#!/bin/sh\nfor a in "$@"; do case "$a" in -bsau) cat >/dev/null; printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 ABC\\n' >&2; printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'; exit 0;; esac; done\necho ran > '${marker}'\nexit 1\n`,
      { mode: 0o755 },
    );
    write('notes/plan.md', '- [ ] a plan\n');
    gitIn(dir, 'init', '-q');
    gitIn(dir, 'add', '.');
    gitIn(dir, '-c', `gpg.program=${gpg}`, '-c', 'commit.gpgsign=true', '-c', 'user.signingkey=ABC', 'commit', '-qm', 'x');
    gitIn(dir, 'config', 'log.showSignature', 'true');
    gitIn(dir, 'config', 'gpg.program', gpg);
    expect(await new DocTracker().candidates(dir, settings(), new Set())).toEqual(['notes/plan.md']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('GIT-HARDEN: a partial clone’s lazy fetch (HEAD on a missing commit, an ext:: promisor remote) runs no transport', async () => {
    const marker = path.join(tools, 'marker');
    const ext = path.join(tools, 'ext.sh');
    fs.writeFileSync(ext, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    write('notes/plan.md', '- [ ] a plan\n');
    gitIn(dir, 'init', '-q', '-b', 'main');
    for (const [k, v] of [
      ['core.repositoryformatversion', '1'],
      ['extensions.partialClone', 'evil'],
      ['remote.evil.promisor', 'true'],
      ['protocol.ext.allow', 'always'],
      ['remote.evil.url', `ext::${ext} %S`],
    ])
      gitIn(dir, 'config', k, v);
    // An edit, not a git command: the branch names a commit nobody has.
    fs.mkdirSync(path.join(dir, '.git/refs/heads'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git/refs/heads/main'), `${'1'.repeat(40)}\n`);
    expect(await new DocTracker().candidates(dir, settings(), new Set())).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
    // armed: the same query without the daemon's environment fetches it
    expect(() => execFileSync('git', GIT_LOG_ARGS(dir), { stdio: 'ignore' })).toThrow();
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('a committed document whose folder is now a link out of the project is not offered', async () => {
    write('docs/plan.md', '- [ ] inside\n');
    gitIn(dir, 'init', '-q');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'x');
    fs.rmSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tools, 'plan.md'), '- [ ] outside the project\n');
    fs.symlinkSync(tools, path.join(dir, 'docs'));
    expect(await new DocTracker().candidates(dir, settings(), new Set())).toEqual([]);
  });
});

describe('through the feed', () => {
  const feed = (home: string, watching: () => number, sent: TrackedItems[]) =>
    new TrackingFeed({
      home,
      watching,
      broadcast: (m) => sent.push(m),
      projectOf: () => null,
      codexDir: () => null,
      projects: () => [{ name: 'alpha', folder: dir }],
      taskIds: () => new Set(),
    });

  it('reads nothing without a viewer', () => {
    write('ROADMAP.md', '- [ ] one\n');
    const sent: TrackedItems[] = [];
    let viewers = 0;
    const f = feed(path.join(dir, 'home'), () => viewers, sent);
    f.refresh([], []);
    expect(f.reads).toBe(0);
    expect(sent).toEqual([]);
    viewers = 1;
    f.refresh([], []);
    expect(f.reads).toBe(1);
    expect(sent.at(-1)!.items.map((i) => i.title)).toEqual(['ROADMAP.md', 'one']);
  });

  it('the git query runs when the settings open, not on every change; the found list is capped', async () => {
    for (let n = 0; n < FOUND_SENT_MAX + 10; n++) write(`tasks/t${String(n).padStart(3, '0')}.md`, '- [ ] x\n');
    const spy = vi.spyOn(DocTracker.prototype, 'candidates');
    try {
      const f = feed(path.join(dir, 'home'), () => 1, []);
      const replies: TrackingSources[] = [];
      await f.onSettings({ project: 'alpha' }, (m) => replies.push(m), true);
      await f.onSettings({ project: 'alpha', settings: { ...NO_SETTINGS, shortIds: true } }, (m) => replies.push(m), true);
      await f.onSettings({ project: 'alpha', hide: 'doc:alpha/tasks/t000.md' }, (m) => replies.push(m), true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(replies.map((r) => r.error)).toEqual([undefined, undefined, undefined]);
      expect(replies[0].found).toHaveLength(FOUND_SENT_MAX);
    } finally {
      spy.mockRestore();
    }
  });

  it('settings: a candidate from git turned on adds its items; a read-only change is refused', async () => {
    write('ROADMAP.md', '- [ ] one\n');
    write('notes/plan.md', '| ID | 상태 |\n|---|---|\n| U-5 | 완료 |\n');
    write('notes/prose.md', 'no items here\n');
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'x');
    const home = path.join(dir, 'home');
    const sent: TrackedItems[] = [];
    const f = feed(home, () => 1, sent);
    f.refresh([], []);
    const replies: TrackingSources[] = [];
    await f.onSettings({ project: 'alpha' }, (m) => replies.push(m), true);
    expect(replies[0]).toMatchObject({ found: [{ path: 'ROADMAP.md', conventional: true, on: true, items: 1 }], candidates: ['notes/plan.md'] });
    await f.onSettings({ project: 'alpha', settings: { ...NO_SETTINGS, on: ['notes/plan.md'] } }, (m) => replies.push(m), false);
    expect(replies[1].error).toBe('denied');
    await f.onSettings({ project: 'alpha', settings: { ...NO_SETTINGS, on: ['../escape.md'] } }, (m) => replies.push(m), true);
    expect(replies[2].error).toBe('outside');
    await f.onSettings({ project: 'alpha', settings: { ...NO_SETTINGS, on: ['notes/plan.md'] } }, (m) => replies.push(m), true);
    expect(replies[3].error).toBeUndefined();
    expect(replies[3].candidates).toEqual([]);
    expect(sent.at(-1)!.items.map((i) => i.taskId ?? i.title)).toEqual(['ROADMAP.md', 'one', 'notes/plan.md', 'U-5']);
    await f.onSettings({ project: 'nope' }, (m) => replies.push(m), true);
    expect(replies[4].error).toBe('project');
  });
});
