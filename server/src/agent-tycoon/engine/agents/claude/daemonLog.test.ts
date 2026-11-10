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
      minutes: 480,
    });
    expect(parseIdleRetire(log, ['29655fd9-background-agent'])).toEqual({
      id: '29655fd9',
      reason: 'settled',
      minutes: 480,
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

  it('reads the minutes Claude 2.1.310 writes (cex retired after 61 idle minutes, 10-26)', () => {
    const log = [
      '[2026-10-25T15:08:58.660Z] [bg] bg retire b3985e0f: idle-prompt, idle 61m',
      '[2026-10-25T15:08:58.786Z] [bg] bg settled b3985e0f (done)',
      '[2026-10-25T16:10:58.457Z] [bg] bg retire b3985e0f: settled, idle 61m',
    ].join('\n');
    expect(parseIdleRetire(log, ['b3985e0f-3c05-4302-9cc2-cb5bd8f175f7'])).toEqual({
      id: 'b3985e0f',
      reason: 'settled',
      minutes: 61,
    });
    expect(parseIdleRetire('[2026-10-25T16:10:58Z] bg retire b3985e0f: settled, idle 61', ['b3985e0f'])).toBeNull();
  });
});
