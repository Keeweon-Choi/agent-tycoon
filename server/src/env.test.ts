import { afterEach, describe, expect, it } from 'vitest';

import { readEnv } from './env.js';

describe('readEnv', () => {
  afterEach(() => {
    delete process.env['AGENT_TYCOON_ENV_TEST'];
    delete process.env['PIXEL_AGENTS_ENV_TEST'];
  });

  it('prefers AGENT_TYCOON_ and falls back to the pre-rename PIXEL_AGENTS_', () => {
    expect(readEnv('ENV_TEST')).toBeUndefined();
    process.env['PIXEL_AGENTS_ENV_TEST'] = 'old';
    expect(readEnv('ENV_TEST')).toBe('old');
    process.env['AGENT_TYCOON_ENV_TEST'] = 'new';
    expect(readEnv('ENV_TEST')).toBe('new');
  });
});
