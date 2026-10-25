import { describe, expect, it } from 'vitest';

import { linkAction } from './externalLinks.js';

const PAGE = 'https://office.example.com:18240/?token=abc';

describe('linkAction', () => {
  it('this origin stays (paths, hashes, blob downloads)', () => {
    for (const href of [
      '/x',
      './y?z=1',
      '#top',
      'https://office.example.com:18240/a',
      'blob:https://office.example.com:18240/id',
    ])
      expect(linkAction(href, PAGE)).toBe('same');
  });
  it('another http or https origin goes to a new window', () => {
    for (const href of [
      'https://example.org/',
      'http://office.example.com:18240/',
      'https://office.example.com/',
      '//evil.test/x',
    ])
      expect(linkAction(href, PAGE)).toBe('open');
  });
  it('every other scheme is refused', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'vscode://x',
      'mailto:a@b.c',
      'blob:https://example.org/id',
      'http://[',
    ])
      expect(linkAction(href, PAGE)).toBe('refuse');
  });
});
