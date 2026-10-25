import type { ChatItem } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';

/** Within this many px of the bottom the list counts as at the bottom (the
 *  last pixels of a smooth scroll). */
export const BOTTOM_SLACK_PX = 48;

interface Metrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** At the bottom (within the slack). */
export function atBottom(m: Metrics): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= BOTTOM_SLACK_PX;
}

/** Messages that arrived after `seenId` (the newest the reader had in view): the agent's
 *  replies only, the unread count's rule (contact.replies). The boss's own lines (one turning
 *  from 보내는 중 into 보냄 included), notices and tool lines are not new messages.
 *  0 when `seenId` is unknown. */
export function newSince(items: readonly ChatItem[], seenId: string | undefined): number {
  const at = seenId === undefined ? -1 : items.findIndex((i) => i.id === seenId);
  return at < 0 ? 0 : items.slice(at + 1).filter((i) => i.kind === 'assistant').length;
}

/** The button's label: "↓", or a clear count of new messages. */
export function jumpLabel(count: number): string {
  return count > 0 ? t('messenger.newMessages', { count: count > 99 ? '99+' : count }) : '↓';
}
