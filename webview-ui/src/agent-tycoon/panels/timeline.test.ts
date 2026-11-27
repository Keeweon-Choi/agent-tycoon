import { describe, expect, it } from 'vitest';

import type { BoardTask, CodexTask, OfficeJob } from '../../../../core/src/messages.js';
import { TIMELINE_FUTURE_MS, TIMELINE_HOUR_MS } from '../../constants.js';
import {
  clockText,
  hostMidnight,
  inWindow,
  packLanes,
  placeRuns,
  ticks,
  timelineLinks,
  type TimelineRun,
  timelineRuns,
  timeWindow,
  xOf,
} from './timeline.js';

const NOW = Date.parse('2026-11-27T11:00:00Z'); // 20:00 in Seoul
const KST = 540;
const MIN = 60_000;
const iso = (minAgo: number) => new Date(NOW - minAgo * MIN).toISOString();
const job = (extra: Partial<OfficeJob>): OfficeJob => ({ pid: 1, project: 'alpha', cmd: 'x', ...extra });
const task = (extra: Partial<BoardTask>): BoardTask => ({
  id: 'T-1',
  project: 'alpha',
  title: 'Fix the login',
  status: 'doing',
  source: 'observed',
  createdAt: iso(100),
  updatedAt: iso(1),
  history: [],
  ...extra,
});
const O = { minSpan: 0.1, labelMin: 0, maxLanes: 99, edge: 'now' as const };
const none = { jobs: [], codex: [], subagents: [], tasks: [], leads: new Set<string>(), now: NOW };

describe('the axis', () => {
  it('maps a time to its place, clamped to the window', () => {
    const w = timeWindow('hour', NOW, KST);
    expect(w).toEqual({ from: NOW - TIMELINE_HOUR_MS, to: NOW + TIMELINE_FUTURE_MS, now: NOW });
    expect(xOf(w.from, w)).toBe(0);
    expect(xOf(w.to, w)).toBe(1);
    expect(xOf(NOW - 35 * MIN, w)).toBeCloseTo(25 / 70); // 25 of the 70 minutes in
    expect(xOf(w.from - 5 * MIN, w)).toBe(0);
    expect(xOf(w.to + 5 * MIN, w)).toBe(1);
  });

  it('today is the host day, midnight to midnight, ticks on the host clock', () => {
    const w = timeWindow('today', NOW, KST);
    expect(w.from).toBe(Date.parse('2026-11-26T15:00:00Z')); // 00:00 in Seoul
    expect(w.to - w.from).toBe(24 * 60 * MIN);
    expect(hostMidnight(NOW, 0)).toBe(Date.parse('2026-11-27T00:00:00Z'));
    expect(ticks(w, 'today', KST).map((at) => clockText(at, KST))).toEqual([
      '00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00', '00:00',
    ]);
    const hour = timeWindow('hour', NOW + 3 * MIN, KST);
    expect(ticks(hour, 'hour', KST).map((at) => clockText(at, KST))).toEqual(['19:10', '19:20', '19:30', '19:40', '19:50', '20:00', '20:10']);
  });
});

describe('lane packing', () => {
  it('puts overlapping spans on separate lanes and reuses a lane once it is free', () => {
    expect(packLanes([])).toEqual([]);
    // a 0-0.3, b 0.2-0.5 overlaps a, c 0.3-0.4 starts where a ends, d 0.45-0.6 overlaps b only.
    expect(packLanes([{ x0: 0, x1: 0.3 }, { x0: 0.2, x1: 0.5 }, { x0: 0.3, x1: 0.4 }, { x0: 0.45, x1: 0.6 }])).toEqual([0, 1, 0, 0]);
    // Input order does not matter, the lanes follow the start.
    expect(packLanes([{ x0: 0.5, x1: 0.9 }, { x0: 0, x1: 0.6 }])).toEqual([1, 0]);
  });
});

describe('the runs', () => {
  it('draws finished, failed and running jobs; a job not started yet is not drawn', () => {
    const runs = timelineRuns({
      ...none,
      jobs: [
        job({ id: 'ok', label: 'build', started: iso(50), ended: iso(40), exit: 0 }),
        job({ id: 'bad', label: 'deploy check', started: iso(30), ended: iso(20), exit: 2 }),
        job({ id: 'run', label: 'train', started: iso(10) }),
        job({ id: 'gpu', label: 'waits', created: iso(5), started: null, gpu: 'queued' }),
      ],
    });
    expect(runs.map((r) => [r.key, r.row, r.label, r.end === null, r.failed, r.mark])).toEqual([
      ['job:ok', 'job', 'build', false, false, false],
      ['job:bad', 'job', 'deploy check', false, true, false],
      ['job:run', 'job', 'train', true, false, false],
    ]);
  });

  it('Codex: a failed state reads failed, a queued one is not drawn, a running one is open', () => {
    const c = (id: string, state: CodexTask['state'], extra: Partial<CodexTask> = {}): CodexTask => ({ id, project: 'alpha', state, ...extra });
    const runs = timelineRuns({
      ...none,
      codex: [
        c('f', 'failed', { started: iso(30), ended: iso(25), exit: 1, title: 'worktree fix' }),
        c('q', 'running', { created: iso(3), started: null }),
        c('r', 'running', { started: iso(5) }),
      ],
    });
    expect(runs.map((r) => [r.key, r.failed, r.end === null, r.label])).toEqual([
      ['codex:f', true, false, 'worktree fix'],
      ['codex:r', false, true, null],
    ]);
  });

  it('links a run to the issue it is recorded on; an execution without its record is drawn from the issue', () => {
    const t1 = task({
      executions: [
        { id: 'job:ok', kind: 'job', ref: 'ok', startedAt: iso(50) },
        { id: 'job:gone', kind: 'job', ref: 'gone', startedAt: iso(45), endedAt: { value: iso(44), source: 'observed', at: iso(44) }, exit: { value: 3, source: 'observed', at: iso(44) } },
        { id: 'job:nostart', kind: 'job', ref: 'nostart' },
      ],
    });
    const runs = timelineRuns({ ...none, jobs: [job({ id: 'ok', started: iso(50), ended: iso(40), exit: 0 })], tasks: [t1] });
    expect(runs.map((r) => [r.key, r.issue?.id, r.label, r.failed])).toEqual([
      ['job:ok', 'T-1', null, false],
      ['job:gone', 'T-1', 'Fix the login', true],
    ]);
  });

  it('an issue handed to an agent is a mark on the Lead row only when a Lead handed it', () => {
    const handed = (by: string, ref: string) =>
      task({
        id: `T-${ref}`,
        executions: [{ id: `agent:${ref}`, kind: 'agent', ref, startedAt: iso(20) }],
        history: [{ at: iso(20), by, change: `execution agent:${ref}` }],
      });
    const runs = timelineRuns({ ...none, tasks: [handed('alpha', 'a1'), handed('owner', 'a2')], leads: new Set(['alpha']) });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ key: 'agent:a1', row: 'lead', mark: true, end: null, label: 'Fix the login' });
  });

  it('a sub-agent keeps its stored description and when the daemon saw it start and end', () => {
    const runs = timelineRuns({
      ...none,
      subagents: [
        { execution: 'claude:t1', project: 'alpha', started: iso(12), ended: iso(8), endedBy: 'end', desc: 'unit tests', seen: 'spawn' },
        { execution: 'claude:t2', project: 'alpha', started: iso(3), seen: 'spawn' },
      ],
    });
    expect(runs.filter((r) => r.row === 'subagent').map((r) => [r.key, r.row, r.label, r.end === null])).toEqual([
      ['claude:t1', 'subagent', 'unit tests', false],
      ['claude:t2', 'subagent', null, true],
    ]);
  });
});

describe('the window', () => {
  const run = (start: number, end: number | null, extra: Partial<TimelineRun> = {}): TimelineRun => ({
    key: `k${start}`,
    row: 'job',
    label: null,
    start,
    end,
    mark: false,
    failed: false,
    issue: null,
    source: { kind: 'job', job: job({}) },
    ...extra,
  });

  it('keeps a run that started before the window and still goes, drawn from the left edge to now', () => {
    const w = timeWindow('hour', NOW, KST);
    const long = run(NOW - 90 * MIN, null);
    const over = run(NOW - 90 * MIN, NOW - 70 * MIN);
    expect(inWindow(long, w)).toBe(true);
    expect(inWindow(over, w)).toBe(false);
    const [row] = placeRuns([long, over], w, O);
    expect(row.items).toHaveLength(1);
    expect(row.items[0]).toMatchObject({ x0: 0, clipped: true, lane: 0 });
    expect(row.items[0].x1).toBeCloseTo(xOf(NOW, w));
  });

  it('rows come in the fixed order and only with something in the window; overlaps get their own lane', () => {
    const w = timeWindow('hour', NOW, KST);
    const rows = placeRuns(
      [
        run(NOW - 30 * MIN, NOW - 10 * MIN),
        run(NOW - 20 * MIN, null, { key: 'b' }),
        run(NOW - 40 * MIN, NOW - 39 * MIN, { key: 's', row: 'subagent' }),
        run(NOW - 5 * MIN, null, { key: 'm', row: 'lead', mark: true }),
      ],
      w,
      O,
    );
    expect(rows.map((r) => [r.row, r.lanes])).toEqual([
      ['lead', 1],
      ['subagent', 1],
      ['job', 2],
    ]);
    // A short run holds the minimum room for its label; near the right edge that room is pulled left.
    expect(rows[1].items[0].room).toBe(0.1);
    const [edge] = placeRuns([run(NOW - 2 * MIN, null, { key: 'z', row: 'lead', mark: true })], w, { ...O, minSpan: 0.3 });
    expect(edge.items[0].left).toBeCloseTo(60 / 70 - 0.3); // its room ends on the now line
    expect(edge.items[0].x0).toBeCloseTo(58 / 70);
  });
});

describe('the boss, the Lead and the connectors', () => {
  it("the boss's messages are marks per Lead, close ones grouped (times only); waiting questions are one dashed stretch", () => {
    const runs = timelineRuns({
      ...none,
      contacts: [{ agentId: 7, name: 'alpha', replies: [], ownerAt: [NOW - 40 * MIN, NOW - 38 * MIN, NOW - 10 * MIN] }],
      asks: [
        { name: 'alpha', agentId: 7, since: NOW - 13 * MIN, text: 'Ship rc.9?' },
        { name: 'beta', agentId: 8, since: NOW - 40 * MIN, text: null },
      ],
    });
    const owner = runs.filter((r) => r.row === 'owner');
    expect(owner.map((r) => [r.key, r.mark, r.dashed ?? false, r.start])).toEqual([
      [`owner:alpha:${NOW - 40 * MIN}`, true, false, NOW - 40 * MIN],
      [`owner:alpha:${NOW - 10 * MIN}`, true, false, NOW - 10 * MIN],
      ['wait', false, true, NOW - 40 * MIN],
    ]);
    expect(owner[0].source).toMatchObject({ kind: 'owner', times: [NOW - 40 * MIN, NOW - 38 * MIN] });
  });

  it("a Lead's spawns are one mark per burst, linked to each sub-agent it started", () => {
    const runs = timelineRuns({
      ...none,
      subagents: [
        { execution: 'claude:a', project: 'alpha', started: iso(30), ended: iso(20), seen: 'spawn', spawner: 'alpha' },
        { execution: 'claude:b', project: 'alpha', started: new Date(NOW - 30 * MIN + 20_000).toISOString(), seen: 'spawn', spawner: 'alpha' },
        { execution: 'claude:c', project: 'alpha', started: iso(5), seen: 'spawn', spawner: 'alpha' },
      ],
      leads: new Set(['alpha']),
    });
    const marks = runs.filter((r) => r.row === 'lead');
    expect(marks.map((r) => r.key)).toEqual(['spawn:claude:a', 'spawn:claude:c']);
    expect(timelineLinks(runs)).toEqual([
      { from: 'spawn:claude:a', to: 'claude:a', kind: 'spawn' },
      { from: 'spawn:claude:a', to: 'claude:b', kind: 'spawn' },
      { from: 'spawn:claude:c', to: 'claude:c', kind: 'spawn' },
    ]);
  });

  it('runs on one issue follow each other; a return from review in between is a back link; jobs that share nothing are not linked', () => {
    const t1 = task({
      executions: [
        { id: 'job:j1', kind: 'job', ref: 'j1' },
        { id: 'job:j2', kind: 'job', ref: 'j2' },
        { id: 'job:j3', kind: 'job', ref: 'j3' },
      ],
      // The return is written half a second after j3's start as recorded (job times are whole seconds).
      history: [{ at: new Date(NOW - 20 * MIN + 500).toISOString(), by: 'alpha', change: 'status review → doing, note' }],
    });
    const runs = timelineRuns({
      ...none,
      tasks: [t1],
      jobs: [
        job({ id: 'j1', started: iso(50), ended: iso(40), exit: 0 }),
        job({ id: 'j2', started: iso(30), ended: iso(28), exit: 2 }),
        job({ id: 'j3', started: iso(20) }),
        job({ id: 'other', started: iso(19), ended: iso(18), exit: 0 }),
      ],
    });
    expect(timelineLinks(runs)).toEqual([
      { from: 'job:j1', to: 'job:j2', kind: 'next' },
      { from: 'job:j2', to: 'job:j3', kind: 'back', status: 'doing' },
    ]);
  });
});

describe('the review fixes', () => {
  it('a sub-agent re-bound after a restart keeps its first start, has no observed end and no hand-out mark', () => {
    const runs = timelineRuns({
      ...none,
      leads: new Set(['alpha']),
      subagents: [
        { execution: 'claude:r', project: 'alpha', started: iso(240), ended: iso(1), endedBy: 'end', rebound: true, seen: 'spawn', spawner: 'alpha' },
        { execution: 'claude:t', project: 'alpha', started: iso(20), seen: 'tool', spawner: 'alpha' },
        { execution: 'claude:p', project: 'alpha', started: iso(10), ended: iso(9), seen: 'replay', spawner: 'alpha' },
      ],
    });
    expect(runs.filter((r) => r.row === 'lead')).toEqual([]);
    const by = (k: string) => runs.find((r) => r.key === k)!;
    expect(by('claude:r')).toMatchObject({ start: NOW - 240 * MIN, end: null, mark: true, endUnknown: true });
    expect(by('claude:t')).toMatchObject({ start: NOW - 20 * MIN, end: null, mark: false, startUnseen: true });
    expect(by('claude:p')).toMatchObject({ mark: true, endUnknown: true, startUnseen: true });
  });

  it("only the Lead's own spawns are its marks; a Worker's sub-agents in the same minute are not added to them", () => {
    const at = (s: number) => new Date(NOW - 10 * MIN + s * 1000).toISOString();
    const runs = timelineRuns({
      ...none,
      leads: new Set(['alpha']),
      subagents: [
        { execution: 'claude:l1', project: 'alpha', started: at(0), seen: 'spawn', spawner: 'alpha' },
        { execution: 'claude:w1', project: 'alpha', started: at(10), seen: 'spawn', spawner: 'alpha-w1' },
        { execution: 'claude:w2', project: 'alpha', started: at(20), seen: 'spawn', spawner: 'alpha-w1' },
      ],
    });
    const marks = runs.filter((r) => r.row === 'lead');
    expect(marks).toHaveLength(1);
    expect(marks[0].source).toMatchObject({ kind: 'spawn', spawner: 'alpha', runs: [{ execution: 'claude:l1' }] });
    expect(timelineLinks(runs).map((l) => l.to)).toEqual(['claude:l1']);
  });

  it('a return is a move from review back to work after the earlier run ended; to blocked, or before its end, is not', () => {
    const mk = (change: string, at: number) =>
      timelineLinks(
        timelineRuns({
          ...none,
          tasks: [
            task({
              executions: [
                { id: 'job:a', kind: 'job', ref: 'a' },
                { id: 'job:b', kind: 'job', ref: 'b' },
              ],
              history: [{ at: iso(at), by: 'alpha', change }],
            }),
          ],
          jobs: [job({ id: 'a', started: iso(30), ended: iso(25), exit: 1 }), job({ id: 'b', started: iso(10) })],
        }),
      )[0];
    expect(mk('status review → doing', 20)).toMatchObject({ kind: 'back', status: 'doing' });
    expect(mk('status review → blocked', 20)).toMatchObject({ kind: 'next' });
    expect(mk('status review → doing', 28)).toMatchObject({ kind: 'next' }); // while the earlier run still ran
  });

  it('200 sub-agents in a day: the lanes stop at the cap, short runs carry no label room, the rest is one +N', () => {
    const w = timeWindow('today', NOW, KST);
    const many: TimelineRun[] = Array.from({ length: 200 }, (_, i) => ({
      key: `s${i}`,
      row: 'subagent',
      label: `run ${i}`,
      // Forty bursts of five at once across the day, each a minute long.
      start: w.from + Math.floor(i / 5) * 15 * MIN,
      end: w.from + Math.floor(i / 5) * 15 * MIN + MIN,
      mark: false,
      failed: false,
      issue: null,
      source: { kind: 'job', job: job({}) },
    }));
    const [row] = placeRuns(many, w, { ...O, labelMin: 0.01, maxLanes: 4 });
    expect(row.lanes).toBeLessThanOrEqual(4);
    expect(row.items.every((p) => p.bare)).toBe(true);
    expect(row.items.length + row.overflow.length).toBe(200);
    expect(row.overflow.length).toBeGreaterThan(0);
    // Without the label room a burst of five needs five lanes, not ninety.
    const [loose] = placeRuns(many, w, { ...O, labelMin: 0.01, maxLanes: 99 });
    expect(loose.lanes).toBe(5);
    // A run still going keeps its label (and its elapsed time), however short so far.
    const [open] = placeRuns([{ ...many[0], start: NOW - MIN, end: null }], w, { ...O, labelMin: 0.01 });
    expect(open.items[0].bare).toBe(false);
  });
});
