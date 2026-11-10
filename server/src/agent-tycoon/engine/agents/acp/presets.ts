/**
 * ACP-1: the coding agents that speak ACP (Agent Client Protocol) themselves, as data. This table is
 * the only place an ACP agent's specifics live: the provider (acp.ts) and the UI read it, never a
 * name. ADR-0016: only a binary installed on this machine is started, found on the daemon's PATH or
 * in the usual install folders the way agentCli finds claude; never `npx` / `uvx` (a package fetched
 * at start), never a path or argument a client sends. A missing agent is simply not offered.
 *
 * Every argv is the agent's own documented ACP mode (stdio), checked 2026-11-06 against the vendor's
 * docs and the ACP registry (cdn.agentclientprotocol.com/registry/v1/latest/registry.json):
 * - gemini: github.com/google-gemini/gemini-cli docs/cli/acp-mode.md, registry `gemini` (`--acp`)
 * - copilot: docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server (`--acp --stdio`),
 *   one premium request per prompt (billing 'metered')
 * - cursor: cursor.com/docs/cli/acp, registry `cursor` (`cursor-agent acp`; its `agent` alias is too
 *   common a name to look for)
 * - qwen: registry `qwen-code` (`--acp`)
 * - opencode: opencode.ai/docs (registry `opencode`: `opencode acp`)
 * - goose: registry `goose` (`goose acp`)
 * - kiro: kiro.dev/docs/cli/acp (`kiro-cli acp`)
 * - kimi: registry `kimi` (`kimi acp`)
 * Left out: Antigravity (its CLI's own ACP mode is not documented by Google; the registry entry is
 * a separate downloaded `agy_acp_server`), Claude (our real `claude` in the PTY host), Codex (its
 * app-server, not codex-acp).
 */
import * as path from 'path';

import { claudeInstallDirs } from '../../../agentCli.js';
import { findOnPath } from '../../../providers/claudeProvider.js';
import type { AgentCapabilities } from '../types.js';

export interface AcpPreset {
  /** The provider id (an assignment's `provider`, agentCaps' key, the logo table's key). */
  id: string;
  /** Shown as is: a product name, never translated. */
  name: string;
  /** Executable names looked for, in order (Windows also tries PATHEXT). */
  bins: readonly string[];
  /** Its ACP mode, exactly; nothing is ever appended. */
  argv: readonly string[];
  billing: AgentCapabilities['billing'];
  /** Install folders of its own, under the home folder, beside the usual ones. */
  dirs?: readonly string[];
  /** Folders whose same-named executable is not this CLI (an editor's launcher): skipped. */
  notIn?: RegExp;
}

export const ACP_PRESETS: readonly AcpPreset[] = [
  { id: 'gemini', name: 'Gemini CLI', bins: ['gemini'], argv: ['--acp'], billing: 'unknown' },
  // VS Code puts a `copilot` launcher on the PATH (bin/copilot-shim, and the WSL server's): it may run
  // or fetch the editor's own copy, so it is never taken for the CLI (and never probed: that would run it).
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    bins: ['copilot'],
    argv: ['--acp', '--stdio'],
    billing: 'metered',
    notIn: /(^|[\\/])(copilot-shim|\.vscode-server[^\\/]*)([\\/]|$)/i,
  },
  { id: 'cursor', name: 'Cursor', bins: ['cursor-agent'], argv: ['acp'], billing: 'unknown' },
  { id: 'qwen', name: 'Qwen Code', bins: ['qwen'], argv: ['--acp'], billing: 'unknown' },
  { id: 'opencode', name: 'OpenCode', bins: ['opencode'], argv: ['acp'], billing: 'unknown', dirs: ['.opencode/bin'] },
  { id: 'goose', name: 'goose', bins: ['goose'], argv: ['acp'], billing: 'unknown' },
  { id: 'kiro', name: 'Kiro CLI', bins: ['kiro-cli'], argv: ['acp'], billing: 'unknown' },
  { id: 'kimi', name: 'Kimi CLI', bins: ['kimi'], argv: ['acp'], billing: 'unknown' },
];

/** `preset`'s executable here: the PATH first, then its own and the usual install folders. */
export function findPreset(
  preset: AcpPreset,
  o: { env: NodeJS.ProcessEnv; home: string; platform?: NodeJS.Platform },
): string | null {
  const platform = o.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = [
    ...(o.env.PATH ?? o.env.Path ?? '').split(p.delimiter),
    ...(preset.dirs ?? []).map((d) => p.join(o.home, d)),
    ...claudeInstallDirs(platform, o.home, o.env),
  ].filter((d) => !!d && !preset.notIn?.test(d));
  for (const bin of preset.bins) {
    const found = findOnPath(bin, dirs.join(p.delimiter), platform, o.env.PATHEXT || undefined);
    if (found) return found;
  }
  return null;
}

/** The presets installed here, each with its executable. */
export function installedPresets(o: {
  env: NodeJS.ProcessEnv;
  home: string;
  platform?: NodeJS.Platform;
}): Array<{ preset: AcpPreset; bin: string }> {
  return ACP_PRESETS.flatMap((preset) => {
    const bin = findPreset(preset, o);
    return bin ? [{ preset, bin }] : [];
  });
}
