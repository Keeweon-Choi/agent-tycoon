/** SPT-P3-FINISH: a requirement whose text is one Markdown table row (the daemon sends header, separator, row) reads as `column: value` lines. */
export interface RowCell {
  column: string;
  value: string;
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The cells of a `| a | b |` line; `\|` stays inside its cell. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n').trim());
}

/** The row's cells with their column names, or null when the text is anything else (rendered as Markdown as before). */
export function tableRowLines(text: string): RowCell[] | null {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 3 || !lines.every((l) => l.includes('|')) || !SEPARATOR.test(lines[1])) return null;
  const head = cells(lines[0]);
  const row = cells(lines[2]);
  if (head.length < 2 || head.length !== cells(lines[1]).length) return null;
  return head.flatMap((column, i) => (row[i] ? [{ column, value: row[i] }] : []));
}
