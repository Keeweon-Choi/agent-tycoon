import { describe, expect, it } from 'vitest';

import {
  FOLD_CHARS,
  FOLD_LINES,
  foldBubble,
  longMessageFileName,
  longMessageSuffix,
  messageCharacterCount,
  prepareMessage,
} from './longMessage.js';

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
  const long = Array.from({ length: FOLD_LINES + 3 }, (_, i) => `line ${i}`).join('\n');
  it('a long bubble folds to its first lines and opens whole; the toggle stays both ways', () => {
    const folded = foldBubble(long, false);
    expect(folded.long).toBe(true);
    expect(folded.shown.split('\n')).toHaveLength(FOLD_LINES);
    expect(folded.shown.endsWith('…')).toBe(true);
    expect(foldBubble(long, true)).toEqual({ long: true, shown: long });
  });
  it('a short bubble has no toggle; a very long single line folds by characters', () => {
    expect(foldBubble('hi', false)).toEqual({ long: false, shown: 'hi' });
    expect(foldBubble('x'.repeat(FOLD_CHARS + 1), false).shown).toHaveLength(FOLD_CHARS + 1);
  });
});
