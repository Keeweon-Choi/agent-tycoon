import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type {
  ChatItem,
  ChatReply,
  ChatSearchHit,
  GroupPostItem,
  GroupRoom,
  MessengerContact,
  OfficeOrchestrator,
  SlashCommand,
} from '../../../../core/src/messages.js';
import type { AgentAppearance, TabStatus } from '../../components/AgentCard.js';
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { Button } from '../../components/ui/Button.js';
import { ATTACH_ACCEPT, JUMP_WAIT_MS, MESSAGE_ACTIONS_LONG_PRESS_MS } from '../../constants.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { t } from '../../i18n/index.js';
import { writeClipboardText } from '../../terminal/clipboard.js';
import { withinTapSlop } from '../../touch/touchPrimitives.js';
import { transport } from '../../transport/index.js';
import { CHAT_SEND_MAX, chatTarget, readOnlyNote, requestChat } from '../chat.js';
import { useEngineStore } from '../engineStore.js';
import { FatigueBar } from '../ez/Fatigue.js';
import { contextPct } from '../ez/fatigueState.js';
import { rootFileTicket } from '../files/filesStore.js';
import { TerminalGlyph } from '../hud/glyphs.js';
import { usePageStyle } from '../hud/hudStore.js';
import { HighlightedText, Markdown } from '../markdown.js';
import { FOCUS_MS } from '../notify/openTarget.js';
import { presenceOf } from '../officeHours.js';
import { cldToast, ezContext, fatigueFor, useCldStore, virtualAgentId } from '../officeStore.js';
import { serverLine, serverText } from '../serverText.js';
import { useStaff } from '../staff.js';
import { requestStaleRecheck } from '../staleBuild.js';
import {
  ATTACHMENT_ACTION_ERROR_DURATION,
  ATTACHMENT_ACTION_SUCCESS_DURATION,
} from './attachmentActions.js';
import {
  draftPath,
  draftViewerFiles,
  useAttachmentTarget,
  useDraftTicketFor,
  useOpenAttachment,
  useTicketFor,
  type ViewerFile,
} from './attachmentGallery.js';
import {
  type AttachmentChip,
  composeAttachmentText,
  fileChip,
  MAX_ATTACHMENTS,
  splitAttachmentText,
  updateChip,
  uploadAttachment,
} from './attachments.js';
import { AttachmentGallery } from './AttachmentViewer.js';
import { keepPhoneComposerFocus } from './composerFocus.js';
import { composerHeight } from './composerGrow.js';
import { FACE_COLUMN, FACE_GAP, FACE_GUTTER_LEFT, FACE_GUTTER_RIGHT, OwnerFace, SenderFace } from './Faces.js';
import { messageCharacterCount, prepareMessage } from './longMessage.js';
import { MessengerLooks } from './looksContext.js';
import {
  copyText,
  findReplied,
  replyChipText,
  replyDraft,
  replyIdOf,
  replySenderOf,
} from './messageActions.js';
import {
  chatViewClosed,
  clearPendingJump,
  closeConversation,
  closeMessenger,
  closeRoomTab,
  contactKey,
  conversationSections,
  dismissSend,
  dividerAfter,
  draftKey,
  heldNote,
  jumpStep,
  jumpTarget,
  leadPresence,
  type LeadState,
  leadState,
  loadDraft,
  loadDraftReply,
  MAX_ITEMS,
  messengerApproveHeld,
  messengerCancel,
  messengerEditEnter,
  messengerEditLeave,
  messengerEditLostClear,
  messengerEditPark,
  messengerEditSave,
  messengerPin,
  messengerSend,
  messengerSendNow,
  openMessenger,
  type PendingSend,
  requestHistory,
  requestSearch,
  roomCandidates,
  roomKey,
  saveDraft,
  saveDraftReply,
  sendLabel,
  setAttachments,
  setGroupAttachments,
  setJumpLoading,
  showConversation,
  showMessengerList,
  showRoom,
  unreadCount,
  useMessenger,
} from './messengerStore.js';
import { PermissionCard } from './PermissionCard.js';
import {
  canonicalizeMentions,
  chooseMention,
  filterMentions,
  mentionAt,
  mentionDisplay,
  replyPrefill,
} from './roomMentions.js';
import { atBottom, jumpLabel, newSince } from './scrollJump.js';
import { isHidden, mayFetchOlder, restoreTop } from './scrollRestore.js';
import { stepSearchResult } from './searchMatch.js';
import { noticeEmployee, noticeName, senderKey, shellDone, startsRun } from './senderFace.js';
import { chordStep, enterSends, enterSendsNow, isTouchDevice } from './sendKey.js';
import { filterSlashCommands, slashComplete, slashMenuKey } from './slashMenu.js';
import { toolLineLabel } from './toolLine.js';
import { useKeepPlace } from './useKeepPlace.js';

/** A reply longer than this many lines folds (더 보기). */
const FOLD_LINES = 12;
const FOLD_CHARS = 1200;
const MUG_PX = 32;
const NO_CHIPS: AttachmentChip[] = [];
let requestSeq = 0;
const nextRequestId = () => `history-${++requestSeq}`;

interface MessengerProps {
  mobile: boolean;
  /** The visual viewport height on a phone; changes while its keyboard animates. */
  visualViewportHeight?: number | null;
  /** The terminal drawer's per-agent activity (working / attention / idle). */
  statusFor: (agentId: number) => TabStatus | null;
  getAppearance: (agentId: number) => AgentAppearance;
}

/** The officeState row of a lead (an engine project or Claude session). */
function useRow(agentId: number): OfficeOrchestrator | undefined {
  const { officeSnapshot: officeState } = useCldStore();
  return officeState?.orchestrators.find(
    (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === agentId,
  );
}

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

function RoomSubscription({ roomId }: { roomId: string }) {
  useEffect(() => {
    transport.send({ type: 'groupView', room: roomId, on: true });
    return () => transport.send({ type: 'groupView', room: roomId, on: false });
  }, [roomId]);
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
  return (
    <section
      aria-label={t('messenger.title')}
      className="flex-1 min-h-0 flex flex-col border-2 border-border"
    >
      {subs}
      <div className="flex flex-1 min-h-0">
        <div className="w-[min(220px,34%)] shrink-0 border-r-2 border-border flex flex-col min-h-0">
          <Contacts statusFor={statusFor} getAppearance={getAppearance} />
        </div>
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {m.open.length + m.openRooms.length > 0 && (
            <nav
              className="shrink-0 flex gap-4 px-8 py-4 border-b border-border overflow-x-auto"
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
          {m.active === null && !room ? (
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
          aria-label={`${c.name}${unread ? t('messenger.unread', { count: unread }) : ''}`}
          onClick={() => openMessenger(c.agentId)}
        >
          <Mug agentId={c.agentId} getAppearance={getAppearance} />
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-4 min-w-0">
              <StateDot agentId={c.agentId} statusFor={statusFor} />
              <strong className="text-sm truncate">{c.name}</strong>
              {c.lastAt ? (
                <span className="ml-auto shrink-0 text-2xs text-text-muted">{clock(c.lastAt)}</span>
              ) : null}
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

/** U-30: the 즐겨찾기 toggle of one conversation row; a read-only client only sees the star. */
function PinButton({
  id,
  pinned,
  readOnly,
  className,
}: {
  id: string;
  pinned: boolean;
  readOnly: boolean;
  className: string;
}) {
  if (readOnly && !pinned) return null;
  return (
    <Button
      size="icon_md"
      variant="ghost"
      className={`self-center mx-2 ${pinned ? 'text-accent-text!' : ''} ${className}`}
      aria-label={t(pinned ? 'messenger.unpin' : 'messenger.pin')}
      aria-pressed={pinned}
      title={t(pinned ? 'messenger.unpin' : 'messenger.pin')}
      disabled={readOnly}
      onClick={() => messengerPin((msg) => transport.send(msg), id, !pinned)}
    >
      {pinned ? '★' : '☆'}
    </Button>
  );
}

/** Room records are deliberately fetched only when expanded, like transcripts. */
function GroupRooms() {
  const m = useMessenger();
  const { officeReadOnly } = useCldStore();
  const [creating, setCreating] = useState(false);
  return (
    <section className="border-b-2 border-border" aria-label={t('messenger.rooms')}>
      <div className="px-8 py-6 flex items-center gap-4">
        <h2 className="flex-1 text-xs font-bold">{t('messenger.rooms')}</h2>
        {!officeReadOnly && (
          <Button size="sm" onClick={() => setCreating((open) => !open)}>
            {t('messenger.createRoom')}
          </Button>
        )}
      </div>
      {creating && !officeReadOnly && (
        <RoomEditor
          members={roomCandidates(m.rooms, m.contacts)}
          title={t('messenger.newRoom')}
          submit={(name, members) => {
            transport.send({
              type: 'groupAction',
              requestId: `group-create-${Date.now()}`,
              action: 'create',
              name,
              members,
            });
            setCreating(false);
          }}
          cancel={() => setCreating(false)}
        />
      )}
      {m.groupError && !m.groupError.requestId.startsWith('group-post-') && (
        <p role="alert" className="px-8 pb-6 text-xs text-danger">
          {m.groupError.error}
        </p>
      )}
      <ul aria-label={t('messenger.roomList')}>
        {conversationSections(m.contacts, m.rooms, m.pinned).groups.map((room) => {
          const unread = unreadCount(room.updates ?? [], m.read[`room:${room.id}`]);
          return (
            <li key={room.id} className="flex items-stretch border-t border-border">
              <button
                type="button"
                data-testid={`group-room-row-${room.id}`}
                className={`flex-1 min-w-0 flex items-center gap-8 px-8 py-6 text-left hover:bg-btn-hover ${m.activeRoom === room.id ? 'bg-active-bg' : ''}`}
                aria-label={`${serverLine(room.name)}${unread ? t('messenger.unread', { count: unread }) : ''}`}
                onClick={() => showRoom(room.id)}
              >
                <span
                  className="shrink-0 border border-border px-6 py-4 text-xs"
                  aria-hidden="true"
                >
                  #
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex gap-4">
                    <strong className="text-sm truncate min-w-0">{serverLine(room.name)}</strong>
                    <span
                      className="shrink-0 whitespace-nowrap text-xs text-text-muted"
                      title={t('messenger.memberPillLabel', { count: room.members.length })}
                    >
                      {t('messenger.memberPill', { count: room.members.length })}
                    </span>
                    {room.lastAt && (
                      <span className="ml-auto text-2xs text-text-muted">{clock(room.lastAt)}</span>
                    )}
                  </span>
                  <span className="flex gap-4">
                    <span className="text-xs text-text-muted truncate flex-1">
                      {room.preview ? serverLine(room.preview) : t('uiaudit.noChat')}
                    </span>
                    {unread > 0 && (
                      <span className="shrink-0 text-2xs px-4 bg-danger text-text">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
              <PinButton
                id={roomKey(room)}
                pinned={m.pinned.includes(roomKey(room))}
                readOnly={officeReadOnly}
                className=""
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RoomConversation({ room }: { room: GroupRoom }) {
  const { rooms, contacts } = useMessenger();
  const allMembers = roomCandidates(rooms, contacts);
  const { list, content, onScroll } = useKeepPlace();
  const [showMembers, setShowMembers] = useState(false);
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid={`group-room-screen-${room.id}`}>
      <RoomSubscription roomId={room.id} />
      <header className="shrink-0 border-b border-border px-8 py-6 flex items-center gap-8 min-w-0">
        <strong className="text-sm truncate min-w-0">{serverLine(room.name)}</strong>
        {/* MSG-UI2: one pill with the head count; it opens the member list below and closes it again. */}
        <Button
          size="sm"
          variant={showMembers ? 'active' : 'default'}
          aria-expanded={showMembers}
          aria-label={t('messenger.memberPillLabel', { count: room.members.length })}
          data-testid="member-pill"
          onClick={() => setShowMembers((v) => !v)}
        >
          {t('messenger.memberPill', { count: room.members.length })}
        </Button>
      </header>
      {showMembers && <RoomMemberList members={room.members} />}
      <div
        ref={list}
        onScroll={onScroll}
        data-testid="room-scroll"
        className="flex-1 min-h-0 overflow-y-auto"
      >
        <div ref={content}>
          <GroupRoomRow room={room} allMembers={allMembers} />
        </div>
      </div>
    </div>
  );
}

/** MSG-UI2: the room's members one under the other, as the agent panel shows them: face, name, state. */
function RoomMemberList({ members }: { members: string[] }) {
  const { contacts } = useMessenger();
  const looks = useContext(MessengerLooks);
  if (!members.length)
    return <p className="px-8 py-6 text-xs text-text-muted border-b border-border">{t('messenger.noMembers')}</p>;
  return (
    <ul
      aria-label={t('messenger.members')}
      data-testid="member-list"
      className="shrink-0 max-h-[40%] overflow-y-auto border-b border-border"
    >
      {members.map((name) => {
        const c = contacts.find((x) => x.name === name);
        return (
          <li key={name} className="flex items-center gap-8 px-8 py-4 border-t border-border first:border-t-0">
            {c && looks ? (
              <Mug agentId={c.agentId} getAppearance={looks.getAppearance} />
            ) : (
              <SenderFace name={name} />
            )}
            <strong className="text-sm truncate min-w-0 flex-1">{name}</strong>
            {c && looks && <StateDot agentId={c.agentId} statusFor={looks.statusFor} withLabel />}
          </li>
        );
      })}
    </ul>
  );
}

function RoomEditor({
  members,
  title,
  initialName = '',
  initialMembers = [],
  submit,
  cancel,
}: {
  members: string[];
  title: string;
  initialName?: string;
  initialMembers?: string[];
  submit: (name: string, members: string[]) => void;
  cancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState(() => new Set(initialMembers));
  return (
    <form
      className="mx-8 mb-8 border border-border p-6 space-y-4 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) submit(name, [...selected]);
      }}
    >
      <strong>{title}</strong>
      <input
        aria-label={t('messenger.roomName')}
        value={name}
        maxLength={40}
        onChange={(event) => setName(event.target.value)}
        className="w-full border border-border bg-bg px-4 py-2"
      />
      <fieldset>
        <legend className="text-text-muted">{t('messenger.members')}</legend>
        <div className="flex flex-wrap gap-x-8 gap-y-4 mt-4">
          {members.map((member) => (
            <label key={member} className="flex items-center gap-2 pointer-coarse:min-h-44">
              <input
                type="checkbox"
                checked={selected.has(member)}
                onChange={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(member)) next.delete(member);
                    else next.add(member);
                    return next;
                  })
                }
              />
              {member}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-4 justify-end">
        <Button size="sm" onClick={cancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="accent" type="submit" disabled={!name.trim()}>
          {t('engine.save')}
        </Button>
      </div>
    </form>
  );
}

function GroupRoomRow({ room, allMembers }: { room: GroupRoom; allMembers: string[] }) {
  const m = useMessenger();
  const { officeReadOnly } = useCldStore();
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [choice, setChoice] = useState(0);
  const [editing, setEditing] = useState<'rename' | 'members' | null>(null);
  const [attachmentError, setAttachmentError] = useState('');
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const lastPost = useRef<{ requestId: string; text: string; reply: ChatReply | null } | null>(
    null,
  );
  const [refused, setRefused] = useState('');
  // MSG-ACTIONS: the post or member reply this room message answers.
  const [reply, setReplyState] = useState<ChatReply | null>(null);
  const setReply = (value: ChatReply | null) => {
    setReplyState(value);
    if (value) requestAnimationFrame(() => input.current?.focus());
  };
  // MSG-UI3: answering a member tags them, so the room's mention routing delivers the reply.
  const replyTo = (value: ChatReply) => {
    const next = replyPrefill(text, value.sender, room.members);
    if (next !== text) edit(next, next.length);
    setReply(value);
  };
  const posts = useRef<HTMLDivElement>(null);
  /** A quote tapped: the post or reply it names, if the room shows it (its last posts). */
  const openQuote = (id: string) => {
    const row = [
      ...(posts.current?.querySelectorAll<HTMLElement>('[data-keep],[data-chat-id]') ?? []),
    ].find((node) => node.dataset.keep === id || node.dataset.chatId === id);
    if (!row) {
      cldToast(t('messenger.title'), t('messenger.replyNotFound'), 'info');
      return;
    }
    row.scrollIntoView({ block: 'center' });
    row.dataset.focused = 'true';
    window.setTimeout(() => delete row.dataset.focused, FOCUS_MS);
  };
  const groupError = m.groupError;
  useEffect(() => {
    // A refused post (an unknown @tag, no permission) gives the draft back instead of eating it.
    if (groupError && lastPost.current && groupError.requestId === lastPost.current.requestId) {
      const { text: draft, reply: answered } = lastPost.current;
      lastPost.current = null;
      setRefused(groupError.error);
      setText((current) => current || draft);
      setReplyState((current) => current ?? answered);
    }
  }, [groupError]);
  const timeline = m.groupTimelines[room.id];
  const chips = m.groupAttachments[room.id] ?? NO_CHIPS;
  const activeMention = mentionAt(text, cursor);
  const suggestions = activeMention ? filterMentions(room.members, activeMention.query) : [];
  const galleryFiles = useMemo(() => {
    const seen = new Set<string>();
    return (timeline?.posts ?? [])
      .flatMap((post) => splitAttachmentText(post.text).attachments)
      .filter((file) => !seen.has(file.path) && !!seen.add(file.path));
  }, [timeline]);
  const ticketFor = useTicketFor();
  const viewerFiles = useMemo(() => [...galleryFiles, ...draftViewerFiles(chips)], [galleryFiles, chips]);
  const viewerTicketFor = useDraftTicketFor(ticketFor, chips);
  const edit = (value: string, at = cursor) => {
    setText(value);
    setCursor(at);
    setChoice(0);
  };
  const addFiles = (files: FileList | File[]) => {
    if (officeReadOnly || uploading) return;
    setAttachmentError(
      files.length > MAX_ATTACHMENTS - chips.length ? t('messenger.limitFiles') : '',
    );
    setGroupAttachments(room.id, [
      ...chips,
      ...Array.from(files)
        .slice(0, Math.max(0, MAX_ATTACHMENTS - chips.length))
        .map((file) => fileChip(file, crypto.randomUUID())),
    ]);
  };
  const acceptMention = (name: string) => {
    const next = chooseMention(text, cursor, name);
    edit(next.text, next.cursor);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };
  const post = async () => {
    if ((!text.trim() && !chips.length) || officeReadOnly || uploading) return;
    const prepared = prepareMessage(text, CHAT_SEND_MAX);
    const hasGeneratedAttachment = prepared.attachment !== undefined;
    if ((chips.length || hasGeneratedAttachment) && !room.members.length) {
      setAttachmentError(t('messenger.noAttachmentMembers'));
      return;
    }
    if ((chips.length || hasGeneratedAttachment) && transport.state !== 'connected') {
      setAttachmentError(t('messenger.error.disconnectedSend'));
      return;
    }
    setUploading(true);
    setAttachmentError('');
    let uploaded = [...chips];
    try {
      if (prepared.attachment) {
        if (uploaded.length >= MAX_ATTACHMENTS) {
          setAttachmentError(t('messenger.limitFiles'));
          return;
        }
        uploaded = [
          ...uploaded,
          fileChip(
            new File([prepared.attachment.content], prepared.attachment.name, {
              type: prepared.attachment.type,
            }),
            crypto.randomUUID(),
          ),
        ];
        setGroupAttachments(room.id, uploaded);
      }
      if (uploaded.some((chip) => chip.state === 'failed')) return;
      for (const chip of uploaded) {
        if (chip.state === 'ready') continue;
        uploaded = updateChip(uploaded, chip.id, { state: 'uploading', progress: 0 });
        setGroupAttachments(room.id, uploaded);
        try {
          // Attachments are saved into one room member's inbox; the absolute path is shared in the room record.
          const saved = await uploadAttachment(
            room.members[0],
            chip,
            crypto.randomUUID(),
            (progress) => {
              uploaded = updateChip(uploaded, chip.id, { progress });
              setGroupAttachments(room.id, uploaded);
            },
          );
          uploaded = updateChip(uploaded, chip.id, {
            state: 'ready',
            progress: 100,
            path: saved.path,
            name: saved.name,
            type: saved.type,
            size: saved.size,
          });
          setGroupAttachments(room.id, uploaded);
        } catch (error) {
          uploaded = updateChip(uploaded, chip.id, {
            state: 'failed',
            error: (error as Error).message,
          });
          setGroupAttachments(room.id, uploaded);
          return;
        }
      }
      const outgoing = composeAttachmentText(canonicalizeMentions(prepared.text), uploaded);
      if (outgoing === null) {
        setAttachmentError(t('messenger.invalidFilename'));
        return;
      }
      if (outgoing.length > CHAT_SEND_MAX) {
        setAttachmentError(t('messenger.messageTooLong'));
        return;
      }
      const requestId = `group-post-${Date.now()}`;
      setRefused('');
      lastPost.current = { requestId, text, reply };
      transport.send({
        type: 'groupPost',
        requestId,
        room: room.id,
        text: outgoing,
        ...(reply && { replyTo: reply }),
      });
      edit('', 0);
      setReply(null);
      setGroupAttachments(room.id, []);
      requestStaleRecheck();
    } finally {
      setUploading(false);
      requestStaleRecheck();
    }
  };
  return (
    <div>
      <AttachmentGallery files={viewerFiles} ticketFor={viewerTicketFor}>
        <div className="px-8 pb-8 space-y-6 text-xs">
          {!officeReadOnly && room.id !== 'all' && (
            <div className="flex flex-wrap gap-4">
              <Button size="sm" onClick={() => setEditing('rename')}>
                {t('messenger.rename')}
              </Button>
              <Button size="sm" onClick={() => setEditing('members')}>
                {t('messenger.members')}
              </Button>
              <Button
                size="sm"
                aria-pressed={room.systemLines !== false}
                onClick={() =>
                  transport.send({
                    type: 'groupAction',
                    requestId: `group-system-${Date.now()}`,
                    action: 'systemLines',
                    id: room.id,
                    on: room.systemLines === false,
                  })
                }
              >
                {t(
                  room.systemLines === false
                    ? 'messenger.systemLinesOn'
                    : 'messenger.systemLinesOff',
                )}
              </Button>
              <Button
                size="sm"
                className="text-danger"
                onClick={() =>
                  transport.send({
                    type: 'groupAction',
                    requestId: `group-delete-${Date.now()}`,
                    action: 'delete',
                    id: room.id,
                  })
                }
              >
                {t('messenger.deleteRoom')}
              </Button>
            </div>
          )}
          {editing === 'rename' && (
            <RoomEditor
              members={room.members}
              title={t('messenger.renameRoom')}
              initialName={room.name}
              initialMembers={room.members}
              submit={(name) => {
                transport.send({
                  type: 'groupAction',
                  requestId: `group-rename-${Date.now()}`,
                  action: 'rename',
                  id: room.id,
                  name,
                });
                setEditing(null);
              }}
              cancel={() => setEditing(null)}
            />
          )}
          {editing === 'members' && (
            <RoomEditor
              members={allMembers}
              title={t('messenger.chooseMembers')}
              initialName={room.name}
              initialMembers={room.members}
              submit={(_, members) => {
                transport.send({
                  type: 'groupAction',
                  requestId: `group-members-${Date.now()}`,
                  action: 'setMembers',
                  id: room.id,
                  members,
                });
                setEditing(null);
              }}
              cancel={() => setEditing(null)}
            />
          )}
          <div ref={posts} className="space-y-12">
            {(timeline?.posts ?? []).map((post, index) => (
              <RoomPost
                key={post.id}
                post={post}
                tone={THREAD_TONES[index % THREAD_TONES.length]}
                onReply={officeReadOnly ? undefined : replyTo}
                onQuote={openQuote}
              />
            ))}
          </div>
          {timeline === undefined && (
            <p className="text-text-muted">{t('messenger.loadingHistory')}</p>
          )}
          {!officeReadOnly && reply && <ReplyChip reply={reply} cancel={() => setReply(null)} />}
          {officeReadOnly ? (
            <p className="text-text-muted">{t('messenger.roomReadOnly')}</p>
          ) : (
            <form
              className="relative flex gap-4 items-end"
              onSubmit={(event) => {
                event.preventDefault();
                void post();
              }}
            >
              <div className="flex-1 min-w-0">
                <textarea
                  ref={input}
                  aria-label={t('messenger.roomMessage', { name: serverLine(room.name) })}
                  value={text}
                  rows={2}
                  onChange={(event) => edit(event.target.value, event.currentTarget.selectionStart)}
                  onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
                  onPaste={(event) => {
                    if (event.clipboardData.files.length) {
                      event.preventDefault();
                      addFiles(event.clipboardData.files);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (suggestions.length) {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setCursor(0);
                        return;
                      }
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        setChoice(
                          (current) =>
                            (current + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) %
                            suggestions.length,
                        );
                        return;
                      }
                      if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault();
                        acceptMention(suggestions[choice] ?? suggestions[0]);
                        return;
                      }
                    }
                    if (
                      enterSends(
                        {
                          key: event.key,
                          shiftKey: event.shiftKey,
                          ctrlKey: event.ctrlKey,
                          metaKey: event.metaKey,
                          isComposing: event.nativeEvent.isComposing,
                          keyCode: event.keyCode,
                        },
                        isTouchDevice(),
                      )
                    ) {
                      event.preventDefault();
                      void post();
                    }
                  }}
                  placeholder={t('messenger.mentionPlaceholder')}
                  className="w-full min-w-0 border border-border bg-bg px-4 py-2 resize-none"
                />
                {messageCharacterCount(text) > CHAT_SEND_MAX && (
                  <p className="pt-2 text-text-muted" role="status">
                    {t('messenger.longMessageNote', { count: messageCharacterCount(text) })}
                  </p>
                )}
                {suggestions.length > 0 && (
                  <div
                    role="listbox"
                    aria-label={t('messenger.mentionSuggestions')}
                    className="absolute z-10 bottom-full mb-2 max-w-full border-2 border-border bg-bg shadow-pixel flex flex-wrap p-2 gap-2"
                  >
                    {suggestions.map((name, index) => (
                      <button
                        key={name}
                        type="button"
                        role="option"
                        aria-selected={index === choice}
                        className={`px-6 py-4 text-left pointer-coarse:min-h-44 ${index === choice ? 'bg-active-bg text-accent-text' : 'hover:bg-btn-hover'}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => acceptMention(name)}
                      >
                        @{mentionDisplay(name)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <input
                ref={picker}
                type="file"
                multiple
                className="hidden"
                aria-label={t('messenger.chooseFiles')}
                accept={ATTACH_ACCEPT}
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              <Button
                size="sm"
                disabled={uploading || chips.length >= MAX_ATTACHMENTS}
                onClick={() => picker.current?.click()}
              >
                {t('messenger.attach')}
              </Button>
              <Button
                size="sm"
                variant="accent"
                type="submit"
                disabled={uploading || (!text.trim() && !chips.length)}
              >
                {uploading ? t('messenger.uploading') : t('messenger.sendButton')}
              </Button>
            </form>
          )}
          {chips.length > 0 && (
            <div className="space-y-2">
              {chips.map((chip) => (
                <DraftChip
                  key={chip.id}
                  chip={chip}
                  remove={() =>
                    setGroupAttachments(
                      room.id,
                      chips.filter((item) => item.id !== chip.id),
                    )
                  }
                />
              ))}
            </div>
          )}
          {(attachmentError || refused) && (
            <p role="alert" className="text-danger">
              {attachmentError || refused}
            </p>
          )}
        </div>
      </AttachmentGallery>
    </div>
  );
}

/** MSG-UI3: a room thread's rail, one colour each (static class names, so Tailwind sees them). */
const THREAD_TONES = ['border-l-thread-1', 'border-l-thread-2', 'border-l-thread-3', 'border-l-thread-4'];

/** The ↳ mark before a thread reply, drawn in pixels (the pixel font has no such arrow). */
function ReplyArrow() {
  return (
    <svg
      className="shrink-0 text-text-muted w-[10px] h-[10px] mt-4"
      viewBox="0 0 10 10"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      data-testid="reply-arrow"
    >
      <rect x="1" y="0" width="1" height="7" />
      <rect x="1" y="6" width="5" height="1" />
      <rect x="5" y="4" width="1" height="5" />
      <rect x="6" y="5" width="1" height="3" />
      <rect x="7" y="6" width="1" height="1" />
    </svg>
  );
}

function RoomPost({
  post,
  tone,
  onReply,
  onQuote,
}: {
  post: GroupPostItem;
  tone: string;
  onReply?: (reply: ChatReply) => void;
  onQuote?: (id: string) => void;
}) {
  // C4: a system event (Task assigned, reported, …): one short muted line, no bubble.
  if (post.system)
    return (
      <p data-keep={post.id} className="text-text-muted text-center">
        {serverLine(post.text)}
      </p>
    );
  const copy = copyText({ kind: 'user', text: post.text });
  const actions: BubbleActions = {
    copy,
    // A room post's id names it; the boss's own post has no sender.
    ...(onReply && { reply: () => onReply(replyDraft(post.id, post.sender ?? undefined, copy)) }),
  };
  const delivery = (state: GroupPostItem['delivery'][string]) =>
    state === 'delivered'
      ? t('messenger.delivery.delivered')
      : state === 'held'
        ? t('messenger.delivery.held')
        : state === 'off'
          ? t('messenger.delivery.off')
          : t('messenger.delivery.waiting');
  return (
    <Actionable
      as="article"
      actions={actions}
      data-keep={post.id}
      data-testid="room-thread"
      className={`border border-border border-l-2 ${tone} bg-bg-dark p-6 space-y-4 data-[focused=true]:outline-2 data-[focused=true]:outline-accent`}
    >
      <div className="flex items-center gap-6">
        {post.sender ? <SenderFace name={post.sender} /> : <OwnerFace />}
        <p className="text-text-muted">{post.sender ?? t('msgui3.me')}</p>
      </div>
      {post.replyTo && <ReplyQuote reply={post.replyTo} open={onQuote} />}
      <BubbleAttachments text={post.text} />
      <p
        className="text-text-muted flex flex-wrap gap-x-6 gap-y-2"
        aria-label={t('messenger.deliveryStatus')}
      >
        {post.targets.length === 0 && <span>{t('messenger.recordOnly')}</span>}
        {post.targets.map((member) => (
          <span key={member} className="border border-border px-4">
            {member}: {delivery(post.delivery[member])}
          </span>
        ))}
        <ActionRow actions={actions} post />
      </p>
      {post.replies.map(
        (reply) =>
          reply.items.length > 0 && (
            <section
              key={reply.messageId ?? reply.member}
              data-message-id={reply.messageId}
              className="border-t border-border pt-4 flex items-start gap-6"
              aria-label={t('messenger.replyLabel', { name: reply.member })}
            >
              <ReplyArrow />
              <SenderFace name={reply.member} />
              <div className="min-w-0 flex-1 space-y-2">
                <strong className="text-peer-name">{reply.member}</strong>
                {reply.items.map((item) => (
                  <div
                    key={item.id}
                    data-chat-id={item.id}
                    className="data-[focused=true]:outline-2 data-[focused=true]:outline-accent"
                  >
                    <Line
                      item={item}
                      received={false}
                      replyAs={reply.member}
                      onReply={onReply}
                      onQuote={onQuote}
                    />
                  </div>
                ))}
              </div>
            </section>
          ),
      )}
    </Actionable>
  );
}

/** Who the last message in the list is from, when not the boss's own words. */
function senderLabel(c: Pick<MessengerContact, 'lastKind' | 'lastFrom' | 'lastFromName'>): string {
  if (c.lastKind !== 'user') return '';
  if (c.lastFrom === 'peer')
    return c.lastFromName
      ? t('messenger.sender.otherName', { name: serverLine(c.lastFromName) })
      : t('messenger.sender.other');
  return c.lastFrom === 'system' ? t('messenger.sender.system') : t('messenger.sender.me');
}

/** "14:05" today, "10-21" before. */
function clock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.toDateString() === new Date().toDateString()
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A bubble's time (user 10-22 13:53): "14:05" today, "10-21 14:05" before. */
function bubbleClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

function sessionClock(at: number): string {
  const d = new Date(at);
  return t('messenger.sessionClock', {
    month: d.getMonth() + 1,
    day: d.getDate(),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  });
}

function SearchHitRow({
  hit,
  query,
  onClick,
}: {
  hit: ChatSearchHit;
  query: string;
  onClick: () => void;
}) {
  const index = hit.snippet.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return (
    <li>
      <button
        type="button"
        className="block w-full text-left border-b-2 border-border px-4 py-6 text-xs"
        onClick={onClick}
      >
        <span className="block text-2xs text-text-muted">
          {sessionClock(hit.at)}{' '}
          {hit.session && (
            <span className="border border-border px-4">{t('messenger.previousSession')}</span>
          )}
        </span>
        <span className="block break-words">
          {index < 0 ? (
            hit.snippet
          ) : (
            <>
              {hit.snippet.slice(0, index)}
              <mark className="bg-search-match text-search-match-text px-px">
                {hit.snippet.slice(index, index + query.length)}
              </mark>
              {hit.snippet.slice(index + query.length)}
            </>
          )}
        </span>
      </button>
    </li>
  );
}

function Mug({
  agentId,
  getAppearance,
}: {
  agentId: number;
  getAppearance: MessengerProps['getAppearance'];
}) {
  const a = getAppearance(agentId);
  return (
    <span className="shrink-0 border border-border">
      <CharacterMugShot palette={a.palette} hueShift={a.hueShift} size={MUG_PX} />
    </span>
  );
}

const DOT: Record<LeadState, string> = {
  working: 'bg-status-active',
  thinking: 'bg-accent-bright',
  waiting: 'bg-status-permission',
  resting: 'bg-status-success',
  off: 'bg-border',
};

function StateDot({
  agentId,
  statusFor,
  withLabel,
}: {
  agentId: number;
  statusFor: MessengerProps['statusFor'];
  withLabel?: boolean;
}) {
  const held = useMessenger().contacts.find((x) => x.agentId === agentId)?.held === true;
  const presence = presenceOf(useStaff(), agentId);
  const { dot: s, word } = leadPresence(
    presence,
    leadState(useRow(agentId), statusFor(agentId), held),
  );
  return (
    <span className="shrink-0 flex items-center gap-4" title={word}>
      <span
        className={`inline-block w-8 h-8 ${DOT[s]}`}
        data-testid="lead-state"
        data-state={s}
        data-presence={presence ?? undefined}
      />
      {withLabel ? (
        <span className="text-2xs text-text-muted">{word}</span>
      ) : (
        <span className="sr-only">{word}</span>
      )}
    </span>
  );
}

function Tab({ agentId }: { agentId: number; chip?: boolean }) {
  const m = useMessenger();
  const c = m.contacts.find((x) => x.agentId === agentId);
  const name = c?.name ?? `#${agentId}`;
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

function Conversation({
  agentId,
  visualViewportHeight,
  statusFor,
  getAppearance,
}: { agentId: number } & Omit<MessengerProps, 'mobile'>) {
  const store = useCldStore();
  const m = useMessenger();
  const row = useRow(agentId);
  const engine = useEngineStore().state;
  const contact = m.contacts.find((c) => c.agentId === agentId);
  const name = contact?.name ?? row?.name ?? `#${agentId}`;
  const projectRoot =
    engine?.projects.find((project) => project.name === name)?.folder ??
    (row && 'dir' in row ? row.dir : undefined);
  const chips = m.attachments[agentId] ?? NO_CHIPS;
  const items = m.items[agentId];
  // U-25: a cancelled queued message keeps its data in the store but is not shown.
  const pending = (m.pending[agentId] ?? []).filter((p) => p.state !== 'cancelled');
  const received = m.received[agentId] ?? [];
  const canSend = m.canSend[agentId] ?? contact?.canSend ?? false;
  // D5 (MVP): a Codex Worker takes work from its Lead or a room, not a person's DM.
  const codexWorker =
    engine?.projects.find((project) => project.name === name)?.provider === 'codex';
  const typing = row?.busy === true;
  // RENEW-STUCK: its messages wait for the new conversation (즉시 cannot reach the old one).
  const renewing = row?.renewing === true;
  const target = chatTarget(agentId, store.officeSnapshot);
  const fatigue = fatigueFor(agentId, store);
  const context = store.contexts[agentId];
  const orch = row && 'dir' in row ? row : undefined;
  const ticketFor = useTicketFor(name, projectRoot);
  const viewerTicketFor = useDraftTicketFor(ticketFor, chips);
  // The viewer steps through every attachment the conversation holds, oldest first.
  const heldPending = m.pending[agentId];
  const galleryFiles = useMemo(() => {
    const seen = new Set<string>();
    const files = [
      ...(items ?? []).flatMap((item) => [
        ...(item.kind === 'user' ? splitAttachmentText(item.text).attachments : []),
        ...sentFiles(item),
      ]),
      ...(heldPending ?? []).flatMap((p) => splitAttachmentText(p.text).attachments),
    ];
    return files.filter((file) => !seen.has(file.path) && !!seen.add(file.path));
  }, [items, heldPending]);
  const viewerFiles = useMemo(() => [...galleryFiles, ...draftViewerFiles(chips)], [galleryFiles, chips]);
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const readerAnchor = useRef<{ id: string; top: number } | null>(null);
  const restoring = useRef(false);
  const savedTop = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [searchRequest, setSearchRequest] = useState('');
  const [activeResult, setActiveResult] = useState(-1);
  const [listOpen, setListOpen] = useState(false);
  const [targetItem, setTargetItem] = useState<{ at: number; id?: string } | null>(null);
  // The jump's bounded wait for a message that has not arrived yet ran out (for this target).
  const [waitedOut, setWaitedOut] = useState<typeof targetItem>(null);
  // A quote tapped: the original's id, sought through older pages until found.
  const [replySeek, setReplySeek] = useState<string | null>(null);
  const searchResult = m.searchResults[agentId];
  const hits = useMemo(() => searchResult?.hits ?? [], [searchResult]);
  const historyBusy = !!m.historyBusy[agentId];
  const historyDone = !!m.historyDone[agentId];
  const full = (items?.length ?? 0) >= MAX_ITEMS;
  const jumpLoading = !!m.jumpLoading[agentId];
  const historyError = m.historyError[agentId];
  const fetchOlder = useCallback(
    (until?: number) => {
      if (!items || historyBusy || historyDone || (full && !jumpLoading)) return;
      const el = list.current;
      if (el) prepend.current = { height: el.scrollHeight, top: el.scrollTop };
      stuck.current = false;
      const requestId = nextRequestId();
      requestHistory(agentId, requestId);
      transport.send({
        type: 'chatHistory',
        agentId,
        requestId,
        ...(items[0] && { before: items[0].id }),
        ...(until !== undefined && { until }),
      });
    },
    [items, historyBusy, historyDone, full, jumpLoading, agentId],
  );
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !prepend.current || historyBusy) return;
    el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height;
    prepend.current = null;
  }, [items, historyBusy]);
  useEffect(() => {
    const el = list.current;
    const top = sentinel.current;
    if (!el || !top || !items || targetItem || historyDone || historyBusy || full || historyError)
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry.isIntersecting &&
          mayFetchOlder({ hidden: isHidden(el), restoring: restoring.current })
        ) {
          fetchOlder();
        }
      },
      { root: el },
    );
    observer.observe(top);
    return () => observer.disconnect();
  }, [items, targetItem, historyDone, historyBusy, full, historyError, fetchOlder]);
  useEffect(() => {
    if (m.pendingJump?.agentId !== agentId) return;
    setJumpLoading(agentId, true);
    stuck.current = false;
    setTargetItem({ at: m.pendingJump.at, id: m.pendingJump.id });
    clearPendingJump(agentId);
  }, [m.pendingJump, agentId]);
  useEffect(() => {
    if (!targetItem || !items) return;
    const plan = jumpStep(items, targetItem, {
      live: !!m.tailLive[agentId],
      historyDone,
      waitedOut: waitedOut === targetItem,
    });
    if (plan.step === 'wait') return; // the next transcript (or the timer below) wakes this
    if (plan.step === 'older') {
      if (!historyError && (!full || jumpLoading)) {
        fetchOlder(targetItem.at);
        return;
      }
    }
    // 'older' that cannot be fetched (error, a full window) ends by time, as before.
    const found = plan.step === 'found' ? plan.item : jumpTarget(items, targetItem.at, targetItem.id);
    if (historyBusy) return;
    if (!found) {
      setTargetItem(null); // nothing that old: stay where the reader is
      setJumpLoading(agentId, false);
      return;
    }
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-chat-id]') ?? [])].find(
      (node) => node.dataset.chatId === found.id,
    );
    if (!row) return;
    stuck.current = false;
    setAway(true);
    row.scrollIntoView({ block: 'center' });
    row.dataset.focused = 'true';
    window.setTimeout(() => {
      delete row.dataset.focused;
    }, FOCUS_MS);
    setTargetItem(null);
    setJumpLoading(agentId, false);
  }, [
    targetItem,
    items,
    historyBusy,
    historyDone,
    full,
    historyError,
    jumpLoading,
    fetchOlder,
    agentId,
    m.tailLive,
    waitedOut,
  ]);
  useEffect(() => {
    if (!targetItem) return;
    const timer = window.setTimeout(() => setWaitedOut(targetItem), JUMP_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [targetItem]);
  useEffect(() => {
    if (!replySeek || !items) return;
    const found = findReplied(items, replySeek);
    if (found) {
      setReplySeek(null);
      setTargetItem({ at: found.at, id: found.id }); // scrolls there and highlights it
      return;
    }
    if (historyBusy) return;
    if (historyDone || historyError) {
      setReplySeek(null);
      setJumpLoading(agentId, false);
      cldToast(t('messenger.title'), t('messenger.replyNotFound'), 'info');
      return;
    }
    fetchOlder();
  }, [replySeek, items, historyBusy, historyDone, historyError, fetchOlder, agentId]);
  const openQuote = useCallback(
    (id: string) => {
      setJumpLoading(agentId, true); // older pages past MAX_ITEMS too, as a search jump
      stuck.current = false;
      setReplySeek(id);
    },
    [agentId],
  );
  const jumpToHit = useCallback(
    (hit: ChatSearchHit) => {
      setJumpLoading(agentId, true);
      stuck.current = false;
      setTargetItem({ id: hit.id, at: hit.at });
    },
    [agentId],
  );
  const clearSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setSearched('');
    setSearchRequest('');
    setActiveResult(-1);
    setListOpen(false);
  }, []);
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      clearSearch();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [searchOpen, clearSearch]);
  const search = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const requestId = nextRequestId();
    setSearched(trimmed);
    setSearchRequest(requestId);
    setActiveResult(-1);
    requestSearch(agentId, requestId);
    transport.send({ type: 'chatSearch', agentId, requestId, query });
  }, [agentId, query]);
  useEffect(() => {
    if (!searchOpen || query.trim().length < 2 || query.trim() === searched) return;
    const timer = window.setTimeout(search, 180);
    return () => window.clearTimeout(timer);
  }, [searchOpen, query, searched, search]);
  useEffect(() => {
    if (searchResult?.requestId !== searchRequest || m.searchBusy[agentId] || !hits.length) return;
    setActiveResult(0);
    jumpToHit(hits[0]);
  }, [searchResult, searchRequest, m.searchBusy, agentId, hits, jumpToHit]);
  const stepResult = (direction: 'older' | 'newer') => {
    const next = stepSearchResult(activeResult, hits.length, direction);
    if (next < 0) return;
    setActiveResult(next);
    jumpToHit(hits[next]);
  };
  // The unsent text survives closing, switching and reloads (per device, 24 h).
  const draft = draftKey(row?.provider ?? 'claude', name);
  const [text, setText] = useState(() => loadDraft(draft));
  // MSG-ACTIONS: the message this draft answers (답글), kept with the draft.
  const [reply, setReplyState] = useState(() => loadDraftReply(draft));
  const setReply = (value: ChatReply | null) => {
    setReplyState(value);
    saveDraftReply(draft, value);
    if (value) requestAnimationFrame(() => box.current?.focus());
  };
  const editRestore = useRef<string | null>(null);
  const pendingEdit = m.editing?.agentId === agentId ? m.editing : null;
  const editActive = useRef(false);
  const edit = (value: string) => {
    setText(value);
    saveDraft(draft, value);
  };
  const leavePendingEdit = () => {
    messengerEditLeave((msg) => transport.send(msg));
    edit(editRestore.current ?? '');
    editRestore.current = null;
  };
  useEffect(() => {
    editActive.current = !!pendingEdit;
  }, [pendingEdit]);
  useEffect(
    () => () => {
      // MSG-HOLD2: leaving the screen is no decision: the message stays held, its bubble asks.
      if (editActive.current) messengerEditPark();
    },
    [],
  );
  useEffect(() => {
    if (!pendingEdit) return;
    setText(pendingEdit.text);
  }, [pendingEdit]);
  // T-0111: one line to start with, growing with the text up to 8 lines (a third of the
  // screen on a phone), then scrolling inside; empty after sending, it shrinks back.
  const box = useRef<HTMLTextAreaElement>(null);
  const phone = useIsMobile();
  const [composerFocused, setComposerFocused] = useState(false);
  // A press inside the footer (chip, 첨부, 보내기, padding) blurs the box, but the box must
  // not shrink under the pointer: the layout shifts and the click misses. Once pressed in,
  // the box stays expanded (also while a viewer takes the focus) until a press lands
  // outside the footer or the focus leaves it with no press in between (Tab).
  const footer = useRef<HTMLElement>(null);
  const pressedIn = useRef(false);
  useEffect(() => {
    if (!composerFocused) {
      pressedIn.current = false;
      return;
    }
    const outside = (e: PointerEvent) => {
      if (footer.current?.contains(e.target as Node)) return;
      pressedIn.current = false;
      // A focused box keeps the size (a scroll drag on the list leaves the keyboard up);
      // when it is blurred by this press, its blur collapses it.
      if (document.activeElement !== box.current) setComposerFocused(false);
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [composerFocused]);
  const [choosingAttachments, setChoosingAttachments] = useState(false);
  const sending = pending.some((p) => p.state === 'sending');
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashRequested = useRef(false);
  const commands = m.slashCommands[agentId];
  const slashText = target?.kind === 'background' && /^\/[^\s]*$/.test(text);
  const matches = useMemo(() => filterSlashCommands(commands ?? [], text), [commands, text]);
  const [clearPrompt, setClearPrompt] = useState(false);
  useEffect(() => {
    if (!slashText) {
      setSlashOpen(false);
      return;
    }
    setSlashOpen(true);
    if (!slashRequested.current) {
      slashRequested.current = true;
      transport.send({ type: 'slashCommands', requestId: nextRequestId(), agentId });
    }
  }, [agentId, slashText]);
  useEffect(() => setSlashIndex(0), [text, matches.length]);
  const composerExpanded =
    composerFocused || slashOpen || choosingAttachments || pendingEdit !== null;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto'; // measure the content without the previous height
    const style = getComputedStyle(el);
    const border = el.offsetHeight - el.clientHeight;
    const fit = composerHeight({
      content: el.scrollHeight + border,
      lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3,
      extra: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + border,
      viewportHeight: window.innerHeight,
      visualViewportHeight: visualViewportHeight ?? undefined,
      phone,
      collapsed: !composerExpanded,
    });
    el.style.height = `${fit.height}px`;
    el.style.overflowY = fit.scrolls ? 'auto' : 'hidden';
    if (!composerExpanded) el.scrollTop = 0;
  }, [text, phone, canSend, composerExpanded, visualViewportHeight]);
  const chooseSlash = (command: SlashCommand) => {
    edit(`/${command.name} `);
    setSlashOpen(false);
    requestAnimationFrame(() => box.current?.focus());
  };
  const addFiles = (files: FileList | File[]) => {
    if (store.officeReadOnly || !canSend || uploading) return;
    setAttachmentError(
      files.length > MAX_ATTACHMENTS - chips.length ? t('messenger.limitFiles') : '',
    );
    const selected = Array.from(files).slice(0, Math.max(0, MAX_ATTACHMENTS - chips.length));
    setAttachments(agentId, [
      ...chips,
      ...selected.map((file) => fileChip(file, crypto.randomUUID())),
    ]);
  };
  const chooseAttachments = () => {
    const input = picker.current;
    if (!input) return;
    setChoosingAttachments(true);
    window.addEventListener('focus', () => setChoosingAttachments(false), { once: true });
    input.click();
  };
  /** Phones: no Ctrl+Enter, so 즉시 is a button beside 보내기. */
  const touch = isTouchDevice();
  const keepComposerFocus = (event: ReactPointerEvent<HTMLButtonElement>) =>
    keepPhoneComposerFocus(phone, event);
  /** When Ctrl+X armed the Ctrl+X Ctrl+S chord. */
  const chord = useRef<number | null>(null);

  // Newest follows only while at the bottom. Away from it, keep the reader's
  // top visible row fixed as messages, tool lines, and the typing line update.
  const stuck = useRef(true);
  const jumping = useRef(false); // a smooth scroll to the bottom is under way
  const seen = useRef<string | undefined>(undefined); // newest message the reader had in view
  const [away, setAway] = useState(false);
  const [missed, setMissed] = useState(0);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || isHidden(el)) return;
    if (stuck.current) {
      el.scrollTop = el.scrollHeight;
      savedTop.current = el.scrollTop;
      seen.current = items?.at(-1)?.id;
      readerAnchor.current = null;
      return;
    }
    const anchor = readerAnchor.current;
    const row = anchor && el.querySelector<HTMLElement>(`[data-chat-id="${anchor.id}"]`);
    if (row) {
      el.scrollTop = row.offsetTop - anchor.top;
      savedTop.current = el.scrollTop;
    }
    setMissed(newSince(items ?? [], seen.current));
  }, [items, pending.length, typing]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    let hidden = isHidden(el);
    if (hidden) restoring.current = true;
    else savedTop.current = el.scrollTop;
    const observer = new ResizeObserver(() => {
      const nextHidden = isHidden(el);
      if (nextHidden) {
        if (!hidden) restoring.current = true;
      } else if (hidden) {
        const anchor = readerAnchor.current;
        const row = anchor && el.querySelector<HTMLElement>(`[data-chat-id="${anchor.id}"]`);
        el.scrollTop = restoreTop(
          {
            stuck: stuck.current,
            anchorTop: anchor?.top ?? null,
            rowOffsetTop: row?.offsetTop ?? null,
            savedTop: savedTop.current,
          },
          el,
        );
        savedTop.current = el.scrollTop;
        restoring.current = false;
      } else {
        // A list that opens before its window is sized has no overflow to pin;
        // when it gets its height, a reader at the bottom is still at the bottom.
        if (stuck.current)
          el.scrollTop = restoreTop(
            { stuck: true, anchorTop: null, rowOffsetTop: null, savedTop: 0 },
            el,
          );
        savedTop.current = el.scrollTop;
      }
      hidden = nextHidden;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const el = list.current;
    if (!el || isHidden(el)) return;
    savedTop.current = el.scrollTop;
    if (jumping.current) {
      if (atBottom(el)) jumping.current = false;
      return;
    }
    const bottom = atBottom(el);
    stuck.current = bottom;
    setAway(!bottom);
    if (bottom) {
      seen.current = items?.at(-1)?.id;
      setMissed(0);
      readerAnchor.current = null;
      return;
    }
    seen.current ??= items?.at(-1)?.id;
    const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find(
      (node) => node.offsetTop + node.offsetHeight > el.scrollTop,
    );
    readerAnchor.current = row
      ? { id: row.dataset.chatId!, top: row.offsetTop - el.scrollTop }
      : null;
  };
  const jump = () => {
    const el = list.current;
    if (!el) return;
    stuck.current = true;
    jumping.current = true;
    seen.current = items?.at(-1)?.id;
    setAway(false);
    setMissed(0);
    readerAnchor.current = null;
    if (m.historyWindowed[agentId]) {
      // A jump dropped the newest items: ask for the tail again (chatView answers in full).
      transport.send({ type: 'chatView', agentId, on: true });
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  /** `now`: 즉시 보내기 (Ctrl+Enter, the 즉시 button): it may go in while the lead works. */
  const submit = async (now = false, clearApproved = false) => {
    if (pendingEdit) {
      if (!text.trim()) return;
      if (messengerEditSave((msg) => transport.send(msg), text)) {
        edit('');
        editRestore.current = null;
        requestStaleRecheck();
      }
      return;
    }
    if ((!text.trim() && !chips.length) || sending || uploading || store.officeReadOnly) return;
    const prepared = prepareMessage(text, CHAT_SEND_MAX);
    const hasGeneratedAttachment = prepared.attachment !== undefined;
    if (!clearApproved && !chips.length && text.trim() === '/clear') {
      setClearPrompt(true);
      return;
    }
    if ((chips.length || hasGeneratedAttachment) && transport.state !== 'connected') {
      setAttachmentError(t('messenger.error.disconnectedSend'));
      return;
    }
    setAttachmentError('');
    setUploading(true);
    let uploaded = [...chips];
    const batch = crypto.randomUUID();
    try {
      if (prepared.attachment) {
        if (uploaded.length >= MAX_ATTACHMENTS) {
          setAttachmentError(t('messenger.limitFiles'));
          return;
        }
        uploaded = [
          ...uploaded,
          fileChip(
            new File([prepared.attachment.content], prepared.attachment.name, {
              type: prepared.attachment.type,
            }),
            crypto.randomUUID(),
          ),
        ];
        setAttachments(agentId, uploaded);
      }
      if (uploaded.some((chip) => chip.state === 'failed')) return;
      for (const chip of uploaded) {
        if (chip.state === 'ready') continue;
        uploaded = updateChip(uploaded, chip.id, { state: 'uploading', progress: 0 });
        setAttachments(agentId, uploaded);
        try {
          const saved = await uploadAttachment(name, chip, batch, (progress) => {
            uploaded = updateChip(uploaded, chip.id, { progress });
            setAttachments(agentId, uploaded);
          });
          const relative =
            projectRoot && saved.path.startsWith(`${projectRoot}/`)
              ? saved.path.slice(projectRoot.length + 1)
              : `.cld-inbox/${saved.path.split('/').at(-1)}`;
          uploaded = updateChip(uploaded, chip.id, {
            state: 'ready',
            progress: 100,
            path: saved.path,
            relative,
            name: saved.name,
            type: saved.type,
            size: saved.size,
          });
          setAttachments(agentId, uploaded);
        } catch (error) {
          uploaded = updateChip(uploaded, chip.id, {
            state: 'failed',
            error: (error as Error).message,
          });
          setAttachments(agentId, uploaded);
          return;
        }
      }
      const outgoing = composeAttachmentText(prepared.text, uploaded);
      if (outgoing === null) {
        setAttachmentError(t('messenger.invalidFilename'));
        return;
      }
      if (outgoing.length > CHAT_SEND_MAX) {
        setAttachments(
          agentId,
          uploaded.map((chip) => ({
            ...chip,
            state: 'failed',
            error: t('messenger.messageTooLong'),
          })),
        );
        return;
      }
      messengerSend(
        (msg) => transport.send(msg),
        transport.state === 'connected',
        agentId,
        name,
        outgoing,
        // A slash command must wait for the current turn; Ctrl+X Ctrl+S is not
        // an interrupt path for commands.
        now && !(uploaded.length === 0 && outgoing.trim().startsWith('/')),
        reply ?? undefined,
      );
      edit('');
      setReply(null);
      setAttachments(agentId, []);
      requestStaleRecheck();
      stuck.current = true; // your own message always scrolls into view
      setAway(false);
      setMissed(0);
      readerAnchor.current = null;
    } finally {
      setUploading(false);
      requestStaleRecheck();
    }
  };

  return (
    <AttachmentGallery files={viewerFiles} ticketFor={viewerTicketFor}>
      <section
        aria-label={t('messenger.conversation', { name })}
        className="flex-1 min-h-0 flex flex-col"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }
        }}
      >
        <header className="shrink-0 border-b border-border px-12 py-6 flex items-center gap-8 min-w-0">
          <Mug agentId={agentId} getAppearance={getAppearance} />
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-8 min-w-0">
              <strong className="text-sm truncate">{name}</strong>
              <StateDot agentId={agentId} statusFor={statusFor} withLabel />
            </span>
            <span className="flex items-center gap-8 min-w-0 text-2xs text-text-muted">
              {orch && (
                <span className="truncate" title={orch.dir}>
                  {serverLine(orch.tab)} · {orch.dir.split('/').filter(Boolean).at(-1) ?? orch.dir}
                </span>
              )}
              {fatigue ? (
                <FatigueBar look={fatigue} />
              ) : (
                context && (
                  <span className="shrink-0">
                    {t('messenger.context', { percent: Math.round(contextPct(context)) })}
                  </span>
                )
              )}
            </span>
          </span>
          <Button
            size="icon_md"
            aria-label={t('messenger.search')}
            aria-expanded={searchOpen}
            onClick={() => (searchOpen ? clearSearch() : setSearchOpen(true))}
          >
            ⌕
          </Button>
          {target?.kind === 'background' && (
            <Button
              size="icon_md"
              variant={m.terminalHint === agentId ? 'accent' : 'default'}
              aria-label={t('messenger.openTerminal')}
              title={
                m.terminalHint === agentId
                  ? t('messenger.openTerminalHint')
                  : t('messenger.openTerminal')
              }
              data-hint={m.terminalHint === agentId || undefined}
              onClick={() => requestChat(agentId, target.id)}
            >
              <TerminalGlyph px={1} />
            </Button>
          )}
        </header>
        {searchOpen && (
          <section
            aria-label={t('messenger.search')}
            className="shrink-0 border-b-2 border-border px-12 py-8 bg-bg-dark"
          >
            <form
              className="flex gap-4 items-center"
              onSubmit={(event) => {
                event.preventDefault();
                if (searched === query.trim() && hits.length) stepResult('older');
                else search();
              }}
            >
              <input
                autoFocus
                aria-label={t('messenger.searchTerm')}
                value={query}
                onChange={(event) => {
                  const value = event.target.value;
                  setQuery(value);
                  if (value.trim().length < 2) {
                    setSearched('');
                    setActiveResult(-1);
                  }
                }}
                onKeyDown={(event) => {
                  // Enter steps to the next older match (the form's submit), Shift+Enter to the newer.
                  if (event.key === 'Enter' && event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    stepResult('newer');
                  }
                }}
                className="flex-1 min-w-0 border-2 border-border bg-bg px-8 py-4 text-sm"
              />
              <Button size="icon_md" type="submit" aria-label={t('messenger.olderResult')}>
                ∧
              </Button>
              <Button
                size="icon_md"
                aria-label={t('messenger.newerResult')}
                onClick={() => stepResult('newer')}
              >
                ∨
              </Button>
              <span
                className="shrink-0 text-sm tabular-nums"
                aria-label={t('messenger.resultPosition')}
              >
                {hits.length
                  ? `${activeResult + 1} / ${hits.length}`
                  : searched && !m.searchBusy[agentId]
                    ? t('messenger.noResults')
                    : '0 / 0'}
              </span>
              <Button
                size="sm"
                aria-expanded={listOpen}
                onClick={() => setListOpen((open) => !open)}
              >
                {t('messenger.resultList')}
              </Button>
            </form>
            {m.searchBusy[agentId] && (
              <p className="text-xs text-text-muted mt-4">{t('messenger.searching')}</p>
            )}
            {m.searchResults[agentId]?.error && (
              <p role="alert" className="text-xs text-danger mt-4">
                {serverText(m.searchResults[agentId])}
              </p>
            )}
            {searched && listOpen && !m.searchBusy[agentId] && !m.searchResults[agentId]?.error && (
              <ul
                className="max-h-48 overflow-y-auto mt-4"
                aria-label={t('messenger.searchResults')}
              >
                {m.searchResults[agentId]?.hits.length === 0 && (
                  <li className="text-sm text-text-muted">{t('messenger.noResults')}</li>
                )}
                {m.searchResults[agentId]?.hits.map((hit) => (
                  <SearchHitRow
                    key={hit.id}
                    hit={hit}
                    query={searched}
                    onClick={() => {
                      setActiveResult(hits.indexOf(hit));
                      jumpToHit(hit);
                    }}
                  />
                ))}
                {m.searchResults[agentId]?.truncated && (
                  <li className="text-xs text-text-muted py-4">{t('messenger.moreResults')}</li>
                )}
              </ul>
            )}
          </section>
        )}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={list}
            data-testid="chat-scroll"
            className="flex-1 min-h-0 overflow-y-auto px-12 py-8 space-y-8"
            onScroll={onScroll}
            onWheel={() => (jumping.current = false)}
            onTouchStart={() => (jumping.current = false)}
          >
            <div ref={sentinel} aria-hidden="true" className="h-px" />
            {items && (
              // One row of fixed height whatever it says, so a page that adds nothing
              // (the start already held) does not shift the reader's view.
              <div className="h-16 flex items-center justify-center text-xs text-text-muted truncate">
                {historyBusy ? (
                  t('messenger.loading')
                ) : m.historyError[agentId] ? (
                  <button
                    type="button"
                    className="text-danger truncate"
                    onClick={() => fetchOlder()}
                  >
                    {t('messenger.retryLoad')}
                    {m.historyError[agentId]}
                  </button>
                ) : historyDone ? (
                  t('messenger.startOfConversation')
                ) : full && !m.jumpLoading[agentId] ? (
                  t('messenger.searchOlder')
                ) : null}
              </div>
            )}
            {!items ? (
              <p className="text-text-muted text-sm">{t('messenger.loadingConversation')}</p>
            ) : items.length === 0 && pending.length === 0 ? (
              <p className="text-text-muted text-sm">{t('messenger.emptyConversation')}</p>
            ) : (
              items.map((item, index) => (
                <div
                  key={item.id}
                  data-chat-id={item.id}
                  data-message-id={item.messageId}
                  className="data-[focused=true]:outline-2 data-[focused=true]:outline-accent"
                >
                  <Line
                    item={item}
                    received={received.includes(item.id)}
                    project={name}
                    projectRoot={projectRoot}
                    highlightQuery={searched}
                    currentMatch={hits[activeResult]?.id === item.id}
                    replyAs={name}
                    onReply={
                      canSend && !store.officeReadOnly && !codexWorker ? setReply : undefined
                    }
                    onQuote={openQuote}
                    face={
                      senderKey(item) === null
                        ? undefined
                        : { show: startsRun(items, index), name: item.fromName ? serverLine(item.fromName) : name }
                    }
                  />
                  {dividerAfter(items, index) !== undefined && (
                    <p
                      className="text-center text-2xs text-text-muted py-8"
                      data-testid="session-divider"
                    >
                      {t('messenger.sessionDivider', {
                        time: sessionClock(dividerAfter(items, index)!),
                      })}
                    </p>
                  )}
                </div>
              ))
            )}
            {pending.map((p) => (
              <Pending
                key={p.requestId}
                p={p}
                project={name}
                projectRoot={projectRoot}
                agentId={agentId}
                sendNow={() =>
                  messengerSendNow((msg) => transport.send(msg), agentId, name, p.requestId)
                }
                edit={() => {
                  editRestore.current = text;
                  if (messengerEditEnter((msg) => transport.send(msg), agentId, name, p.requestId))
                    setText(p.text);
                }}
                cancel={() =>
                  messengerCancel((msg) => transport.send(msg), agentId, name, p.requestId)
                }
                approve={() =>
                  messengerApproveHeld((msg) => transport.send(msg), agentId, name, p.requestId)
                }
                editingHere={pendingEdit?.requestId === p.requestId}
                permissionWait={!!contact?.permission}
              />
            ))}
            {typing && (
              <p
                className="mr-24 w-fit text-sm px-8 py-4 border border-border text-text-muted"
                role="status"
                data-testid="typing"
              >
                {t('messenger.state.thinking')}
                <span className="thinking-dots" aria-label={t('messenger.dotsMoving')}>
                  ...
                </span>
              </p>
            )}
          </div>
          {away && (
            <button
              key={missed}
              type="button"
              className={`absolute left-1/2 -translate-x-1/2 bottom-12 min-h-32 px-12 rounded-full border-2 border-accent bg-accent text-white text-xs shadow-pixel pointer-coarse:min-h-44 ${missed > 0 ? 'jump-newest-pop' : 'min-w-32'}`}
              aria-label={
                missed > 0
                  ? t('messenger.jumpBottomNew', { count: missed })
                  : t('messenger.jumpBottom')
              }
              data-testid="jump-newest"
              onClick={jump}
            >
              {jumpLabel(missed)}
            </button>
          )}
        </div>
        <footer
          ref={footer}
          className="relative shrink-0 border-t-2 border-border px-12 py-8"
          onBlur={(e) => {
            if (!pressedIn.current && !footer.current?.contains(e.relatedTarget as Node | null))
              setComposerFocused(false);
          }}
          onPointerDown={() => (pressedIn.current = true)}
        >
          {slashOpen && (
            <div
              role="listbox"
              aria-label={t('messenger.slashCommands')}
              className="absolute bottom-full left-12 right-12 max-h-256 overflow-y-auto border-2 border-border bg-bg shadow-pixel z-10"
            >
              {commands === undefined ? (
                <p className="px-8 py-6 text-xs text-text-muted">
                  {t('messenger.loadingCommands')}
                </p>
              ) : matches.length === 0 ? (
                <p className="px-8 py-6 text-xs text-text-muted">{t('messenger.noCommands')}</p>
              ) : (
                matches.map((command, index) => (
                  <button
                    key={command.name}
                    type="button"
                    role="option"
                    aria-selected={index === slashIndex}
                    ref={
                      index === slashIndex
                        ? (el) => el?.scrollIntoView({ block: 'nearest' })
                        : undefined
                    }
                    className={`w-full min-h-44 px-8 py-6 text-left flex items-center gap-6 text-xs border-b border-border last:border-b-0 pointer-coarse:min-h-52 ${index === slashIndex ? 'bg-active-bg text-accent-text' : 'hover:bg-btn-hover'}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSlash(command)}
                  >
                    <strong className="shrink-0">/{command.name}</strong>
                    {command.args && (
                      <span className="shrink-0 text-text-muted">{serverLine(command.args)}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-text-muted">
                      {command.description && serverLine(command.description)}
                    </span>
                    <span className="shrink-0 border border-border px-4 text-2xs">
                      {command.source === 'builtin'
                        ? t('messenger.commandBuiltIn')
                        : command.source === 'user'
                          ? t('messenger.commandUser')
                          : t('messenger.commandProject')}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          {clearPrompt && (
            <section
              role="dialog"
              aria-label={t('messenger.clearConfirm')}
              className="mb-6 border-2 border-accent bg-bg-dark px-8 py-6 text-xs flex items-center gap-8"
            >
              <p className="flex-1">{t('messenger.clearQuestion')}</p>
              <Button size="sm" onClick={() => setClearPrompt(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="accent"
                onClick={() => {
                  setClearPrompt(false);
                  void submit(false, true);
                }}
              >
                {t('messenger.clear')}
              </Button>
            </section>
          )}
          {attachmentError && (
            <p role="alert" className="text-xs text-danger pb-4">
              {attachmentError}
            </p>
          )}
          {pendingEdit && (
            <div
              className="mb-6 border-2 border-accent bg-bg-dark px-8 py-6 text-xs flex items-center gap-8"
              role="status"
            >
              <span className="flex-1">
                <span className="block">{t('messenger.editingMessage')}</span>
                <span className="block text-text-muted">{t('messenger.editHeld')}</span>
              </span>
              <button type="button" className="underline" onClick={leavePendingEdit}>
                {t('common.cancel')}
              </button>
            </div>
          )}
          {m.editLost?.agentId === agentId && (
            <div
              className="mb-6 border-2 border-danger bg-bg-dark px-8 py-6 text-xs flex flex-wrap items-center gap-8"
              role="status"
              data-testid="edit-lost"
            >
              <span className="flex-1 min-w-0">{t('messenger.editLost')}</span>
              <button
                type="button"
                className="underline text-accent-text pointer-coarse:min-h-44"
                onClick={() => {
                  const lost = m.editLost!;
                  messengerEditLostClear();
                  messengerSend(
                    (msg) => transport.send(msg),
                    transport.state === 'connected',
                    agentId,
                    name,
                    `${t('messenger.correctionPrefix')}${lost.text}`,
                  );
                }}
              >
                {t('messenger.sendCorrection')}
              </button>
              <button
                type="button"
                className="underline pointer-coarse:min-h-44"
                onClick={() => {
                  edit(m.editLost!.text);
                  messengerEditLostClear();
                }}
              >
                {t('messenger.editLostToComposer')}
              </button>
            </div>
          )}
          {!pendingEdit && reply && <ReplyChip reply={reply} cancel={() => setReply(null)} />}
          {!pendingEdit && chips.length > 0 && (
            <div className="flex flex-wrap gap-4 pb-6" aria-label={t('messenger.attachments')}>
              {chips.map((chip) => (
                <DraftChip
                  key={chip.id}
                  chip={chip}
                  remove={() =>
                    setAttachments(
                      agentId,
                      chips.filter((item) => item.id !== chip.id),
                    )
                  }
                />
              ))}
            </div>
          )}
          {renewing && (
            <p className="text-xs text-accent-text pb-6" role="status" data-testid="renewing-note">
              {t('messenger.renewingNote')}
            </p>
          )}
          {contact?.permission ? (
            <PermissionCard
              agentId={agentId}
              card={contact.permission}
              canAnswer={canSend && !store.officeReadOnly}
              openTerminal={
                target?.kind === 'background' ? () => requestChat(agentId, target.id) : null
              }
            />
          ) : (
            contact?.held && (
              <p className="text-xs text-accent-text pb-6" role="status" data-testid="held-note">
                {heldNote()}
              </p>
            )
          )}
          {codexWorker ? (
            <p className="text-xs text-text-muted" data-testid="no-direct-chat">
              {t('messenger.codexNoChat')}
            </p>
          ) : canSend && !store.officeReadOnly ? (
            <form
              className="flex gap-8 items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div className="flex-1 min-w-0">
                <textarea
                  ref={box}
                  aria-label={t('messenger.messageInput')}
                  className="block w-full min-w-0 bg-bg-dark border-2 border-border px-8 py-4 text-sm resize-none pointer-coarse:min-h-44"
                  rows={1}
                  maxLength={pendingEdit ? CHAT_SEND_MAX : undefined}
                  value={text}
                  onChange={(e) => edit(e.target.value)}
                  onFocus={() => setComposerFocused(true)}
                  onPaste={(event) => {
                    if (event.clipboardData.files.length) {
                      event.preventDefault();
                      const files = Array.from(event.clipboardData.files).map((file) =>
                        (!file.name || file.name === 'image.png' || file.name === 'blob') &&
                        file.type === 'image/png'
                          ? new File([file], t('messenger.pastedImage', { time: Date.now() }), {
                              type: file.type,
                            })
                          : file,
                      );
                      addFiles(files);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (pendingEdit && e.key === 'Escape') {
                      e.preventDefault();
                      leavePendingEdit();
                      return;
                    }
                    const menuKey = slashMenuKey(
                      e.key,
                      slashOpen,
                      e.nativeEvent.isComposing || e.keyCode === 229,
                      // Nothing to pick: Enter sends, and the daemon says why it is no command.
                      !matches.length || slashComplete(text, matches[slashIndex]),
                    );
                    if (menuKey) {
                      e.preventDefault();
                      if (menuKey === 'close') setSlashOpen(false);
                      else if (menuKey === 'moveUp')
                        setSlashIndex((index) =>
                          matches.length ? (index - 1 + matches.length) % matches.length : 0,
                        );
                      else if (menuKey === 'moveDown')
                        setSlashIndex((index) =>
                          matches.length ? (index + 1) % matches.length : 0,
                        );
                      else if (menuKey === 'choose' && matches[slashIndex])
                        chooseSlash(matches[slashIndex]);
                      return;
                    }
                    // Ctrl+X then Ctrl+S: 즉시 보내기 (Claude Code's chord); Ctrl+X still
                    // cuts a selection.
                    const box = e.currentTarget;
                    const step = chordStep(
                      chord.current,
                      {
                        key: e.key,
                        ctrlKey: e.ctrlKey,
                        selected: box.selectionStart !== box.selectionEnd,
                      },
                      Date.now(),
                    );
                    chord.current = step.armedAt;
                    if (step.consume) {
                      e.preventDefault();
                      if (step.send) void submit(true);
                      return;
                    }
                    // Desktop: Enter sends, Shift+Enter breaks the line. Touch: Enter breaks
                    // the line, the button sends. Ctrl/Cmd+Enter: 즉시 보내기, anywhere.
                    // Never mid-composition (Hangul IME).
                    const key = {
                      key: e.key,
                      shiftKey: e.shiftKey,
                      ctrlKey: e.ctrlKey,
                      metaKey: e.metaKey,
                      isComposing: e.nativeEvent.isComposing,
                      keyCode: e.keyCode,
                    };
                    const now = enterSendsNow(key);
                    if (now || enterSends(key, isTouchDevice())) {
                      e.preventDefault();
                      void submit(now);
                    }
                  }}
                />
                {!pendingEdit && messageCharacterCount(text) > CHAT_SEND_MAX && (
                  <p className="pt-2 text-xs text-text-muted" role="status">
                    {t('messenger.longMessageNote', { count: messageCharacterCount(text) })}
                  </p>
                )}
              </div>
              {!pendingEdit && (
                <>
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    className="hidden"
                    aria-label={t('messenger.chooseFiles')}
                    accept={ATTACH_ACCEPT}
                    onChange={(event) => {
                      setChoosingAttachments(false);
                      if (event.target.files) addFiles(event.target.files);
                      event.target.value = '';
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={uploading || chips.length >= MAX_ATTACHMENTS}
                    onPointerDown={keepComposerFocus}
                    onClick={chooseAttachments}
                  >
                    {t('messenger.attach')}
                  </Button>
                </>
              )}
              {touch && !pendingEdit && (
                <Button
                  type="button"
                  size="sm"
                  disabled={sending || uploading || renewing || (!text.trim() && !chips.length)}
                  title={renewing ? t('messenger.renewingNote') : t('messenger.sendNowHint')}
                  onPointerDown={keepComposerFocus}
                  onClick={() => void submit(true)}
                >
                  {t('messenger.sendNow')}
                </Button>
              )}
              <Button
                type="submit"
                variant="accent"
                size="sm"
                disabled={sending || uploading || (!text.trim() && !chips.length)}
                title={t('messenger.sendShortcut')}
                onPointerDown={keepComposerFocus}
              >
                {sending ? t('messenger.send.sending') : t('messenger.sendButton')}
              </Button>
            </form>
          ) : (
            items && (
              <p className="text-xs text-text-muted" data-testid="no-send-note">
                {readOnlyNote(agentId, store.officeSnapshot)}
              </p>
            )
          )}
        </footer>
      </section>
    </AttachmentGallery>
  );
}

function DraftChip({ chip, remove }: { chip: AttachmentChip; remove: () => void }) {
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const openViewer = useOpenAttachment();
  useEffect(() => {
    if (!chip.file || !chip.type.startsWith('image/')) return;
    const url = URL.createObjectURL(chip.file);
    setThumbnail(url);
    return () => URL.revokeObjectURL(url);
  }, [chip.file, chip.type]);
  return (
    <div
      className="min-w-0 max-w-full border border-border bg-bg-dark px-4 py-2 text-xs"
      data-state={chip.state}
    >
      <div className="flex gap-4 items-center">
        {/* MSG-UI2: the thumbnail and the name open the same viewer as a sent file does. */}
        <button
          type="button"
          className="min-w-0 flex gap-4 items-center text-left"
          data-testid="draft-open"
          aria-label={t('messenger.attachmentOpen', { name: chip.name })}
          onClick={() => openViewer?.(draftPath(chip))}
        >
          {thumbnail && <img src={thumbnail} alt="" className="w-32 h-32 object-cover pointer-events-none" />}
          <span className="truncate max-w-128" title={chip.name}>
            {chip.name}
          </span>
        </button>
        <span className="text-text-muted shrink-0">{Math.ceil(chip.size / 1024)} KB</span>
        <button
          type="button"
          aria-label={t('messenger.attachmentRemove', { name: chip.name })}
          onClick={remove}
          disabled={chip.state === 'uploading'}
        >
          ×
        </button>
      </div>
      {chip.state === 'uploading' && (
        <progress
          aria-label={t('messenger.attachmentUpload', { name: chip.name })}
          value={chip.progress}
          max={100}
          className="w-full h-4"
        />
      )}
      {chip.error && (
        <p role="alert" className="text-danger">
          {chip.error}
        </p>
      )}
    </div>
  );
}

/** The files a lead sent that the server kept (the viewer's list); `unavailable` ones are left out. */
function sentFiles(item: ChatItem): ViewerFile[] {
  return (item.attachments ?? []).flatMap((file) =>
    file.path
      ? [{ path: file.path, name: file.name, type: file.type ?? '', sizeKb: file.sizeKb ?? 0 }]
      : [],
  );
}

/** A message's attachments as thumbnails and file chips; a tap opens the app's own viewer. */
function BubbleAttachments(props: {
  text: string;
  /** The files themselves (a lead's sent files, T-0105); absent: read from `[첨부]` lines in `text`. */
  attachments?: ViewerFile[];
  project?: string;
  projectRoot?: string;
  highlightQuery?: string;
  currentMatch?: boolean;
}) {
  const inGallery = useOpenAttachment();
  const ticketFor = useTicketFor(props.project, props.projectRoot);
  const files = useMemo(
    () => props.attachments ?? splitAttachmentText(props.text).attachments,
    [props.attachments, props.text],
  );
  const body = <BubbleAttachmentsBody {...props} />;
  // Outside a conversation (the work sheet) the bubble brings a viewer of its own files.
  return inGallery ? (
    body
  ) : (
    <AttachmentGallery files={files} ticketFor={ticketFor}>
      {body}
    </AttachmentGallery>
  );
}

function BubbleAttachmentsBody({
  text,
  attachments: given,
  project,
  projectRoot,
  highlightQuery,
  currentMatch,
}: {
  text: string;
  attachments?: ViewerFile[];
  project?: string;
  projectRoot?: string;
  highlightQuery?: string;
  currentMatch?: boolean;
}) {
  const { body, attachments } = useMemo(
    () => (given ? { body: text, attachments: given } : splitAttachmentText(text)),
    [given, text],
  );
  const [urls, setUrls] = useState<Record<string, string>>({});
  const targetFor = useAttachmentTarget(project, projectRoot);
  const openViewer = useOpenAttachment();
  useEffect(() => {
    let live = true;
    for (const file of attachments) {
      if (urls[file.path]) continue;
      const target = targetFor(file.path);
      if (!target || !file.type.startsWith('image/')) continue;
      rootFileTicket({ kind: 'project', project: target.project }, target.relative, 'preview')
        .then((url) => {
          if (live) setUrls((held) => ({ ...held, [file.path]: url }));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [attachments, targetFor, urls]);
  return (
    <>
      {body && (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          <HighlightedText text={body} query={highlightQuery} current={currentMatch} />
        </p>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-4 mt-4">
          {attachments.map((file) => (
            <button
              key={file.path}
              type="button"
              title={file.path}
              className="border border-border px-4 py-2 text-xs max-w-160 truncate"
              onClick={() => openViewer?.(file.path)}
            >
              {file.type.startsWith('image/') && urls[file.path] ? (
                <img src={urls[file.path]} alt={file.name} className="w-64 h-64 object-contain" />
              ) : (
                <>▤ {file.name}</>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ── MSG-ACTIONS: 복사 and 답글 on every bubble ──────────────────────

/** 복사: the clipboard module's one write, its outcome as a short toast (why, when it fails). */
function copyMessage(text: string): void {
  void writeClipboardText(text).then((ok) =>
    cldToast(
      t('messenger.title'),
      ok ? t('messenger.copied') : t('messenger.copyFailed'),
      ok ? 'ok' : 'error',
      ok ? ATTACHMENT_ACTION_SUCCESS_DURATION : ATTACHMENT_ACTION_ERROR_DURATION,
    ),
  );
}

/** What a bubble offers: its copy text, and 답글 when the conversation can reply. */
interface BubbleActions {
  copy: string;
  reply?: () => void;
}

/** A phone's hold on a bubble: one finger, still (the app's one tap slop), for
 *  MESSAGE_ACTIONS_LONG_PRESS_MS. A scroll cancels it (pointercancel or a move); links,
 *  buttons, images and fields keep their own touch. The click a fired hold ends with is eaten. */
/** F2: a gesture belongs to the innermost bubble (a room member's reply sits inside the post's):
 *  its press claims the native event on the way up, and the outer ones skip it. */
const claimed = new WeakSet<Event>();

function useLongPress(fire: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    origin.current = null;
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      fired.current = false;
      if (e.pointerType !== 'touch') return;
      const target = e.target as Element;
      if (target.closest('a,img,input,textarea,button:not([data-press-through])')) return;
      if (claimed.has(e.nativeEvent)) return;
      claimed.add(e.nativeEvent);
      origin.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        origin.current = null;
        fired.current = true;
        fire();
      }, MESSAGE_ACTIONS_LONG_PRESS_MS);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const o = origin.current;
      if (o && !withinTapSlop(e.clientX - o.x, e.clientY - o.y)) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: ReactMouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/** Desktop: 복사 · 답글 beside the time, shown on hover or keyboard focus (a phone holds instead). */
function ActionRow({
  actions,
  post = false,
  before = false,
}: {
  actions: BubbleActions;
  post?: boolean;
  /** MSG-ALIGN: left of the time (the boss's side), so the time stays on the bubble's right edge. */
  before?: boolean;
}) {
  return (
    <span
      className={`${before ? 'mr-6' : 'ml-6'} inline-flex gap-6 opacity-0 ${post ? 'group-hover/post:opacity-100' : 'group-hover/msg:opacity-100'} focus-within:opacity-100 pointer-coarse:hidden`}
      role="group"
      aria-label={t('messenger.messageActions')}
      data-testid="message-actions"
    >
      <button
        type="button"
        className="underline text-accent-text"
        onClick={() => copyMessage(actions.copy)}
      >
        {t('messenger.copy')}
      </button>
      {actions.reply && (
        <button type="button" className="underline text-accent-text" onClick={actions.reply}>
          {t('messenger.reply')}
        </button>
      )}
    </span>
  );
}

/** Phone: the action sheet a held bubble opens, above everything (a portal on document.body). */
function ActionSheet({ actions, close }: { actions: BubbleActions; close: () => void }) {
  const run = (act: () => void) => {
    close();
    act();
  };
  return createPortal(
    <div className="fixed inset-0 z-[84] flex flex-col justify-end" data-testid="message-sheet">
      <div className="absolute inset-0 bg-black/50" onClick={close} aria-hidden="true" />
      <div
        role="menu"
        aria-label={t('messenger.messageActions')}
        className="relative pixel-panel flex flex-col text-sm pb-[var(--cld-safe-bottom)]"
      >
        <button
          type="button"
          role="menuitem"
          autoFocus
          className="min-h-52 px-16 text-left border-b border-border"
          onClick={() => run(() => copyMessage(actions.copy)) /* still in the tap's gesture */}
        >
          {t('messenger.copy')}
        </button>
        {actions.reply && (
          <button
            type="button"
            role="menuitem"
            className="min-h-52 px-16 text-left border-b border-border"
            onClick={() => run(actions.reply!)}
          >
            {t('messenger.reply')}
          </button>
        )}
        <button type="button" className="min-h-52 px-16 text-left" onClick={close}>
          {t('common.cancel')}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** The quote a reply bubble shows above its text: a tap goes to the original. */
function ReplyQuote({ reply, open }: { reply: ChatReply; open?: (id: string) => void }) {
  const sender = reply.sender ? serverLine(reply.sender) : t('messenger.replyYou');
  return (
    <button
      type="button"
      data-testid="reply-quote"
      data-reply-id={reply.id}
      disabled={!open}
      aria-label={t('messenger.replyQuote', { text: `${sender}: ${reply.text}` })}
      className="block w-full min-w-0 max-w-full text-left border-l-2 border-accent pl-6 mb-4 text-2xs text-text-muted truncate enabled:hover:text-text"
      onClick={() => open?.(reply.id)}
    >
      ↩ <strong>{sender}</strong> {reply.text}
    </button>
  );
}

/** The composer's reply chip: `↩ <sender> · <text…>` and ✕. */
function ReplyChip({ reply, cancel }: { reply: ChatReply; cancel: () => void }) {
  return (
    <div
      className="mb-6 flex items-center gap-8 border-l-2 border-accent bg-bg-dark px-8 py-2 text-xs"
      role="status"
      aria-label={t('messenger.replyChip')}
      data-testid="reply-chip"
    >
      <span className="flex-1 min-w-0 truncate">
        {replyChipText(reply, t('messenger.replyYou'))}
      </span>
      <button
        type="button"
        aria-label={t('messenger.replyCancel')}
        className="shrink-0 px-4 pointer-coarse:min-h-44 pointer-coarse:min-w-44"
        onClick={cancel}
      >
        ✕
      </button>
    </div>
  );
}

/** Wraps a bubble root: the hold and the sheet. */
function Actionable({
  actions,
  className,
  children,
  as: Tag = 'div',
  ...data
}: {
  actions: BubbleActions;
  className?: string;
  children: ReactNode;
  as?: 'div' | 'article';
} & Record<`data-${string}`, string | undefined>) {
  const [sheet, setSheet] = useState(false);
  const press = useLongPress(() => setSheet(true));
  return (
    <Tag
      // On a phone a hold opens our sheet only: no native text selection spreading over the page
      // and no iOS/Android callout on top of it (owner 10-24 18:57).
      className={`${Tag === 'article' ? 'group/post' : 'group/msg'} pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] ${className ?? ''}`}
      onContextMenu={(e) => {
        if (window.matchMedia('(pointer: coarse)').matches) e.preventDefault();
      }}
      {...data}
      {...press}
    >
      {children}
      {sheet && <ActionSheet actions={actions} close={() => setSheet(false)} />}
    </Tag>
  );
}

/** BUBBLE-TAIL + MSG-ALIGN: the bubble sits on the guide line; on a run's first bubble the pixel tail
 *  pokes out of its corner toward the face (look: `.bubble-tail` in index.css). */
const BUBBLE_TAIL_COLORS = {
  lead: '[--tail-border:var(--color-border)] [--tail-fill:var(--color-bg)]',
  peer: '[--tail-border:var(--color-peer-border)] [--tail-fill:var(--color-peer-bg)]',
  boss: '[--tail-border:var(--color-accent)] [--tail-fill:var(--color-active-bg)]',
} as const;

function BubbleBox({
  side,
  tail,
  kind,
  children,
}: {
  side: 'l' | 'r' | null;
  tail: boolean;
  kind: keyof typeof BUBBLE_TAIL_COLORS;
  children: ReactNode;
}) {
  if (!side) return <>{children}</>;
  return (
    <div className={`bubble-box ${BUBBLE_TAIL_COLORS[kind]}`}>
      {children}
      {tail && <span className={`bubble-tail bubble-tail-${side}`} aria-hidden="true" data-testid="bubble-tail" />}
    </div>
  );
}

export function Line({
  item,
  received,
  project,
  projectRoot,
  highlightQuery,
  currentMatch = false,
  replyAs,
  onReply,
  onQuote,
  face,
}: {
  item: ChatItem;
  received: boolean;
  project?: string;
  projectRoot?: string;
  highlightQuery?: string;
  currentMatch?: boolean;
  /** MSG-ACTIONS: who an assistant item is from, in a reply's quote (the lead or room member). */
  replyAs?: string;
  /** MSG-ACTIONS: 답글 on this bubble; absent: copy only (the work sheet). */
  onReply?: (reply: ChatReply) => void;
  /** MSG-ACTIONS: a reply's quote was tapped: go to the original. */
  onQuote?: (id: string) => void;
  /** MSG-UI2: the sender's face beside the bubble (`show`: this message starts a run; later ones
   *  keep the column empty so the bubbles line up). Absent: no face column. */
  face?: { show: boolean; name: string };
}) {
  const [open, setOpen] = useState(false);
  const { tempStaff } = useCldStore();
  const copy = copyText(item);
  const actions: BubbleActions = {
    copy,
    ...(onReply && {
      reply: () => onReply(replyDraft(replyIdOf(item), replySenderOf(item, replyAs ?? ''), copy)),
    }),
  };
  const sent = useMemo(() => sentFiles(item), [item]);
  const targetFor = useAttachmentTarget(project, projectRoot);
  const openViewer = useOpenAttachment();
  if (item.kind === 'tool') {
    return (
      // On the bubbles' left line: past the sender's face column.
      <details className={`${FACE_GUTTER_LEFT} text-xs text-text-muted`}>
        <summary className="cursor-pointer truncate">{toolLineLabel(item, ezContext())}</summary>
        <p className="pl-16 break-all">{item.text}</p>
      </details>
    );
  }
  if (item.kind === 'result') {
    // A tool's output (the work view only), trimmed on the server.
    return (
      <details className={`${FACE_GUTTER_LEFT} text-2xs text-text-muted pl-16`}>
        <summary className="cursor-pointer">{t('messenger.result')}</summary>
        <pre className="[font-family:inherit] whitespace-pre-wrap break-all">{item.text}</pre>
      </details>
    );
  }
  const shell = shellDone(item);
  if (shell) {
    // One of the lead's command lines, folded like the others: the notice's text inside.
    return (
      <details
        className={`${FACE_GUTTER_LEFT} text-xs ${shell.code ? 'text-danger' : 'text-text-muted'}`}
        data-testid="shell-done"
        data-failed={shell.code ? 'true' : undefined}
      >
        <summary className="cursor-pointer truncate">
          {shell.code === null || shell.code === 0 ? '⏰' : '⚠️'}{' '}
          {t(shell.code ? 'messenger.shellFailed' : 'messenger.shellDone', { desc: shell.desc, code: shell.code ?? 0 })}
        </summary>
        <p className="pl-16 break-all whitespace-pre-wrap">{item.text.replaceAll('**', '')}</p>
      </details>
    );
  }
  const user = item.kind === 'user';
  if (user && item.from === 'system') {
    // A notice (Codex, recovery, an unnamed sender): one muted line, not a bubble. Tap to read it whole.
    return (
      <Actionable
        actions={actions}
        className="flex justify-center items-baseline gap-4 text-2xs text-text-muted"
        data-from="system"
      >
        <button
          type="button"
          data-press-through
          className={`text-left min-w-0 ${open ? 'whitespace-pre-wrap break-words' : 'truncate'}`}
          aria-expanded={open}
          title={item.text}
          onClick={() => setOpen((v) => !v)}
        >
          {item.text}
        </button>
        {item.at > 0 && (
          <time className="shrink-0" dateTime={new Date(item.at).toISOString()}>
            · {bubbleClock(item.at)}
          </time>
        )}
        <ActionRow actions={actions} />
      </Actionable>
    );
  }
  const peer = user && item.from === 'peer';
  const visibleText = user ? splitAttachmentText(item.text).body : item.text;
  const lines = visibleText.split('\n');
  const long = lines.length > FOLD_LINES || visibleText.length > FOLD_CHARS;
  const shown =
    long && !open ? `${lines.slice(0, FOLD_LINES).join('\n').slice(0, FOLD_CHARS)}…` : visibleText;
  const quote = user && item.replyTo && <ReplyQuote reply={item.replyTo} open={onQuote} />;
  const faced = face && (peer || !user) ? face : null;
  // MSG-UI3: the boss gets the mirror column, so every bubble has one width.
  const bossFaced = face && user && !peer ? face : null;
  const inner = (
    <>
      {peer && (!faced || faced.show) && (
        <span className="text-2xs text-peer-name max-w-full truncate" data-testid="from-name">
          {item.fromName && noticeName(serverLine(item.fromName), noticeEmployee(item, tempStaff))}
        </span>
      )}
      {/* A run's first bubble names its side next to the face, the lead's and the boss's alike (owner 10-24 23:28). */}
      {!user && faced?.show && (
        <span className="block text-2xs text-peer-name max-w-full truncate" data-testid="from-name">
          {faced.name}
        </span>
      )}
      {bossFaced?.show && (
        <span className="text-2xs text-text-muted max-w-full truncate" data-testid="from-name">
          {t('msgui3.me')}
        </span>
      )}
      <BubbleBox
        side={faced ? 'l' : bossFaced ? 'r' : null}
        tail={!!(faced ?? bossFaced)?.show}
        kind={peer ? 'peer' : user ? 'boss' : 'lead'}
      >
      {user ? (
        <div
          className={`text-sm px-8 py-4 border max-w-full ${peer ? 'border-peer-border bg-peer-bg overflow-hidden' : 'border-accent bg-active-bg'}`}
        >
          {quote}
          {peer ? (
            // Another agent's words (an orchestrator, a task notice): Markdown, like a lead's reply.
            <Markdown text={shown} highlightQuery={highlightQuery} currentMatch={currentMatch} />
          ) : (
            <BubbleAttachments
              text={
                item.text === visibleText ? shown : `${shown}${item.text.slice(visibleText.length)}`
              }
              project={project}
              projectRoot={projectRoot}
              highlightQuery={highlightQuery}
              currentMatch={currentMatch}
            />
          )}
        </div>
      ) : item.attachments?.length ? (
        // Files the lead sent (T-0105): its caption, then thumbnails and chips; what could not be kept is a plain line.
        <div className="text-sm px-8 py-4 border border-border max-w-full overflow-hidden space-y-4">
          {shown && (
            <Markdown
              text={shown}
              highlightQuery={highlightQuery}
              currentMatch={currentMatch}
              projectRoot={projectRoot}
              fileLink={(path) => !!targetFor(path)}
              onOpenFile={openViewer ?? undefined}
            />
          )}
          <BubbleAttachments
            text=""
            attachments={sent}
            project={project}
            projectRoot={projectRoot}
          />
          {item.attachments
            .filter((file) => file.unavailable)
            .map((file, i) => (
              <p key={i} className="text-xs text-text-muted break-all">
                {t('messenger.fileUnavailable', { name: file.name })}
              </p>
            ))}
        </div>
      ) : (
        // The leads write Markdown (bold, tables, code); the boss's own lines stay plain.
        <Markdown
          text={shown}
          className="text-sm px-8 py-4 border border-border max-w-full overflow-hidden"
          highlightQuery={highlightQuery}
          currentMatch={currentMatch}
          projectRoot={projectRoot}
          fileLink={(path) => !!targetFor(path)}
          onOpenFile={openViewer ?? undefined}
        />
      )}
      </BubbleBox>
      {long && (
        <button
          type="button"
          className="text-2xs text-accent-text mt-2"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t('messenger.collapse') : t('messenger.showMore')}
        </button>
      )}
      <span className="text-2xs text-text-muted">
        {/* The boss's side mirrors the lead's: copy/답글 sit left of the time (MSG-ALIGN). */}
        {user && !peer && <ActionRow actions={actions} before />}
        {item.at > 0 && (
          <time dateTime={new Date(item.at).toISOString()}>{bubbleClock(item.at)}</time>
        )}
        {item.at > 0 && received && <span aria-hidden="true"> · </span>}
        {received && <span>{t('messenger.received')}</span>}
        {!(user && !peer) && <ActionRow actions={actions} />}
      </span>
    </>
  );
  return (
    <Actionable
      actions={actions}
      className={
        faced
          ? `${FACE_GUTTER_RIGHT} flex items-start ${FACE_GAP}`
          : bossFaced
            ? `${FACE_GUTTER_LEFT} flex items-start ${FACE_GAP}`
            : peer
            ? 'mr-24 flex flex-col items-start'
            : user
              ? 'ml-24 flex flex-col items-end'
              : 'mr-24'
      }
      data-from={user ? (peer ? 'peer' : 'boss') : undefined}
    >
      {faced ? (
        <>
          {faced.show ? (
            <SenderFace name={faced.name} employee={peer ? noticeEmployee(item, tempStaff) : undefined} />
          ) : (
            <span className={`shrink-0 ${FACE_COLUMN}`} aria-hidden="true" />
          )}
          {/* A column, so 더보기 and the time start their own lines on the guide line (MSG-ALIGN). */}
          <div className="min-w-0 flex-1 flex flex-col items-start">{inner}</div>
        </>
      ) : bossFaced ? (
        <>
          <div className="min-w-0 flex-1 flex flex-col items-end">{inner}</div>
          {bossFaced.show ? <OwnerFace /> : <span className={`shrink-0 ${FACE_COLUMN}`} aria-hidden="true" />}
        </>
      ) : (
        inner
      )}
    </Actionable>
  );
}

function Pending({
  p,
  agentId,
  sendNow,
  edit,
  cancel,
  approve,
  editingHere,
  project,
  projectRoot,
  permissionWait,
}: {
  p: PendingSend;
  /** PERM-PROMPT: its lead waits on a permission dialog: a waiting message says why. */
  permissionWait?: boolean;
  agentId: number;
  sendNow: () => void;
  approve: () => void;
  /** This bubble is in the composer right now (its hold is shown there). */
  editingHere: boolean;
  edit: () => void;
  cancel: () => void;
  project?: string;
  projectRoot?: string;
}) {
  const failed = p.state === 'failed';
  const cancelled = p.state === 'cancelled';
  const waiting = p.state === 'queued' || p.state === 'sending';
  const actions = p.state === 'queued' && p.queueId && !p.editing && !p.cancelling;
  return (
    <div className={`${FACE_GUTTER_LEFT} flex items-start ${FACE_GAP}`} data-testid="pending" data-state={p.state}>
      <div className="min-w-0 flex-1 flex flex-col items-end">
      <div
        className={`text-sm whitespace-pre-wrap [overflow-wrap:anywhere] min-w-0 max-w-full px-8 py-4 border border-dashed ${failed ? 'border-danger' : cancelled ? 'border-border text-text-muted opacity-60' : 'border-accent'}`}
      >
        {p.replyTo && <ReplyQuote reply={p.replyTo} />}
        <BubbleAttachments text={p.text} project={project} projectRoot={projectRoot} />
      </div>
      <span className={`text-2xs ${failed ? 'text-danger' : 'text-text-muted'}`} role="status">
        {failed ? (p.error ?? sendLabel('failed')) : sendLabel(p.state)}
        {p.edited && !cancelled && t('messenger.editedSuffix')}
        {waiting && p.now && t('messenger.nowSuffix')}
        {p.state === 'queued' && permissionWait && t('permPrompt.queued')}
        {/* MSG-HOLD2: which decision applies to this message */}
        {p.state === 'queued' && p.held && !editingHere && t('messenger.heldSuffix')}
        {p.state === 'queued' &&
          !p.held &&
          p.holdNote === 'editCancelled' &&
          t('messenger.editCancelledSuffix')}
        {p.state === 'queued' &&
          !p.held &&
          p.holdNote === 'approved' &&
          t('messenger.approvedSuffix')}
        {p.state === 'queued' &&
          p.held &&
          !editingHere &&
          p.queueId &&
          !p.editing &&
          !p.cancelling && (
            <button
              type="button"
              className="ml-8 underline text-accent-text pointer-coarse:min-h-44"
              onClick={approve}
            >
              {t('messenger.approveOriginal')}
            </button>
          )}
        {p.state === 'queued' &&
          p.queueId &&
          !p.now &&
          !p.held &&
          !p.text.trimStart().startsWith('/') && (
            <button
              type="button"
              className="ml-8 underline text-accent-text pointer-coarse:min-h-44"
              disabled={p.promoting}
              onClick={sendNow}
            >
              {t('messenger.sendImmediately')}
            </button>
          )}
        {actions && (
          // Always shown, on the phone too: a queued message can be sent now, edited or cancelled (10-24 02:48).
          <span className="ml-8 gap-6 inline-flex">
            <button
              type="button"
              className="underline text-accent-text pointer-coarse:min-h-44"
              onClick={edit}
            >
              {p.held && !editingHere ? t('messenger.continueEdit') : t('messenger.edit')}
            </button>
            <button
              type="button"
              className="underline text-danger pointer-coarse:min-h-44"
              onClick={cancel}
            >
              {t('common.cancel')}
            </button>
          </span>
        )}
        {(p.editing || p.cancelling) && t('messenger.processingSuffix')}
        {p.refusal && <span className="ml-8 text-danger">{p.refusal}</span>}
        {failed && (
          <button
            type="button"
            className="ml-8 underline"
            onClick={() => dismissSend(agentId, p.requestId)}
          >
            {t('messenger.dismiss')}
          </button>
        )}
      </span>
      </div>
      <span className={`shrink-0 ${FACE_COLUMN}`} aria-hidden="true" />
    </div>
  );
}
