/** The grow ring is only drawn where a click on it can grow the grid: not around a generated agty office. */
import assert from 'node:assert/strict';

import { expect, test } from 'vitest';

import { buildEditorRenderState } from '../office/editor/editorRenderState.js';
import { EditorState } from '../office/editor/editorState.js';
import type { OfficeLayout } from '../office/types.js';
import { EditTool, TileType } from '../office/types.js';

const layout = (agty: boolean): OfficeLayout => ({
  version: 1,
  cols: 2,
  rows: 2,
  tiles: new Array(4).fill(TileType.FLOOR_1),
  furniture: [],
  ...(agty && { agtyBase: 'base' }),
});

test.each([EditTool.TILE_PAINT, EditTool.WALL_PAINT, EditTool.ERASE])(
  'tool %s: the ring shows on a layout that can grow, not on an agty office',
  (tool) => {
    const editorState = new EditorState();
    editorState.activeTool = tool;
    assert.equal(buildEditorRenderState(editorState, layout(false)).showGhostBorder, true);
    expect(buildEditorRenderState(editorState, layout(true)).showGhostBorder).toBe(false);
  },
);
