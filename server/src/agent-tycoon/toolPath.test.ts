import { describe, expect, it } from 'vitest';

import { toolPath } from './toolPath.js';

const CWD = '/home/o/shop';

describe('toolPath (DEVROOM-SIDEBAR)', () => {
  it('a file or folder input, relative ones against the working folder', () => {
    expect(toolPath({ file_path: '/home/o/shop/.worktrees/a/src/x.ts' }, CWD)).toBe('/home/o/shop/.worktrees/a/src/x.ts');
    expect(toolPath({ notebook_path: 'n.ipynb' }, CWD)).toBe('/home/o/shop/n.ipynb');
    expect(toolPath({ pattern: 'foo', path: '.worktrees/b' }, CWD)).toBe('/home/o/shop/.worktrees/b');
  });
  it('a command: its first cd or git -C, quoted or bare; else the working folder', () => {
    expect(toolPath({ command: 'cd /w/a && npm test' }, CWD)).toBe('/w/a');
    expect(toolPath({ command: 'cd ".worktrees/my dir"; ls' }, CWD)).toBe('/home/o/shop/.worktrees/my dir');
    expect(toolPath({ command: 'git -C /w/b status --short' }, CWD)).toBe('/w/b');
    expect(toolPath({ command: 'npm run build' }, CWD)).toBe(CWD);
    expect(toolPath({ pattern: '**/*.ts' }, CWD)).toBe(CWD);
  });
  it('nothing for a call that touches no path, or a path it cannot place', () => {
    expect(toolPath({ url: 'https://x', prompt: 'p' }, CWD)).toBeUndefined();
    expect(toolPath({ file_path: 'rel.ts' }, undefined)).toBeUndefined();
    expect(toolPath({ command: 'cd ~/x && ls' }, CWD)).toBeUndefined();
    expect(toolPath({ command: 'ls' }, undefined)).toBeUndefined();
    expect(toolPath(null, CWD)).toBeUndefined();
    expect(toolPath({ file_path: `/${'a'.repeat(2000)}` }, CWD)).toBeUndefined();
  });
});
