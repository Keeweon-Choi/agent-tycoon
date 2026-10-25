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
