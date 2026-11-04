import { describe, expect, it } from 'vitest';

import {
  ISO_BILLBOARD,
  ISO_BILLBOARD_BODY,
  ISO_SLAB_H,
  ISO_STOREY_H,
  ISO_WALL_H,
} from '../../constants.js';
import { billboardBox } from './billboard.js';
import { inStorey, onFaces, onRoof, plateCorners, plateEdges } from './facade.js';
import { floorBox, isoStack } from './projection.js';

const building = (depth: number, floors = 3) =>
  isoStack({
    cols: 35,
    rows: floors * (depth + 2),
    cldFloors: Array.from({ length: floors }, (_, k) => ({
      id: String(k + 1),
      row: k * (depth + 2),
      rows: depth,
      cols: 35,
    })),
  });

describe('the building outside (building-a-1104)', () => {
  it('stands a storey on its plate: its walls up to the slab above, nothing past its edges', () => {
    const stack = building(24);
    for (const level of [0, 1, 2]) {
      const lift = stack.lifts[level];
      const { L, R } = plateCorners(stack.cols, stack.depth, lift);
      const mid = (L.x + R.x) / 2;
      const [back, front] = plateEdges(stack.cols, stack.depth, lift, mid);
      expect(inStorey(stack.cols, stack.depth, lift, mid, (back + front) / 2)).toBe(true);
      expect(inStorey(stack.cols, stack.depth, lift, mid, back - ISO_WALL_H)).toBe(true);
      expect(inStorey(stack.cols, stack.depth, lift, mid, back - ISO_WALL_H - 1)).toBe(false);
      expect(inStorey(stack.cols, stack.depth, lift, mid, front + ISO_SLAB_H)).toBe(false);
      expect(inStorey(stack.cols, stack.depth, lift, L.x - 1, L.y)).toBe(false);
      // Flush: the storey above starts where this one's walls end.
      const up = plateEdges(stack.cols, stack.depth, lift + ISO_STOREY_H, mid);
      expect(up[1] + ISO_SLAB_H).toBe(front - ISO_WALL_H);
    }
  });

  it('gives a point of the closed building to one storey: its front faces, or the roof', () => {
    const stack = building(24);
    const { cols, depth, lifts } = stack;
    const top = lifts.length - 1;
    for (let x = -24 * 8; x < 35 * 8; x += 5)
      for (let y = -260; y < 260; y += 3) {
        const on = lifts.filter((l) => onFaces(cols, depth, l, x, y)).length;
        const roof = onRoof(cols, depth, lifts[top], x, y) ? 1 : 0;
        expect(on + roof, `${x},${y}`).toBeLessThanOrEqual(1);
      }
    // The left corner, a storey up: 2F's face, not the roof (3F's prism covers it whole).
    const { L } = plateCorners(cols, depth, 0);
    const y = L.y - ISO_STOREY_H - 30;
    expect(onFaces(cols, depth, lifts[1], L.x + 4, y)).toBe(true);
    expect(onRoof(cols, depth, lifts[top], L.x + 4, y)).toBe(false);
  });

  it('puts the billboard on the ground in front, clear of every storey, in the lobby frame', () => {
    for (const depth of [16, 24, 30]) {
      const stack = building(depth);
      const b = billboardBox(stack);
      expect(b.x1 - b.x0).toBe(ISO_BILLBOARD.w);
      expect(b.y1 - b.y0).toBe(ISO_BILLBOARD.h);
      expect(b.ground).toBeGreaterThan(b.y1);
      // Never over the building: no point of its face (nor its posts) is on a storey.
      // The face, the posts and the case's top and right side (up and right of the face).
      for (let x = b.x0; x <= b.x1 + ISO_BILLBOARD_BODY.depth; x += 4)
        for (let y = b.y0 - ISO_BILLBOARD_BODY.depth / 2; y <= b.ground; y += 4)
          for (const lift of stack.lifts)
            expect(inStorey(stack.cols, stack.depth, lift, x, y), `${depth}: ${x},${y}`).toBe(
              false,
            );
      // Inside the lobby's own frame sideways (the floor view frames floor 1's box).
      const f = floorBox(stack, 0);
      expect(b.x0).toBeGreaterThanOrEqual(f.x0);
      expect(b.x1).toBeLessThanOrEqual(f.x1);
    }
  });
});
