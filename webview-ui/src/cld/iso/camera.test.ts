import { describe, expect, it } from 'vitest';

import { ISO_FRAME_MARGIN, PHONE_ISO_ZOOM_MIN } from '../../constants.js';
import { billboardBox } from './billboard.js';
import {
  clampIsoPan,
  fitZoom,
  isoCameraStep,
  newIsoCam,
  occupiedRoomsBox,
  phoneFitZoom,
  phoneFrame,
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

// PHONE-ZOOM: a portrait phone, 390x633 CSS at dpr 3. Floor 2 (rows 27..48) holds two rooms.
const phoneView = { w: 1170, h: 1900 };
const areaTiles: Array<string | null> = new Array(35 * 74).fill(null);
const room = (label: string, c0: number, r0: number, c1: number, r1: number) => {
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) areaTiles[(27 + r) * 35 + c] = label;
};
room('a', 1, 2, 11, 12);
room('b', 14, 2, 24, 12);
const layout = { cols: 35, areaTiles };
const inRoomB = [{ tileCol: 18, tileRow: 27 + 6 }];
const mid = (b: { x0: number; y0: number; x1: number; y1: number }) => ({
  x: (b.x0 + b.x1) / 2,
  y: (b.y0 + b.y1) / 2,
});

describe('phone isometric framing', () => {
  const phone = {
    ...base,
    view: phoneView,
    dpr: 3,
    level: 1,
    focusId: '2',
    building: true,
    phone: true,
  };

  it('frames the occupied rooms at a readable zoom, centred on them', () => {
    const rooms = occupiedRoomsBox(stack, 1, layout, inRoomB)!;
    const out = isoCameraStep(newIsoCam(), { ...phone, phoneBox: () => rooms });
    expect(out.zoom).toBeGreaterThanOrEqual(PHONE_ISO_ZOOM_MIN);
    expect(out.zoom).toBe(phoneFitZoom(phoneView, rooms, 3));
    expect(out.pan).toEqual(panTo(mid(rooms), stackCentre(stack), out.zoom!));
    // the old slab fit: zoom 2, the whole floor, characters ~10 CSS px
    expect(fitZoom(phoneView, floorBox(stack, 1), 3)).toBeLessThan(PHONE_ISO_ZOOM_MIN);
  });

  it('on the ground floor the first view holds the billboard too (it is wider than the 6x frame)', () => {
    const rooms = floorBox(stack, 0);
    const e = billboardBox(stack).extent;
    const at = phoneFrame(stack, 0, phoneView, rooms, 3);
    expect(at.zoom).toBeLessThan(phoneFitZoom(phoneView, rooms, 3));
    const cx = (at.box.x0 + at.box.x1) / 2;
    const cy = (at.box.y0 + at.box.y1) / 2;
    expect(cx - phoneView.w / 2 / at.zoom).toBeLessThanOrEqual(e.x0);
    expect(cx + phoneView.w / 2 / at.zoom).toBeGreaterThanOrEqual(e.x1);
    expect(cy - phoneView.h / 2 / at.zoom).toBeLessThanOrEqual(e.y0);
    expect(cy + phoneView.h / 2 / at.zoom).toBeGreaterThanOrEqual(e.y1);
    // an upper floor has no billboard: the rooms alone, as before
    const up = occupiedRoomsBox(stack, 1, layout, inRoomB)!;
    expect(phoneFrame(stack, 1, phoneView, up, 3)).toEqual({
      box: up,
      zoom: phoneFitZoom(phoneView, up, 3),
    });
  });

  it('takes only the rooms with someone in them, else every room of the floor', () => {
    const b = occupiedRoomsBox(stack, 1, layout, inRoomB)!;
    const all = occupiedRoomsBox(stack, 1, layout, [])!;
    const elsewhere = occupiedRoomsBox(stack, 1, layout, [{ tileCol: 18, tileRow: 6 }])!; // floor 1
    expect(all.x1 - all.x0).toBeGreaterThan(b.x1 - b.x0);
    expect(elsewhere).toEqual(all);
    expect(occupiedRoomsBox(stack, 1, { cols: 35 }, inRoomB)).toBeNull();
    // the room's iso corners lie inside the floor's slab
    const floor = floorBox(stack, 1);
    expect(b.x0).toBeGreaterThanOrEqual(floor.x0);
    expect(b.x1).toBeLessThanOrEqual(floor.x1);
    expect(b.y1).toBeLessThanOrEqual(floor.y1);
  });

  it('keeps the slab fit where no rooms are known, and the desktop as it was', () => {
    const slab = isoCameraStep(newIsoCam(), { ...phone, phoneBox: () => null });
    expect(slab.zoom).toBe(phoneFitZoom(phoneView, floorBox(stack, 1), 3));
    const desktop = isoCameraStep(newIsoCam(), {
      ...base,
      level: 1,
      focusId: '2',
      building: true,
      phoneBox: () => occupiedRoomsBox(stack, 1, layout, inRoomB),
    });
    expect(desktop.zoom).toBe(fitZoom(view, stack.box));
    const d2 = isoCameraStep(newIsoCam(), { ...base, level: 1, focusId: '2', building: true });
    expect(desktop).toEqual(d2);
  });

  it('follows the agents arriving after the first frame, until the user moves the camera', () => {
    const cam = newIsoCam();
    let box: ReturnType<typeof occupiedRoomsBox> = null;
    const first = isoCameraStep(cam, { ...phone, phoneBox: () => box });
    box = occupiedRoomsBox(stack, 1, layout, inRoomB);
    const next = isoCameraStep(cam, {
      ...phone,
      zoom: first.zoom!,
      pan: first.pan,
      phoneBox: () => box,
    });
    expect(next.pan).toEqual(
      panTo(mid(box!), stackCentre(stack), phoneFitZoom(phoneView, box!, 3)),
    );
    // the user pans: left alone
    const moved = { x: 5, y: 5 };
    const kept = isoCameraStep(cam, {
      ...phone,
      zoom: next.zoom ?? first.zoom!,
      pan: moved,
      manual: true,
      phoneBox: () => box,
    });
    expect(kept).toEqual({ pan: moved });
  });

  it('starts on the followed owner at the rooms zoom, not the ground floor billboard frame', () => {
    const rooms = occupiedRoomsBox(stack, 1, layout, inRoomB)!; // (the test layout has rooms on floor 2 only)
    const ground = { ...phone, level: 0, focusId: '1', phoneBox: () => rooms };
    const cam = newIsoCam();
    const first = isoCameraStep(cam, ground);
    expect(first.zoom).toBeLessThan(phoneFitZoom(phoneView, rooms, 3)); // the billboard frame
    const feet = { x: 10, y: 20 };
    const out = isoCameraStep(cam, { ...ground, zoom: first.zoom!, pan: first.pan, follow: feet });
    expect(out.zoom).toBe(phoneFitZoom(phoneView, rooms, 3));
    expect(out.zoom).toBeGreaterThanOrEqual(PHONE_ISO_ZOOM_MIN);
    expect(out.pan).toEqual(panTo(feet, stackCentre(stack), out.zoom!));
    // a follow that starts later keeps the zoom it has
    const later = isoCameraStep(cam, { ...ground, zoom: out.zoom!, pan: out.pan, follow: feet });
    expect(later.zoom).toBeUndefined();
  });

  it('keeps a manual zoom and pan, and reframes on a toggle back to the floor', () => {
    const rooms = occupiedRoomsBox(stack, 1, layout, inRoomB)!;
    const saved = { x: 123, y: -45 };
    expect(
      isoCameraStep(newIsoCam(), {
        ...phone,
        manual: true,
        zoom: 7,
        pan: saved,
        phoneBox: () => rooms,
      }),
    ).toEqual({ pan: saved });
    const cam = newIsoCam();
    const open = isoCameraStep(cam, { ...phone, phoneBox: () => rooms });
    const whole = isoCameraStep(cam, {
      ...phone,
      building: false,
      zoom: open.zoom!,
      pan: open.pan,
      phoneBox: () => rooms,
    });
    expect(whole.zoom).toBe(phoneFitZoom(phoneView, rooms, 3));
    const all = isoCameraStep(cam, {
      ...phone,
      building: true,
      zoom: whole.zoom!,
      pan: whole.pan,
      phoneBox: () => rooms,
    });
    expect(all.zoom).toBe(fitZoom(phoneView, stack.box, 3));
    const back = isoCameraStep(cam, {
      ...phone,
      building: false,
      zoom: all.zoom!,
      pan: all.pan,
      phoneBox: () => rooms,
    });
    expect(back.zoom).toBe(open.zoom);
  });
});

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

  it('opens the phone on the current floor and leaves its saved camera alone', () => {
    const desktop = isoCameraStep(newIsoCam(), {
      ...base,
      level: 1,
      focusId: '2',
      building: true,
    });
    const phone = isoCameraStep(newIsoCam(), {
      ...base,
      level: 1,
      focusId: '2',
      building: true,
      phone: true,
    });
    const floor = floorBox(stack, 1);
    expect(desktop.zoom).toBe(fitZoom(view, stack.box));
    expect(phone.zoom).toBe(phoneFitZoom(view, floor));
    expect(phone.zoom).toBeGreaterThan(desktop.zoom!);
    expect(phone.pan).toEqual(
      panTo(
        { x: (floor.x0 + floor.x1) / 2, y: (floor.y0 + floor.y1) / 2 },
        stackCentre(stack),
        phone.zoom!,
      ),
    );

    const saved = { x: 123, y: -45 };
    const restored = isoCameraStep(newIsoCam(), {
      ...base,
      level: 1,
      focusId: '2',
      building: true,
      phone: true,
      manual: true,
      zoom: 7,
      pan: saved,
    });
    expect(restored).toEqual({ pan: saved });
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
