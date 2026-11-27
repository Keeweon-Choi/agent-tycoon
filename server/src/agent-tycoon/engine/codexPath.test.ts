/**
 * A1.2: on Windows codex is looked up by its bare name, so PATHEXT finds a codex.exe (bun, scoop,
 * the standalone build) as well as npm's codex.cmd. A fake disk of Windows paths (this runs on Linux).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findCodex } from './codex.js';

const disk = new Set<string>();
vi.mock('fs', async (orig) => {
  const fs = await orig<typeof import('fs')>();
  return {
    ...fs,
    accessSync: (f: string) => {
      if (!disk.has(f)) throw new Error('ENOENT');
    },
    statSync: () => ({ isFile: () => true }),
  };
});

const PATH = 'C:\\Users\\kim\\.bun\\bin;C:\\Users\\kim\\AppData\\Roaming\\npm';

describe('findCodex on Windows (A1.2)', () => {
  beforeEach(() => disk.clear());

  it('finds a codex.exe on PATH, not only codex.cmd', () => {
    disk.add('C:\\Users\\kim\\.bun\\bin\\codex.exe');
    expect(findCodex(PATH, 'win32')).toBe('C:\\Users\\kim\\.bun\\bin\\codex.exe');
  });

  it("still finds npm's codex.cmd", () => {
    disk.add('C:\\Users\\kim\\AppData\\Roaming\\npm\\codex.cmd');
    expect(findCodex(PATH, 'win32')).toBe('C:\\Users\\kim\\AppData\\Roaming\\npm\\codex.cmd');
  });

  it('none: null', () => {
    expect(findCodex(PATH, 'win32')).toBeNull();
  });
});
