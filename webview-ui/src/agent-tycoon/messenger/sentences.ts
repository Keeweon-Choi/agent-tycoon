/**
 * Messenger length rules count sentences, not characters (an English line has more characters than the same
 * Korean one): how long a reply types, when it folds behind 더 보기, how much of a question the card shows.
 *
 * A sentence ends at . ! ? (when a space or the end of the line follows, so 3.14, v1.2, a.ts and URLs stay
 * whole), at … 。 ！ ？ (alone), and at every line end (a list item, a table row, a heading). A fenced code
 * block is one sentence. Short forms like "e.g." and "Mr." do not end one.
 */

const END = /(?:[.!?]+|[…。！？]+)[)"'”’」』\]]*/g;
const FENCE = /^\s*(?:```|~~~)/;
const MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const SHORT_FORM = /(?:\be\.g|\bi\.e|\bmr|\bmrs|\bms|\bdr|\bprof|\bvs|\bcf|\bfig|\bno)\.$/i;

/** The text cut into sentences; joined again they are the text. Blank space rides on the sentence before it. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let lead = '';
  const add = (piece: string) => {
    if (piece.trim() === '') {
      if (out.length) out[out.length - 1] += piece;
      else lead += piece;
    } else {
      out.push(lead + piece);
      lead = '';
    }
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const nl = i < lines.length - 1 ? '\n' : '';
    if (FENCE.test(lines[i])) {
      // The whole block, up to and with its closing fence (or the end of the text).
      let block = lines[i] + nl;
      while (++i < lines.length) {
        const last = i === lines.length - 1;
        block += lines[i] + (last ? '' : '\n');
        if (FENCE.test(lines[i])) break;
      }
      add(block);
      continue;
    }
    const line = lines[i];
    let start = 0;
    END.lastIndex = MARKER.exec(line)?.[0].length ?? 0;
    for (let m = END.exec(line); m; m = END.exec(line)) {
      let end = m.index + m[0].length;
      const word = /^[.!?]/.test(m[0]);
      if (word && end < line.length && !/\s/.test(line[end])) continue;
      if (word && SHORT_FORM.test(line.slice(0, m.index + 1))) continue;
      while (end < line.length && /\s/.test(line[end])) end++;
      add(line.slice(start, end));
      start = end;
      END.lastIndex = end;
    }
    add(line.slice(start) + nl);
  }
  return out;
}

export const countSentences = (text: string): number => splitSentences(text).length;
