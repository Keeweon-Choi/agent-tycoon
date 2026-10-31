/** One satisfiable byte range of a file of `size` bytes, both ends inclusive. */
export type ByteRange = { start: number; end: number };

/**
 * An HTTP `Range` header against a file size: null (no header, another unit or several ranges: the
 * whole file is sent, as RFC 9110 allows), 'unsatisfiable' (a malformed range, or one starting past the end: 416),
 * or the range with its end clamped to the file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const unit = /^\s*bytes\s*=(.*)$/i.exec(header);
  if (!unit || unit[1].includes(',')) return null;
  const spec = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(unit[1]);
  if (!spec || (spec[1] === '' && spec[2] === '')) return 'unsatisfiable';
  if (spec[1] === '') {
    // A suffix: the last N bytes.
    const length = Number(spec[2]);
    return length === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(spec[1]);
  const end = spec[2] === '' ? size - 1 : Math.min(Number(spec[2]), size - 1);
  return start >= size || start > end ? 'unsatisfiable' : { start, end };
}
