import { describe, expect, it } from 'vitest';

import type { RepoCleanupRow, RepoConflictFile } from '../../../../core/src/messages.js';
import { canMark, choicesFor, defaultChecked, fixingLock, segments, setPick, sizeText } from './mergeState.js';

const block = (startLine: number, endLine: number) => ({ startLine, endLine, ours: 'a', theirs: 'b' });
const file = (path: string, blocks: number): RepoConflictFile => ({
  path,
  blocks: Array.from({ length: blocks }, (_, i) => block(2 + i * 5, 6 + i * 5)),
});

describe('conflict picks', () => {
  it('sends one choice per block, in the listed order, only once every block is picked', () => {
    const f = file('a.ts', 2);
    let picks = setPick({}, 'a.ts', 1, 2, 'both');
    expect(choicesFor(picks, f)).toBeNull();
    expect(canMark(picks, [f])).toBe(false);
    picks = setPick(picks, 'a.ts', 0, 2, 'theirs');
    expect(choicesFor(picks, f)).toEqual(['theirs', 'both']);
    expect(canMark(picks, [f])).toBe(true);
    // Picking a block again (re-opened) takes it back.
    expect(choicesFor(setPick(picks, 'a.ts', 0, 2, undefined), f)).toBeNull();
  });

  it('cannot mark a file that has no block to pick from, and a merge with no file left is markable', () => {
    expect(canMark({}, [file('bin.png', 0)])).toBe(false);
    expect(canMark({}, [])).toBe(true);
  });
});

describe('segments', () => {
  const text = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n');
  it('shows a few lines around a block and leaves the far ones out', () => {
    const out = segments(text, [block(10, 14)], 2);
    expect(out.map((s) => s.kind)).toEqual(['ctx', 'block', 'ctx']);
    const [before, , after] = out;
    expect(before.kind === 'ctx' && before.lines.map((l) => l.no)).toEqual([8, 9]);
    expect(after.kind === 'ctx' && after.lines.map((l) => l.no)).toEqual([15, 16]);
  });
});

describe('cleanup numbers', () => {
  it('checks the merged rows only', () => {
    const rows = [{ task: 'a', merged: true }, { task: 'b', merged: false }] as RepoCleanupRow[];
    expect([...defaultChecked(rows)]).toEqual(['a']);
  });
  it('writes sizes the way W3 does', () => {
    expect(sizeText(480 * 1024 ** 2)).toBe('480 MB');
    expect(sizeText(1.8 * 1024 ** 3)).toBe('1.8 GB');
    expect(sizeText(0)).toBe('0 B');
  });
});

describe('merge lock', () => {
  it('locks only while notes are being fixed and the task is still doing', () => {
    expect(fixingLock({ notesFixing: 1 }, 'doing')).toBe(true);
    expect(fixingLock({ notesFixing: 1 }, 'review')).toBe(false);
    expect(fixingLock({ notesFixing: 0 }, 'doing')).toBe(false);
  });
});
