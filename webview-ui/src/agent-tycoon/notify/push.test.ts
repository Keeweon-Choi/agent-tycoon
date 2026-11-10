/** The "notifications are off on this device" banner's condition (pure). */
import { describe, expect, it } from 'vitest';

import type { PushState } from '../../../../core/src/messages.js';
import { DEFAULT_SETTINGS } from './notices.js';
import { PUSH_BANNER_DISMISS_MS, pushBannerKind, subscribeMessage } from './push.js';

const state = (over: Partial<PushState> = {}): PushState => ({
  type: 'pushState',
  available: true,
  publicKey: 'k',
  subscribed: false,
  ...over,
});
type Input = Parameters<typeof pushBannerKind>[0];
const base: Input = {
  push: state(),
  support: 'ok',
  permission: 'default',
  dismissedAt: null,
  optedOut: false,
  now: 10 * PUSH_BANNER_DISMISS_MS,
};
const kind = (over: Partial<Input> = {}) => pushBannerKind({ ...base, ...over });

describe('pushBannerKind', () => {
  it('asks when this device has no subscription and permission is open', () => {
    expect(kind()).toBe('ask');
  });
  it('resubscribes silently when permission is already granted on this origin', () => {
    expect(kind({ permission: 'granted' })).toBe('resubscribe');
  });
  it('says why on an iPhone browser tab (needs the installed Home Screen app)', () => {
    expect(kind({ support: 'ios-browser' })).toBe('ios-install');
  });
  it('stays away when subscribed, unknown, unavailable, opted out, or nothing could help', () => {
    expect(kind({ push: state({ subscribed: true }) })).toBe('none');
    expect(kind({ push: null })).toBe('none');
    expect(kind({ push: state({ available: false }) })).toBe('none');
    expect(kind({ optedOut: true })).toBe('none');
    expect(kind({ permission: 'denied' })).toBe('none');
    expect(kind({ support: 'insecure' })).toBe('none');
    expect(kind({ support: 'none' })).toBe('none');
  });
  it('a dismissal holds for a week, then asks again', () => {
    const now = base.now;
    expect(kind({ dismissedAt: now - 1000 })).toBe('none');
    expect(kind({ dismissedAt: now - PUSH_BANNER_DISMISS_MS - 1 })).toBe('ask');
  });
});

describe('pushSubscribe (U-49)', () => {
  const sub = {
    toJSON: () => ({ endpoint: 'https://push.example/x', keys: { p256dh: 'k', auth: 'a' } }),
  } as unknown as PushSubscription;
  const message = (kinds: Partial<typeof DEFAULT_SETTINGS.kinds>) =>
    subscribeMessage(sub, {
      ...DEFAULT_SETTINGS,
      kinds: { ...DEFAULT_SETTINGS.kinds, ...kinds },
    }) as { kinds: string[]; kindsOff: string[] };

  it('carries the message kind, and lists what is off so the daemon can tell "off" from "old"', () => {
    expect(message({})).toMatchObject({
      kinds: ['turnEnd', 'attention', 'job', 'reply'],
      kindsOff: [],
    });
    expect(message({ reply: false })).toMatchObject({
      kinds: ['turnEnd', 'attention', 'job'],
      kindsOff: ['reply'],
    });
    expect(message({ turnEnd: false, reply: false }).kindsOff).toEqual(['turnEnd', 'reply']);
  });
});
