import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MessengerContact } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { MESSENGER_SPLIT_MIN_PX, MSG_DELIVERED_BADGE_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { PixelIcon } from '../game/parts.js';
import { usePageStyle } from '../hud/hudStore.js';
import { useCldStore } from '../officeStore.js';
import { serverLine } from '../serverText.js';
import { WaitMark } from '../WaitMark.js';
import { Conversation } from './conversation/Conversation.js';
import { shownName } from './goneNames.js';
import { MessengerLooks } from './looksContext.js';
import {
  chatViewClosed,
  closeConversation,
  closeMessenger,
  closeMessengerPane,
  closeRoomTab,
  contactKey,
  conversationSections,
  focusMessengerPane,
  heldNote,
  openMessenger,
  roomKey,
  setMessengerLayout,
  setMessengerWide,
  showConversation,
  showMessengerList,
  showRoom,
  unreadCount,
  useMessenger,
} from './messengerStore.js';
import { PANE_LAYOUTS, panesShown, paneTarget } from './panes.js';
import { clock, type MessengerProps, Mug, PinButton, senderLabel, StateDot } from './parts.js';
import { GroupRooms, RoomConversation } from './rooms/GroupRooms.js';


/** Each open conversation's chatView, while the panel is up (the transport
 *  re-sends it after a reconnect). */
function Subscription({ agentId }: { agentId: number }) {
  useEffect(() => {
    transport.send({ type: 'chatView', agentId, on: true });
    return () => {
      transport.send({ type: 'chatView', agentId, on: false });
      chatViewClosed(agentId);
    };
  }, [agentId]);
  return null;
}

/**
 * The office messenger (T-0043). Desktop: a panel beside the office, the
 * contacts on the left and the open conversations as tabs (one readable
 * column; four side by side would leave each ~120 px). Phone: a page over the
 * office, the list, then a conversation with the open ones as chips.
 */
export function Messenger(props: MessengerProps) {
  const looks = useMemo(
    () => ({ getAppearance: props.getAppearance, statusFor: props.statusFor }),
    [props.getAppearance, props.statusFor],
  );
  return (
    <MessengerLooks.Provider value={looks}>
      <MessengerBody {...props} />
    </MessengerLooks.Provider>
  );
}

function MessengerBody({ mobile, visualViewportHeight, statusFor, getAppearance }: MessengerProps) {
  const m = useMessenger();
  const pageStyle = usePageStyle('messenger');
  const subs = m.open.map((id) => <Subscription key={id} agentId={id} />);
  const room = m.rooms.find((item) => item.id === m.activeRoom);
  const wideRef = useSplitWide();
  if (mobile) {
    return (
      <section
        aria-label={t('messenger.title')}
        className="absolute inset-x-0 top-0 bottom-0 z-50 bg-bg flex flex-col min-h-0 pl-(--cld-safe-left) pr-(--cld-safe-right)"
        style={pageStyle}
      >
        {subs}
        {m.active === null && !room ? (
          <>
            <header className="shrink-0 border-b-2 border-border px-12 py-8 flex items-center justify-between">
              <strong className="text-sm">{t('messenger.title')}</strong>
              {/* WINMODEL: the way home; the page is kept (a phone has no minimize and no close). */}
              <button
                type="button"
                className="text-xs border border-border px-8 py-4"
                onClick={closeMessenger}
              >
                {t('messenger.office')}
              </button>
            </header>
            <Contacts statusFor={statusFor} getAppearance={getAppearance} />
          </>
        ) : (
          <>
            <nav
              className="shrink-0 flex items-center gap-4 px-8 py-4 border-b border-border overflow-x-auto"
              aria-label={t('messenger.openConversations')}
            >
              <button
                type="button"
                className="shrink-0 text-xs border border-border px-8 py-4"
                onClick={showMessengerList}
              >
                {t('messenger.backToList')}
              </button>
              {m.open.map((id) => (
                <Tab key={id} agentId={id} chip />
              ))}
              {m.openRooms.map((id) => (
                <RoomTab key={id} roomId={id} chip />
              ))}
            </nav>
            {room ? (
              <RoomConversation key={room.id} room={room} />
            ) : (
              <Conversation
                key={m.active}
                agentId={m.active!}
                visualViewportHeight={visualViewportHeight}
                statusFor={statusFor}
                getAppearance={getAppearance}
              />
            )}
          </>
        )}
      </section>
    );
  }
  // T-0077: the window's title bar (HudWindow) carries the title and the × now.
  const shown = panesShown(m.split, m.splitWide);
  return (
    <section
      ref={wideRef}
      aria-label={t('messenger.title')}
      className="flex-1 min-h-0 flex flex-col border-2 border-border"
    >
      {subs}
      <div className="flex flex-1 min-h-0">
        <div className="w-[min(220px,34%)] shrink-0 border-r-2 border-border flex flex-col min-h-0">
          <Contacts statusFor={statusFor} getAppearance={getAppearance} />
        </div>
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {(m.splitWide || (m.open.length + m.openRooms.length > 0)) && (
            <div className="shrink-0 flex items-center gap-4 px-8 py-4 border-b border-border">
              {shown === 1 && (
                <nav
                  className="flex-1 min-w-0 flex gap-4 overflow-x-auto"
                  aria-label={t('messenger.openConversations')}
                >
                  {m.open.map((id) => (
                    <Tab key={id} agentId={id} />
                  ))}
                  {m.openRooms.map((id) => (
                    <RoomTab key={id} roomId={id} />
                  ))}
                </nav>
              )}
              {/* MSG-SPLIT: 1 · 2 · 2×2, only where the panes fit (never on the phone). */}
              {m.splitWide && (
                <div className="ml-auto shrink-0 flex gap-4" role="group" aria-label={t('msgSplit.layout')}>
                  {PANE_LAYOUTS.map((n) => (
                    <Button
                      key={n}
                      size="sm"
                      variant={m.split.layout === n ? 'active' : 'default'}
                      aria-pressed={m.split.layout === n}
                      data-testid={`split-layout-${n}`}
                      onClick={() => setMessengerLayout(n)}
                    >
                      {t(`msgSplit.layout${n}`)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
          {shown > 1 ? (
            <div
              className={`flex-1 min-h-0 grid grid-cols-2 ${shown === 4 ? 'grid-rows-2' : 'grid-rows-1'}`}
            >
              {m.split.panes.slice(0, shown).map((key, i) => (
                <Pane
                  key={i}
                  index={i}
                  convKey={key}
                  focused={m.split.focus === i}
                  visualViewportHeight={visualViewportHeight}
                  statusFor={statusFor}
                  getAppearance={getAppearance}
                />
              ))}
            </div>
          ) : m.active === null && !room ? (
            <p className="text-sm text-text-muted p-12">{t('messenger.chooseLead')}</p>
          ) : room ? (
            <RoomConversation key={room.id} room={room} />
          ) : (
            <Conversation
              key={m.active}
              agentId={m.active!}
              visualViewportHeight={visualViewportHeight}
              statusFor={statusFor}
              getAppearance={getAppearance}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/** MSG-SPLIT: whether the desktop messenger is wide enough for panes; reported to the store
 *  (resize events only, no polling), and false again when it leaves the screen. */
function useSplitWide() {
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => setMessengerWide(false), []);
  return useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    observer.current = new ResizeObserver(() =>
      setMessengerWide(el.clientWidth >= MESSENGER_SPLIT_MIN_PX),
    );
    observer.current.observe(el);
  }, []);
}

/** MSG-SPLIT: one pane: the single conversation view of its lead or room, or a hint when empty.
 *  A press or focus inside gives it the focus (the accent border). */
function Pane({
  index,
  convKey,
  focused,
  visualViewportHeight,
  statusFor,
  getAppearance,
}: { index: number; convKey: string | null; focused: boolean } & Omit<MessengerProps, 'mobile'>) {
  const m = useMessenger();
  const target = paneTarget(convKey, m.contacts, m.rooms);
  const room = target && 'room' in target ? m.rooms.find((r) => r.id === target.room) : undefined;
  const close = () => closeMessengerPane(index);
  const take = () => {
    if (!focused) focusMessengerPane(index);
  };
  return (
    <div
      className={`min-w-0 min-h-0 flex flex-col border-2 ${focused ? 'border-accent' : 'border-border'}`}
      data-testid={`split-pane-${index}`}
      data-focused={focused || undefined}
      onPointerDownCapture={take}
      onFocusCapture={take}
    >
      {room ? (
        <RoomConversation key={room.id} room={room} onClose={close} />
      ) : target && 'agentId' in target ? (
        <Conversation
          key={target.agentId}
          agentId={target.agentId}
          visualViewportHeight={visualViewportHeight}
          statusFor={statusFor}
          getAppearance={getAppearance}
          onClose={close}
        />
      ) : (
        <p className="text-sm text-text-muted p-12">{t('msgSplit.emptyPane')}</p>
      )}
    </div>
  );
}

function Contacts({ statusFor, getAppearance }: Omit<MessengerProps, 'mobile'>) {
  const m = useMessenger();
  const { officeReadOnly, officeSnapshot } = useCldStore();
  const { direct: sorted, workers } = conversationSections(m.contacts, m.rooms, m.pinned);
  if (!sorted.length && !m.rooms.length)
    return <p className="text-sm text-text-muted p-12">{t('messenger.noLeads')}</p>;
  const row = (c: MessengerContact, nested = false) => {
    const unread = unreadCount(c.replies, m.read[c.name]);
    // MSG-HOLD2: edits left held show here too, so a forgotten one cannot hide in its chat.
    const heldEdits =
      officeSnapshot?.orchestrators.find((o) => o.agentId === c.agentId)?.heldEdits ?? 0;
    return (
      <li key={c.agentId} className="flex items-stretch border-b border-border">
        <button
          type="button"
          className={`flex-1 min-w-0 flex items-center gap-8 ${nested ? 'pl-24 pr-8' : 'px-8'} py-6 text-left hover:bg-btn-hover ${m.active === c.agentId ? 'bg-active-bg' : ''}`}
          aria-label={`${shownName(c.name)}${unread ? t('messenger.unread', { count: unread }) : ''}`}
          onClick={() => openMessenger(c.agentId)}
        >
          <span className="shrink-0 flex">
            <Mug agentId={c.agentId} getAppearance={getAppearance} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-4 min-w-0">
              <StateDot agentId={c.agentId} statusFor={statusFor} />
              <strong className="text-sm truncate">{shownName(c.name)}</strong>
              <WaitMark agentId={c.agentId} />
              <RowTime lastAt={c.lastAt} delivered={m.delivered[c.agentId]} />
            </span>
            <span className="flex items-center gap-4 min-w-0">
              <span
                className={`text-xs truncate flex-1 min-w-0 ${c.held ? 'text-accent-text' : 'text-text-muted'}`}
              >
                {c.held
                  ? heldNote()
                  : c.preview
                    ? `${senderLabel(c)}${serverLine(c.preview)}`
                    : t('uiaudit.noChat')}
              </span>
              {heldEdits > 0 && (
                <span
                  className="shrink-0 text-2xs px-4 border border-accent text-accent-text"
                  data-testid="held-edits"
                >
                  {t('messenger.heldEdits', { count: heldEdits })}
                </span>
              )}
              {unread > 0 && (
                <span className="shrink-0 text-2xs px-4 bg-danger text-text">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </span>
          </span>
        </button>
        <PinButton
          id={contactKey(c)}
          pinned={m.pinned.includes(contactKey(c))}
          readOnly={officeReadOnly}
          className=""
        />
      </li>
    );
  };
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <GroupRooms />
      {sorted.length > 0 && (
        <h2 className="px-8 py-6 text-xs font-bold border-b border-border">
          {t('messenger.directChats')}
        </h2>
      )}
      <ul aria-label={t('messenger.contacts')}>
        {sorted.flatMap((c) => {
          const team = workers[c.name];
          return [
            row(c),
            ...(team
              ? [
                  // D3 (F-7): a project's Workers, an advanced chat, collapsed under it.
                  <li key={`workers:${c.name}`}>
                    <details data-testid={`workers-${c.name}`}>
                      <summary className="pl-24 pr-8 py-4 text-xs text-text-muted border-b border-border cursor-pointer">
                        {t('messenger.workers', { count: team.length })}
                      </summary>
                      <ul>{team.map((w) => row(w, true))}</ul>
                    </details>
                  </li>,
                ]
              : []),
          ];
        })}
      </ul>
    </div>
  );
}

/** A row's time, or (GAME-UI-1 G1, 04) ✓ 전달됨 popping in for MSG_DELIVERED_BADGE_MS after a confirmed
 *  delivery, then the time again (one timer, no polling). */
function RowTime({ lastAt, delivered }: { lastAt?: number; delivered?: number }) {
  const [shownFor, setShownFor] = useState<number | undefined>(undefined);
  useEffect(() => {
    const left = delivered === undefined ? 0 : delivered + MSG_DELIVERED_BADGE_MS - Date.now();
    if (left <= 0) return;
    setShownFor(delivered);
    const id = window.setTimeout(() => setShownFor(undefined), left);
    return () => window.clearTimeout(id);
  }, [delivered]);
  if (shownFor !== undefined && shownFor === delivered)
    return (
      <span className="mail-badge ml-auto shrink-0 text-2xs" data-testid="delivered-badge">
        <PixelIcon name="check" size={12} />
        {t('game.msg.delivered')}
      </span>
    );
  return lastAt ? <span className="ml-auto shrink-0 text-2xs text-text-muted">{clock(lastAt)}</span> : null;
}

function Tab({ agentId }: { agentId: number; chip?: boolean }) {
  const m = useMessenger();
  const c = m.contacts.find((x) => x.agentId === agentId);
  const name = c ? shownName(c.name) : `#${agentId}`;
  const unread = c ? unreadCount(c.replies, m.read[c.name]) : 0;
  const on = m.active === agentId;
  return (
    <span
      className={`shrink-0 flex items-center border text-xs ${on ? 'border-accent text-accent-text' : 'border-border text-text-muted'}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={on}
        className="self-stretch px-8 max-w-[140px] truncate"
        onClick={() => showConversation(agentId)}
      >
        {name}
        {unread > 0 && ` (${unread})`}
      </button>
      <Button
        size="icon_md"
        variant="ghost"
        aria-label={t('messenger.closeConversation', { name })}
        onClick={() => closeConversation(agentId)}
      >
        ×
      </Button>
    </span>
  );
}

/** MSG-UI2: a room kept in the tab row (a room left for the list stays here, minimized). */
function RoomTab({ roomId }: { roomId: string; chip?: boolean }) {
  const m = useMessenger();
  const room = m.rooms.find((x) => x.id === roomId);
  if (!room) return null;
  const on = m.activeRoom === roomId;
  const unread = unreadCount(room.updates ?? [], m.read[roomKey(room)]);
  return (
    <span
      className={`shrink-0 flex items-center border text-xs ${on ? 'border-accent text-accent-text' : 'border-border text-text-muted'}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={on}
        data-testid={`room-tab-${roomId}`}
        className="self-stretch px-8 max-w-[140px] truncate"
        onClick={() => showRoom(roomId)}
      >
        {serverLine(room.name)}
        {unread > 0 && ` (${unread})`}
      </button>
      <Button
        size="icon_md"
        variant="ghost"
        aria-label={t('messenger.closeRoom', { name: serverLine(room.name) })}
        onClick={() => closeRoomTab(roomId)}
      >
        ×
      </Button>
    </span>
  );
}
