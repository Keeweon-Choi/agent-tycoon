import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { startArgs } from './agents/claude/claude.js';
import { Engine } from './engine.js';
import { EngineEvents, eventsPath } from './events.js';
import { Jobs } from './jobs.js';
import type { Run } from './sessionPath.js';
import { appendMissing, buildSessionPath, windowsToWsl } from './sessionPath.js';

const WIN =
  'C:\\Windows\\System32;C:\\Program Files\\nodejs\;%SystemRoot%\\x;C:\\gone;\\\\srv\\share;C:\\Windows\\';
const DIRS = new Set([
  '/mnt/c/Windows/System32',
  '/mnt/c/Program Files/nodejs',
  '/mnt/c/Windows',
  '/usr/lib/wsl/lib',
]);

/** Fake runners: bash -lc and cmd.exe answers; never a real process. */
function fakes(o: { login?: string | null; win?: string | null; wsl?: boolean }) {
  const calls: string[] = [];
  const run: Run = (file, args, opts) => {
    calls.push(file);
    if (file === 'bash')
      return o.login === undefined ? '/home/u/.local/bin:/usr/bin:/usr/sbin' : o.login;
    expect(args).toEqual(['/d', '/c', 'echo %PATH%']);
    expect(opts.cwd).toBe('/mnt/c/Windows');
    return o.win === undefined ? `${WIN}\r\n` : o.win;
  };
  return {
    calls,
    opts: {
      binDir: '/r/cld/bin',
      env: { HOME: '/home/u', PATH: '/usr/bin' },
      platform: 'linux' as const,
      run,
      isDir: (p: string) => DIRS.has(p),
      exists: (p: string) => (o.wsl ?? true) && p.startsWith('/proc/sys/fs/binfmt_misc'),
    },
  };
}

describe('sessionPath', () => {
  it('converts Windows PATH entries and drops what cannot be a directory here', () => {
    expect(windowsToWsl('C:\\Windows\\System32')).toBe('/mnt/c/Windows/System32');
    expect(windowsToWsl('D:\\a\\b\\')).toBe('/mnt/d/a/b');
    expect(windowsToWsl('C:\\')).toBe('/mnt/c');
    expect(windowsToWsl('%SystemRoot%\\x')).toBeNull();
    expect(windowsToWsl('\\\\srv\\share')).toBeNull();
    expect(windowsToWsl('rel\\dir')).toBeNull();
  });

  it('bin dir, login PATH, existing Windows dirs, wsl lib: in order, no repeats', () => {
    const f = fakes({});
    expect(buildSessionPath(f.opts)).toBe(
      [
        '/r/cld/bin',
        '/home/u/.local/bin',
        '/usr/bin',
        '/usr/sbin',
        '/mnt/c/Windows/System32',
        '/mnt/c/Program Files/nodejs',
        '/mnt/c/Windows',
        '/usr/lib/wsl/lib',
      ].join(':'),
    );
  });

  it('off WSL there are no Windows entries and cmd.exe is not run', () => {
    const f = fakes({ wsl: false });
    const built = buildSessionPath(f.opts)!;
    expect(built).toBe('/r/cld/bin:/home/u/.local/bin:/usr/bin:/usr/sbin');
    expect(f.calls).toEqual(['bash']);
  });

  it('a failing runner falls back: nothing added, or just the part that worked', () => {
    expect(buildSessionPath(fakes({ login: null, win: null }).opts)).toBe(
      '/r/cld/bin:/usr/lib/wsl/lib',
    );
    expect(buildSessionPath(fakes({ login: null }).opts)).toContain('/mnt/c/Windows/System32');
    expect(buildSessionPath(fakes({ win: null }).opts)).not.toContain('/mnt/c');
    const boom = {
      ...fakes({}).opts,
      run: () => {
        throw new Error('x');
      },
    };
    expect(buildSessionPath(boom)).toBeNull();
    expect(buildSessionPath({ ...fakes({}).opts, platform: 'win32' })).toBeNull();
  });

  it('takes the last line of a noisy login shell', () => {
    expect(
      buildSessionPath(fakes({ login: 'welcome\n/opt/x/bin:/usr/bin', wsl: false }).opts),
    ).toBe('/r/cld/bin:/opt/x/bin:/usr/bin');
  });

  it('startArgs puts PATH in the settings env next to CLD_BIN; a wake resume carries nothing', () => {
    const p = { projectId: 'p_abcdefghij', name: 'alpha', folder: '/w/alpha', wantRunning: false };
    const args = startArgs(
      p,
      undefined,
      false,
      '/r/cld/bin/cld-gui',
      '/r/cld/bin:/mnt/c/Windows/System32',
    );
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject({
      env: { CLD_BIN: '/r/cld/bin/cld-gui', PATH: '/r/cld/bin:/mnt/c/Windows/System32' },
      worktree: { bgIsolation: 'none' },
    });
    expect(startArgs(p, 'sid', true, '/r/cld/bin/cld-gui', '/x')).toEqual([
      '--bg',
      '--resume',
      'sid',
    ]);
  });

  it('the engine env (jobs, Codex workers) carries the built PATH, then the service entries it lacks', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-spath-'));
    try {
      const e = new Engine({
        claudePath: '/nope',
        readOnly: false,
        home,
        systemdRun: null,
        env: { PATH: '/svc/bin:/usr/bin' },
        binDir: '/r/cld/bin',
        sessionPath: '/r/cld/bin:/usr/bin:/mnt/c/Windows/System32',
      });
      // ENV-1: then the daemon's own Node folder, last, for the `#!/usr/bin/env node` CLI.
      expect(e.jobEnv().PATH).toBe(
        `/r/cld/bin:/usr/bin:/mnt/c/Windows/System32:/svc/bin:${path.dirname(process.execPath)}`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a job keeps its caller PATH and gains the engine entries it lacks', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-spath-'));
    try {
      const jobs = new Jobs({
        home,
        events: new EngineEvents(eventsPath(home)),
        env: () => ({
          CLD_BIN: '/r/cld/bin/cld-gui',
          PATH: '/r/cld/bin:/usr/bin:/mnt/c/Windows/System32',
        }),
        systemdRun: null,
        changed: () => {},
        log: () => {},
      });
      const env = (
        jobs as unknown as {
          jobEnv(p: string, c: string, x: string): NodeJS.ProcessEnv;
        }
      ).jobEnv('/caller/bin:/usr/bin', 'true', '/tmp/x');
      expect(env.PATH).toBe('/r/cld/bin:/caller/bin:/usr/bin:/mnt/c/Windows/System32');
      expect(appendMissing('a:b', 'b:c', ':')).toBe('a:b:c');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
