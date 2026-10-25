/**
 * T-0039: the notice toast (mounted once, at the app's top level) and the
 * 알림 icon's list and the notice settings. A tap on either marks
 * that notice read and opens where it came from (T-0043, the app's `onOpen`):
 * a lead's conversation in the messenger, the 작업 or Codex card, or the
 * character (selected and followed; on a phone, back to the office).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { Button } from '../../components/ui/Button.js';
import { NOTICE_TOAST_MS } from '../../constants.js';
import { getLanguage, t, type TranslationKey, useLanguage } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { transport } from '../../transport/index.js';
import { ago } from '../auth/authApi.js';
import { FloatingToast } from '../FloatingToast.js';
import { useCldStore } from '../officeStore.js';
import { filterNews, mergeNews, NEWS_FILTERS, type NewsFilter, type NewsItem } from './newsList.js';
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
      className="fixed left-1/2 -translate-x-1/2 top-[calc(var(--cld-safe-top)+72px)] z-[70] w-max max-w-[min(420px,calc(100vw-32px))] cursor-pointer text-left"
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
          <p className="text-sm text-text-muted">
            {t('notice.pushDescription')}
          </p>
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
      <p className="text-sm text-text-muted mt-8">
        {t('notice.cooldownNote')}
      </p>
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

/** One line of the list: a notice (read mark, opens its source) or an event (only expands, T-0070). */
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
  const label = n
    ? lineText(n)
    : item.text.startsWith(item.name)
      ? item.text
      : `${item.name} · ${item.text}`;
  return (
    <li>
      <button
        type="button"
        data-testid={n ? 'notice-item' : 'news-event'}
        data-read={n ? n.read : undefined}
        disabled={n ? !goes : false}
        aria-expanded={n ? undefined : expanded}
        className={`w-full flex items-center gap-8 px-4 py-4 text-left text-sm hover:bg-btn-hover ${n && !n.read ? 'text-text' : 'text-text-muted'}`}
        onClick={() => {
          if (n) markRead(n.id);
          if (goes) {
            close();
            onOpen(target);
          } else setExpanded((v) => !v);
        }}
      >
        {n ? (
          <Mug notice={n} getOfficeState={getOfficeState} />
        ) : (
          <span className="text-lg leading-none w-28 text-center" aria-hidden="true">
            {item.icon}
          </span>
        )}
        <span className={`flex-1 min-w-0 break-words ${expanded ? '' : 'line-clamp-1'}`}>
          {label}
        </span>
        <span className="shrink-0 text-xs text-text-muted">{ago(item.at, now)}</span>
      </button>
      {expanded && (
        <p
          className="px-4 pb-4 pl-40 text-xs text-text-muted break-words"
          data-testid="news-detail"
        >
          {new Date(item.at).toLocaleString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US')} · {item.detail}
        </p>
      )}
    </li>
  );
}

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
  /** When the panel opened: the list's "3분 전". */
  const [now] = useState(Date.now);
  return (
    <div className="flex flex-col min-h-0 flex-1 overflow-y-auto" data-testid="notice-panel">
      <div className={`flex justify-between items-center gap-8 ${inWindow ? '' : 'px-10 py-4'}`}>
        <strong className="text-sm">
          {view === 'list' ? t('notice.title') : t('notice.settings')}
        </strong>
        <span className="flex gap-8">
          {view === 'list' && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="notice-mark-all"
              disabled={unread === 0}
              onClick={markAllRead}
            >
              {t('notice.markAllRead')}
            </Button>
          )}
          {view === 'list' && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="notice-clear-all"
              disabled={news.length === 0}
              onClick={() => clearAll()}
            >
              {t('notice.clearAll')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            data-testid="notice-view-toggle"
            onClick={() => setView(view === 'list' ? 'settings' : 'list')}
          >
            {view === 'list' ? t('notice.settingsShort') : t('notice.list')}
          </Button>
        </span>
      </div>
      {view === 'settings' ? (
        <NoticeSettingsView />
      ) : (
        <>
          <div
            role="group"
            aria-label={t('notice.filter')}
            className={`flex flex-wrap gap-4 ${inWindow ? '' : 'px-10'} pb-4 pt-4`}
            data-testid="notice-filters"
          >
            {NEWS_FILTERS.map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={filter === f.id ? 'active' : 'default'}
                aria-pressed={filter === f.id}
                data-testid={`notice-filter-${f.id}`}
                onClick={() => setFilter(f.id)}
              >
                {t(f.label)}
              </Button>
            ))}
          </div>
          {shown.length === 0 ? (
            <p className={`${inWindow ? '' : 'px-10 pb-8'} text-sm text-text-muted max-w-[420px]`}>
              {t(FILTER_EMPTY[filter])}
            </p>
          ) : (
            <ul className={`${inWindow ? '' : 'px-6 pb-8'} grid gap-2`} data-testid="notice-list">
              {shown.map((item) => (
                <NewsRow
                  key={item.id}
                  item={item}
                  now={now}
                  getOfficeState={getOfficeState}
                  onOpen={onOpen}
                  close={onClose}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
