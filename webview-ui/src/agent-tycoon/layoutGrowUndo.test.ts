/**
 * Growing the grid from the ghost border (floor tool, left of / above the office) and undoing it. The
 * undo entry must hold the layout from before the growth, and undo / redo must move the characters
 * back / forward with it, or they stand one tile off after a Ctrl+Z. A fake office records what the
 * hook asks of it; React's hooks are stood in for.
 */
import assert from 'node:assert/strict';

import { expect, test, vi } from 'vitest';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
  useRef: (init: unknown) => ({ current: init }),
  useCallback: (fn: unknown) => fn,
}));
vi.mock('../transport/index.js', () => ({ transport: { send: () => {}, onMessage: () => () => {} } }));
vi.stubGlobal('window', { devicePixelRatio: 1 });

import { useEditorActions } from '../hooks/useEditorActions.js';
import { EditorState } from '../office/editor/editorState.js';
import type { OfficeLayout } from '../office/types.js';
import { EditTool, TileType } from '../office/types.js';

const base = (): OfficeLayout => ({
  version: 1,
  cols: 4,
  rows: 3,
  tiles: new Array(12).fill(TileType.FLOOR_1),
  furniture: [],
});

/** An office that only keeps its layout and the tile column one character stands on. */
function fakeOffice() {
  const office = {
    layout: base(),
    characterCol: 2,
    shiftArgs: [] as unknown[],
    getLayout: () => office.layout,
    rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }) {
      office.layout = layout;
      office.shiftArgs.push(shift);
      office.characterCol += shift?.col ?? 0;
    },
  };
  return office;
}

function setup() {
  const office = fakeOffice();
  const editorState = new EditorState();
  editorState.activeTool = EditTool.TILE_PAINT;
  /* eslint-disable-next-line react-hooks/rules-of-hooks -- a plain function standing in for a component */
  const editor = useEditorActions(() => office as never, editorState);
  return { office, editorState, editor };
}

test('a stroke that grows the grid left is one undo entry holding the grid from before, and undo / redo move the characters with it', () => {
  const { office, editorState, editor } = setup();
  editor.handleEditorTileAction(-1, 1);
  editorState.endStroke();
  assert.equal(office.layout.cols, 5);
  assert.equal(office.characterCol, 3);
  assert.equal(editorState.undoStack.length, 1);
  assert.equal(editorState.undoStack[0].cols, 4, 'the entry is the layout from before the growth');

  editor.handleUndo();
  assert.equal(office.layout.cols, 4);
  assert.equal(office.characterCol, 2, 'back where it stood');

  editor.handleRedo();
  assert.equal(office.layout.cols, 5);
  assert.equal(office.characterCol, 3);
});

test('a growth in the middle of a stroke undoes with the rest of the stroke', () => {
  const { office, editorState, editor } = setup();
  editor.handleEditorTileAction(1, 1);
  editor.handleEditorTileAction(-1, 1);
  editorState.endStroke();
  assert.equal(editorState.undoStack.length, 1);
  editor.handleUndo();
  assert.deepEqual([office.layout.cols, office.characterCol], [4, 2]);
  expect(editorState.redoStack.length).toBe(1);
});

test('undo and redo of an edit that grew nothing pass no shift, so the floors still carry their characters', () => {
  const { office, editorState, editor } = setup();
  editor.handleEditorTileAction(1, 1);
  editorState.endStroke();
  office.shiftArgs.length = 0;
  editor.handleUndo();
  editor.handleRedo();
  assert.deepEqual(office.shiftArgs, [undefined, undefined]);
});
