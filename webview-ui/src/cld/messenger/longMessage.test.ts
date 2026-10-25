import { describe, expect, it } from 'vitest';

import {
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
