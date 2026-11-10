import { describe, expect, it } from 'vitest';

import {
  WEBVIEW_ERROR_MESSAGE_MAX,
  WEBVIEW_ERROR_STACK_LINES,
} from '../../../core/src/constants.js';
import { WEBVIEW_ERROR_BURST, WEBVIEW_ERROR_WINDOW_MS } from '../constants.js';
import { webviewErrorLine, WebviewErrorLog } from './webviewErrors.js';

describe('webviewErrorLine', () => {
  it('logs a boundary catch with its region, stack and component stack', () => {
    const line = webviewErrorLine({
      type: 'webviewError',
      source: 'boundary',
      region: 'party',
      message: 'Maximum update depth exceeded',
      stack: 'Error: x\n at a (app.js:1:2)',
      componentStack: '\n at SubCardHost\n at AgentCardBar',
    });
    expect(line).toBe(
      '[Webview] boundary in party: Maximum update depth exceeded\n  stack:\n    Error: x\n    at a (app.js:1:2)\n  components:\n    at SubCardHost\n    at AgentCardBar',
    );
  });

  it('drops a malformed report', () => {
    for (const bad of [
      {},
      { source: 'boundary' },
      { source: 'nope', message: 'x' },
      { source: 'error', message: 7 },
      { source: 'error', message: '  ' },
    ])
      expect(webviewErrorLine(bad)).toBeNull();
    expect(webviewErrorLine({ source: 'error', message: 'x', stack: 5, region: {} })).toBe(
      '[Webview] error: x',
    );
  });

  it('caps, flattens and masks what the page sent', () => {
    const line = webviewErrorLine({
      source: 'rejection',
      message: `token=abcdef123456\n[Agent Tycoon] forged ${'m'.repeat(2 * WEBVIEW_ERROR_MESSAGE_MAX)}`,
      region: 'x\n[Agent Tycoon]',
      stack: Array.from({ length: 50 }, (_, i) => `at f${i}`).join('\n'),
    })!;
    expect(line).not.toContain('abcdef123456');
    expect(line.split('\n')[0].length).toBeLessThan(WEBVIEW_ERROR_MESSAGE_MAX + 40);
    expect(line.split('\n').filter((l) => l.startsWith('[')).length).toBe(1);
    expect(line.split('\n').filter((l) => l.startsWith('    at f')).length).toBe(
      WEBVIEW_ERROR_STACK_LINES,
    );
  });
});

describe('webviewErrorLine, hostile text (T-74 review F1, F2)', () => {
  it('lets no control character through from any field', () => {
    const line = webviewErrorLine({
      source: 'error',
      message: 'x\r[Agent Tycoon] forged\u001b[2J\u0085\u2028y',
      region: 'a\u001b[31mb',
      stack: 'at a\r[Agent Tycoon] forged\n\u001b[2J\u001b[31mred\u009b',
      componentStack: 'at B\r\u0007',
    })!;
    expect(line).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(line.split('\n').filter((l) => l.startsWith('[')).length).toBe(1);
    expect(line).toContain('at a [Agent Tycoon] forged'); // indented under the stack, not at a line start
  });

  it('masks a token that runs across the length cap', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    const line = webviewErrorLine({
      source: 'error',
      message: `${'m'.repeat(WEBVIEW_ERROR_MESSAGE_MAX - 15)} ${token}`,
    })!;
    expect(line).not.toContain('ghp_');
    expect(line).not.toContain('AAAA');
  });
});

describe('WebviewErrorLog', () => {
  it('rate-limits per socket and tells how many were dropped', () => {
    const lines: string[] = [];
    let now = 0;
    const log = new WebviewErrorLog(
      (l) => lines.push(l),
      () => now,
    );
    const a = {};
    const b = {};
    const msg = { source: 'error', message: 'boom' };
    for (let i = 0; i < WEBVIEW_ERROR_BURST + 5; i++) log.report(a, msg);
    expect(log.report(b, msg)).toBe(true); // another page has its own window
    expect(lines.length).toBe(WEBVIEW_ERROR_BURST + 1);
    now += WEBVIEW_ERROR_WINDOW_MS;
    expect(log.report(a, msg)).toBe(true);
    expect(lines.at(-2)).toBe('[Webview] 5 more report(s) from one page were dropped');
  });

  it('never throws on a hostile report', () => {
    const log = new WebviewErrorLog(() => undefined);
    const hostile = {
      get source(): string {
        throw new Error('x');
      },
    };
    expect(log.report({}, hostile)).toBe(false);
  });
});
