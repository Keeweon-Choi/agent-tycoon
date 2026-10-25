/**
 * D3b (F-20, design-d3b.md): replacing a project's Lead by promoting one of its
 * Workers, when agent names are the address. Names are slots: the two
 * assignments swap names. The promoted Worker's assignment becomes the lead
 * (it answers to the project's name), the old Lead's becomes a Worker under the
 * Worker's former name. Every store keyed by a name keeps meaning "whoever
 * answers to it"; the per-session ones are reset because both sessions restart.
 *
 * Which fields go where (§3.1): the agent's own (provider, model, effort,
 * permission mode, compaction nudge, its conversation) follow the assignment;
 * the Lead seat's (title, rulesFile, remoteControl, alwaysOn) stay with the
 * project's name, and the Worker's former values of those go to the old Lead.
 *
 * The commit (§3.2 step 5) is written from a journal, lead-swap.json, so a crash
 * at any point either leaves the old pair (before the journal) or is rolled
 * forward on the next engine start: applySwap is idempotent. lead-history.json
 * records each old Lead's term, so the project chat scrolls back into it.
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../core/src/cld/serverText.js';
import type { BoardTask } from '../../../../core/src/messages.js';
import { configDir, shortStamp } from './events.js';
import { summarizeEvent } from './eventSummary.js';
import { readdressFiles, writeAtomic } from './messenger.js';
import type { LeadRecord, ProjectRecord } from './registry.js';
import {
  assignmentsPath,
  joinRegistry,
  linkWorkers,
  registryFault,
  splitRegistry,
} from './registry.js';

export type OldLead = 'worker' | 'stop';

/** Stay with the Lead seat (the project's name): swapped between the two records. */
export const LEAD_SEAT = ['title', 'rulesFile', 'remoteControl', 'alwaysOn'] as const;
/** The agent's own launch fields: they follow its assignment. */
const AGENT_OWN = ['provider', 'model', 'effort', 'permissionMode', 'compactionNudge'] as const;

const pick = (r: ProjectRecord, keys: readonly (keyof ProjectRecord)[]): Partial<ProjectRecord> =>
  Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));

/**
 * The registry after promoting Worker `worker`: its assignment leads the project
 * under the project's name (a fresh conversation, wantRunning), the old Lead's
 * assignment is a Worker named `worker` (its conversation kept; on only with
 * `oldLead: worker`). Every other record as it is. Refused (an error) when
 * `worker` is not a Worker or the pair does not load as one Lead per project.
 */
export function promotePair(
  records: ProjectRecord[],
  worker: string,
  oldLead: OldLead,
): { records: LeadRecord[]; lead: ProjectRecord; worker: ProjectRecord } | { error: string } {
  const w = records.find((r) => r.name === worker);
  if (!w?.role || !w.assignmentId) return { error: koText('not_a_worker', { name: worker }) };
  const l = records.find((r) => !r.role && r.projectId === w.projectId);
  if (!l?.leadAssignmentId) return { error: koText('worker_lead_missing') };
  const lead: ProjectRecord = {
    projectId: l.projectId,
    leadAssignmentId: w.assignmentId,
    name: l.name,
    folder: l.folder,
    ...(l.room !== undefined && { room: l.room }),
    ...pick(w, AGENT_OWN),
    ...pick(l, LEAD_SEAT),
    wantRunning: true,
  };
  const demoted: ProjectRecord = {
    projectId: l.projectId,
    assignmentId: l.leadAssignmentId,
    role: 'worker',
    name: w.name,
    folder: l.folder,
    ...pick(l, AGENT_OWN),
    ...pick(w, LEAD_SEAT),
    wantRunning: oldLead === 'worker',
    ...(l.sessionId && { sessionId: l.sessionId }),
    ...(l.backgroundId && { backgroundId: l.backgroundId }),
    // Its conversation was the Lead's (its job keeps the Lead's -n and flags): every later
    // start, not only the swap's own, continues it as a copy under this Worker's identity.
    ...(l.sessionId && { resumeAsCopy: true as const }),
  };
  const next = linkWorkers(records.map((r) => (r === l ? lead : r === w ? demoted : r))) as LeadRecord[];
  const pair = splitRegistry(next);
  const joined = joinRegistry(pair.projects, pair.assignments);
  const problem = joined.broken ?? (joined.orphans.length ? 'an assignment without a project' : null);
  if (problem) return { error: koText('swap_list_unreadable', { why: problem }) };
  return { records: next, lead, worker: demoted };
}

/** One old Lead's time in the seat: its conversation up to `bytes`, until `endedAt`. */
export interface LeadTerm {
  projectId: string;
  assignmentId: string;
  sessionId: string;
  /** Its transcript file (the provider's path) and its size at the stop. */
  transcript: string;
  bytes: number;
  endedAt: number;
}

export interface SwapJournal {
  v: 1;
  projectId: string;
  at: number;
  /** The old Lead's and the promoted Worker's assignment ids. */
  from: string;
  to: string;
  oldLead: OldLead;
  /** The project's name (the Lead slot) and the Worker's (the Worker slot). */
  names: { lead: string; worker: string };
  /** The two registry files as the commit writes them ('' once they are written). */
  projects: string;
  assignments: string;
  /** 'effects': the registry is written; only the effects after it remain (a replay must not
   *  write the registry again: it would revert later changes). */
  phase?: 'effects';
  term: LeadTerm | null;
  prompts: { lead: string; worker: string | null };
}

export const journalPath = (home: string): string => path.join(configDir(home), 'lead-swap.json');
export const leadHistoryPath = (home: string): string =>
  path.join(configDir(home), 'lead-history.json');
/** lead-history.json's version (cld/release/version.json's dataSchema lists it). */
export const LEAD_HISTORY_VERSION = 1;

const str = (v: unknown): v is string => typeof v === 'string';

function validTerm(t: unknown): t is LeadTerm {
  const o = t as Partial<LeadTerm> | null;
  return (
    !!o &&
    str(o.projectId) &&
    str(o.assignmentId) &&
    str(o.sessionId) &&
    str(o.transcript) &&
    Number.isInteger(o.bytes) &&
    Number.isInteger(o.endedAt)
  );
}

/** The journal on disk; null when there is none, 'unreadable' when it is not one. */
export function readJournal(home: string): SwapJournal | null | 'unreadable' {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath(home), 'utf-8');
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(raw) as Partial<SwapJournal>;
    const ok =
      j.v === 1 &&
      str(j.projectId) &&
      Number.isInteger(j.at) &&
      str(j.from) &&
      str(j.to) &&
      (j.oldLead === 'worker' || j.oldLead === 'stop') &&
      !!j.names &&
      str(j.names.lead) &&
      str(j.names.worker) &&
      (j.phase === undefined || j.phase === 'effects') &&
      str(j.projects) &&
      str(j.assignments) &&
      (j.phase === 'effects' || (!!j.projects && !!j.assignments)) &&
      (j.term === null || validTerm(j.term)) &&
      !!j.prompts &&
      str(j.prompts.lead) &&
      (j.prompts.worker === null || str(j.prompts.worker));
    return ok ? (j as SwapJournal) : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

export function writeJournal(home: string, j: SwapJournal): void {
  writeAtomic(journalPath(home), JSON.stringify(j));
}

/** Every recorded term, oldest first (an unreadable file reads as none). */
export function readLeadHistory(home: string): LeadTerm[] {
  try {
    const j = JSON.parse(fs.readFileSync(leadHistoryPath(home), 'utf-8')) as { v?: unknown; terms?: unknown };
    return j.v === LEAD_HISTORY_VERSION && Array.isArray(j.terms) ? j.terms.filter(validTerm) : [];
  } catch {
    return [];
  }
}

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
};

/** The inbox prompts' fixed names (a re-run overwrites them; "0-" sorts before every stamp). */
export const leadPromptFile = (home: string, j: Pick<SwapJournal, 'names' | 'at'>) =>
  path.join(configDir(home), 'inbox', j.names.lead, `0-lead-${j.at}.md`);
export const rolePromptFile = (home: string, j: Pick<SwapJournal, 'names' | 'at'>) =>
  path.join(configDir(home), 'inbox', j.names.worker, `0-role-${j.at}.md`);

/**
 * §3.2 step 5, the commit, idempotent (also run at engine start while the journal is there):
 * a. assignments.json, then projects.json, from the journal's texts (a crash between them
 *    leaves a mix that loads as broken, never as two Leads; the next start rolls forward);
 *    then the journal is rewritten to its 'effects' phase, without the registry: from here on
 *    a replay (an error below, a crash) only finishes the effects, never rewrites the registry;
 * b. the old Lead's term into lead-history.json; c. what was on its way to the Worker's name
 * goes to the project's; d. both names' typed/ hints deleted; e. the prompts into the inboxes;
 * f. the journal removed. registryFault.afterWrite runs after each step (the tests' crashes).
 */
export function applySwap(
  home: string,
  registryFile: string,
  j: SwapJournal,
  log: (line: string) => void = () => undefined,
): void {
  const done = (file: string) => registryFault.afterWrite?.(file);
  const write = (file: string, text: string) => {
    if (readText(file) !== text) writeAtomic(file, text);
    done(file);
  };
  if (j.phase !== 'effects') {
    write(assignmentsPath(registryFile), j.assignments);
    write(registryFile, j.projects);
    writeJournal(home, { ...j, phase: 'effects', projects: '', assignments: '' });
    done(journalPath(home));
  }
  if (j.term) {
    const terms = readLeadHistory(home);
    const t = j.term;
    if (!terms.some((x) => x.sessionId === t.sessionId && x.endedAt === t.endedAt))
      writeAtomic(leadHistoryPath(home), JSON.stringify({ v: LEAD_HISTORY_VERSION, terms: [...terms, t] }));
    done(leadHistoryPath(home));
  }
  readdressFiles(home, j.names.worker, j.names.lead, j.at, log);
  done(path.join(configDir(home), 'queue'));
  for (const name of [j.names.lead, j.names.worker])
    fs.rmSync(path.join(configDir(home), 'typed', `${name}.json`), { force: true });
  done(path.join(configDir(home), 'typed'));
  write(leadPromptFile(home, j), j.prompts.lead);
  if (j.prompts.worker !== null) write(rolePromptFile(home, j), j.prompts.worker);
  fs.rmSync(journalPath(home), { force: true });
  done(journalPath(home));
}

// ── §3.3 the new Lead's first prompt ────────────────────────────

const PROMPT_MAX = 8_000;
const TASKS_MAX = 30;
const FINISHED_MAX = 10;
const EVENTS_MAX = 40;
const DAY_MS = 24 * 60 * 60_000;

const oneLine = (s: string, max = 80) => s.replace(/[\r\n]+/g, ' ').slice(0, max);

/** The last `max` event one-liners of the last 24 h that concern `names` (summarizeEvent's,
 *  which copy no message bodies, commands or paths), oldest first. */
export function eventLines(
  records: Array<Record<string, unknown>>,
  names: readonly string[],
  now: number,
  max = EVENTS_MAX,
): string[] {
  const mine = (v: unknown) => typeof v === 'string' && names.includes(v);
  const lines: string[] = [];
  for (const e of records) {
    if (!mine(e.name) && !mine(e.to) && !mine(e.from) && !mine(e.project)) continue;
    const s = summarizeEvent(e);
    const at = s ? Date.parse(s.ts) : NaN;
    if (!s || !(now - at <= DAY_MS)) continue;
    lines.push(`${shortStamp(at)} ${oneLine(s.summary, 120)}`);
  }
  return lines.slice(-max);
}

export interface LeadBriefing {
  when: string;
  /** The clock "recently finished" is measured against. */
  now: number;
  project: string;
  worker: string;
  oldLead: OldLead;
  workerTranscript: string | null;
  leadTranscript: string | null;
  /** The project's Tasks (any status; the open ones are listed). */
  tasks: BoardTask[];
  /** An assignee's name after the swap, by its assignment id. */
  nameOf: (assignmentId: string) => string | undefined;
  /** Jobs and Codex tasks of the project still running ("<title> <id>"). */
  running: string[];
  workers: Array<{ name: string; role: string; on: boolean }>;
  events: string[];
}

/** When `t` last moved to its status `done` or `review` (its history), within 24 h of `now`. */
function finishedAt(t: BoardTask, now: number): number | null {
  if (t.status !== 'done' && t.status !== 'review') return null;
  const to = new RegExp(`(^|, )status [^,]* → ${t.status}(,|$)`);
  const last = [...(t.history ?? [])].reverse().find((h) => to.test(h.change));
  const at = last ? Date.parse(last.at) : NaN;
  return now - at <= DAY_MS ? at : null;
}

/** The new Lead's first message: names, ids, titles, statuses and event one-liners only. */
export function leadPrompt(b: LeadBriefing): string {
  const open = b.tasks
    .filter((t) => t.status !== 'done')
    .sort((x, y) => (y.updatedAt ?? '').localeCompare(x.updatedAt ?? ''));
  // EX-7b: what a Worker finished while the Lead was off (done or handed to review, last 24 h).
  const finished = b.tasks
    .map((t) => ({ t, at: finishedAt(t, b.now) }))
    .filter((x): x is { t: BoardTask; at: number } => x.at !== null)
    .sort((x, y) => y.at - x.at);
  const taskLine = (t: BoardTask) =>
    [
      `#${t.id} ${oneLine(t.title)}`,
      t.status,
      // A proposal (C6) waits for the Lead seat, whoever holds it: the project's name.
      `담당 ${(t.assignee && (t.status === 'proposed' ? b.project : (b.nameOf(t.assignee.assignmentId) ?? t.assignee.name))) || '없음'}`,
      ...(t.parentId ? [`부모 #${t.parentId}`] : []),
    ].join(' · ');
  const build = (shown: number, done: number, events: string[]) => {
    const more = open.length - shown;
    return [
      `[cld-gui Lead 교체 · ${b.when}] 이제 너는 프로젝트 '${b.project}' 의 Lead 다. 사용자와 다른 에이전트는 '${b.project}' 로 너를 부른다.`,
      `이전 Lead 는 이제 Worker '${b.worker}'(${b.oldLead === 'worker' ? '켜짐' : '멈춤'}) 다. 너의 Worker 시절 대화: ${b.workerTranscript ?? '없음'}. 이전 Lead 대화: ${b.leadTranscript ?? '없음'} (필요하면 읽어라).`,
      `열린 Task (${open.length}개):${open.length ? '' : ' 없음'}`,
      ...open.slice(0, shown).map(taskLine),
      ...(more > 0 ? [`… ${more}개 더 — get_task_status`] : []),
      ...(finished.length
        ? [
            `최근 끝난 Task (24시간, ${finished.length}개):`,
            ...finished.slice(0, done).map(({ t, at }) => `${taskLine(t)} · ${shortStamp(at)}`),
            ...(finished.length > done ? [`… ${finished.length - done}개 더 — get_task_status`] : []),
          ]
        : []),
      `돌고 있는 일: ${b.running.length ? b.running.map((r) => oneLine(r)).join(', ') : '없음'}`,
      ...(b.workers.length
        ? b.workers.map((w) => `Worker: ${w.name} · ${w.role} · ${w.on ? '켜짐' : '꺼짐'}`)
        : ['Worker: 없음']),
      `최근 이벤트 (24시간, ${events.length}줄):${events.length ? '' : ' 없음'}`,
      ...events,
      '먼저 Task 현황을 확인하고, 필요하면 Worker 에게 맡겨 이어서 진행하라. 할 일이 없으면 기다린다.',
    ].join('\n');
  };
  let shown = Math.min(open.length, TASKS_MAX);
  let done = Math.min(finished.length, FINISHED_MAX);
  let events = b.events.slice(-EVENTS_MAX);
  let text = build(shown, done, events);
  while (text.length > PROMPT_MAX && shown > 0) text = build(--shown, done, events);
  while (text.length > PROMPT_MAX && done > 0) text = build(shown, --done, events);
  while (text.length > PROMPT_MAX && events.length)
    text = build(shown, done, (events = events.slice(1)));
  return text.slice(0, PROMPT_MAX);
}

/** The old Lead's notice when it goes on as a Worker. */
export const roleNotice = (project: string, worker: string, when: string): string =>
  `[cld-gui Lead 교체 · ${when}] Lead 는 이제 '${project}' 다. 너는 Worker '${worker}' 이다. 맡은 Task 만 하고 새 일은 create_task 로 Lead 에게 제안하라. 하던 Lead 일은 새 Lead 가 이어받으니 안전한 지점에서 멈추고 기다린다.`;

/**
 * §3.4 the project chat's scroll-back: the transcript a Lead contact's history continues
 * into from `file` (whose first record is at `start`): the newest recorded term of the same
 * project that ended by then, from its byte offset. `projectOf` names the project whose Lead
 * runs that session now (else a term's own session tells it). Null: no term, the caller's
 * heuristic decides.
 */
export function leadTermBefore(
  terms: LeadTerm[],
  file: string,
  start: number,
  projectOf: (sessionId: string) => string | null,
): { file: string; end: number } | null {
  const sid = path.basename(file, '.jsonl');
  const projectId = projectOf(sid) ?? terms.find((t) => t.sessionId === sid)?.projectId;
  if (!projectId) return null;
  const t = terms
    .filter((x) => x.projectId === projectId && x.sessionId !== sid && x.endedAt <= start)
    .sort((a, b) => b.endedAt - a.endedAt)[0];
  return t ? { file: t.transcript, end: t.bytes } : null;
}
