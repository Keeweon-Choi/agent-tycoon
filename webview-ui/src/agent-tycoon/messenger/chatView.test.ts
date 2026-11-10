import { describe, expect, it, vi } from 'vitest';

import type { ClientMessage } from '../../../../core/src/messages.js';
import { holdChatView } from './chatView.js';

vi.mock('../../transport/index.js', () => ({ transport: { send: () => undefined } }));

describe('chatView holders', () => {
  it('the first holder turns it on, only the last one to let go turns it off', () => {
    const sent: ClientMessage[] = [];
    const send = (m: ClientMessage) => sent.push(m);
    const messenger = holdChatView(7, send);
    const pane = holdChatView(7, send);
    expect(sent).toEqual([{ type: 'chatView', agentId: 7, on: true }]);
    pane();
    pane(); // letting go twice counts once
    expect(sent).toHaveLength(1);
    messenger();
    expect(sent.at(-1)).toEqual({ type: 'chatView', agentId: 7, on: false });
    holdChatView(7, send)();
    expect(sent.map((m) => 'on' in m && m.on)).toEqual([true, false, true, false]);
  });
});
