import { expect, it } from 'vitest';

import { parseRange } from './range.js';

it('reads one byte range against the file size', () => {
  expect(parseRange(undefined, 1000)).toBeNull();
  expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
  expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 });
  expect(parseRange('bytes=0-0', 1000)).toEqual({ start: 0, end: 0 });
});

it('refuses ranges outside the file or malformed, and ignores what it does not understand', () => {
  for (const header of ['bytes=1000-', 'bytes=2000-3000', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=abc'])
    expect(parseRange(header, 1000)).toBe('unsatisfiable');
  expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  expect(parseRange('bytes=-10', 0)).toBe('unsatisfiable');
  expect(parseRange('items=0-5', 1000)).toBeNull();
  expect(parseRange('bytes=0-5,10-15', 1000)).toBeNull();
});
