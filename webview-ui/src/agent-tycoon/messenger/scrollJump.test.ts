import { beforeEach, describe, expect, it } from 'vitest';

import type { ChatItem } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import { atBottom, jumpLabel, newSince } from './scrollJump.js';

const item = (id: string, kind: ChatItem['kind'] = 'assistant'): ChatItem => ({
  id,
  kind,
  text: id,
  at: 0,
});
// A 500 px list over 3000 px of messages: the bottom is scrollTop 2500.
const at = (scrollTop: number) => ({ scrollTop, clientHeight: 500, scrollHeight: 3000 });

beforeEach(() => setLanguage('ko'));

describe('the jump button', () => {
  it('knows the bottom, with a 48 px slack', () => {
    expect(atBottom(at(2500))).toBe(true);
    expect(atBottom(at(2452))).toBe(true);
    expect(atBottom(at(2451))).toBe(false);
    expect(atBottom(at(2400))).toBe(false); // not a screen away: still detached
  });
  it("counts the agent's replies after the one last seen: not tool lines, not the boss's own lines", () => {
    // 'c' is the boss's line (one that just turned from sending into sent): never a new message.
    const items = [item('a'), item('b'), item('t', 'tool'), item('c', 'user'), item('d')];
    expect(newSince(items, 'd')).toBe(0);
    expect(newSince(items, 'b')).toBe(1);
    expect(newSince(items, 'a')).toBe(2);
    expect(newSince(items, 'c')).toBe(1);
    expect(newSince(items, 'gone')).toBe(0);
    expect(newSince(items, undefined)).toBe(0);
  });
  it('labels the count', () => {
    expect(jumpLabel(0)).toBe('↓');
    expect(jumpLabel(3)).toBe('\uc0c8 \uba54\uc2dc\uc9c0 3 ↓');
    expect(jumpLabel(120)).toBe('\uc0c8 \uba54\uc2dc\uc9c0 99+ ↓');
  });
});
