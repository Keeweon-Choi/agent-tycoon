/** TEMP-PLATES: a temp character's roster employee, its name in the UI language, its fatigue. */
import { afterEach, describe, expect, it } from 'vitest';

import { STAFF_NAMES } from '../../../core/src/cld/staffNames.js';
import type { CodexTasks, TempEmployee } from '../../../core/src/messages.js';
import { getLanguage, setLanguage } from '../i18n/index.js';
import {
  employeeBusyElsewhere,
  employeeFatigue,
  employeeName,
  employeeOf,
  executionOf,
  setSpawnLookup,
} from './employees.js';
import { FATIGUE } from './ez/rules.js';
import { characterName, showsNameLabel } from './kinds.js';
import { cldHandleMessage, cldResetForTests, virtualAgentId } from './officeStore.js';

const harry = STAFF_NAMES[0];
const tasks = {
  type: 'codexTasks',
  tasks: [
    { id: 'c1', project: 'alpha', agentId: 40, state: 'running' },
    { id: 'w1', project: 'alpha', agentId: 41, state: 'running', agent: 'worker' },
  ],
} as unknown as CodexTasks;
const staff: TempEmployee[] = [
  { execution: 'claude:toolu_a', employeeId: 'e1', nameId: harry.id, project: 'alpha', working: true, contextTokens: 160_000, maxContextTokens: 200_000 },
  { execution: 'codex:c1', employeeId: 'e2', nameId: `${harry.id}#2`, project: 'alpha', working: true },
];
const snap = { codexTasks: tasks, tempStaff: staff };
setSpawnLookup((id) => (id === -3 ? 'toolu_a' : undefined));

afterEach(() => {
  setLanguage('en');
  cldResetForTests();
});

describe('employees', () => {
  it('maps a sub-agent to its spawn and a Codex temporary to its run (never a Worker run)', () => {
    expect(executionOf(-3, tasks)).toBe('claude:toolu_a');
    expect(executionOf(40, tasks)).toBe('codex:c1');
    expect(executionOf(41, tasks)).toBeNull();
    expect(executionOf(-9, tasks)).toBeNull();
    expect(employeeOf(-3, snap)?.employeeId).toBe('e1');
    expect(employeeOf(40, snap)?.employeeId).toBe('e2');
  });

  it('names the employee in the UI language; switching it keeps the employee', () => {
    setLanguage('ko');
    const before = employeeOf(-3, snap)!;
    expect(employeeName(before)).toBe(harry.ko);
    setLanguage('en');
    expect(getLanguage()).toBe('en');
    const after = employeeOf(-3, snap)!;
    expect(after.employeeId).toBe(before.employeeId);
    expect(employeeName(after)).toBe(harry.en);
    expect(employeeName(employeeOf(40, snap)!)).toBe(`${harry.en} 2`);
  });

  it('fatigue: a verified snapshot is shown, a Codex run without usage is unknown', () => {
    expect(employeeFatigue(staff[0], FATIGUE)?.value).toBe(80);
    expect(employeeFatigue(staff[1], FATIGUE)).toBeNull();
  });

  it('a roster sub-agent gets a plate, its name from the roster', () => {
    expect(showsNameLabel('subagent', false, true, true)).toBe(true);
    expect(showsNameLabel('subagent', false, true, false)).toBe(false);
    cldHandleMessage({ ...tasks });
    cldHandleMessage({ type: 'tempStaff', staff });
    expect(characterName({ id: 40 }, null, tasks)).toBe(`${harry.en} 2`);
    expect(characterName({ id: -3, isSubagent: true }, null, tasks, 'fix login')).toBe(harry.en);
    expect(characterName({ id: virtualAgentId('codex:zz') }, null, tasks)).not.toBe(harry.en);
  });

  it('a resting sub-agent keeps its employee and fatigue once the wire moved on (TEMP-STATE)', () => {
    const resting = { codexTasks: tasks, tempStaff: [{ ...staff[0], working: false }] };
    expect(employeeOf(-3, resting)?.nameId).toBe(harry.id);
    expect(employeeBusyElsewhere(-3, resting)).toBe(false);
    // Its employee is back at work on a newer spawn: the wire carries only that one.
    const moved = {
      codexTasks: tasks,
      tempStaff: [{ ...staff[0], execution: 'claude:toolu_b', contextTokens: 1_000 }],
    };
    expect(employeeOf(-3, moved)).toMatchObject({ nameId: harry.id, contextTokens: 160_000 });
    expect(employeeBusyElsewhere(-3, moved)).toBe(true);
    // Ended over an hour ago, off the wire altogether: still the same employee.
    expect(employeeOf(-3, { codexTasks: tasks, tempStaff: [] })?.nameId).toBe(harry.id);
  });
});
