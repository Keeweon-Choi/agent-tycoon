// The daemon's `/usage` probe adds no agent: neither its hooks (should --safe-mode not hold), nor its
// transcript (should --no-session-persistence not hold), nor its session file is ever an office agent.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeProjectPath } from '../../../core/src/normalizeProjectPath.js';
import { AgentStateStore } from '../agentStateStore.js';
import { DismissalTracker } from '../dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  scanExternalDir,
  setDismissalTracker,
} from '../fileWatcher.js';
import { PathSet } from '../pathKey.js';
import { ClaudeSessions } from './providers/claudeProvider.js';
import { isUsageProbeFolder, usageProbeDir } from './usageProbeFolder.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-probe-'));
  vi.stubEnv('HOME', home); // os.homedir(): the guard's default home, never the real one
  setDismissalTracker(new DismissalTracker());
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const maps = () => ({
  known: new PathSet(),
  next: { current: 1 },
  agents: new AgentStateStore(),
  watchers: new Map<number, fs.FSWatcher>(),
  polls: new Map<number, ReturnType<typeof setInterval>>(),
  waits: new Map<number, ReturnType<typeof setTimeout>>(),
  perms: new Map<number, ReturnType<typeof setTimeout>>(),
});
const stop = (m: ReturnType<typeof maps>) => {
  for (const t of m.polls.values()) clearInterval(t);
  for (const w of m.watchers.values()) w.close();
};
/** A transcript the way Claude Code would write one for `cwd` (under <home>/.claude/projects). */
const transcript = (cwd: string) => {
  const dir = path.join(home, '.claude', 'projects', normalizeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'probe-session.jsonl');
  fs.writeFileSync(file, '{"type":"assistant"}\n');
  return file;
};

describe('the /usage probe adds no agent', () => {
  it('a hook from the probe folder is not adopted, with or without a transcript; another folder is', () => {
    const probe = usageProbeDir(home);
    const m = maps();
    const adopt = (sid: string, file: string | undefined, cwd: string) =>
      adoptExternalSessionFromHook(
        sid,
        file,
        cwd,
        m.known,
        m.next,
        m.agents,
        m.watchers,
        m.polls,
        m.waits,
        m.perms,
        () => {},
      );
    adopt('probe-a', transcript(probe), probe);
    adopt('probe-b', undefined, probe);
    expect(m.agents.size).toBe(0);
    const work = path.join(home, 'work');
    adopt('real', transcript(work), work); // the control: the same call for a real folder adopts
    expect(m.agents.size).toBe(1);
    stop(m);
  });

  it("the scanner skips the probe's transcript folder", () => {
    const file = transcript(usageProbeDir(home));
    const m = maps();
    scanExternalDir(
      path.dirname(file),
      m.known,
      m.next,
      m.agents,
      m.watchers,
      m.polls,
      m.waits,
      m.perms,
      () => {},
    );
    expect(m.agents.size).toBe(0);
    stop(m);
  });

  it('a session file whose cwd is the probe folder is not listed', async () => {
    const dir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const row = (pid: number, cwd: string) =>
      fs.writeFileSync(
        path.join(dir, `${pid}.json`),
        JSON.stringify({ pid, procStart: '1', sessionId: `s-${pid}`, cwd, kind: 'interactive' }),
      );
    row(4101, usageProbeDir(home));
    row(4102, path.join(home, 'work'));
    const rows = await new ClaudeSessions(dir, null, () => true).list(false);
    expect(rows.map((r) => r.pid)).toEqual([4102]);
  });

  it.skipIf(process.platform === 'win32')(
    'matches the probe folder by its real path too (a symlinked home)',
    () => {
      const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-probe-real-'));
      const link = path.join(os.tmpdir(), `cld-probe-link-${path.basename(real)}`);
      fs.symlinkSync(real, link);
      try {
        expect(isUsageProbeFolder(path.join(real, 'x'), link)).toBe(false);
        fs.mkdirSync(usageProbeDir(real), { recursive: true });
        const viaLink = usageProbeDir(link);
        const viaReal = usageProbeDir(real);
        expect(isUsageProbeFolder(viaLink, link)).toBe(true);
        expect(isUsageProbeFolder(viaReal, link)).toBe(true);
        expect(
          isUsageProbeFolder(
            path.join(home, '.claude', 'projects', normalizeProjectPath(viaReal)),
            link,
          ),
        ).toBe(true);
        expect(isUsageProbeFolder(path.join(viaReal, '..', 'other'), link)).toBe(false);
      } finally {
        fs.unlinkSync(link);
        fs.rmSync(real, { recursive: true, force: true });
      }
    },
  );
});
