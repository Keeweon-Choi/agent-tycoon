/**
 * building-a-1104 (owner 11-04 19:47, 21:04): the lobby board moved out of the building as a
 * billboard on posts, on the ground in front of the building's left face. Its face is level with
 * the screen (the old board's screen reads without a tilt); its case (a top and a right side at
 * the iso angle) and the face sit wholly below that face's slab line, so it never covers the
 * building nor a walkway inside it; near the left corner, so the lobby's own view (and the whole
 * building's) has it on screen. Pure (the Node runner tests it).
 */
import {
  ISO_BILLBOARD,
  ISO_BILLBOARD_BODY,
  ISO_HALF_H,
  ISO_HALF_W,
  ISO_SLAB_H,
} from '../../constants.js';
import type { IsoStack } from './projection.js';

export interface BillboardBox {
  /** The face (iso px): left, top, right, bottom. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Where its posts meet the ground (iso px), and the posts' x. */
  ground: number;
  posts: [number, number];
  /** All it covers (iso px): the case up and right of the face, the shadow down and right of the
   *  posts (what the camera frames). */
  extent: { x0: number; y0: number; x1: number; y1: number };
}

/** The billboard of a building (floor 1's plane: it stands on the ground). */
export function billboardBox(stack: Pick<IsoStack, 'depth'>): BillboardBox {
  const b = ISO_BILLBOARD;
  const left = { x: -stack.depth * ISO_HALF_W, y: stack.depth * ISO_HALF_H };
  const x1 = left.x + b.along;
  // The left face's slab line falls to the right: clear of it at the face's right end is clear
  // of it all along.
  // The case's top runs up and right by its depth (a depth's half up): clear of the slab line too.
  const { depth, shadow } = ISO_BILLBOARD_BODY;
  const y0 = left.y + (x1 - left.x) / 2 + ISO_SLAB_H + b.gap + depth;
  const y1 = y0 + b.h;
  const x0 = x1 - b.w;
  const ground = y1 + b.post;
  return {
    x0,
    y0,
    x1,
    y1,
    ground,
    posts: [x0 + b.postIn, x1 - b.postIn],
    extent: { x0, y0: y0 - depth / 2, x1: x1 + Math.max(depth, shadow.dx), y1: ground + shadow.dy },
  };
}
