/** TEMP-PLATES: sub-agent spawns and Codex temporaries on the roster, their XP and fatigue. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CodexTask } from '../../../core/src/messages.js';
import { LevelStore, XP_JOB, XP_TOOL, XP_TURN } from './levels.js';
import { RosterStore } from './roster.js';
import { TempStaff } from './tempStaff.js';

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
    live: () => true,
    changed: () => changes++,
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
      live: () => false,
      changed: () => undefined,
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
