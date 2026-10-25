/**
 * One character per stable key (FR-OFC-001/002). A session with a transcript
 * is driven by the upstream transcript machinery (startFileWatching ->
 * transcriptParser), so tools animate it; a session without one (off, shell,
 * absent, Codex contractor) is an idle synthetic agent. When the transcript
 * changes (renew, /clear, new session id) the SAME agent is re-bound. The
 * label is the provider's name, carried in `directoryName`.
 *
 * Agents are created non-external: the upstream stale check and restore only
 * handle external agents, so they never remove or duplicate these.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { AgentRuntime } from '../agentRuntime.js';
import { createAgentState } from '../agentState.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { startFileWatching } from '../fileWatcher.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import { cancelWaitingTimer, clearAgentActivity } from '../timerManager.js';
import type { AgentState } from '../types.js';

export interface CharacterSpec {
  key: string;
  label: string;
  transcript: string | null;
  /** The saved look's built-in palette (characters.json); unset = the least-used one. */
  look?: { palette: number; hueShift: number } | null;
}

export class CharacterBinder {
  private readonly ids = new Map<string, number>();
  private readonly removals = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly store: AgentStateStore,
    /** Keep a vanished character this long before removing it (contractors). */
    private readonly graceMs = 0,
  ) {}

  idOf(key: string): number | null {
    const id = this.ids.get(key);
    return id !== undefined && this.store.has(id) ? id : null;
  }

  keyOf(id: number): string | undefined {
    for (const [k, v] of this.ids) if (v === id) return k;
    return undefined;
  }

  reconcile(specs: CharacterSpec[]): void {
    const want = new Set<string>();
    for (const spec of specs) {
      want.add(spec.key);
      const pending = this.removals.get(spec.key);
      if (pending) {
        clearTimeout(pending);
        this.removals.delete(spec.key);
      }
      const id = this.ids.get(spec.key);
      const agent = id !== undefined ? this.store.get(id) : undefined;
      if (id === undefined || !agent) {
        this.create(spec);
        continue;
      }
      agent.directoryName = spec.label;
      if (agent.jsonlFile !== (spec.transcript ?? '')) {
        this.unbind(id, agent, spec.key);
        if (spec.transcript) this.bind(id, agent, spec.transcript);
      }
    }
    for (const key of [...this.ids.keys()]) {
      if (want.has(key) || this.removals.has(key)) continue;
      if (this.graceMs <= 0) this.remove(key);
      else
        this.removals.set(
          key,
          setTimeout(() => {
            this.removals.delete(key);
            this.remove(key);
          }, this.graceMs),
        );
    }
  }

  dispose(): void {
    for (const t of this.removals.values()) clearTimeout(t);
    this.removals.clear();
  }

  private create(spec: CharacterSpec): void {
    const id = this.store.nextAgentId.current++;
    const agent = createAgentState({
      id,
      sessionId: `cld:${spec.key}`,
      isExternal: false,
      projectDir: '',
      jsonlFile: '',
      directoryName: spec.label,
    });
    if (spec.look) Object.assign(agent, spec.look);
    assignPaletteIfNeeded(agent, this.store);
    this.ids.set(spec.key, id);
    this.store.set(id, agent); // -> agentCreated
    if (spec.transcript) this.bind(id, agent, spec.transcript);
  }

  /** Follow a transcript from its current end (history is not replayed). */
  private bind(id: number, agent: AgentState, transcript: string): void {
    agent.jsonlFile = transcript;
    agent.projectDir = path.dirname(transcript);
    agent.sessionId = path.basename(transcript, '.jsonl');
    agent.lineBuffer = '';
    try {
      agent.fileOffset = fs.statSync(transcript).size;
    } catch {
      agent.fileOffset = 0; // not written yet: read it from the start once it is
    }
    agent.lastDataAt = Date.now();
    const r = this.runtime;
    r.knownJsonlFiles.add(transcript);
    startFileWatching(
      id,
      transcript,
      this.store,
      r.fileWatchers,
      r.pollingTimers,
      r.waitingTimers,
      r.permissionTimers,
    );
    r.registerAgent(agent.sessionId, id);
  }

  private unbind(id: number, agent: AgentState, key: string): void {
    const r = this.runtime;
    const poll = r.pollingTimers.get(id);
    if (poll) clearInterval(poll);
    r.pollingTimers.delete(id);
    r.fileWatchers.get(id)?.close();
    r.fileWatchers.delete(id);
    cancelWaitingTimer(id, r.waitingTimers);
    if (agent.jsonlFile) {
      r.unregisterAgent(agent.sessionId);
      clearAgentActivity(agent, id, this.store, r.permissionTimers);
    }
    agent.jsonlFile = '';
    agent.projectDir = '';
    agent.sessionId = `cld:${key}`;
  }

  private remove(key: string): void {
    const id = this.ids.get(key);
    this.ids.delete(key);
    if (id === undefined) return;
    const agent = this.store.get(id);
    if (agent?.jsonlFile) this.runtime.unregisterAgent(agent.sessionId);
    this.runtime.removeAgent(id); // -> agentClosed
  }
}
