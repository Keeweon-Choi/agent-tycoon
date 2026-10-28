import { expect, test } from 'vitest';

import { bypassUnanswered, preferredBypassMode } from './bypass.js';

// Next to the source, not in test/: it imports app code the node test config cannot type-check (JSX).
test('an unanswered new-agent permission visibly preselects the recommended bypass choice without saving it', () => {
  const unanswered = { mode: '' as const, error: null };

  expect(preferredBypassMode(unanswered.mode)).toBe('bypass');
  expect(bypassUnanswered(unanswered)).toBe(true);
  expect(preferredBypassMode('ask')).toBe('ask');
});
