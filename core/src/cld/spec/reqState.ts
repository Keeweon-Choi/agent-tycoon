/**
 * RQ1 (RQW §2.4): a requirement's three states, 아직 · 진행 중 · 확인됨, computed and never stored
 * from the four axes the trace index already has: its issues' states, how its links are known
 * (confirmed, 글에 적힘, 짐작), the acceptance on the current text and whether the text changed.
 * Pure, so the 요구사항 tab and the agent reads give the same answer. Counts and reasons only, no
 * percentage (FR-TRC-008). A guess never makes 확인됨: rule 2 counts confirmed and written links only.
 */
import type { HowCount, LinkHow, ReqFacts, TraceState } from './trace.js';

export const REQ_STATUSES = ['todo', 'doing', 'done'] as const;
export type ReqStatus = (typeof REQ_STATUSES)[number];

/** One fact of the '왜 … 인가요' sentence, in the order it is said. `guess`: it rests on inferred links only. */
export type ReqWhy =
  | { k: 'accepted' }
  | { k: 'seen'; merged: number; passed: number }
  | { k: 'rejected' }
  | { k: 'issue'; id: string; status: string; how: LinkHow }
  | { k: 'commits'; n: number; merged: number; guess: boolean }
  | { k: 'runs'; n: number; passed: number; guess: boolean }
  | { k: 'noRun' }
  | { k: 'reported'; n: number; guess: boolean }
  | { k: 'changed' }
  | { k: 'todoIssues'; n: number }
  | { k: 'none' };

export interface ReqStateView {
  status: ReqStatus;
  /** The facts that set it all come from inferred links (drawn dashed, with the word 짐작). */
  guess: boolean;
  why: ReqWhy[];
}

/** An issue that is being worked on (the Task Board's 진행 중, 검토, 막힘). */
const ACTIVE = new Set(['doing', 'review', 'blocked']);
const EMPTY: ReqFacts = { issues: [], commits: {}, merged: {}, runs: {}, passed: {}, reported: {} };
const firm = (c: HowCount = {}) => (c.confirmed ?? 0) + (c.written ?? 0);
const all = (c: HowCount = {}) => firm(c) + (c.guess ?? 0);

/** RQW §2.4's table, the first row that fits wins, except that a rejection on the current text (3) comes before what was seen (2). */
export function reqState(s?: TraceState): ReqStateView {
  const f = s?.facts ?? EMPTY;
  const acc = s?.acceptance?.current ?? 'none';
  // 내용 바뀜: a confirmed link or an acceptance is on an older text, so what was seen is about that text.
  const changed = s?.freshness === 'review';
  // 1. accepted on the current text
  if (acc === 'accepted') return { status: 'done', guess: false, why: [{ k: 'accepted' }] };
  // 2. merged and passed, both seen by the daemon through confirmed or written links, on this text
  const seen = firm(f.merged) > 0 && firm(f.passed) > 0;
  // (3 before 2: the owner's rejection of this text wins over what the daemon saw, owner 11-06.)
  if (seen && !changed && acc !== 'rejected')
    return {
      status: 'done',
      guess: false,
      why: [{ k: 'seen', merged: firm(f.merged), passed: firm(f.passed) }],
    };
  // 4's facts, each with whether it is a guess only
  const why: ReqWhy[] = [];
  const guesses: boolean[] = [];
  for (const i of f.issues)
    if (ACTIVE.has(i.status) || i.status === 'done') {
      why.push({ k: 'issue', id: i.id, status: i.status, how: i.how });
      guesses.push(i.how === 'guess');
    }
  if (all(f.commits)) {
    why.push({ k: 'commits', n: all(f.commits), merged: all(f.merged), guess: !firm(f.commits) });
    guesses.push(!firm(f.commits));
  }
  if (all(f.runs)) {
    why.push({ k: 'runs', n: all(f.runs), passed: all(f.passed), guess: !firm(f.runs) });
    guesses.push(!firm(f.runs));
  } else if (guesses.length || all(f.reported)) why.push({ k: 'noRun' });
  if (all(f.reported)) {
    why.push({ k: 'reported', n: all(f.reported), guess: !firm(f.reported) });
    guesses.push(!firm(f.reported));
  }
  if (seen && changed) why.push({ k: 'changed' });
  // 3. rejected on the current text
  if (acc === 'rejected')
    return { status: 'doing', guess: false, why: [{ k: 'rejected' }, ...why] };
  // 4. something is moving
  if (guesses.length) return { status: 'doing', guess: guesses.every(Boolean), why };
  // 5. the rest: nothing linked, or issues still to do
  return {
    status: 'todo',
    guess: false,
    why: [f.issues.length ? { k: 'todoIssues', n: f.issues.length } : { k: 'none' }],
  };
}

/** Counts per state, each requirement once (the head and the tree's document and feature rows). */
export function reqStateCounts(states: Iterable<ReqStatus>): Record<ReqStatus, number> {
  const n: Record<ReqStatus, number> = { todo: 0, doing: 0, done: 0 };
  for (const s of states) n[s]++;
  return n;
}
