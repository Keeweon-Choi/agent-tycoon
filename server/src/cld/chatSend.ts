/**
 * Chat's input (T-0014): what a well-formed chatSend / chatSendNow is, and the
 * text rules of a message to a lead. The engine messenger delivers it
 * (Office.chatSend).
 */
import { type Refused, refused } from '../../../core/src/cld/serverText.js';
import type {
  ChatCancel,
  ChatEdit,
  ChatHold,
  ChatSend,
  ChatSendNow,
} from '../../../core/src/messages.js';
import { replyRef } from './engine/messenger.js';

const REQUEST_ID_MAX = 128;
/** U-37: a long message goes in as itself up to here (Claude Code folds it into a paste placeholder); above, the webview attaches it. */
export const SEND_TEXT_MAX = 20_000;
/** Control characters but tab and newline: in a pasted message they would act as keys. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;

/** A well-formed chatSend, or null. */
export function parseChatSend(msg: Record<string, unknown>): ChatSend | null {
  const { requestId, name, text, now } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > REQUEST_ID_MAX) return null;
  if (typeof name !== 'string' || typeof text !== 'string') return null;
  if (now !== undefined && typeof now !== 'boolean') return null;
  // MSG-ACTIONS: a reply reference, made safe (replyRef); a malformed one refuses the message.
  const replyTo = msg.replyTo === undefined ? undefined : replyRef(msg.replyTo);
  if (msg.replyTo !== undefined && !replyTo) return null;
  return { type: 'chatSend', requestId, name, text, ...(now && { now }), ...(replyTo && { replyTo }) };
}

/** A well-formed chatSendNow, or null. */
export function parseChatSendNow(msg: Record<string, unknown>): ChatSendNow | null {
  const { requestId, name, id } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > REQUEST_ID_MAX) return null;
  if (typeof name !== 'string' || typeof id !== 'string' || id.length > REQUEST_ID_MAX) return null;
  return { type: 'chatSendNow', requestId, name, id };
}

/** A well-formed chatCancel, or null. */
export function parseChatCancel(msg: Record<string, unknown>): ChatCancel | null {
  const { requestId, name, id } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > REQUEST_ID_MAX) return null;
  if (typeof name !== 'string' || typeof id !== 'string' || id.length > REQUEST_ID_MAX) return null;
  return { type: 'chatCancel', requestId, name, id };
}

/** A well-formed chatEdit, or null. */
export function parseChatEdit(msg: Record<string, unknown>): ChatEdit | null {
  const { requestId, name, id, text } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > REQUEST_ID_MAX) return null;
  if (typeof name !== 'string' || typeof id !== 'string' || id.length > REQUEST_ID_MAX) return null;
  if (typeof text !== 'string') return null;
  return { type: 'chatEdit', requestId, name, id, text };
}

/** A well-formed chatHold, or null. */
export function parseChatHold(msg: Record<string, unknown>): ChatHold | null {
  const { name, id, on } = msg;
  if (typeof name !== 'string' || typeof id !== 'string' || id.length > REQUEST_ID_MAX)
    return null;
  if (typeof on !== 'boolean') return null;
  return { type: 'chatHold', name, id, on };
}

/** A chat message's own rules, or null when it may go. */
export function sendTextRefusal(text: string): Refused | null {
  if (!text.trim() || text.length > SEND_TEXT_MAX)
    return refused('send_text_length', { max: SEND_TEXT_MAX });
  if (CONTROL.test(text)) return refused('send_text_chars');
  return null;
}
