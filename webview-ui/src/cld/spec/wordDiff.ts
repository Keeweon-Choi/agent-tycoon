/**
 * SPT-P1C: the word diff 같은 항목 확인 shows between a candidate's old text and the current one
 * (both at most 4 KB). LCS over words; past SPEC_DIFF_CELLS_MAX cells it gives up and marks
 * nothing (the two texts are still shown whole).
 */
import { SPEC_DIFF_CELLS_MAX } from '../../constants.js';

export type Part = { text: string; changed: boolean };

/** The old text's words (changed = gone in the new one) and the new text's (changed = not in the old one). */
export function wordDiff(before: string, after: string): { old: Part[]; now: Part[] } {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if (a.length * b.length > SPEC_DIFF_CELLS_MAX) return { old: [{ text: before, changed: false }], now: [{ text: after, changed: false }] };
  // lcs[i][j]: the common length of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const old: Part[] = [];
  const now: Part[] = [];
  const add = (list: Part[], text: string, changed: boolean) => {
    const last = list.at(-1);
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      add(old, a[i++], false);
      add(now, b[j++], false);
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) add(now, b[j++], !/^\s+$/.test(b[j - 1]));
    else add(old, a[i++], !/^\s+$/.test(a[i - 1]));
  }
  return { old, now };
}
