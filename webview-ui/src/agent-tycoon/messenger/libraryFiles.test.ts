import { describe, expect, it } from 'vitest';

import type { ChatLibraryFile } from '../../../../core/src/messages.js';
import { libraryGone, mergeLibrary } from './libraryFiles.js';

const file = (id: string, path?: string): ChatLibraryFile => ({ id, at: 1, kind: 'user', name: id, ...(path && { path }) });

describe('library files', () => {
  it('keeps the newest row of a path sent twice, and every row without a path', () => {
    const merged = mergeLibrary([file('a', '/p/x'), file('b')], [file('c', '/p/x'), file('d', '/p/y'), file('e')]);
    expect(merged.map((f) => f.id)).toEqual(['a', 'b', 'd', 'e']);
  });
  it('calls a missing, unavailable or pathless file gone', () => {
    expect(libraryGone({ path: '/p/x' })).toBe(false);
    expect(libraryGone({ path: '/p/x', missing: true })).toBe(true);
    expect(libraryGone({ path: '/p/x', unavailable: true })).toBe(true);
    expect(libraryGone({})).toBe(true);
  });
});
