import { describe, expect, it, vi } from 'vitest';

import { afterCancel, canShareLink, inviteButtons, invitePhase, shareLink, suggestedNickname } from './inviteView.js';

const base = { hasCode: true, error: false, cancelled: false, registered: false, msLeft: 1000 };

describe('invitePhase', () => {
  it('follows the invitation', () => {
    expect(invitePhase({ ...base, hasCode: false })).toBe('loading');
    expect(invitePhase({ ...base, hasCode: false, error: true })).toBe('failed');
    expect(invitePhase(base)).toBe('active');
    expect(invitePhase({ ...base, msLeft: 0 })).toBe('expired');
    expect(invitePhase({ ...base, cancelled: true })).toBe('cancelled');
    expect(invitePhase({ ...base, registered: true, msLeft: 0 })).toBe('registered');
  });
});

describe('inviteButtons', () => {
  it('copy, cancel and the close note are for a live invite only', () => {
    for (const phase of ['loading', 'failed', 'expired', 'cancelled', 'registered'] as const)
      expect(inviteButtons(phase, true)).toEqual({ copyLink: false, share: false, cancel: false, closeNote: false });
    expect(inviteButtons('active', false)).toEqual({ copyLink: true, share: false, cancel: true, closeNote: true });
  });
  it('share needs a browser that can share', () => {
    expect(inviteButtons('active', true).share).toBe(true);
    expect(canShareLink({})).toBe(false);
    expect(canShareLink({ share: () => Promise.resolve() })).toBe(true);
  });
});

describe('shareLink', () => {
  it('hands the text and the link to the share sheet', async () => {
    const share = vi.fn(() => Promise.resolve());
    await shareLink({ share }, 'hello', 'https://x/login?code=1');
    expect(share).toHaveBeenCalledWith({ text: 'hello', url: 'https://x/login?code=1' });
  });
  it('a dismissed share sheet is not an error', async () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    await expect(shareLink({ share: () => Promise.reject(abort) }, 't', 'u')).resolves.toBeUndefined();
  });
});

describe('suggestedNickname', () => {
  it('drops the dot between OS and browser', () => {
    expect(suggestedNickname('Windows · Chrome')).toBe('Windows Chrome');
    expect(suggestedNickname('iPhone')).toBe('iPhone');
  });
});

describe('afterCancel', () => {
  it('a cancel that arrives after the code was used shows the registered device, not "cancelled"', () => {
    const device = { label: 'Windows · Chrome' };
    expect(afterCancel({ state: 'registered', device })).toEqual({ kind: 'registered', device });
    expect(afterCancel({ state: 'cancelled' })).toEqual({ kind: 'cancelled' });
    expect(afterCancel({})).toEqual({ kind: 'cancelled' });
  });
});
