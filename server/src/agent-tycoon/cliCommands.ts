/** Read the slash command and model metadata that the user's Claude Code exposes to one safe control request. */
import * as fs from 'fs';

import { CLAUDE_COMMANDS_PROBE_RETRY_MS, CLAUDE_COMMANDS_PROBE_TIMEOUT_MS } from '../constants.js';
import { type SpawnFn, spawnJson } from './spawnJson.js';
import { usageProbeDir } from './usageProbeFolder.js';

const INITIALIZE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--safe-mode',
];
const INITIALIZE_REQUEST = `${JSON.stringify({
  type: 'control_request',
  request_id: 'agent-tycoon-initialize',
  request: { subtype: 'initialize' },
})}\n`;

export type ClaudeCliCommand = { name: string; description: string; argumentHint: string };
export type ClaudeCliModel = { value: string; displayName: string };
export type ClaudeCliInitialize = {
  version: string;
  commands: ClaudeCliCommand[];
  models: ClaudeCliModel[];
};
export type ClaudeCommandsRunner = () => Promise<ClaudeCliInitialize | null>;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const command = (value: unknown): ClaudeCliCommand | null => {
  const row = record(value);
  if (
    !row ||
    typeof row.name !== 'string' ||
    typeof row.description !== 'string' ||
    typeof row.argumentHint !== 'string'
  )
    return null;
  return { name: row.name, description: row.description, argumentHint: row.argumentHint };
};

const model = (value: unknown): ClaudeCliModel | null => {
  const row = record(value);
  if (!row || typeof row.value !== 'string' || typeof row.displayName !== 'string') return null;
  return { value: row.value, displayName: row.displayName };
};

/** Deliberately copies only command, model and version fields: a control response can contain account metadata. */
export function claudeInitializeResult(value: unknown): ClaudeCliInitialize | null {
  const lines = Array.isArray(value) ? value : [value];
  for (const line of lines) {
    const control = record(line);
    if (control?.type !== 'control_response') continue;
    // The payload sits one level deeper: control_response.response.response (subtype/request_id are beside it).
    const response = record(record(control.response)?.response);
    if (!response || typeof response.claude_code_version !== 'string') continue;
    const commands = Array.isArray(response.commands)
      ? response.commands.map(command).filter((item): item is ClaudeCliCommand => item !== null)
      : [];
    const models = Array.isArray(response.models)
      ? response.models.map(model).filter((item): item is ClaudeCliModel => item !== null)
      : [];
    return { version: response.claude_code_version, commands, models };
  }
  return null;
}

type FileBuild = { path: string; mtimeMs: number; size: number };

const buildOf = (file: string): FileBuild | null => {
  try {
    const path = fs.realpathSync(file);
    const stat = fs.statSync(path);
    return stat.isFile() ? { path, mtimeMs: stat.mtimeMs, size: stat.size } : null;
  } catch {
    return null;
  }
};

const buildKey = (build: FileBuild): string => `${build.path}:${build.mtimeMs}:${build.size}`;

/**
 * Starts Claude only on demand. The executable's resolved path, mtime and size identify one build;
 * failures have a short memory too, so an unavailable CLI is not started for every messenger list.
 */
export class ClaudeCommandsCache {
  private readonly now: () => number;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly entries = new Map<
    string,
    { value: ClaudeCliInitialize | null; failedAt: number }
  >();
  private readonly running = new Map<string, Promise<ClaudeCliInitialize | null>>();

  constructor(
    private readonly opts: {
      claude: string;
      env: () => NodeJS.ProcessEnv;
      home: string;
      now?: () => number;
      spawnFn?: SpawnFn;
      retryMs?: number;
      timeoutMs?: number;
    },
  ) {
    this.now = opts.now ?? Date.now;
    this.spawnFn = opts.spawnFn;
    this.retryMs = opts.retryMs ?? CLAUDE_COMMANDS_PROBE_RETRY_MS;
    this.timeoutMs = opts.timeoutMs ?? CLAUDE_COMMANDS_PROBE_TIMEOUT_MS;
  }

  async get(): Promise<ClaudeCliInitialize | null> {
    const build = buildOf(this.opts.claude);
    if (!build) return null;
    const key = buildKey(build);
    const cached = this.entries.get(key);
    if (cached?.value) return cached.value;
    if (cached && this.now() - cached.failedAt < this.retryMs) return null;
    const active = this.running.get(key);
    if (active) return active;
    const run = this.run().then((value) => {
      this.entries.set(key, { value, failedAt: value ? Number.NEGATIVE_INFINITY : this.now() });
      return value;
    });
    this.running.set(key, run);
    void run.finally(() => this.running.delete(key));
    return run;
  }

  private async run(): Promise<ClaudeCliInitialize | null> {
    try {
      const cwd = usageProbeDir(this.opts.home);
      fs.mkdirSync(cwd, { recursive: true });
      return claudeInitializeResult(
        await spawnJson(this.opts.claude, INITIALIZE_ARGS, {
          env: this.opts.env(),
          cwd,
          timeoutMs: this.timeoutMs,
          ndjson: true,
          stdin: INITIALIZE_REQUEST,
          spawnFn: this.spawnFn,
        }),
      );
    } catch {
      return null;
    }
  }
}
