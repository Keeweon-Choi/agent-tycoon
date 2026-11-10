import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  OfficeOrchestrator,
  OfficeSnapshot,
  TempEmployee,
} from '../../../../core/src/messages.js';
import {
  COMPACT_COFFEE_DEDUPE_MS,
  FX_LEVELUP_SEC,
  FX_REBIRTH_SEC,
  FX_STILL_SEC,
  OWNER_CHARACTER_ID,
  REST_SETTLE_MS,
} from '../../constants.js';
import type { Character } from '../../office/types.js';
import { agtyHandleMessage, setTempCharacterLookup } from '../officeStore.js';
import { compactHolds } from '../rest.js';
import { makeAction } from './actions.js';
import {
  CompactBreakWatch,
  Director,
  director,
  type FxAction,
  type FxFactory,
  type FxRequest,
  type FxWorld,
  InheritWatch,
  TempStaffWatch,
} from './director.js';

/** A moment that lasts `frames` steps and records what happened to it. */
function fake(log: string[], frames = 2, moving = true) {
  const make: FxFactory = (req: FxRequest, reduced: boolean) => {
    log.push(`make ${req.kind}${reduced ? ' still' : ''}`);
    let left = frames;
    const action: FxAction = {
      moving: moving && !reduced,
      step: () => {
        log.push(`step ${req.kind}`);
        return --left > 0;
      },
      skip: () => void log.push(`skip ${req.kind}`),
      draw: () => void log.push(`draw ${req.kind}`),
    };
    return action;
  };
  return make;
}
const world = (...ids: number[]): FxWorld => ({
  characters: new Map(ids.map((id) => [id, { id } as Character])),
});

describe('the director', () => {
  it('plays one moment at a time per character, the next after it ends', () => {
    const log: string[] = [];
    const d = new Director(() => false, fake(log));
    const w = world(1);
    d.play(1, { kind: 'coffee' });
    d.play(1, { kind: 'levelUpA', count: 2 });
    d.step(w, 0.016);
    d.step(w, 0.016);
    expect(log).toEqual(['make coffee', 'step coffee', 'step coffee']);
    d.step(w, 0.016);
    expect(log.slice(3)).toEqual(['make levelUpA', 'step levelUpA']);
    expect(d.playing(1)).toBe(true);
    d.step(w, 0.016);
    expect(d.playing(1)).toBe(false);
  });

  it('drops a request past the queue limit', () => {
    const log: string[] = [];
    const d = new Director(() => false, fake(log, 1));
    for (let i = 0; i < 10; i++) d.play(1, { kind: 'coffee' });
    for (let i = 0; i < 20; i++) d.step(world(1), 0.016);
    expect(log.filter((l) => l.startsWith('make')).length).toBeLessThan(10);
  });

  it('a tap skips the moment playing now; the next one starts on the next frame', () => {
    const log: string[] = [];
    const d = new Director(() => false, fake(log, 100));
    const w = world(1);
    d.play(1, { kind: 'levelUpB' });
    d.play(1, { kind: 'coffee' });
    d.step(w, 0.016);
    expect(d.skip(w, 1)).toBe(true);
    expect(log.at(-1)).toBe('skip levelUpB');
    d.step(w, 0.016);
    expect(log.slice(-2)).toEqual(['make coffee', 'step coffee']);
    expect(d.skip(w, 2)).toBe(false); // nothing playing there
  });

  it('does no work once nothing plays: no steps, no drawing, no full-rate frames', () => {
    const log: string[] = [];
    const d = new Director(() => false, fake(log, 1));
    const w = world(1);
    d.play(1, { kind: 'coffee' });
    d.step(w, 0.016);
    expect(d.busy()).toBe(false);
    const before = log.length;
    for (let i = 0; i < 50; i++) d.step(w, 0.016);
    expect(d.drawables({ id: 1 } as Character, { x: 0, y: 0, zoom: 2, h: 26 }, 0)).toEqual([]);
    d.drawFront({} as CanvasRenderingContext2D);
    expect(log.length).toBe(before);
    expect(d.playing(1)).toBe(false);
  });

  it('forgets a character that left the office', () => {
    const log: string[] = [];
    const d = new Director(() => false, fake(log));
    d.play(9, { kind: 'coffee' });
    d.step(world(1), 0.016);
    expect(d.playing(9)).toBe(false);
    expect(log).toEqual([]);
  });

  it('draws the back layer in the z-sort and the front layer once, after the office', () => {
    const log: string[] = [];
    const d = new Director(() => false, fake(log, 100));
    d.play(1, { kind: 'levelUpC' });
    d.step(world(1), 0.016);
    expect(d.busy()).toBe(true);
    const back = d.drawables({ id: 1 } as Character, { x: 0, y: 0, zoom: 2, h: 26 }, 10);
    expect(back).toHaveLength(1);
    expect(back[0].zY).toBeLessThan(10); // just behind the character
    back[0].draw({} as CanvasRenderingContext2D);
    d.drawFront({} as CanvasRenderingContext2D);
    d.drawFront({} as CanvasRenderingContext2D); // not drawn again until the character is
    expect(log.filter((l) => l === 'draw levelUpC')).toHaveLength(2);
  });

  it('reduced motion: the factory is asked for the still version, which never asks for full rate', () => {
    const log: string[] = [];
    const d = new Director(() => true, fake(log, 100));
    d.play(1, { kind: 'levelUpA' });
    d.step(world(1), 0.016);
    expect(log[0]).toBe('make levelUpA still');
    expect(d.busy()).toBe(false);
  });
});

describe('the moments', () => {
  it('each level-up and rebirth plays for its own length and moves; the still badge does not move', () => {
    const w = world(1);
    const ch = w.characters.get(1)!;
    const lengths = { ...FX_LEVELUP_SEC, ...FX_REBIRTH_SEC };
    for (const kind of Object.keys(lengths) as Array<keyof typeof lengths>) {
      const a = makeAction({ kind, count: 3 }, false);
      expect(a.moving).toBe(true);
      let t = 0.1;
      while (a.step(0.1, w, ch)) t += 0.1;
      expect(Math.abs(t - lengths[kind])).toBeLessThanOrEqual(0.1 + 1e-9);
    }
    // a grand rebirth is clearly the bigger moment
    expect(Math.min(...Object.values(FX_REBIRTH_SEC))).toBeGreaterThanOrEqual(5);
    expect(Math.max(...Object.values(FX_LEVELUP_SEC))).toBeLessThan(5);
    const still = makeAction({ kind: 'levelUpB', count: 1 }, true);
    expect(still.moving).toBe(false);
    let t = 0.1;
    while (still.step(0.1, w, ch)) t += 0.1;
    expect(Math.abs(t - FX_STILL_SEC)).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});

describe('the triggers (the rest count, the Lv and the rebirth count the stats view shows)', () => {
  afterEach(() => vi.restoreAllMocks());

  const orch = (compactions: number, rebirths: number, level = 3): OfficeOrchestrator => ({
    name: 'alpha',
    dir: '/work/alpha',
    tab: 'room',
    order: 1,
    state: 'running',
    busy: true,
    remoteControl: { on: false, url: null },
    compactions,
    alive: true,
    agentId: 5,
    level: { level, xp: 345, floor: 300, next: 600, rebirths },
  });
  const snap = (o: OfficeOrchestrator): OfficeSnapshot => ({
    type: 'officeSnapshot',
    readOnly: false,
    tabs: [],
    orchestrators: [o],
  });

  it('one moment per live increase; none for the counts a page load or a reconnect brings', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    // A live rebirth picks R1, R2 or R3 at random: pin the pick.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const log: string[] = [];
    const made: FxRequest[] = [];
    const logged = fake(log, 1);
    director.use((req, reduced) => {
      made.push(req);
      return logged(req, reduced);
    });
    const w = world(5);
    const run = () => {
      for (let i = 0; i < 5; i++) director.step(w, 0.016);
    };
    agtyHandleMessage({ type: 'officeAccess', readOnly: false });
    // page load: old counts are a baseline
    agtyHandleMessage(snap(orch(4, 2)));
    now = REST_SETTLE_MS + 1;
    agtyHandleMessage(snap(orch(4, 2)));
    run();
    expect(log).toEqual([]);
    // a compaction: one coffee break
    agtyHandleMessage(snap(orch(5, 2)));
    agtyHandleMessage(snap(orch(5, 2))); // the same count again: nothing
    run();
    expect(log).toEqual(['make coffee', 'step coffee']);
    // a renew: a grand rebirth, with the new count; the pick covers all three
    log.length = 0;
    made.length = 0;
    agtyHandleMessage(snap(orch(0, 3))); // a new conversation counts its compactions from 0
    run();
    expect(log).toEqual(['make rebirthR1', 'step rebirthR1']);
    random.mockReturnValue(0.5);
    agtyHandleMessage(snap(orch(0, 4)));
    run();
    random.mockReturnValue(0.99);
    agtyHandleMessage(snap(orch(0, 5)));
    run();
    expect(made).toEqual([
      { kind: 'rebirthR1', count: 3 },
      { kind: 'rebirthR2', count: 4 },
      { kind: 'rebirthR3', count: 5 },
    ]);
    // a reconnect replays higher counts: still a baseline
    log.length = 0;
    agtyHandleMessage({ type: 'officeAccess', readOnly: false });
    agtyHandleMessage(snap(orch(2, 6)));
    run();
    expect(log).toEqual([]);
  });

  it('COMPACT-COFFEE: the break starts at compacting, holds while it lasts, no second one at the boundary', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const log: string[] = [];
    director.use(fake(log, 1));
    const w = world(5);
    const run = () => {
      for (let i = 0; i < 5; i++) director.step(w, 0.016);
    };
    const compacting = (n: number): OfficeOrchestrator => ({ ...orch(n, 0), compacting: true });
    agtyHandleMessage({ type: 'officeAccess', readOnly: false });
    agtyHandleMessage(snap(orch(1, 0)));
    now = REST_SETTLE_MS + 1;
    // Claude Code starts compacting: the break now, held while the row says so
    agtyHandleMessage(snap(compacting(1)));
    run();
    expect(log).toEqual(['make coffee', 'step coffee']);
    expect(compactHolds.has(5)).toBe(true);
    agtyHandleMessage(snap(compacting(1))); // still compacting: nothing more
    // the boundary: the count goes up, compacting ends: the hold lets go, no second break
    agtyHandleMessage(snap(orch(2, 0)));
    run();
    expect(compactHolds.has(5)).toBe(false);
    expect(log).toEqual(['make coffee', 'step coffee']);
    // a compaction seen only by its boundary (no screen): today's break after the fact
    log.length = 0;
    now += COMPACT_COFFEE_DEDUPE_MS + 1;
    agtyHandleMessage(snap(orch(3, 0)));
    run();
    expect(log).toEqual(['make coffee', 'step coffee']);
  });

  it('a level-up plays on a live Lv increase, with the new Lv; never on load, replay or a drop', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // the last of the three, levelUpC
    const made: FxRequest[] = [];
    const logged = fake([], 1);
    director.use((req, reduced) => {
      made.push(req);
      return logged(req, reduced);
    });
    const w = world(5);
    const run = () => {
      for (let i = 0; i < 5; i++) director.step(w, 0.016);
    };
    agtyHandleMessage({ type: 'officeAccess', readOnly: false });
    agtyHandleMessage(snap(orch(1, 0, 4))); // page load: Lv 4 is the baseline
    now = REST_SETTLE_MS + 1;
    agtyHandleMessage(snap(orch(1, 0, 4)));
    run();
    expect(made).toEqual([]);
    agtyHandleMessage(snap(orch(1, 0, 5))); // Lv 4 -> 5 live
    agtyHandleMessage(snap(orch(1, 0, 5))); // the same Lv again: nothing
    run();
    expect(made).toEqual([{ kind: 'levelUpC', count: 5 }]);
    made.length = 0;
    agtyHandleMessage(snap(orch(1, 0, 1))); // a lower Lv (a reset): nothing
    run();
    expect(made).toEqual([]);
    // a reconnect replays a higher Lv inside the settle window: a baseline, not a level-up
    agtyHandleMessage({ type: 'officeAccess', readOnly: false });
    agtyHandleMessage(snap(orch(1, 0, 7)));
    now += REST_SETTLE_MS / 2;
    agtyHandleMessage(snap(orch(1, 0, 8)));
    run();
    expect(made).toEqual([]);
  });

  it("the owner's Lv up plays like an agent's (OWNER-STATS)", () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const made: FxRequest[] = [];
    const logged = fake([], 1);
    director.use((req, reduced) => {
      made.push(req);
      return logged(req, reduced);
    });
    const w = world(OWNER_CHARACTER_ID);
    const counts = { instructions: 0, approvals: 0, merges: 0, tasks: 0, steps: 0, seconds: 0 };
    const owner = (level: number): OfficeSnapshot => ({
      type: 'officeSnapshot',
      readOnly: false,
      tabs: [],
      orchestrators: [],
      owner: { level: { level, xp: 0, floor: 0, next: 100, rebirths: 0 }, today: counts, total: counts },
    });
    agtyHandleMessage({ type: 'officeAccess', readOnly: false });
    agtyHandleMessage(owner(1)); // page load: the baseline
    now = REST_SETTLE_MS + 1;
    agtyHandleMessage(owner(2)); // the next snapshot is the live Lv up
    for (let i = 0; i < 5; i++) director.step(w, 0.016);
    expect(made).toEqual([{ kind: 'levelUpA', count: 2 }]);
  });
});

describe('INHERIT: the inherit trigger', () => {
  it('fires once, when an heir that showed up live has its character; never for the replay', () => {
    const w = new InheritWatch();
    w.connected(0, REST_SETTLE_MS);
    expect(w.observe('old', 1, true, 10)).toBe(false); // replayed after a (re)connect: a baseline
    const later = REST_SETTLE_MS + 1;
    expect(w.observe('heir', 1, false, later)).toBe(false); // added, still its stand-in character
    expect(w.observe('heir', 1, true, later + 1)).toBe(true); // its session's character: plays
    expect(w.observe('heir', 1, true, later + 2)).toBe(false); // once
    expect(w.observe('old', 1, true, later + 3)).toBe(false);
    expect(w.observe('plain', 0, true, later + 4)).toBe(false); // inherited nothing
  });
});

describe('COMPACT-COFFEE: CompactBreakWatch', () => {
  it('starts at compacting, swallows the same compaction rise, plays a boundary-only one', () => {
    const w = new CompactBreakWatch();
    expect(w.observe(1, false, false, 0)).toBeNull();
    expect(w.observe(1, true, false, 10)).toBe('start');
    expect(w.observe(1, true, false, 20)).toBeNull(); // still compacting
    expect(w.observe(1, false, true, 30)).toBeNull(); // its boundary in the same snapshot
    expect(w.observe(1, false, true, 40)).toBe('rest'); // another, boundary-only
    // the spinner went first, the boundary a moment later: still the same compaction
    expect(w.observe(1, true, false, 50)).toBe('start');
    expect(w.observe(1, false, false, 60)).toBeNull();
    expect(w.observe(1, false, true, 60 + COMPACT_COFFEE_DEDUPE_MS - 1)).toBeNull();
    // Negative control: a spinner whose boundary never came does not eat a later compaction
    expect(w.observe(1, true, false, 100)).toBe('start');
    expect(w.observe(1, false, false, 110)).toBeNull();
    expect(w.observe(1, false, true, 110 + COMPACT_COFFEE_DEDUPE_MS)).toBe('rest');
    // other characters are their own
    expect(w.observe(2, false, true, 0)).toBe('rest');
  });
});

describe('FX-ALL: the temp staff moments (TempStaffWatch)', () => {
  const MAX = 200_000;
  const emp = (execution: string, level: number, tokens?: number, compactions?: number): TempEmployee => ({
    execution,
    employeeId: 'e1',
    nameId: 'n1',
    project: 'alpha',
    working: true,
    level: { level, xp: 0, floor: 0, next: 100, rebirths: 0 },
    ...(tokens !== undefined && { contextTokens: tokens, maxContextTokens: MAX }),
    ...(compactions !== undefined && { compactions }),
  });
  const later = REST_SETTLE_MS + 1;

  it("a live Lv up of the employee is a level-up; the load, a reconnect's replay and a lower Lv are not", () => {
    const w = new TempStaffWatch();
    w.connected(0, REST_SETTLE_MS);
    expect(w.observe([emp('claude:a', 2)], 10)).toEqual([]); // the load: a baseline
    expect(w.observe([emp('claude:a', 3)], 20)).toEqual([]); // still the replay
    expect(w.observe([emp('claude:a', 3)], later)).toEqual([]); // the same Lv: nothing
    // the employee's Lv carries over to its next execution: the moment is on that one
    expect(w.observe([emp('claude:b', 4)], later)).toEqual([
      { execution: 'claude:b', kind: 'levelUp', count: 4 },
    ]);
    expect(w.observe([emp('claude:b', 1)], later)).toEqual([]); // a reset: nothing
    w.connected(later, REST_SETTLE_MS);
    expect(w.observe([emp('claude:b', 5)], later + 1)).toEqual([]); // a reconnect
  });

  it("a compaction the daemon counted in the execution's own transcript is a coffee break; a falling gauge, or a new execution, is not", () => {
    const w = new TempStaffWatch();
    const full = MAX * 0.8;
    expect(w.observe([emp('claude:a', 1, full, 0)], later)).toEqual([]); // first sample
    // the gauge fell 60 points but nothing was counted (a /clear, a wider window): not a compaction
    expect(w.observe([emp('claude:a', 1, MAX * 0.2, 0)], later)).toEqual([]);
    expect(w.observe([emp('claude:a', 1, MAX * 0.2, 1)], later)).toEqual([
      { execution: 'claude:a', kind: 'coffee', count: 1 },
    ]);
    expect(w.observe([emp('claude:a', 1, MAX * 0.3, 1)], later)).toEqual([]); // the same count: nothing
    // a new execution of the same employee starts at its own count: its first sample
    expect(w.observe([emp('claude:b', 1, MAX * 0.05, 3)], later)).toEqual([]);
    // no verified context (a Codex temporary): never a coffee break
    expect(w.observe([emp('codex:t', 1)], later)).toEqual([]);
  });

  it('plays on the execution character on screen, and skips quietly when there is none', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const made: Array<[number, FxRequest]> = [];
    director.use((req, reduced) => fake([], 1)(req, reduced));
    const play = vi.spyOn(director, 'play').mockImplementation((id, req) => {
      made.push([id, req]);
      return true;
    });
    let onScreen: number | null = null;
    setTempCharacterLookup((exec) => (exec === 'claude:a' ? onScreen : null));
    const send = (level: number) => agtyHandleMessage({ type: 'tempStaff', staff: [emp('claude:a', level)] });
    agtyHandleMessage({ type: 'officeAccess', readOnly: false });
    send(1);
    now = REST_SETTLE_MS + 1;
    send(2); // no character now: skipped
    expect(made).toEqual([]);
    onScreen = -7;
    send(3);
    expect(made).toEqual([[-7, { kind: 'levelUpA', count: 3 }]]);
    play.mockRestore();
    setTempCharacterLookup(() => null);
  });
});

describe("FX-ALL: the owner's character", () => {
  it('plays a level-up and a coffee break, never a rebirth or an inherit (an agent still does)', () => {
    const d = new Director(() => false, fake([], 1));
    expect(d.play(OWNER_CHARACTER_ID, { kind: 'levelUpB', count: 2 })).toBe(true);
    expect(d.play(OWNER_CHARACTER_ID, { kind: 'coffee' })).toBe(true);
    expect(d.play(OWNER_CHARACTER_ID, { kind: 'rebirthR1', count: 1 })).toBe(false);
    expect(d.play(OWNER_CHARACTER_ID, { kind: 'inherit', count: 1 })).toBe(false);
    expect(d.play(5, { kind: 'rebirthR2', count: 1 })).toBe(true);
    expect(d.play(5, { kind: 'inherit', count: 1 })).toBe(true);
  });
});
