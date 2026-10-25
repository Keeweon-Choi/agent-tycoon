import { describe, expect, it } from 'vitest';

import { submitTerminalLine } from '../../components/mobileSend.js';

describe('the key bar send key', () => {
  it('is Enter, or chat:sendNow during a Claude turn, which Enter would only queue (10-22 20:25)', () => {
    const calls: string[] = [];
    const input = (busy?: boolean) => ({
      send: (key: string) => calls.push(key),
      busy: busy === undefined ? undefined : () => busy,
    });
    submitTerminalLine(input(true));
    submitTerminalLine(input(false));
    submitTerminalLine(input());
    expect(calls).toEqual(['\x18\x13', '\r', '\r']);
  });
});
