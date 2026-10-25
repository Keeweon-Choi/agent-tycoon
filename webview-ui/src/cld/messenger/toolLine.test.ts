import { beforeEach, expect, it } from 'vitest';

import { setLanguage } from '../../i18n/index.js';
import { jobLineLabel, toolLineLabel } from './toolLine.js';

beforeEach(() => setLanguage('ko'));

it('uses an agent tool description for the collapsed label, otherwise the EZ phrase', () => {
  expect(
    toolLineLabel({
      toolName: 'Bash',
      text: 'Running: npm run build',
      desc: '\uac80\uc0ac \uacb0\uacfc \uc77d\uae30',
    }),
  ).toBe('🔨 \uac80\uc0ac \uacb0\uacfc \uc77d\uae30');
  expect(toolLineLabel({ toolName: 'Bash', text: 'Running: npm run build' })).toBe(
    '🔨 \ube4c\ub4dc\ud558\ub294 \uc911',
  );
});

it('a job reads as its own description; without one, its command explained; unknown, the generic words', () => {
  expect(jobLineLabel({ cmd: 'npm run build', label: '\ubc30\ud3ec: \ubc18\uc601' })).toBe(
    '🔨 \ubc30\ud3ec: \ubc18\uc601',
  );
  expect(jobLineLabel({ cmd: 'npm run build', label: null })).toBe('🔨 \ube4c\ub4dc\ud558\ub294 \uc911');
  expect(jobLineLabel({ cmd: 'git commit -m x', label: '  ' })).toBe('📦 \uc800\uc7a5(\ucee4\ubc0b)\ud558\ub294 \uc911');
  expect(jobLineLabel({ cmd: './weird-tool --go', label: null })).toBe(
    '💻 \uba85\ub839 \uc2e4\ud589 \uc911',
  );
});
