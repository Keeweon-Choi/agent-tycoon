import { describe, expect, it } from 'vitest';

import type { ChatItem, ChatReply } from '../../../../core/src/messages.js';
import { peekShown, peekStep, peekView } from './quotePeek.js';

const reply: ChatReply = { id: 'm1', sender: 'alpha', text: 'short quote' };
const item = (extra: Partial<ChatItem>): ChatItem => ({
  kind: 'assistant',
  text: 'the whole answer\nover two lines',
  id: '1700000000000-a',
  at: 1_700_000_000_000,
  ...extra,
});

describe('peekView', () => {
  it('shows the loaded original in full, with its writer and time', () => {
    const v = peekView([item({ messageId: 'm1', kind: 'assistant', id: 'm1' })], reply, 'alpha');
    expect(v).toMatchObject({
      loaded: true,
      sender: 'alpha',
      at: 1_700_000_000_000,
      text: 'the whole answer\nover two lines',
    });
  });
  it('names the files of the boss message and keeps them out of the text', () => {
    const boss = item({
      kind: 'user',
      id: 'm1',
      text: 'look at this\n[\ucca8\ubd80] /tmp/a/20240101-120000-shot.png (image/png, 3 KB)',
    });
    const v = peekView([boss], { id: 'm1', text: 'look' }, 'alpha');
    expect(v.sender).toBeUndefined();
    expect(v.text).toBe('look at this');
    expect(v.files).toEqual(['shot.png']);
  });
  it('falls back to the chip quote when the original is not loaded', () => {
    expect(peekView([], reply, 'alpha')).toEqual({
      sender: 'alpha',
      text: 'short quote',
      files: [],
      loaded: false,
    });
    expect(peekView(undefined, reply, 'alpha').loaded).toBe(false);
  });
});

describe('peekStep', () => {
  it('opens on the reply, closes on close, and jump closes while naming the target', () => {
    expect(peekStep(reply, 'open')).toEqual({ peek: 'm1' });
    expect(peekStep(reply, 'close')).toEqual({ peek: null });
    expect(peekStep(reply, 'jump')).toEqual({ peek: null, seek: 'm1' });
  });
  it('has nothing to show once the draft has no reply', () => {
    expect(peekStep(null, 'open')).toEqual({ peek: null });
    expect(peekShown('m1', null)).toBe(false);
    expect(peekShown('m1', reply)).toBe(true);
    expect(peekShown('m1', { ...reply, id: 'm2' })).toBe(false);
  });
  it('is the peek alone that changes: a draft held beside it is the same object after close', () => {
    const draft = { text: 'half-written answer', reply };
    expect(peekStep(draft.reply, 'open').peek).toBe('m1');
    const closed = peekStep(draft.reply, 'close');
    expect(closed.peek).toBeNull();
    expect(draft).toEqual({ text: 'half-written answer', reply });
  });
});
