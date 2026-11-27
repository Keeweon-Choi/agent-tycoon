/** TEMP-PLATES: sub-agent spawns and Codex temporaries on the roster, their XP and fatigue. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CodexTask } from '../../../core/src/messages.js';
import { LevelStore, XP_JOB, XP_TOOL, XP_TURN } from './levels.js';
import { RosterStore } from './roster.js';
import { TEMP_STAFF_RUNS_MAX, TEMP_STAFF_RUNS_MS, TempStaff } from './tempStaff.js';

let dir: string;
let n = 0;
const LEAD = 7;

function office(projects: Record<number, string> = { [LEAD]: 'alpha' }) {
  const levels = new LevelStore(path.join(dir, 'levels.json'), () => undefined, 60_000);
  const roster = new RosterStore(path.join(dir, 'roster.json'), { newId: () => `e${++n}` });
  levels.beforeWrite = () => roster.flushIfDirty();
  let changes = 0;
  const temps = new TempStaff({
    roster,
    levels,
    projectOf: (id) => projects[id] ?? null,
    nameOf: () => null,
    live: () => true,
    changed: () => changes++,
    runsChanged: () => undefined,
  });
  const restart = () => {
    levels.flush();
    return office(projects);
  };
  return { levels, roster, temps, restart, changes: () => changes };
}

const spawn = (toolId: string, extra: Record<string, unknown> = {}) => ({
  type: 'agentToolStart',
  id: LEAD,
  toolId,
  toolName: 'Agent',
  status: 'Subtask: x',
  ...extra,
});
const subTool = (parentToolId: string, toolId: string) => ({
  type: 'subagentToolStart',
  id: LEAD,
  parentToolId,
  toolId,
  status: 'Reading a.ts',
});
const clear = (parentToolId: string) => ({ type: 'subagentClear', id: LEAD, parentToolId });
const xpOf = (o: ReturnType<typeof office>, exec: string) =>
  o.levels.view(`emp:${o.roster.employeeOf(exec)!.id}`)!.xp;
const codexTask = (id: string, state: CodexTask['state'], extra: Partial<CodexTask> = {}): CodexTask => ({
  id,
  project: 'alpha',
  state,
  ...extra,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-staff-'));
  n = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('Claude sub-agents', () => {
  it('binds a spawn to an employee and pays its tools and its finish once, replays included', () => {
    const o = office();
    o.temps.observe(spawn('t1'));
    o.temps.observe(spawn('t1')); // the background re-broadcast
    expect(o.roster.employees('alpha')).toHaveLength(1);
    o.temps.observe(subTool('t1', 's1'));
    o.temps.observe(subTool('t1', 's1')); // a duplicate event
    o.temps.observe(subTool('t1', 's2'));
    o.temps.observe(clear('t1'));
    o.temps.observe(clear('t1')); // twice
    expect(xpOf(o, 'claude:t1')).toBe(2 * XP_TOOL + XP_TURN);
    // A daemon restart and the transcript's tail replayed: nothing is paid again.
    const again = o.restart();
    again.temps.observe(subTool('t1', 's1'));
    again.temps.observe(subTool('t1', 's2'));
    again.temps.observe(clear('t1'));
    expect(xpOf(again, 'claude:t1')).toBe(2 * XP_TOOL + XP_TURN);
  });

  it('a second wave reuses the idle employees and their XP grows; two at once never share one', () => {
    const o = office();
    o.temps.observe(spawn('a'));
    o.temps.observe(spawn('b'));
    const [ea, eb] = [o.roster.employeeOf('claude:a')!.id, o.roster.employeeOf('claude:b')!.id];
    expect(ea).not.toBe(eb);
    for (const t of ['a', 'b']) {
      o.temps.observe(subTool(t, `${t}1`));
      o.temps.observe(clear(t));
    }
    o.temps.observe(spawn('c'));
    o.temps.observe(spawn('d'));
    const wave2 = [o.roster.employeeOf('claude:c')!.id, o.roster.employeeOf('claude:d')!.id];
    expect(wave2.sort()).toEqual([ea, eb].sort());
    o.temps.observe(subTool('c', 'c1'));
    expect(xpOf(o, 'claude:c')).toBeGreaterThan(XP_TOOL + XP_TURN);
  });

  it('ends a foreground spawn with its lead turn cleared, keeps a background one, frees all when the lead goes', () => {
    const o = office();
    o.temps.observe(spawn('fg'));
    o.temps.observe(spawn('bg', { runInBackground: true }));
    o.temps.observe({ type: 'agentToolsClear', id: LEAD });
    expect(o.roster.open('claude:')).toEqual(['claude:bg']);
    o.temps.leadGone(LEAD);
    expect(o.roster.open('claude:')).toEqual([]);
  });

  it('a resumed spawn (started again after its own end) is the same employee, working, until it ends again', () => {
    const o = office();
    o.temps.observe(spawn('a', { runInBackground: true }));
    const nami = o.roster.employeeOf('claude:a')!;
    o.temps.observe(clear('a'));
    o.temps.observe(spawn('b')); // between the runs: b takes the idle employee
    o.temps.observe(clear('b'));
    // SendMessage resumes a: the lead re-arms its original spawn id.
    o.temps.observe(spawn('a', { runInBackground: true }));
    o.temps.observe(spawn('c')); // a new spawn while a runs again must not take its employee
    expect(o.roster.employeeOf('claude:a')!.id).toBe(nami.id);
    expect(o.roster.employeeOf('claude:c')!.id).not.toBe(nami.id);
    const row = o.temps.message().staff.find((s) => s.execution === 'claude:a');
    expect(row).toMatchObject({ employeeId: nami.id, nameId: nami.nameId, working: true });
    o.temps.observe(clear('a'));
    expect(o.roster.open('claude:')).toEqual(['claude:c']);
  });

  it('a start replayed before the history read is over does not reopen an ended spawn', () => {
    const o = office();
    o.temps.observe(spawn('a'));
    o.temps.observe(clear('a'));
    const replay = new TempStaff({
      roster: o.roster,
      levels: o.levels,
      projectOf: () => 'alpha',
      nameOf: () => null,
      live: () => false,
      changed: () => undefined,
      runsChanged: () => undefined,
    });
    replay.observe(spawn('a'));
    expect(o.roster.open('claude:')).toEqual([]);
  });

  it('skips teammate spawns and leads without a project', () => {
    const o = office();
    o.temps.observe(spawn('tm', { isTeammateSpawn: true }));
    o.temps.observe({ ...spawn('v'), id: 99 });
    expect(o.roster.allEmployees()).toEqual([]);
  });

  it('carries a sub-agent’s own context snapshot to its plate', () => {
    const o = office();
    o.temps.observe(spawn('t1'));
    o.temps.context(LEAD, 't1', 50_000, 200_000);
    const row = o.temps.message().staff.find((s) => s.execution === 'claude:t1')!;
    expect(row).toMatchObject({ working: true, contextTokens: 50_000, maxContextTokens: 200_000 });
    expect(row.level).toMatchObject({ level: 1, xp: 0 });
  });

  it('carries the limit basis and the compactions counted in the sub-agent’s own transcript, across a restart', () => {
    const o = office();
    o.temps.observe(spawn('t1'));
    o.temps.compactions(LEAD, 't1', 1); // no context yet: nowhere to hold it
    expect(o.temps.message().staff[0].compactions).toBeUndefined();
    o.temps.context(LEAD, 't1', 50_000, 200_000, 'estimated');
    o.temps.compactions(LEAD, 't1', 2);
    o.temps.context(LEAD, 't1', 12_000, 200_000, 'estimated'); // the next usage keeps the count
    const want = { contextTokens: 12_000, limitBasis: 'estimated', compactions: 2 };
    expect(o.temps.message().staff[0]).toMatchObject(want);
    expect(o.restart().temps.message().staff[0]).toMatchObject(want);
    // none counted: no field, not a 0
    const fresh = office();
    fresh.temps.observe(spawn('t2'));
    fresh.temps.context(LEAD, 't2', 1_000, 200_000, 'unknown');
    expect(fresh.temps.message().staff[0]).toMatchObject({ limitBasis: 'unknown' });
    expect(fresh.temps.message().staff[0]).not.toHaveProperty('compactions');
  });

  it('keeps the last known context after the sub-agent finished and across a daemon restart', () => {
    const o = office();
    o.temps.observe(spawn('t1'));
    o.temps.context(LEAD, 't1', 50_000, 200_000);
    o.temps.observe(clear('t1'));
    const ctx = { contextTokens: 50_000, maxContextTokens: 200_000 };
    expect(o.temps.message().staff[0]).toMatchObject({ working: false, ...ctx });
    expect(o.restart().temps.message().staff[0]).toMatchObject({ working: false, ...ctx });
  });
});

describe('T-185: sub-agent runs for the 타임라인', () => {
  let clock = 0;
  let runsSent = 0;
  const names: Record<number, string> = { [LEAD]: 'alpha', 9: 'alpha-w1' };
  function timed(start = Date.parse('2026-11-27T10:00:00Z')) {
    clock = start;
    runsSent = 0;
    const levels = new LevelStore(path.join(dir, 'levels.json'), () => undefined, 60_000);
    const roster = new RosterStore(path.join(dir, 'roster.json'), { newId: () => `e${++n}`, now: () => clock });
    let live = true;
    const temps = new TempStaff({
      roster,
      levels,
      projectOf: () => 'alpha',
      nameOf: (id) => names[id] ?? null,
      live: () => live,
      changed: () => undefined,
      runsChanged: () => runsSent++,
      now: () => clock,
    });
    return { roster, temps, setLive: (v: boolean) => (live = v) };
  }

  it('sends each spawn with its start, its end, how it ended, its description and who started it; a day-old end drops out', () => {
    const { roster, temps } = timed();
    temps.observe(spawn('old', { desc: '어제 검사' }));
    temps.observe(clear('old'));
    clock += TEMP_STAFF_RUNS_MS + 1;
    temps.observe(spawn('a', { desc: '단위 테스트' }));
    clock += 60_000;
    temps.observe(clear('a'));
    temps.observe(spawn('b'));
    const { runs } = temps.runsMessage();
    expect(runs.map((r) => r.execution).sort()).toEqual(['claude:a', 'claude:b']);
    expect(runs.find((r) => r.execution === 'claude:a')).toEqual({
      execution: 'claude:a',
      project: 'alpha',
      started: new Date(clock - 60_000).toISOString(),
      ended: new Date(clock).toISOString(),
      endedBy: 'end',
      desc: '단위 테스트',
      employeeId: roster.employeeOf('claude:a')!.id,
      spawner: 'alpha',
      seen: 'spawn',
    });
    // Still running: no end; no description given: none made up.
    expect(runs.find((r) => r.execution === 'claude:b')).toEqual({
      execution: 'claude:b',
      project: 'alpha',
      started: new Date(clock).toISOString(),
      employeeId: roster.employeeOf('claude:b')!.id,
      spawner: 'alpha',
      seen: 'spawn',
    });
  });

  it('a spawn that outlives a restart keeps its first start and is marked re-bound (its end is not an observed one)', () => {
    const before = timed();
    before.temps.observe(spawn('a', { desc: 'long one' }));
    // 14:00: the daemon starts again; the start-up replay sees the spawn, then its end.
    clock += 4 * 60 * 60_000;
    const after = timed(clock);
    after.setLive(false);
    after.temps.observe(spawn('a', { desc: 'long one' }));
    clock += 60_000;
    after.temps.observe(clear('a'));
    const run = after.temps.runsMessage().runs[0];
    expect(run).toMatchObject({ started: '2026-11-27T10:00:00.000Z', rebound: true, seen: 'spawn' });
  });

  it("a sub-agent first seen by one of its tools says so; a Worker's spawn names the Worker", () => {
    const { temps } = timed();
    temps.observe(subTool('t9', 's1')); // its spawn was missed
    temps.observe({ ...spawn('w1'), id: 9 });
    const runs = temps.runsMessage().runs;
    expect(runs.find((r) => r.execution === 'claude:t9')).toMatchObject({ seen: 'tool', spawner: 'alpha' });
    expect(runs.find((r) => r.execution === 'claude:w1')).toMatchObject({ seen: 'spawn', spawner: 'alpha-w1' });
  });

  it('the runs go out only when a binding is made, released or re-bound, never on a context update; at most TEMP_STAFF_RUNS_MAX, the newest', () => {
    const { temps } = timed();
    temps.observe(spawn('a'));
    expect(runsSent).toBe(1);
    temps.context(LEAD, 'a', 1_000, 200_000);
    temps.compactions(LEAD, 'a', 1);
    expect(runsSent).toBe(1);
    temps.observe(clear('a'));
    expect(runsSent).toBe(2);
    for (let i = 0; i < TEMP_STAFF_RUNS_MAX + 5; i++) {
      clock += 1_000;
      temps.observe(spawn(`x${i}`)); // open: the roster keeps every open one (it prunes ended ones)
    }
    const msg = temps.runsMessage();
    expect(msg.runs).toHaveLength(TEMP_STAFF_RUNS_MAX);
    expect(msg.runs.some((r) => r.execution === `claude:x${TEMP_STAFF_RUNS_MAX + 4}`)).toBe(true);
    expect(msg.runs.some((r) => r.execution === 'claude:a')).toBe(false);
    // The record no longer reaches back to the day's first runs: it says from when it is whole.
    expect(msg.prunedBefore).toBeDefined();
  });
});

describe('Codex temporaries', () => {
  it('binds a running run, pays XP_JOB once when done, and has no context (unknown fatigue)', () => {
    const o = office();
    o.temps.codex([codexTask('c1', 'running'), codexTask('w1', 'running', { agent: 'worker' })]);
    expect(o.roster.open('codex:')).toEqual(['codex:c1']); // a Worker's run is not a temp
    const row = o.temps.message().staff[0];
    expect(row.execution).toBe('codex:c1');
    expect(row.contextTokens).toBeUndefined();
    o.temps.codex([codexTask('c1', 'done')]);
    o.temps.codex([codexTask('c1', 'done')]);
    expect(xpOf(o, 'codex:c1')).toBe(XP_JOB);
    expect(o.temps.message().staff[0].working).toBe(false);
  });

  it('releases a run whose record is gone; a failed run earns nothing', () => {
    const o = office();
    o.temps.codex([codexTask('c1', 'running'), codexTask('c2', 'running')]);
    o.temps.codex([codexTask('c2', 'failed')]);
    expect(o.roster.open('codex:')).toEqual([]);
    expect(xpOf(o, 'codex:c2')).toBe(0);
  });
});
