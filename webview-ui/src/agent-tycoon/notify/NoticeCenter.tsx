/**
 * A4: the body of the 알림 window, composed like the GPT mock-up (specs/ui-mock-1104 gpt-3): tabs
 * with counts, a filter column (importance, kind, time) with 모두 확인 at its foot, a search and
 * sort bar, day or importance groups that fold, and each notice as a raised card (kind badge,
 * face, text, buttons). Every number is counted from the merged list; the column folds under the
 * tabs when the window is narrow (noticeCenter.css, a container query), so the phone's page shares it.
 */
import './noticeCenter.css';

import { type CSSProperties, Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { Button } from '../../components/ui/Button.js';
import { NOTICE_FACE_PX } from '../../constants.js';
import { getLanguage, t, type TranslationKey } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { ago } from '../auth/authApi.js';
import { chatTarget, requestChat } from '../chat.js';
import { useMessenger } from '../messenger/messengerStore.js';
import { useAgtyStore, virtualAgentId } from '../officeStore.js';
import {
  bodyOf,
  cardTone,
  countTime,
  EMPTY_QUERY,
  type Importance,
  IMPORTANCE_ORDER,
  IMPORTANCE_TONE,
  importanceOf,
  kindOf,
  NEWS_FILTERS,
  NEWS_KINDS,
  NEWS_TIMES,
  newsDay,
  type NewsFilter,
  type NewsItem,
  type NewsKind,
  type NewsQuery,
  type NewsTime,
  queryNews,
  sortNews,
} from './newsList.js';
import type { OpenTarget } from './NoticeLayer.js';
import { clearAll, markAllRead, markRead, type Notice, permissionOver } from './notices.js';

/** Material symbols: what each notice cause, importance, kind and time looks like. */
const CAUSE_GLYPH: Record<Notice['cause'], string> = {
  permission: 'lock',
  question: 'question_mark',
  turnEnd: 'notifications',
  job: 'flag',
  reply: 'chat_bubble',
};
const IMPORTANCE_GLYPH: Record<Importance, string> = {
  urgent: 'warning',
  important: 'priority_high',
  normal: 'info',
};
const IMPORTANCE_LABEL: Record<Importance, TranslationKey> = {
  urgent: 'noticesLook.urgent',
  important: 'noticesLook.important',
  normal: 'noticesLook.normal',
};
const KIND_GLYPH: Record<NewsKind, string> = {
  attention: 'lock',
  turnEnd: 'notifications',
  job: 'flag',
  reply: 'chat_bubble',
  system: 'settings',
};
/** The glyph of a card: its cause for asks and replies, its kind for a run or job that ended (no tool's own). */
const glyphOf = (item: NewsItem): string =>
  item.notice && item.notice.cause !== 'job'
    ? CAUSE_GLYPH[item.notice.cause]
    : KIND_GLYPH[kindOf(item)];
const KIND_SIDE_LABEL: Record<NewsKind, TranslationKey> = {
  attention: 'noticesLook.kindAttention',
  turnEnd: 'noticesNeutral.kindTurnEnd',
  job: 'noticesNeutral.kindJob',
  reply: 'noticesLook.kindReply',
  system: 'noticesLook.kindSystem',
};
const TIME_GLYPH: Record<NewsTime, string> = { today: 'schedule', week: 'date_range' };
const TIME_LABEL: Record<NewsTime, TranslationKey> = {
  today: 'noticesLook.timeToday',
  week: 'noticesLook.timeWeek',
};
const FILTER_EMPTY: Record<NewsFilter, TranslationKey> = {
  all: 'notice.emptyAll',
  attention: 'notice.emptyAttention',
  job: 'notice.emptyJob',
  chat: 'notice.emptyChat',
  system: 'notice.emptyAll',
};

const TAB_GLYPH: Record<NewsFilter, string> = {
  all: 'list',
  attention: 'warning',
  job: 'task_alt',
  chat: 'chat_bubble',
  system: 'settings',
};

const Glyph = ({ name, tone }: { name: string; tone?: string }) => (
  <span
    className="material-symbols-sharp nc-glyph"
    style={tone ? ({ color: tone } as CSSProperties) : undefined}
    aria-hidden="true"
  >
    {name}
  </span>
);

/** "일을 마쳤어요 · 메시지가 …": the first part is the title, the rest its description. */
function split(text: string): { title: string; note: string } {
  const at = text.indexOf(' · ');
  return at < 0
    ? { title: text, note: '' }
    : { title: text.slice(0, at), note: text.slice(at + 3) };
}

/** The sender's face in a pixel frame; no face: the kind itself fills the frame. */
function Face({ item, getOfficeState }: { item: NewsItem; getOfficeState: () => OfficeState }) {
  const n = item.notice;
  const ch = n && n.agentId !== null ? getOfficeState().characters.get(n.agentId) : undefined;
  return (
    <span className="nc-face" aria-hidden="true">
      {ch ? (
        <CharacterMugShot palette={ch.palette} hueShift={ch.hueShift} size={NOTICE_FACE_PX} />
      ) : (
        <Glyph name={glyphOf(item)} tone="var(--tone)" />
      )}
    </span>
  );
}

/** "3분 전" today; an earlier day's row says its clock time (the day is on the group above), with the date when `dated`. */
function whenOf(at: number, now: number, dated: boolean): string {
  if (newsDay(at, now) === 'today') return ago(at, now);
  return new Date(at).toLocaleString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US', {
    ...(dated ? { month: 'numeric', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Whether the element is drawn whole inside the list that scrolls it (true until measured, and where there is
 * no observer). A card at the list's edge is cut through by it; its buttons are then not drawn at all rather than
 * half (the 열기 / 읽음 row sat cut off at the bottom of the panel, owner 11-06 17:18). They come back whole as
 * soon as the card is scrolled in.
 */
function useWhole<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [whole, setWhole] = useState(true);
  useEffect(() => {
    const el = ref.current;
    const root = el?.closest('.nc-scroll') ?? null;
    if (!el || !root || typeof IntersectionObserver === 'undefined') return;
    const seen = new IntersectionObserver(([entry]) => setWhole(entry.intersectionRatio >= WHOLE_RATIO), {
      root,
      threshold: [0, WHOLE_RATIO, 1],
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return [ref, whole] as const;
}
/** A box counts as whole at this share (sub-pixel rounding keeps it a hair under 1). */
const WHOLE_RATIO = 0.98;

/** One card: a notice (read mark, opens its source) or an event (only expands). */
function NewsCard({
  item,
  now,
  dated,
  getOfficeState,
  onOpen,
  close,
}: {
  item: NewsItem;
  now: number;
  /** The groups are not days: an earlier row says its date too. */
  dated: boolean;
  getOfficeState: () => OfficeState;
  onOpen: OpenTarget;
  close: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [actRef, actWhole] = useWhole<HTMLDivElement>();
  const n = item.notice;
  const target = item.target;
  const goes = target !== undefined && target.open !== 'office';
  const unread = n !== undefined && !n.read;
  const importance = importanceOf(item);
  const { title, note: said } = split(bodyOf(item));
  // FIX-PERM-RESTART: a permission no longer waiting opens its terminal, not an empty conversation.
  const office = useAgtyStore().officeSnapshot;
  const orchestrators = office?.orchestrators ?? [];
  const contacts = useMessenger().contacts;
  const over = !!n && permissionOver(n, orchestrators, contacts);
  const row = over && target?.open === 'chat' ? orchestrators.find((o) => o.name === target.lead) : undefined;
  const rowId = row ? (row.agentId ?? virtualAgentId(`orch:${row.name}`)) : null;
  const where = rowId === null ? null : chatTarget(rowId, office); // ACP-1: no terminal, no 터미널에서 보기
  const terminal = rowId !== null && where?.kind === 'background' ? () => requestChat(rowId, where.id) : null;
  const note = over ? t('permNotice.over') : said;
  const open = () => {
    if (n) markRead(n.id);
    if (terminal) {
      close();
      terminal();
    } else if (goes) {
      close();
      onOpen(target);
    } else setExpanded((v) => !v);
  };
  return (
    <li className="nc-li" style={{ '--tone': cardTone(item) } as CSSProperties}>
      <div
        className="nc-card ui-card"
        data-unread={unread || undefined}
        data-importance={importance}
      >
        <span className="nc-badge" aria-hidden="true">
          <Glyph name={glyphOf(item)} />
          <span>{t(IMPORTANCE_LABEL[importance])}</span>
        </span>
        <button
          type="button"
          data-testid={n ? 'notice-item' : 'news-event'}
          data-read={n ? n.read : undefined}
          disabled={n ? !goes : false}
          aria-expanded={n ? undefined : expanded}
          className="nc-main"
          onClick={open}
        >
          <Face item={item} getOfficeState={getOfficeState} />
          <span className="nc-text">
            <span className="nc-line">
              <span className={`nc-title ${expanded ? 'is-open' : ''}`}>{title}</span>
              <span className="nc-when">{whenOf(item.at, now, dated)}</span>
            </span>
            {note && <span className={`nc-note ${expanded ? 'is-open' : ''}`}>{note}</span>}
            <span className="nc-meta">
              <span className="truncate">{item.name}</span>
              {unread && (
                <span
                  className="nc-dot"
                  role="img"
                  aria-label={t('noticeB.unreadMark')}
                  title={t('noticeB.unreadMark')}
                />
              )}
            </span>
          </span>
        </button>
        {(unread || goes) && (
          <div className="nc-act" ref={actRef} data-cut={actWhole ? undefined : ''}>
            {goes && (
              <Button size="sm" variant="accent" onClick={open}>
                {terminal ? t('permPrompt.terminal') : t('uiFix.noticeOpen')}
                <Glyph name={terminal ? 'terminal' : 'north_east'} />
              </Button>
            )}
            {unread && (
              <Button size="sm" data-testid="notice-mark-read" onClick={() => markRead(n.id)}>
                <Glyph name="check" />
                {t('uiFix.noticeRead')}
              </Button>
            )}
          </div>
        )}
        {expanded && item.detail && (
          <p className="nc-detail" data-testid="news-detail">
            {new Date(item.at).toLocaleString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US')} ·{' '}
            {item.detail}
          </p>
        )}
      </div>
    </li>
  );
}

interface Group {
  key: string;
  label: string;
  glyph: string;
  tone?: string;
  items: NewsItem[];
}

const dayLabel = (day: ReturnType<typeof newsDay>) =>
  day === 'today'
    ? t('noticeB.today')
    : day === 'yesterday'
      ? t('noticeB.yesterday')
      : new Date(day).toLocaleDateString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US', {
          month: 'short',
          day: 'numeric',
          weekday: 'short',
        });

function groupItems(items: NewsItem[], by: 'time' | 'importance', now: number): Group[] {
  const groups: Group[] = [];
  const add = (key: string, make: () => Omit<Group, 'key' | 'items'>, item: NewsItem) => {
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, ...make(), items: [item] });
  };
  for (const item of items) {
    if (by === 'importance') {
      const imp = importanceOf(item);
      add(
        imp,
        () => ({
          label: t(IMPORTANCE_LABEL[imp]),
          glyph: IMPORTANCE_GLYPH[imp],
          tone: IMPORTANCE_TONE[imp],
        }),
        item,
      );
    } else {
      const day = newsDay(item.at, now);
      add(String(day), () => ({ label: dayLabel(day), glyph: 'schedule' }), item);
    }
  }
  return groups;
}

function SideRow({
  glyph,
  tone,
  label,
  count,
  on,
  testId,
  onPick,
}: {
  glyph: string;
  tone?: string;
  label: string;
  count: number;
  on: boolean;
  testId: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className="nc-row ui-row"
      aria-current={on || undefined}
      data-testid={testId}
      onClick={onPick}
    >
      <Glyph name={glyph} tone={tone} />
      <span className="nc-row-label">{label}</span>
      <span className="nc-count">{count}</span>
    </button>
  );
}

export function NoticeCenter({
  news,
  now,
  getOfficeState,
  onOpen,
  onClose,
  phone = false,
}: {
  news: NewsItem[];
  now: number;
  getOfficeState: () => OfficeState;
  onOpen: OpenTarget;
  /** After a card opened where it came from: the window or page gives way. */
  onClose: () => void;
  /** The phone's page: the filters sit behind one button (a bottom sheet) and the head is the page's own. */
  phone?: boolean;
}) {
  const [query, setQuery] = useState<NewsQuery>(EMPTY_QUERY);
  const [sort, setSort] = useState<'time' | 'importance'>('time');
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const set = (patch: Partial<NewsQuery>) => setQuery((q) => ({ ...q, ...patch }));
  const toggle = <K extends 'importance' | 'kind' | 'time'>(key: K, value: NewsQuery[K]) =>
    set({ [key]: query[key] === value ? null : value } as Partial<NewsQuery>);

  const shown = useMemo(
    () => sortNews(queryNews(news, query, now), sort),
    [news, query, now, sort],
  );
  const groups = useMemo(() => groupItems(shown, sort, now), [shown, sort, now]);
  // Each facet's counts leave that facet out (what its row would show), the other filters kept.
  const counts = useMemo(() => {
    const imp = queryNews(news, query, now, 'importance');
    const kind = queryNews(news, query, now, 'kind');
    const time = queryNews(news, query, now, 'time');
    return {
      all: queryNews(news, { ...query, importance: null, kind: null, time: null }, now).length,
      importance: (v: Importance) => imp.filter((i) => importanceOf(i) === v).length,
      kind: (v: NewsKind) => kind.filter((i) => kindOf(i) === v).length,
      time: (v: NewsTime) => countTime(time, now, v),
    };
  }, [news, query, now]);
  const tabCount = (f: NewsFilter) => queryNews(news, { ...EMPTY_QUERY, tab: f }, now).length;
  const tabUnread = (f: NewsFilter) =>
    queryNews(news, { ...EMPTY_QUERY, tab: f }, now).filter((i) => i.notice && !i.notice.read)
      .length;
  const unread = news.filter((i) => i.notice && !i.notice.read).length;
  const filtered =
    query.importance !== null || query.kind !== null || query.time !== null || query.text !== '';

  const side = (
    <>
      <SideRow
        glyph="list"
        label={t('noticesLook.sideAll')}
        count={counts.all}
        on={!query.importance && !query.kind && !query.time}
        testId="notice-side-all"
        onPick={() => set({ importance: null, kind: null, time: null })}
      />
      <p className="nc-side-title">{t('noticesLook.byImportance')}</p>
      {IMPORTANCE_ORDER.map((v) => (
        <SideRow
          key={v}
          glyph={IMPORTANCE_GLYPH[v]}
          tone={IMPORTANCE_TONE[v]}
          label={t(IMPORTANCE_LABEL[v])}
          count={counts.importance(v)}
          on={query.importance === v}
          testId={`notice-side-importance-${v}`}
          onPick={() => toggle('importance', v)}
        />
      ))}
      <p className="nc-side-title">{t('noticesLook.byKind')}</p>
      {NEWS_KINDS.map((v) => (
        <SideRow
          key={v}
          glyph={KIND_GLYPH[v]}
          label={t(KIND_SIDE_LABEL[v])}
          count={counts.kind(v)}
          on={query.kind === v}
          testId={`notice-side-kind-${v}`}
          onPick={() => toggle('kind', v)}
        />
      ))}
      <p className="nc-side-title">{t('noticesLook.byTime')}</p>
      {NEWS_TIMES.map((v) => (
        <SideRow
          key={v}
          glyph={TIME_GLYPH[v]}
          label={t(TIME_LABEL[v])}
          count={counts.time(v)}
          on={query.time === v}
          testId={`notice-side-time-${v}`}
          onPick={() => toggle('time', v)}
        />
      ))}
    </>
  );

  const tabsEl = (
    <div
      role="group"
      aria-label={t('notice.filter')}
      className="ui-tabs nc-tabs"
      data-testid="notice-filters"
    >
      {NEWS_FILTERS.map((f) => {
        const on = query.tab === f.id;
        const fresh = tabUnread(f.id);
        return (
          <button
            key={f.id}
            type="button"
            aria-pressed={on}
            aria-selected={on}
            data-testid={`notice-filter-${f.id}`}
            className="ui-tab ui-raise"
            onClick={() => set({ tab: f.id })}
          >
            <span className="nc-tab-glyph">
              <Glyph name={TAB_GLYPH[f.id]} />
            </span>
            <span className="nc-tab-label">{t(f.label)}</span>
            <span
              className="nc-count"
              data-fresh={fresh > 0 || undefined}
              title={fresh > 0 ? t('noticeB.unread', { count: fresh }) : undefined}
            >
              {tabCount(f.id)}
            </span>
          </button>
        );
      })}
    </div>
  );
  const searchEl = (
    <label className="nc-search">
      <Glyph name="search" />
      <input
        type="search"
        className="ui-input"
        value={query.text}
        placeholder={t('noticesLook.search')}
        aria-label={t('noticesLook.searchLabel')}
        data-testid="notice-search"
        onChange={(e) => set({ text: e.target.value })}
      />
    </label>
  );
  const sortEl = (
    <select
      className="ui-input nc-sort"
      value={sort}
      aria-label={t('noticesLook.sortLabel')}
      data-testid="notice-sort"
      onChange={(e) => setSort(e.target.value as 'time' | 'importance')}
    >
      <option value="time">{t('noticesLook.sortTime')}</option>
      <option value="importance">{t('noticesLook.sortImportance')}</option>
    </select>
  );
  const footEl = (
    <div className="nc-foot">
      <Button size="sm" data-testid="notice-mark-all" disabled={unread === 0} onClick={markAllRead}>
        <Glyph name="done_all" />
        {t('notice.markAllRead')}
      </Button>
      <Button
        size="sm"
        data-testid="notice-clear-all"
        disabled={news.length === 0}
        onClick={() => clearAll()}
      >
        <Glyph name="delete_sweep" />
        {t('notice.clearAll')}
      </Button>
    </div>
  );
  const scrollEl = (
    <div className="nc-scroll">
      {shown.length === 0 ? (
        <div className="nc-empty" data-testid="notice-empty">
          <span className="ui-card-tile ui-card" aria-hidden="true">
            <Glyph name="notifications_paused" tone="var(--color-accent-text)" />
          </span>
          <p className="nc-empty-title">
            {filtered ? t('noticesLook.emptySearch') : t('noticeB.emptyTitle')}
          </p>
          <p className="nc-empty-note">
            {filtered ? t('noticesLook.emptySearchNote') : t(FILTER_EMPTY[query.tab])}
          </p>
          {filtered && (
            <Button size="sm" onClick={() => setQuery((q) => ({ ...EMPTY_QUERY, tab: q.tab }))}>
              {t('noticesLook.resetFilters')}
            </Button>
          )}
        </div>
      ) : (
        <ul className="nc-list" data-testid="notice-list">
          {groups.map((g) => {
            const open = !folded.has(g.key);
            const fresh = g.items.filter((i) => i.notice && !i.notice.read).length;
            return (
              <Fragment key={g.key}>
                <li role="presentation" className="nc-group-li">
                  <button
                    type="button"
                    className="nc-group"
                    aria-expanded={open}
                    title={t(open ? 'noticesLook.fold' : 'noticesLook.unfold')}
                    data-testid="notice-group"
                    style={g.tone ? ({ '--tone': g.tone } as CSSProperties) : undefined}
                    onClick={() =>
                      setFolded((s) => {
                        const next = new Set(s);
                        if (!next.delete(g.key)) next.add(g.key);
                        return next;
                      })
                    }
                  >
                    <Glyph name={open ? 'expand_more' : 'chevron_right'} />
                    <Glyph name={g.glyph} tone={g.tone} />
                    <span>{g.label}</span>
                    <span className="nc-count">{g.items.length}</span>
                    {fresh > 0 && <span className="nc-dot" aria-hidden="true" />}
                  </button>
                </li>
                {open &&
                  g.items.map((item) => (
                    <NewsCard
                      key={item.id}
                      item={item}
                      now={now}
                      dated={sort === 'importance'}
                      getOfficeState={getOfficeState}
                      onOpen={onOpen}
                      close={onClose}
                    />
                  ))}
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );

  if (phone) {
    // Default: newest first, nothing narrowed. The button says what narrows the list when it is not.
    const narrowed = filtered || query.tab !== 'all' || sort !== 'time';
    const tabLabel = t(NEWS_FILTERS.find((f) => f.id === query.tab)!.label);
    return (
      <div className="nc-center nc-phone">
        <div className="nc-phone-bar">
          <Button
            size="sm"
            className="nc-filter-btn"
            aria-expanded={filtersOpen}
            data-narrowed={narrowed || undefined}
            data-testid="notice-filters-toggle"
            onClick={() => setFiltersOpen(true)}
          >
            <Glyph name="tune" />
            {query.tab === 'all' ? t('noticesLook.filters') : tabLabel}
            {narrowed && (
              <span className="nc-dot" role="img" aria-label={t('noticesLook.narrowed')} />
            )}
          </Button>
        </div>
        <div className="nc-body">
          {scrollEl}
          {footEl}
        </div>
        {filtersOpen && (
          <>
            <button
              type="button"
              className="nc-sheet-back"
              aria-label={t('common.close')}
              onClick={() => setFiltersOpen(false)}
            />
            <aside
              className="nc-sheet"
              data-testid="notice-filter-sheet"
              aria-label={t('noticesLook.filters')}
            >
              <div className="nc-sheet-head">
                <strong>{t('noticesLook.filters')}</strong>
                <Button
                  size="sm"
                  data-testid="notice-filter-sheet-close"
                  onClick={() => setFiltersOpen(false)}
                >
                  {t('common.close')}
                </Button>
              </div>
              {tabsEl}
              <div className="nc-tools">
                {searchEl}
                {sortEl}
              </div>
              <nav className="nc-side" aria-label={t('noticesLook.filters')}>
                {side}
              </nav>
            </aside>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="nc-center" data-filters={filtersOpen ? 'open' : undefined}>
      {tabsEl}

      <div className="nc-body">
        <div className="nc-tools">
          {searchEl}
          {sortEl}
          <Button
            size="icon_md"
            className="nc-filter-toggle"
            aria-pressed={filtersOpen}
            aria-label={t('noticesLook.filters')}
            title={t('noticesLook.filters')}
            data-testid="notice-filters-toggle"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <Glyph name="tune" />
          </Button>
        </div>

        <nav className="nc-side" aria-label={t('noticesLook.filters')}>
          {side}
        </nav>

        {footEl}

        {scrollEl}
      </div>
    </div>
  );
}
