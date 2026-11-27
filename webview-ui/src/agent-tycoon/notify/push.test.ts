/** The "notifications are off on this device" banner's condition (pure). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PushState } from '../../../../core/src/messages.js';
import { getLanguage, setLanguage } from '../../i18n/index.js';
import { agtyPushState, DEFAULT_SETTINGS, noticesResetForTests } from './notices.js';
import {
  listenForPushClicks,
  PUSH_BANNER_DISMISS_MS,
  pushBannerKind,
  resendPushOnLanguage,
  subscribeMessage,
} from './push.js';

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

describe('U2.2: the language of this device\'s pushes follows the settings', () => {
  const sub = {
    toJSON: () => ({ endpoint: 'https://push.example/x', keys: { p256dh: 'k', auth: 'a' } }),
  } as unknown as PushSubscription;
  const before = getLanguage();
  afterEach(() => {
    setLanguage(before);
    noticesResetForTests();
    vi.unstubAllGlobals();
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const withServiceWorker = () =>
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }) },
    });

  it('a language change while subscribed re-sends the subscription in the new language, with no settings screen open', async () => {
    withServiceWorker();
    setLanguage('ko');
    agtyPushState(state({ subscribed: true }));
    const send = vi.fn();
    const off = resendPushOnLanguage(send);
    setLanguage('en');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: 'pushSubscribe', lang: 'en' });
    off();
    setLanguage('ko');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('says nothing when this device has no push subscription', async () => {
    withServiceWorker();
    agtyPushState(state({ subscribed: false }));
    const send = vi.fn();
    const off = resendPushOnLanguage(send);
    setLanguage(getLanguage() === 'ko' ? 'en' : 'ko');
    await flush();
    expect(send).not.toHaveBeenCalled();
    off();
  });
});

describe('listenForPushClicks', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('cleans every key the target came in on (project, task, url too), keeping the rest', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: {
        pathname: '/',
        search: '?open=preview&project=p&task=t&url=http%3A%2F%2F127.0.0.1%3A3000%2F&keep=1',
      },
      history: { replaceState },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal('navigator', {});
    const open = vi.fn(() => true);
    listenForPushClicks(open)();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ open: 'preview', project: 'p', task: 't' }));
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?keep=1');
  });
});
