import { describe, expect, it } from 'vitest';

import { parseIdleRetire } from './daemonLog.js';

describe('parseIdleRetire', () => {
  it('recognizes both idle-retire reasons for a background or session id', () => {
    const log = [
      '[2026-10-22T19:05:10Z] bg retire 377f7c98: idle-prompt, idle 8h',
      '[2026-10-23T03:05:10Z] bg retire 29655fd9: settled, idle 8h',
    ].join('\n');
    expect(parseIdleRetire(log, ['377f7c98-aabb-ccdd-eeff-001122334455'])).toEqual({
      id: '377f7c98',
      reason: 'idle-prompt',
      hours: 8,
    });
    expect(parseIdleRetire(log, ['29655fd9-background-agent'])).toEqual({
      id: '29655fd9',
      reason: 'settled',
      hours: 8,
    });
  });

  it('does not confuse non-idle retirement or another project with idle retirement', () => {
    const log = [
      '[2026-10-22T19:05:10Z] bg retire 377f7c98: stopped, requested',
      '[2026-10-23T03:05:10Z] bg retire 29655fd9: settled, idle 8h',
    ].join('\n');
    expect(parseIdleRetire(log, ['377f7c98-aabb-ccdd-eeff-001122334455'])).toBeNull();
    expect(parseIdleRetire(log, ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'])).toBeNull();
  });

  it('does not accept a truncated final line', () => {
    const log = '[2026-10-23T03:05:10Z] bg retire 29655fd9: settled, idle 8';
    expect(parseIdleRetire(log, ['29655fd9-background-agent'])).toBeNull();
  });
});
