import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STAFF_NAMES } from '../../../core/src/cld/staffNames.js';
import type { OfficeSnapshot, TempEmployee } from '../../../core/src/messages.js';
import { HOME_GRACE_MS } from '../constants.js';
import { setLanguage } from '../i18n/index.js';
import { OfficeState } from '../office/engine/officeState.js';
import type { OfficeLayout } from '../office/types.js';
import { TILE_SIZE, TileType } from '../office/types.js';
import { cldDrawSpeechLinks } from './ez/drawVisuals.js';
import { publishCharacterRing, publishCharacterVisual } from './ez/visuals.js';
import { DEFAULT_HOURS, presenceOf, setOfficeHours } from './officeHours.js';
import { cldGetSnapshot, cldHandleMessage, cldResetForTests } from './officeStore.js';
import {
  deferRemoval,
  noteSubagent,
  reviveSubagent,
  staffResetForTests,
  staffSnapshot,
  staffStep,
} from './staff.js';

const MIN = 60_000;
beforeEach(() => setLanguage('ko'));

/** A walled room with one door in the bottom wall (col 4). */
function room(): OfficeLayout {
  const cols = 9;
  const rows = 7;
  const tiles = Array.from({ length: cols * rows }, (_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const edge = c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
    return edge && !(r === rows - 1 && c === 4) ? TileType.WALL : TileType.FLOOR_1;
  });
  return { version: 1, cols, rows, tiles, furniture: [] };
}

/** Two floors of room(), stacked with a void row between (the daemon's `cldFloors`). */
function twoFloors(): OfficeLayout {
  const one = room();
  const gap = Array.from({ length: one.cols }, () => TileType.VOID);
  return {
    ...one,
    rows: one.rows * 2 + 1,
    tiles: [...one.tiles, ...gap, ...one.tiles],
    cldFloors: [
      { id: '1', row: 0, rows: one.rows, cols: one.cols },
      { id: '2', row: one.rows + 1, rows: one.rows, cols: one.cols },
    ],
  } as OfficeLayout;
}

function office(names: Array<[string, number]>, layout = room()): OfficeState {
  cldHandleMessage({
    type: 'officeSnapshot',
    tabs: [],
    orchestrators: names.map(([name, agentId]) => ({ name, agentId, state: 'running' })),
  } as unknown as OfficeSnapshot);
  const os = new OfficeState(layout);
  for (const [, id] of names) os.addAgent(id, 0, 0, undefined, true);
  return os;
}

/** Steps of the office and the director, `s` game seconds at `now`. */
function run(os: OfficeState, now: number, s = 1): void {
  for (let t = 0; t < s; t += 0.1) {
    os.update(0.1);
    staffStep(os, 0.1, now);
  }
}

afterEach(() => {
  staffResetForTests();
  cldResetForTests();
});

describe('temps (T-0041)', () => {
  it('a sub-agent lingers until its lead is done and the linger time passed, then walks out', () => {
    const os = office([['lead', 1]]);
    const t0 = Date.now();
    run(os, t0, 4); // the office came up a while ago
    const sub = os.addSubagent(1, 'tu-a');
    noteSubagent(sub, 'fix login', 'sonnet');
    run(os, t0);
    expect(staffSnapshot().temps).toMatchObject([
      { id: sub, leadId: 1, name: 'fix login', model: 'sonnet', phase: 'working' },
    ]);
    let gone = false;
    // What useExtensionMessages hands over: the upstream removal.
    const final = () => {
      gone = true;
      os.removeSubagent(1, 'tu-a');
    };
    expect(deferRemoval(sub, final)).toBe(true);
    // The lead's turn goes on: it stays however long.
    run(os, t0 + 30 * MIN);
    expect(staffSnapshot().temps[0]?.phase).toBe('lingering');
    os.setAgentActive(1, false);
    run(os, t0 + 9 * MIN);
    expect(gone).toBe(false);
    run(os, t0 + 11 * MIN, 20); // out of the door
    expect(staffSnapshot().temps).toEqual([]);
    expect(gone).toBe(true);
    expect(cldGetSnapshot().events[0]).toMatchObject({ kind: 'temp', name: 'lead' });
    expect(cldGetSnapshot().events[0].summary).toMatch(/^fix login · \ub05d \(\d+\ubd84\)$/);
  });

  it('a temp that gets work again comes back as the same character', () => {
    const os = office([['lead', 1]]);
    const t0 = Date.now();
    run(os, t0, 4);
    const sub = os.addSubagent(1, 'tu-a');
    noteSubagent(sub, 'fix login', undefined);
    run(os, t0);
    deferRemoval(sub, () => {});
    os.setAgentActive(1, false);
    run(os, t0 + MIN);
    expect(staffSnapshot().temps[0]?.phase).toBe('lingering');
    // The lead resumes it: a new spawn with the same task.
    expect(reviveSubagent(os, 1, 'tu-b', 'fix login', 'opus')).toBe('tu-a');
    expect(os.addSubagent(1, 'tu-b')).toBe(sub);
    run(os, t0 + 2 * MIN);
    expect(staffSnapshot().temps).toMatchObject([{ id: sub, phase: 'working', model: 'opus' }]);
    // Another task is someone new.
    expect(reviveSubagent(os, 1, 'tu-c', 'write docs', undefined)).toBe(null);
  });

  it('a resting sub-agent keeps its name, and walks out once its employee is back at work elsewhere (TEMP-STATE)', () => {
    const os = office([['lead', 1]]);
    const t0 = Date.now();
    run(os, t0, 4);
    const sub = os.addSubagent(1, 'tu-a');
    noteSubagent(sub, 'fix login', undefined);
    const employee = (execution: string, working: boolean): TempEmployee => ({
      execution,
      employeeId: 'e1',
      nameId: STAFF_NAMES[0].id,
      project: 'lead',
      working,
    });
    cldHandleMessage({ type: 'tempStaff', staff: [employee('claude:tu-a', true)] });
    run(os, t0);
    deferRemoval(sub, () => os.removeSubagent(1, 'tu-a'));
    cldHandleMessage({ type: 'tempStaff', staff: [employee('claude:tu-a', false)] });
    run(os, t0 + MIN); // the lead works on: it rests however long
    expect(staffSnapshot().temps[0]).toMatchObject({ phase: 'lingering', name: STAFF_NAMES[0].ko });
    // A new spawn took the same employee: the wire now carries only that execution.
    cldHandleMessage({ type: 'tempStaff', staff: [employee('claude:tu-b', true)] });
    run(os, t0 + 2 * MIN, 0.3);
    expect(staffSnapshot().temps[0]).toMatchObject({ phase: 'leaving', name: STAFF_NAMES[0].ko });
  });
});

describe('the 🤝 dotted line follows the sub-agents still in the office (LINKS)', () => {
  const dots = (os: OfficeState) => {
    let n = 0;
    const ctx = { fillRect: () => n++, set fillStyle(_v: string) {} } as unknown as CanvasRenderingContext2D;
    // The sub-agents drawn 100 px off, so a line has room for its dots.
    const far = os.getCharacters().map((c) => (c.isSubagent ? { ...c, x: c.x + 100 } : c));
    cldDrawSpeechLinks(ctx, far, 0, 0, 1);
    return n;
  };

  beforeEach(() => setOfficeHours({ on: false })); // open whatever the wall clock says
  afterEach(() => {
    publishCharacterVisual(1, undefined);
    setOfficeHours(DEFAULT_HOURS);
  });

  it('runs to a working and a resting sub-agent, not to one walking out, nor to one gone', () => {
    const os = office([['lead', 1]]);
    publishCharacterVisual(1, { icon: '🤝', text: '', prop: 'link', ring: 'idle' });
    const t0 = Date.now();
    run(os, t0, 4);
    const sub = os.addSubagent(1, 'tu-a');
    noteSubagent(sub, 'fix login', undefined);
    run(os, t0);
    expect(dots(os)).toBeGreaterThan(0); // working
    deferRemoval(sub, () => os.removeSubagent(1, 'tu-a'));
    os.setAgentActive(1, false);
    run(os, t0 + MIN);
    expect(staffSnapshot().temps[0]?.phase).toBe('lingering');
    expect(dots(os)).toBeGreaterThan(0); // resting: the owner's call, unchanged
    run(os, t0 + 11 * MIN, 0.3); // set off for the door
    expect(staffSnapshot().temps[0]?.phase).toBe('leaving');
    expect(os.characters.get(sub)).toBeDefined();
    expect(dots(os)).toBe(0);
    run(os, t0 + 11 * MIN, 20); // out of the door
    expect(os.characters.get(sub)).toBeUndefined();
    expect(dots(os)).toBe(0);
  });

  it('never runs to a sub-agent on another floor than its lead (TEMP-STATE)', () => {
    const os = office([['lead', 1]], twoFloors());
    publishCharacterVisual(1, { icon: '🤝', text: '', prop: 'link', ring: 'idle' });
    const t0 = Date.now();
    run(os, t0, 4);
    const sub = os.addSubagent(1, 'tu-a');
    noteSubagent(sub, 'fix login', undefined);
    run(os, t0);
    const lead = os.characters.get(1)!;
    const ch = os.characters.get(sub)!;
    const rows = room().rows;
    const onFloor = (k: number) => {
      ch.tileRow = k * (rows + 1) + 3;
      ch.y = ch.tileRow * TILE_SIZE + TILE_SIZE / 2;
    };
    const leadFloor = lead.tileRow > rows ? 1 : 0;
    onFloor(leadFloor);
    expect(dots(os)).toBeGreaterThan(0);
    onFloor(1 - leadFloor);
    expect(dots(os)).toBe(0);
  });
});

describe('office hours (T-0041)', () => {
  it('after hours a working orchestrator does overtime, an idle one goes home and comes back at 09:00', () => {
    cldHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    const os = office([
      ['busy', 1],
      ['idle', 2],
    ]);
    os.setAgentActive(2, false);
    const evening = Date.UTC(2026, 9, 21, 20, 0); // a Wednesday
    run(os, evening, 4);
    expect(staffSnapshot().overtime).toEqual([1]);
    expect(Object.keys(staffSnapshot().away)).toEqual(['2']);
    expect(os.characters.get(2)?.cldAway).toBe(true);
    expect(os.getCharacters().map((c) => c.id)).toEqual([1]); // not drawn
    run(os, Date.UTC(2026, 9, 22, 9, 0), 4);
    expect(staffSnapshot().away).toEqual({});
    expect(staffSnapshot().overtime).toEqual([]);
    expect(os.characters.get(2)?.cldAway).toBe(false);
  });

  it('who is on overtime follows each one\'s own ring, never what the FSM says of a character on a floor not shown (CARD-TAGS)', () => {
    cldHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    const os = office([
      ['busy', 1],
      ['idle', 2],
    ]);
    // The overlay publishes every ring, drawn floor or not: the lead is mid-thought (its FSM
    // may rest), the other rests while its FSM still says active (a synthetic character never hears otherwise).
    os.setAgentActive(1, false);
    publishCharacterRing(1, 'working');
    publishCharacterRing(2, 'idle');
    run(os, Date.UTC(2026, 9, 21, 20, 0), 4);
    expect(staffSnapshot().overtime).toEqual([1]);
    expect(Object.keys(staffSnapshot().away)).toEqual(['2']);
    for (const id of [1, 2]) publishCharacterRing(id, undefined);
  });

  it('an idle orchestrator walks out at closing time, after a short grace', () => {
    cldHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    const os = office([['idle', 2]]);
    os.setAgentActive(2, false);
    run(os, Date.UTC(2026, 9, 21, 17, 59), 4);
    expect(staffSnapshot().away).toEqual({});
    run(os, Date.UTC(2026, 9, 21, 18, 0));
    expect(staffSnapshot().away).toEqual({}); // the grace
    expect(staffSnapshot().overtime).toEqual([2]); // still in the office after hours: overtime until it goes home (PRESENCE-SYNC)
    run(os, Date.UTC(2026, 9, 21, 18, 0) + HOME_GRACE_MS - MIN, 20);
    expect(staffSnapshot().away).toEqual({}); // still the grace (the owner's messages pause longer than a turn)
    run(os, Date.UTC(2026, 9, 21, 18, 0) + HOME_GRACE_MS + MIN, 20);
    expect(Object.keys(staffSnapshot().away)).toEqual(['2']);
    expect(staffSnapshot().overtime).toEqual([]); // gone home: no longer overtime
    expect(presenceOf(staffSnapshot(), 2)).toBe('away');
  });

  it('a renewing orchestrator stays at work on a closed day; without the renewal it goes home (RENEW-STUCK)', () => {
    cldHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    const os = office([
      ['renewing', 1],
      ['idle', 2],
    ]);
    cldHandleMessage({
      type: 'officeSnapshot',
      tabs: [],
      orchestrators: [
        { name: 'renewing', agentId: 1, state: 'running', renewing: true },
        { name: 'idle', agentId: 2, state: 'running' },
      ],
    } as unknown as OfficeSnapshot);
    os.setAgentActive(1, false);
    os.setAgentActive(2, false);
    const saturday = Date.UTC(2026, 9, 24, 16, 20);
    for (let s = 0; s < 6; s++) run(os, saturday + s * MIN, 5);
    expect(Object.keys(staffSnapshot().away)).toEqual(['2']);
    expect(os.characters.get(1)?.cldAway).toBe(false);
  });

  it('an off orchestrator after hours is home (\ud1f4\uadfc), never on overtime', () => {
    cldHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    const os = office([
      ['busy', 1],
      ['sleeper', 2],
    ]);
    // Off: the office says so, whatever the character's own default activity.
    cldHandleMessage({
      type: 'officeSnapshot',
      tabs: [],
      orchestrators: [
        { name: 'busy', agentId: 1, state: 'running' },
        { name: 'sleeper', agentId: 2, state: 'off' },
      ],
    } as unknown as OfficeSnapshot);
    // Live: at the desk before closing, never 야근 after it, then home.
    run(os, Date.UTC(2026, 9, 21, 17, 59), 4);
    for (const mm of [0, 0, 1, 1, 1]) {
      run(os, Date.UTC(2026, 9, 21, 18, mm), 5);
      expect(staffSnapshot().overtime).toEqual([1]);
    }
    expect(Object.keys(staffSnapshot().away)).toEqual(['2']);
    // And on a page opened at 23:00.
    staffResetForTests();
    const night = office([['busy', 1]]);
    night.addAgent(2, 0, 0, undefined, true);
    cldHandleMessage({
      type: 'officeSnapshot',
      tabs: [],
      orchestrators: [
        { name: 'busy', agentId: 1, state: 'running' },
        { name: 'sleeper', agentId: 2, state: 'off' },
      ],
    } as unknown as OfficeSnapshot);
    run(night, Date.UTC(2026, 9, 21, 23, 0), 4);
    expect(staffSnapshot().overtime).toEqual([1]);
    expect(Object.keys(staffSnapshot().away)).toEqual(['2']);
  });
});

describe('the load shows the steady state at once (T-0041 bug, 10-22)', () => {
  const at = (hh: number, mm = 0) => Date.UTC(2026, 9, 21, hh, mm); // a Wednesday, host on UTC
  const drawn = (os: OfficeState) => os.getCharacters().map((c) => c.id);
  /** Steps `s` game seconds at `now`, checking every frame. */
  function watch(os: OfficeState, now: number, s: number, each: () => void): void {
    for (let t = 0; t < s; t += 0.1) {
      os.update(0.1);
      staffStep(os, 0.1, now);
      each();
    }
  }

  it('at 23:00 with 3 idle and 1 working, only the working one is ever drawn and nobody walks out', () => {
    cldHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    const os = office([
      ['busy', 1],
      ['a', 2],
      ['b', 3],
      ['c', 4],
    ]);
    for (const id of [2, 3, 4]) os.setAgentActive(id, false);
    watch(os, at(23), 30, () => {
      expect(drawn(os).filter((id) => id !== 1)).toEqual([]);
      for (const id of [2, 3, 4]) expect(os.characters.get(id)?.path).toEqual([]);
    });
    expect(drawn(os)).toEqual([1]);
    expect(staffSnapshot().overtime).toEqual([1]);
    expect(Object.keys(staffSnapshot().away).sort()).toEqual(['2', '3', '4']);
  });

  it('at 10:00 a temp whose work ended 30 minutes ago is not shown at all', () => {
    cldHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    const os = office([['lead', 1]]);
    const ended = new Date(at(9, 30)).toISOString();
    cldHandleMessage({
      type: 'codexTasks',
      tasks: [{ id: 't1', project: 'lead', state: 'done', ended, agentId: 50 }],
    } as never);
    os.addAgent(50, 0, 0, undefined, true, 'codex·lead');
    watch(os, at(10), 5, () => expect(drawn(os)).not.toContain(50));
    expect(os.characters.has(50)).toBe(false);
    expect(staffSnapshot().temps).toEqual([]);
    expect(cldGetSnapshot().events).toEqual([]); // no "끝" line: it left before we looked
  });

  it('at 10:00 a working temp is placed, with no walk in', () => {
    cldHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    const os = office([['lead', 1]]);
    const sub = os.addSubagent(1, 'tu-a');
    noteSubagent(sub, 'fix login', undefined);
    const ch = () => os.characters.get(sub)!;
    let seen: number[] | null = null;
    watch(os, at(10), 5, () => {
      if (!drawn(os).includes(sub)) return;
      expect(ch().matrixEffect).toBe(null); // no spawn effect either
      expect(ch().path).toEqual([]);
      seen ??= [ch().tileCol, ch().tileRow];
      expect([ch().tileCol, ch().tileRow]).toEqual(seen);
    });
    expect(drawn(os)).toContain(sub);
    expect(staffSnapshot().temps).toMatchObject([{ id: sub, phase: 'working' }]);
  });

  it('the state arriving 2 s after the characters: no flash of everyone', () => {
    staffResetForTests({ holdWithoutOffice: true }); // as in the browser
    cldHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    const os = new OfficeState(room());
    for (const id of [1, 2, 3]) os.addAgent(id, 0, 0, undefined, true);
    os.setAgentActive(2, false);
    os.setAgentActive(3, false);
    watch(os, at(23), 2, () => expect(drawn(os)).toEqual([]));
    cldHandleMessage({
      type: 'officeSnapshot',
      tabs: [],
      orchestrators: [1, 2, 3].map((agentId) => ({
        name: `o${agentId}`,
        agentId,
        state: 'running',
      })),
    } as unknown as OfficeSnapshot);
    watch(os, at(23), 10, () => expect(drawn(os).filter((id) => id !== 1)).toEqual([]));
    expect(drawn(os)).toEqual([1]);
  });
});
