/**
 * The empty folder the daemon runs Claude Code's `/usage` probe in (usage.ts). The probe is
 * started with --no-session-persistence and --safe-mode (no transcript, no hooks); this folder
 * is the second guard: a session whose working folder, or whose transcript folder (Claude's
 * ~/.claude/projects/<the folder, every non-alphanumeric a dash>), is this one is never
 * adopted or listed, so a CLI that ignored those flags still adds no agent to the office.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../../core/src/normalizeProjectPath.js';
import { pathsMatch } from '../pathKey.js';
import { configDirectory } from './configPath.js';

export const usageProbeDir = (home: string): string =>
  path.join(configDirectory(home), 'usage-probe');

/** The probe folder's real path (a symlinked ~/.config or $HOME), once it exists; looked up again until then. */
const realProbeDirs = new Map<string, string>();
function realProbeDir(probe: string): string | null {
  let real = realProbeDirs.get(probe);
  if (real === undefined) {
    try {
      real = fs.realpathSync(probe);
      realProbeDirs.set(probe, real);
    } catch {
      return null; // not made yet
    }
  }
  return real;
}

/** `dir` is the probe's working folder or its transcript folder under ~/.claude/projects. */
export function isUsageProbeFolder(dir: string | undefined, home = os.homedir()): boolean {
  if (!dir) return false;
  const probe = usageProbeDir(home);
  const real = realProbeDir(probe);
  return [probe, ...(real ? [real] : [])].some(
    (p) => pathsMatch(dir, p) || path.basename(dir) === normalizeProjectPath(p),
  );
}
