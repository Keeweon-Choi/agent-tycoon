import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { isGoneName } from '../../../../../core/src/agent-tycoon/goneAgent.js';
import type { ChatItem, SlashCommand } from '../../../../../core/src/messages.js';
import { Button } from '../../../components/ui/Button.js';
import { Modal } from '../../../components/ui/Modal.js';
import { ATTACH_ACCEPT, QUOTE_PEEK_MAX_PX } from '../../../constants.js';
import { useIsMobile } from '../../../hooks/useIsMobile.js';
import { t } from '../../../i18n/index.js';
import { transport } from '../../../transport/index.js';
import { CHAT_SEND_MAX, chatTarget, readOnlyNote, requestChat } from '../../chat.js';
import { DevroomLink } from '../../devroom/DevRoom.js';
import { capsOf, takesDirectChat } from '../../engine.js';
import { useEngineStore } from '../../engineStore.js';
import { FatigueBar } from '../../ez/Fatigue.js';
import { basisHint } from '../../ez/fatigueState.js';
import { kTokens } from '../../ez/statCardRows.js';
import { TerminalGlyph } from '../../hud/glyphs.js';
import { Icon } from '../../icons/Icon.js';
import { ezContext, fatigueFor, useAgtyStore } from '../../officeStore.js';
import { serverLine, serverText } from '../../serverText.js';
import { requestStaleRecheck } from '../../staleBuild.js';
import { useWaitReasons } from '../../waiting.js';
import { WaitMark } from '../../WaitMark.js';
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
import { DraftChip, sentFiles } from '../BubbleAttachments.js';
import { keepPhoneComposerFocus } from '../composerFocus.js';
import { composerHeight } from '../composerGrow.js';
import { SenderFace } from '../Faces.js';
import { placeRecords, questionText, setTypewriter, useTypewriter } from '../gameMessenger.js';
import { shownName } from '../goneNames.js';
import { Library } from '../Library.js';
import { Line, QuotePeek, ReplyChip } from '../Line.js';
import { messageCharacterCount, prepareMessage } from '../longMessage.js';
import {
  dividerAfter,
  heldNote,
  messengerApproveHeld,
  messengerCancel,
  messengerDeleteGone,
  messengerEditEnter,
  messengerEditLostClear,
  messengerEditSave,
  messengerSend,
  messengerSendNow,
  setAttachments,
  startsEarlierSession,
  useMessenger,
} from '../messengerStore.js';
import {
  dayLabel,
  type MessengerProps,
  newDay,
  nextRequestId,
  NO_CHIPS,
  PaneClose,
  SearchHitRow,
  sessionClock,
  StateDot,
  useRow,
} from '../parts.js';
import { Pending } from '../Pending.js';
import { PermissionCard, QuestionCard, QuestRecordLine } from '../PermissionCard.js';
import { peekView } from '../quotePeek.js';
import { jumpLabel } from '../scrollJump.js';
import { senderKey, startsRun } from '../senderFace.js';
import { chordStep, enterSends, enterSendsNow, isTouchDevice } from '../sendKey.js';
import { filterSlashCommands, slashComplete, slashMenuKey } from '../slashMenu.js';
import { StaleCliBand } from '../StaleCliBand.js';
import { Thinking } from '../Thinking.js';
import { toolRuns } from '../toolFold.js';
import { ToolRun } from '../ToolRun.js';
import { useChatSearch } from './useChatSearch.js';
import { useDraft } from './useDraft.js';
import { useHistoryJump } from './useHistoryJump.js';
import { useQuestionTag } from './useQuestionTag.js';
import { useReturnMark } from './useReturnMark.js';
import { useStickToBottom } from './useStickToBottom.js';

export function Conversation({
  agentId,
  visualViewportHeight,
  statusFor,
  onClose,
  pane,
}: {
  agentId: number;
  onClose?: () => void;
  /** DEVROOM-PANE-CHAT: inside a 개발실 pane, whose head names the agent: no head here, and the
   *  permission card's 터미널에서 보기 switches that pane (null: it has no terminal). */
  pane?: { onTerminal: (() => void) | null };
} & Omit<MessengerProps, 'mobile'>) {
  const store = useAgtyStore();
  const m = useMessenger();
  const row = useRow(agentId);
  const engine = useEngineStore().state;
  const contact = m.contacts.find((c) => c.agentId === agentId);
  const name = contact?.name ?? row?.name ?? `#${agentId}`;
  // PROJECT-DATA: a removed agent's conversation: shown as "(알 수 없음)", read-only, deletable.
  const gone = isGoneName(name);
  const shown = shownName(name);
  const [askDelete, setAskDelete] = useState(false);
  const projectRoot =
    engine?.projects.find((project) => project.name === name)?.folder ??
    (row && 'dir' in row ? row.dir : undefined);
  const chips = m.attachments[agentId] ?? NO_CHIPS;
  const items = m.items[agentId];
  // GAME-UI-1 G1 (01): what this view loaded first is history (shown at once); only the newest lead
  // line that came in after it is fresh (it may type in, and carries ▼).
  const [history, setHistory] = useState<Set<string> | null>(null);
  if (items && !history) setHistory(new Set(items.map((i) => i.id)));
  const newest = items && [...items].reverse().find((i) => i.kind === 'assistant');
  const freshId = newest && history && !history.has(newest.id) ? newest.id : undefined;
  const typewriter = useTypewriter();
  const waitWhy = useWaitReasons()[agentId];
  const answer = m.permissionAnswers[agentId];
  const records = m.questRecords[agentId];
  // The record of the card still showing its stamp joins the conversation once that card has folded,
  // or at once when another call's card has taken its place.
  const stamping =
    answer && !answer.folded && (contact?.permission?.toolId ?? answer.toolId) === answer.toolId
      ? answer.toolId
      : undefined;
  const placed = useMemo(
    () =>
      records?.length && items
        ? placeRecords(
            items.map((i) => i.at),
            records.filter((r) => r.toolId !== stamping),
          )
        : null,
    [records, items, stamping],
  );
  const formRef = useRef<HTMLFormElement>(null);
  // U-25: a cancelled queued message keeps its data in the store but is not shown.
  const pending = (m.pending[agentId] ?? []).filter((p) => p.state !== 'cancelled');
  const received = m.received[agentId] ?? [];
  const canSend = m.canSend[agentId] ?? contact?.canSend ?? false;
  // D5 (MVP): a 'run' agent takes work from its Lead or a room, not a person's DM.
  const noDirectChat = !takesDirectChat(capsOf(engine, engine?.projects.find((project) => project.name === name)?.provider));
  const typing = row?.busy === true;
  // RENEW-STUCK: its messages wait for the new conversation (즉시 cannot reach the old one).
  const renewing = row?.renewing === true;
  // K1 (B4): its last renew could not start the new conversation; the next start does.
  const renewFailed = row?.renewFailed === true;
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
  const readerAnchor = useRef<{ id: string; top: number } | null>(null);
  const restoring = useRef(false);
  const savedTop = useRef(0);
  // Newest follows only while at the bottom. Away from it, keep the reader's
  // top visible row fixed as messages, tool lines, and the typing line update.
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const { mark, remember, moved, watch, goBack } = useReturnMark(list);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const { sentinel, historyBusy, historyDone, full, fetchOlder, openQuote, jumpToHit } =
    useHistoryJump({ agentId, m, items, list, restoring, stuck, setAway, remember });
  const {
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    searched,
    setSearched,
    activeResult,
    setActiveResult,
    listOpen,
    setListOpen,
    hits,
    clearSearch,
    search,
    stepResult,
  } = useChatSearch({ agentId, m, jumpToHit });
  const { openTag } = useQuestionTag({ agentId, m, list, jumpToHit, clearSearch });
  const box = useRef<HTMLTextAreaElement>(null);
  const {
    text,
    setText,
    reply,
    setReply,
    editRestore,
    parkReply,
    pendingEdit,
    peekOn,
    peekDo,
    pendingReply,
    edit,
    leavePendingEdit,
  } = useDraft({ agentId, m, row, name, pending, openQuote, box });
  // T-0111: one line to start with, growing with the text up to 8 lines (a third of the
  // screen on a phone), then scrolling inside; empty after sending, it shrinks back.
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
      // The viewer a chip opened is part of the composer's gesture: its ✕ or its image must not
      // collapse the box behind it (COMPOSE-PREVIEW).
      if ((e.target as Element).closest?.('.attach-viewer')) return;
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
  /** Phones: no Ctrl+Enter, so 즉시 is a button (under the text box, UI-PHONE). */
  const touch = isTouchDevice();
  // GAME-UI-1 G1 (02): the daemon's wait while it lasts (the agent still waits, so the card and its
  // buttons stay), or the one just answered while its stamp shows (then it folds).
  const questCard =
    contact?.permission ?? (answer?.result === 'answered' && !answer.folded ? answer.card : undefined);
  const keepComposerFocus = (event: ReactPointerEvent<HTMLButtonElement>) =>
    keepPhoneComposerFocus(phone, event);
  const attachButton = (
    <Button
      type="button"
      size="sm"
      disabled={uploading || chips.length >= MAX_ATTACHMENTS}
      onPointerDown={keepComposerFocus}
      onClick={chooseAttachments}
    >
      <Icon name="paperclip" size={16} pixel={<span className="material-symbols-sharp text-[16px]" aria-hidden="true">
        attach_file
      </span>} />
      {t('messenger.attach')}
    </Button>
  );
  /** When Ctrl+X armed the Ctrl+X Ctrl+S chord. */
  const chord = useRef<number | null>(null);

  const { jumping, missed, setMissed, onScroll, jump } = useStickToBottom({
    agentId,
    m,
    items,
    pending,
    typing,
    list,
    readerAnchor,
    restoring,
    savedTop,
    stuck,
    setAway,
  });

  /** `now`: 즉시 보내기 (Ctrl+Enter, the 즉시 button): it may go in while the lead works. */
  const submit = async (now = false, clearApproved = false) => {
    // A held message's edit keeps its text (the box holds at most CHAT_SEND_MAX) and takes files like
    // a new message: they go up and their lines join the replacement text.
    if (pendingEdit) {
      if (!text.trim() || uploading || store.officeReadOnly) return;
    } else if ((!text.trim() && !chips.length) || sending || uploading || store.officeReadOnly)
      return;
    const prepared = pendingEdit
      ? { text, attachment: undefined }
      : prepareMessage(text, CHAT_SEND_MAX);
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
      const result = await uploadChips(uploaded, {
        upload: (chip, progress) => uploadAttachment(name, chip, batch, progress),
        onChange: (next) => setAttachments(agentId, next),
        relative: (savedPath) =>
          projectRoot && savedPath.startsWith(`${projectRoot}/`)
            ? savedPath.slice(projectRoot.length + 1)
            : `.agty-inbox/${savedPath.split('/').at(-1)}`,
      });
      if (!result.ok) return;
      uploaded = result.chips;
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
      if (pendingEdit) {
        // A reply picked while editing re-points the held message (its own chip, else the old quote stays).
        if (!messengerEditSave((msg) => transport.send(msg), outgoing, reply ?? undefined)) return;
        editRestore.current = null;
        setReply(null);
        edit('');
        setAttachments(agentId, []);
        requestStaleRecheck();
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

  // Consecutive rows of one tool fold into one; a divider or a quest record between two ends the run.
  const runs = useMemo(
    () =>
      toolRuns(
        items ?? [],
        (i) =>
          newDay(items!, i) ||
          startsEarlierSession(items!, i, historyDone) ||
          dividerAfter(items!, i - 1) !== undefined ||
          !!placed?.has(i - 1),
        ezContext(),
      ),
    [items, placed, historyDone],
  );
  const lineOf = (item: ChatItem, index: number) => (
    <Line
      item={item}
      fresh={item.id === freshId}
      received={received.includes(item.id)}
      project={name}
      projectRoot={projectRoot}
      highlightQuery={searched}
      currentMatch={hits[activeResult]?.id === item.id}
      replyAs={name}
      onReply={
        canSend && !store.officeReadOnly && !noDirectChat ? setReply : undefined
      }
      onQuote={openQuote}
      onQuestionTag={openTag}
      face={
        senderKey(item) === null
          ? undefined
          : { show: startsRun(items, index), name: item.fromName ? serverLine(item.fromName) : shown }
      }
    />
  );

  return (
    <AttachmentGallery files={viewerFiles} ticketFor={viewerTicketFor}>
      <section
        aria-label={t('messenger.conversation', { name: shown })}
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
        {/* FEAT-MESSENGER-GPT-LOOK: the head: the lead's portrait, the name large, its state and place under it. */}
        {!pane && (
        <header
          className={`msg-head shrink-0 px-12 py-8 min-w-0 pointer-coarse:px-10 pointer-coarse:py-6 ${phone ? 'msg-head-phone' : 'flex flex-wrap items-center gap-x-10 gap-y-6'}`}
        >
          <SenderFace name={name} agentId={agentId} portrait />
          <span className="msg-head-text flex-1 basis-160 min-w-0 flex flex-col gap-4">
            <span className="msg-head-name flex items-center gap-8 min-w-0">
              <strong className="text-lg leading-none truncate text-devroom-title" title={shown}>
                {shown}
              </strong>
              <WaitMark agentId={agentId} />
            </span>
            <span className="msg-head-state flex items-center gap-8 min-w-0 overflow-hidden text-2xs text-text-muted">
              <StateDot agentId={agentId} statusFor={statusFor} withLabel />
              {orch && (
                <span className="truncate" title={orch.dir}>
                  <span aria-hidden="true" className="text-devroom-card-line">
                    |{' '}
                  </span>
                  {serverLine(orch.tab)} · {orch.dir.split('/').filter(Boolean).at(-1) ?? orch.dir}
                </span>
              )}
              {fatigue ? (
                <FatigueBar look={fatigue} />
              ) : (
                context && (
                  <span className="shrink-0" title={basisHint(context.basis)}>
                    {t('ctxsrc.tokensOnly', { tokens: kTokens(context.tokens) })}
                  </span>
                )
              )}
            </span>
          </span>
          {/* MSG-HEAD: the buttons are one group that keeps its size and sits right of the text (on a narrow pane it
              wraps under it), so the name and state lines truncate in the room left over and are never covered. */}
          <span
            className="msg-head-tools ml-auto shrink-0 flex items-center gap-10"
            data-touch-compact={phone || undefined}
          >
            {/* GAME-UI-1 G1 (01): 타자 효과 켬 / 끔 (this browser; a phone keeps its header for the name). */}
            {!phone && (
              <button
                type="button"
                className="dlg-switch text-2xs shrink-0"
                aria-pressed={typewriter}
                data-testid="typing-switch"
                onClick={() => setTypewriter(!typewriter)}
              >
                {t('game.msg.typing')}
                <span className="dlg-switch-v">{typewriter ? t('game.msg.on') : t('game.msg.off')}</span>
              </button>
            )}
            <Button
              size="icon_md"
              aria-label={t('messenger.search')}
              aria-expanded={searchOpen}
              onClick={() => (searchOpen ? clearSearch() : setSearchOpen(true))}
            >
              ⌕
            </Button>
            <Button
              size="icon_md"
              aria-label={t('msglib.open')}
              title={t('msglib.open')}
              aria-expanded={libraryOpen}
              data-testid="library-open"
              onClick={() => setLibraryOpen((open) => !open)}
            >
              ▤
            </Button>
            {gone && !store.officeReadOnly && (
              <Button size="sm" onClick={() => setAskDelete(true)}>
                {t('projectData.deleteConversation')}
              </Button>
            )}
            {!gone && <DevroomLink name={name} />}
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
            {onClose && <PaneClose onClose={onClose} />}
          </span>
        </header>
        )}
        {searchOpen && (
          <section
            aria-label={t('messenger.search')}
            className="msg-head shrink-0 px-12 py-8"
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
                className="ui-input flex-1 min-w-0 px-8 py-4 text-sm"
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
        {!gone && <StaleCliBand name={name} />}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={list}
            data-testid="chat-scroll"
            className="msg-timeline msg-band flex-1 min-h-0 overflow-y-auto py-10 space-y-10"
            onScroll={() => {
              onScroll();
              watch();
            }}
            onWheel={() => {
              jumping.current = false;
              moved();
            }}
            onTouchStart={() => {
              jumping.current = false;
              moved();
            }}
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
              items.map((item, index) =>
                runs.hidden.has(index) ? null : (
                <div
                  key={item.id}
                  data-chat-id={item.id}
                  data-message-id={item.messageId}
                  data-previous-session={item.session ? 'true' : undefined}
                  className={`data-[focused=true]:outline-2 data-[focused=true]:outline-accent${item.session ? ' previous-session' : ''}`}
                >
                  {newDay(items, index) && (
                    <p className="msg-day text-xs" data-testid="day-divider">
                      <span>{dayLabel(item.at)}</span>
                    </p>
                  )}
                  {startsEarlierSession(items, index, historyDone) && (
                    <p
                      className="previous-band text-center text-2xs py-4 px-8 mb-6"
                      data-testid="session-start"
                    >
                      {t('messenger.sessionStart', { time: sessionClock(item.sessionStart ?? item.at) })}
                    </p>
                  )}
                  {index === 0 && placed?.get(-1)?.map((r) => <QuestRecordLine key={r.toolId} record={r} />)}
                  {runs.heads.has(index) ? (
                    <ToolRun
                      items={runs.heads.get(index)!}
                      show={(it, offset) => lineOf(it, index + offset)}
                      focusId={hits[activeResult]?.id}
                    />
                  ) : (
                    lineOf(item, index)
                  )}
                  {placed?.get(index)?.map((r) => (
                    <div key={r.toolId} className="mt-8">
                      <QuestRecordLine record={r} />
                    </div>
                  ))}
                  {dividerAfter(items, index) !== undefined && (
                    <p
                      className="previous-band text-center text-2xs py-4 px-8 mt-6"
                      data-testid="session-divider"
                    >
                      {t('messenger.sessionDivider', { time: sessionClock(item.at) })}
                    </p>
                  )}
                </div>
              ))
            )}
            {typing && <Thinking name={shown} />}
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
                  if (messengerEditEnter((msg) => transport.send(msg), agentId, name, p.requestId)) {
                    parkReply();
                    setText(p.text);
                  }
                }}
                cancel={() =>
                  messengerCancel((msg) => transport.send(msg), agentId, name, p.requestId)
                }
                approve={() =>
                  messengerApproveHeld((msg) => transport.send(msg), agentId, name, p.requestId)
                }
                editingHere={pendingEdit?.requestId === p.requestId}
                permissionWait={!!contact?.permission}
                onQuote={openQuote}
                onReply={canSend && !store.officeReadOnly && !noDirectChat ? setReply : undefined}
              />
            ))}
          </div>
          {libraryOpen && (
            <Library
              agentId={agentId}
              name={shown}
              phone={phone}
              ticketFor={viewerTicketFor}
              onClose={() => setLibraryOpen(false)}
              onGo={(file) => {
                setLibraryOpen(false);
                jumpToHit(file);
              }}
            />
          )}
          {mark && (
            <button
              type="button"
              className="ui-raise absolute left-12 bottom-12 min-h-32 px-12 border-ui rounded-ui-card border-devroom-box-line bg-(--surface-float) text-xs pointer-coarse:min-h-44"
              aria-label={t('msglib.returnLabel')}
              data-testid="jump-return"
              onClick={() => goBack({ bottom: jump, hit: jumpToHit })}
            >
              {t('msglib.return')}
            </button>
          )}
          {away && (
            <Button
              key={missed}
              size={missed > 0 ? 'sm' : 'icon_md'}
              variant="accent"
              className={`absolute right-8 bottom-12${missed > 0 ? ' msg-jump-pop' : ''}`}
              aria-label={
                missed > 0
                  ? t('messenger.jumpBottomNew', { count: missed })
                  : t('messenger.jumpBottom')
              }
              data-testid="jump-newest"
              onClick={jump}
            >
              {jumpLabel(missed)}
            </Button>
          )}
        </div>
        <footer
          ref={footer}
          className="relative shrink-0 msg-timeline px-12 pt-6 pb-10 pointer-coarse:px-8 pointer-coarse:pb-8"
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
              className="absolute bottom-full left-12 right-12 max-h-256 overflow-y-auto border-ui rounded-ui-card border-border bg-bg shadow-pixel z-10"
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
              className="mb-6 border-ui rounded-ui-card border-accent bg-bg-dark px-8 py-6 text-xs flex items-center gap-8"
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
              className="mb-6 border-ui rounded-ui-card border-accent bg-bg-dark px-8 py-6 text-xs flex items-center gap-8"
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
          {pendingEdit && pendingReply && !reply && <ReplyChip reply={pendingReply} open={openQuote} />}
          {m.editLost?.agentId === agentId && (
            <div
              className="mb-6 border-ui rounded-ui-card border-danger bg-bg-dark px-8 py-6 text-xs flex flex-wrap items-center gap-8"
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
          {reply && (
            <ReplyChip
              reply={reply}
              cancel={() => setReply(null)}
              peek={() => peekDo(peekOn ? 'close' : 'open')}
              peekOpen={peekOn}
            />
          )}
          {peekOn && reply && (
            <QuotePeek
              view={peekView(items, reply, name)}
              maxHeight={Math.min(QUOTE_PEEK_MAX_PX, list.current?.clientHeight ?? QUOTE_PEEK_MAX_PX)}
              jump={() => peekDo('jump')}
              close={() => peekDo('close')}
            />
          )}
          {renewing && (
            <p className="text-xs text-accent-text pb-6" role="status" data-testid="renewing-note">
              {t('messenger.renewingNote')}
            </p>
          )}
          {renewFailed && (
            <p className="text-xs text-accent-text pb-6" role="status" data-testid="renew-failed-note">
              {t('brainK1.renewFailed')}
            </p>
          )}
          {questCard ? (
            <PermissionCard
              key={questCard.toolId}
              agentId={agentId}
              name={shown}
              card={questCard}
              canAnswer={canSend && !store.officeReadOnly}
              visualViewportHeight={visualViewportHeight}
              openTerminal={
                pane
                  ? pane.onTerminal
                  : target?.kind === 'background'
                    ? () => requestChat(agentId, target.id)
                    : null
              }
            />
          ) : waitWhy === 'question' && !contact?.held ? (
            <QuestionCard
              agentId={agentId}
              name={shown}
              question={questionText(items)}
              onAnswer={canSend && !store.officeReadOnly && !noDirectChat ? () => box.current?.focus() : null}
            />
          ) : (
            contact?.held && (
              <p className="text-xs text-accent-text pb-6" role="status" data-testid="held-note">
                {heldNote()}
              </p>
            )
          )}
          {noDirectChat ? (
            <p className="text-xs text-text-muted" data-testid="no-direct-chat">
              {t('agentCaps.noDirectChat')}
            </p>
          ) : canSend && !store.officeReadOnly ? (
            // FEAT-MESSENGER-GPT-LOOK: one raised panel: the text on top; 첨부, the files and 보내기 under it.
            <form
              ref={formRef}
              className="msg-composer flex flex-col"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div className="flex">
                <div className="flex-1 min-w-0">
                  <textarea
                    ref={box}
                    aria-label={t('messenger.messageInput')}
                    placeholder={pane ? t('devroom.pane.placeholder', { name: shown }) : t('messengerLook.placeholder')}
                    className="block w-full min-w-0 px-10 pt-8 pb-4 text-sm resize-none placeholder:text-text-muted pointer-coarse:min-h-44"
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
                    <p className="px-10 pt-2 text-xs text-text-muted" role="status">
                      {t('messenger.longMessageNote', { count: messageCharacterCount(text) })}
                    </p>
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
                    setChoosingAttachments(false);
                    if (event.target.files) addFiles(event.target.files);
                    event.target.value = '';
                  }}
                />
              </div>
              {/* UI-PHONE: 즉시 보내기 is a button there (named in full, with its icon); the files take a line
                  of their own over the buttons on a phone, beside 첨부 on a desktop. */}
              <div className="msg-composer-tools flex-wrap px-8 pb-8 pt-4" data-testid="composer-tools">
                {attachButton}
                <div
                  className={`flex-1 min-w-0 flex flex-wrap gap-6 ${touch ? 'order-first basis-full empty:hidden' : ''}`}
                  aria-label={t('messenger.attachments')}
                >
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
                {touch && !pendingEdit && (
                    <Button
                      type="button"
                      size="sm"
                      className="ml-auto"
                      disabled={sending || uploading || renewing || (!text.trim() && !chips.length)}
                      title={renewing ? t('messenger.renewingNote') : t('messenger.sendNowHint')}
                      data-testid="send-now"
                      onPointerDown={keepComposerFocus}
                      onClick={() => void submit(true)}
                    >
                      <Icon name="zap" size={16} pixel={<span className="material-symbols-sharp text-[16px]" aria-hidden="true">
                        bolt
                      </span>} />
                      {t('uiPhone.sendNow')}
                    </Button>
                )}
                <Button
                  type="submit"
                  variant="accent"
                  size="sm"
                  className="px-12"
                  disabled={sending || uploading || (!text.trim() && !chips.length)}
                  title={t('messenger.sendShortcut')}
                  onPointerDown={keepComposerFocus}
                >
                  <Icon name="send" size={16} pixel={<span className="material-symbols-sharp text-[16px]" aria-hidden="true">
                    send
                  </span>} />
                  {sending ? t('messenger.send.sending') : t('messenger.sendButton')}
                </Button>
              </div>
            </form>
          ) : (
            items && (
              <p className="text-xs text-text-muted" data-testid="no-send-note">
                {gone ? t('projectData.goneNote') : readOnlyNote(agentId, store.officeSnapshot)}
              </p>
            )
          )}
        </footer>
        <Modal isOpen={askDelete} onClose={() => setAskDelete(false)} title={shown} zIndex={62}>
          <div className="px-10 pb-8" role="alertdialog" aria-label={t('projectData.deleteConversationQuestion')}>
            <p className="text-base">{t('projectData.deleteConversationQuestion')}</p>
            <p className="text-sm text-text-muted mt-4">{t('projectData.deleteConversationNote')}</p>
            <p className="text-sm text-red-400 mt-4">{t('projectData.purgeWarn')}</p>
            {m.goneDeleteError && (
              <p role="alert" className="text-sm text-red-400 mt-4">
                {m.goneDeleteError}
              </p>
            )}
            <div className="flex justify-end gap-8 mt-16">
              <Button
                variant="accent"
                size="sm"
                disabled={!!m.goneDelete}
                onClick={() => messengerDeleteGone((msg) => transport.send(msg), agentId, name)}
              >
                {t('projectData.deleteConversationConfirm')}
              </Button>
              <Button size="sm" onClick={() => setAskDelete(false)} autoFocus>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Modal>
      </section>
    </AttachmentGallery>
  );
}
