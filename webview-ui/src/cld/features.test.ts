import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(win: Record<string, unknown>) {
  vi.resetModules();
  Object.assign(globalThis, { window: globalThis, ...win });
  return import('./features.js');
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__AGENT_TYCOON_E2E;
  delete (globalThis as Record<string, unknown>).__AGENT_TYCOON_LATER_FEATURES;
  delete (globalThis as Record<string, unknown>).window;
});

describe('postponed features (interior, looks custom)', () => {
  it('are off for a real user', async () => {
    const f = await load({});
    expect(f.interiorOn).toBe(false);
    expect(f.looksCustomOn).toBe(false);
  });
  it('are on under the e2e harness, and off again with LATER_FEATURES=off', async () => {
    const on = await load({ __AGENT_TYCOON_E2E: true });
    expect([on.interiorOn, on.looksCustomOn]).toEqual([true, true]);
    const off = await load({ __AGENT_TYCOON_E2E: true, __AGENT_TYCOON_LATER_FEATURES: 'off' });
    expect([off.interiorOn, off.looksCustomOn]).toEqual([false, false]);
  });
});
