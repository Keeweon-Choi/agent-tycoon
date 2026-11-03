/** Messenger group room list and conversation. */
 
import { useContext, useEffect, useState } from 'react';

import type { GroupRoom } from '../../../../../core/src/messages.js';
import { Button } from '../../../components/ui/Button.js';
import { t } from '../../../i18n/index.js';
import { transport } from '../../../transport/index.js';
import { useCldStore } from '../../officeStore.js';
import { serverLine } from '../../serverText.js';
import { SenderFace } from '../Faces.js';
import { MessengerLooks } from '../looksContext.js';
import {
  conversationSections,
  roomCandidates,
  roomKey,
  showRoom,
  unreadCount,
  useMessenger,
} from '../messengerStore.js';
import { clock, Mug, PaneClose, PinButton, StateDot } from '../parts.js';
import { useKeepPlace } from '../useKeepPlace.js';
import { GroupRoomRow } from './GroupRoomRow.js';
import { RoomEditor } from './RoomEditor.js';

function RoomSubscription({ roomId }: { roomId: string }) {
  useEffect(() => {
    transport.send({ type: 'groupView', room: roomId, on: true });
    return () => transport.send({ type: 'groupView', room: roomId, on: false });
  }, [roomId]);
  return null;
}
/** Room records are deliberately fetched only when expanded, like transcripts. */
export function GroupRooms() {
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

export function RoomConversation({ room, onClose }: { room: GroupRoom; onClose?: () => void }) {
  const { rooms, contacts } = useMessenger();
  const allMembers = roomCandidates(rooms, contacts);
  const { list, content, onScroll } = useKeepPlace();
  const [showMembers, setShowMembers] = useState(false);
  const [manage, setManage] = useState(false);
  const { officeReadOnly } = useCldStore();
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
        {/* UI-FIX 1: rename, members, system lines and delete fold under one button, so the
            conversation is not led by a row of admin buttons (and a red 방 삭제). */}
        {!officeReadOnly && room.id !== 'all' && (
          <Button
            size="sm"
            variant={manage ? 'active' : 'default'}
            aria-expanded={manage}
            data-testid="room-manage"
            onClick={() => setManage((v) => !v)}
          >
            {t('uiFix.roomManage')}
          </Button>
        )}
        {onClose && (
          <span className="ml-auto">
            <PaneClose onClose={onClose} />
          </span>
        )}
      </header>
      {showMembers && <RoomMemberList members={room.members} />}
      <div
        ref={list}
        onScroll={onScroll}
        data-testid="room-scroll"
        className="flex-1 min-h-0 overflow-y-auto"
      >
        <div ref={content} className="min-h-full flex flex-col">
          <GroupRoomRow room={room} allMembers={allMembers} manage={manage} />
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
    return (
      <p className="px-8 py-6 text-xs text-text-muted border-b border-border">
        {t('messenger.noMembers')}
      </p>
    );
  return (
    <ul
      aria-label={t('messenger.members')}
      data-testid="member-list"
      className="shrink-0 max-h-[40%] overflow-y-auto border-b border-border"
    >
      {members.map((name) => {
        const c = contacts.find((x) => x.name === name);
        return (
          <li
            key={name}
            className="flex items-center gap-8 px-8 py-4 border-t border-border first:border-t-0"
          >
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
