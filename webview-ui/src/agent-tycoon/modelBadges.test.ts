import { describe, expect, it } from 'vitest';

import { setLanguage } from '../i18n/index.js';
import { modelName, modelVersion, rankModelLabel } from './modelBadges.js';

describe('modelVersion', () => {
  it('reads family-version from a real model id', () => {
    expect(modelVersion('claude-opus-5-5')).toBe('Opus-5.5');
    expect(modelVersion('claude-fable-5-1')).toBe('Fable-5.1');
    expect(modelVersion('claude-sonnet-4-5-20250929')).toBe('Sonnet-4.5');
    expect(modelVersion('claude-3-5-haiku-20241022')).toBe('Haiku-3.5');
    expect(modelVersion('claude-opus-4-1[1m]')).toBe('Opus-4.1');
  });

  it('knows nothing of an alias or another shape', () => {
    for (const id of ['opus', 'sonnet', 'terra', 'gpt-5-1', 'claude', 'claude-5-5', '', null, undefined])
      expect(modelVersion(id)).toBeNull();
  });
});

describe('rankModelLabel', () => {
  it('writes "<rank> · <model>": the level sets the rank, the model only its name', () => {
    setLanguage('en');
    expect(rankModelLabel(1, 'opus', 'claude-opus-5-5')).toBe('Intern · Opus-5.5');
    expect(rankModelLabel(15, 'opus', 'opus')).toBe('Associate · Opus');
    expect(rankModelLabel(15, 'haiku')).toBe('Associate · Haiku');
    expect(rankModelLabel(15, 'haiku')).toBe(rankModelLabel(15, 'sol').replace('Codex Sol', 'Haiku'));
  });

  it('leaves out what is not known and never guesses', () => {
    setLanguage('en');
    expect(rankModelLabel(undefined, 'opus')).toBe('Opus');
    expect(rankModelLabel(42, null)).toBe('Manager');
    expect(rankModelLabel(undefined, null)).toBe('Teammate');
    expect(modelName(null)).toBeNull();
  });
});
