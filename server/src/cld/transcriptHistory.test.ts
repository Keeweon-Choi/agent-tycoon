import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { chatHistory, chatSearch } from './transcriptHistory.js';
import { TranscriptTail } from './transcriptView.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cld-history-'));
const record = (n: number, text = `message ${n}`, at = n) =>
  JSON.stringify({
    type: n % 2 ? 'assistant' : 'user',
    uuid: `${String(n).padStart(8, '0')}-record`,
    timestamp: new Date(1_790_000_000_000 + at * 1000).toISOString(),
    message: { content: n % 2 ? [{ type: 'text', text }] : text },
  }) + '\n';
const write = (file: string, rows: string[]) => fs.writeFileSync(file, rows.join(''));

describe('transcript history', () => {
  it('a whole conversation the tail already holds has nothing older (records without a uuid)', async () => {
    const file = path.join(root(), 'plain.jsonl');
    fs.writeFileSync(
      file,
      [
        { type: 'user', message: { role: 'user', content: 'first' } },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        },
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(''),
    );
    const tail = new TranscriptTail();
    tail.poll(file);
    expect(tail.items).toHaveLength(2);
    // Negative control: ids numbered upwards from 1 made the history page re-send both.
    expect((await chatHistory(file, tail.items[0].id)).items).toEqual([]);
  });

  it('C2: an older page binds replies to their message the way the live tail does', async () => {
    const file = path.join(root(), 'marked.jsonl');
    const mark = (n: number, id: string | null) =>
      record(n, `[사장 · 메신저 · 10-24 12:00]${id ? ` ⟨m:${id}⟩` : ''}\n같은 글`);
    write(file, [mark(0, 'aaaa2222'), record(1, '답'), mark(2, 'bbbb3333'), record(3, '답'), mark(4, null), record(5, '답')]);
    const page = await chatHistory(file); // the newest page, read backwards
    const view = (items: typeof page.items) => items.map((i) => [i.text, i.messageId ?? null]);
    expect(view(page.items)).toEqual([
      ['같은 글', 'aaaa2222'],
      ['답', 'aaaa2222'],
      ['같은 글', 'bbbb3333'],
      ['답', 'bbbb3333'],
      ['같은 글', null],
      ['답', null],
    ]);
  });

  it('pages over 200 items without gaps, including equal timestamps', async () => {
    const file = path.join(root(), 'current.jsonl');
    write(
      file,
      Array.from({ length: 230 }, (_, n) => record(n, undefined, Math.floor(n / 3))),
    );
    const pages = [];
    let before: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await chatHistory(file, before);
      pages.push(page);
      before = page.items[0].id;
    }
    expect(pages.map((p) => p.items.length)).toEqual([80, 80, 70]);
    expect(pages[2].done).toBe(true);
    const ids = pages.flatMap((p) => p.items.map((x) => x.id));
    expect(new Set(ids).size).toBe(230);
  });

  it('resumes from the cursor of the previous page, across sessions, same items', async () => {
    const dir = root();
    const current = path.join(dir, 'current.jsonl');
    write(
      path.join(dir, 'previous.jsonl'),
      Array.from({ length: 50 }, (_, n) => record(n)),
    );
    write(
      current,
      Array.from({ length: 150 }, (_, n) => record(n + 100, undefined, 100 + Math.floor(n / 2))),
    );
    const ids: string[] = [];
    let before: string | undefined;
    let cursor: Awaited<ReturnType<typeof chatHistory>>['cursor'];
    for (let done = false; !done;) {
      const page = await chatHistory(current, before, undefined, cursor);
      ids.unshift(...page.items.map((x) => x.id));
      ({ done, cursor } = page);
      before = page.items[0]?.id ?? before;
    }
    expect(new Set(ids).size).toBe(200);
    expect(ids).toEqual([...ids].sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0])));
    // A cursor really resumes: an unreadable newer part is never read again.
    const first = await chatHistory(current);
    const text = fs.readFileSync(current, 'utf8');
    fs.writeFileSync(
      current,
      text.slice(0, first.cursor!.end) + 'x'.repeat(text.length - first.cursor!.end),
    );
    const second = await chatHistory(current, first.items[0].id, undefined, first.cursor);
    expect(second.items).toHaveLength(80); // 70 current + 10 of the previous session
    expect(second.items.at(-1)!.at).toBeLessThan(first.items[0].at);
  });

  it('pages through shared milliseconds with random uuids: every item once, in file order', async () => {
    for (let trial = 0; trial < 50; trial++) {
      let seed = trial + 1;
      const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
      const rows = Array.from(
        { length: 230 },
        (_, n) =>
          JSON.stringify({
            type: 'user',
            uuid: Array.from({ length: 8 }, () => Math.floor(rand() * 16).toString(16)).join(''),
            timestamp: new Date(1_790_000_000_000 + Math.floor(n / 6)).toISOString(),
            message: { content: `message ${n}` },
          }) + '\n',
      );
      const file = path.join(root(), 'current.jsonl');
      write(file, rows);
      const expected = Array.from({ length: 230 }, (_, n) => `message ${n}`);
      for (const withCursor of [false, true]) {
        const texts: string[] = [];
        let before: string | undefined;
        let cursor: Awaited<ReturnType<typeof chatHistory>>['cursor'];
        for (let done = false; !done;) {
          const page = await chatHistory(file, before, undefined, withCursor ? cursor : undefined);
          texts.unshift(...page.items.map((x) => x.text));
          ({ done, cursor } = page);
          before = page.items[0]?.id ?? before;
        }
        expect(texts, `trial ${trial} cursor ${withCursor}`).toEqual(expected);
      }
    }
  });

  it('reaches until and includes ten older items', async () => {
    const file = path.join(root(), 'current.jsonl');
    write(
      file,
      Array.from({ length: 180 }, (_, n) => record(n)),
    );
    const target = 1_790_000_000_000 + 100_000;
    const page = await chatHistory(file, undefined, target);
    expect(page.items[0].text).toBe('message 90');
    expect(page.items.some((item) => item.at === target)).toBe(true);
  });

  it('chains earlier top-level sessions but ignores subagents', async () => {
    const dir = root();
    const current = path.join(dir, 'current.jsonl');
    write(current, [record(30)]);
    write(path.join(dir, 'previous.jsonl'), [record(10), record(20)]);
    write(path.join(dir, 'oldest.jsonl'), [record(0)]);
    fs.mkdirSync(path.join(dir, 'subagents'));
    write(path.join(dir, 'subagents', 'side.jsonl'), [record(5, 'subagent only')]);
    const page = await chatHistory(current);
    expect(page.items.map((x) => x.text)).toEqual([
      'message 0',
      'message 10',
      'message 20',
      'message 30',
    ]);
    expect(page.items[0].session).toBe('oldest');
    expect(page.items[3].session).toBeUndefined();
    expect(page.done).toBe(true);
  });

  it('searches text in both sessions, newest first, caps hits and validates queries', async () => {
    const dir = root();
    const current = path.join(dir, 'current.jsonl');
    write(path.join(dir, 'previous.jsonl'), [record(0, 'Needle earlier')]);
    write(
      current,
      Array.from({ length: 60 }, (_, n) => record(n + 10, `NEEDLE ${n}`)),
    );
    const result = await chatSearch(current, 'needle');
    expect(result.hits).toHaveLength(50);
    expect(result.hits[0].snippet).toContain('NEEDLE 59');
    expect(result.truncated).toBe(true);
    expect((await chatSearch(current, 'earlier')).hits[0].session).toBe('previous');
    expect((await chatSearch(current, 'a')).error).toBeTruthy();
    expect((await chatSearch(current, 'x'.repeat(101))).error).toBeTruthy();
    expect((await chatSearch(current, 'needle', { byteBudget: 40 })).truncated).toBe(true);
  });

  it('keeps a room post and its tool-using reply out of both history and search', async () => {
    const file = path.join(root(), 'current.jsonl');
    write(file, [
      record(0, 'before direct message'),
      JSON.stringify({
        type: 'user',
        uuid: 'room-prompt',
        timestamp: new Date(1_790_000_001_000).toISOString(),
        message: { content: "[peer · 단톡방 '출시팀' · 10-22 10:05]\n@alpha secret room post" },
      }) + '\n',
      JSON.stringify({
        type: 'assistant',
        uuid: 'room-tool',
        timestamp: new Date(1_790_000_002_000).toISOString(),
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'secret deploy' } }],
        },
      }) + '\n',
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'secret result' }] },
      }) + '\n',
      record(3, 'secret room reply'),
      record(4, 'after direct message'),
    ]);
    expect((await chatHistory(file)).items.map((item) => item.text)).toEqual([
      'before direct message',
      'after direct message',
    ]);
    expect((await chatSearch(file, 'secret')).hits).toEqual([]);
  });
});
