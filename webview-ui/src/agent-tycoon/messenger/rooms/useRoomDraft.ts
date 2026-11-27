import { useState } from 'react';

import type { ChatReply } from '../../../../../core/src/messages.js';
import { loadDraft, loadDraftReply, saveDraft, saveDraftReply } from '../messengerStore.js';

/** B6.6: a room composer's unsent text and the post it answers, kept like a chat's draft (`key`
 *  is the room's `room:<id>`): they survive a tab switch, the phone's back and a reload. */
export function useRoomDraft(key: string) {
  const [text, setTextState] = useState(() => loadDraft(key));
  const [reply, setReplyState] = useState(() => loadDraftReply(key));
  const setText = (value: string) => {
    setTextState(value);
    saveDraft(key, value);
  };
  const setReply = (value: ChatReply | null) => {
    setReplyState(value);
    saveDraftReply(key, value);
  };
  return { text, setText, reply, setReply };
}
