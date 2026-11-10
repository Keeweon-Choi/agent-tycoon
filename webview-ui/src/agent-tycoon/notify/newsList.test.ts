import { describe, expect, it } from 'vitest';

import type { OfficeEvent } from '../../../../core/src/messages.js';
import {
  cardTone,
  EMPTY_QUERY,
  filterNews,
  IMPORTANCE_TONE,
  importanceOf,
  isFeedNoise,
  kindOf,
  mergeNews,
  newsDay,
  queryNews,
  sortNews,
} from './newsList.js';
import type { Notice } from './notices.js';

const T0 = 1_800_000_000_000;
const notice = (over: Partial<Notice>): Notice => ({
  id: 'n1',
  cause: 'turnEnd',
  agentId: 7,
  name: 'harvester',
  text: '\uc77c\uc744 \ub9c8\ucce4\uc5b4\uc694',
  at: T0,
  read: false,
  ...over,
});
const event = (over: Partial<OfficeEvent>): OfficeEvent => ({
  type: 'officeEvent',
  ts: new Date(T0).toISOString(),
  kind: 'compacted',
  name: 'harvester',
  summary: '\ub300\ud654\ub97c \uc904\uc600\uc5b4\uc694',
  ...over,
});

describe('one list of notices and events (T-0070)', () => {
  it('merges newest first; only notices carry a read mark', () => {
    const list = mergeNews(
      [notice({ at: T0 + 2_000 }), notice({ id: 'n0', at: T0 - 5_000, read: true })],
      [event({ ts: new Date(T0 + 1_000).toISOString() })],
    );
    expect(list.map((i) => i.at - T0)).toEqual([2_000, 1_000, -5_000]);
    expect(list.map((i) => i.notice?.read)).toEqual([false, undefined, true]);
    expect(list.filter((i) => !i.notice).every((i) => i.groups.length === 0)).toBe(true);
  });

  it('filters: \ud655\uc778 \ud544\uc694 (asks, failures), \uc791\uc5c5, \ub300\ud654; events with no group are in \uc804\uccb4 only', () => {
    const list = mergeNews(
      [
        notice({ id: 'p', cause: 'permission', text: '\ud5c8\ub77d\uc744 \uae30\ub2e4\ub824\uc694', at: T0 + 5 }),
        notice({ id: 'j', cause: 'job', text: '\ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694', at: T0 + 4 }),
        notice({ id: 'f', cause: 'job', text: '\uc2dc\ud5d8\uc774 \uc2e4\ud328\ud588\uc5b4\uc694', at: T0 + 3 }),
        notice({ id: 't', at: T0 + 2 }),
      ],
      [event({})],
    );
    const ids = (f: Parameters<typeof filterNews>[1]) =>
      filterNews(list, f).map((i) => i.notice?.id ?? i.text);
    expect(ids('all')).toHaveLength(5);
    expect(ids('attention')).toEqual(['p', 'f']);
    expect(ids('job')).toEqual(['j', 'f']);
    expect(ids('chat')).toEqual(['t']);
  });

  it('omits the plumbing of the owner\'s own queued messages', () => {
    const list = mergeNews(
      [],
      ['send_hold', 'send_edit', 'send_cancel', 'inbox_deliver', 'token_guard', 'send_stuck'].map(
        (kind) => event({ kind, summary: kind }),
      ),
    );
    expect(list.map((i) => i.text).sort()).toEqual(['send_stuck', 'token_guard']);
  });

  it('omits sends from both the owner and agents', () => {
    const sends = mergeNews(
      [],
      [
        event({ kind: 'send', name: null, source: 'gui:phone', summary: 'owner message' }),
        event({
          kind: 'send',
          name: 'ops-bot',
          source: 'ops-bot',
          summary: 'agent message',
          ts: new Date(T0 + 1).toISOString(),
        }),
      ],
    );
    expect(sends).toEqual([]);
  });

  it('an event twin of a notice is listed once', () => {
    const list = mergeNews(
      [notice({ cause: 'job', text: '\ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694', at: T0 + 500 })],
      [event({ kind: 'job_end', ref: 'j1', summary: '\ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694' })],
    );
    expect(list).toHaveLength(1);
    // Replayed history (no notice): the event stays.
    expect(mergeNews([], [event({ kind: 'job_end', ref: 'j1', summary: 'x' })])).toHaveLength(1);
  });

  it('a notice hides only its own event, never one that had no notice (cooldown)', () => {
    // Two runs of the same job end 60 s apart: the second is inside the 5-min
    // notice cooldown, so only the first has a notice. Both ends stay visible.
    const jobs = mergeNews(
      [
        notice({
          cause: 'job',
          text: '\ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694',
          at: T0,
          target: { open: 'job', id: 'j1' },
        }),
      ],
      [
        event({
          kind: 'job_end',
          ref: 'j2',
          summary: '\ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694',
          ts: new Date(T0 + 60_000).toISOString(),
        }),
        event({ kind: 'job_end', ref: 'j1', summary: '\ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694' }),
      ],
    );
    expect(jobs.map((i) => (i.notice ? 'notice' : i.target))).toEqual([
      { open: 'job', id: 'j2' },
      'notice',
    ]);
    // Two turn ends of one lead, one notice: one event stays.
    const turns = mergeNews(
      [notice({})],
      [
        event({
          kind: 'turn_end',
          summary: 'harvester \ud134 \ub05d',
          ts: new Date(T0 + 60_000).toISOString(),
        }),
        event({ kind: 'turn_end', summary: 'harvester \ud134 \ub05d' }),
      ],
    );
    expect(turns.map((i) => i.at - T0)).toEqual([60_000, 0]);
  });

  it('NOTICE-DEDUP: a lead\'s reply stands for its turn end in the list too', () => {
    const list = mergeNews(
      [notice({ cause: 'reply', text: 'done' })],
      [event({ kind: 'turn_end', summary: 'harvester \ud134 \ub05d' })],
    );
    expect(list.map((i) => i.notice?.cause)).toEqual(['reply']);
  });

  it('NOTICE-DEDUP: a job or Codex start is not in the list; its end is', () => {
    const list = mergeNews(
      [],
      [
        event({ kind: 'job_start', ref: 'j1', summary: 'start' }),
        event({ kind: 'codex_start', ref: 'c1', summary: 'start' }),
        event({ kind: 'job_end', ref: 'j1', summary: 'end' }),
      ],
    );
    expect(list.map((i) => i.text)).toEqual(['end']);
  });

  it('a job event opens its card; others only expand', () => {
    const [job, other] = mergeNews(
      [],
      [
        event({ kind: 'job_end', ref: 'j1', summary: 'a' }),
        event({ kind: 'compacted', ts: new Date(T0 - 1).toISOString() }),
      ],
    );
    expect(job.target).toEqual({ open: 'job', id: 'j1' });
    expect(other.target).toBeUndefined();
  });
});

describe('the shared feed-noise filter', () => {
  it('drops sends and queue plumbing, keeps real news', () => {
    expect(['send', 'send_hold', 'inbox_deliver'].every(isFeedNoise)).toBe(true);
    expect(['job_end', 'token_guard', 'send_stuck'].some(isFeedNoise)).toBe(false);
  });
});

describe('day separators (NOTICE-B)', () => {
  it('names today and yesterday, and an older day by its midnight', () => {
    const now = new Date(2026, 10, 3, 10, 30).getTime();
    expect(newsDay(new Date(2026, 10, 3, 0, 5).getTime(), now)).toBe('today');
    expect(newsDay(new Date(2026, 10, 2, 23, 59).getTime(), now)).toBe('yesterday');
    expect(newsDay(new Date(2026, 10, 1, 8, 0).getTime(), now)).toBe(new Date(2026, 10, 1).getTime());
    expect(newsDay(now + 60_000, now)).toBe('today');
  });
});

describe('the window\'s facets (A4)', () => {
  const now = T0 + 2 * 86_400_000;
  const list = mergeNews(
    [
      notice({ id: 'p', cause: 'permission', name: 'lead', text: 'wait', at: now - 1_000 }),
      notice({
        id: 'f',
        cause: 'job',
        name: 'ops',
        text: '\uc2dc\ud5d8\uc774 \uc2e4\ud328\ud588\uc5b4\uc694',
        at: now - 2_000,
      }),
      notice({ id: 'j', cause: 'job', name: 'ops', text: 'ok', at: now - 3_000 }),
      notice({ id: 'old', cause: 'reply', name: 'lead', text: 'old note', at: now - 3 * 86_400_000 }),
    ],
    [event({ ts: new Date(now - 4_000).toISOString(), kind: 'hw', name: 'box', summary: 'hot' })],
  );

  it('importance and kind come from the cause and the groups', () => {
    const at = (id: string) => list.find((i) => i.notice?.id === id)!;
    expect(importanceOf(at('p'))).toBe('important');
    expect(importanceOf(at('f'))).toBe('urgent');
    expect(importanceOf(at('j'))).toBe('normal');
    expect(kindOf(at('p'))).toBe('attention');
    expect(kindOf(at('old'))).toBe('reply');
    expect(kindOf(list.find((i) => !i.notice)!)).toBe('system');
  });

  it('the system tab is the events no other tab claims', () => {
    expect(filterNews(list, 'system').map((i) => i.name)).toEqual(['box']);
  });

  it('the facets and the text combine; a facet can be left out for its own counts', () => {
    const q = { ...EMPTY_QUERY, time: 'today' as const };
    expect(queryNews(list, q, now).map((i) => i.name)).toEqual(['lead', 'ops', 'ops', 'box']);
    expect(queryNews(list, { ...q, importance: 'urgent' }, now)).toHaveLength(1);
    expect(queryNews(list, { ...q, text: 'OPS' }, now)).toHaveLength(2);
    expect(queryNews(list, { ...EMPTY_QUERY, time: 'week' }, now)).toHaveLength(5);
    expect(queryNews(list, { ...q, importance: 'urgent' }, now, 'importance')).toHaveLength(4);
  });

  it('sorts by importance, newest first inside a level', () => {
    const ids = sortNews(list, 'importance').map((i) => i.notice?.id ?? i.name);
    expect(ids.slice(0, 2)).toEqual(['f', 'p']);
    expect(ids.slice(2)).toEqual(['j', 'box', 'old']);
    expect(sortNews(list, 'time')).toBe(list);
  });
});

describe('importance colours and agent-neutral kinds (notices-neutral)', () => {
  const list = mergeNews(
    [
      notice({ id: 'p', cause: 'permission', at: T0 + 5 }),
      notice({ id: 'f', cause: 'job', text: '\uc2dc\ud5d8\uc774 \uc2e4\ud328\ud588\uc5b4\uc694', at: T0 + 4 }),
      notice({ id: 'n', cause: 'turnEnd', at: T0 + 3 }),
      notice({
        id: 'cx',
        cause: 'job',
        name: 'codex',
        target: { open: 'codex', id: 'c1' },
        at: T0 + 2,
      }),
      notice({ id: 'jb', cause: 'job', target: { open: 'job', id: 'j1' }, at: T0 + 1 }),
    ],
    [
      event({ kind: 'codex_end', ref: 'c9', summary: 'x', ts: new Date(T0 - 1).toISOString() }),
      event({ kind: 'job_end', ref: 'j9', summary: 'y', ts: new Date(T0 - 2).toISOString() }),
    ],
  );
  const by = (id: string) => list.find((i) => i.notice?.id === id)!;

  it('the card tone and the filter count come from the same importance', () => {
    expect(cardTone(by('f'))).toBe(IMPORTANCE_TONE.urgent);
    expect(cardTone(by('p'))).toBe(IMPORTANCE_TONE.important);
    expect(cardTone(by('n'))).toBe(IMPORTANCE_TONE.normal);
    expect(new Set(Object.values(IMPORTANCE_TONE)).size).toBe(3);
    // every item's card tone is the tone of the importance the filter counts it under
    for (const i of list)
      expect(queryNews(list, { ...EMPTY_QUERY, importance: importanceOf(i) }, T0).includes(i)).toBe(true);
    for (const i of list) expect(cardTone(i)).toBe(IMPORTANCE_TONE[importanceOf(i)]);
  });

  it('an ended Codex run and an ended Claude run are the same kind; a background job is not', () => {
    expect(kindOf(by('cx'))).toBe(kindOf(by('n')));
    expect(kindOf(by('n'))).toBe('turnEnd');
    expect(kindOf(by('jb'))).toBe('job');
    const [codexEnd, jobEnd] = list.filter((i) => !i.notice);
    expect(kindOf(codexEnd)).toBe('turnEnd');
    expect(kindOf(jobEnd)).toBe('job');
  });

  it('a failed run is urgent whichever agent ran it', () => {
    const [fail] = mergeNews([], [
      event({ kind: 'codex_end', ref: 'c2', summary: '\uc2e4\ud328\ud588\uc5b4\uc694' }),
    ]);
    expect(importanceOf(fail)).toBe('urgent');
    expect(kindOf(fail)).toBe('turnEnd');
  });
});
