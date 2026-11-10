import type {
  ChatSearchAllResult,
  ChatSearchHit,
  GroupRoom,
  MessengerContact,
} from '../../../../core/src/messages.js';
import { MESSENGER_SEARCH_ALL_MIN_CHARS } from '../../constants.js';
import { serverLine } from '../serverText.js';
import { shownName } from './goneNames.js';

/** The text of the list's find field that is searched in the conversations' text (null: too short). */
export function searchAllQuery(findText: string): string | null {
  const query = findText.trim();
  return query.length >= MESSENGER_SEARCH_ALL_MIN_CHARS ? query : null;
}

export interface SearchAllRow {
  /** One conversation: a one-to-one one (`agentId`) or a group room (`roomId`). */
  key: string;
  agentId?: number;
  roomId?: string;
  name: string;
  hits: ChatSearchHit[];
  more: boolean;
}

/**
 * The daemon's groups as rows with the names the list shows (shownName, serverLine), in the order the
 * daemon sent (newest match first). A conversation the list no longer has (closed, removed since) is left out.
 */
export function searchAllRows(
  groups: ChatSearchAllResult['groups'],
  contacts: MessengerContact[],
  rooms: GroupRoom[],
): SearchAllRow[] {
  return groups.flatMap<SearchAllRow>((group) => {
    const { hits, more } = group;
    if (group.roomId !== undefined) {
      const room = rooms.find((r) => r.id === group.roomId);
      return room ? [{ key: `room:${room.id}`, roomId: room.id, name: serverLine(room.name), hits, more }] : [];
    }
    const contact = contacts.find((c) => c.agentId === group.agentId);
    return contact
      ? [{ key: `lead:${contact.agentId}`, agentId: contact.agentId, name: shownName(contact.name), hits, more }]
      : [];
  });
}
