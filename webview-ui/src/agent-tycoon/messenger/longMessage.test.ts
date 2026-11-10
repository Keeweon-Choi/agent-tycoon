import { describe, expect, it } from 'vitest';

import { MSG_FOLD_SENTENCES } from '../../constants.js';
import {
  foldBubble,
  hitHiddenByFold,
  longMessageFileName,
  longMessageSuffix,
  messageCharacterCount,
  prepareMessage,
} from './longMessage.js';
import { splitSentences } from './sentences.js';

describe('long messenger message', () => {
  const at = new Date(2026, 9, 23, 16, 20);

  it('leaves text at or under the limit unchanged', () => {
    expect(prepareMessage('abc', 3, at)).toEqual({ text: 'abc' });
    expect(prepareMessage('ab', 3, at)).toEqual({ text: 'ab' });
  });

  it('puts over-limit text in a timestamped UTF-8 Markdown attachment', () => {
    const source = `${'first line '.repeat(60)}\nthe second line stays in the file`;
    expect(prepareMessage(source, 200, at)).toEqual({
      text: `${Array.from(source.split('\n')[0]).slice(0, 200).join('')}${longMessageSuffix()}`,
      attachment: {
        name: 'message-20261023-1620.md',
        content: source,
        type: 'text/markdown',
      },
    });
    expect(longMessageFileName(at)).toBe('message-20261023-1620.md');
  });

  it('counts Hangul and emoji as characters, not UTF-8 bytes', () => {
    expect(messageCharacterCount('a😀b')).toBe(3);
    const source = '😀'.repeat(201);
    const prepared = prepareMessage(source, 200, at);
    expect(prepared.attachment?.content).toBe(source);
    expect(messageCharacterCount(prepared.text.replace(longMessageSuffix(), ''))).toBe(200);
  });
});

describe('bubble fold (show more / collapse)', () => {
  const long = Array.from({ length: MSG_FOLD_SENTENCES + 3 }, (_, i) => `Sentence ${i}.`).join(' ');
  it('a long bubble folds to its first sentences and opens whole; the toggle stays both ways', () => {
    const folded = foldBubble(long, false);
    expect(folded.long).toBe(true);
    expect(splitSentences(folded.shown.slice(0, -1))).toHaveLength(MSG_FOLD_SENTENCES);
    expect(folded.shown.endsWith('.…')).toBe(true);
    expect(foldBubble(long, true)).toEqual({ long: true, shown: long });
  });
  it('folds by sentences in any language; a short bubble, however long its words, has no toggle', () => {
    expect(foldBubble(Array.from({ length: MSG_FOLD_SENTENCES + 1 }, () => '\ub124.').join(' '), false).long).toBe(true);
    expect(foldBubble('hi', false)).toEqual({ long: false, shown: 'hi' });
    const wide = 'x'.repeat(5000);
    expect(foldBubble(wide, false)).toEqual({ long: false, shown: wide });
  });
});

describe('a search hit behind a fold', () => {
  const sentence = (n: number, extra = '') => `Sentence ${n} is here${extra}.`;
  const long = (extra: Record<number, string> = {}) =>
    Array.from({ length: 12 }, (_, i) => sentence(i + 1, extra[i] ?? '')).join(' ');

  it('is hidden when the word is only past the folded sentences', () => {
    expect(hitHiddenByFold(long({ 11: ' plum' }), 'plum')).toBe(true);
  });

  it('is not hidden when the folded part already shows the word', () => {
    expect(hitHiddenByFold(long({ 1: ' plum' }), 'plum')).toBe(false);
  });

  it('is not hidden in a short message, with no query, or with no match at all', () => {
    expect(hitHiddenByFold(sentence(1, ' plum'), 'plum')).toBe(false);
    expect(hitHiddenByFold(long({ 11: ' plum' }), undefined)).toBe(false);
    expect(hitHiddenByFold(long(), 'plum')).toBe(false);
  });
});
