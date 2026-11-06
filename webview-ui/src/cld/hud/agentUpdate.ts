/**
 * AGENT-UPDATE: an agent CLI's 업데이트 as the control center's usage rows see it, by agent provider
 * id (the same for every agent). `updateAgentCli` asks the daemon to run the CLI's own update
 * command; a remote device is asked for the step-up proof, then the request goes once more.
 */
import { useEffect, useSyncExternalStore } from 'react';

import type { AgentCliUpdateState } from '../../../../core/src/messages.js';
import { AGENT_LATEST_ASK_GAP_MS, AGENT_UPDATE_RESULT_MS } from '../../constants.js';
import { stepUpFailedText } from '../auth/authApi.js';
import { requestStepUp } from '../auth/stepUp.js';

export interface AgentUpdateView {
  phase: AgentCliUpdateState['phase'];
  ok: boolean;
  before?: string;
  after?: string;
  lines: string[];
  /** The CLI cannot update itself: update it by hand, with `command` when it gave one. */
  manual: boolean;
  command?: string;
  /** A refusal's or a timeout's code, or the step-up's own failure text. */
  error: string | null;
}

let byAgent: Readonly<Record<string, AgentUpdateView>> = {};
const listeners = new Set<() => void>();
/** Whether a usage panel is open: a finished result lives only while one is. */
let panelOpen = false;
const expiry = new Map<string, ReturnType<typeof setTimeout>>();
const drop = (agent: string) => {
  clearTimeout(expiry.get(agent));
  expiry.delete(agent);
  if (!(agent in byAgent)) return;
  byAgent = Object.fromEntries(Object.entries(byAgent).filter(([a]) => a !== agent));
  listeners.forEach((l) => l());
};
const set = (agent: string, view: AgentUpdateView) => {
  clearTimeout(expiry.get(agent));
  expiry.delete(agent);
  if (view.phase !== 'running' && !panelOpen) return drop(agent); // nobody is looking: nothing to keep
  byAgent = { ...byAgent, [agent]: view };
  // A success goes after a minute; a failure (or a CLI that must be updated by hand) stays until the panel closes.
  if (view.phase === 'done' && view.ok && !view.manual) expiry.set(agent, setTimeout(() => drop(agent), AGENT_UPDATE_RESULT_MS));
  listeners.forEach((l) => l());
};

/** The usage panel opened or closed (every list of it: the folded tile's pop, the whole center, the phone's sheet).
 *  Closing ends every finished result; one still running goes on. */
export function setUsagePanelOpen(open: boolean): void {
  panelOpen = open;
  if (!open) for (const [agent, view] of Object.entries(byAgent)) if (view.phase !== 'running') drop(agent);
}

/** AGENT-LATEST: ask the daemon for the newest CLI versions (it caches an hour; `refresh` skips that, at most every 30 s). */
let lastRefresh = -Infinity;
export function askAgentLatest(refresh = false, now = Date.now()): void {
  if (refresh) {
    if (now - lastRefresh < AGENT_LATEST_ASK_GAP_MS) return;
    lastRefresh = now;
  }
  send({ type: 'agentCliLatest', refresh });
}

/** A usage panel is `open`: results live while it is, and its opening asks for the newest versions. */
export function useUsagePanel(open: boolean): void {
  useEffect(() => {
    setUsagePanelOpen(open);
    if (open) askAgentLatest();
    return () => setUsagePanelOpen(false);
  }, [open]);
}
/** The agents whose next step-up refusal retries the update, once. */
const retry = new Set<string>();

const send = (msg: Record<string, unknown>) =>
  // Loaded on use: the transport touches `window`, and this store is imported by Node-run tests.
  void import('../../transport/index.js').then(({ transport }) => transport.send(msg as never));

export function updateAgentCli(agent: string, again = true): void {
  if (again) retry.add(agent);
  else retry.delete(agent);
  set(agent, { phase: 'running', ok: false, lines: [], manual: false, error: null });
  send({ type: 'agentCliUpdate', agent });
}

export function agentUpdateHandleMessage(msg: AgentCliUpdateState): void {
  if (msg.phase === 'refused' && msg.error === 'stepup' && retry.has(msg.agent)) {
    retry.delete(msg.agent);
    const failed = () => set(msg.agent, { phase: 'refused', ok: false, lines: [], manual: false, error: stepUpFailedText() });
    void requestStepUp().then((ok) => (ok ? updateAgentCli(msg.agent, false) : failed()), failed);
    return;
  }
  if (msg.phase !== 'running') retry.delete(msg.agent);
  set(msg.agent, {
    phase: msg.phase,
    ok: msg.ok === true,
    before: msg.before,
    after: msg.after,
    lines: msg.lines ?? [],
    manual: msg.manual === true,
    command: msg.command,
    error: msg.error ?? null,
  });
}

export const peekAgentUpdate = (agent: string): AgentUpdateView | undefined => byAgent[agent];

export const useAgentUpdate = (agent: string): AgentUpdateView | undefined =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => peekAgentUpdate(agent),
  );
