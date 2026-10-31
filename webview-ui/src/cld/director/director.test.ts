import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OfficeOrchestrator, OfficeSnapshot } from '../../../../core/src/messages.js';
import { FX_REBIRTH_SEC, FX_STILL_SEC, REST_SETTLE_MS } from '../../constants.js';
import type { Character } from '../../office/types.js';
import { cldHandleMessage } from '../officeStore.js';
import { makeAction } from './actions.js';
import {
  Director,
  director,
  type FxAction,
  type FxFactory,
  type FxRequest,
  type FxWorld,
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
    d.play(1, { kind: 'rebirthA', count: 2 });
    d.step(w, 0.016);
    d.step(w, 0.016);
    expect(log).toEqual(['make coffee', 'step coffee', 'step coffee']);
    d.step(w, 0.016);
    expect(log.slice(3)).toEqual(['make rebirthA', 'step rebirthA']);
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
    d.play(1, { kind: 'rebirthB' });
    d.play(1, { kind: 'coffee' });
    d.step(w, 0.016);
    expect(d.skip(w, 1)).toBe(true);
    expect(log.at(-1)).toBe('skip rebirthB');
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
    d.play(1, { kind: 'rebirthC' });
    d.step(world(1), 0.016);
    expect(d.busy()).toBe(true);
    const back = d.drawables({ id: 1 } as Character, { x: 0, y: 0, zoom: 2, h: 26 }, 10);
    expect(back).toHaveLength(1);
    expect(back[0].zY).toBeLessThan(10); // just behind the character
    back[0].draw({} as CanvasRenderingContext2D);
    d.drawFront({} as CanvasRenderingContext2D);
    d.drawFront({} as CanvasRenderingContext2D); // not drawn again until the character is
    expect(log.filter((l) => l === 'draw rebirthC')).toHaveLength(2);
  });

  it('reduced motion: the factory is asked for the still version, which never asks for full rate', () => {
    const log: string[] = [];
    const d = new Director(() => true, fake(log, 100));
    d.play(1, { kind: 'rebirthA' });
    d.step(world(1), 0.016);
    expect(log[0]).toBe('make rebirthA still');
    expect(d.busy()).toBe(false);
  });
});

describe('the moments', () => {
  it('each rebirth plays for its own length and moves; the still badge does not move', () => {
    const w = world(1);
    const ch = w.characters.get(1)!;
    for (const kind of ['rebirthA', 'rebirthB', 'rebirthC'] as const) {
      const a = makeAction({ kind, count: 3 }, false);
      expect(a.moving).toBe(true);
      let t = 0.1;
      while (a.step(0.1, w, ch)) t += 0.1;
      expect(Math.abs(t - FX_REBIRTH_SEC[kind])).toBeLessThanOrEqual(0.1 + 1e-9);
    }
    const still = makeAction({ kind: 'rebirthB', count: 1 }, true);
    expect(still.moving).toBe(false);
    let t = 0.1;
    while (still.step(0.1, w, ch)) t += 0.1;
    expect(Math.abs(t - FX_STILL_SEC)).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});

describe('the triggers (the rest and rebirth counts the stats view shows)', () => {
  afterEach(() => vi.restoreAllMocks());

  const orch = (compactions: number, rebirths: number): OfficeOrchestrator => ({
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
    level: { level: 3, xp: 345, floor: 300, next: 600, rebirths },
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
    // A live rebirth picks its variant at random: pin the pick (0 → the first, rebirthA).
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const log: string[] = [];
    director.use(fake(log, 1));
    const w = world(5);
    const run = () => {
      for (let i = 0; i < 5; i++) director.step(w, 0.016);
    };
    cldHandleMessage({ type: 'officeAccess', readOnly: false });
    // page load: old counts are a baseline
    cldHandleMessage(snap(orch(4, 2)));
    now = REST_SETTLE_MS + 1;
    cldHandleMessage(snap(orch(4, 2)));
    run();
    expect(log).toEqual([]);
    // a compaction: one coffee break
    cldHandleMessage(snap(orch(5, 2)));
    cldHandleMessage(snap(orch(5, 2))); // the same count again: nothing
    run();
    expect(log).toEqual(['make coffee', 'step coffee']);
    // a renew: the rebirth, with the new count
    log.length = 0;
    cldHandleMessage(snap(orch(0, 3))); // a new conversation counts its compactions from 0
    run();
    expect(log).toEqual(['make rebirthA', 'step rebirthA']);
    // a reconnect replays higher counts: still a baseline
    log.length = 0;
    cldHandleMessage({ type: 'officeAccess', readOnly: false });
    cldHandleMessage(snap(orch(2, 4)));
    run();
    expect(log).toEqual([]);
  });
});
