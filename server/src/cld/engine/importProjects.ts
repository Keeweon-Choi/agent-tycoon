/** Discover existing projects without changing their folders or loading transcripts. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizeProjectPath, type PathHost } from '../../../../core/src/cld/projectPath.js';
import { koText } from '../../../../core/src/cld/serverText.js';
import { normalizeProjectPath as claudePathKey } from '../../../../core/src/normalizeProjectPath.js';
import { findFolder } from '../folders.js';
import { unmark } from '../transcriptView.js';
import type { LiveSession } from './agents/types.js';
import { NAME_RE, samePath, SESSION_ID_RE } from './registry.js';

export interface ImportCandidate {
  folder: string;
  name: string;
  room: string;
  sessionId?: string;
  lastActivity?: string;
  title?: string;
  live: boolean;
  branch?: string;
  already: boolean;
}

const MAX_DIRS = 500;
const MAX_HEAD = 64 * 1024;

function inside(folder: string, home: string): boolean {
  return folder === home || folder.startsWith(home + path.sep);
}

function safeFile(file: string, host: PathHost): boolean {
  try {
    return inside(fs.realpathSync(file), fs.realpathSync(host.home)) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolve symlinks before checking the home boundary. */
export function safeHomeFolder(input: string, host: PathHost): string | null {
  const n = normalizeProjectPath(input, host);
  if ('error' in n) return null;
  const disk = findFolder(n.path, host);
  if (!disk) return null;
  try {
    const home = fs.realpathSync(host.home);
    const folder = fs.realpathSync(disk);
    return inside(folder, home) && fs.statSync(folder).isDirectory() ? folder : null;
  } catch {
    return null;
  }
}

function firstUserLine(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(fd).size, MAX_HEAD);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"user"')) continue;
      try {
        const row = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if (row.type !== 'user') continue;
        const content = row.message?.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.find((x) => x && x.type === 'text')?.text
              : undefined;
        if (typeof text === 'string' && text.trim())
          // C2: a session the engine started opens with our header; its mark is no title.
          return unmark(text.trim()).text.split(/\r?\n/)[0].slice(0, 60);
      } catch {
        /* a partial first line or malformed record */
      }
    }
  } catch {
    /* unreadable transcript */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

function conversation(folder: string, host: PathHost) {
  const dir = safeHomeFolder(
    path.join(host.home, '.claude', 'projects', claudePathKey(folder)),
    host,
  );
  if (!dir) return undefined;
  let newest: { sessionId: string; lastActivity: string; file: string; mtime: number } | undefined;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -6);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const file = path.join(dir, entry.name);
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime)
        newest = { sessionId, lastActivity: new Date(mtime).toISOString(), file, mtime };
    }
  } catch {
    /* no Claude conversations for this folder */
  }
  return (
    newest && {
      sessionId: newest.sessionId,
      lastActivity: newest.lastActivity,
      title: firstUserLine(newest.file),
    }
  );
}

function gitInfo(folder: string, host: PathHost): { branch?: string } | null {
  try {
    const git = path.join(folder, '.git');
    let gitDir = safeHomeFolder(git, host);
    if (fs.statSync(git).isFile()) {
      if (!safeFile(git, host)) return null;
      const pointer = fs.readFileSync(git, 'utf8').trim();
      if (!pointer.startsWith('gitdir: ')) return null;
      gitDir = safeHomeFolder(path.resolve(folder, pointer.slice(8)), host);
    }
    if (!gitDir) return null;
    const head = path.join(gitDir, 'HEAD');
    if (!safeFile(head, host)) return null;
    const value = fs.readFileSync(head, 'utf8').trim();
    return value.startsWith('ref: refs/heads/') ? { branch: value.slice(16) } : {};
  } catch {
    return null;
  }
}

function uniqueName(folder: string, used: Set<string>): string {
  let stem = path
    .basename(folder)
    .replace(/[^A-Za-z0-9가-힣._-]/g, '-')
    .replace(/^[^A-Za-z0-9가-힣]+/, '')
    .slice(0, 35);
  if (!stem || !NAME_RE.test(stem)) stem = 'project';
  let name = stem;
  for (let n = 2; used.has(name); n++) name = `${stem.slice(0, 35)}-${n}`;
  used.add(name);
  return name;
}

export function scanProjects(
  rootInput: string,
  host: PathHost,
  projects: Array<{ name: string; folder: string; sessionId?: string; wantRunning?: boolean }>,
  live: LiveSession[],
): ImportCandidate[] {
  const root = safeHomeFolder(rootInput, host);
  if (!root) throw new Error(koText('home_folders_only'));
  const used = new Set(projects.map((p) => p.name));
  const out: ImportCandidate[] = [];
  const seen = new Set<string>();
  const visit = (parent: string, depth: number) => {
    if (seen.size >= MAX_DIRS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen.size >= MAX_DIRS) break;
      if (entry.name.startsWith('.')) continue;
      const folder = safeHomeFolder(path.join(parent, entry.name), host);
      if (!folder || seen.has(folder)) continue;
      seen.add(folder);
      const convo = conversation(folder, host);
      const git = gitInfo(folder, host);
      if (git || safeFile(path.join(folder, 'CLAUDE.md'), host) || convo) {
        const holder = live.find((s) => s.kind === 'background' && samePath(s.cwd, folder, host));
        const registered = projects.find(
          (p) => samePath(p.folder, folder, host) || (!!convo && p.sessionId === convo.sessionId),
        );
        out.push({
          folder,
          // Already in the office: its own name, not a new one beside it.
          name: registered?.name ?? uniqueName(folder, used),
          room: path.basename(root),
          ...(convo && {
            sessionId: convo.sessionId,
            lastActivity: convo.lastActivity,
            ...(convo.title && { title: convo.title }),
          }),
          live: !!holder,
          ...(git?.branch && { branch: git.branch }),
          already: !!registered,
        });
      }
      if (depth < 2) visit(folder, depth + 1);
    }
  };
  visit(root, 1);
  return out;
}
