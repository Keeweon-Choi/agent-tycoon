import type { ReactElement } from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  WEBVIEW_ERROR_MESSAGE_MAX,
  WEBVIEW_ERROR_STACK_LINES,
  WEBVIEW_ERROR_STACK_MAX,
} from '../../../core/src/constants.js';
import { setLanguage } from '../i18n/index.js';
import { errorReport, makeLimiter } from './errorReport.js';
import { type Region, RegionBoundary } from './RegionBoundary.js';

describe('errorReport (T-74)', () => {
  it('caps the message, the top of the stack and the component stack', () => {
    const error = new Error('word '.repeat(3 * WEBVIEW_ERROR_MESSAGE_MAX));
    error.stack = Array.from({ length: 100 }, (_, i) => `at f${i}`).join('\n'); // short: the line cap binds, not the character cap
    const r = errorReport('boundary', error, 'party', '\n  at SubCardHost\n  at AgentCardBar');
    expect(r.type).toBe('webviewError');
    expect(r.message.length).toBeLessThanOrEqual(WEBVIEW_ERROR_MESSAGE_MAX);
    expect(r.message.length).toBeGreaterThan(WEBVIEW_ERROR_MESSAGE_MAX - 10); // cut at a word, not far short
    expect(r.stack!.length).toBeLessThanOrEqual(WEBVIEW_ERROR_STACK_MAX);
    expect(r.stack!.split('\n').length).toBe(WEBVIEW_ERROR_STACK_LINES);
    expect(r.componentStack).toBe('  at SubCardHost\n  at AgentCardBar');
    expect(r.region).toBe('party');
  });

  it('drops a token the cap runs through instead of leaving a prefix of it (F2)', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    const r = errorReport(
      'error',
      new Error(`${'m'.repeat(WEBVIEW_ERROR_MESSAGE_MAX - 15)} ${token}`),
    );
    expect(r.message).not.toContain('ghp_');
    expect(r.message.length).toBeLessThanOrEqual(WEBVIEW_ERROR_MESSAGE_MAX);
    // a stack line too
    const e = new Error('x');
    e.stack = `${'s'.repeat(WEBVIEW_ERROR_STACK_MAX - 15)} ${token}`;
    expect(errorReport('error', e).stack).not.toContain('ghp_');
  });

  it('reports what is not an Error, and leaves out what is empty', () => {
    expect(errorReport('rejection', { code: 7 })).toEqual({
      type: 'webviewError',
      source: 'rejection',
      message: '{"code":7}',
    });
    expect(errorReport('error', 'boom', '', null)).toEqual({
      type: 'webviewError',
      source: 'error',
      message: 'boom',
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorReport('rejection', circular).message).toBe('[object Object]');
  });

  it('lets a burst through per window', () => {
    let now = 0;
    const allow = makeLimiter(3, 1000, () => now);
    expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);
    now = 999;
    expect(allow()).toBe(false);
    now = 1000;
    expect(allow()).toBe(true);
  });
});

/**
 * React's boundary protocol by hand (no DOM in these tests): the boundary renders its child; when that throws,
 * getDerivedStateFromError's state is taken and the boundary renders again. The runner
 * (agent-tycoon/test/run-webview-blank-screen.ts) checks the real thing in a browser.
 */
function page(region: Region, child: () => ReactElement): string {
  const boundary = new RegionBoundary({ region, children: h(child) });
  let inner: string;
  try {
    inner = renderToStaticMarkup(boundary.render() as ReactElement);
  } catch (error) {
    boundary.state = { ...boundary.state, ...RegionBoundary.getDerivedStateFromError(error) };
    inner = renderToStaticMarkup(boundary.render() as ReactElement);
  }
  return `<div id="root"><main>${inner}</main><nav>office</nav></div>`;
}

describe('RegionBoundary (T-74)', () => {
  it('a throwing child shows the region card, and the rest of the page stays', () => {
    setLanguage('en');
    const html = page('party', () => {
      throw new Error('Maximum update depth exceeded');
    });
    expect(html).toContain('data-testid="region-crash"');
    expect(html).toContain('data-region="party"');
    expect(html).toContain('The party stopped working');
    expect(html).toContain('Maximum update depth exceeded');
    expect(html).toContain('data-testid="region-reopen"');
    expect(html).toContain('data-testid="region-reload"');
    expect(html).toContain('<nav>office</nav>');
  });

  it('a healthy child renders as it is', () => {
    expect(page('messenger', () => h('p', null, 'hello'))).toBe(
      '<div id="root"><main><p>hello</p></main><nav>office</nav></div>',
    );
  });
});
