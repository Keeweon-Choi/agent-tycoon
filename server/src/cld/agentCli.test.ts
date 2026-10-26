import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { claudeInstallCommand, claudeInstallDirs, findClaude } from './agentCli.js';

const tmp: string[] = [];
const mkdir = (...parts: string[]): string => {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const home = (): string => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-'));
  tmp.push(h);
  return h;
};
const fakeClaude = (dir: string): string => {
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
};
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('findClaude (linux/macOS, real fake dirs)', () => {
  it('finds the daemon PATH first', () => {
    const h = home();
    const onPath = fakeClaude(mkdir(h, 'bin'));
    fakeClaude(mkdir(h, '.local', 'bin'));
    expect(findClaude({ platform: 'linux', home: h, env: { PATH: path.join(h, 'bin') } })).toBe(onPath);
  });

  it.each([
    ['~/.local/bin', ['.local', 'bin'], {}],
    ['~/.claude/local', ['.claude', 'local'], {}],
    ['~/.npm-global/bin', ['.npm-global', 'bin'], {}],
    ['the npm prefix', ['npm-prefix', 'bin'], { npm_config_prefix: 'npm-prefix' }],
  ])('finds a claude the PATH lacks in %s', (_name, parts, extra) => {
    const h = home();
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent' };
    if ('npm_config_prefix' in extra) env.npm_config_prefix = path.join(h, 'npm-prefix');
    const file = fakeClaude(mkdir(h, ...parts));
    expect(findClaude({ platform: 'linux', home: h, env })).toBe(file);
  });

  it('null when nowhere holds one (negative control)', () => {
    const h = home();
    expect(findClaude({ platform: 'linux', home: h, env: { PATH: path.join(h, 'bin') } })).toBeNull();
  });
});

describe('findClaude (Windows, search order with fakes)', () => {
  const env = { PATH: 'C:\\Windows;C:\\Tools', APPDATA: 'C:\\Users\\kim\\AppData\\Roaming' };

  it('PATH, then the registry user PATH (read once), then the install folders', () => {
    let reads = 0;
    const seen: string[][] = [];
    const out = findClaude({
      platform: 'win32',
      home: 'C:\\Users\\kim',
      env,
      userPath: () => (reads++, 'C:\\Users\\kim\\.local\\bin;C:\\Other'),
      find: (_cmd, searchPath, platform) => {
        seen.push((searchPath ?? '').split(';'));
        expect(platform).toBe('win32');
        return null;
      },
    });
    expect(out).toBeNull();
    expect(reads).toBe(1);
    expect(seen[0]).toEqual([
      'C:\\Windows',
      'C:\\Tools',
      'C:\\Users\\kim\\.local\\bin',
      'C:\\Other',
      'C:\\Users\\kim\\.local\\bin',
      'C:\\Users\\kim\\.claude\\local',
      'C:\\Users\\kim\\AppData\\Roaming\\npm',
    ]);
  });

  it('returns what findOnPath finds in the user PATH', () => {
    const out = findClaude({
      platform: 'win32',
      home: 'C:\\Users\\kim',
      env,
      userPath: () => 'C:\\Users\\kim\\.local\\bin',
      find: (_c, searchPath) =>
        (searchPath ?? '').split(';').includes('C:\\Users\\kim\\.local\\bin')
          ? 'C:\\Users\\kim\\.local\\bin\\claude.exe'
          : null,
    });
    expect(out).toBe('C:\\Users\\kim\\.local\\bin\\claude.exe');
  });

  it('lists the npm folder under %APPDATA% and no posix folders', () => {
    const dirs = claudeInstallDirs('win32', 'C:\\Users\\kim', env);
    expect(dirs).toContain('C:\\Users\\kim\\AppData\\Roaming\\npm');
    expect(dirs.some((d) => d.startsWith('/'))).toBe(false);
  });
});

describe('claudeInstallCommand', () => {
  it('is the PowerShell one-liner on Windows and curl elsewhere', () => {
    expect(claudeInstallCommand('win32')).toBe('irm https://claude.ai/install.ps1 | iex');
    for (const p of ['linux', 'darwin'] as const)
      expect(claudeInstallCommand(p)).toBe('curl -fsSL https://claude.ai/install.sh | bash');
  });
});
