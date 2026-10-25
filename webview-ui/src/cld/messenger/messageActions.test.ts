import { expect, it } from 'vitest';

import type { ChatItem } from '../../../../core/src/messages.js';
import {
  copyText,
  findReplied,
  replyChipText,
  replyDraft,
  replyIdOf,
  replySenderOf,
  SYSTEM_SENDER,
} from './messageActions.js';

const ATTACH = '[\ucca8\ubd80] /p/.cld-inbox/20261024-131122-plan.png (image/png, 2 KB)';
const item = (o: Partial<ChatItem>): ChatItem => ({
  id: '1729738800000-abcd1234-0',
  at: 1,
  kind: 'user',
  text: '',
  ...o,
});

it('copy text: the words as written, attachments as their names, for every bubble kind', () => {
  // The boss's message: the `[attachment]` tail becomes the file's name.
  expect(copyText(item({ text: `check this\n${ATTACH}` }))).toBe('check this\nplan.png');
  expect(copyText(item({ text: ATTACH }))).toBe('plan.png');
  // A lead's answer: the Markdown source; a sent file by name.
  expect(copyText(item({ kind: 'assistant', text: '**done**\n\n| a |\n|---|' }))).toBe(
    '**done**\n\n| a |\n|---|',
  );
  expect(
    copyText(
      item({
        kind: 'assistant',
        text: 'here',
        attachments: [{ name: 'out.txt', path: '/p/out.txt' }],
      }),
    ),
  ).toBe('here\nout.txt');
  // A peer's and a system notice's text as shown; a room post is a user text.
  expect(copyText(item({ from: 'peer', fromName: 'beta', text: '- review it' }))).toBe(
    '- review it',
  );
  expect(copyText(item({ from: 'system', text: 'Codex finished' }))).toBe('Codex finished');
});

it('reply id: a user message by its C2 id, anything else (an answer) by its own item id', () => {
  expect(replyIdOf(item({ messageId: 'aaaa2222' }))).toBe('aaaa2222');
  expect(replyIdOf(item({}))).toBe('1729738800000-abcd1234-0');
  // An assistant's messageId is the message it answers, never its own.
  expect(replyIdOf(item({ kind: 'assistant', messageId: 'aaaa2222', id: 'x-1' }))).toBe('x-1');
  const items = [
    item({ id: 'u', messageId: 'aaaa2222' }),
    item({ kind: 'assistant', id: 'a', messageId: 'aaaa2222' }),
  ];
  expect(findReplied(items, 'aaaa2222')?.id).toBe('u');
  expect(findReplied(items, 'a')?.id).toBe('a');
  expect(findReplied(items, 'gone')).toBeUndefined();
});

it('reply sender and chip: the boss is absent, a peer by name, a notice is cld-gui', () => {
  expect(replySenderOf(item({}), 'alpha')).toBeUndefined();
  expect(replySenderOf(item({ kind: 'assistant' }), 'alpha')).toBe('alpha');
  expect(replySenderOf(item({ from: 'peer', fromName: 'beta' }), 'alpha')).toBe('beta');
  expect(replySenderOf(item({ from: 'system' }), 'alpha')).toBe(SYSTEM_SENDER);
  const long = 'x'.repeat(200);
  const draft = replyDraft('aaaa2222', 'alpha', long);
  // Sent whole (the server masks, then cuts): a cut at the quote length could leave a token's head.
  expect(draft).toEqual({ id: 'aaaa2222', sender: 'alpha', text: long });
  const token = `ghp_${'a'.repeat(36)}`;
  expect(replyDraft('t', undefined, `${'x'.repeat(100)} ${token}\nmore`).text).toContain(token);
  expect(replyDraft('p1', undefined, 'hi')).toEqual({ id: 'p1', text: 'hi' });
  expect(replyChipText(draft, 'You')).toBe(`↩ alpha · ${'x'.repeat(60)}…`);
  expect(replyChipText({ id: 'p1', text: 'two\nlines' }, 'You')).toBe('↩ You · two lines');
});
