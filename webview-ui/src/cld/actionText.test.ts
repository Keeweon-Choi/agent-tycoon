import { beforeEach, describe, expect, it } from 'vitest';

import { setLanguage } from '../i18n/index.js';
import { ACTION_LABEL, confirmText, objectParticle, subjectWithParticle } from './actionText.js';

beforeEach(() => setLanguage('ko'));

describe('texts', () => {
  it('labels: \uc7ac\uc2dc\uc791 for a restart', () => {
    expect(ACTION_LABEL).toEqual({ start: '\ucf1c\uae30', quit: '\ub044\uae30', restart: '\uc7ac\uc2dc\uc791' });
  });
  it('confirmation questions with the right particle', () => {
    expect(confirmText('restart', 'wayfinder')).toEqual({
      question: 'wayfinder\ub97c \uc7ac\uc2dc\uc791\ud560\uae4c\uc694?',
      note: '\ud558\ub358 \uc77c\uc774 \uc7a0\uae50 \ub04a\uae38 \uc218 \uc788\uc5b4\uc694.',
    });
    expect(confirmText('start', 'pofol').question).toBe('pofol\uc744 \ucf24\uae4c\uc694?');
    expect(confirmText('quit', 'aixon').question).toBe('aixon\uc744 \ub04c\uae4c\uc694?');
    expect([objectParticle('\uc0ac\ubb34\uc2e4'), objectParticle('\uad00\ub9ac'), objectParticle('wt7')]).toEqual([
      '\uc744',
      '\ub97c',
      '\uc744',
    ]);
  });
  it('subject particle: Hangul batchim, a fallback, and Latin readings', () => {
    expect(subjectWithParticle('\uce90\ub9ad\ud130')).toBe('\uce90\ub9ad\ud130\uac00');
    expect(subjectWithParticle('\ubd04')).toBe('\ubd04\uc774');
    expect(subjectWithParticle('')).toBe('\uce90\ub9ad\ud130\uac00');
    expect(subjectWithParticle('model')).toBe('model\uc774');
    expect(subjectWithParticle('alpha')).toBe('alpha\uac00');
    expect(subjectWithParticle('7')).toBe('7\uc774');
    expect(subjectWithParticle('2')).toBe('2\uac00');
    expect(subjectWithParticle('r')).toBe('r\uc774'); // 알
    expect(subjectWithParticle('worker')).toBe('worker\uc774');
  });
});
