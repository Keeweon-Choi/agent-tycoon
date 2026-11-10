/**
 * AGENT-LATEST (owner 11-06 22:03): the newest version published for each agent CLI, so the usage
 * panel can say "0.156.1 → 0.167.0" before the owner presses 업데이트. DISPLAY ONLY: it never decides
 * what gets installed (the CLI's own updater does). The npm registry over HTTPS (`<package>/<dist-tag>`),
 * a short timeout, a capped body, redirects refused, a failure is quiet. Looked up only when a viewer
 * asks (the panel opened or its ↻ pressed), never on a timer: a CLI is asked again after an hour, a
 * forced ask skips the hour, and no CLI is asked twice within 30 s. Claude Code follows the `stable`
 * dist-tag when its settings pick that update channel (read only).
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  AGENT_LATEST_MAX_BYTES,
  AGENT_LATEST_MIN_GAP_MS,
  AGENT_LATEST_PACKAGES,
  AGENT_LATEST_REGISTRY,
  AGENT_LATEST_TIMEOUT_MS,
  AGENT_LATEST_TTL_MS,
} from '../constants.js';
import type { InstalledAgentChoices } from './engine/agentCapabilities.js';

export interface AgentLatestDeps {
  home: string;
  fetch?: typeof fetch;
  now?: () => number;
  readFile?: (file: string) => string;
}

const VERSION = /^\d+\.\d+\.\d+$/;

export class AgentLatest {
  private readonly found: Record<string, { version?: string; okAt: number; triedAt: number }> = {};
  private running: Promise<boolean> | null = null;
  private readonly get: typeof fetch;
  private readonly now: () => number;
  private readonly read: (file: string) => string;

  constructor(private readonly d: AgentLatestDeps) {
    this.get = d.fetch ?? fetch;
    this.now = d.now ?? Date.now;
    this.read = d.readFile ?? ((f) => fs.readFileSync(f, 'utf-8'));
  }

  /** `choices` with each CLI's newest known version added (a copy; the discovery cache stays as it is). */
  merge(choices: InstalledAgentChoices): InstalledAgentChoices {
    const out: InstalledAgentChoices = { ...choices };
    for (const id of Object.keys(AGENT_LATEST_PACKAGES) as Array<keyof typeof AGENT_LATEST_PACKAGES>) {
      const latest = this.found[id]?.version;
      if (out[id] && latest) out[id] = { ...out[id], latest };
    }
    return out;
  }

  /** Looks up what is due; resolves true when a version changed. One lookup at a time. */
  refresh(force: boolean): Promise<boolean> {
    return (this.running ??= this.lookup(force).finally(() => {
      this.running = null;
    }));
  }

  private async lookup(force: boolean): Promise<boolean> {
    const now = this.now();
    let changed = false;
    for (const [id, pkg] of Object.entries(AGENT_LATEST_PACKAGES)) {
      const seen = this.found[id];
      if (seen && (now - seen.triedAt < AGENT_LATEST_MIN_GAP_MS || (!force && now - seen.okAt < AGENT_LATEST_TTL_MS))) continue;
      const version = await this.registry(pkg, id === 'claude' ? this.claudeTag() : 'latest');
      const before = seen?.version;
      this.found[id] = { version: version ?? before, okAt: version ? now : (seen?.okAt ?? 0), triedAt: now };
      changed ||= this.found[id].version !== before;
    }
    return changed;
  }

  /** Claude Code's update channel from its own settings; `latest` when unsure.
   *  ponytail: the user's settings.json only (not a managed or project one); read, never written. */
  private claudeTag(): 'stable' | 'latest' {
    try {
      const s = JSON.parse(this.read(path.join(this.d.home, '.claude', 'settings.json'))) as { autoUpdatesChannel?: unknown };
      return s.autoUpdatesChannel === 'stable' ? 'stable' : 'latest';
    } catch {
      return 'latest';
    }
  }

  private async registry(pkg: string, tag: string): Promise<string | undefined> {
    try {
      const res = await this.get(`${AGENT_LATEST_REGISTRY}${pkg}/${tag}`, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(AGENT_LATEST_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) return undefined;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > AGENT_LATEST_MAX_BYTES) {
          void reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
      const version = (JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { version?: unknown }).version;
      return typeof version === 'string' && VERSION.test(version) ? version : undefined;
    } catch {
      return undefined; // quiet: offline, a slow registry or a bad answer just leaves the version unknown
    }
  }
}
