/**
 * Persistent review notes for task worktrees. The daemon is the sole writer:
 * `review-notes.json` is a small 0600 document, atomically replaced after
 * each edit so a crash cannot leave a partial review behind.
 */
import { randomBytes } from 'crypto';

import { formatDiffComments } from '../../../../../core/src/agent-tycoon/reviewFormat.js';
import type { Coded } from '../../../../../core/src/agent-tycoon/serverText.js';
import { koText, refused } from '../../../../../core/src/agent-tycoon/serverText.js';
import { readJson, writeJsonAtomic } from '../../jsonFile.js';
import { maskText } from '../../mask.js';
import { cleanText } from '../messenger.js';

export const REVIEW_NOTES_VERSION = 1;
export const REVIEW_NOTES_MAX = 200;
export const REVIEW_NOTE_BODY_MAX = 4_000;
export const REVIEW_NOTE_FILE_MAX = 4_096;

export interface ReviewNote {
  id: string;
  file: string;
  /** Review notes only anchor the new side in this first version. */
  side: 'new';
  /** Inclusive range start; absent means the one `line`. */
  startLine?: number;
  /** New-side line; zero is a file-level note. */
  line: number;
  body: string;
  createdAt: string;
  updatedAt?: string;
  sentAt?: string;
  /** `git hash-object` for the file at the note's latest edit. */
  diffIdentity: string;
  by: string;
  /** P4: the worktree's commit (its uncommitted work included) when the note was sent. */
  sentHead?: string;
  /** P4: a hash of the anchored lines (line 0: the file's identity) when it was sent. */
  sentAnchor?: string;
}

export interface ReviewNoteInput {
  file: string;
  side: 'new';
  startLine?: number;
  line: number;
  body: string;
}

interface ReviewNotesFile {
  v: typeof REVIEW_NOTES_VERSION;
  notes: Record<string, ReviewNote[]>;
}

export class ReviewNotesError extends Error {
  constructor(readonly code: 'review_notes_unreadable' | 'review_note_invalid' | 'review_note_limit' | 'review_note_missing') {
    super(koText(code));
  }
}

const keyOf = (project: string, task: string): string => `${project}\0${task}`;
const validTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const validLine = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

const isNote = (value: unknown): value is ReviewNote => {
  const n = value as Partial<ReviewNote> | null;
  return (
    typeof n === 'object' &&
    n !== null &&
    validText(n.id, 80) &&
    validText(n.file, REVIEW_NOTE_FILE_MAX) &&
    n.side === 'new' &&
    validLine(n.line) &&
    (n.startLine === undefined || (validLine(n.startLine) && n.startLine > 0 && n.startLine <= n.line)) &&
    validText(n.body, REVIEW_NOTE_BODY_MAX) &&
    validTimestamp(n.createdAt) &&
    (n.updatedAt === undefined || validTimestamp(n.updatedAt)) &&
    (n.sentAt === undefined || validTimestamp(n.sentAt)) &&
    validText(n.diffIdentity, 80) &&
    validText(n.by, 256) &&
    (n.sentHead === undefined || validText(n.sentHead, 80)) &&
    (n.sentAnchor === undefined || validText(n.sentAnchor, 80))
  );
};

const isFile = (value: unknown): value is ReviewNotesFile => {
  const f = value as Partial<ReviewNotesFile> | null;
  return (
    typeof f === 'object' &&
    f !== null &&
    f.v === REVIEW_NOTES_VERSION &&
    typeof f.notes === 'object' &&
    f.notes !== null &&
    Object.values(f.notes as Record<string, unknown>).every(
      (notes) => Array.isArray(notes) && notes.length <= REVIEW_NOTES_MAX && notes.every(isNote),
    )
  );
};

const copy = (note: ReviewNote): ReviewNote => ({ ...note });
const noteId = (): string => randomBytes(12).toString('hex');

/** A persistent per-project/task note collection. */
export class ReviewNotes {
  private data: ReviewNotesFile = { v: REVIEW_NOTES_VERSION, notes: {} };
  private loaded = false;
  private loadError: ReviewNotesError | undefined;

  constructor(
    private readonly file: string,
    private readonly o: { now?: () => Date; newId?: () => string; log?: (line: string) => void } = {},
  ) {}

  list(project: string, task: string): ReviewNote[] {
    return this.load().notes[keyOf(project, task)]?.map(copy) ?? [];
  }

  add(project: string, task: string, input: ReviewNoteInput, by: string, diffIdentity: string): ReviewNote {
    const body = bodyOf(input.body);
    checkInput(input);
    if (!validText(by, 256) || !validText(diffIdentity, 80)) throw new ReviewNotesError('review_note_invalid');
    const doc = this.load();
    const key = keyOf(project, task);
    const old = doc.notes[key] ?? [];
    if (old.length >= REVIEW_NOTES_MAX) throw new ReviewNotesError('review_note_limit');
    const note: ReviewNote = {
      id: this.o.newId?.() ?? noteId(),
      file: input.file,
      side: input.side,
      ...(input.startLine !== undefined && { startLine: input.startLine }),
      line: input.line,
      body,
      createdAt: (this.o.now?.() ?? new Date()).toISOString(),
      diffIdentity,
      by,
    };
    this.save({ ...doc.notes, [key]: [...old, note] });
    return copy(note);
  }

  edit(project: string, task: string, id: string, body: string, diffIdentity: string): ReviewNote {
    const nextBody = bodyOf(body);
    if (!validText(id, 80) || !validText(diffIdentity, 80)) throw new ReviewNotesError('review_note_invalid');
    const doc = this.load();
    const key = keyOf(project, task);
    const old = doc.notes[key] ?? [];
    const index = old.findIndex((note) => note.id === id);
    if (index < 0) throw new ReviewNotesError('review_note_missing');
    const prior = old[index];
    const { sentAt: _sentAt, sentHead: _head, sentAnchor: _anchor, ...withoutSent } = prior;
    const note: ReviewNote = {
      ...withoutSent,
      body: nextBody,
      diffIdentity,
      updatedAt: (this.o.now?.() ?? new Date()).toISOString(),
    };
    const notes = [...old];
    notes[index] = note;
    this.save({ ...doc.notes, [key]: notes });
    return copy(note);
  }

  delete(project: string, task: string, id: string): void {
    if (!validText(id, 80)) throw new ReviewNotesError('review_note_invalid');
    const doc = this.load();
    const key = keyOf(project, task);
    const old = doc.notes[key] ?? [];
    if (!old.some((note) => note.id === id)) throw new ReviewNotesError('review_note_missing');
    const notes = old.filter((note) => note.id !== id);
    const next = { ...doc.notes };
    if (notes.length) next[key] = notes;
    else delete next[key];
    this.save(next);
  }

  /** Step ④ marks delivered notes; keeping it here lets edit reliably clear `sentAt`. A note
   *  edited while the send was on its way stays unsent: its new words were not delivered. */
  markSent(
    project: string,
    task: string,
    sent: readonly Pick<ReviewNote, 'id' | 'body' | 'updatedAt'>[],
    /** P4: the worktree's commit at the send and each note's anchor hash (for `fixed`). */
    at2: { sentHead?: string; anchors?: ReadonlyMap<string, string> } = {},
  ): void {
    const wanted = new Map(sent.map((note) => [note.id, note]));
    if (!wanted.size) return;
    const doc = this.load();
    const key = keyOf(project, task);
    const old = doc.notes[key] ?? [];
    const at = (this.o.now?.() ?? new Date()).toISOString();
    const delivered = (note: ReviewNote) => {
      const was = wanted.get(note.id);
      return !!was && !note.sentAt && was.body === note.body && was.updatedAt === note.updatedAt;
    };
    const sentFields = (note: ReviewNote) => {
      const anchor = at2.anchors?.get(note.id);
      return { sentAt: at, ...(at2.sentHead && { sentHead: at2.sentHead }), ...(anchor && { sentAnchor: anchor }) };
    };
    this.save({ ...doc.notes, [key]: old.map((note) => (delivered(note) ? { ...note, ...sentFields(note) } : note)) });
  }

  /** Worktree removal discards its now-unreachable review anchors. */
  remove(project: string, task: string): void {
    const doc = this.load();
    const key = keyOf(project, task);
    if (!(key in doc.notes)) return;
    const next = { ...doc.notes };
    delete next[key];
    this.save(next);
  }

  /** Read the file again at the next use (after projectData changed it). */
  reload(): void {
    this.loaded = false;
    this.loadError = undefined;
    this.data = { v: REVIEW_NOTES_VERSION, notes: {} };
  }

  private load(): ReviewNotesFile {
    if (this.loadError) throw this.loadError;
    if (this.loaded) return this.data;
    this.loaded = true;
    try {
      const raw = readJson(this.file);
      if (raw === null) return this.data;
      if (!isFile(raw)) throw new Error('invalid review notes shape');
      this.data = raw;
      return this.data;
    } catch (err) {
      this.loadError = new ReviewNotesError('review_notes_unreadable');
      this.o.log?.(`review notes unreadable: ${String(err)}`);
      throw this.loadError;
    }
  }

  private save(notes: Record<string, ReviewNote[]>): void {
    const next: ReviewNotesFile = { v: REVIEW_NOTES_VERSION, notes };
    try {
      writeJsonAtomic(this.file, next);
      this.data = next;
    } catch (err) {
      this.o.log?.(`review notes not written: ${String(err)}`);
      throw new ReviewNotesError('review_notes_unreadable');
    }
  }
}

function checkInput(input: ReviewNoteInput): void {
  if (
    !validText(input.file, REVIEW_NOTE_FILE_MAX) ||
    input.side !== 'new' ||
    !validLine(input.line) ||
    (input.line === 0 && input.startLine !== undefined) ||
    (input.startLine !== undefined && (!validLine(input.startLine) || input.startLine === 0 || input.startLine > input.line))
  )
    throw new ReviewNotesError('review_note_invalid');
}

function bodyOf(value: string): string {
  const body = maskText(cleanText(value));
  if (!validText(body.trim(), REVIEW_NOTE_BODY_MAX)) throw new ReviewNotesError('review_note_invalid');
  return body;
}

/** What step ④ needs from the office: the messenger queue, the Task board and the rooms. */
export interface ReviewSendDeps {
  /** The office's Messenger.send (the boss's queue: waits for idle, holds on a question). */
  send(req: { to: string; text: string; ifIdle: false; from: string | null; source: string }): Promise<
    { ok: true; delivered: string } | ({ ok: false; error: string } & Coded)
  >;
  /** Engine agents that can receive a message now. */
  names(): string[];
  /** The name an assignment answers to now. */
  nameOf(assignmentId: string): string | undefined;
  /** The Lead a Worker reports to (its project's orchestrator). */
  leadOf(name: string): string | undefined;
  task(id: string): { status: string; assignee?: { assignmentId: string; name: string } } | undefined;
  /** A user report on the Task (TaskStore.update). */
  setStatus(id: string, status: 'doing', by: string): void;
  /** One room line for the Lead (groupMessages.system): never typed into a session. */
  leadLine(lead: string, task: string, text: string): void;
}

export interface ReviewSendInput {
  project: string;
  /** The worktree's task name (its folder). */
  worktree: string;
  taskId?: string;
  assignmentId?: string;
  notes: readonly ReviewNote[];
  /** The client's `gui:<device>`: the queue shows it as the boss's message. */
  source: string;
  /** P4 add_review_note: the Lead who wrote them (the message is from it; never sent to it). */
  lead?: string;
}

export type ReviewSendOutcome =
  /** `sent`: the notes the message carried (the only ones to mark sent). */
  | { ok: true; to: string; delivered: string; moved: boolean; sent: ReviewNote[] }
  | ({ ok: false; error: string } & Coded);

/**
 * Step ④: the unsent notes as one message to the agent that made the change (the worktree's
 * assignee, else the Task's, else the project Lead), through the existing messenger queue; the
 * Task then goes review → doing and the Lead's rooms get one line. Marking the notes sent is the
 * caller's (only after this says ok).
 */
export async function sendReview(deps: ReviewSendDeps, input: ReviewSendInput): Promise<ReviewSendOutcome> {
  const notes = input.notes.filter((note) => !note.sentAt);
  if (!notes.length) return { ok: false, ...refused('review_nothing_to_send') };
  const label = input.taskId ?? input.worktree;
  const header = input.lead
    ? koText('review_lead_header', { lead: input.lead, task: label, worktree: input.worktree })
    : koText('review_send_header', { task: label, worktree: input.worktree, count: notes.length });
  const out = await deliverToWorker(deps, input, `${header}\n\n${formatDiffComments(notes)}`, (to) =>
    input.lead
      ? koText('sys_review_lead', { lead: input.lead, worker: to, task: label })
      : koText('sys_review', { worker: to, count: notes.length, task: label }),
  );
  return out.ok ? { ...out, sent: notes } : out;
}

/**
 * One message to the agent that made worktree `input.worktree`'s change (its assignee, else its
 * Task's, else the project Lead; never the Lead that wrote it), through the messenger queue; a Task
 * in review goes back to doing and the Lead's rooms get `line(to)`. Shared by review notes and the
 * P4 conflict handoff.
 */
export async function deliverToWorker(
  deps: ReviewSendDeps,
  input: Pick<ReviewSendInput, 'project' | 'worktree' | 'taskId' | 'assignmentId' | 'source' | 'lead'>,
  text: string,
  line: (to: string) => string,
  /** The Task statuses that go back to doing. */
  reopen: readonly string[] = ['review'],
): Promise<{ ok: true; to: string; delivered: string; moved: boolean } | ({ ok: false; error: string } & Coded)> {
  const task = input.taskId ? deps.task(input.taskId) : undefined;
  const live = new Set(deps.names());
  const worker = [
    input.assignmentId && deps.nameOf(input.assignmentId),
    task?.assignee && (deps.nameOf(task.assignee.assignmentId) ?? task.assignee.name),
  ].find((name): name is string => !!name && live.has(name) && name !== input.lead);
  const lead = (worker && deps.leadOf(worker)) || input.lead || input.project;
  const to = worker ?? (live.has(lead) && lead !== input.lead ? lead : undefined);
  if (!to) return { ok: false, ...refused('review_no_target') };
  const sent = await deps.send({ to, text, ifIdle: false, from: input.lead ?? null, source: input.source });
  if (!sent.ok) return { ok: false, error: sent.error, ...(sent.errorCode && { errorCode: sent.errorCode }), ...(sent.errorParams && { errorParams: sent.errorParams }) };
  const moved = !!input.taskId && !!task && reopen.includes(task.status);
  if (moved) deps.setStatus(input.taskId!, 'doing', input.source);
  if (to !== lead && live.has(lead)) deps.leadLine(lead, input.taskId ?? input.worktree, line(to));
  return { ok: true, to, delivered: sent.delivered, moved };
}
