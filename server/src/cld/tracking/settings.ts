/**
 * U-48 phase 2a: our own ~/.config/cld-gui/tracking.json, the only file document
 * tracking writes. Per project: the documents turned on (paths or globs relative to
 * its folder) and the conventional ones turned off, whether short ids count, and the
 * item keys hidden from the board. The index itself is never stored.
 *   {v: 1, projects: {<name>: {docs: {on: [...], off: [...]}, shortIds: bool, hidden: [...]}}}
 * 0600, written through a temp file and a rename (jsonFile.ts).
 */
import * as fs from 'fs';
import * as path from 'path';

import type { TrackingProjectSettings } from '../../../../core/src/messages.js';
import { readJson, writeJsonAtomic } from '../jsonFile.js';

export const TRACKING_VERSION = 1;
/** Paths or globs a project may turn on. */
export const DOCS_ON_MAX = 20;
export const DOCS_OFF_MAX = 50;
export const HIDDEN_MAX = 500;
export const PATH_MAX = 200;
export const KEY_MAX = 400;
/** Never read below these, whatever a path or glob says. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.worktrees']);

export const trackingPath = (home: string) => path.join(home, '.config', 'cld-gui', 'tracking.json');
export const NO_SETTINGS: TrackingProjectSettings = { on: [], off: [], shortIds: false, hidden: [] };

/** Why a refused change was refused; the screen words them (tasks.docs.error.<code>). */
export type SettingsError = 'path' | 'outside' | 'tooMany' | 'key' | 'save' | 'project' | 'denied';

/**
 * A path or glob relative to `folder`: no absolute path, no `..`, no `**`, nothing under
 * SKIP_DIRS, a Markdown (or JSON) file, and inside the folder once resolved. null = fine.
 */
export function checkPath(folder: string, p: unknown): SettingsError | null {
  if (typeof p !== 'string' || !p || p.length > PATH_MAX || /[\0\\]/.test(p)) return 'path';
  if (path.isAbsolute(p) || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return 'outside';
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) return 'outside';
  if (segs.some((s) => s === '' || s === '.' || s.includes('**') || SKIP_DIRS.has(s))) return 'path';
  if (!/\.(md|json)$/i.test(segs[segs.length - 1])) return 'path';
  const root = path.resolve(folder);
  return path.resolve(root, p).startsWith(root + path.sep) ? null : 'outside';
}

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].slice(0, max) : [];

function fromStored(raw: unknown): TrackingProjectSettings {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const docs = (p.docs && typeof p.docs === 'object' ? p.docs : {}) as Record<string, unknown>;
  return {
    on: strings(docs.on, DOCS_ON_MAX),
    off: strings(docs.off, DOCS_OFF_MAX),
    shortIds: p.shortIds === true,
    hidden: strings(p.hidden, HIDDEN_MAX),
  };
}

export class TrackingSettingsStore {
  private projects = new Map<string, TrackingProjectSettings>();

  constructor(readonly file: string) {
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      // Unreadable: kept aside (it is our own file), the defaults hold until the next change.
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* gone already */
      }
      return;
    }
    const projects = (raw as { projects?: unknown } | null)?.projects;
    if (projects && typeof projects === 'object')
      for (const [name, p] of Object.entries(projects)) this.projects.set(name, fromStored(p));
  }

  get(project: string): TrackingProjectSettings {
    return this.projects.get(project) ?? NO_SETTINGS;
  }

  /** Replace a project's settings after checking every path against its folder. */
  set(project: string, folder: string, next: TrackingProjectSettings): SettingsError | null {
    const on = strings(next.on, Infinity);
    const off = strings(next.off, Infinity);
    const hidden = strings(next.hidden, Infinity);
    if (on.length > DOCS_ON_MAX || off.length > DOCS_OFF_MAX || hidden.length > HIDDEN_MAX) return 'tooMany';
    for (const p of [...on, ...off]) {
      const e = checkPath(folder, p);
      if (e) return e;
    }
    if (hidden.some((k) => !k.startsWith(`doc:${project}/`) || k.length > KEY_MAX)) return 'key';
    return this.save(project, { on, off, shortIds: next.shortIds === true, hidden });
  }

  hide(project: string, key: unknown): SettingsError | null {
    if (typeof key !== 'string' || !key.startsWith(`doc:${project}/`) || key.length > KEY_MAX) return 'key';
    const cur = this.get(project);
    if (cur.hidden.includes(key)) return null;
    if (cur.hidden.length >= HIDDEN_MAX) return 'tooMany';
    return this.save(project, { ...cur, hidden: [...cur.hidden, key] });
  }

  private save(project: string, s: TrackingProjectSettings): SettingsError | null {
    const next = new Map(this.projects).set(project, s);
    const projects = Object.fromEntries(
      [...next].map(([name, p]) => [name, { docs: { on: p.on, off: p.off }, shortIds: p.shortIds, hidden: p.hidden }]),
    );
    try {
      writeJsonAtomic(this.file, { v: TRACKING_VERSION, projects });
    } catch {
      return 'save';
    }
    this.projects = next;
    return null;
  }
}
