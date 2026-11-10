import { describe, expect, it } from 'vitest';

import { t } from '../../i18n/index.js';
import { presetLabel } from './looks.js';

describe('presetLabel: a preset name in the looks window', () => {
  it('names a built-in id in the UI language, any other preset (even `constructor`) by its label', () => {
    expect(presetLabel({ id: 'builtin-bunny', label: 'x' })).toBe(t('looks.builtinBunny'));
    for (const id of ['constructor', 'hasownproperty', 'robot'])
      expect(presetLabel({ id, label: 'Mine' })).toBe('Mine');
  });
});
