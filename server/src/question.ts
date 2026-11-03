/**
 * WAITING-PERSIST (owner 11-03 12:18): an agent whose main turn ended on a question to the person
 * (its last assistant text ends with '?') keeps that question in its state until the person
 * answers or the agent goes on. It is saved in its own small office file, questions.json (keyed by
 * transcript, bounded, 0600, tmp+rename), so a daemon restart gives it back when the transcript is
 * bound again. Claude's idle_prompt (60 s without input after ANY turn) is no question. Nothing
 * here talks to the agent.
 */
import * as fs from 'fs';
import * as path from 'path';

import { QUESTION_RECONCILE_MAX_BYTES, QUESTIONS_FILE_NAME, QUESTIONS_MAX } from './constants.js';
import { officeFile } from './officeFolder.js';
import type { AgentState } from './types.js';

// ── The rule ─────────────────────────────────────────────────

/** Trailing whitespace, markdown emphasis, closing quotes and brackets (never a backtick). */
const TRAILING = /[\s*_~"'”’»」』)\]}>]+$/u;

/** A text that ends asking: '?' or '？' once the trailing marks are stripped. A text that ends with
 *  code (inline `isReady?`, a closing fence) or inside an open fence is no question. */
export function endsWithQuestion(text: string | undefined): boolean {
  if (!text || (text.match(/```/g)?.length ?? 0) % 2 === 1) return false;
  const last = text.replace(TRAILING, '').at(-1);
  return last === '?' || last === '？';
}

/** Only the person's own agents ask the person: a teammate asks its Lead, a sub-agent its parent. */
const asksThePerson = (a: AgentState): boolean =>
  a.leadAgentId === undefined && !a.agentName && !a.spawnToolUseId;

// ── questions.json ───────────────────────────────────────────

let file: string | null = null;
let saved: Map<string, number> | null = null;

/** Where the questions are saved: the daemon names the office file at start (cli.ts), a test its own;
 *  until then they live in memory only, so no test can reach a real home. */
export function useQuestionStore(at: string = officeFile(QUESTIONS_FILE_NAME)): void {
  file = at;
  saved = null;
}

function load(): Map<string, number> {
  if (saved) return saved;
  saved = new Map();
  if (!file) return saved;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [file, offset] of Object.entries(raw)) {
      // An entry whose transcript is gone has no agent to come back to.
      if (typeof offset === 'number' && fs.existsSync(file)) saved.set(file, offset);
    }
  } catch {
    /* none yet, or junk: no saved questions */
  }
  return saved;
}

function save(): void {
  const map = load();
  // ponytail: oldest first out past QUESTIONS_MAX; the owner never has that many open at once.
  while (map.size > QUESTIONS_MAX) map.delete(map.keys().next().value!);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[Agent Tycoon] Failed to save questions:', err);
  }
}

// ── State changes ─────────────────────────────────────────────

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function ask(agent: AgentState): void {
  agent.questionOffset = sizeOf(agent.jsonlFile);
  if (!agent.jsonlFile) return;
  const map = load();
  map.delete(agent.jsonlFile); // re-insert: newest last
  map.set(agent.jsonlFile, agent.questionOffset);
  save();
}

/** The person answered or the agent went on: the question is gone. */
export function endQuestion(agent: AgentState): void {
  if (agent.questionOffset === undefined) return;
  agent.questionOffset = undefined;
  if (agent.jsonlFile && load().delete(agent.jsonlFile)) save();
}

/**
 * A main turn ended: a question when its last assistant text asks, else none. Returns whether
 * the state changed (the caller says so to the browsers).
 */
export function settleQuestion(agent: AgentState): boolean {
  const before = agent.questionOffset !== undefined;
  if (asksThePerson(agent) && endsWithQuestion(agent.lastAssistantText)) {
    if (!before) ask(agent);
  } else endQuestion(agent);
  return before !== (agent.questionOffset !== undefined);
}

/** Restart: the saved question of this agent's transcript comes back unless the conversation went
 *  on meanwhile. Sends nothing to the agent; the connect resend shows it. */
export function restoreQuestion(agent: AgentState): void {
  if (!agent.jsonlFile) return;
  const offset = load().get(agent.jsonlFile);
  if (offset === undefined) return;
  if (answeredSince(agent.jsonlFile, offset)) {
    load().delete(agent.jsonlFile);
    save();
    return;
  }
  agent.isWaiting = true;
  agent.questionOffset = offset;
}

/**
 * Did the conversation go on after `offset` (a user or assistant record) while the daemon was
 * down? A shorter, unreadable or much longer file counts as answered.
 */
export function answeredSince(file: string, offset: number): boolean {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    if (size < offset || size - offset > QUESTION_RECONCILE_MAX_BYTES) return true;
    if (size === offset) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
  return text.split('\n').some((line) => {
    try {
      const type = (JSON.parse(line) as { type?: unknown }).type;
      return type === 'user' || type === 'assistant';
    } catch {
      return false; // a half-written or junk line says nothing
    }
  });
}
