import { describe, expect, it } from 'vitest';

import { FRAME_MAX_INSET_FRACTION, PAN_MARGIN_FRACTION, ZOOM_MAX, ZOOM_MIN } from '../constants.js';
import { createFramePacer } from '../office/engine/framePacer.js';
import { mapOffset } from '../office/projection.js';
import { TILE_SIZE } from '../office/types.js';
import {
  cameraKey,
  clampPan,
  DRAG_THRESHOLD_PX,
  easeVelocity,
  EDGE_SCROLL_BAND_PX,
  edgeDirection,
  fillZoom,
  fitZoom,
  FLOOR_GLIDE_PER_S,
  framePan,
  glidePan,
  isDrag,
  keyDirection,
  officeBox,
  panelInset,
  stepZoom,
  usableView,
  wheelZoom,
  zoomAround,
} from './camera.js';

const key = (k: string, code = '', mods: Partial<Record<'ctrl' | 'meta' | 'alt', boolean>> = {}) =>
  cameraKey({
    key: k,
    code,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    altKey: !!mods.alt,
  });

/** Screen position (device px from the canvas centre) of world point `w`,
 *  for a map whose centre is world point `c` — the renderer's projection. */
const project = (w: number, c: number, pan: number, zoom: number) => pan + (w - c) * zoom;

describe('key map', () => {
  it('pans with WASD by key position, so a Hangul IME or AZERTY still works', () => {
    expect(key('w', 'KeyW')).toBe('up');
    expect(key('ㅈ', 'KeyW')).toBe('up');
    expect(key('z', 'KeyW')).toBe('up'); // AZERTY: the key in W's place
    expect(key('a', 'KeyA')).toBe('left');
    expect(key('ㄴ', 'KeyS')).toBe('down');
    expect(key('D', 'KeyD')).toBe('right'); // Shift is fine
  });
  it('pans with the arrows, zooms with +/- (keypad too) and resets with 0', () => {
    expect(key('ArrowUp', 'ArrowUp')).toBe('up');
    expect(key('ArrowDown', 'ArrowDown')).toBe('down');
    expect(key('ArrowLeft', 'ArrowLeft')).toBe('left');
    expect(key('ArrowRight', 'ArrowRight')).toBe('right');
    expect(key('=', 'Equal')).toBe('zoomIn');
    expect(key('+', 'Equal')).toBe('zoomIn');
    expect(key('+', 'BracketRight')).toBe('zoomIn'); // German layout's + key
    expect(key('+', 'NumpadAdd')).toBe('zoomIn');
    expect(key('-', 'Minus')).toBe('zoomOut');
    expect(key('-', 'NumpadSubtract')).toBe('zoomOut');
    expect(key('0', 'Digit0')).toBe('reset');
    expect(key('Insert', 'Numpad0')).toBe('reset'); // keypad 0 with NumLock off
    expect(key('Escape', 'Escape')).toBe('unfollow');
  });
  it('leaves chords and other keys to the browser and the app', () => {
    expect(key('w', 'KeyW', { ctrl: true })).toBeNull(); // close tab
    expect(key('-', 'Minus', { ctrl: true })).toBeNull(); // page zoom
    expect(key('0', 'Digit0', { meta: true })).toBeNull();
    expect(key('ArrowLeft', 'ArrowLeft', { alt: true })).toBeNull(); // history back
    expect(key('r', 'KeyR')).toBeNull(); // the editor's rotate
    expect(key('Enter', 'Enter')).toBeNull();
    expect(key(' ', 'Space')).toBeNull();
    expect(key('Tab', 'Tab')).toBeNull();
  });
});

describe('click or drag', () => {
  it('is a click up to the threshold and a drag past it', () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(DRAG_THRESHOLD_PX, 0)).toBe(false);
    expect(isDrag(3, 2)).toBe(false);
    expect(isDrag(DRAG_THRESHOLD_PX + 1, 0)).toBe(true);
    expect(isDrag(-4, -4)).toBe(true);
  });
});

describe('zoom', () => {
  it('moves in whole steps within the pixel-perfect range', () => {
    expect(stepZoom(3, 1)).toBe(4);
    expect(stepZoom(3, -1)).toBe(2);
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
    expect(stepZoom(2.6, 0)).toBe(3);
    expect(Number.isInteger(stepZoom(4, 1))).toBe(true);
  });
  it('keeps the world point under the cursor where it was', () => {
    const c = 160; // map centre (world px)
    for (const [from, to] of [
      [2, 3],
      [3, 2],
      [4, 10],
      [1, 2],
    ]) {
      const pan = { x: -37, y: 52 };
      const anchor = { x: 210, y: -95 }; // cursor, device px from the canvas centre
      const world = { x: c + (anchor.x - pan.x) / from, y: c + (anchor.y - pan.y) / from };
      const next = zoomAround(pan, anchor, from, to);
      expect(project(world.x, c, next.x, to)).toBeCloseTo(anchor.x, 9);
      expect(project(world.y, c, next.y, to)).toBeCloseTo(anchor.y, 9);
    }
  });
  it('zooms about the centre when anchored there (what a followed character needs)', () => {
    expect(zoomAround({ x: 40, y: -20 }, { x: 0, y: 0 }, 2, 4)).toEqual({ x: 80, y: -40 });
  });
  it('turns wheel deltas into at most one step per event', () => {
    expect(wheelZoom(0, -100, 0)).toEqual({ acc: 0, steps: 1 }); // a notch up
    expect(wheelZoom(0, 100, 0)).toEqual({ acc: 0, steps: -1 });
    expect(wheelZoom(0, -1000, 0)).toEqual({ acc: 0, steps: 1 });
    expect(wheelZoom(0, -3, 1)).toEqual({ acc: 0, steps: 1 }); // Firefox: 3 lines
    let acc = 0;
    let steps = 0;
    for (let i = 0; i < 10; i++) {
      const r = wheelZoom(acc, -8, 0); // trackpad pinch: small ctrl+wheel deltas
      acc = r.acc;
      steps += r.steps;
    }
    expect(steps).toBe(1);
    expect(wheelZoom(-40, 10, 0)).toEqual({ acc: 10, steps: 0 }); // a turn starts over
  });
});

describe('pan', () => {
  const canvas = { w: 1280, h: 800 };
  const map = { cols: 20, rows: 11 };
  it('lets the map go no further than the margin', () => {
    const zoom = 2;
    const maxX = (map.cols * TILE_SIZE * zoom) / 2 + canvas.w / 2 - canvas.w * PAN_MARGIN_FRACTION;
    const maxY = (map.rows * TILE_SIZE * zoom) / 2 + canvas.h / 2 - canvas.h * PAN_MARGIN_FRACTION;
    expect(clampPan({ x: 1e6, y: -1e6 }, canvas, map, zoom)).toEqual({ x: maxX, y: -maxY });
    expect(clampPan({ x: 12, y: -7 }, canvas, map, zoom)).toEqual({ x: 12, y: -7 });
  });
  it('allows more pan at a higher zoom (the map is bigger)', () => {
    const far = { x: 1e6, y: 0 };
    expect(clampPan(far, canvas, map, 6).x).toBeGreaterThan(clampPan(far, canvas, map, 2).x);
  });
  it('points the held keys, with diagonals no faster than straight', () => {
    expect(keyDirection(new Set(['up']))).toEqual({ x: 0, y: -1 });
    expect(keyDirection(new Set(['left', 'right']))).toEqual({ x: 0, y: 0 });
    const d = keyDirection(new Set(['down', 'right']));
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 9);
    expect(d.x).toBeGreaterThan(0);
    expect(d.y).toBeGreaterThan(0);
  });
  it('edge-scrolls only inside the band at the window edge', () => {
    const view = { w: 1280, h: 800 };
    expect(edgeDirection({ x: 640, y: 400 }, view)).toEqual({ x: 0, y: 0 });
    expect(edgeDirection({ x: 0, y: 400 }, view)).toEqual({ x: -1, y: 0 });
    expect(edgeDirection({ x: 1279, y: 400 }, view)).toEqual({ x: 1, y: 0 });
    expect(edgeDirection({ x: 1280 - EDGE_SCROLL_BAND_PX - 1, y: 400 }, view)).toEqual({
      x: 0,
      y: 0,
    });
    expect(edgeDirection({ x: 640, y: 0 }, view)).toEqual({ x: 0, y: -1 });
    const corner = edgeDirection({ x: 1279, y: 799 }, view);
    expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(1, 9);
  });
  it('eases speed in and out, the same at any frame rate', () => {
    const target = { x: 600, y: 0 };
    let v60 = { x: 0, y: 0 };
    for (let i = 0; i < 6; i++) v60 = easeVelocity(v60, target, 1 / 60);
    let v120 = { x: 0, y: 0 };
    for (let i = 0; i < 12; i++) v120 = easeVelocity(v120, target, 1 / 120);
    expect(v60.x).toBeGreaterThan(0);
    expect(v60.x).toBeLessThan(600); // eased in, not a jump
    expect(v120.x).toBeCloseTo(v60.x, 6);
    let stop = { x: 600, y: 0 };
    for (let i = 0; i < 120; i++) stop = easeVelocity(stop, { x: 0, y: 0 }, 1 / 60);
    expect(stop).toEqual({ x: 0, y: 0 }); // settles, no endless creep
  });
});

describe('frame pacing', () => {
  /** Frames drawn in one second of vsyncs at `hz`. */
  const perSecond = (hz: number) => {
    const due = createFramePacer();
    let n = 0;
    for (let i = 0; i < hz; i++) if (due((i * 1000) / hz)) n++;
    return n;
  };
  it('draws every frame at 60 Hz and about 60 a second on faster screens', () => {
    expect(perSecond(60)).toBe(60);
    for (const hz of [75, 90, 120, 144, 165, 240]) {
      expect(perSecond(hz), `${hz} Hz`).toBeGreaterThanOrEqual(57);
      expect(perSecond(hz), `${hz} Hz`).toBeLessThanOrEqual(61);
    }
    expect(perSecond(50)).toBe(50); // slower screens are never skipped
  });
  it('gives every loop the same answer for one frame', () => {
    const due = createFramePacer();
    expect(due(0)).toBe(true);
    expect(due(0)).toBe(true); // the overlay asks after the canvas, same stamp
    expect(due(5)).toBe(false);
    expect(due(5)).toBe(false);
  });
  it('picks up at once after a pause (a hidden tab)', () => {
    const due = createFramePacer();
    due(0);
    expect(due(60_000)).toBe(true);
    expect(due(60_016.7)).toBe(true);
  });
});

describe('floor camera glide', () => {
  it('eases independently of frame rate, finishes within 1 px, and never overshoots', () => {
    const start = { x: -100, y: 80 };
    const target = { x: 100, y: -80 };
    const dt = 0.1;
    const one = glidePan(start, target, dt);
    const fraction = 1 - Math.exp(-FLOOR_GLIDE_PER_S * dt);
    expect(one.x).toBeCloseTo(start.x + (target.x - start.x) * fraction, 9);
    expect(one.y).toBeCloseTo(start.y + (target.y - start.y) * fraction, 9);
    const halves = glidePan(glidePan(start, target, dt / 2), target, dt / 2);
    expect(Math.abs(halves.x - one.x)).toBeLessThan(1e-9);
    expect(Math.abs(halves.y - one.y)).toBeLessThan(1e-9);
    expect(glidePan({ x: 99.5, y: -79.5 }, target, dt)).toEqual(target);
    expect(one.x).toBeLessThan(target.x);
    expect(one.y).toBeGreaterThan(target.y);
  });
});

describe('GFX framing', () => {
  // A 40x30-tile map whose office is the 35x25 tiles from (2,3); wall tops one row above.
  const map = { cols: 40, rows: 30 };
  const tiles = Array.from({ length: 30 }, (_, r) =>
    Array.from({ length: 40 }, (_, c) => (c >= 2 && c < 37 && r >= 3 && r < 28 ? 1 : 0)),
  );
  const office = officeBox(tiles, 0)!;
  const offsetOf = (
    zoom: number,
    canvas: { w: number; h: number },
    pan: { x: number; y: number },
  ) => mapOffset(canvas.w, canvas.h, map.cols, map.rows, zoom, pan.x, pan.y);

  it('finds the office drawn, with one tile of headroom for the wall tops', () => {
    expect(office).toEqual({
      x: 2 * TILE_SIZE,
      y: 2 * TILE_SIZE,
      w: 35 * TILE_SIZE,
      h: 26 * TILE_SIZE,
    });
    expect(officeBox(tiles, 0, { row: 10, rows: 5, cols: 40 })).toEqual({
      x: 2 * TILE_SIZE,
      y: 9 * TILE_SIZE,
      w: 35 * TILE_SIZE,
      h: 6 * TILE_SIZE,
    });
    expect(officeBox(tiles, 0, { row: 28, rows: 2, cols: 40 })).toBeNull();
  });

  it('keeps whole zooms: Fit floors, Fill rounds to the nearest, never under Fit, within range', () => {
    const box = { w: 560, h: 416 };
    expect(fitZoom({ w: 1280, h: 744 }, box)).toBe(1); // 2.29 x 1.79
    expect(fillZoom({ w: 1280, h: 744 }, box)).toBe(2); // covers at 2.29
    expect(fitZoom({ w: 2560, h: 1488 }, box)).toBe(3);
    expect(fillZoom({ w: 2560, h: 1488 }, box)).toBe(5); // 4.57
    expect(fitZoom({ w: 100, h: 100 }, box)).toBe(ZOOM_MIN); // too big even at 1: overflow, no blur
    expect(fillZoom({ w: 100000, h: 100000 }, box)).toBe(ZOOM_MAX);
    // A phone, portrait: Fill covers the height.
    expect(fillZoom({ w: 1170, h: 1896 }, box)).toBe(5);
    for (const v of [
      { w: 777, h: 333 },
      { w: 1170, h: 1896 },
      { w: 3840, h: 2160 },
    ])
      expect(Number.isInteger(fillZoom(v, box)) && Number.isInteger(fitZoom(v, box))).toBe(true);
  });

  it('prefers even zooms while an HD (density 2) character is on screen', () => {
    const box = { w: 560, h: 416 };
    expect(fitZoom({ w: 2560, h: 1488 }, box, 2)).toBe(2); // 3 would draw HD at 1.5
    expect(fillZoom({ w: 2560, h: 1488 }, box, 2)).toBe(4); // 4.57: the nearest even
    expect(fillZoom({ w: 1170, h: 1896 }, box, 2)).toBe(4);
    expect(fitZoom({ w: 1280, h: 744 }, box, 2)).toBe(1); // no even zoom fits: odd it is
    expect(fillZoom({ w: 1280, h: 744 }, box, 2)).toBe(2);
    expect(fillZoom({ w: 100000, h: 100000 }, box, 2)).toBe(ZOOM_MAX);
  });

  it('Fit centres the whole office in the view left by the panels', () => {
    const canvas = { w: 1280, h: 744 };
    const view = usableView(canvas, { top: 0, right: 0, bottom: 0, left: 110 });
    expect(view).toEqual({ x: 110, y: 0, w: 1170, h: 744 });
    const z = fitZoom(view, office);
    const pan = framePan(map, z, canvas, view, office);
    const { offsetX, offsetY } = offsetOf(z, canvas, pan);
    const left = offsetX + office.x * z;
    const top = offsetY + office.y * z;
    expect(left).toBeGreaterThanOrEqual(view.x);
    expect(left + office.w * z).toBeLessThanOrEqual(view.x + view.w);
    expect(Math.abs(left - view.x - (view.x + view.w - (left + office.w * z)))).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(top - (canvas.h - (top + office.h * z)))).toBeLessThanOrEqual(1);
  });

  it('Fill and Focus keep the office covering the view, Focus as near the focus as that allows', () => {
    const canvas = { w: 1170, h: 1896 };
    const view = usableView(canvas, { top: 0, right: 0, bottom: 0, left: 0 });
    const z = fillZoom(view, office);
    const covers = (pan: { x: number; y: number }) => {
      const { offsetX, offsetY } = offsetOf(z, canvas, pan);
      const left = offsetX + office.x * z;
      const top = offsetY + office.y * z;
      return (
        left <= 0 && left + office.w * z >= canvas.w && top <= 0 && top + office.h * z >= canvas.h
      );
    };
    expect(covers(framePan(map, z, canvas, view, office))).toBe(true);
    // Someone at the far right: as far right as the office's right edge allows.
    const right = framePan(map, z, canvas, view, office, { x: 36 * TILE_SIZE, y: 15 * TILE_SIZE });
    expect(covers(right)).toBe(true);
    const { offsetX } = offsetOf(z, canvas, right);
    expect(offsetX + (office.x + office.w) * z).toBe(canvas.w);
    // Someone in the middle is put in the middle of the view.
    const mid = { x: 20 * TILE_SIZE, y: 15 * TILE_SIZE };
    const p = framePan(map, z, canvas, view, office, mid);
    const o = offsetOf(z, canvas, p);
    expect(Math.abs(o.offsetX + mid.x * z - canvas.w / 2)).toBeLessThanOrEqual(1);
  });

  it('lets no panel or safe area take more than its share of the view', () => {
    const view = usableView({ w: 1000, h: 500 }, { top: 0, right: 900, bottom: 0, left: 900 });
    expect(view.w).toBeCloseTo(1000 * (1 - 2 * FRAME_MAX_INSET_FRACTION));
  });

  it('assigns a panel to the side it hugs', () => {
    const c = { w: 1280, h: 744 };
    expect(panelInset(c, { x: 10, y: 300, w: 100, h: 142 })).toEqual({ side: 'left', px: 110 });
    expect(panelInset(c, { x: 1110, y: 280, w: 44, h: 190 })).toEqual({ side: 'right', px: 170 });
    expect(panelInset(c, { x: 300, y: 4, w: 600, h: 60 })).toEqual({ side: 'top', px: 64 });
    expect(panelInset(c, { x: 2000, y: 4, w: 60, h: 60 })).toBeNull(); // off the canvas
  });
});
