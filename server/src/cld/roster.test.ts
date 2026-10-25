/** TEMP-PLATES: the roster names (the owner's six conditions) and the roster store. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVE_STAFF_NAMES,
  splitNameId,
  STAFF_NAMES,
  staffName,
} from '../../../core/src/cld/staffNames.js';
import { freeNameId, RosterStore, type Work } from './roster.js';

/** The pre-v1.0 list (task/codex-1022-195011 core/src/cld/names.ts), names only. */
const OLD_NAMES: string[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'old-staff-names.json'), 'utf-8'),
);
const CLAUDE: Work = { provider: 'claude' };
let dir: string;
let file: string;
let clock: number;
let n = 0;
const store = (seed = 1) => {
  let r = seed;
  return new RosterStore(file, {
    now: () => clock,
    newId: () => `e${++n}`,
    // A fixed sequence: tests never depend on Math.random.
    random: () => ((r = (r * 9301 + 49297) % 233280) / 233280),
  });
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  file = path.join(dir, 'roster.json');
  clock = 1_000;
  n = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the names (roster v1.0)', () => {
  const active = STAFF_NAMES.filter((n) => n.status === 'active');
  const excluded = new Set([
    ...OLD_NAMES.filter((ko) => !active.some((n) => n.ko === ko)),
    ...STAFF_NAMES.filter((n) => n.status !== 'active').map((n) => n.ko),
  ]);

  it('hires only from the active rows, counted from the data', () => {
    expect(ACTIVE_STAFF_NAMES).toEqual(active);
    expect(ACTIVE_STAFF_NAMES.length).toBe(STAFF_NAMES.length - STAFF_NAMES.filter((n) => n.status === 'held').length);
  });

  it('has no duplicate id, ko or en, and every id has both forms', () => {
    for (const key of ['id', 'ko', 'en'] as const)
      expect(new Set(STAFF_NAMES.map((n) => n[key])).size).toBe(STAFF_NAMES.length);
    for (const n of STAFF_NAMES) {
      expect(n.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(n.ko.trim()).toBe(n.ko);
      expect(n.en.trim()).toBe(n.en);
      expect(n.ko && n.en).toBeTruthy();
      expect(staffName(n.id, 'ko')).toBe(n.ko);
      expect(staffName(n.id, 'en')).toBe(n.en);
    }
  });

  it('never hires under an old-list name that is not active, nor a held row, even when every active name is taken', () => {
    expect(excluded.size).toBeGreaterThan(0);
    const s = store();
    const shown: string[] = [];
    for (let i = 0; i < ACTIVE_STAFF_NAMES.length * 2 + 3; i++) {
      const e = s.bind('alpha', `claude:t${i}`, CLAUDE)!;
      shown.push(staffName(e.nameId, 'ko'));
    }
    for (const ko of shown) expect(excluded.has(ko.replace(/ \d+$/, ''))).toBe(false);
    // Names unique in the project; past the active list, numbered repeats of active names.
    expect(new Set(shown).size).toBe(shown.length);
    const ids = s.employees('alpha').map((e) => e.nameId);
    expect(ids.slice(0, ACTIVE_STAFF_NAMES.length).sort()).toEqual(ACTIVE_STAFF_NAMES.map((n) => n.id).sort());
    expect(ids[ACTIVE_STAFF_NAMES.length]).toBe(`${ACTIVE_STAFF_NAMES[0].id}#2`);
    expect(staffName(ids[ACTIVE_STAFF_NAMES.length], 'en')).toBe(`${ACTIVE_STAFF_NAMES[0].en} 2`);
    expect(ids.at(-1)).toBe(`${ACTIVE_STAFF_NAMES[2].id}#3`);
  });

  it('freeNameId skips held rows and fills the numbered fallback in order', () => {
    const held = STAFF_NAMES.filter((n) => n.status === 'held').map((n) => n.id);
    for (let i = 0; i < 50; i++) expect(held).not.toContain(freeNameId(new Set(), () => i / 50));
    const all = new Set(ACTIVE_STAFF_NAMES.map((n) => n.id));
    expect(freeNameId(all)).toBe(`${ACTIVE_STAFF_NAMES[0].id}#2`);
    expect(splitNameId('harry-potter#2')).toEqual({ base: 'harry-potter', n: 2 });
  });

  it('keeps an existing employee under an excluded name untouched, and it keeps working', () => {
    const heldId = STAFF_NAMES.find((n) => n.status === 'held')!.id;
    const oldName = `legacy:${OLD_NAMES.find((ko) => excluded.has(ko))}`;
    const record = {
      v: 1,
      projects: {
        alpha: {
          employees: [
            { id: 'old1', nameId: heldId, hiredAt: 5, lastReleasedAt: 10, execution: null },
            { id: 'old2', nameId: oldName, hiredAt: 6, lastReleasedAt: 20, execution: null },
          ],
          executions: {},
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(record));
    const s = store();
    expect(s.employees('alpha')).toEqual(record.projects.alpha.employees);
    // Longest idle first: the held-name employee comes back to work under its own name.
    expect(s.bind('alpha', 'claude:a', CLAUDE)).toMatchObject({ id: 'old1', nameId: heldId });
    expect(s.bind('alpha', 'claude:b', CLAUDE)).toMatchObject({ id: 'old2', nameId: oldName });
    expect(staffName(heldId, 'ko')).toBe(STAFF_NAMES.find((n) => n.id === heldId)!.ko);
    expect(staffName(oldName, 'en')).toBe(oldName); // an id the list does not know shows as it is
    // A new hire never takes the excluded names.
    const hire = s.bind('alpha', 'claude:c', CLAUDE)!;
    expect([heldId, oldName]).not.toContain(hire.nameId);
  });
});

describe('the roster store', () => {
  it('gives work to the longest-idle suitable employee, else hires', () => {
    const s = store();
    const a = s.bind('alpha', 'claude:1', CLAUDE)!;
    const b = s.bind('alpha', 'claude:2', CLAUDE)!;
    expect(a.id).not.toBe(b.id);
    clock = 2_000;
    s.release('claude:2');
    clock = 3_000;
    s.release('claude:1');
    clock = 4_000;
    // b has been idle since 2000, a since 3000: b first.
    expect(s.bind('alpha', 'claude:3', CLAUDE)!.id).toBe(b.id);
    expect(s.bind('alpha', 'claude:4', CLAUDE)!.id).toBe(a.id);
    expect(s.bind('alpha', 'claude:5', CLAUDE)!.id).not.toMatch(new RegExp(`^(${a.id}|${b.id})$`));
    expect(s.employees('alpha')).toHaveLength(3);
  });

  it('never books one employee for two executions at once', () => {
    const s = store();
    const running = new Map<string, string>();
    for (let i = 0; i < 10; i++) {
      const e = s.bind('alpha', `claude:x${i}`, CLAUDE)!;
      expect([...running.values()]).not.toContain(e.id);
      running.set(`claude:x${i}`, e.id);
      if (i % 3 === 2) {
        const first = [...running.keys()][0];
        s.release(first);
        running.delete(first);
      }
    }
    const busy = s.employees('alpha').filter((e) => e.execution !== null);
    expect(new Set(busy.map((e) => e.execution)).size).toBe(busy.length);
  });

  it('binds an execution once: replays, reconnects and late events change nothing', () => {
    const s = store();
    const e = s.bind('alpha', 'claude:1', CLAUDE)!;
    expect(s.bind('alpha', 'claude:1', CLAUDE)!.id).toBe(e.id);
    s.release('claude:1');
    const other = s.bind('alpha', 'claude:2', CLAUDE)!;
    expect(other.id).toBe(e.id); // back to work
    // A replayed start of the ended run: the same employee, not booked again.
    expect(s.bind('alpha', 'claude:1', CLAUDE)!.id).toBe(e.id);
    expect(s.employees('alpha').find((x) => x.id === e.id)!.execution).toBe('claude:2');
    expect(s.release('claude:1')).toBe(false);
  });

  it('pays each (execution, event) once, across a daemon restart', () => {
    const s = store();
    const e = s.bind('alpha', 'claude:1', CLAUDE)!;
    expect(s.pay('claude:1', 'tool:a')).toBe(e.id);
    expect(s.pay('claude:1', 'tool:a')).toBeNull();
    expect(s.pay('claude:1', 'tool:b')).toBe(e.id);
    s.flushIfDirty();
    const again = store();
    expect(again.pay('claude:1', 'tool:a')).toBeNull();
    expect(again.pay('claude:1', 'tool:b')).toBeNull();
    expect(again.pay('claude:nope', 'tool:a')).toBeNull();
  });

  it('a daemon start releases what was left running; seen again, it goes back to its idle employee', () => {
    const s = store();
    const e = s.bind('alpha', 'claude:1', CLAUDE)!;
    const f = s.bind('alpha', 'claude:2', CLAUDE)!;
    clock = 5_000;
    const after = store();
    expect(after.employees('alpha').every((x) => x.execution === null)).toBe(true);
    expect(after.bind('alpha', 'claude:1', CLAUDE)!.id).toBe(e.id);
    // claude:2's employee was taken by new work meanwhile: it runs on another, never doubled.
    expect(after.bind('alpha', 'claude:9', CLAUDE)!.id).toBe(f.id);
    const back = after.bind('alpha', 'claude:2', CLAUDE)!;
    expect(back.id).not.toBe(f.id);
    expect(back.id).not.toBe(e.id);
  });

  it('a roster.json of the wrong shape loads what it can, keeps the file aside, and never throws', () => {
    const good = { id: 'g', nameId: 'harry-potter', hiredAt: 1, lastReleasedAt: 2, execution: 'claude:gone' };
    const raw = JSON.stringify({
      v: 1,
      projects: {
        alpha: {
          employees: [null, good],
          executions: { 'claude:a': null, 'claude:b': { employee: 'g', started: 1, ended: 2 } },
        },
        beta: { employees: 'x' },
      },
    });
    fs.writeFileSync(file, raw);
    const s = store();
    // The good employee survives, idle (its binding was junk), and keeps working.
    expect(s.employees('alpha')).toEqual([{ ...good, execution: null, lastReleasedAt: clock }]);
    expect(s.bind('alpha', 'claude:c', CLAUDE)!.id).toBe('g');
    expect(s.pay('claude:c', 'tool:1')).toBe('g');
    const aside = fs.readdirSync(dir).filter((f) => f.startsWith('roster.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf-8')).toBe(raw);
  });

  it('pins which old-list names stay hireable (an excluded old name made active fails here)', () => {
    const kept = OLD_NAMES.filter((ko) => ACTIVE_STAFF_NAMES.some((n) => n.ko === ko));
    expect(kept).toEqual([
      '해리 커밋터',
      '드레이코 말포맷',
      '루크 스택워커',
      '레아 오거나이저',
      '다스 디버거',
      '한 솔로스레드',
      '프로도 배포긴스',
      '샘와이즈 깃지',
      '토니 스택',
      '피터 파커밋',
      '닉 퓨처',
    ]);
  });

  it('keeps projects apart', () => {
    const s = store();
    s.bind('alpha', 'claude:1', CLAUDE);
    const b = s.bind('beta', 'codex:1', { provider: 'codex' })!;
    s.release('claude:1');
    // alpha's idle employee is never beta's.
    expect(s.bind('beta', 'codex:2', { provider: 'codex' })!.id).not.toBe(s.employees('alpha')[0].id);
    expect(s.employees('beta').map((x) => x.id)).toContain(b.id);
    expect(s.employees('alpha')).toHaveLength(1);
    expect(s.employeeOf('codex:1')!.project).toBe('beta');
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Object.keys(json.projects.alpha.executions)).toEqual(['claude:1']);
  });

  it('the same name can live in two projects, never twice in one', () => {
    const s = store(7);
    for (let i = 0; i < 5; i++) s.bind('alpha', `claude:a${i}`, CLAUDE);
    const names = s.employees('alpha').map((e) => e.nameId);
    expect(new Set(names).size).toBe(names.length);
  });
});
