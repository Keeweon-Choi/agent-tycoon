/**
 * DEVROOM-PANE-CHAT: a conversation's chatView, held by every view that shows it (the messenger's
 * open conversations, a 개발실 pane in 대화 view). The daemon keeps one on/off per socket and agent,
 * so the first holder turns it on and only the last one to let go turns it off: a pane closing never
 * stops the messenger's tail of the same agent. The transport re-sends the `on` after a reconnect.
 */
import { useEffect } from 'react';

import type { ClientMessage } from '../../../../core/src/messages.js';
import { transport } from '../../transport/index.js';
import { chatViewClosed } from './messengerStore.js';

const holders = new Map<number, number>();

/** Hold agent `agentId`'s chatView; the returned function lets go (once). */
export function holdChatView(agentId: number, send: (m: ClientMessage) => void = (m) => transport.send(m)): () => void {
  const n = holders.get(agentId) ?? 0;
  holders.set(agentId, n + 1);
  if (n === 0) send({ type: 'chatView', agentId, on: true });
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (holders.get(agentId) ?? 1) - 1;
    if (left > 0) {
      holders.set(agentId, left);
      return;
    }
    holders.delete(agentId);
    send({ type: 'chatView', agentId, on: false });
    chatViewClosed(agentId);
  };
}

/** The chatView of `agentId` while `on` (and the component is mounted). */
export function useChatView(agentId: number | null, on = true): void {
  useEffect(() => (on && agentId !== null ? holdChatView(agentId) : undefined), [agentId, on]);
}
