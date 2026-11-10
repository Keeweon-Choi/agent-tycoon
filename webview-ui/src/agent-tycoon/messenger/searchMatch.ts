/** A range in a source string. Search is deliberately text based: callers render
 * these ranges as React nodes instead of ever inserting the query as HTML. */
export interface MatchRange {
  start: number;
  end: number;
}

/** All non-overlapping, locale-insensitive matches, left to right. */
export function matchRanges(text: string, query: string): MatchRange[] {
  const needle = query.trim();
  if (!needle) return [];
  const haystack = text.toLocaleLowerCase();
  const foldedNeedle = needle.toLocaleLowerCase();
  const ranges: MatchRange[] = [];
  let from = 0;
  while (from < text.length) {
    const start = haystack.indexOf(foldedNeedle, from);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    from = start + needle.length;
  }
  return ranges;
}

/** Result indexes are newest-first. Older moves down the result list. */
export function stepSearchResult(
  current: number,
  total: number,
  direction: 'older' | 'newer',
): number {
  if (total <= 0) return -1;
  const start = current < 0 ? 0 : current;
  return direction === 'older' ? (start + 1) % total : (start - 1 + total) % total;
}
