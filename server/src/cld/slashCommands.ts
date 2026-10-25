/**
 * Slash commands which the office messenger may type into an engine session.
 * Only metadata is read: a bounded front matter prefix and one body line.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { koText, type Refused, refused } from '../../../core/src/cld/serverText.js';
import { slashTextProblem } from '../../../core/src/cld/slashText.js';
import type { SlashCommand } from '../../../core/src/messages.js';

export const SLASH_FILE_BYTES = 64 * 1024;
export const SLASH_MAX_COMMANDS = 300;
export const SLASH_RESCAN_MS = 30_000;
const WATCH_MS = 1_000;
const NAME = /^[A-Za-z][A-Za-z0-9:_-]*$/; // what slashTextProblem accepts to send

const BUILTINS: ReadonlyArray<Omit<SlashCommand, 'source'>> = [
  { name: 'compact', args: koText('slash_arg_instruction'), description: koText('slash_desc_compact') },
  { name: 'clear', description: koText('slash_desc_clear'), confirm: true },
  { name: 'context', description: koText('slash_desc_context') },
  { name: 'cost', description: koText('slash_desc_cost') },
  { name: 'init', description: koText('slash_desc_init') },
  { name: 'review', description: koText('slash_desc_review') },
  { name: 'security-review', description: koText('slash_desc_security') },
  { name: 'pr-comments', description: koText('slash_desc_pr') },
  { name: 'model', args: koText('slash_arg_model'), description: koText('slash_desc_model'), argsRequired: true },
  { name: 'add-dir', args: koText('slash_arg_path'), description: koText('slash_desc_add_dir'), argsRequired: true },
  { name: 'export', args: koText('slash_arg_file'), description: koText('slash_desc_export'), argsRequired: true },
];

type Meta = {
  name?: string;
  description?: string;
  args?: string;
  userInvocable: boolean;
  first?: string;
};
type Cached = { at: number; list: SlashCommand[]; signature: string };
type Watch = {
  callbacks: Set<(commands: SlashCommand[]) => void>;
  timer: ReturnType<typeof setInterval>;
};

const squash = (value: string, max: number) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Minimal front matter parser: command metadata has only scalar keys. */
export function parseSlashFrontmatter(text: string): Meta {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const fields = new Map<string, string>();
  let body = lines;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    const stop = end < 0 ? lines.length : end;
    for (let i = 1; i < stop; i++) {
      const match = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
      if (!match) continue;
      const value = match[2].trim();
      fields.set(match[1], /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value);
    }
    body = lines.slice(Math.min(stop + 1, lines.length));
  }
  return {
    name: fields.get('name') || undefined,
    description: fields.get('description') || undefined,
    args: fields.get('argument-hint') || undefined,
    userInvocable: fields.get('user-invocable')?.toLowerCase() !== 'false',
    first: body.find((line) => line.trim())?.replace(/^#+\s*/, ''),
  };
}

/** Metadata catalogue, with an inexpensive directory signature while watched. */
export class SlashCatalogue {
  private readonly home: string;
  private readonly now: () => number;
  private readonly cached = new Map<string, Cached>();
  private readonly watchers = new Map<string, Watch>();

  constructor(opts: { home?: string; now?: () => number } = {}) {
    this.home = opts.home ?? os.homedir();
    this.now = opts.now ?? Date.now;
  }

  list(projectDir: string): SlashCommand[] {
    const project = path.resolve(projectDir);
    const signature = this.signature(project);
    const hit = this.cached.get(project);
    if (hit && hit.signature === signature && this.now() - hit.at < SLASH_RESCAN_MS)
      return hit.list;
    const list = this.scan(project);
    this.cached.set(project, { at: this.now(), list, signature });
    return list;
  }

  /** Refresh only while somebody keeps this conversation open. */
  watch(projectDir: string, callback: (commands: SlashCommand[]) => void): () => void {
    const project = path.resolve(projectDir);
    let watch = this.watchers.get(project);
    if (!watch) {
      const callbacks = new Set<(commands: SlashCommand[]) => void>();
      let signature = this.signature(project);
      const timer = setInterval(() => {
        const next = this.signature(project);
        if (next === signature) return;
        signature = next;
        this.cached.delete(project);
        const commands = this.list(project);
        for (const listener of callbacks) listener(commands);
      }, WATCH_MS);
      watch = { callbacks, timer };
      this.watchers.set(project, watch);
    }
    watch.callbacks.add(callback);
    return () => {
      const current = this.watchers.get(project);
      if (!current) return;
      current.callbacks.delete(callback);
      if (current.callbacks.size) return;
      clearInterval(current.timer);
      this.watchers.delete(project);
    };
  }

  dispose(): void {
    for (const watch of this.watchers.values()) clearInterval(watch.timer);
    this.watchers.clear();
  }

  private scan(project: string): SlashCommand[] {
    const out: SlashCommand[] = BUILTINS.map((command) => ({ ...command, source: 'builtin' }));
    const seen = new Set(out.map((command) => command.name));
    const add = (command: SlashCommand | null) => {
      if (!command || seen.has(command.name) || out.length >= SLASH_MAX_COMMANDS) return;
      seen.add(command.name);
      out.push(command);
    };
    const claude = path.join(this.home, '.claude');
    for (const command of this.commands(path.join(claude, 'commands'), 'user')) add(command);
    for (const command of this.commands(path.join(project, '.claude', 'commands'), 'project'))
      add(command);
    for (const command of this.skills(path.join(claude, 'skills'), 'user')) add(command);
    for (const command of this.skills(path.join(project, '.claude', 'skills'), 'project'))
      add(command);
    return out;
  }

  private commands(root: string, source: SlashCommand['source']): SlashCommand[] {
    const out: SlashCommand[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of this.entries(root, dir)) {
        if (out.length >= SLASH_MAX_COMMANDS) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, `${prefix}${entry.name}:`);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const meta = this.read(root, full);
          const command = meta && this.command(`${prefix}${entry.name.slice(0, -3)}`, meta, source);
          if (command) out.push(command);
        }
      }
    };
    walk(root, '');
    return out;
  }

  private skills(root: string, source: SlashCommand['source']): SlashCommand[] {
    const out: SlashCommand[] = [];
    for (const entry of this.entries(root, root)) {
      if (out.length >= SLASH_MAX_COMMANDS || !entry.isDirectory()) continue;
      const meta = this.read(root, path.join(root, entry.name, 'SKILL.md'));
      const command = meta && this.command(meta.name ?? entry.name, meta, source);
      if (command) out.push(command);
    }
    return out;
  }

  private command(name: string, meta: Meta, source: SlashCommand['source']): SlashCommand | null {
    if (!NAME.test(name) || !meta.userInvocable) return null;
    return {
      name,
      ...(meta.args && { args: squash(meta.args, 60) }),
      description: squash(meta.description ?? meta.first ?? '', meta.description ? 120 : 80),
      source,
    };
  }

  private read(root: string, file: string): Meta | null {
    if (!this.within(root, file)) return null;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return null;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size, SLASH_FILE_BYTES));
        const size = fs.readSync(fd, buf, 0, buf.length, 0);
        return parseSlashFrontmatter(buf.toString('utf8', 0, size));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  private entries(root: string, dir: string): fs.Dirent[] {
    if (!this.within(root, dir)) return [];
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !entry.isSymbolicLink() && !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  private signature(project: string): string {
    const roots = [
      path.join(this.home, '.claude', 'commands'),
      path.join(this.home, '.claude', 'skills'),
      path.join(project, '.claude', 'commands'),
      path.join(project, '.claude', 'skills'),
    ];
    const rows: string[] = [];
    const visit = (root: string, dir: string) => {
      for (const entry of this.entries(root, dir)) {
        const full = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(full);
          rows.push(`${full}:${stat.size}:${stat.mtimeMs}`);
          if (entry.isDirectory()) visit(root, full);
        } catch {
          /* changed during scan */
        }
      }
    };
    for (const root of roots) visit(root, root);
    return rows.join('|');
  }

  private within(root: string, target: string): boolean {
    try {
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(target);
      return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
    } catch {
      return false;
    }
  }
}

/** Refusal for a typed command. The catalogue is the allow-list. */
export function slashRefusal(commands: readonly SlashCommand[], text: string): Refused | null {
  const syntax = slashTextProblem(text);
  if (syntax) return syntax;
  const [name, ...args] = text.slice(1).split(' ');
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) return refused('slash_unknown');
  if (command.argsRequired && !args.join(' ').trim()) {
    return refused('slash_needs_arg', { name: command.name, arg: command.args ?? koText('slash_arg_value') });
  }
  return null;
}
