import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claudeInstallCommand,
  claudeInstallDirs,
  type ClaudeVersionResult,
  findClaude,
  readWindowsMachinePath,
  readWindowsUserPath,
  windowsLogonEnv,
  windowsLogonPath,
} from './agentCli.js';

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
/** A file named claude that answers --version like Claude Code (or, with `body`, however a test says). */
const fakeClaude = (dir: string, body = 'echo "2.1.310 (Claude Code)"'): string => {
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
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
    expect(findClaude({ platform: 'linux', home: h, env: { PATH: path.join(h, 'bin') } })).toBe(
      onPath,
    );
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
    expect(
      findClaude({ platform: 'linux', home: h, env: { PATH: path.join(h, 'bin') } }),
    ).toBeNull();
  });

  it('skips a file named claude that is not Claude Code and takes the next one, logging why', () => {
    const h = home();
    fakeClaude(mkdir(h, 'bin'), 'echo "hello"'); // exits 0 but is not Claude Code
    const good = fakeClaude(mkdir(h, '.local', 'bin'));
    const logs: string[] = [];
    const env = { PATH: path.join(h, 'bin') };
    expect(findClaude({ platform: 'linux', home: h, env, log: (l) => logs.push(l) })).toBe(good);
    expect(logs).toEqual([
      `[cld] agent CLI: ${path.join(h, 'bin', 'claude')} is not a working Claude Code (version output did not identify Claude Code), skipped`,
    ]);
  });

  it('a candidate that exits non-zero is skipped, even when it printed the version line', () => {
    const h = home();
    fakeClaude(mkdir(h, 'bin'), 'echo "2.1.310 (Claude Code)"; exit 3');
    const logs: string[] = [];
    expect(
      findClaude({
        platform: 'linux',
        home: h,
        env: { PATH: path.join(h, 'bin') },
        log: (l) => logs.push(l),
      }),
    ).toBeNull();
    expect(logs[0]).toContain('exited 3');
  });
});

describe('findClaude (version probe through an injected runner)', () => {
  const dirs = ['/a', '/b', '/c'];
  const candidates = () => dirs.map((d) => `${d}/claude`);
  const ok = { exitCode: 0, stdout: '2.1.310 (Claude Code)\n' };
  const run = (answers: Record<string, ClaudeVersionResult>) => {
    const probed: { command: string; args: string[]; timeout: number }[] = [];
    const logs: string[] = [];
    const out = findClaude({
      platform: 'linux',
      home: '/h',
      env: { PATH: '/a:/b:/c' },
      candidates,
      runVersion: (candidate, invocation) => {
        probed.push(invocation);
        return answers[candidate] ?? { exitCode: 1, stdout: '' };
      },
      log: (l) => logs.push(l),
    });
    return { out, probed, logs };
  };

  it('a working candidate is accepted and runs with --version within 10 s', () => {
    const { out, probed } = run({ '/a/claude': ok });
    expect(out).toBe('/a/claude');
    expect(probed).toEqual([
      { command: '/a/claude', args: ['--version'], timeout: 10_000, env: { PATH: '/a:/b:/c' } },
    ]);
  });

  it('a non-zero exit, a timeout and other output are each skipped, the next candidate is taken', () => {
    const { out, logs } = run({
      '/a/claude': { exitCode: 1, stdout: '' },
      '/b/claude': { exitCode: null, stdout: '', timedOut: true },
      '/c/claude': ok,
    });
    expect(out).toBe('/c/claude');
    expect(logs).toEqual([
      '[cld] agent CLI: /a/claude is not a working Claude Code (exited 1), skipped',
      '[cld] agent CLI: /b/claude is not a working Claude Code (timed out after 10000 ms), skipped',
    ]);
  });

  it('every candidate bad: null', () => {
    const { out, logs } = run({ '/a/claude': { exitCode: 0, stdout: 'something else\n' } });
    expect(out).toBeNull();
    expect(logs).toHaveLength(3);
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
      candidates: (searchDirs, platform) => {
        seen.push(searchDirs);
        expect(platform).toBe('win32');
        return [];
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

  const okVersion = { exitCode: 0, stdout: '2.1.310 (Claude Code)\r\n' };

  it('returns what is found in the user PATH', () => {
    const out = findClaude({
      platform: 'win32',
      home: 'C:\\Users\\kim',
      env,
      userPath: () => 'C:\\Users\\kim\\.local\\bin',
      candidates: (dirs) =>
        dirs.filter((d) => d === 'C:\\Users\\kim\\.local\\bin').map((d) => `${d}\\claude.exe`),
      runVersion: () => okVersion,
    });
    expect(out).toBe('C:\\Users\\kim\\.local\\bin\\claude.exe');
  });

  it('a .cmd candidate runs through ComSpec with the path quoted; an .exe runs directly', () => {
    const calls: { command: string; args: string[]; verbatim?: boolean }[] = [];
    const logs: string[] = [];
    const cmd = 'C:\\Users\\kim\\AppData\\Roaming\\npm\\claude.cmd';
    const exe = 'C:\\Users\\kim\\.local\\bin\\claude.exe';
    const out = findClaude({
      platform: 'win32',
      home: 'C:\\Users\\kim',
      env: { ...env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      userPath: () => '',
      candidates: () => [cmd, exe],
      runVersion: (candidate, inv) => {
        calls.push({ command: inv.command, args: inv.args, ...(inv.verbatim && { verbatim: true }) });
        return candidate === exe ? okVersion : { exitCode: 1, stdout: '' };
      },
      log: (l) => logs.push(l),
    });
    expect(out).toBe(exe);
    expect(calls).toEqual([
      {
        command: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', `""${cmd}" --version"`],
        verbatim: true,
      },
      { command: exe, args: ['--version'] },
    ]);
    expect(logs).toEqual([
      `[cld] agent CLI: ${cmd} is not a working Claude Code (exited 1), skipped`,
    ]);
  });

  it('a WindowsApps store alias is never run', () => {
    const alias = 'C:\\Users\\kim\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe';
    const ran: string[] = [];
    const logs: string[] = [];
    const out = findClaude({
      platform: 'win32',
      home: 'C:\\Users\\kim',
      env,
      userPath: () => '',
      candidates: () => [alias],
      runVersion: (candidate) => (ran.push(candidate), okVersion),
      log: (l) => logs.push(l),
    });
    expect(out).toBeNull();
    expect(ran).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('skipped');
  });

  it('lists the npm folder under %APPDATA% and no posix folders', () => {
    const dirs = claudeInstallDirs('win32', 'C:\\Users\\kim', env);
    expect(dirs).toContain('C:\\Users\\kim\\AppData\\Roaming\\npm');
    expect(dirs.some((d) => d.startsWith('/'))).toBe(false);
  });
});

describe('Windows logon environment', () => {
  const env = {
    Path: 'C:\\Daemon\\bin',
    CLD_GUI_SECRET: 'daemon-only',
  };
  const query = (): string =>
    JSON.stringify({
      Machine: {
        Path: 'C:\\Windows\\System32',
        JAVA_HOME: 'C:\\Java\\machine',
        GOPATH: 'C:\\go\\machine',
        SHARED: 'machine',
      },
      User: {
        Path: 'C:\\Users\\최\\bin',
        JAVA_HOME: 'C:\\Java\\user',
        gopath: 'C:\\go\\user',
        KOREAN_HOME: 'C:\\Users\\최\\tools',
        SHARED: 'user',
      },
    });

  it('joins PATH, lets user values win case-insensitively, and preserves Unicode', () => {
    expect(readWindowsMachinePath(env, query)).toBe('C:\\Windows\\System32');
    expect(readWindowsUserPath(env, query)).toBe('C:\\Users\\최\\bin');
    expect(windowsLogonEnv(env, query)).toEqual({
      Path: 'C:\\Windows\\System32;C:\\Users\\최\\bin',
      JAVA_HOME: 'C:\\Java\\user',
      gopath: 'C:\\go\\user',
      SHARED: 'user',
      KOREAN_HOME: 'C:\\Users\\최\\tools',
    });
    expect(windowsLogonPath(env, query)).toBe('C:\\Windows\\System32;C:\\Users\\최\\bin');
  });

  it('uses one reader invocation for two quick calls', () => {
    let calls = 0;
    const cached = (): string => {
      calls++;
      return query();
    };
    expect(windowsLogonEnv(env, cached)?.JAVA_HOME).toBe('C:\\Java\\user');
    expect(windowsLogonEnv(env, cached)?.KOREAN_HOME).toBe('C:\\Users\\최\\tools');
    expect(calls).toBe(1);
  });

  it('returns null and keeps the daemon PATH when the reader fails', () => {
    const failed = (): string => {
      throw new Error('PowerShell unavailable');
    };
    expect(windowsLogonEnv(env, failed)).toBeNull();
    expect(windowsLogonPath(env, failed)).toBe('C:\\Daemon\\bin');
  });
});

describe('claudeInstallCommand', () => {
  it('is the PowerShell one-liner on Windows and installs, persists PATH, then signs in elsewhere', () => {
    expect(claudeInstallCommand('win32')).toBe('irm https://claude.ai/install.ps1 | iex');
    for (const p of ['linux', 'darwin'] as const)
      expect(claudeInstallCommand(p)).toBe(
        'curl -fsSL https://claude.ai/install.sh | bash && { case "$SHELL:$(uname)" in */zsh:*) p="$HOME/.zprofile";; */bash:Darwin) p="$HOME/.bash_profile";; *) p="$HOME/.profile";; esac; grep -q \'\\.local/bin\' "$p" 2>/dev/null || printf \'%s\\n\' \'export PATH="$HOME/.local/bin:$PATH" # Added by Agent Tycoon (Claude Code)\' >> "$p"; export PATH="$HOME/.local/bin:$PATH"; claude auth status >/dev/null 2>&1 || claude auth login; }',
      );
  });
});
