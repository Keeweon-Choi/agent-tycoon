import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ChatReply, OfficeOrchestrator } from '../../../../../core/src/messages.js';
import { transport } from '../../../transport/index.js';
import { useDraftFiles } from '../draftFiles.js';
import { pendingReplyForEdit } from '../messageActions.js';
import {
  draftKey,
  loadDraft,
  loadDraftReply,
  messengerEditLeave,
  messengerEditPark,
  type MessengerSnapshot,
  type PendingSend,
  saveDraft,
  saveDraftReply,
  setAttachments,
} from '../messengerStore.js';
import { NO_CHIPS } from '../parts.js';
import { type Peek, type PeekAction, peekShown, peekStep } from '../quotePeek.js';

/**
 * Conversation's draft: the unsent text, the reply it answers and its peek, and a held
 * message's edit (enter, leave, park on unmount). `box` is Conversation's composer
 * textarea ref, the same object its composer grow and JSX use.
 */
export function useDraft({
  agentId,
  m,
  row,
  name,
  pending,
  openQuote,
  box,
}: {
  agentId: number;
  m: MessengerSnapshot;
  row: OfficeOrchestrator | undefined;
  name: string;
  pending: PendingSend[];
  openQuote: (id: string) => void;
  box: RefObject<HTMLTextAreaElement | null>;
}) {
  // The unsent text survives closing, switching and reloads (per device, 24 h).
  const draft = draftKey(row?.provider ?? 'claude', name);
  const [text, setText] = useState(() => loadDraft(draft));
  // REDEPLOY-STATE: so do the files attached and not sent yet (a deploy reloads the page).
  useDraftFiles(draft, m.attachments[agentId] ?? NO_CHIPS, (chips) => setAttachments(agentId, chips));
  // MSG-ACTIONS: the message this draft answers (답글), kept with the draft.
  const [reply, setReplyState] = useState(() => loadDraftReply(draft));
  const setReply = (value: ChatReply | null) => {
    setReplyState(value);
    saveDraftReply(draft, value);
    if (value) requestAnimationFrame(() => box.current?.focus());
  };
  // MSG-POLISH: the peek of the message the draft answers; it never touches the draft or the focus.
  const [peek, setPeek] = useState<Peek>(null);
  const editRestore = useRef<string | null>(null);
  const pendingEdit = m.editing?.agentId === agentId ? m.editing : null;
  const peekOn = peekShown(peek, reply);
  const peekDo = (action: PeekAction) => {
    const step = peekStep(reply, action);
    setPeek(step.peek);
    if (step.seek) openQuote(step.seek);
    box.current?.focus({ preventScroll: true }); // the keyboard stays up
  };
  useEffect(() => {
    if (!reply) setPeek(null);
  }, [reply]);
  useEffect(() => {
    if (!peekOn) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      setPeek(null);
    };
    const onDown = (event: PointerEvent) => {
      // The chip toggles the peek itself.
      if (!(event.target as Element).closest('[data-quote-peek],[data-testid="reply-chip"]'))
        setPeek(null);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [peekOn]);
  const pendingReply = pendingReplyForEdit(pending, pendingEdit?.requestId);
  const editActive = useRef(false);
  const edit = (value: string) => {
    setText(value);
    saveDraft(draft, value);
  };
  // The draft's own reply chip waits while a held message is edited (the edit has its own chip).
  // ponytail: kept in memory only; a reload in the middle of an edit forgets it.
  const replyRestore = useRef<ChatReply | null>(null);
  const parkReply = () => {
    replyRestore.current = reply;
    setReplyState(null);
  };
  const leavePendingEdit = () => {
    messengerEditLeave((msg) => transport.send(msg));
    edit(editRestore.current ?? '');
    editRestore.current = null;
    setReplyState(replyRestore.current);
    saveDraftReply(draft, replyRestore.current);
    replyRestore.current = null;
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
  return {
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
  };
}
