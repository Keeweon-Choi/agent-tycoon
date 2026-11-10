import { afterEach, describe, expect, it } from 'vitest';

import { WHITEBOARD_FACE } from '../../constants.js';
import { overlayProjection } from '../../office/projection.js';
import { TILE_SIZE } from '../../office/types.js';
import {
  boardRect,
  inRect,
  memoRect,
  memoText,
  whiteboardHandleMessage,
  whiteboardMemos,
} from './whiteboard.js';

const layout = { cols: 40, rows: 30 };
const container = { width: 1000, height: 700 };
const project = (zoom: number, pan = { x: 0, y: 0 }) =>
  overlayProjection(layout, container, zoom, pan, 1);
const board = { col: 7, row: 3 };

describe('whiteboard memo geometry (T-0065)', () => {
  it('the memo face is the writable face of the sprite at every zoom', () => {
    for (const zoom of [1, 2, 3, 4, 6, 10]) {
      const p = project(zoom);
      const r = memoRect(board, p);
      expect(r.width).toBe(WHITEBOARD_FACE.w * zoom);
      expect(r.height).toBe(WHITEBOARD_FACE.h * zoom);
      // Left/top: the board's tile plus the face's offset, in the same projection the renderer uses.
      expect(r.left).toBe(p.toScreenX(board.col * TILE_SIZE + WHITEBOARD_FACE.x));
      expect(r.top).toBe(p.toScreenY(board.row * TILE_SIZE + WHITEBOARD_FACE.y));
    }
  });

  it('follows the pan, and sits inside the 2x2 footprint', () => {
    const still = memoRect(board, project(4));
    const panned = memoRect(board, project(4, { x: 30, y: -12 }));
    expect([panned.left - still.left, panned.top - still.top]).toEqual([30, -12]);
    const box = boardRect(board, project(4));
    expect([box.width, box.height]).toEqual([2 * TILE_SIZE * 4, 2 * TILE_SIZE * 4]);
    expect(still.left).toBeGreaterThanOrEqual(box.left);
    expect(still.top).toBeGreaterThanOrEqual(box.top);
    expect(still.left + still.width).toBeLessThanOrEqual(box.left + box.width);
    expect(still.top + still.height).toBeLessThanOrEqual(box.top + box.height);
  });

  it('the marker is whole px and three lines fill the face', () => {
    for (const zoom of [1, 2, 3, 4, 6, 10]) {
      const r = memoRect(board, project(zoom));
      const t = memoText(r);
      expect(Number.isInteger(t.fontPx)).toBe(true);
      expect(t.lineHeightPx * t.lines).toBe(r.height);
    }
    expect(memoText(memoRect(board, project(4))).fontPx).toBe(10);
  });

  it('a click inside the footprint hits, one outside does not', () => {
    const box = boardRect(board, project(3));
    expect(inRect(box, box.left + 1, box.top + 1)).toBe(true);
    expect(inRect(box, box.left + box.width, box.top)).toBe(false);
    expect(inRect(box, box.left - 1, box.top + 5)).toBe(false);
  });
});

describe('whiteboard memo store', () => {
  afterEach(() => whiteboardHandleMessage({ type: 'whiteboardMemos', memos: [] }));
  it('each message replaces the whole list', () => {
    whiteboardHandleMessage({
      type: 'whiteboardMemos',
      memos: [
        { uid: 'whiteboard:a', text: '\ud558\ub098', updatedAt: 1 },
        { uid: 'whiteboard:b', text: 'two', updatedAt: 2 },
      ],
    });
    expect([...whiteboardMemos().keys()]).toEqual(['whiteboard:a', 'whiteboard:b']);
    whiteboardHandleMessage({
      type: 'whiteboardMemos',
      memos: [{ uid: 'whiteboard:b', text: 'two', updatedAt: 2 }],
    });
    expect(whiteboardMemos().has('whiteboard:a')).toBe(false);
  });
});
