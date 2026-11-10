/** P4 S6: what the 미리보기 box accepts, where it runs, and that a notice url cannot smuggle another address. */
import { describe, expect, it } from 'vitest';

import { noticeUrl, parseNoticeUrl } from '../../../../core/src/agent-tycoon/notices.js';
import { onThisPc, previewAddress } from './previewHost.js';

const OWN = '18240';

describe('previewAddress', () => {
  it('takes a typed address or a pasted dev server line', () => {
    expect(previewAddress('localhost:5173', OWN)).toEqual({ url: 'http://localhost:5173/' });
    expect(previewAddress('  Local:   http://127.0.0.1:3000/\n  Network: http://192.168.0.7:3000/', OWN)).toEqual({ url: 'http://127.0.0.1:3000/' });
  });

  it('refuses anything off this machine and the office itself', () => {
    for (const bad of ['http://example.com', '192.168.0.7:5173', 'javascript:alert(1)', 'http://localhost.evil.com:5173'])
      expect(previewAddress(bad, OWN)).toHaveProperty('error');
    expect(previewAddress('localhost:18240', OWN)).toHaveProperty('error');
    expect(previewAddress('127.0.0.1:18240', OWN)).toHaveProperty('error');
  });
});

describe('where it runs', () => {
  it('only a page served from loopback is the PC', () => {
    expect(onThisPc('localhost')).toBe(true);
    expect(onThisPc('127.0.0.1')).toBe(true);
    expect(onThisPc('[::1]')).toBe(true);
    expect(onThisPc('office.example.com')).toBe(false);
    expect(onThisPc('192.168.0.5')).toBe(false);
  });
});

describe('the preview notice target', () => {
  it('survives a push url, and a url that is not loopback is refused', () => {
    const target = { open: 'preview', project: 'shop-web', task: 'cart-total', url: 'http://localhost:5173/' } as const;
    expect(parseNoticeUrl(noticeUrl(target))).toEqual(target);
    expect(parseNoticeUrl('/?open=preview&project=shop-web&task=cart-total')).toEqual({ open: 'preview', project: 'shop-web', task: 'cart-total' });
    expect(parseNoticeUrl('/?open=preview&project=shop-web&task=cart-total&url=http%3A%2F%2Fevil.example%2F')).toBeNull();
    expect(parseNoticeUrl('/?open=preview&project=shop-web')).toBeNull();
  });
});
