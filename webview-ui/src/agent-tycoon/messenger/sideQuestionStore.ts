/**
 * T-115 사이드 질문 (variant B): a drawer beside a Lead's conversation where the owner asks
 * something answered from a read-only copy of that conversation; the Lead keeps working and its
 * conversation is not changed. The exchanges live here, in this page, until the drawer is closed;
 * 리드에게 전달 queues one ordinary message to the Lead through the messenger's own send.
 */
import { useSyncExternalStore } from 'react';

import type {
  ChatSend,
  ChatView,
  CliModel,
  SideAnswer,
  SideAsk,
  SideCancel,
} from '../../../../core/src/messages.js';
import {
  SIDE_ANSWER_MAX,
  SIDE_QUESTION_DEFAULT_MODEL,
  SIDE_QUESTION_EARLIER_MAX,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { DEFAULT_PROVIDER, PTY_PROVIDER } from '../engine.js';
import { serverText } from '../serverText.js';
import { messengerSend } from './messengerStore.js';

export interface SideCard {
  /** The sideAsk's requestId. */
  id: string;
  question: string;
  model: string;
  state: 'asking' | 'answered' | 'failed';
  text?: string;
  error?: string;
  at: number;
  forwarded?: boolean;
}

export interface SideSnapshot {
  /** The Lead whose drawer is open (one at a time), or null. */
  open: number | null;
  /** The model the next question goes to; null = the default. */
  model: string | null;
  /** The models the user's Claude Code lists (the slash list's initialize answer). */
  models: CliModel[];
  cards: Record<number, SideCard[]>;
}

const initial = (): SideSnapshot => ({ open: null, model: null, models: [], cards: {} });
let snapshot = initial();
const listeners = new Set<() => void>();
let seq = 0;
const set = (next: Partial<SideSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
};
const setCards = (agentId: number, cards: SideCard[]) =>
  set({ cards: { ...snapshot.cards, [agentId]: cards } });

export const sideSubscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const sideGetSnapshot = () => snapshot;
export const useSideQuestion = () => useSyncExternalStore(sideSubscribe, sideGetSnapshot);

/** The model a question goes to: the one picked, else the default when the CLI lists it, else its first. */
export function sideModel(s: Pick<SideSnapshot, 'model' | 'models'> = snapshot): string {
  if (s.model) return s.model;
  if (!s.models.length || s.models.some((m) => m.value === SIDE_QUESTION_DEFAULT_MODEL))
    return SIDE_QUESTION_DEFAULT_MODEL;
  return s.models[0].value;
}

/** The name the CLI gives a model value (its value when unlisted). */
export const sideModelName = (value: string, models: CliModel[] = snapshot.models): string =>
  models.find((m) => m.value === value)?.displayName ?? value;

/** A side question forks a Claude Code conversation: a Lead whose engine project runs Claude, in
 *  its background session or our PTY host (the daemon's cliOf), never Codex or another agent. */
export const sideForProvider = (provider: string | undefined): boolean =>
  !provider || provider === DEFAULT_PROVIDER || provider === PTY_PROVIDER;

export const sideAsking = (agentId: number, s: SideSnapshot = snapshot): boolean =>
  (s.cards[agentId] ?? []).some((c) => c.state === 'asking');

export function sideModelsCame(models: CliModel[] | undefined): void {
  if (models?.length) set({ models });
}

export function sideOpen(agentId: number): void {
  if (snapshot.open !== agentId) set({ open: agentId });
}

/** 닫기 on the drawer: its exchanges go with it, and a question still waiting is stopped (the daemon's fork). */
export function sideClose(send: (m: SideCancel) => void, agentId: number): void {
  for (const c of snapshot.cards[agentId] ?? [])
    if (c.state === 'asking') send({ type: 'sideCancel', requestId: c.id });
  const cards = { ...snapshot.cards };
  delete cards[agentId];
  set({ cards, ...(snapshot.open === agentId && { open: null }) });
}

export function sidePickModel(model: string): void {
  set({ model });
}

/** The drawer's earlier answered exchanges, newest last, that the next question carries (each
 *  answer cut to the protocol's limit: a longer one would get the whole ask refused). */
export function sideEarlier(cards: SideCard[]): SideAsk['earlier'] {
  return cards
    .filter((c) => c.state === 'answered' && c.text)
    .slice(-SIDE_QUESTION_EARLIER_MAX)
    .map((c) => ({ question: c.question, answer: c.text!.slice(0, SIDE_ANSWER_MAX) }));
}

/** 물어보기: false (nothing sent) while this drawer still waits for an answer or with no text. */
export function sideAsk(
  send: (m: SideAsk) => void,
  agentId: number,
  question: string,
  replace?: string,
): boolean {
  const q = question.trim();
  if (!q || sideAsking(agentId)) return false;
  const all = snapshot.cards[agentId] ?? [];
  const kept = replace ? all.filter((c) => c.id !== replace) : all;
  const id = `${Date.now().toString(36)}-s${++seq}`;
  const model = sideModel();
  setCards(agentId, [...kept, { id, question: q, model, state: 'asking', at: Date.now() }]);
  send({ type: 'sideAsk', requestId: id, agentId, question: q, model, earlier: sideEarlier(kept) });
  return true;
}

/** 다시 시도 on a failed card: the same question again, in its place. */
export function sideRetry(send: (m: SideAsk) => void, agentId: number, id: string): boolean {
  const card = snapshot.cards[agentId]?.find((c) => c.id === id);
  return !!card && sideAsk(send, agentId, card.question, id);
}

/** 닫기 on one card: that question and its answer are gone. */
export function sideDismiss(agentId: number, id: string): void {
  setCards(
    agentId,
    (snapshot.cards[agentId] ?? []).filter((c) => c.id !== id),
  );
}

/** The one message 리드에게 전달 queues: the question and the answer, marked as a side question. */
export const sideForwardText = (card: SideCard): string =>
  t('sideq.forwardText', {
    question: card.question,
    answer: (card.text ?? '').replace(/\r\n?/g, '\n'),
    model: sideModelName(card.model),
  });

/** 리드에게 전달: one ordinary message through the messenger's send (queued while the Lead works). */
export function sideForward(
  send: (m: ChatSend | ChatView) => void,
  connected: boolean,
  agentId: number,
  name: string,
  id: string,
): void {
  const card = snapshot.cards[agentId]?.find((c) => c.id === id);
  if (!card || card.state !== 'answered' || card.forwarded) return;
  messengerSend(send, connected, agentId, name, sideForwardText(card));
  setCards(
    agentId,
    (snapshot.cards[agentId] ?? []).map((c) => (c.id === id ? { ...c, forwarded: true } : c)),
  );
}

export function sideHandleMessage(msg: SideAnswer): void {
  const cards = snapshot.cards[msg.agentId];
  if (!cards?.some((c) => c.id === msg.requestId && c.state === 'asking')) return;
  setCards(
    msg.agentId,
    cards.map((c) =>
      c.id !== msg.requestId
        ? c
        : msg.ok && msg.text
          ? { ...c, state: 'answered', text: msg.text, at: Date.now() }
          : { ...c, state: 'failed', error: serverText(msg, t('sideq.failed')), at: Date.now() },
    ),
  );
}

/** The socket is gone: an answer can no longer come. */
export function sideConnectionLost(): void {
  const cards: SideSnapshot['cards'] = {};
  for (const [id, list] of Object.entries(snapshot.cards))
    cards[Number(id)] = list.map((c) =>
      c.state === 'asking' ? { ...c, state: 'failed', error: t('sideq.disconnected') } : c,
    );
  set({ cards });
}

export function sideResetForTests(): void {
  snapshot = initial();
}
