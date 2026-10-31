/**
 * FileStateAdapter: shared StateAdapter implementation for both VS Code and standalone.
 *
 * Settings (per adapter namespace) persist to
 *   <office folder>/config.json  under the key "standalone".
 *
 * Agents + seats (per adapter) persist to
 *   <office folder>/<namespace>-state.json   (officeFolder.ts; read from ~/.pixel-agents for one release)
 *
 * Runtime visibility (which agents show in the office) is scope-controlled by the
 * runtime scanner + Watch All Sessions toggle, not by persistence. Both adapters
 * can observe the same ~/.claude/projects/ filesystem; each keeps its own local
 * agent IDs and seat mappings.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import type { AdapterSettingKey, AdapterSettings, ConfigNamespace } from './configPersistence.js';
import { ADAPTER_SETTING_KEYS, readConfig, writeConfig } from './configPersistence.js';
import { officeFile, officeFileToRead } from './officeFolder.js';

const ADAPTER_SETTING_KEY_SET: ReadonlySet<string> = new Set(ADAPTER_SETTING_KEYS);

/** Strip the leading "agent-tycoon." prefix to match AdapterSettings field names. */
function settingNameOf(key: string): AdapterSettingKey | null {
  const bare = key.startsWith('agent-tycoon.') ? key.slice('agent-tycoon.'.length) : key;
  return ADAPTER_SETTING_KEY_SET.has(bare) ? (bare as AdapterSettingKey) : null;
}

interface AdapterState {
  agents: PersistedAgent[];
  seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
}

const EMPTY_STATE: AdapterState = { agents: [], seats: {} };

export interface FileStateAdapterOptions {
  namespace: ConfigNamespace;
}

export class FileStateAdapter implements StateAdapter {
  private readonly namespace: ConfigNamespace;
  private readonly stateFileName: string;

  constructor(options: FileStateAdapterOptions) {
    this.namespace = options.namespace;
    this.stateFileName = `${options.namespace}-state.json`;
  }

  // ── Settings (shared config.json, per-namespace section) ────

  getSetting<T>(key: string, defaultValue: T): T {
    const field = settingNameOf(key);
    if (!field) return defaultValue;
    const config = readConfig();
    return config[this.namespace][field] as unknown as T;
  }

  setSetting<T>(key: string, value: T): void {
    const field = settingNameOf(key);
    if (!field) return;
    const config = readConfig();
    // Narrow by field to keep the union-safe write. Each entry is a boolean or string.
    (config[this.namespace] as unknown as Record<string, unknown>)[field] = value;
    writeConfig(config);
  }

  // ── Agents + seats (adapter-scoped file) ────────────────────

  loadAgents(): PersistedAgent[] {
    return this.readState().agents;
  }

  saveAgents(agents: PersistedAgent[]): void {
    const state = this.readState();
    state.agents = agents;
    this.writeState(state);
  }

  loadSeats(): Record<string, { palette?: number; hueShift?: number; seatId?: string }> {
    return this.readState().seats;
  }

  saveSeats(seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>): void {
    const state = this.readState();
    state.seats = seats;
    this.writeState(state);
  }

  // ── Internal state-file I/O ─────────────────────────────────

  private readState(): AdapterState {
    const file = officeFileToRead(this.stateFileName);
    try {
      if (!fs.existsSync(file)) {
        return { agents: [], seats: {} };
      }
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AdapterState>;
      return {
        agents: Array.isArray(parsed.agents) ? (parsed.agents as PersistedAgent[]) : [],
        seats:
          parsed.seats && typeof parsed.seats === 'object'
            ? (parsed.seats as AdapterState['seats'])
            : {},
      };
    } catch (err) {
      console.error('[Agent Tycoon] Failed to read adapter state:', err);
      return { ...EMPTY_STATE };
    }
  }

  private writeState(state: AdapterState): void {
    const file = officeFile(this.stateFileName);
    const dir = path.dirname(file);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const json = JSON.stringify(state, null, 2);
      const tmpPath = file + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, file);
    } catch (err) {
      console.error('[Agent Tycoon] Failed to write adapter state:', err);
    }
  }
}

// Re-export for callers that want to construct AdapterSettings defaults directly.
/** @public */
export type { AdapterSettings, ConfigNamespace };
