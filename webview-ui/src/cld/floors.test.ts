import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mapOffset } from '../office/projection.js';
import type { Character } from '../office/types.js';
import { TILE_SIZE } from '../office/types.js';
import { centerPan, clampPan, clearLeft } from './camera.js';
import type { FloorRect } from './floors.js';
import {
  cameraRect,
  DOOR_CLOSE_MS,
  DOOR_HOLD_MS,
  DOOR_OPEN_MS,
  drawnShift,
  floorBadges,
  floorClip,
  floorIndexAt,
  floorKey,
  floorRects,
  floorsHandleMessage,
  floorsResetForTests,
  floorsSnapshot,
  floorView,
  goToFloor,
  onFloor,
  sampleFloors,
  setStackedView,
  shownRect,
  stackedFloorAt,
  stackShifts,
  stackSpan,
  stepFloor,
  swipeStep,
  wanderTiles,
} from './floors.js';

// Floor 1: rows 0-9, 20 cols; a 2-row gap; floor 2: rows 12-19, 12 cols.
const F1: FloorRect = { id: '1', row: 0, rows: 10, cols: 20 };
const F2: FloorRect = { id: '7', row: 12, rows: 8, cols: 12 };
const LAYOUT = { cols: 20, rows: 20, cldFloors: [F1, F2] };
const building = (perProject = false) => ({
  type: 'buildingState' as const,
  floors: [
    { id: '1', name: '1\uce35', rooms: ['a'], characters: [] },
    { id: '7', name: '\uc5f0\uad6c\ub3d9', rooms: ['b'], characters: [] },
  ],
  perProject,
});

afterEach(() => {
  floorsResetForTests();
  vi.useRealTimers();
});

describe('floor geometry', () => {
  it('reads the floors from the layout; one floor (or none) draws the whole map', () => {
    expect(floorRects(LAYOUT)).toEqual([F1, F2]);
    expect(floorRects({ cols: 5, rows: 5 })).toBeNull();
    expect(floorRects({ cldFloors: [F1] })).toBeNull();
    expect(shownRect(LAYOUT, '7')).toBe(F2);
    expect(shownRect(LAYOUT, 'gone')).toBe(F1); // a floor removed meanwhile: floor 1
    expect(shownRect({ cols: 5, rows: 5 }, '7')).toBeNull();
  });

  it('a tile row is on one floor, or in a gap between floors', () => {
    expect(floorIndexAt([F1, F2], 0)).toBe(0);
    expect(floorIndexAt([F1, F2], 9)).toBe(0);
    expect(floorIndexAt([F1, F2], 10)).toBe(-1);
    expect(floorIndexAt([F1, F2], 12)).toBe(1);
    expect(floorIndexAt([F1, F2], 20)).toBe(-1);
  });

  it('a floor owns its rows and the tile above them (wall tops, heads)', () => {
    const T = TILE_SIZE;
    expect(onFloor(F2, 12 * T - T)).toBe(true);
    expect(onFloor(F2, 12 * T - T - 1)).toBe(false);
    expect(onFloor(F2, 20 * T - 1)).toBe(true);
    expect(onFloor(F2, 20 * T)).toBe(false);
    expect(onFloor(null, -999)).toBe(true);
  });

  it('the clip is the floor where the renderer draws it, at any pan and zoom', () => {
    const canvas = { w: 800, h: 600 };
    for (const [zoom, pan] of [
      [2, { x: 0, y: 0 }],
      [3, { x: 37.4, y: -120.6 }],
    ] as const) {
      const clip = floorClip(F2, LAYOUT, canvas, zoom, pan)!;
      const o = mapOffset(canvas.w, canvas.h, LAYOUT.cols, LAYOUT.rows, zoom, pan.x, pan.y);
      const s = TILE_SIZE * zoom;
      expect(clip).toEqual({ x: o.offsetX, y: o.offsetY + 11 * s, w: 12 * s, h: 9 * s });
    }
    expect(floorClip(null, LAYOUT, canvas, 2, { x: 0, y: 0 })).toBeNull();
  });

  it('the default view moves a thing under the elevator panel clear of it (T-0063)', () => {
    const pan = { x: 10, y: 5 };
    // Starts left of the clearance: moved right by exactly the shortfall, even past the canvas edge.
    expect(clearLeft(pan, { left: -122, right: 754 }, 920, 84)).toEqual({ x: 216, y: 5 });
    // Already clear: untouched. Wider than the canvas (a phone): untouched.
    expect(clearLeft(pan, { left: 120, right: 996 }, 920, 84)).toBe(pan);
    expect(clearLeft(pan, { left: -50, right: 2578 }, 1179, 84)).toBe(pan);
  });

  it('the camera centres the floor shown and keeps it in view', () => {
    const zoom = 2;
    const c = centerPan(LAYOUT, zoom, F2);
    // The floor's centre lands on the canvas centre.
    const canvas = { w: 800, h: 600 };
    const o = mapOffset(canvas.w, canvas.h, LAYOUT.cols, LAYOUT.rows, zoom, c.x, c.y);
    expect(o.offsetX + (F2.cols / 2) * TILE_SIZE * zoom).toBeCloseTo(canvas.w / 2, 0);
    expect(o.offsetY + (F2.row + F2.rows / 2) * TILE_SIZE * zoom).toBeCloseTo(canvas.h / 2, 0);
    expect(centerPan(LAYOUT, zoom, null)).toEqual({ x: 0, y: 0 });
    // Clamped around that centre by the floor's size, not the map's.
    const far = clampPan({ x: 1e6, y: -1e6 }, canvas, LAYOUT, zoom, F2);
    const maxX = (F2.cols * TILE_SIZE * zoom) / 2 + canvas.w / 2 - canvas.w * 0.25;
    const maxY = (F2.rows * TILE_SIZE * zoom) / 2 + canvas.h / 2 - canvas.h * 0.25;
    expect(far).toEqual({ x: c.x + maxX, y: c.y - maxY });
    // Without a floor it is upstream's clamp, about the map's centre.
    expect(clampPan({ x: 1e6, y: 0 }, canvas, LAYOUT, zoom).x).toBe(
      (LAYOUT.cols * TILE_SIZE * zoom) / 2 + canvas.w / 2 - canvas.w * 0.25,
    );
  });

  it('the renderer walks only the shown floor: other rows are emptied (memoized)', () => {
    const rect: FloorRect = { id: '7', row: 1, rows: 2, cols: 3 };
    const map = [
      [1, 1, 1],
      [2, 2, 2],
      [3, 3, 3],
      [4, 4, 4],
    ];
    const labels = ['a', 'a', 'a', 'b', 'b', null, 'c', 'c', 'c', 'd', 'd', 'd'];
    const view = floorView(map, labels, rect, 255);
    expect(view.tileMap).toEqual([
      [255, 255, 255],
      [2, 2, 2],
      [3, 3, 3],
      [255, 255, 255],
    ]);
    expect(view.tileMap[1]).toBe(map[1]); // the floor's own rows, untouched
    expect(view.areaTiles).toEqual([
      null,
      null,
      null,
      'b',
      'b',
      null,
      'c',
      'c',
      'c',
      null,
      null,
      null,
    ]);
    expect(floorView(map, labels, rect, 255)).toBe(view);
    const other = { ...rect, row: 0 };
    const otherView = floorView(map, labels, other, 255);
    expect(floorView(map, labels, rect, 255)).toBe(view);
    expect(floorView(map, labels, other, 255)).toBe(otherView);
    expect(floorView(map, labels, null, 255)).toEqual({ tileMap: map, areaTiles: labels });
  });

  it('idle characters wander on their own floor', () => {
    const walkable = [
      { col: 1, row: 1 },
      { col: 2, row: 5 },
      { col: 1, row: 13 },
      { col: 3, row: 19 },
    ];
    const at = (row: number) => ({ tileRow: row }) as Character;
    expect(wanderTiles(walkable, LAYOUT, at(1))).toEqual(walkable.slice(0, 2));
    expect(wanderTiles(walkable, LAYOUT, at(19))).toEqual(walkable.slice(2));
    expect(wanderTiles(walkable, { cols: 5, rows: 5 }, at(1))).toBe(walkable);
  });
});

describe('stacked floor view', () => {
  it('reverses the floors with the layout gap and keeps the current floor fixed', () => {
    expect(stackShifts([F1, F2], 0)).toEqual([0, -352]);
    expect(stackShifts([F1, F2], 1)).toEqual([352, 0]);
    const F3 = { id: '9', row: 22, rows: 6, cols: 8 };
    const rects = [F1, F2, F3];
    for (let current = 0; current < rects.length; current++) {
      const shifts = stackShifts(rects, current);
      expect(shifts[current]).toBe(0);
      const top = rects.map((r, i) => r.row + shifts[i] / TILE_SIZE);
      expect(top[2]).toBeLessThan(top[1]);
      expect(top[1]).toBeLessThan(top[0]);
      expect(top[1] + F2.rows + 2).toBe(top[0]);
      expect(top[2] + F3.rows + 2).toBe(top[1]);
      for (let b = 0; b < rects.length; b++) {
        const fromB = stackShifts(rects, b);
        for (let k = 0; k < rects.length; k++) expect(fromB[k]).toBe(shifts[k] - shifts[b]);
      }
    }
    expect(stackSpan([F1, F2], stackShifts([F1, F2], 0))).toEqual({ row: -10, rows: 20, cols: 20 });
  });

  it('reports rendered shifts, hit targets, camera bounds, and the default setting', () => {
    floorsHandleMessage(building());
    expect(floorsSnapshot().stacked).toBe(true);
    expect(drawnShift(LAYOUT, 3 * TILE_SIZE)).toBe(0);
    expect(drawnShift(LAYOUT, 14 * TILE_SIZE)).toBe(-352);
    expect(stackedFloorAt(LAYOUT, 5 * TILE_SIZE, -8 * TILE_SIZE)).toBe('7');
    expect(stackedFloorAt(LAYOUT, 15 * TILE_SIZE, -8 * TILE_SIZE)).toBeNull();
    expect(stackedFloorAt(LAYOUT, 5 * TILE_SIZE, 3 * TILE_SIZE)).toBeNull();
    expect(cameraRect(LAYOUT)).toEqual({ row: -10, rows: 20, cols: 20 });
    expect(drawnShift({ cols: 5, rows: 5 }, 3 * TILE_SIZE)).toBe(0);
    goToFloor('7');
    expect(floorsSnapshot()).toMatchObject({ current: '7', doors: null });
    goToFloor('1');
    setStackedView(false);
    expect(floorsSnapshot().stacked).toBe(false);
    expect(drawnShift(LAYOUT, 14 * TILE_SIZE)).toBeNull();
    expect(stackedFloorAt(LAYOUT, 5 * TILE_SIZE, -8 * TILE_SIZE)).toBeNull();
    expect(cameraRect(LAYOUT)).toEqual(F1);
  });
});

describe('floor keys and the phone swipe', () => {
  const key = (
    code: string,
    k: string,
    mods: Partial<Record<'ctrl' | 'meta' | 'alt', boolean>> = {},
  ) => floorKey({ code, key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt });

  it('1-9 by position on the digit row, the numpad only while it types digits', () => {
    expect(key('Digit1', '1')).toBe(1);
    expect(key('Digit9', '9')).toBe(9);
    expect(key('Digit1', '&')).toBe(1); // AZERTY
    expect(key('Digit0', '0')).toBeNull(); // 0 resets the camera (T-0025)
    expect(key('Numpad3', '3')).toBe(3);
    expect(key('Numpad2', 'ArrowDown')).toBeNull(); // NumLock off: it pans
    expect(key('Digit2', '2', { ctrl: true })).toBeNull(); // the browser's tab switch
    expect(key('Digit2', '2', { alt: true })).toBeNull();
    expect(key('KeyW', 'w')).toBeNull();
  });

  it('a swipe up goes a floor up, down a floor down; short or sideways does nothing', () => {
    expect(swipeStep(0, -30)).toBe(1);
    expect(swipeStep(3, 40)).toBe(-1);
    expect(swipeStep(0, -10)).toBe(0);
    expect(swipeStep(50, -30)).toBe(0);
  });
});

describe('floor badges', () => {
  beforeEach(() => setStackedView(false));
  const item = (
    floor: number,
    p: Partial<{ permission: boolean; blocked: boolean; waitingSince: number | null }> = {},
  ) => ({
    floor,
    permission: false,
    blocked: false,
    waitingSince: null,
    ...p,
  });

  it('permission wins; a turn ended since the floor was last seen is waiting; the floor shown has none', () => {
    const viewed = [100, 100, 100];
    expect(
      floorBadges(3, [item(1, { waitingSince: 150 }), item(1, { permission: true })], viewed, 0),
    ).toEqual([null, 'permission', null]);
    expect(floorBadges(3, [item(2, { waitingSince: 150 })], viewed, 0)).toEqual([
      null,
      null,
      'waiting',
    ]);
    expect(floorBadges(3, [item(2, { waitingSince: 50 })], viewed, 0)).toEqual([null, null, null]); // seen
    expect(floorBadges(3, [item(2, { blocked: true })], viewed, 0)).toEqual([
      null,
      null,
      'waiting',
    ]);
    expect(
      floorBadges(3, [item(0, { permission: true }), item(-1, { permission: true })], viewed, 0),
    ).toEqual([null, null, null]);
  });

  it('only a turn that ends while this page watches counts, until that floor is looked at', () => {
    floorsHandleMessage(building());
    const ch = {
      id: 5,
      tileRow: 14,
      isActive: false,
      bubbleType: null,
      currentTool: null,
    } as unknown as Character;
    const tick = (now: number) => sampleFloors([ch], LAYOUT, 1, now);
    // A waiting replayed at connect (never seen working): no badge.
    ch.bubbleType = 'waiting';
    tick(1000);
    expect(floorsSnapshot().badges).toEqual({});
    // It works, then its turn ends while floor 1 is shown.
    ch.isActive = true;
    ch.bubbleType = null;
    tick(2000);
    ch.isActive = false;
    ch.bubbleType = 'waiting';
    tick(3000);
    expect(floorsSnapshot().badges).toEqual({ '7': 'waiting' });
    ch.bubbleType = null; // the bubble fades; the badge stays
    tick(4000);
    expect(floorsSnapshot().badges).toEqual({ '7': 'waiting' });
    // A permission there wins.
    ch.bubbleType = 'permission';
    tick(5000);
    expect(floorsSnapshot().badges).toEqual({ '7': 'permission' });
    ch.bubbleType = null;
    // Looking at floor 2 clears it; back on floor 1 it stays cleared.
    floorsHandleMessage(building());
    vi.useFakeTimers();
    goToFloor('7');
    vi.advanceTimersByTime(DOOR_CLOSE_MS + DOOR_HOLD_MS + DOOR_OPEN_MS);
    tick(6000);
    expect(floorsSnapshot().badges).toEqual({});
    goToFloor('1');
    vi.advanceTimersByTime(DOOR_CLOSE_MS + DOOR_HOLD_MS + DOOR_OPEN_MS);
    tick(7000);
    expect(floorsSnapshot().badges).toEqual({});
  });
});

describe('the elevator', () => {
  beforeEach(() => setStackedView(false));
  it('shuts, switches behind the doors, opens, in under 300 ms', () => {
    vi.useFakeTimers();
    floorsHandleMessage(building());
    expect(floorsSnapshot().current).toBe('1');
    goToFloor('7');
    expect(floorsSnapshot()).toMatchObject({
      current: '1',
      doors: { phase: 'closing', target: '7', dir: 1 },
    });
    vi.advanceTimersByTime(DOOR_CLOSE_MS);
    expect(floorsSnapshot()).toMatchObject({ current: '7', doors: { phase: 'opening' } });
    vi.advanceTimersByTime(DOOR_HOLD_MS + DOOR_OPEN_MS);
    expect(floorsSnapshot().doors).toBeNull();
    expect(DOOR_CLOSE_MS + DOOR_HOLD_MS + DOOR_OPEN_MS).toBeLessThan(300);
  });

  it('a new floor while shutting is where it opens; while opening it goes on after', () => {
    vi.useFakeTimers();
    const three = {
      ...building(),
      floors: [...building().floors, { id: '9', name: '3\uce35', rooms: [], characters: [] }],
    };
    floorsHandleMessage(three);
    goToFloor('9');
    goToFloor('7'); // still shutting
    vi.advanceTimersByTime(DOOR_CLOSE_MS);
    expect(floorsSnapshot().current).toBe('7');
    goToFloor('1'); // opening: queued
    expect(floorsSnapshot().doors?.phase).toBe('opening');
    vi.advanceTimersByTime(DOOR_HOLD_MS + DOOR_OPEN_MS);
    expect(floorsSnapshot().doors).toMatchObject({ phase: 'closing', target: '1', dir: -1 });
    vi.advanceTimersByTime(DOOR_CLOSE_MS + DOOR_HOLD_MS + DOOR_OPEN_MS);
    expect(floorsSnapshot()).toMatchObject({ current: '1', doors: null });
    stepFloor(1);
    vi.advanceTimersByTime(DOOR_CLOSE_MS);
    expect(floorsSnapshot().current).toBe('7');
  });

  it('a floor that is gone falls back to floor 1; no unknown floor is gone to', () => {
    floorsHandleMessage(building());
    goToFloor('nope');
    expect(floorsSnapshot().doors).toBeNull();
    vi.useFakeTimers();
    goToFloor('7');
    vi.advanceTimersByTime(DOOR_CLOSE_MS + DOOR_HOLD_MS + DOOR_OPEN_MS);
    floorsHandleMessage({ ...building(), floors: building().floors.slice(0, 1) });
    expect(floorsSnapshot().current).toBe('1');
  });
});
