import { describe, expect, it } from 'vitest';

import {
  PERM_FOLD_CHARS,
  PERM_FOLD_LINES,
  PERM_PHONE_DETAIL_SHARE,
  permissionCommandIsLong,
  permissionDetailMaxHeight,
  permissionStartsFolded,
} from './permissionFit.js';

describe('permission card fit', () => {
  const manyLines = Array.from({ length: PERM_FOLD_LINES + 1 }, (_, i) => `l${i}`).join('\n');
  it('a command is long past the line or character limit', () => {
    expect(permissionCommandIsLong(undefined)).toBe(false);
    expect(permissionCommandIsLong('ls')).toBe(false);
    expect(permissionCommandIsLong(manyLines)).toBe(true);
    expect(permissionCommandIsLong('x'.repeat(PERM_FOLD_CHARS + 1))).toBe(true);
  });
  it('only a long command on a phone starts folded', () => {
    expect(permissionStartsFolded(manyLines, true)).toBe(true);
    expect(permissionStartsFolded(manyLines, false)).toBe(false);
    expect(permissionStartsFolded('ls', true)).toBe(false);
  });
  it('the phone box is a share of the visible height, none on a desktop', () => {
    expect(permissionDetailMaxHeight(false, 400, 800)).toBeUndefined();
    expect(permissionDetailMaxHeight(true, undefined, 800)).toBe(
      Math.floor(800 * PERM_PHONE_DETAIL_SHARE),
    );
    expect(permissionDetailMaxHeight(true, 400, 800)).toBe(Math.floor(400 * PERM_PHONE_DETAIL_SHARE));
  });
});
