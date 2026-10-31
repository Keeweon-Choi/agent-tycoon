import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineProject, OfficeOrchestrator } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import { fatigueLook } from './fatigueState.js';
import {
  canStartProject,
  fatigueLine,
  kTokens,
  placeOf,
  readStatFull,
  restValue,
  type StatFacts,
  statSections,
  writeStatFull,
} from './statCardRows.js';

beforeEach(() => setLanguage('en'));
afterEach(() => vi.unstubAllGlobals());

const facts = (over: Partial<StatFacts> = {}): StatFacts => ({
  name: 'cld-gui',
  kind: null,
  lead: null,
  task: null,
  level: { level: 21, xp: 540, floor: 400, next: 2000, rebirths: 4 },
  rank: 'Rank',
  fatigue: fatigueLook(25, 2, undefined, 2),
  tokens: { used: 252_000, max: 1_000_000 },
  activity: 'working',
  elapsed: 'just now',
  model: 'claude-opus-5-5',
  effort: 'max',
  employee: null,
  place: null,
  ...over,
});

describe('fatigueLine', () => {
  it('says the fatigue and the context once', () => {
    expect(fatigueLine(fatigueLook(25, 0), { used: 252_000, max: 1_000_000 })).toBe('Fatigue 25% (252k / 1000k)');
  });
  it('drops the tokens when none were reported', () => {
    expect(fatigueLine(fatigueLook(25, 0), null)).toBe('Fatigue 25%');
  });
  it('rounds tokens to k', () => {
    expect(kTokens(251_600)).toBe('252k');
  });
});

describe('restValue', () => {
  it('is N of M, or N alone', () => {
    expect(restValue(fatigueLook(10, 2, undefined, 2))).toBe('2/2');
    expect(restValue(fatigueLook(10, 1))).toBe('1');
  });
});

describe('statSections', () => {
  it('lists the four sections with every number labelled', () => {
    const sections = statSections(facts());
    expect(sections.map((s) => s.id)).toEqual(['now', 'fatigue', 'growth', 'run']);
    const flat = Object.fromEntries(sections.flatMap((s) => s.rows).map((r) => [r.id, r.value]));
    expect(flat).toMatchObject({
      fatigue: '25%',
      rest: '2/2',
      tokens: '252k / 1000k tokens',
      level: 'Lv 21',
      xp: '540',
      next: '1460',
      rebirth: '4',
      model: 'claude-opus-5-5',
      effort: 'max',
    });
  });
  it('leaves out what is not known instead of guessing', () => {
    const sections = statSections(
      facts({ level: null, rank: null, fatigue: null, tokens: null, model: null, effort: null, activity: null, elapsed: null, employee: null }),
    );
    expect(sections).toEqual([]);
  });
});

const orch = (over: Partial<OfficeOrchestrator> = {}): OfficeOrchestrator => ({
  name: 'alpha',
  dir: '/work/alpha',
  tab: 'room-alpha',
  order: 1,
  state: 'off',
  busy: null,
  compactions: 0,
  alive: false,
  remoteControl: { on: false, url: null },
  agentId: 7,
  sessionId: 'abcdef123456',
  ...over,
});
const project = (over: Partial<EngineProject> = {}): EngineProject => ({
  name: 'alpha',
  folder: '/work/alpha',
  room: 'r',
  wantRunning: false,
  live: false,
  ...over,
});

describe('an off agent (the old sheet\'s facts)', () => {
  it('keeps provider, room, folder and session in the list, and the reason it stopped on the place', () => {
    const place = placeOf(orch(), project({ downNote: 'died 3 times', needsTrust: true }), true);
    expect(place).toMatchObject({ sleeping: true, session: 'abcdef12', downNote: 'died 3 times', needsTrust: true });
    expect(place.state).toContain('Gone home');
    const rows = statSections(facts({ place })).find((s) => s.id === 'place')!.rows;
    expect(rows.map((r) => [r.id, r.value])).toEqual([
      ['provider', 'Engine'],
      ['room', 'room-alpha'],
      ['folder', '/work/alpha'],
      ['session', 'abcdef12'],
    ]);
  });
  it('leaves out a folder or session the office does not hold', () => {
    const place = placeOf(orch({ dir: '', sessionId: null }), undefined, false);
    expect(place.sleeping).toBe(true);
    expect(statSections(facts({ place })).find((s) => s.id === 'place')!.rows.map((r) => r.id)).toEqual([
      'provider',
      'room',
    ]);
  });
  it('a working orchestrator is not sleeping', () => {
    expect(placeOf(orch({ state: 'running' }), undefined, false)).toMatchObject({ sleeping: false, state: null });
  });
  it('no place section for a plain character', () => {
    expect(statSections(facts()).some((s) => s.id === 'place')).toBe(false);
  });
});

describe('canStartProject (the start button)', () => {
  it('shows for an engine project that is not live, to a viewer who may act', () => {
    expect(canStartProject(project(), true)).toBe(true);
  });
  it('is hidden for a read-only viewer', () => {
    expect(canStartProject(project(), false)).toBe(false);
  });
  it('is hidden for a live project and for one the engine does not hold', () => {
    expect(canStartProject(project({ live: true }), true)).toBe(false);
    expect(canStartProject(project({ live: true, bgId: 'b1' }), true)).toBe(false);
    expect(canStartProject(undefined, true)).toBe(false);
  });
});

describe('readStatFull', () => {
  it('remembers the choice', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(readStatFull()).toBe(false);
    writeStatFull(true);
    expect(readStatFull()).toBe(true);
    writeStatFull(false);
    expect(readStatFull()).toBe(false);
  });
  it('works without storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readStatFull()).toBe(false);
    expect(() => writeStatFull(true)).not.toThrow();
  });
});
