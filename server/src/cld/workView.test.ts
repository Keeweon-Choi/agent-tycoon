import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { refused } from '../../../core/src/cld/serverText.js';
import { lineItems, RESULT_MAX, spawnLineItems } from './transcriptView.js';
import {
  fileReader,
  MAX_OPEN_PER_CLIENT,
  MAX_READERS,
  parseWorkView,
  seal,
  SidecarFinder,
  subagentReader,
  within,
  type WorkReader,
  WorkViews,
} from './workView.js';

const rec = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`;
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cld-work-'));
const T = (s: number) => new Date(Date.UTC(2026, 9, 22, 2, 0, s)).toISOString();

const SPAWN = 'toolu_SPAWN0001';
const OTHER = 'toolu_OTHER0002';

/** The lead's own records around an inline sub-agent (Task-era agent_progress). */
const leadLines = (spawn = SPAWN) =>
  [
    rec({ type: 'user', uuid: 'u1', timestamp: T(1), message: { content: '조사 맡겨 줘' } }),
    rec({
      type: 'assistant',
      uuid: 'a1',
      timestamp: T(2),
      message: {
        content: [
          { type: 'text', text: '서브에이전트에게 맡길게요' },
          {
            type: 'tool_use',
            id: spawn,
            name: 'Task',
            input: { description: 'dig', prompt: '로그를 조사해서 원인을 알려줘' },
          },
        ],
      },
    }),
    rec({
      type: 'progress',
      uuid: 'p1',
      timestamp: T(3),
      parentToolUseID: spawn,
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          uuid: 's1',
          timestamp: T(3),
          message: {
            content: [
              { type: 'text', text: '**원인**을 찾는 중' },
              { type: 'tool_use', id: 'toolu_inner1', name: 'Bash', input: { command: 'ls /var' } },
            ],
          },
        },
      },
    }),
    rec({
      type: 'progress',
      uuid: 'p2',
      timestamp: T(4),
      parentToolUseID: spawn,
      data: {
        type: 'agent_progress',
        message: {
          type: 'user',
          uuid: 's2',
          timestamp: T(4),
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_inner1', content: 'a\nb\nc' }],
          },
        },
      },
    }),
    // Another spawn's progress, and the lead's own sidechain-free chatter: not ours.
    rec({
      type: 'progress',
      uuid: 'p3',
      timestamp: T(5),
      parentToolUseID: OTHER,
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          uuid: 's3',
          timestamp: T(5),
          message: { content: [{ type: 'text', text: '다른 일' }] },
        },
      },
    }),
    rec({
      type: 'assistant',
      uuid: 'a2',
      timestamp: T(6),
      message: { content: [{ type: 'text', text: '기다리는 중' }] },
    }),
  ].join('');

describe('sidechain extraction by tool_use id', () => {
  it('the spawn prompt, then the sub-agent text, tool call and result; nothing of another spawn or the lead', () => {
    const items = leadLines()
      .split('\n')
      .flatMap((l, i) => spawnLineItems(l, SPAWN, i));
    expect(items.map(({ kind, text, toolName }) => ({ kind, text, toolName }))).toEqual([
      { kind: 'user', text: '로그를 조사해서 원인을 알려줘', toolName: undefined },
      { kind: 'assistant', text: '**원인**을 찾는 중', toolName: undefined },
      { kind: 'tool', text: 'Running: ls /var', toolName: 'Bash' },
      { kind: 'result', text: 'a\nb\nc', toolName: undefined },
    ]);
    expect(items[0].at).toBe(Date.parse(T(2)));
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('a spawn nothing logged for has no items; torn lines are skipped', () => {
    expect(spawnLineItems('{"type":"prog', SPAWN)).toEqual([]);
    expect(
      leadLines()
        .split('\n')
        .flatMap((l) => spawnLineItems(l, 'toolu_NONE0003')),
    ).toEqual([]);
  });

  it('results are trimmed, and only when asked for; the messenger view never has them', () => {
    const line = JSON.stringify({
      type: 'user',
      isSidechain: true,
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'z'.repeat(1000) }] },
    });
    expect(lineItems(line)).toEqual([]); // sidechain: left out
    expect(lineItems(line, 0, { sidechain: true })).toEqual([]); // no results unless asked
    const [r] = lineItems(line, 0, { sidechain: true, results: true });
    expect(r.kind).toBe('result');
    expect(r.text.length).toBe(RESULT_MAX + 1);
    const blocks = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'from blocks' }] }],
      },
    });
    expect(lineItems(blocks, 0, { results: true })[0].text).toBe('from blocks');
  });
});

describe('a background sub-agent: its sidecar transcript', () => {
  function project() {
    const root = dir();
    const lead = path.join(root, 'lead-session.jsonl');
    fs.writeFileSync(lead, leadLines());
    const subs = path.join(root, 'lead-session', 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    return { root, lead, subs };
  }
  const sidecar = (subs: string, id: string, toolUseId: string, lines: string[]) => {
    fs.writeFileSync(path.join(subs, `agent-${id}.meta.json`), JSON.stringify({ toolUseId }));
    fs.writeFileSync(path.join(subs, `agent-${id}.jsonl`), lines.join(''));
  };
  const own = (n: number, text: string) =>
    rec({
      type: 'assistant',
      isSidechain: true,
      uuid: `own${n}`,
      timestamp: T(10 + n),
      message: { content: [{ type: 'text', text }] },
    });
  const prompt = rec({
    type: 'user',
    isSidechain: true,
    uuid: 'own0',
    timestamp: T(10),
    message: { content: '자기 작업: 서버 로그 조사' },
  });

  it('finds the sidecar naming the spawn, reading each sidecar once', () => {
    const p = project();
    sidecar(p.subs, 'aaa', OTHER, [prompt]);
    sidecar(p.subs, 'bbb', SPAWN, [prompt]);
    const finder = new SidecarFinder(p.lead, SPAWN);
    expect(finder.find()).toBe(path.join(p.subs, 'agent-bbb.jsonl'));
    expect(new SidecarFinder(p.lead, 'toolu_NONE0003').find()).toBeNull();
  });

  it('its own transcript is read whole, then followed', async () => {
    const p = project();
    sidecar(p.subs, 'bbb', SPAWN, [prompt, own(1, '파일을 읽는 중')]);
    const reader = subagentReader(p.lead, SPAWN);
    const first = await reader.poll();
    expect(first?.append).toBe(false);
    expect(first?.items.map((i) => i.text)).toEqual([
      '자기 작업: 서버 로그 조사',
      '파일을 읽는 중',
    ]);
    expect(await reader.poll()).toBeNull();
    fs.appendFileSync(path.join(p.subs, 'agent-bbb.jsonl'), own(2, '끝났어요'));
    const next = await reader.poll();
    expect(next).toMatchObject({ append: true, items: [{ text: '끝났어요' }] });
    expect(reader.full().items).toHaveLength(3);
  });

  it('with no sidecar it falls back to the sidechain records in the lead transcript', async () => {
    const p = project();
    const reader = subagentReader(p.lead, SPAWN);
    const first = await reader.poll();
    expect(first?.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'result']);
    // The sidecar shows up later: the view switches to it.
    sidecar(p.subs, 'ccc', SPAWN, [prompt, own(1, '이제 자기 파일')]);
    const later = await reader.poll();
    expect(later?.append).toBe(false);
    expect(later?.items.map((i) => i.text)).toContain('이제 자기 파일');
  });

  it('a sidecar that is a symlink out of the lead project dir is not followed', async () => {
    const p = project();
    const outside = path.join(dir(), 'secret.jsonl');
    fs.writeFileSync(outside, own(1, 'OUTSIDE-CONTENT'));
    fs.writeFileSync(
      path.join(p.subs, 'agent-lnk.meta.json'),
      JSON.stringify({ toolUseId: SPAWN }),
    );
    fs.symlinkSync(outside, path.join(p.subs, 'agent-lnk.jsonl'));
    const first = await subagentReader(p.lead, SPAWN).poll();
    expect(JSON.stringify(first)).not.toContain('OUTSIDE-CONTENT');
  });
});

describe('confinement', () => {
  it('within: inside, the root itself, outside, a symlink out, a missing file', () => {
    const root = dir();
    const inside = path.join(root, 'a.txt');
    fs.writeFileSync(inside, 'x');
    const out = path.join(dir(), 'b.txt');
    fs.writeFileSync(out, 'x');
    fs.symlinkSync(out, path.join(root, 'link.txt'));
    expect(within(inside, root)).toBe(true);
    expect(within(root, root)).toBe(true);
    expect(within(out, root)).toBe(false);
    expect(within(path.join(root, 'link.txt'), root)).toBe(false);
    expect(within(path.join(root, 'missing'), root)).toBe(false);
  });

  it('fileReader reads a teammate transcript only inside its root', async () => {
    const root = dir();
    const file = path.join(root, 'mate.jsonl');
    fs.writeFileSync(
      file,
      rec({
        type: 'assistant',
        isSidechain: true,
        uuid: 'm1',
        timestamp: T(1),
        message: { content: [{ type: 'text', text: '팀원 말' }] },
      }),
    );
    expect((await fileReader(() => file, root).poll())?.items[0].text).toBe('팀원 말');
    expect((await fileReader(() => file, dir()).poll())?.items).toEqual([]);
  });
});

describe('parseWorkView', () => {
  it.each([
    [
      { kind: 'subagent', agentId: 7, id: SPAWN, on: true },
      { kind: 'subagent', agentId: 7, id: SPAWN },
    ],
    [
      { kind: 'teammate', agentId: 7, id: 'ignored', on: true },
      { kind: 'teammate', agentId: 7 },
    ],
  ])('takes %j', (msg, target) => {
    expect(parseWorkView(msg)).toEqual({ on: true, target });
  });
  it.each([
    [{ kind: 'subagent', agentId: 7, on: true }],
    [{ kind: 'subagent', id: SPAWN, on: true }],
    [{ kind: 'teammate', on: true }],
    [{ kind: 'bash', id: 'x', on: true }],
    [{ kind: 'codex', id: 'x', agentId: 3, on: true }],
    [{ kind: 'subagent', agentId: 3, id: 'x'.repeat(300), on: true }],
    [{ kind: 'subagent', agentId: 1.5, id: 'x', on: true }],
  ])('refuses %j', (msg) => {
    expect(parseWorkView(msg)).toBeNull();
  });
});

/** Lets the poll a view's opening starts run to its end. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('WorkViews', () => {
  const fixed = (items: string[]): WorkReader => {
    let sent = false;
    const all = items.map((text, i) => ({ kind: 'assistant' as const, text, id: `${i}-x`, at: i }));
    return {
      poll: async () => (sent ? null : ((sent = true), { items: all })),
      full: () => ({ items: all }),
    };
  };

  it('masks every string before it leaves (one choke point)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const views = new WorkViews(() =>
      fixed(['token=abc123XYZ and ok', 'curl -H "Authorization: Bearer hunter2hunter2"']),
    );
    views.view((m) => sent.push(m), { kind: 'teammate', agentId: 1 }, true);
    await views.poll();
    expect(sent).toHaveLength(1);
    const text = JSON.stringify(sent[0]);
    expect(text).not.toContain('abc123XYZ');
    expect(text).not.toContain('hunter2hunter2');
    expect(text).toContain('token=***');
  });

  it('seal masks the title too', () => {
    const s = seal({ items: [], title: 'job password=pw1' });
    expect(JSON.stringify(s)).not.toMatch(/pw\d/);
  });

  it('opens once per reader, tells a late client the whole state, then the appended items', async () => {
    let n = 0;
    let appended: string | null = null;
    const reader: WorkReader = {
      poll: async () => {
        const a = appended;
        appended = null;
        return a
          ? { items: [{ kind: 'assistant', text: a, id: `${++n}-i`, at: n }], append: true }
          : null;
      },
      full: () => ({ items: [{ kind: 'assistant', text: 'whole', id: '0-i', at: 0 }] }),
    };
    let resolved = 0;
    const views = new WorkViews(() => (resolved++, reader));
    const a: Array<Record<string, unknown>> = [];
    const b: Array<Record<string, unknown>> = [];
    const target = { kind: 'teammate' as const, agentId: 4 };
    views.view((m) => a.push(m), target, true);
    await settle();
    views.view((m) => b.push(m), target, true);
    await settle();
    expect(resolved).toBe(1);
    expect(views.size).toBe(1);
    expect(a).toHaveLength(1);
    expect(b[0]).toMatchObject({ type: 'workContent', agentId: 4, items: [{ text: 'whole' }] });
    appended = 'later';
    await views.poll();
    await settle();
    expect(a[1]).toMatchObject({ append: true, items: [{ text: 'later' }] });
    expect(b[1]).toMatchObject({ append: true, items: [{ text: 'later' }] });
  });

  it('closing the last view frees the reader; a dropped client frees its views', async () => {
    const views = new WorkViews(() => fixed(['x']));
    const send = () => undefined;
    views.view(send, { kind: 'teammate', agentId: 1 }, true);
    views.view(send, { kind: 'teammate', agentId: 2 }, true);
    expect(views.size).toBe(2);
    views.view(send, { kind: 'teammate', agentId: 1 }, false);
    expect(views.size).toBe(1);
    views.drop(send);
    expect(views.size).toBe(0);
  });

  it('caps per client and per daemon, and relays why a target has no reader', () => {
    const got: Array<Record<string, unknown>> = [];
    const views = new WorkViews((t) =>
      t.agentId === 99 ? refused('work_record_missing') : fixed(['x']),
    );
    const send = (m: Record<string, unknown>) => got.push(m);
    for (let i = 1; i <= MAX_OPEN_PER_CLIENT + 1; i++)
      views.view(send, { kind: 'teammate', agentId: i }, true);
    expect(views.size).toBe(MAX_OPEN_PER_CLIENT);
    expect(got.at(-1)).toMatchObject({
      type: 'workContent',
      items: [],
      error: expect.stringMatching(/[가-힣]/),
    });
    views.drop(send);
    views.view(send, { kind: 'teammate', agentId: 99 }, true);
    expect(got.at(-1)).toMatchObject({ agentId: 99, error: '이 일의 기록을 찾지 못했어요', errorCode: 'work_record_missing' });
    const crowd = new WorkViews(() => fixed(['x']));
    for (let c = 0; c < MAX_READERS + 3; c++)
      crowd.view(() => undefined, { kind: 'teammate', agentId: 100 + c }, true);
    expect(crowd.size).toBe(MAX_READERS);
  });
});
