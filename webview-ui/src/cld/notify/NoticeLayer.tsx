/**
 * T-0039: the notice toast (mounted once, at the app's top level) and the
 * 알림 icon's list and the notice settings. A tap on either marks
 * that notice read and opens where it came from (T-0043, the app's `onOpen`):
 * a lead's conversation in the messenger, the 작업 or Codex card, or the
 * character (selected and followed; on a phone, back to the office).
 */
import { type CSSProperties, Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { Button } from '../../components/ui/Button.js';
import { NOTICE_FACE_PX, NOTICE_TOAST_MS } from '../../constants.js';
import { getLanguage, t, type TranslationKey, useLanguage } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { transport } from '../../transport/index.js';
import { ago } from '../auth/authApi.js';
import { FloatingToast } from '../FloatingToast.js';
import { useCldStore } from '../officeStore.js';
import { useNow } from '../workbench/workbenchStore.js';
import {
  filterNews,
  mergeNews,
  NEWS_FILTERS,
  newsDay,
  type NewsFilter,
  type NewsItem,
} from './newsList.js';
import {
  bindNoticeOffice,
  clearAll,
  dismissNoticeToast,
  KIND_LABEL,
  markAllRead,
  markRead,
  markReadFor,
  type Notice,
  NOTICE_ICON,
  noticeGoesTo,
  type NoticeKind,
  type NoticeTarget,
  setNoticeSettings,
  unreadCount,
  useNotices,
} from './notices.js';
import {
  listenForPushClicks,
  PUSH_HINT,
  pushSupport,
  resendPush,
  subscribePush,
  unsubscribePush,
} from './push.js';

const MUG_PX = 28;

/** Open a notice's target; false while it is not there yet (a push opened the page). */
export type OpenTarget = (target: NoticeTarget) => boolean;

function Mug({ notice, getOfficeState }: { notice: Notice; getOfficeState: () => OfficeState }) {
  const ch = notice.agentId === null ? undefined : getOfficeState().characters.get(notice.agentId);
  return ch ? (
    <CharacterMugShot palette={ch.palette} hueShift={ch.hueShift} size={MUG_PX} />
  ) : (
    <span className="text-lg leading-none w-28 text-center">{NOTICE_ICON[notice.cause]}</span>
  );
}

const lineText = (n: Notice) => `${NOTICE_ICON[n.cause]} ${n.name} · ${n.text}`;

/** The newest notice for a few seconds; a tap opens where it came from. */
export function NoticeToast({
  getOfficeState,
  onOpen,
}: {
  getOfficeState: () => OfficeState;
  onOpen: OpenTarget;
}) {
  const { toast } = useNotices();
  useEffect(() => {
    bindNoticeOffice(getOfficeState);
    return () => bindNoticeOffice(null);
  }, [getOfficeState]);
  // A push notification's click: its url, or the service worker's message. Listened for once:
  // `onOpen` changes with every render of the app, and each change used to tear the listener down
  // with the retries of a target the office had not loaded yet (the url was already cleaned from
  // the address, so nothing asked again and the character was never followed).
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  }, [onOpen]);
  useEffect(
    () =>
      listenForPushClicks((t) => {
        const opened = openRef.current(t);
        if (opened) markReadFor(t); // the notice it came from is read, as a tap in the app
        return opened;
      }),
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dismissNoticeToast(toast.id), NOTICE_TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <FloatingToast
      key={toast.id}
      testId="notice-toast"
      data-cause={toast.cause}
      data-agent-id={toast.agentId ?? undefined}
      className="w-max max-w-[min(420px,calc(100vw-32px))] cursor-pointer text-left"
      frameClassName="px-10 py-6 text-sm"
      onDismiss={() => dismissNoticeToast(toast.id)}
      onTap={() => {
        dismissNoticeToast(toast.id);
        markRead(toast.id);
        onOpen(noticeGoesTo(toast));
      }}
    >
      <div className="flex items-center gap-8" title={t('notice.open')}>
        <Mug notice={toast} getOfficeState={getOfficeState} />
        <span className="min-w-0 break-words">{lineText(toast)}</span>
      </div>
    </FloatingToast>
  );
}

function Row({
  label,
  note,
  on,
  onToggle,
}: {
  label: string;
  note?: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-16 py-4">
      <div className="flex-1 min-w-0">
        <p className="text-base">{label}</p>
        {note && <p className="text-sm text-text-muted">{note}</p>}
      </div>
      <Button
        size="sm"
        variant={on ? 'active' : 'default'}
        aria-pressed={on}
        aria-label={label}
        onClick={onToggle}
      >
        {on ? t('notice.on') : t('notice.off')}
      </Button>
    </div>
  );
}

const send = (msg: Parameters<typeof transport.send>[0]) => transport.send(msg);

/** 알림 받기 (Web Push): this device gets the notices while no page of it is showing. */
function PushRow() {
  const { push, settings } = useNotices();
  const language = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const support = pushSupport();
  const subscribed = push?.subscribed === true;
  // The kinds changed while subscribed: the daemon gets them (not on the first render).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (subscribed && support === 'ok') void resendPush(settings, send);
  }, [settings.kinds, settings.subagents, settings.remoteTurnEnds, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const hint =
    support !== 'ok'
      ? t(PUSH_HINT[support])
      : !push?.available
        ? t('notice.pushUnavailable')
        : null;
  return (
    <div className="mt-12 border-t border-border pt-8" data-testid="push-row">
      <div className="flex items-center gap-16 py-4">
        <div className="flex-1 min-w-0">
          <p className="text-base">{t('notice.push')}</p>
          <p className="text-sm text-text-muted">{t('notice.pushDescription')}</p>
        </div>
        <Button
          size="sm"
          variant={subscribed ? 'active' : 'default'}
          aria-pressed={subscribed}
          aria-label={t('notice.push')}
          disabled={busy || hint !== null}
          onClick={() => {
            setBusy(true);
            setError(null);
            const run = subscribed
              ? unsubscribePush(send)
              : subscribePush(push!.publicKey!, settings, send);
            run
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        >
          {subscribed ? t('notice.on') : t('notice.off')}
        </Button>
      </div>
      {(hint ?? error ?? push?.error) && (
        <p className="text-sm text-warning" data-testid="push-hint">
          {hint ?? error ?? push?.error}
        </p>
      )}
      {subscribed && (
        <Row
          label={t('notice.remoteControl')}
          note={t('notice.remoteControlNote')}
          on={settings.remoteTurnEnds}
          onToggle={() =>
            setNoticeSettings({ ...settings, remoteTurnEnds: !settings.remoteTurnEnds })
          }
        />
      )}
    </div>
  );
}

function NoticeSettingsView() {
  const { settings } = useNotices();
  const kinds = Object.keys(KIND_LABEL) as NoticeKind[];
  return (
    <div className="px-10 pb-8 max-w-[420px]" data-testid="notice-settings">
      <Row
        label={t('notice.sound')}
        on={settings.sound}
        onToggle={() => setNoticeSettings({ ...settings, sound: !settings.sound })}
      />
      <label className="flex items-center gap-12 py-4">
        <span className="text-base shrink-0">{t('notice.volume')}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(settings.volume * 100)}
          aria-label={t('notice.volume')}
          disabled={!settings.sound}
          className="flex-1 accent-accent"
          onChange={(e) => setNoticeSettings({ ...settings, volume: Number(e.target.value) / 100 })}
        />
      </label>
      <h3 className="text-xs text-text-muted mt-8 mb-2">{t('notice.notifyWhen')}</h3>
      {kinds.map((kind) => (
        <Row
          key={kind}
          label={t(KIND_LABEL[kind])}
          on={settings.kinds[kind]}
          onToggle={() =>
            setNoticeSettings({
              ...settings,
              kinds: { ...settings.kinds, [kind]: !settings.kinds[kind] },
            })
          }
        />
      ))}
      <Row
        label={t('notice.subagents')}
        note={t('notice.subagentsNote')}
        on={settings.subagents}
        onToggle={() => setNoticeSettings({ ...settings, subagents: !settings.subagents })}
      />
      <p className="text-sm text-text-muted mt-8">{t('notice.cooldownNote')}</p>
      <PushRow />
    </div>
  );
}

const FILTER_EMPTY: Record<NewsFilter, TranslationKey> = {
  all: 'notice.emptyAll',
  attention: 'notice.emptyAttention',
  job: 'notice.emptyJob',
  chat: 'notice.emptyChat',
};

/** NOTICE-B: each kind's accent (the unread bar, the badge, the dot), from the theme's status colours. */
const TONE = {
  attention: 'var(--color-status-permission)',
  done: 'var(--color-status-success)',
  job: 'var(--color-status-active)',
  reply: 'var(--color-accent-text)',
  bad: 'var(--color-danger)',
  quiet: 'var(--color-border)',
} as const;

function toneOf(item: NewsItem): string {
  const cause = item.notice?.cause;
  if (cause === 'permission' || cause === 'question') return TONE.attention;
  if (item.groups.includes('attention')) return TONE.bad; // a job that failed
  if (cause === 'turnEnd') return TONE.done;
  if (cause === 'reply' || item.groups.includes('chat')) return TONE.reply;
  return cause === 'job' || item.groups.includes('job') ? TONE.job : TONE.quiet;
}

/** The kind badge on a face: a Material symbol in the kind's tone (lock = waiting for permission, bell = done, ...). */
const CAUSE_GLYPH: Record<Notice['cause'], string> = {
  permission: 'lock',
  question: 'question_mark',
  turnEnd: 'notifications',
  job: 'flag',
  reply: 'chat_bubble',
};

/** A compact row action: one height for 확인 and 열기, 32 tall under a finger. A touch target is at
 *  least --cld-touch-min square: the width for real (min-w), the height an invisible ::before that
 *  reaches only up and down into the row's own padding, never sideways into the other button. */
const ROW_ACTION =
  "relative h-24 pointer-coarse:h-32 pointer-coarse:min-w-(--cld-touch-min) shrink-0 border-2 rounded-none px-8 text-xs leading-none whitespace-nowrap cursor-pointer pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:top-1/2 pointer-coarse:before:h-(--cld-touch-min) pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']";

/** The text without a leading "name ·" (events carry the name in their text; the meta line has it). */
const bodyOf = (item: NewsItem) =>
  item.text.startsWith(item.name)
    ? item.text.slice(item.name.length).replace(/^[\s·:]+/, '') || item.text
    : item.text;

/** The sender's face in a pixel frame with the kind badge; no face: the kind itself fills the frame. */
function Face({ item, getOfficeState }: { item: NewsItem; getOfficeState: () => OfficeState }) {
  const n = item.notice;
  const ch = n && n.agentId !== null ? getOfficeState().characters.get(n.agentId) : undefined;
  return (
    <span
      className="relative grid size-36 shrink-0 place-items-center border-2 border-border bg-bg-dark"
      aria-hidden="true"
    >
      {ch ? (
        <CharacterMugShot palette={ch.palette} hueShift={ch.hueShift} size={NOTICE_FACE_PX} />
      ) : n ? (
        <span className="material-symbols-sharp text-[18px] text-(--notice-tone)">
          {CAUSE_GLYPH[n.cause]}
        </span>
      ) : (
        <span className="text-xs leading-none">{item.icon}</span>
      )}
      {ch && n && (
        <span className="absolute -right-6 -bottom-6 grid size-16 place-items-center border-2 border-(--notice-tone) bg-bg-dark">
          <span className="material-symbols-sharp text-[10px] leading-none text-(--notice-tone)">
            {CAUSE_GLYPH[n.cause]}
          </span>
        </span>
      )}
    </span>
  );
}

/** "3분 전" today; an earlier day's row says its clock time (the day is on the separator above). */
function whenOf(at: number, now: number): string {
  if (newsDay(at, now) === 'today') return ago(at, now);
  return new Date(at).toLocaleTimeString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** One line of the list (layout B, owner 11-03): a notice (read mark, opens its source) or an event
 *  (only expands, T-0070). The message leads; who and when are one quiet line under it. */
function NewsRow({
  item,
  now,
  getOfficeState,
  onOpen,
  close,
}: {
  item: NewsItem;
  now: number;
  getOfficeState: () => OfficeState;
  onOpen: OpenTarget;
  close: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const n = item.notice;
  const target = item.target;
  const goes = target !== undefined && target.open !== 'office';
  const unread = n !== undefined && !n.read;
  const open = () => {
    if (n) markRead(n.id);
    if (goes) {
      close();
      onOpen(target);
    } else setExpanded((v) => !v);
  };
  return (
    <li
      className={`border-b-2 border-b-bg-dark border-l-2 ${unread ? 'border-l-(--notice-tone) bg-btn-bg/45' : 'border-l-transparent'}`}
      style={{ '--notice-tone': toneOf(item) } as CSSProperties}
    >
      <div className="flex items-center gap-8 py-8 pr-8 pl-10">
        <button
          type="button"
          data-testid={n ? 'notice-item' : 'news-event'}
          data-read={n ? n.read : undefined}
          disabled={n ? !goes : false}
          aria-expanded={n ? undefined : expanded}
          className="flex flex-1 min-w-0 items-center gap-12 py-2 text-left cursor-pointer disabled:cursor-default"
          onClick={open}
        >
          <Face item={item} getOfficeState={getOfficeState} />
          <span className="flex-1 min-w-0">
            <span
              className={`text-xs leading-tight break-words ${expanded ? 'block' : 'line-clamp-2'} ${unread ? 'text-text' : 'text-text/65'}`}
            >
              {bodyOf(item)}
            </span>
            <span className="mt-2 flex min-w-0 items-center gap-6 text-2xs leading-tight text-text-muted">
              <span className="truncate">{item.name}</span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{whenOf(item.at, now)}</span>
              {unread && (
                <span
                  className="size-6 shrink-0 bg-(--notice-tone)"
                  role="img"
                  aria-label={t('noticeB.unreadMark')}
                />
              )}
            </span>
          </span>
        </button>
        {unread && (
          <button
            type="button"
            data-testid="notice-mark-read"
            className={`${ROW_ACTION} border-border bg-transparent text-text-muted hover:bg-btn-hover hover:text-text`}
            onClick={() => markRead(n.id)}
          >
            {t('uiFix.noticeRead')}
          </button>
        )}
        {goes && (
          <button
            type="button"
            className={`${ROW_ACTION} border-accent bg-accent text-text hover:border-accent-bright hover:bg-accent-bright`}
            onClick={open}
          >
            {t('uiFix.noticeOpen')}
          </button>
        )}
      </div>
      {expanded && item.detail && (
        <p
          className="pr-8 pb-8 pl-58 text-2xs text-text-muted break-words"
          data-testid="news-detail"
        >
          {new Date(item.at).toLocaleString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US')} ·{' '}
          {item.detail}
        </p>
      )}
    </li>
  );
}

/** A day's heading in the list: "오늘", "어제", or the date. */
function DayLine({ day }: { day: ReturnType<typeof newsDay> }) {
  const label =
    day === 'today'
      ? t('noticeB.today')
      : day === 'yesterday'
        ? t('noticeB.yesterday')
        : new Date(day).toLocaleDateString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US', {
            month: 'short',
            day: 'numeric',
            weekday: 'short',
          });
  return (
    <li
      className="flex items-center gap-8 px-10 pt-12 pb-4 text-2xs text-text-muted"
      role="presentation"
    >
      <span className="shrink-0">{label}</span>
      <span className="h-2 flex-1 bg-border/50" />
    </li>
  );
}

/** A compact text action of the panel's header and the filter strip. */
const HEAD_ACTION =
  'h-24 pointer-coarse:h-32 px-6 text-xs leading-none whitespace-nowrap cursor-pointer text-text-muted hover:text-text disabled:cursor-default disabled:opacity-(--btn-disabled-opacity) disabled:hover:text-text-muted';

/** The 알림 list and the notice settings: the body of the 알림 window (desktop) and page (phone).
 *  Opening it reads nothing: a click on a notice reads that one, 모두 읽음 all (T-0043).
 *  Events are listed, never unread (T-0070). */
export function NoticePanel({
  getOfficeState,
  onOpen,
  onClose,
  inWindow = false,
}: {
  getOfficeState: () => OfficeState;
  onOpen: OpenTarget;
  /** After a row opened where it came from: the window or page gives way. */
  onClose: () => void;
  /** A desktop window: its body already carries the side and top padding (WINDOW_PAD). */
  inWindow?: boolean;
}) {
  const { items, clearedAt } = useNotices();
  const { events } = useCldStore();
  const [filter, setFilter] = useState<NewsFilter>('all');
  const news = useMemo(() => mergeNews(items, events, clearedAt), [items, events, clearedAt]);
  const shown = filterNews(news, filter);
  const [view, setView] = useState<'list' | 'settings'>('list');
  const unread = unreadCount(items);
  /** The list's "3분 전", ticking while the panel is open (it said 방금 for good, owner 10-26 12:53). */
  const now = useNow();
  const unreadIn = (f: NewsFilter) =>
    filterNews(news, f).filter((i) => i.notice !== undefined && !i.notice.read).length;
  const side = inWindow ? '' : 'px-10';
  return (
    <div className="flex flex-col min-h-0 flex-1 overflow-y-auto" data-testid="notice-panel">
      <div className={`flex justify-between items-center gap-8 ${inWindow ? '' : 'px-10 py-4'}`}>
        {/* The list's title is the window's or page's own (UI-FIX 5); only the settings view names itself. */}
        {view === 'settings' ? (
          <strong className="text-sm">{t('notice.settings')}</strong>
        ) : (
          <span
            className="flex min-w-0 items-center gap-6 text-xs text-text-muted"
            data-testid="notice-unread"
          >
            {unread > 0 && <span className="size-6 shrink-0 bg-accent-text" aria-hidden="true" />}
            <span className="truncate">
              {unread > 0 ? t('noticeB.unread', { count: unread }) : t('noticeB.allRead')}
            </span>
          </span>
        )}
        <span className="flex gap-4 ml-auto">
          {view === 'list' && (
            <button
              type="button"
              className={HEAD_ACTION}
              data-testid="notice-mark-all"
              disabled={unread === 0}
              onClick={markAllRead}
            >
              {t('notice.markAllRead')}
            </button>
          )}
          {view === 'list' && (
            <button
              type="button"
              className={HEAD_ACTION}
              data-testid="notice-clear-all"
              disabled={news.length === 0}
              onClick={() => clearAll()}
            >
              {t('notice.clearAll')}
            </button>
          )}
          <button
            type="button"
            className={HEAD_ACTION}
            data-testid="notice-view-toggle"
            onClick={() => setView(view === 'list' ? 'settings' : 'list')}
          >
            {view === 'list' ? t('notice.settingsShort') : t('notice.list')}
          </button>
        </span>
      </div>
      {view === 'settings' ? (
        <NoticeSettingsView />
      ) : (
        <>
          <div className={`${side} pt-4 pb-8`}>
            <div
              role="group"
              aria-label={t('notice.filter')}
              className="flex w-max max-w-full border-2 border-border bg-bg-dark"
              data-testid="notice-filters"
            >
              {NEWS_FILTERS.map((f) => {
                const on = filter === f.id;
                const count = f.id === 'all' ? 0 : unreadIn(f.id);
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={on}
                    data-testid={`notice-filter-${f.id}`}
                    className={`${HEAD_ACTION} flex items-center gap-4 border-l-2 border-border px-10 first:border-l-0 ${on ? 'bg-active-bg text-text' : 'hover:bg-btn-hover'}`}
                    onClick={() => setFilter(f.id)}
                  >
                    {t(f.label)}
                    {count > 0 && <span className="text-2xs text-accent-text">{count}</span>}
                  </button>
                );
              })}
            </div>
          </div>
          {shown.length === 0 ? (
            <div
              className={`${side} flex flex-col items-center gap-8 py-32 text-center`}
              data-testid="notice-empty"
            >
              <span
                className="grid size-48 place-items-center border-2 border-border bg-bg-dark shadow-pixel"
                aria-hidden="true"
              >
                <span className="material-symbols-sharp text-[24px] text-accent-text">
                  notifications_paused
                </span>
              </span>
              <p className="mt-4 text-sm text-text">{t('noticeB.emptyTitle')}</p>
              <p className="max-w-[300px] text-xs text-text-muted">{t(FILTER_EMPTY[filter])}</p>
            </div>
          ) : (
            <ul
              className={`${inWindow ? '' : 'pb-8'} border-t-2 border-bg-dark`}
              data-testid="notice-list"
            >
              {shown.map((item, i) => {
                const day = newsDay(item.at, now);
                const newDay = i === 0 || newsDay(shown[i - 1].at, now) !== day;
                return (
                  <Fragment key={item.id}>
                    {newDay && <DayLine day={day} />}
                    <NewsRow
                      item={item}
                      now={now}
                      getOfficeState={getOfficeState}
                      onOpen={onOpen}
                      close={onClose}
                    />
                  </Fragment>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
