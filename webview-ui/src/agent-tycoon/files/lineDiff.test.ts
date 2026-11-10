import { describe, expect, it } from 'vitest';

import { changedLines, eolOf, lf, withEol } from './lineDiff.js';

const doc = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');

describe('changedLines', () => {
  it('marks the lines an agent changed, not the untouched ones between two edits', () => {
    expect(changedLines(doc, doc.replace('b', 'B').replace('e', 'E'))).toEqual([2, 5]);
  });
  it('marks added lines, and the line that took the place of a removed one', () => {
    expect(changedLines(doc, 'a\nb\nx\ny\nc\nd\ne\nf')).toEqual([3, 4]);
    expect(changedLines(doc, 'a\nb\nd\ne\nf')).toEqual([3]);
    expect(changedLines(doc, doc)).toEqual([]);
  });
  it('ignores line-ending differences', () => {
    expect(changedLines('a\r\nb', 'a\nb')).toEqual([]);
  });
});

it('writes back the line ending the file had', () => {
  expect(eolOf('a\r\nb')).toBe('\r\n');
  expect(withEol(lf('a\r\nb\r\n'), eolOf('a\r\nb\r\n'))).toBe('a\r\nb\r\n');
  expect(withEol('a\nb', eolOf('a\nb'))).toBe('a\nb');
});
