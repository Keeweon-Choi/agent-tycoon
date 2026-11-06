/**
 * A5: the 현황판 dashboard's counts and lists (dashboardModel.ts) and each Lead's ring (statusTree.ts
 * leadRings), read from the store as the daemon's messages fill it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BoardTask, OfficeSnapshot } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import { cldGetSnapshot, cldHandleMessage, cldResetForTests } from '../officeStore.js';
import { activityIcon, approvals, doneAt, doneToday, kpis, taskRows } from './dashboardModel.js';
import { workCounts } from './jobs.js';
import { leadRings } from './statusTree.js';

const NOW = Date.parse('2026-11-06T06:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
beforeEach(() => setLanguage('ko'));
afterEach(() => cldResetForTests());

const task = (id: string, status: BoardTask['status'], msAgo: number, who?: string): BoardTask => ({
  id,
  project: 'p',
  title: id,
  status,
  source: 'reported',
  createdAt: iso(msAgo),
  updatedAt: iso(msAgo),
  history: [],
  ...(who && { owner: { kind: 'lead' as const, name: who } }),
});

const orch = (name: string, order: number) => ({
  name,
  dir: `/w/${name}`,
  tab: 'orch',
  order,
  state: 'running' as const,
  busy: false,
  remoteControl: { on: false, url: null },
  compactions: 0,
  alive: true,
  agentId: 100 + order,
});
const office = (n: number): OfficeSnapshot => ({
  type: 'officeSnapshot',
  readOnly: true,
  tabs: [{ name: 'orch', kind: 'orch', order: 0 }],
  orchestrators: Array.from({ length: n }, (_, k) => orch(`p${k}`, k)),
});
const permission = [{ toolId: 't', status: 'Bash: git push', toolName: 'Bash', done: false, permissionWait: true }];

describe('the Tasks in progress', () => {
  it('in progress only (no to-do), a waiting assignee shows its wait, a blocked one stays blocked; the most urgent first', () => {
    const rows = taskRows(
      [task('A', 'doing', 1000, 'ann'), task('B', 'todo', 500), task('C', 'blocked', 9000, 'ann'), task('D', 'done', 10), task('E', 'review', 100, 'bo')],
      (name) => (name === 'ann' ? 'permission' : null),
      () => true,
    );
    expect(rows.map((r) => [r.task.id, r.pill, r.who])).toEqual([
      ['A', 'permission', 'ann'],
      ['C', 'blocked', 'ann'],
      ['E', 'review', 'bo'],
    ]);
    expect(taskRows([task('A', 'doing', 0)], () => null, () => false)).toEqual([]);
  });

  it("done today counts the viewer's calendar day by when the history says it turned done, not by the last change", () => {
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    const since = NOW - midnight.getTime();
    const line = (msAgo: number, change: string) => ({ at: iso(msAgo), by: 'cli', change });
    const done = (id: string, ...history: BoardTask['history']) => ({ ...task(id, 'done', 0), history });
    const a = done('A', line(since + 9e6, 'add'), line(60_000, 'status doing → done'));
    // Done yesterday, its note changed today: not today's.
    const b = done('B', line(since + 60_000, 'status review → done, owner a → b'), line(1000, 'priority P1 → P0'));
    const c = done('C', line(5000, 'add')); // added already done, today
    const d = done('D'); // imported: no line says when
    expect([a, b, c, d].map(doneAt)).toEqual([iso(60_000), iso(since + 60_000), iso(5000), null]);
    expect(doneAt({ ...a, status: 'doing' })).toBeNull();
    expect(doneToday([a, b, c, d, task('E', 'doing', 0)], NOW)).toBe(2);
  });
});

describe('the count cards', () => {
  it('every card a count; the jobs card names what waits its turn', () => {
    const cards = kpis({
      working: 2,
      waiting: 1,
      tasks: [task('A', 'blocked', 0), { ...task('B', 'done', 0), history: [{ at: iso(0), by: 'cli', change: 'status doing → done' }] }],
      work: workCounts([{ pid: 1, project: 'p', cmd: 'x' }, { pid: 2, project: 'p', cmd: 'y', gpu: 'queued' }], []),
      now: NOW,
    });
    expect(cards.map((k) => [k.id, k.value, k.queued])).toEqual([
      ['working', 2, undefined],
      ['waiting', 1, undefined],
      ['blocked', 1, undefined],
      ['doneToday', 1, undefined],
      ['jobs', 1, 1],
    ]);
  });

  it("each Lead's ring, Workers left out; who waits, permissions first, with the open call", () => {
    cldHandleMessage(office(3));
    const snap = cldGetSnapshot();
    expect(leadRings(snap, { 102: permission }, {}, new Set(['p1']))).toEqual(['idle', 'permission']);
    const list = approvals({ 100: 'question', 102: 'permission' }, snap.officeSnapshot!.orchestrators, { 102: permission }, () => true);
    expect(list.map((a) => [a.name, a.reason, a.what])).toEqual([
      ['p2', 'permission', 'Bash: git push'],
      ['p0', 'question', null],
    ]);
    expect(approvals({ 100: 'question' }, snap.officeSnapshot!.orchestrators, {}, (n) => n !== 'p0')).toEqual([]);
  });
});

describe('the feed marks', () => {
  it('by kind only', () => {
    expect(['job_start', 'job_end', 'codex_worker_end', 'delegate', 'gpu_lease', 'orch_exit', 'stop', 'send'].map(activityIcon)).toEqual([
      'play',
      'flag',
      'flag',
      'scroll',
      'bolt',
      'person',
      'stop',
      'log',
    ]);
  });
});
