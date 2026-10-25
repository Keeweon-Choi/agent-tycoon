/**
 * MSG-ACTIONS: what 복사 copies and what 답글 refers to, for every bubble kind
 * (the boss's, a Lead's/Worker's, a peer's, a system notice, a room post).
 * Pure, so the Node runner tests it; Messenger.tsx wires it to the clipboard and composer.
 */
import { REPLY_CHIP_MAX, REPLY_SOURCE_MAX, snippet } from '../../../../core/src/cld/reply.js';
import type { ChatItem, ChatReply } from '../../../../core/src/messages.js';
import { splitAttachmentText } from './attachments.js';

/** Who a system notice is from, in a reply's quote line (the daemon's own name). */
export const SYSTEM_SENDER = 'cld-gui';

type Copyable = Pick<ChatItem, 'kind' | 'text' | 'attachments'>;

/** The message as its sender wrote it: the Markdown source (no header, the server strips it),
 *  attachments as their names, one per line. */
export function copyText(item: Copyable): string {
  if (item.kind === 'user') {
    const { body, attachments } = splitAttachmentText(item.text);
    return [body, ...attachments.map((file) => file.name)].filter(Boolean).join('\n');
  }
  return [item.text, ...(item.attachments ?? []).map((file) => file.name)]
    .filter(Boolean)
    .join('\n');
}

/** The id a reply names: a user item's C2 id when it has one (an assistant's `messageId` is the
 *  message it ANSWERS, never its own), else the item's own id (stable: from the transcript record). */
export const replyIdOf = (item: Pick<ChatItem, 'kind' | 'id' | 'messageId'>): string =>
  item.kind === 'user' && item.messageId ? item.messageId : item.id;

/** The sender a reply quotes: absent for the boss, the peer's name, cld-gui for a notice, else `lead`. */
export function replySenderOf(
  item: Pick<ChatItem, 'kind' | 'from' | 'fromName'>,
  lead: string,
): string | undefined {
  if (item.kind !== 'user') return lead;
  if (item.from === 'system') return SYSTEM_SENDER;
  if (item.from === 'peer') return item.fromName || SYSTEM_SENDER;
  return undefined;
}

/** The composer's reply draft for a message. Not cut to the quote here: the server masks
 *  secrets first, then cuts (replyRef); a cut before the mask could leave a token's head. */
export const replyDraft = (id: string, sender: string | undefined, text: string): ChatReply => ({
  id,
  ...(sender && { sender }),
  text: text.slice(0, REPLY_SOURCE_MAX),
});

/** The reply chip: `↩ <sender> · <first REPLY_CHIP_MAX characters>`; `you` names the boss. */
export const replyChipText = (reply: ChatReply, you: string): string =>
  `↩ ${reply.sender ?? you} · ${snippet(reply.text, REPLY_CHIP_MAX)}`;

/** The item a reply's id names in a loaded conversation, if it is loaded. */
export const findReplied = <T extends Pick<ChatItem, 'kind' | 'id' | 'messageId'>>(
  items: readonly T[],
  id: string,
): T | undefined => items.find((item) => replyIdOf(item) === id || item.id === id);
