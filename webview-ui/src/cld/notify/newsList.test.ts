import { describe, expect, it } from 'vitest';

import type { OfficeEvent } from '../../../../core/src/messages.js';
import { filterNews, isFeedNoise, mergeNews } from './newsList.js';
import type { Notice } from './notices.js';

const T0 = 1_800_000_000_000;
const notice = (over: Partial<Notice>): Notice => ({
  id: 'n1',
  cause: 'turnEnd',
  agentId: 7,
  name: 'wayfinder',
  text: '\uc77c\uc744 \ub9c8\ucce4\uc5b4\uc694',
  at: T0,
  read: false,
  ...over,
});
const event = (over: Partial<OfficeEvent>): OfficeEvent => ({
  type: 'officeEvent',
  ts: new Date(T0).toISOString(),
  kind: 'compacted',
  name: 'wayfinder',
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
          summary: 'wayfinder \ud134 \ub05d',
          ts: new Date(T0 + 60_000).toISOString(),
        }),
        event({ kind: 'turn_end', summary: 'wayfinder \ud134 \ub05d' }),
      ],
    );
    expect(turns.map((i) => i.at - T0)).toEqual([60_000, 0]);
  });

  it('NOTICE-DEDUP: a lead\'s reply stands for its turn end in the list too', () => {
    const list = mergeNews(
      [notice({ cause: 'reply', text: 'done' })],
      [event({ kind: 'turn_end', summary: 'wayfinder \ud134 \ub05d' })],
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
