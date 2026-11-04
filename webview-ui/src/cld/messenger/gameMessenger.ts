/**
 * GAME-UI-1 G1 (specs/ui-mock-1103 ideas/messenger 01, 02, 04): the messenger's game parts as pure
 * functions, and the 타자 효과 switch. Motion itself is gameMotion.ts's call; this only plans it.
 *   typePlan          how a new line types in: the characters shown at each tick (a time per sentence, capped)
 *   sentenceEndStep   the first press on a typing reply: on to the end of the sentence being typed
 *   skipsTyping       which key presses move a typing reply on (never one meant for a field)
 *   placeRecords      where the folded quest records sit among the conversation's items
 *   arcPoint          the envelope's flight: a quadratic arc above the straight line, whole pixels
 * The switch is per browser (like 게임 효과): localStorage behind try/catch, on by default.
 */
import { useSyncExternalStore } from 'react';

import type { ChatItem } from '../../../../core/src/messages.js';
import { MSG_ENVELOPE_ARC_PX, MSG_QUESTION_SENTENCES, MSG_TYPE_MAX_MS, MSG_TYPE_SENTENCE_MS, MSG_TYPE_TICK_MS } from '../../constants.js';
import { splitSentences } from './sentences.js';

/** How a new line types in: the characters shown after each tick (the last is the whole line); null = nothing
 *  to type. Every sentence gets MSG_TYPE_SENTENCE_MS (its characters share it evenly), the whole reply at most
 *  MSG_TYPE_MAX_MS: past that every sentence just gets less. Korean and English take as long for the same
 *  number of sentences. */
export function typePlan(text: string): number[] | null {
  const sentences = splitSentences(text).map((s) => Array.from(s).length);
  if (sentences.length === 0) return null;
  const ticks = Math.floor(Math.min(sentences.length * MSG_TYPE_SENTENCE_MS, MSG_TYPE_MAX_MS) / MSG_TYPE_TICK_MS);
  const perSentence = ticks / sentences.length;
  const total = sentences.reduce((a, b) => a + b, 0);
  const plan: number[] = [];
  for (let k = 1; k < ticks; k++) {
    const at = k / perSentence;
    const i = Math.floor(at);
    plan.push(sentences.slice(0, i).reduce((a, b) => a + b, 0) + Math.round((at - i) * sentences[i]));
  }
  plan.push(total);
  return plan;
}

/** The first press on a typing reply: the tick (an index into `plan`) at which the sentence being typed is whole;
 *  typing goes on from there with the next sentence. The end of the plan when it was the last one. */
export function sentenceEndStep(text: string, plan: readonly number[], step: number): number {
  let end = 0;
  for (const s of splitSentences(text)) {
    end += Array.from(s).length;
    if (end > plan[step]) break;
  }
  const to = plan.findIndex((n) => n >= end);
  return to < 0 ? plan.length - 1 : Math.max(step, to);
}

/** Space or Enter pressed with nothing to type into: the page itself or the conversation list, not a field,
 *  button, link or terminal (those keep their key: Enter sends, Space is a space). */
const KEEPS_KEYS = 'input,textarea,select,button,a,summary,[contenteditable],[role="textbox"],[role="button"],[role="combobox"]';
export function skipsTyping(e: Pick<KeyboardEvent, 'key' | 'target' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>): boolean {
  if ((e.key !== ' ' && e.key !== 'Enter') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return false;
  const el = e.target as Element | null;
  if (el?.closest?.(KEEPS_KEYS)) return false;
  return !el?.tagName || el.tagName === 'BODY' || el.tagName === 'HTML' || !!el.closest?.('[data-testid="chat-scroll"]');
}

/** The first `count` characters (code points, so an emoji is never split). */
export const typedSlice = (text: string, count: number): string => Array.from(text).slice(0, count).join('');

/** A question wait's request: the lead's last words, their last paragraph, its last MSG_QUESTION_SENTENCES sentences. */
export function questionText(items: readonly Pick<ChatItem, 'kind' | 'text'>[] | undefined): string {
  const last = [...(items ?? [])].reverse().find((i) => i.kind === 'assistant')?.text.trim() ?? '';
  const para = last.split(/\n\s*\n/).at(-1)?.trim() ?? '';
  const sentences = splitSentences(para);
  return sentences.length > MSG_QUESTION_SENTENCES ? `\u2026${sentences.slice(-MSG_QUESTION_SENTENCES).join('').trim()}` : para;
}

/** A folded quest: what was asked, the answer and when (the stamp's words come from `allow`). */
export interface QuestRecord {
  toolId: string;
  allow: boolean;
  at: number;
  label: string;
}

/** Each record goes after the last item at or before its time (index -1: before them all). */
export function placeRecords(itemTimes: readonly number[], records: readonly QuestRecord[]): Map<number, QuestRecord[]> {
  const out = new Map<number, QuestRecord[]>();
  for (const r of records) {
    let at = -1;
    for (let i = 0; i < itemTimes.length; i++) if (itemTimes[i] <= r.at) at = i;
    out.set(at, [...(out.get(at) ?? []), r]);
  }
  return out;
}

/** The envelope at `t` (0..1) on a quadratic arc lifted MSG_ENVELOPE_ARC_PX over the higher end; whole pixels. */
export function arcPoint(from: { x: number; y: number }, to: { x: number; y: number }, t: number): { x: number; y: number } {
  const cx = (from.x + to.x) / 2;
  const cy = Math.min(from.y, to.y) - MSG_ENVELOPE_ARC_PX;
  const u = 1 - t;
  return {
    x: Math.round(u * u * from.x + 2 * u * t * cx + t * t * to.x),
    y: Math.round(u * u * from.y + 2 * u * t * cy + t * t * to.y),
  };
}

// ── 타자 효과 (the conversation header's switch) ──
export const TYPEWRITER_KEY = 'cld.typewriter';
let typing = (() => {
  try {
    return localStorage.getItem(TYPEWRITER_KEY) !== 'off';
  } catch {
    return true;
  }
})();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const typewriterOn = () => typing;
export const useTypewriter = () => useSyncExternalStore(subscribe, typewriterOn);
export function setTypewriter(on: boolean): void {
  typing = on;
  try {
    localStorage.setItem(TYPEWRITER_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode: this visit still remembers it.
  }
  listeners.forEach((l) => l());
}
