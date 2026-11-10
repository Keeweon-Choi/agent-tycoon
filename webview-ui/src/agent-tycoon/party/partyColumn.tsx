import { lookNameOf } from '../characters/looks.js';
import { useAgtyStore } from '../officeStore.js';
import { currentParty, partyIds, useParties, useSelectedParty } from './parties.js';
import { PartyHead } from './PartyHead.js';
import { SubCardHost, SubIcons } from './TeamBits.js';
import type { PartyRow } from './teamTree.js';
import { useTeam } from './useTeam.js';

/**
 * The party (agty only: the desktop column, AgentCardBar, and the phone's strip, MobileAgentBar): the rows
 * the chosen party shows and its head. Members are look keys (lookNameOf), else the card's name. 모두 shows
 * everyone flat; an owner-composed party also shows each member Lead's Workers (one step in) and its
 * sub-agents as icons (T-71), none of them stored as members. `press` is what a portrait does (a Worker in a
 * composed party opens its devroom terminal), `subs` the icons under a row, `card` the sub-agent card.
 */
export function usePartyColumn(
  ids: readonly number[],
  nameOf: ((id: number) => string | undefined) | undefined,
  up = false,
) {
  const { officeSnapshot, officeReadOnly } = useAgtyStore();
  const parties = useParties();
  const party = currentParty(parties, useSelectedParty());
  const team = useTeam(up);
  const composed = party !== null;
  if (!nameOf) return { shown: [...ids], rows: ids.map((id): PartyRow => ({ id, depth: 0 })), head: null, press: undefined, subs: () => null, card: null };
  const keyOf = (id: number) => (officeSnapshot && lookNameOf(id, officeSnapshot)) || nameOf(id);
  const members = partyIds(ids, party, keyOf);
  const rows = team.rows(ids, members, composed);
  return {
    shown: rows.map((r) => r.id),
    rows,
    head: (
      <PartyHead ids={ids} shown={members.length} nameOf={(id) => nameOf(id) ?? `#${id}`} keyOf={keyOf} canEdit={!officeReadOnly} up={up} />
    ),
    /** A portrait's own press: true when handled here (a Worker's terminal), else the bar selects the character. */
    press: composed
      ? (id: number) => {
          if (!team.isWorker(id)) return false;
          team.openAgent(id);
          return true;
        }
      : undefined,
    subs: (id: number) => (composed ? <SubIcons subs={team.subsUnder(id)} /> : null),
    card: composed ? <SubCardHost /> : null,
  };
}
