/**
 * T-0070: the 알림 list is the one place for news. The notices (what the user
 * should know: unread marks, toasts, pushes) and the feed's events (start,
 * compaction, inbox, ...) merge into one time-ordered list. Events are only
 * ever listed: never unread, never a toast or a push. Pure.
 */
import type { NoticeTarget } from '../../../../core/src/cld/notices.js';
import { NOTICE_ICON } from '../../../../core/src/cld/notices.js';
import type { OfficeEvent } from '../../../../core/src/messages.js';
import type { TranslationKey } from '../../i18n/index.js';
import { serverLine } from '../serverText.js';
import { type Notice, noticeGoesTo } from './notices.js';

export type NewsFilter = 'all' | 'attention' | 'job' | 'chat';
export const NEWS_FILTERS: { id: NewsFilter; label: TranslationKey }[] = [
  { id: 'all', label: 'notice.filterAll' },
  { id: 'attention', label: 'notice.filterAttention' },
  { id: 'job', label: 'notice.filterJob' },
  { id: 'chat', label: 'notice.filterChat' },
];

export interface NewsItem {
  id: string;
  at: number;
  icon: string;
  /** Who: the character, or the event's name/source. */
  name: string;
  text: string;
  /** Notices only; an event has no read mark. */
  notice?: Notice;
  /** Where a tap goes; absent: it only expands. */
  target?: NoticeTarget;
  /** The event's kind and source, for the expanded line. */
  detail?: string;
  /** The filters (besides 전체) this item shows under. */
  groups: Exclude<NewsFilter, 'all'>[];
}

const EVENT_ICON: Record<string, string> = {
  inbox: '✉',
  job: '⚙',
  task: '⌘',
  hw: '▣',
  stop: '✓',
  renew: '↻',
  compaction: '▤',
  compacted: '▤',
  start: '▶',
  temp: '⌂',
};
export const eventIcon = (kind: string) =>
  EVENT_ICON[kind] ?? EVENT_ICON[kind.split('_')[0]] ?? '•';

const FAILED = /\uC2E4\uD328|\uC2DC\uAC04 \uCD08\uACFC/;
/** A finished job or Codex task that did not succeed (T-0068's wording). */
const failed = (text: string) => FAILED.test(text);

/** The same job end, seen twice: as a feed event and as the notice made from it. */
const NEWS_DUP_MS = 120_000;

function eventGroups(kind: string, summary: string): NewsItem['groups'] {
  const isJob = /^(job|codex|gpu)/.test(kind) || kind === 'stop';
  const bad = failed(summary) && (kind.endsWith('_end') || kind === 'orch_renew');
  if (bad) return isJob ? ['attention', 'job'] : ['attention'];
  if (isJob) return ['job'];
  return ['send', 'turn_end', 'inbox_deliver'].includes(kind) ? ['chat'] : [];
}

function noticeGroups(n: Notice): NewsItem['groups'] {
  if (n.cause === 'question' || n.cause === 'permission') return ['attention'];
  if (n.cause === 'job') return failed(n.text) ? ['attention', 'job'] : ['job'];
  return ['chat'];
}

function eventTarget(ev: OfficeEvent): NoticeTarget | undefined {
  if (ev.kind === 'job_end' || ev.kind === 'job_start')
    return ev.ref ? { open: 'job', id: ev.ref } : undefined;
  if (ev.kind === 'codex_end') return ev.ref ? { open: 'codex', id: ev.ref } : undefined;
  return undefined;
}

/** Plumbing of the owner's own messages (holding, editing, cancelling a queued one): never news.
 *  `token_guard` and `send_stuck` stay: a blocked input or a stuck pane is a defect the owner should see. */
export const QUEUE_NOISE: ReadonlySet<string> = new Set(['send_hold', 'send_edit', 'send_cancel', 'inbox_deliver']);

/** Feed rows that are not news: the owner's and the agents' sends (the conversation shows them) and the queue plumbing. */
export const isFeedNoise = (kind: string): boolean => kind === 'send' || QUEUE_NOISE.has(kind);

/** A job or Codex run starting: on the 현황판 and the off-duty sheet, not in the 알림 list (its end is the news). */
const START_KINDS: ReadonlySet<string> = new Set(['job_start', 'codex_start']);

const eventAt = (ev: OfficeEvent) => Date.parse(ev.ts) || 0;

/** `ev` is the feed's side of notice `n` (the same job end or turn end). */
function isTwin(n: Notice, ev: OfficeEvent): boolean {
  if (Math.abs(n.at - eventAt(ev)) >= NEWS_DUP_MS) return false;
  // NOTICE-DEDUP: a lead's reply stands for its turn end, in the feed too.
  if (n.cause === 'turnEnd' || n.cause === 'reply')
    return ev.kind === 'turn_end' && n.name === (ev.name ?? ev.source ?? 'engine');
  if (
    n.cause !== 'job' ||
    (ev.kind !== 'job_end' && ev.kind !== 'codex_end' && ev.kind !== 'orch_giveup')
  )
    return false;
  const id = n.target && 'id' in n.target ? n.target.id : null;
  return id && ev.ref ? id === ev.ref : serverLine(n.text) === serverLine(ev.summary);
}

export function mergeNews(
  notices: Notice[],
  events: OfficeEvent[],
  clearedAt: number | null = null,
): NewsItem[] {
  const items: NewsItem[] = notices.map((n) => ({
    id: `n:${n.id}`,
    at: n.at,
    icon: NOTICE_ICON[n.cause],
    name: n.name,
    text: n.text,
    notice: n,
    target: noticeGoesTo(n),
    groups: noticeGroups(n),
  }));
  // Each notice hides at most one event, its nearest twin: a job end inside the
  // notice cooldown, or a second turn end, had no notice and stays listed.
  const twins = new Set<number>();
  for (const n of notices) {
    let best = -1;
    for (const [i, ev] of events.entries()) {
      if (twins.has(i) || !isTwin(n, ev)) continue;
      const gap = (e: OfficeEvent) => Math.abs(eventAt(e) - n.at);
      if (best < 0 || gap(ev) < gap(events[best])) best = i;
    }
    if (best >= 0) twins.add(best);
  }
  for (const [i, ev] of events.entries()) {
    // Conversations already show sends; neither owner nor agent sends need a news row.
    if (twins.has(i) || isFeedNoise(ev.kind) || START_KINDS.has(ev.kind)) continue;
    const at = eventAt(ev);
    if (clearedAt !== null && at <= clearedAt) continue;
    const name = ev.name ?? ev.source ?? 'engine';
    items.push({
      // Not the position: a new event would shift every key and fold an opened row.
      id: `e:${ev.ts}:${ev.kind}:${ev.summary}`,
      at,
      icon: eventIcon(ev.kind),
      name,
      text: serverLine(ev.summary),
      target: eventTarget(ev),
      detail: ev.source && ev.source !== name ? `${ev.kind} · ${ev.source}` : ev.kind,
      groups: eventGroups(ev.kind, ev.summary),
    });
  }
  // Newest first; a stable sort keeps the store's order for equal times.
  return items.sort((a, b) => b.at - a.at);
}

export const filterNews = (items: NewsItem[], filter: NewsFilter): NewsItem[] =>
  filter === 'all' ? items : items.filter((i) => i.groups.includes(filter));
