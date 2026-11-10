/**
 * MSG-POLISH: the peek over the composer when the reply chip is tapped. It shows the message
 * the draft answers (full text, files by name, who wrote it, when) while the draft, the keyboard
 * and the list stay as they are. Pure, so the Node runner tests it; Messenger.tsx wires it up.
 */
import type { ChatItem, ChatReply } from '../../../../core/src/messages.js';
import { splitAttachmentText } from './attachments.js';
import { findReplied, replySenderOf } from './messageActions.js';

export interface PeekView {
  /** Absent: the boss. */
  sender?: string;
  /** Absent: the original is not loaded, only the chip's quote is known. */
  at?: number;
  text: string;
  files: string[];
  loaded: boolean;
}

/** The original as the peek shows it: from the loaded conversation, else the chip's quote. */
export function peekView(
  items: readonly ChatItem[] | undefined,
  reply: ChatReply,
  lead: string,
): PeekView {
  const item = items && findReplied(items, reply.id);
  if (!item) return { sender: reply.sender, text: reply.text, files: [], loaded: false };
  const split = item.kind === 'user' ? splitAttachmentText(item.text) : null;
  const files = split ? split.attachments : (item.attachments ?? []);
  return {
    sender: replySenderOf(item, lead),
    ...(item.at > 0 && { at: item.at }),
    text: split ? split.body : item.text,
    files: files.map((file) => file.name),
    loaded: true,
  };
}

/** The peek is the id of the reply it shows (null: closed); it follows the draft's reply. */
export type Peek = string | null;
export type PeekAction = 'open' | 'close' | 'jump';

/** One step: `jump` closes the peek and names the message to go to; nothing here
 *  touches the draft text or the reply, so closing never loses them. */
export function peekStep(
  reply: ChatReply | null,
  action: PeekAction,
): { peek: Peek; seek?: string } {
  if (!reply) return { peek: null };
  if (action === 'open') return { peek: reply.id };
  if (action === 'jump') return { peek: null, seek: reply.id };
  return { peek: null };
}

/** Whether the peek is showing: only for the reply it was opened on. */
export const peekShown = (peek: Peek, reply: ChatReply | null): boolean =>
  !!reply && peek === reply.id;
