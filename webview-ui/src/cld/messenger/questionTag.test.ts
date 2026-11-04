import { describe, expect, it } from 'vitest';

import { plainText } from '../../../../core/src/cld/plainText.js';
import { splitQuestionTags, stripQuestionTags, tagText } from '../../../../core/src/cld/questionTag.js';

describe('question tags', () => {
  it('reads a valid name', () => {
    expect(splitQuestionTags('Merge now? \u27e8q:merge-order\u27e9')).toEqual([
      'Merge now? ',
      { tag: 'merge-order' },
    ]);
  });

  it('reads several, in order, with the text between', () => {
    expect(splitQuestionTags('\u27e8q:aa\u27e9 and \u27e8q:b2-c\u27e9.')).toEqual([
      { tag: 'aa' },
      ' and ',
      { tag: 'b2-c' },
      '.',
    ]);
  });

  it('leaves a wrong name as written', () => {
    for (const bad of [
      '\u27e8q:a\u27e9', // 1 character
      `\u27e8q:${'a'.repeat(25)}\u27e9`, // 25 characters
      '\u27e8q:Upper\u27e9',
      '\u27e8q:snake_case\u27e9',
      '\u27e8q:\u27e9',
      '<q:abc>',
      '\u27e8x:abc\u27e9',
    ]) {
      expect(splitQuestionTags(bad)).toEqual([bad]);
    }
    expect(splitQuestionTags(`\u27e8q:${'a'.repeat(24)}\u27e9`)).toEqual([{ tag: 'a'.repeat(24) }]);
  });

  it('strips tags for previews, in plain text too', () => {
    expect(stripQuestionTags('Ship it? \u27e8q:ship-it\u27e9')).toBe('Ship it? ');
    expect(plainText('**Ship it?** \u27e8q:ship-it\u27e9')).toBe('Ship it?');
  });

  it('the search text is the tag as written', () => {
    expect(tagText('ship-it')).toBe('\u27e8q:ship-it\u27e9');
  });
});
