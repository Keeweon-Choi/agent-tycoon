import { lookNameOf } from '../characters/looks.js';
import { useCldStore } from '../officeStore.js';
import { currentParty, partyIds, useParties, useSelectedParty } from './parties.js';
import { PartyHead } from './PartyHead.js';

/**
 * The party (cld only: the desktop column, AgentCardBar, and the phone's strip, MobileAgentBar): the ids the
 * chosen party shows and its head. Members are look keys (lookNameOf), else the card's name.
 */
export function usePartyColumn(
  ids: readonly number[],
  nameOf: ((id: number) => string | undefined) | undefined,
  up = false,
) {
  const { officeSnapshot, officeReadOnly } = useCldStore();
  const parties = useParties();
  const party = currentParty(parties, useSelectedParty());
  if (!nameOf) return { shown: [...ids], head: null };
  const keyOf = (id: number) => (officeSnapshot && lookNameOf(id, officeSnapshot)) || nameOf(id);
  const shown = partyIds(ids, party, keyOf);
  return {
    shown,
    head: (
      <PartyHead ids={ids} shown={shown.length} nameOf={(id) => nameOf(id) ?? `#${id}`} keyOf={keyOf} canEdit={!officeReadOnly} up={up} />
    ),
  };
}
