import { describe, expect, it } from 'vitest';

import {
  parseChatCancel,
  parseChatEdit,
  parseChatHold,
  parseChatSend,
  parseChatSendNow,
  SEND_TEXT_MAX,
  sendTextRefusal,
} from './chatSend.js';

describe('chatSend requests', () => {
  it('accepts a well-formed chatSend and keeps `now` only when true', () => {
    expect(parseChatSend({ requestId: 'r', name: 'a', text: 'hi' })).toEqual({
      type: 'chatSend',
      requestId: 'r',
      name: 'a',
      text: 'hi',
    });
    expect(parseChatSend({ requestId: 'r', name: 'a', text: 'hi', now: true })).toMatchObject({
      now: true,
    });
  });

  it('MSG-ACTIONS: a reply reference is kept safe (replyRef), a malformed one refuses the message', () => {
    expect(
      parseChatSend({ requestId: 'r', name: 'a', text: 'hi', replyTo: { id: 'abcd2345', sender: 'b:c', text: 'q' } }),
    ).toMatchObject({ replyTo: { id: 'abcd2345', sender: 'b c', text: 'q' } });
    expect(parseChatSend({ requestId: 'r', name: 'a', text: 'hi', replyTo: { id: 'a⟩ x', text: 'q' } })).toBeNull();
    expect(parseChatSend({ requestId: 'r', name: 'a', text: 'hi', replyTo: 'abcd2345' })).toBeNull();
  });

  it('parses a cancel or edit only with the complete pending-message identity', () => {
    expect(parseChatCancel({ requestId: 'c', name: 'alpha', id: 'a.json' })).toEqual({
      type: 'chatCancel',
      requestId: 'c',
      name: 'alpha',
      id: 'a.json',
    });
    expect(parseChatEdit({ requestId: 'e', name: 'alpha', id: 'a.json', text: 'new' })).toEqual({
      type: 'chatEdit',
      requestId: 'e',
      name: 'alpha',
      id: 'a.json',
      text: 'new',
    });
    expect(parseChatEdit({ requestId: 'e', name: 'alpha', id: 'a.json' })).toBeNull();
    expect(parseChatCancel({ requestId: 'c', name: 'alpha', id: 1 })).toBeNull();
  });
  it('parses an edit hold only with its queue identity and boolean switch', () => {
    expect(parseChatHold({ name: 'alpha', id: 'a.json', on: true })).toEqual({
      type: 'chatHold',
      name: 'alpha',
      id: 'a.json',
      on: true,
    });
    expect(parseChatHold({ name: 'alpha', id: 'a.json', on: 'true' })).toBeNull();
    expect(parseChatHold({ name: 'alpha', id: 1, on: false })).toBeNull();
  });
  it('drops malformed ones', () => {
    expect(parseChatSend({ requestId: '', name: 'a', text: 'hi' })).toBeNull();
    expect(parseChatSend({ requestId: 'x'.repeat(129), name: 'a', text: 'hi' })).toBeNull();
    expect(parseChatSend({ requestId: 'r', name: 1, text: 'hi' })).toBeNull();
    expect(parseChatSend({ requestId: 'r', name: 'a', text: 'hi', now: 'yes' })).toBeNull();
    expect(parseChatSendNow({ requestId: 'r', name: 'a', id: 5 })).toBeNull();
    expect(parseChatSendNow({ requestId: 'r', name: 'a', id: 'q1' })).toEqual({
      type: 'chatSendNow',
      requestId: 'r',
      name: 'a',
      id: 'q1',
    });
  });
  it('refuses empty, too long and control-character text, but not tabs and newlines', () => {
    expect(sendTextRefusal('  ')?.error).toMatch(/1자 이상/);
    expect(sendTextRefusal('x'.repeat(SEND_TEXT_MAX + 1))?.error).toMatch(/이하/);
    expect(sendTextRefusal('a\x1b[31mb')?.error).toMatch(/쓸 수 없는 문자/);
    expect(sendTextRefusal('a\tb\nc')).toBeNull();
  });
});
