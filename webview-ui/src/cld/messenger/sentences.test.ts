// The messenger counts sentences (Korean and English alike): where one ends and what does not end one.
import { describe, expect, it } from 'vitest';

import { countSentences, splitSentences } from './sentences.js';

/** The pieces, trimmed, and a check that they join back into the text. */
const split = (text: string): string[] => {
  const parts = splitSentences(text);
  expect(parts.join('')).toBe(text);
  return parts.map((p) => p.trim());
};

describe('splitSentences', () => {
  it('ends a sentence at . ! ? … 。 and at a line end', () => {
    expect(split('Done. Really? Yes! Ok…')).toEqual(['Done.', 'Really?', 'Yes!', 'Ok…']);
    expect(split('\ub05d\ub0ac\uc5b4\uc694. \uc815\ub9d0\uc694? \ub124!')).toEqual(['\ub05d\ub0ac\uc5b4\uc694.', '\uc815\ub9d0\uc694?', '\ub124!']);
    expect(split('完了しました。確認します。')).toEqual(['完了しました。', '確認します。']);
    expect(split('first line\nsecond line')).toEqual(['first line', 'second line']);
  });
  it('counts a Korean and an English sentence the same, whatever their length', () => {
    expect(countSentences('\ubc30\ud3ec\ud588\uc5b4\uc694. \ud655\uc778\ud574 \uc8fc\uc138\uc694.')).toBe(2);
    expect(countSentences('I deployed the whole service to staging. Please check it carefully.')).toBe(2);
  });
  it('treats every list item, table row and heading as one sentence', () => {
    expect(split('- one\n- two\n3. three\n4) four')).toEqual(['- one', '- two', '3. three', '4) four']);
    expect(split('- one. two\n- three')).toEqual(['- one.', 'two', '- three']);
    expect(countSentences('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(3);
    expect(countSentences('# Title\nBody text.')).toBe(2);
  });
  it('does not end a sentence inside numbers, versions, file names, URLs or short forms', () => {
    expect(split('Pi is 3.14 and v1.2 shipped.')).toEqual(['Pi is 3.14 and v1.2 shipped.']);
    expect(split('Edit src/app.ts then run foo.sh now.')).toEqual(['Edit src/app.ts then run foo.sh now.']);
    expect(split('See https://example.com/a.b?x=1&y=2 for details.')).toEqual(['See https://example.com/a.b?x=1&y=2 for details.']);
    expect(split('Use e.g. a list, i.e. not a table. Ask Mr. Kim or Dr. Lee.')).toEqual(['Use e.g. a list, i.e. not a table.', 'Ask Mr. Kim or Dr. Lee.']);
  });
  it('keeps closing quotes and brackets with their sentence and runs of marks as one end', () => {
    expect(split('He said "stop." Then (really?) left?! Wait...')).toEqual(['He said "stop."', 'Then (really?)', 'left?!', 'Wait...']);
  });
  it('counts a fenced code block as one sentence, an unclosed one too', () => {
    const text = 'Run this.\n```js\nconst a = 1.5;\nfoo(); bar();\n```\nThen done.';
    expect(split(text)).toEqual(['Run this.', '```js\nconst a = 1.5;\nfoo(); bar();\n```', 'Then done.']);
    expect(split('Look:\n```\nunclosed. code. here.')).toEqual(['Look:', '```\nunclosed. code. here.']);
  });
  it('mixed Korean and English text', () => {
    expect(split('`npm test` \ub97c \ub3cc\ub838\uc5b4\uc694. All 12 tests passed. \ub2e4\uc74c\uc740 v2.0 \ubc30\ud3ec\uc608\uc694!')).toEqual([
      '`npm test` \ub97c \ub3cc\ub838\uc5b4\uc694.',
      'All 12 tests passed.',
      '\ub2e4\uc74c\uc740 v2.0 \ubc30\ud3ec\uc608\uc694!',
    ]);
  });
  it('blank text has no sentences; blank lines ride on the sentence before', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences(' \n ')).toEqual([]);
    expect(split('A.\n\n\nB.')).toEqual(['A.', 'B.']);
  });
});
