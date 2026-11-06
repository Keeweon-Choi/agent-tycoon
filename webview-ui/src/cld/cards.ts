/**
 * T-0036: the card bars in the cld office: every card says its group and
 * name (kinds.ts). Without office (no cld office) the bars stay upstream's.
 *
 * T-0041: temps (sub-agents, teammates, Codex workers) get no card of their
 * own. Their lead's card carries "+N" for them; temps with no lead card (a
 * Codex task no orchestrator owns) gather under one 외주 card, the first such
 * temp's. An orchestrator gone home keeps its card. The party draws them as portraits
 * (game/Party.tsx), the lead's team is its member card's 관계 tab (party/MemberCard.tsx).
 */
import { useMemo } from 'react';

import type { CardInfo } from '../components/cardBar.js';
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js';
import { useLanguage } from '../i18n/index.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { cardInfo, characterKind, KIND_ORDER } from './kinds.js';
import { useCldStore } from './officeStore.js';
import { useStaff } from './staff.js';
import { groupTemps, outsourcedLabel } from './temps.js';

const TEMP_KINDS = new Set(['subagent', 'teammate', 'codex']);

export function useCldCards(
  getOfficeState: () => OfficeState,
  agents: number[],
  subagents: SubagentCharacter[],
): { cardIds: number[]; describeCard?: (agentId: number) => CardInfo | undefined } {
  const { officeSnapshot: officeState, codexTasks } = useCldStore();
  const { temps } = useStaff();
  useLanguage();
  const outsourcedName = outsourcedLabel();
  return useMemo(() => {
    if (!officeState) return { cardIds: agents };
    const os = getOfficeState();
    const labels = new Map(subagents.map((s) => [s.id, s.label]));
    const isTemp = (id: number) => {
      const ch = os.characters.get(id);
      return TEMP_KINDS.has(characterKind(ch ?? { id }, officeState, codexTasks));
    };
    const leads = agents.filter((id) => !isTemp(id));
    const { byLead, outsourced } = groupTemps(temps, new Set(leads));
    const outsourcedCard = outsourced[0]?.id;
    return {
      cardIds: outsourcedCard === undefined ? leads : [...leads, outsourcedCard],
      describeCard: (id: number) => {
        if (id === outsourcedCard) return { group: KIND_ORDER.length, name: outsourcedName, temps: outsourced.length };
        const ch = os.characters.get(id);
        if (!ch) return undefined;
        const { group, name } = cardInfo(ch, officeState, codexTasks, labels.get(id));
        return { group, name, temps: byLead.get(id)?.length ?? 0 };
      },
    };
  }, [getOfficeState, agents, subagents, officeState, codexTasks, temps, outsourcedName]);
}
