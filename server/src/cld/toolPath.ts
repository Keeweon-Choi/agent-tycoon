/**
 * DEVROOM-SIDEBAR: the path a tool call touches, read once when its transcript line is read, so the
 * dev room can place a sub-agent in the worktree its calls touch (agentToolStart/subagentToolStart
 * `path`). A file or folder input; a shell command's `cd <dir>` or `git -C <dir>`; a shell or search
 * call without one runs in the record's working folder. Relative paths resolve against that folder.
 */
import * as path from 'path';

/** Longer is not a path a worktree is matched by. */
const PATH_MAX = 1024;
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;
/** The first `cd <dir>` or `git -C <dir>` of a command line (quoted or bare). */
const DIR_RE = /(?:^|[;&|(]\s*|\s)(?:cd|git\s+-C)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/;

function absolute(p: string, cwd: string | undefined): string | undefined {
  const s = p.trim();
  if (!s || s.length > PATH_MAX || s.startsWith('~') || s.startsWith('-')) return undefined;
  if (path.isAbsolute(s)) return path.normalize(s);
  return cwd && path.isAbsolute(cwd) ? path.resolve(cwd, s) : undefined;
}

export function toolPath(input: unknown, cwd: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const here = typeof cwd === 'string' ? cwd : undefined;
  for (const k of PATH_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v) return absolute(v, here);
  }
  if (typeof o.command === 'string') {
    const m = DIR_RE.exec(o.command);
    if (m) return absolute(m[1].replace(/^["']|["']$/g, ''), here);
  }
  if (typeof o.command === 'string' || typeof o.pattern === 'string') return here && absolute(here, undefined);
  return undefined;
}
