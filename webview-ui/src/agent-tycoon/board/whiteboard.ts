/**
 * The whiteboard memos (T-0065): the memos the server sent, by furniture uid,
 * and the pure geometry that puts a memo over its board's writable face.
 */
import { useSyncExternalStore } from 'react';

import type { WhiteboardMemos } from '../../../../core/src/messages.js';
import {
  WHITEBOARD_FACE,
  WHITEBOARD_FONT_UNITS,
  WHITEBOARD_LINE_UNITS,
  WHITEBOARD_LINES,
} from '../../constants.js';
import type { OverlayProjection } from '../../office/projection.js';
import { TILE_SIZE } from '../../office/types.js';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
type Project = Pick<OverlayProjection, 'toScreenX' | 'toScreenY'>;
interface BoardAt {
  col: number;
  row: number;
}

/** A world rectangle (sprite px, relative to the board's tile) in the container's CSS px. */
function screenRect(board: BoardAt, x: number, y: number, w: number, h: number, p: Project): Rect {
  const [x0, y0] = [board.col * TILE_SIZE + x, board.row * TILE_SIZE + y];
  const [left, top] = [p.toScreenX(x0), p.toScreenY(y0)];
  return { left, top, width: p.toScreenX(x0 + w) - left, height: p.toScreenY(y0 + h) - top };
}

/** The face a memo is written on (inside the frame). */
export const memoRect = (board: BoardAt, p: Project): Rect =>
  screenRect(board, WHITEBOARD_FACE.x, WHITEBOARD_FACE.y, WHITEBOARD_FACE.w, WHITEBOARD_FACE.h, p);

/** The whole 2x2-tile footprint: what a click on the board hits. */
export const boardRect = (board: BoardAt, p: Project): Rect =>
  screenRect(board, 0, 0, 2 * TILE_SIZE, 2 * TILE_SIZE, p);

/** The marker's size for a face drawn `rect`: whole px, the line height an exact third of the face. */
export function memoText(rect: Rect): { fontPx: number; lineHeightPx: number; lines: number } {
  const unit = rect.width / WHITEBOARD_FACE.w; // CSS px per sprite px
  return {
    fontPx: Math.max(1, Math.round(unit * WHITEBOARD_FONT_UNITS)),
    lineHeightPx: unit * WHITEBOARD_LINE_UNITS,
    lines: WHITEBOARD_LINES,
  };
}

export const inRect = (r: Rect, x: number, y: number): boolean =>
  x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;

// ── The memos the server holds ──────────────────────────────────

export type Memos = ReadonlyMap<string, { text: string; updatedAt: number }>;
let memos: Memos = new Map();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const whiteboardMemos = (): Memos => memos;
export const useWhiteboardMemos = () => useSyncExternalStore(subscribe, whiteboardMemos);

/** whiteboardMemos: the full list replaces what was held. */
export function whiteboardHandleMessage(msg: WhiteboardMemos): void {
  memos = new Map(msg.memos.map((m) => [m.uid, { text: m.text, updatedAt: m.updatedAt }]));
  listeners.forEach((l) => l());
}
