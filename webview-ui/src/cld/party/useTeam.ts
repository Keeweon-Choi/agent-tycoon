/**
 * T-71: the party's view of the teams (teamTree.ts) on live data: the engine's agents with their cards' ids,
 * and the sub-agents the devroom's sidebar lists (the same rows: subColumns, useSubs, subDot). The tools the
 * rows read come from the DevroomTools context (App provides them to the whole tree).
 */
import { useContext, useMemo, useSyncExternalStore } from 'react';

import { DevroomTools, subDot, useSubs } from '../devroom/devroomData.js';
import { columnOf, subColumns } from '../devroom/devroomState.js';
import { openDevRoomOn } from '../devroom/devroomStore.js';
import { traceOf, useSubWhere } from '../devroom/subWhere.js';
import { capsOf } from '../engine.js';
import { useEngineStore } from '../engineStore.js';
import { useCldStore, virtualAgentId } from '../officeStore.js';
import { type PartyRow, relationsOf, subsOfLead, taskOfFolder, type TeamAgent, teamAgents, teamRows, type TeamSub } from './teamTree.js';

export interface Team {
  agents: readonly TeamAgent[];
  subs: readonly TeamSub[];
  rows: (all: readonly number[], shown: readonly number[], composed: boolean) => PartyRow[];
  /** A Lead's team's live sub-agents (a Worker has none under it). */
  subsUnder: (id: number) => TeamSub[];
  relations: (id: number, self?: string) => ReturnType<typeof relationsOf>;
  isWorker: (id: number) => boolean;
  /** A Worker's terminal in the dev room. */
  openAgent: (id: number) => void;
  /** A sub-agent's read-only transcript in the dev room. */
  openSub: (key: string) => void;
}

export function useTeam(phone = false): Team {
  const engineState = useEngineStore().state;
  const { officeSnapshot } = useCldStore();
  const { agentTools, subagentTools } = useContext(DevroomTools);
  useSubWhere();
  const engine = engineState?.projects;
  const orchs = officeSnapshot?.orchestrators;
  const agents = useMemo(
    () =>
      teamAgents(engine ?? [], (name) => {
        const o = orchs?.find((x) => x.name === name);
        return o ? (o.agentId ?? virtualAgentId(`orch:${o.name}`)) : null;
      }),
    [engine, orchs],
  );
  const cols = (engine ?? []).map((p) => columnOf(p, orchs ?? [], capsOf(engineState, p.provider)));
  const subRows = useSubs(cols, subColumns(cols, subagentTools, agentTools));
  const subs = subRows.map((s): TeamSub => ({ key: s.key, agentId: s.agentId, desc: s.desc, dot: subDot(s, traceOf(s.key)?.perm === true) }));
  const agentOf = (id: number) => agents.find((a) => a.id === id);
  const taskOf = (a: TeamAgent) => (a.role === 'lead' ? null : taskOfFolder(a.folder));
  return {
    agents,
    subs,
    rows: (all, shown, composed) => teamRows(all, shown, agents, composed),
    subsUnder: (id) => (agentOf(id)?.role === 'lead' ? subsOfLead(id, agents, subs).filter((s) => s.dot !== 'done') : []),
    relations: (id, self) => relationsOf(id, agents, subs, self),
    isWorker: (id) => agentOf(id)?.role === 'worker',
    openAgent: (id) => {
      const a = agentOf(id);
      if (a) openDevRoomOn(a.project, taskOf(a), a.name, null, phone);
    },
    openSub: (key) => {
      const s = subs.find((x) => x.key === key);
      const a = s && agentOf(s.agentId);
      if (s && a) openDevRoomOn(a.project, taskOf(a), a.name, s.key, phone);
    },
  };
}

// ── The sub-agent card: which sub-agent's small card is open (one at a time) ──

let cardKey: string | null = null;
const listeners = new Set<() => void>();
export const setSubCard = (key: string | null): void => {
  cardKey = key;
  listeners.forEach((l) => l());
};
export const useSubCard = (): string | null =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => cardKey,
  );
