import { beforeEach, describe, expect, it } from 'vitest';

import type { CodexTask, OfficeJob } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import {
  codexKind,
  codexStatus,
  foldText,
  gpuBadge,
  jobStatus,
  MAX_JOB_CARDS,
  planJobs,
  progressText,
  spanText,
  timesText,
  workCounts,
  workLines,
} from './jobs.js';

beforeEach(() => setLanguage('ko'));

const NOW = Date.parse('2026-10-22T12:00:00+09:00');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const job = (over: Partial<OfficeJob>): OfficeJob => ({
  pid: 1,
  project: 'pofol',
  cmd: 'python train.py --token SECRET',
  started: ago(12),
  ended: null,
  exit: null,
  progress: null,
  ...over,
});

describe('progress for every running job', () => {
  it('a tqdm log: percent, speed, remaining time', () => {
    const j = job({ progress: { pct: 45, rate: '5.4it/s', eta: '01:41' } });
    expect(progressText(j)).toBe('45% · 5.4it/s · \ub0a8\uc740 \uc2dc\uac04 01:41');
  });
  it('the first run has an indeterminate bar with elapsed time', () => {
    const j = job({ progress: { label: '\uccab \uc2e4\ud589', pct: 0, indeterminate: true } });
    expect(progressText(j, NOW)).toBe('\uccab \uc2e4\ud589 · 12\ubd84\uc9f8');
    expect(jobStatus(j, NOW)).toEqual({ kind: 'running', text: '\uc2e4\ud589 \uc911 · 12\ubd84\uc9f8' });
  });
  it('prior-run and known-step bars use explanatory labels', () => {
    expect(
      progressText(job({ progress: { label: '\uc9c0\ub09c\ubc88 4\ubd84 · \uc57d 2\ubd84 \ub0a8\uc74c', pct: 50 } }), NOW),
    ).toBe('\uc9c0\ub09c\ubc88 4\ubd84 · \uc57d 2\ubd84 \ub0a8\uc74c');
    expect(progressText(job({ progress: { label: '2/6\ub2e8\uacc4', pct: 33 } }), NOW)).toBe(
      '2/6\ub2e8\uacc4 · 33%',
    );
  });
  it('an ended job shows no progress even if one was left on it', () => {
    expect(progressText(job({ ended: ago(1), exit: 0, progress: { pct: 99 } }))).toBeNull();
  });
});

describe('tense', () => {
  it('exit 0 is done, in the past', () => {
    expect(jobStatus(job({ started: ago(15), ended: ago(3), exit: 0 }), NOW)).toEqual({
      kind: 'done',
      text: '\ub05d\ub0a8(\uc131\uacf5) · 12\ubd84 \uac78\ub9bc',
    });
  });
  it('a non-zero exit is a failure without its code', () => {
    expect(jobStatus(job({ started: ago(6), ended: ago(3), exit: 1 }), NOW)).toEqual({
      kind: 'failed',
      text: '\uc2e4\ud328 · 3\ubd84 \uac78\ub9bc',
    });
  });
  it('an unknown exit fails; only an explicit user stop reads as \uba48\ucda4', () => {
    expect(jobStatus(job({ ended: ago(3), exit: null }), NOW).kind).toBe('failed');
    expect(jobStatus(job({ ended: ago(3), exit: null, stopped: true }), NOW).kind).toBe('stopped');
  });
  it('an ended job never says \uc2e4\ud589 \uc911', () => {
    for (const exit of [0, 1, null]) {
      expect(jobStatus(job({ ended: ago(3), exit }), NOW).text).not.toContain('\uc2e4\ud589 \uc911');
    }
  });
  it('spans', () => {
    expect(spanText(30_000)).toBe('30\ucd08');
    expect(spanText(125 * 60_000)).toBe('2\uc2dc\uac04 5\ubd84');
    expect(spanText(120 * 60_000)).toBe('2\uc2dc\uac04');
  });
});

describe('order, folding and the cap', () => {
  const ended = (pid: number, minAgo: number, exit: number, project = 'pofol') =>
    job({ pid, project, started: ago(minAgo + 5), ended: ago(minAgo), exit });

  it('running first, newest first; recent ended after, newest first', () => {
    const plan = planJobs(
      [
        ended(1, 10, 0),
        job({ pid: 2, started: ago(30) }),
        ended(3, 5, 0),
        job({ pid: 4, started: ago(2) }),
      ],
      NOW,
    );
    expect(plan.cards.map((j) => j.pid)).toEqual([4, 2, 3, 1]);
  });

  it('ended jobs older than an hour fold per project, counting failures', () => {
    const jobs = [
      ...Array.from({ length: 21 }, (_, i) => ended(100 + i, 120 + i, 0)),
      ended(200, 200, 1),
      ended(201, 300, 2),
      ended(300, 90, 0, 'atlas'),
      ended(400, 30, 0),
    ];
    const plan = planJobs(jobs, NOW);
    expect(plan.cards.map((j) => j.pid)).toEqual([400]);
    expect(plan.folds.map(foldText)).toEqual([
      'atlas \ub05d\ub09c \uc791\uc5c5 1\uac1c',
      'pofol \ub05d\ub09c \uc791\uc5c5 23\uac1c · \uc2e4\ud328 2',
    ]);
  });

  it('caps the cards at 20 and says \uc678 N', () => {
    const jobs = Array.from({ length: 25 }, (_, i) => job({ pid: i + 1, started: ago(i + 1) }));
    const plan = planJobs(jobs, NOW);
    expect(plan.cards).toHaveLength(MAX_JOB_CARDS);
    expect(plan.more).toBe(5);
    expect(plan.cards[0].pid).toBe(1);
  });
});

describe('GPU jobs (T-0021)', () => {
  it('say leased while running, nothing once ended or without --gpu; a queued one is a status, not a badge', () => {
    expect(gpuBadge(job({ gpu: 'queued', gpuId: null }))).toBeNull();
    expect(gpuBadge(job({ gpu: 'leased', gpuId: 'g-1022-040000-a' }))).toBe('GPU \uc608\uc57d');
    expect(gpuBadge(job({ gpu: 'done', ended: ago(1), exit: 0 }))).toBeNull();
    expect(gpuBadge(job({ gpu: 'leased', ended: ago(1), exit: 0 }))).toBeNull();
    expect(gpuBadge(job({}))).toBeNull();
  });
});

describe('waiting is not running (U-03)', () => {
  it('a job waiting in the GPU queue reads GPU \ub300\uae30 since it was created, never \uc9c4\ud589 \uc911 or \uc2e4\ud589 \uc911', () => {
    const j = job({ gpu: 'queued', created: ago(10), started: null, progress: { pct: 40 } });
    expect(jobStatus(j, NOW)).toEqual({ kind: 'gpuWait', text: 'GPU \ub300\uae30 · 10\ubd84\uc9f8' });
    // Nothing runs, so no bar or percent even if a stale one is attached.
    expect(progressText(j, NOW)).toBeNull();
  });
  it('once leased it runs, counted from its real start and not from its creation', () => {
    const j = job({ gpu: 'leased', gpuId: 'gpu0', created: ago(10), started: ago(2) });
    expect(jobStatus(j, NOW)).toEqual({ kind: 'running', text: '\uc2e4\ud589 \uc911 · 2\ubd84\uc9f8' });
  });
  it('shows created and started apart; before the start it says so', () => {
    expect(timesText(ago(10), ago(2), NOW)).toBe('\uc0dd\uc131 10\ubd84 \uc804 · \uc2dc\uc791 2\ubd84 \uc804');
    expect(timesText(ago(10), null, NOW)).toBe('\uc0dd\uc131 10\ubd84 \uc804 · \uc2dc\uc791 \uc804');
  });
});

describe('Codex tasks wait too (U-03)', () => {
  const task = (over: Partial<CodexTask>): CodexTask => ({
    id: 'c1',
    project: 'pofol',
    state: 'running',
    created: ago(10),
    started: ago(8),
    ...over,
  });
  it('queued until the worker started Codex, then running, then limit with its reset time', () => {
    expect(codexKind(task({ started: null }))).toBe('queued');
    expect(codexStatus(task({ started: null }), NOW)).toBe('\uc2e4\ud589 \ub300\uae30 · 10\ubd84\uc9f8');
    expect(codexKind(task({}))).toBe('running');
    expect(codexStatus(task({}), NOW)).toBe('\uc2e4\ud589 \uc911 · 8\ubd84\uc9f8');
    const limit = task({ state: 'limit', resetAt: new Date(NOW + 90 * 60_000).toISOString() });
    expect(codexKind(limit)).toBe('limit');
    expect(codexStatus(limit, NOW)).toBe('\ud55c\ub3c4 \ub300\uae30 · 1\uc2dc\uac04 30\ubd84 \ub4a4 \ucd08\uae30\ud654');
  });
  it('a limit wait without a known reset says only that', () => {
    expect(codexStatus(task({ state: 'limit', resetAt: null }), NOW)).toBe('\ud55c\ub3c4 \ub300\uae30');
  });
  it('an ended task is not waiting', () => {
    expect(codexKind(task({ state: 'done', ended: ago(1) }))).toBe('done');
    expect(codexKind(task({ state: 'running', started: null, ended: ago(1) }))).toBe('done');
  });
});

describe('the hourglass count follows state (U-04)', () => {
  const codex = (over: Partial<CodexTask>): CodexTask => ({
    id: 'c1',
    project: 'pofol',
    state: 'running',
    started: ago(8),
    ...over,
  });
  it('counts each waiting state apart from running, jobs and Codex tasks together', () => {
    const jobs = [
      job({ pid: 1 }),
      job({ pid: 2, gpu: 'leased', started: ago(1) }),
      job({ pid: 3, gpu: 'queued', started: null }),
      job({ pid: 4, ended: ago(1), exit: 0 }),
    ];
    const tasks = [
      codex({}),
      codex({ id: 'c2', started: null }),
      codex({ id: 'c3', state: 'limit' }),
      codex({ id: 'c4', state: 'done', ended: ago(1) }),
    ];
    expect(workCounts(jobs, tasks)).toEqual({ running: 3, queued: 1, gpuWait: 1, limit: 1 });
    expect(workLines(workCounts(jobs, tasks))).toEqual([
      '\u23f3 \uc791\uc5c5 \uc911 3',
      '\u231b \uc2e4\ud589 \ub300\uae30 1',
      '\u231b GPU \ub300\uae30 1',
      '\u231b \ud55c\ub3c4 \ub300\uae30 1',
    ]);
  });
  it('is the same number whatever progress the jobs report: no percent, no merge by text', () => {
    const jobs = [job({ pid: 1, progress: { pct: 45 } }), job({ pid: 2, progress: { pct: 0, indeterminate: true } })];
    expect(workLines(workCounts(jobs, []))).toEqual(['\u23f3 \uc791\uc5c5 \uc911 2']);
  });
  it('drops when a job ends and rises when one starts, from the records alone', () => {
    const one = [job({ pid: 1 })];
    expect(workLines(workCounts(one, []))).toEqual(['\u23f3 \uc791\uc5c5 \uc911 1']);
    const two = [...one, job({ pid: 2 })];
    expect(workLines(workCounts(two, []))).toEqual(['\u23f3 \uc791\uc5c5 \uc911 2']);
    const ended = [one[0], { ...two[1], ended: ago(0), exit: 0 }];
    expect(workLines(workCounts(ended, []))).toEqual(['\u23f3 \uc791\uc5c5 \uc911 1']);
    expect(workLines(workCounts([{ ...one[0], ended: ago(0), exit: 0 }], []))).toEqual([]);
  });
});
