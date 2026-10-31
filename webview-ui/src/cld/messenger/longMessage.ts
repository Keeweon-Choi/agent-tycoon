import { t } from '../../i18n/index.js';

/** The preview's tail; the text reaches the agent, so it follows the UI language. */
export const longMessageSuffix = (): string => t('messenger.longMessageSuffix');
export const LONG_MESSAGE_SUMMARY_MAX = 200;

export interface LongMessageAttachment {
  name: string;
  content: string;
  type: 'text/markdown';
}

export interface PreparedMessage {
  text: string;
  attachment?: LongMessageAttachment;
}

/** Counts Unicode code points so an emoji is one character, like Hangul. */
export function messageCharacterCount(text: string): number {
  return Array.from(text).length;
}

export function longMessageFileName(at: Date): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `message-${at.getFullYear()}${part(at.getMonth() + 1)}${part(at.getDate())}-${part(at.getHours())}${part(at.getMinutes())}.md`;
}

/** Turns an oversized chat field into a small preview and a Markdown attachment. */
export function prepareMessage(text: string, max: number, at: Date = new Date()): PreparedMessage {
  if (messageCharacterCount(text) <= max) return { text };
  const firstLine = text.split(/\r\n?|\n/u, 1)[0] ?? '';
  const preview = Array.from(firstLine).slice(0, LONG_MESSAGE_SUMMARY_MAX).join('');
  return {
    text: `${preview}${longMessageSuffix()}`,
    attachment: { name: longMessageFileName(at), content: text, type: 'text/markdown' },
  };
}

/** A bubble longer than this many lines (or characters) folds behind 더 보기. */
export const FOLD_LINES = 12;
export const FOLD_CHARS = 1200;

/** A bubble's text, folded or open: `long` means it gets the 더 보기 / 접기 toggle; `shown` is
 *  the text to draw (cut with … while folded, whole when open). */
export function foldBubble(text: string, open: boolean): { long: boolean; shown: string } {
  const lines = text.split('\n');
  const long = lines.length > FOLD_LINES || text.length > FOLD_CHARS;
  return {
    long,
    shown: long && !open ? `${lines.slice(0, FOLD_LINES).join('\n').slice(0, FOLD_CHARS)}…` : text,
  };
}
