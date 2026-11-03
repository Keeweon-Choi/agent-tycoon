/** Messenger group room composer and thread posts. */
 
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatReply, GroupPostItem, GroupRoom } from '../../../../../core/src/messages.js';
import { Button } from '../../../components/ui/Button.js';
import { ATTACH_ACCEPT } from '../../../constants.js';
import { t } from '../../../i18n/index.js';
import { transport } from '../../../transport/index.js';
import { CHAT_SEND_MAX } from '../../chat.js';
import { FOCUS_MS } from '../../notify/openTarget.js';
import { cldOwnToast, useCldStore } from '../../officeStore.js';
import { serverLine } from '../../serverText.js';
import { requestStaleRecheck } from '../../staleBuild.js';
import { draftViewerFiles, useDraftTicketFor, useTicketFor } from '../attachmentGallery.js';
import {
  composeAttachmentText,
  fileChip,
  MAX_ATTACHMENTS,
  splitAttachmentText,
  uploadAttachment,
  uploadChips,
} from '../attachments.js';
import { AttachmentGallery } from '../AttachmentViewer.js';
import { BubbleAttachments, DraftChip } from '../BubbleAttachments.js';
import { OwnerFace, SenderFace } from '../Faces.js';
import { Actionable, ActionRow, type BubbleActions, Line, ReplyChip, ReplyQuote } from '../Line.js';
import { messageCharacterCount, prepareMessage } from '../longMessage.js';
import { copyText, replyDraft } from '../messageActions.js';
import { setGroupAttachments, useMessenger } from '../messengerStore.js';
import { NO_CHIPS } from '../parts.js';
import {
  canonicalizeMentions,
  chooseMention,
  filterMentions,
  mentionAt,
  mentionDisplay,
  replyPrefill,
} from '../roomMentions.js';
import { enterSends, isTouchDevice } from '../sendKey.js';
import { RoomEditor } from './RoomEditor.js';

export function GroupRoomRow({
  room,
  allMembers,
  manage = true,
}: {
  room: GroupRoom;
  allMembers: string[];
  /** The room's admin buttons are shown (the screen's 방 관리 button opens them). */
  manage?: boolean;
}) {
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
      cldOwnToast(t('messenger.title'), t('messenger.replyNotFound'), 'info');
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
  const viewerFiles = useMemo(
    () => [...galleryFiles, ...draftViewerFiles(chips)],
    [galleryFiles, chips],
  );
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
      // Attachments are saved into one room member's inbox; the absolute path is shared in the room record.
      const result = await uploadChips(uploaded, {
        upload: (chip, progress) =>
          uploadAttachment(room.members[0], chip, crypto.randomUUID(), progress),
        onChange: (next) => setGroupAttachments(room.id, next),
      });
      if (!result.ok) return;
      uploaded = result.chips;
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
    <div className="flex-1 flex flex-col">
      <AttachmentGallery files={viewerFiles} ticketFor={viewerTicketFor}>
        <div className="flex-1 flex flex-col px-8 pb-8 space-y-6 text-xs">
          {manage && !officeReadOnly && room.id !== 'all' && (
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
          {/* UI-FIX 1: the composer sits at the bottom of the pane, as in a DM, also while
              the room is short (it followed the last post, mid-screen). */}
          <div className="mt-auto sticky bottom-0 bg-bg pt-6 space-y-6">
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
                    onChange={(event) =>
                      edit(event.target.value, event.currentTarget.selectionStart)
                    }
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
          {!officeReadOnly && (
            <p className="truncate text-text-muted" data-testid="room-hint">
              {t('uiFix.roomHint')}
            </p>
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
        </div>
      </AttachmentGallery>
    </div>
  );
}

/** MSG-UI3: a room thread's rail, one colour each (static class names, so Tailwind sees them). */
const THREAD_TONES = [
  'border-l-thread-1',
  'border-l-thread-2',
  'border-l-thread-3',
  'border-l-thread-4',
];

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
        {post.notice ? (
          <span data-testid="room-mode">
            {t('room.mode.notice', {
              done: post.targets.filter((member) => post.delivery[member] === 'delivered').length,
              total: post.targets.length,
            })}
          </span>
        ) : (
          post.targets.length > 0 && <span data-testid="room-mode">{t('room.mode.now')}</span>
        )}
        {!post.notice &&
          post.targets.map((member) => (
          <span key={member} className="border border-border px-4">
            {member}: {delivery(post.delivery[member])}
          </span>
        ))}
        <ActionRow actions={actions} post />
      </p>
      {post.replies.map(
        (reply) =>
          // Owner 11-01 10:22: a room shows the members' words only, never their tool lines.
          reply.items.some((i) => i.kind === 'assistant') && (
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
                {reply.items
                  .filter((i) => i.kind === 'assistant')
                  .map((item) => (
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
