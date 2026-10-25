import { describe, expect, it } from 'vitest';

import { lobbyAtLaunch, snapExact } from './titleSceneState.js';

describe('lobby at launch', () => {
  const fresh = { atStart: true, seen: false, deepLink: false, reloaded: false };
  it('shows on a fresh launch (a new session: browser or installed app)', () => {
    expect(lobbyAtLaunch(fresh)).toBe(true);
  });
  it('not over a notice or deep link, not on a reload, not when seen or turned off', () => {
    expect(lobbyAtLaunch({ ...fresh, deepLink: true })).toBe(false);
    expect(lobbyAtLaunch({ ...fresh, reloaded: true })).toBe(false);
    expect(lobbyAtLaunch({ ...fresh, seen: true })).toBe(false);
    expect(lobbyAtLaunch({ ...fresh, atStart: false })).toBe(false);
  });
});

describe('snapExact', () => {
  it('lands on a device px that is also a whole layout unit (1/64 CSS px)', () => {
    for (const [dpr, step] of [
      [1, 1],
      [1.25, 4],
      [1.5, 2],
      [2, 0.5],
      [2.625, 8],
      [3, 1],
    ] as const)
      for (const v of [0, 13.3, 76.8, 101.7, 333.33]) {
        const x = snapExact(v, dpr);
        expect(Math.abs(x / step - Math.round(x / step))).toBeLessThan(1e-9);
        expect(Math.abs(x - v)).toBeLessThanOrEqual(step / 2 + 1e-9);
      }
  });
});
