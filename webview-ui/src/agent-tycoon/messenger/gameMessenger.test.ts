// GAME-UI-1 G1: how a line types in (a time per sentence), where folded quest records sit.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MSG_TYPE_MAX_MS, MSG_TYPE_SENTENCE_MS, MSG_TYPE_TICK_MS } from '../../constants.js';
import { placeRecords, questionText, type QuestRecord, sentenceEndStep, skipsTyping, typedSlice, typePlan } from './gameMessenger.js';

describe('typePlan', () => {
  const ticksOf = (text: string) => typePlan(text)!.length;
  it('gives every sentence the same time, whatever its length or language', () => {
    expect(ticksOf('\ubc30\ud3ec \ud655\uc778\ud588\uc5b4\uc694.')).toBe(Math.floor(MSG_TYPE_SENTENCE_MS / MSG_TYPE_TICK_MS));
    expect(ticksOf('Deployment check finished without any problem at all.')).toBe(Math.floor(MSG_TYPE_SENTENCE_MS / MSG_TYPE_TICK_MS));
    // Two sentences take twice as long; Korean and English alike.
    expect(ticksOf('\uc88b\uc544\uc694. \ub05d\ub0ac\uc5b4\uc694.')).toBe(2 * ticksOf('\uc88b\uc544\uc694.'));
    expect(ticksOf('Fine. All done.')).toBe(ticksOf('\uc88b\uc544\uc694. \ub05d\ub0ac\uc5b4\uc694.'));
  });
  it('shares a sentence evenly among its characters and ends on the whole text', () => {
    const plan = typePlan('abcdefghij.')!;
    expect(plan.at(-1)).toBe(11);
    expect(plan[0]).toBeGreaterThan(0);
    expect(plan.every((n, i) => i === 0 || n >= plan[i - 1])).toBe(true);
    const two = typePlan('abcd. efghijkl.')!;
    // Half the time is gone when the first sentence (6 characters with its space) is out.
    expect(two[two.length / 2 - 1]).toBe(6);
  });
  it('never takes longer than the cap: a long answer types faster, not longer', () => {
    const long = Array.from({ length: 50 }, (_, i) => `Sentence number ${i}.`).join(' ');
    expect(ticksOf(long) * MSG_TYPE_TICK_MS).toBeLessThanOrEqual(MSG_TYPE_MAX_MS);
    expect(typePlan(long)!.at(-1)).toBe(Array.from(long).length);
  });
  it('types code and Markdown too; nothing to type in an empty line', () => {
    expect(typePlan('run `npm test`')).not.toBeNull();
    expect(typePlan('```\nls\n```')).not.toBeNull();
    expect(typePlan('')).toBeNull();
    expect(typePlan('  \n')).toBeNull();
  });
  it('slices by code point', () => {
    expect(typedSlice('a\u{1F600}b', 2)).toBe('a\u{1F600}');
  });
});

describe('sentenceEndStep', () => {
  const text = 'abcd. efghijkl. mn.';
  const plan = typePlan(text)!;
  it('the first press jumps to the end of the sentence being typed, the next one types on from there', () => {
    const at = sentenceEndStep(text, plan, 2);
    expect(plan[at]).toBeGreaterThanOrEqual(6);
    expect(plan[at - 1]).toBeLessThan(6);
    expect(plan[at]).toBeLessThan(Array.from(text).length);
  });
  it('in a later sentence it ends that one; in the last one it is all there', () => {
    const second = sentenceEndStep(text, plan, plan.findIndex((n) => n > 8));
    expect(plan[second]).toBeGreaterThanOrEqual(16);
    expect(plan[second - 1]).toBeLessThan(16);
    expect(plan[sentenceEndStep(text, plan, plan.length - 3)]).toBe(Array.from(text).length);
  });
  it('never goes back', () => {
    expect(sentenceEndStep(text, plan, 4)).toBeGreaterThanOrEqual(4);
  });
});

describe('skipsTyping', () => {
  const el = (tagName: string, inside: string[] = []) => ({ tagName, closest: (sel: string) => (inside.some((s) => sel.includes(s)) ? {} : null) }) as unknown as EventTarget;
  const key = (k: string, target: EventTarget | null, extra: object = {}) => ({ key: k, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...extra });
  it('Space and Enter show the line whole on the page or in the conversation list', () => {
    expect(skipsTyping(key(' ', el('BODY')))).toBe(true);
    expect(skipsTyping(key('Enter', el('BODY')))).toBe(true);
    expect(skipsTyping(key('Enter', el('DIV', ['chat-scroll'])))).toBe(true);
  });
  it('never takes a key meant for a field, button, link or terminal', () => {
    for (const tag of ['textarea', 'input', 'select', 'button', 'a', '[contenteditable]', '[role="textbox"]']) {
      expect(skipsTyping(key('Enter', el('DIV', [tag, 'chat-scroll'])))).toBe(false);
      expect(skipsTyping(key(' ', el('DIV', [tag, 'chat-scroll'])))).toBe(false);
    }
  });
  it('ignores other keys, shortcuts, IME composition and focus in some other panel', () => {
    expect(skipsTyping(key('a', el('BODY')))).toBe(false);
    expect(skipsTyping(key('Enter', el('BODY'), { shiftKey: true }))).toBe(false);
    expect(skipsTyping(key(' ', el('BODY'), { ctrlKey: true }))).toBe(false);
    expect(skipsTyping(key('Enter', el('BODY'), { isComposing: true }))).toBe(false);
    expect(skipsTyping(key('Enter', el('DIV')))).toBe(false);
  });
});

describe('placeRecords', () => {
  const r = (at: number): QuestRecord => ({ toolId: `t${at}`, allow: true, at, label: '' });
  it('puts each record after the last item at or before it', () => {
    const placed = placeRecords([10, 20, 30], [r(5), r(20), r(25), r(99)]);
    expect([...placed.entries()].map(([i, list]) => [i, list.map((x) => x.at)])).toEqual([
      [-1, [5]],
      [1, [20, 25]],
      [2, [99]],
    ]);
  });
});

describe('questionText', () => {
  it("is the lead's last paragraph, its end kept when long", () => {
    const items = [
      { kind: 'assistant' as const, text: 'old?' },
      { kind: 'assistant' as const, text: 'Done with A.\n\nShould I deploy?' },
      { kind: 'tool' as const, text: 'Bash' },
    ];
    expect(questionText(items)).toBe('Should I deploy?');
    expect(questionText(undefined)).toBe('');
    const long = questionText([{ kind: 'assistant', text: 'One. Two. Three. Four. Should I deploy?' }]);
    expect(long).toBe('\u2026Three. Four. Should I deploy?');
  });
});

it('gameMessenger.css animates only under :root[data-game-motion=on]', () => {
  const css = fs
    .readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'gameMessenger.css'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , body]) => /\banimation\b/.test(body));
  expect(rules.length).toBeGreaterThan(0);
  for (const [, selector] of rules) for (const s of selector.split(',')) expect(s.trim()).toMatch(/^:root\[data-game-motion='on'\] /);
});
