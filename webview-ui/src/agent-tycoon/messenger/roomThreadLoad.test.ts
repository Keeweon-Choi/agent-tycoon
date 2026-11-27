import { describe, expect, it } from 'vitest';

import type { GroupThread } from '../../../../core/src/messages.js';
import { foldThreadLoad, forgetRoomLoads, loadKey, loadThread, stalledThread, ThreadLoad,threadLoadResult } from './roomThreadLoad.js';

const sent: GroupThread[] = [];
const send = (m: GroupThread) => void sent.push(m);

describe('T-113 round 2 (N1): a thread load never spins for ever', () => {
  it('an answered load is not asked again until it is folded or the room forgets it', () => {
    loadThread(send, 'r1', ['p1']);
    expect(sent.map((m) => m.posts)).toEqual([['p1']]);
    threadLoadResult({ type: 'groupThreadResult', requestId: sent[0].requestId, ok: true });
    loadThread(send, 'r1', ['p1']); // the effect runs again (loads changed): nothing more is sent
    expect(sent).toHaveLength(1);
    foldThreadLoad(send, 'r1', ['p1']);
    expect(sent.at(-1)).toMatchObject({ mode: 'fold', posts: ['p1'] });
    loadThread(send, 'r1', ['p1']); // reopened: asked again
    expect(sent.at(-1)).toMatchObject({ posts: ['p1'] });
    expect(sent.at(-1)!.mode).toBeUndefined();
    forgetRoomLoads('r1');
    loadThread(send, 'r1', ['p1']); // a new socket: asked again
    expect(sent.filter((m) => !m.mode)).toHaveLength(3);
    forgetRoomLoads('r1');
  });

  it('a spinner with nothing on its way (or answered without its replies) becomes the retry line', () => {
    let snapshot = stalledThread('r2', ['p1', 'p2']);
    expect(snapshot[loadKey('r2', 'p1')]).toBe(ThreadLoad.failed);
    expect(snapshot[loadKey('r2', 'p2')]).toBe(ThreadLoad.failed);
    loadThread(send, 'r2', ['p3']);
    snapshot = stalledThread('r2', ['p3']); // still on its way: its own timer decides
    expect(snapshot[loadKey('r2', 'p3')]).toBe(ThreadLoad.pending);
    forgetRoomLoads('r2');
  });
});
