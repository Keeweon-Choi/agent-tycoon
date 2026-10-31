/**
 * The editor's pure text rules: which lines of the disk's text an agent changed since the text was
 * loaded (the yellow lines), and the line ending a save writes back (CodeMirror holds `\n` only).
 */

/** Past this many lines in the changed middle the whole middle is marked (no line-by-line match). */
const MATCH_LIMIT = 2000;

export const lf = (text: string): string => text.replace(/\r\n?/g, '\n');
export const eolOf = (text: string): '\r\n' | '\n' => (text.includes('\r\n') ? '\r\n' : '\n');
export const withEol = (text: string, eol: '\r\n' | '\n'): string =>
  eol === '\n' ? text : text.replace(/\n/g, eol);

/** 1-based line numbers of `after` that `before` does not have (a deletion marks the line now at its place). */
export function changedLines(before: string, after: string): number[] {
  const a = lf(before).split('\n');
  const b = lf(after).split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const marked = new Set<number>();
  if (x.length > MATCH_LIMIT || y.length > MATCH_LIMIT) y.forEach((_, i) => marked.add(head + i));
  else {
    // Longest common subsequence of the middles: the lines of `y` it does not use are the new ones.
    const width = y.length + 1;
    const table = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        table[i * width + j] =
          x[i] === y[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0;
    let j = 0;
    while (j < y.length) {
      if (i < x.length && x[i] === y[j]) {
        i++;
        j++;
      } else if (i < x.length && table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else marked.add(head + j++);
    }
  }
  // Lines only removed: mark the line that now sits where they were.
  if (!marked.size && x.length) marked.add(Math.min(head, b.length - 1));
  return [...marked].sort((p, q) => p - q).map((n) => n + 1);
}

/** "6, 7" for the caption under the editor; a long run is cut. */
export const lineList = (lines: readonly number[]): string =>
  lines.length > 6 ? `${lines.slice(0, 6).join(', ')} …` : lines.join(', ');
