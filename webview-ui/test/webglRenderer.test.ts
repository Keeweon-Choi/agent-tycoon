import type { Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

const addon = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'ctor' | 'activate', disposed: 0 }));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      if (addon.mode === 'ctor') throw new Error('Webgl2 is only supported on Safari 16 and above');
    }
    onContextLoss() {
      return { dispose() {} };
    }
    dispose() {
      addon.disposed++;
    }
  },
}));

import { loadWebglRenderer } from '../src/terminal/webglRenderer.js';

function load(mode: 'ok' | 'ctor' | 'activate') {
  addon.mode = mode;
  addon.disposed = 0;
  const host = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  const term = {
    loadAddon: () => {
      if (mode === 'activate') throw new Error('WebGL2 not supported');
    },
  } as unknown as Terminal;
  loadWebglRenderer(term, host);
  return host.dataset['renderer'];
}

describe('loadWebglRenderer', () => {
  it('WebGL when the addon loads', () => {
    expect(load('ok')).toBe('webgl');
  });
  it('the DOM renderer stays when activation throws, and the addon is disposed', () => {
    expect(load('activate')).toBe('dom');
    expect(addon.disposed).toBe(1);
  });
  it('the DOM renderer stays when the constructor throws (Safari before 16): nothing escapes', () => {
    expect(() => load('ctor')).not.toThrow();
    expect(load('ctor')).toBe('dom');
  });
});
