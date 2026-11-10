import * as fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PinnedConversations } from '../../../core/src/messages.js';
import { ROSTER, startEngineOffice } from './officeTestKit.js';

afterEach(() => vi.restoreAllMocks());

const pinned = (list: Array<Record<string, unknown>>) =>
  (
    [...list].reverse().find((m) => m.type === 'pinnedConversations') as unknown as
      PinnedConversations | undefined
  )?.keys;

describe('pinned conversations (U-30)', () => {
  it('a pin reaches everyone, survives a restart, and unpinning removes it', async () => {
    const first = await startEngineOffice({ projects: ROSTER });
    const send = vi.fn();
    const ask = (key: unknown, on: unknown, privileged = true) =>
      first.office.onClientMessage(
        { type: 'setConversationPin', key, pinned: on },
        send,
        privileged,
        'ua',
      );
    ask('alpha', true);
    ask('room:all', true);
    ask('alpha', true); // already pinned: no duplicate
    expect(pinned(first.messages)).toEqual(['alpha', 'room:all']);
    const file = `${first.home}/.config/agent-tycoon/pins.json`;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const home = first.home;
    first.stop();
    const again = await startEngineOffice({ projects: ROSTER, home });
    const got: Array<Record<string, unknown>> = [];
    again.office.onClientReady((m: Record<string, unknown>) => got.push(m));
    expect(pinned(got)).toEqual(['alpha', 'room:all']);
    again.office.onClientMessage(
      { type: 'setConversationPin', key: 'alpha', pinned: false },
      send,
      true,
      'ua',
    );
    expect(pinned(again.messages)).toEqual(['room:all']);
    again.stop();
  });

  it('a read-only client or a bad key is refused and told the truth', async () => {
    const o = await startEngineOffice({ projects: ROSTER });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => sent.push(m);
    o.office.onClientMessage(
      { type: 'setConversationPin', key: 'a', pinned: true },
      send,
      false,
      'ua',
    );
    o.office.onClientMessage(
      { type: 'setConversationPin', key: 7, pinned: true },
      send,
      true,
      'ua',
    );
    o.office.onClientMessage({ type: 'setConversationPin', key: 'a', pinned: 1 }, send, true, 'ua');
    expect(pinned(sent)).toEqual([]);
    expect(pinned(o.messages)).toBeUndefined();
    o.stop();
  });
});
