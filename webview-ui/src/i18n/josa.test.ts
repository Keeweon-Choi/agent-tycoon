import { describe, expect, it } from 'vitest';

import { translate } from './index.js';

// The owner's two examples (11-01), as escapes: no Hangul outside the i18n files.
const SASUKE = '우치하 사스케줄';
const ZORO = '롤로노아 제로데이';

describe('Korean particles in screen texts', () => {
  it('the permission wait: the agent is the subject', () => {
    expect(translate('permPrompt.noticeSub', { name: SASUKE }, 'ko')).toBe(
      `${SASUKE}이 허락을 기다려요`,
    );
  });
  it('the messenger card: no doubled particle', () => {
    expect(translate('permPrompt.asker', { name: ZORO }, 'ko')).toBe(
      `${ZORO}가 묻고 있어요`,
    );
    expect(translate('permPrompt.asker', { name: SASUKE }, 'ko')).toBe(
      `${SASUKE}이 묻고 있어요`,
    );
  });
  it('English is untouched', () => {
    expect(translate('permPrompt.asker', { name: 'Zero' }, 'en')).toBe('Zero is asking');
  });
});
