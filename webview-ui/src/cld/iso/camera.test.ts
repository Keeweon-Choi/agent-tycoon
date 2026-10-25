import { describe, expect, it } from 'vitest';

import { ISO_FRAME_MARGIN } from '../../constants.js';
import {
  clampIsoPan,
  fitZoom,
  isoCameraStep,
  newIsoCam,
  stackCentre,
  viewTarget,
} from './camera.js';
import { floorBox, isoStack, panTo } from './projection.js';

const stack = isoStack({
  cols: 35,
  rows: 74,
  cldFloors: [
    { id: '1', row: 0, rows: 24, cols: 35 },
    { id: '2', row: 27, rows: 22, cols: 35 },
    { id: '3', row: 52, rows: 22, cols: 35 },
  ],
});
const view = { w: 1280, h: 800 };
const base = {
  stack,
  view,
  dpr: 1,
  zoom: 2,
  pan: { x: 0, y: 0 },
  follow: null,
  reduced: false,
  dt: 1 / 60,
};

describe('iso camera', () => {
  it('fits a box at the largest whole zoom, never under 1', () => {
    const floor = floorBox(stack, 1);
    const z = fitZoom(view, floor);
    expect((floor.x1 - floor.x0) * z).toBeLessThanOrEqual(view.w - 2 * ISO_FRAME_MARGIN);
    expect(
      (floor.x1 - floor.x0) * (z + 1) > view.w - 2 * ISO_FRAME_MARGIN ||
        (floor.y1 - floor.y0) * (z + 1) > view.h - 2 * ISO_FRAME_MARGIN,
    ).toBe(true);
    expect(fitZoom({ w: 100, h: 100 }, stack.box)).toBe(1);
  });

  it('frames the view toggled to, at once', () => {
    const cam = newIsoCam();
    const first = isoCameraStep(cam, { ...base, level: 1, focusId: '2', building: false });
    expect(first.zoom).toBe(fitZoom(view, floorBox(stack, 1)));
    const f = floorBox(stack, 1);
    expect(first.pan).toEqual(
      panTo({ x: (f.x0 + f.x1) / 2, y: (f.y0 + f.y1) / 2 }, stackCentre(stack), first.zoom!),
    );
    // The whole building: framed again (a new zoom) when toggled.
    const all = isoCameraStep(cam, {
      ...base,
      zoom: first.zoom!,
      pan: first.pan,
      level: 1,
      focusId: '2',
      building: true,
    });
    expect(all.zoom).toBe(fitZoom(view, stack.box));
  });

  it('glides to a new focus, at once with reduced motion, and lets a manual pan be', () => {
    const cam = newIsoCam();
    const first = isoCameraStep(cam, { ...base, level: 1, focusId: '2', building: false }) as {
      pan: { x: number; y: number };
      zoom: number;
    };
    const zoom = first.zoom;
    let pan = first.pan;
    const target = panTo(viewTarget(stack, 2, false, view, zoom), stackCentre(stack), zoom);
    let steps = 0;
    for (; steps < 600 && (pan.x !== target.x || pan.y !== target.y); steps++) {
      const next = isoCameraStep(cam, {
        ...base,
        zoom,
        pan,
        level: 2,
        focusId: '3',
        building: false,
      }).pan;
      if (steps === 0) expect(next).not.toEqual(target); // the first frame is part of the way
      pan = next;
    }
    expect(pan).toEqual(target);
    expect(steps).toBeGreaterThan(5);
    // Reduced motion: there in one frame.
    const now = isoCameraStep(cam, {
      ...base,
      zoom,
      pan,
      level: 0,
      focusId: '1',
      building: false,
      reduced: true,
    }).pan;
    expect(now).toEqual(panTo(viewTarget(stack, 0, false, view, zoom), stackCentre(stack), zoom));
    // A focus change, then the user drags: the glide stops where the user put it.
    isoCameraStep(cam, { ...base, zoom, pan: now, level: 1, focusId: '2', building: false });
    const dragged = { x: now.x + 300, y: now.y };
    expect(
      isoCameraStep(cam, { ...base, zoom, pan: dragged, level: 1, focusId: '2', building: false })
        .pan,
    ).toEqual(dragged);
  });

  it('follows a character smoothly and keeps the view over the building', () => {
    const cam = newIsoCam();
    const { pan, zoom } = isoCameraStep(cam, {
      ...base,
      level: 0,
      focusId: '1',
      building: false,
    }) as {
      pan: { x: number; y: number };
      zoom: number;
    };
    const feet = { x: 40, y: 120 };
    const next = isoCameraStep(cam, {
      ...base,
      zoom,
      pan,
      level: 0,
      focusId: '1',
      building: false,
      follow: feet,
    }).pan;
    const goal = panTo(feet, stackCentre(stack), zoom);
    expect(Math.abs(goal.x - next.x)).toBeLessThan(Math.abs(goal.x - pan.x));
    const far = clampIsoPan({ x: 1e6, y: -1e6 }, stack, 2);
    const c = stackCentre(stack);
    expect(c.x - far.x / 2).toBeCloseTo(stack.box.x0, 6);
    expect(c.y - far.y / 2).toBeCloseTo(stack.box.y1, 6);
  });
});
