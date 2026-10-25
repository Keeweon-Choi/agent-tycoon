/**
 * Read-only discovery of the choices an installed agent CLI offers.  This
 * deliberately reads only public settings, never either agent's credentials.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { findOnPath } from '../providers/claudeProvider.js';
import { commandArgv } from '../spawnJson.js';
import { CODEX_EFFORTS } from './codex.js';

export interface AgentChoices {
  version?: string;
  models: string[];
  efforts: string[];
  /** D3b: the --permission-mode choices the help lists (absent when it lists none). */
  permissionModes?: string[];
  defaultModel?: string;
  defaultEffort?: string;
}

export interface InstalledAgentChoices {
  claude?: AgentChoices;
  codex?: AgentChoices;
}

/** What the engine needs from discovery; tests inject a fake so none probes the real CLIs. */
export interface AgentChoicesReader {
  discover(refresh?: boolean): InstalledAgentChoices;
}

type Fs = Pick<typeof fs, 'readFileSync' | 'statSync'>;
type Run = (file: string, args: string[]) => { status: number | null; stdout: string };

const words = (s: string): string[] =>
  (s.match(/[A-Za-z][A-Za-z0-9._:-]*/g) ?? []).filter(
    (v) =>
      !new Set(['model', 'models', 'alias', 'aliases', 'full', 'name', 'or', 'the', 'latest']).has(
        v,
      ),
  );

/** Parses both older and newer help layouts without asserting a model list of our own. */
export function parseClaudeHelp(
  help: string,
): Pick<AgentChoices, 'models' | 'efforts' | 'permissionModes'> {
  const effort = /--effort\b([\s\S]{0,400})/i.exec(help)?.[1] ?? '';
  const model = /--model\b([\s\S]{0,700})/i.exec(help)?.[1] ?? '';
  const efforts = words(/\((?:choices:\s*)?([^)]*)\)/i.exec(effort)?.[1] ?? effort).filter((v) =>
    /^(low|medium|high|xhigh|max)$/i.test(v),
  );
  // The help quotes every alias and full name it documents ('x', 'y-1'); the list is the CLI's own.
  const models = [...model.matchAll(/'([A-Za-z][A-Za-z0-9._:-]*)'/g)].map((m) => m[1]);
  // `--permission-mode <mode> … (choices: "a", "b")`: the CLI's own words, quoted.
  const modes = /--permission-mode\b[^\n]*?\(choices:\s*([^)]*)\)/i.exec(help)?.[1] ?? '';
  const permissionModes = [...modes.matchAll(/"([A-Za-z][A-Za-z0-9_-]*)"/g)].map((m) => m[1]);
  return {
    models: [...new Set(models)],
    efforts: [...new Set(efforts.map((v) => v.toLowerCase()))],
    ...(permissionModes.length && { permissionModes: [...new Set(permissionModes)] }),
  };
}

export function parseClaudeSettings(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as { model?: unknown };
    return typeof value.model === 'string' ? value.model : undefined;
  } catch {
    return undefined;
  }
}

/** The small TOML subset used by Codex's top level and named profiles. */
export function parseCodexConfig(
  text: string,
): Pick<AgentChoices, 'models' | 'efforts' | 'defaultModel' | 'defaultEffort'> {
  let section = '';
  let defaultModel: string | undefined;
  let defaultEffort: string | undefined;
  const models: string[] = [];
  const efforts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const heading = /^\[([^\]]+)]$/.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    const pair = /^(model|model_reasoning_effort)\s*=\s*["']([^"']+)["']\s*$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    if (key === 'model') {
      models.push(value);
      if (!section) defaultModel = value;
    } else {
      efforts.push(value);
      if (!section) defaultEffort = value;
    }
  }
  return {
    models: [...new Set(models)],
    efforts: [...new Set(efforts)],
    defaultModel,
    defaultEffort,
  };
}

function versionOf(stdout: string): string | undefined {
  return stdout.trim().match(/\d+(?:\.\d+)+/)?.[0];
}

export class AgentChoicesCache implements AgentChoicesReader {
  private cached: { stamp: string; choices: InstalledAgentChoices } | null = null;

  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly disk: Fs = fs,
    private readonly run: Run = (file, args) => {
      const run = commandArgv(file, args); // claude.cmd/codex.cmd on Windows
      const out = spawnSync(run.file, run.args, {
        encoding: 'utf-8',
        timeout: 3_000,
        windowsVerbatimArguments: run.windowsVerbatimArguments,
      });
      return { status: out.status, stdout: out.stdout ?? '' };
    },
    private readonly find: (command: string, pathValue?: string) => string | null = findOnPath,
  ) {}

  discover(refresh = false): InstalledAgentChoices {
    const claude = this.find('claude', this.env.PATH);
    const codex = this.find('codex', this.env.PATH);
    const stamp = [claude, codex]
      .map((file) => {
        try {
          return `${file}:${file ? this.disk.statSync(file).mtimeMs : ''}`;
        } catch {
          return `${file}:missing`;
        }
      })
      .join('|');
    if (!refresh && this.cached?.stamp === stamp) return this.cached.choices;

    const choices: InstalledAgentChoices = {};
    if (claude) {
      const version = versionOf(this.run(claude, ['--version']).stdout);
      const help = parseClaudeHelp(this.run(claude, ['--help']).stdout);
      let defaultModel: string | undefined;
      try {
        defaultModel = parseClaudeSettings(
          this.disk.readFileSync(path.join(this.home, '.claude', 'settings.json'), 'utf-8'),
        );
      } catch {
        /* no settings is normal */
      }
      choices.claude = { version, ...help, defaultModel };
    }
    if (codex) {
      const version = versionOf(this.run(codex, ['--version']).stdout);
      let config: ReturnType<typeof parseCodexConfig> = { models: [], efforts: [] };
      try {
        config = parseCodexConfig(
          this.disk.readFileSync(path.join(this.home, '.codex', 'config.toml'), 'utf-8'),
        );
      } catch {
        /* no config is normal */
      }
      // D5: every effort Codex takes (isCodexEffort), the config's own as the default.
      choices.codex = { version, ...config, efforts: [...CODEX_EFFORTS] };
    }
    this.cached = { stamp, choices };
    return choices;
  }
}
