/**
 * RENEW-STUCK: agty renew, from the request to the new conversation, resumed after a daemon
 * restart (renewals/<name>.json). Extracted from engine.ts (E6).
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../core/src/agent-tycoon/serverText.js';
import type { BrainRef } from '../../../../core/src/agent-tycoon/spec/trace.js';
import { turnEnded } from '../providers/claudeProvider.js';
import { fail, type Outcome } from './engineAction.js';
import { configDir, shortStamp } from './events.js';
import { type HandoffFormat, handoffFormat } from './handoff.js';
import { type LeadTerm, leadTermOf } from './leadSwap.js';
import { writeAtomic } from './messenger.js';
import type { ProjectRecord } from './registry.js';
import type { Live } from './sessionMatch.js';

/** RENEW-STUCK, K1 (BRN §3.2 B3): an accepted renewal, on disk until it is over, so a daemon
 *  restart resumes it. `phase`: `waiting` for the turn (and the Lead's background sub-agents) to
 *  end, `queued` once the handoff is in the inbox (a resume does not write it twice), `starting`
 *  once the old session is stopped (a resume never starts a second new conversation: the
 *  registry's session id tells whether the start got through), `done` once it did. A record a
 *  start failed is kept (`failed`): the next start is a new conversation (B4). One without `v`
 *  (before K1) is read too: its `message` is the first message already, `queued` its phase. */
export interface RenewRecord {
  v?: 1;
  name: string;
  /** v1: the handoff as the agent wrote it; before: the whole first message. */
  message: string;
  source: string;
  requestedAt: number;
  queued?: boolean;
  phase?: RenewPhase;
  /** The handoff file the agent named. */
  file?: string | null;
  oldSessionId?: string | null;
  newSessionId?: string | null;
  /** The HEAD and branch the work basis was built on (BRN §4.6 `base.head`). */
  base?: { head: string | null; branch: string | null };
  /** The old conversation's transcript (the renew history's hop). */
  transcript?: string | null;
  format?: HandoffFormat;
  refs?: BrainRef[];
  failed?: { code: string; error: string; at: number };
  /** When the old session was gone (the history's `endedAt`: before the new one's first record). */
  stoppedAt?: number;
}
export type RenewPhase = 'waiting' | 'queued' | 'starting' | 'done';
const phaseOf = (r: RenewRecord): RenewPhase => r.phase ?? (r.queued ? 'queued' : 'waiting');

const renewDir = (home: string): string => path.join(configDir(home), 'renewals');
const renewFile = (home: string, name: string): string =>
  path.join(renewDir(home), `${encodeURIComponent(name)}.json`);

/** K1 (B3): one renew that started a new conversation: the old one's transcript up to `bytes`. */
export interface RenewTerm {
  name: string;
  /** A Lead's renew: its project (the Lead chain goes on before this conversation). */
  projectId?: string;
  sessionId: string;
  /** The new conversation's session id. */
  next: string;
  transcript: string;
  bytes: number;
  endedAt: number;
}
export const renewHistoryPath = (home: string): string => path.join(configDir(home), 'renew-history.json');
export const RENEW_HISTORY_VERSION = 1;
/** Kept terms (oldest go first). */
const RENEW_HISTORY_MAX = 500;

const validTerm = (t: unknown): t is RenewTerm => {
  const o = t as Partial<RenewTerm> | null;
  return (
    !!o &&
    typeof o.name === 'string' &&
    typeof o.sessionId === 'string' &&
    typeof o.next === 'string' &&
    typeof o.transcript === 'string' &&
    Number.isInteger(o.bytes) &&
    Number.isInteger(o.endedAt)
  );
};

/** Every recorded renew, oldest first (an unreadable file reads as none). */
export function readRenewHistory(home: string): RenewTerm[] {
  try {
    const j = JSON.parse(fs.readFileSync(renewHistoryPath(home), 'utf-8')) as { v?: unknown; terms?: unknown };
    return j.v === RENEW_HISTORY_VERSION && Array.isArray(j.terms) ? j.terms.filter(validTerm) : [];
  } catch {
    return [];
  }
}

/**
 * The conversation `file` (first record at `start`) continues from, by the recorded history: a
 * Lead swap's term (leadSwap.leadTermOf) or a renew's, whichever ended last by `start`. A Lead
 * that renewed is still its project's Lead in the conversations before. Null: no record names
 * one (the caller's folder guess decides).
 */
export function historyHop(
  file: string,
  start: number,
  lead: LeadTerm[],
  renew: RenewTerm[],
  projectOf: (sessionId: string) => string | null,
): { file: string; end: number } | null {
  const sid = path.basename(file, '.jsonl');
  const viaRenew = (id: string) =>
    renew.find((t) => (t.sessionId === id || t.next === id) && t.projectId)?.projectId ?? null;
  const l = leadTermOf(lead, file, start, (id) => projectOf(id) ?? viaRenew(id));
  const r =
    renew
      .filter((t) => t.next === sid && t.sessionId !== sid && t.endedAt <= start)
      .sort((a, b) => b.endedAt - a.endedAt)[0] ?? null;
  const t = l && (!r || l.endedAt >= r.endedAt) ? l : r;
  return t ? { file: t.transcript, end: t.bytes } : null;
}

export interface RenewalsDeps {
  home: string;
  /** The engine's timing object (read at each call, so a test's override is seen). */
  timing: { renewWaitMs: number; renewPollMs: number };
  /** The Engine's own action set (shared, never copied). */
  running: Set<string>;
  disposed: () => boolean;
  broken: () => string | null;
  find: (name: string) => ProjectRecord | undefined;
  /** Re-read the Engine's live sessions (its `live` field). */
  rereadLive: () => void;
  holder: (p: ProjectRecord) => Live | null;
  refresh: () => void;
  sleep: (ms: number) => Promise<void>;
  /** RENAME: a rename of `name` is pending (a renew and a rename are exclusive). */
  renaming?: (name: string) => boolean;
  enqueue: (fn: () => Promise<Outcome>) => Promise<Outcome>;
  stopSession: (h: Live) => Promise<Outcome>;
  startProject: (p: ProjectRecord, source: string, newConversation: boolean) => Promise<Outcome>;
  log: (line: string) => void;
  event?: (type: string, source: string, fields: Record<string, unknown>) => void;
  writeInbox?: (name: string, text: string) => boolean | undefined;
  /** K1 (B2): a v1 handoff's first message (safety lines, handoff, work basis), with what it was
   *  built on; `h`: the old session while it is still live. Never rejects. */
  compose: (p: ProjectRecord, r: RenewRecord, h: Live | null) => Promise<{
    text: string;
    base: { head: string | null; branch: string | null };
    refs: BrainRef[];
    transcript: string | null;
  }>;
  /** K1 (G6): the background sub-agents `name`'s session still runs; null: not known yet (the
   *  renew waits). Unset: none. */
  subagents?: (name: string) => number | null;
}

export class Renewals {
  /** Projects in a renew, from the caller's turn end until the new conversation. */
  private readonly renewals = new Set<string>();
  /** TOKEN-GUARD (S-02): pending renewals a person stopped: they end without a new conversation. */
  private readonly renewCancel = new Set<string>();

  constructor(private readonly deps: RenewalsDeps) {}

  /** A renewal of `name` is pending. */
  has(name: string): boolean {
    return this.renewals.has(name);
  }

  /** The pending names, in insertion order (the refresh signature). */
  names(): string[] {
    return [...this.renewals];
  }

  /** A person stopped `name`: its pending renewal ends without a new conversation. */
  cancel(name: string): void {
    this.renewCancel.add(name);
  }

  /** K1 (B4): `name`'s last renew could not start its new conversation: its next start is a new
   *  one (the handoff waits in its inbox), and nothing starts it by itself. Read from disk, so a
   *  rename (projectData moves the record) and a restart see it too. */
  failedStart(name: string): boolean {
    if (this.renewals.has(name)) return false;
    const r = this.read(renewFile(this.deps.home, name));
    return !!r && 'failed' in r && !!r.failed;
  }

  /** K1 (B4): every failed renew's name and the conversation it left (not one pending now). */
  failedList(): Array<{ name: string; oldSessionId: string | null }> {
    let files: string[];
    try {
      files = fs.readdirSync(renewDir(this.deps.home)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files.flatMap((f) => {
      const r = this.read(path.join(renewDir(this.deps.home), f));
      return r && !('error' in r) && r.failed && !this.renewals.has(r.name)
        ? [{ name: r.name, oldSessionId: r.oldSessionId ?? null }]
        : [];
    });
  }

  /** K1 (B4): the new conversation a failed renew left to the next start is up: the record goes,
   *  the history gets the term. */
  recovered(p: ProjectRecord, sessionId: string | null): void {
    const file = renewFile(this.deps.home, p.name);
    const r = this.read(file);
    if (!r || 'error' in r || !r.failed) return;
    this.addTerm(r, sessionId, p.role ? undefined : p.projectId);
    this.remove(file, p.name);
    this.deps.log(`renew "${p.name}": its new conversation started on the next start (${sessionId?.slice(0, 8) ?? '-'})`);
  }

  request(
    name: string,
    message: string,
    source: string,
    file: string | null = null,
  ): { ok: true } | { ok: false; code: string; error: string } {
    const p = this.deps.find(name);
    if (!p) return { ok: false, code: 'unknown_project', error: koText('project_unknown', { name }) };
    if (this.deps.broken())
      return {
        ok: false,
        code: 'daemon_error',
        error: koText('registry_unreadable'),
      };
    if (this.renewals.has(name))
      return {
        ok: false,
        code: 'renew_pending',
        error: koText('renew_pending', { name }),
      };
    if (this.deps.running.has(name))
      return { ok: false, code: 'busy', error: koText('project_busy_quoted', { name }) };
    if (this.deps.renaming?.(name))
      return { ok: false, code: 'rename_pending', error: koText('rename_pending', { name }) };
    // A failed one's record is replaced (its handoff stays in the inbox, before this one).
    const r: RenewRecord = {
      v: 1,
      name,
      message,
      source,
      requestedAt: Date.now(),
      phase: 'waiting',
      file,
      oldSessionId: p.sessionId ?? null,
      format: handoffFormat(message),
    };
    this.saveRenewal(r);
    this.launchRenewal(p, r);
    this.deps.refresh(); // the office row's `renewing`
    return { ok: true };
  }

  private launchRenewal(p: ProjectRecord, r: RenewRecord): void {
    this.renewals.add(p.name);
    void this.renewRun(p, r).finally(() => {
      this.renewals.delete(p.name);
      this.renewCancel.delete(p.name); // a run that threw must not cancel the next renewal
    });
  }

  /** Write a pending renewal's record; a failed write leaves it in memory only (logged). */
  private saveRenewal(r: RenewRecord): void {
    try {
      writeAtomic(renewFile(this.deps.home, r.name), JSON.stringify(r));
    } catch (err) {
      this.deps.log(`renew "${r.name}": not saved, a restart would lose it (${String(err)})`);
    }
  }

  private read(file: string): RenewRecord | { error: string } | null {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
    try {
      const r = JSON.parse(raw) as RenewRecord;
      if (typeof r.name !== 'string' || typeof r.message !== 'string') throw new Error('bad record');
      return r;
    } catch (err) {
      return { error: String(err) };
    }
  }

  private remove(file: string, name: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      this.deps.log(`renew "${name}": ${file}: ${String(err)}`);
    }
  }

  /** B3: the old conversation's term for the chat's scroll-back (once per old → new pair). */
  private addTerm(r: RenewRecord, next: string | null, projectId?: string): void {
    const sid = r.oldSessionId;
    if (!sid || !next || sid === next || !r.transcript) return;
    try {
      const terms = readRenewHistory(this.deps.home);
      if (terms.some((t) => t.sessionId === sid && t.next === next)) return;
      let bytes = 0;
      try {
        bytes = fs.statSync(r.transcript).size;
      } catch {
        /* no transcript */
      }
      const term: RenewTerm = {
        name: r.name,
        ...(projectId && { projectId }),
        sessionId: sid,
        next,
        transcript: r.transcript,
        bytes,
        endedAt: r.stoppedAt ?? Date.now(),
      };
      writeAtomic(
        renewHistoryPath(this.deps.home),
        JSON.stringify({ v: RENEW_HISTORY_VERSION, terms: [...terms, term].slice(-RENEW_HISTORY_MAX) }),
      );
    } catch (err) {
      this.deps.log(`renew "${r.name}": history not written (${String(err)})`);
    }
  }

  /** start(): every renewal a stopped daemon left pending goes on where it was; one whose new
   *  conversation was already starting is never started twice (B3). */
  resume(): void {
    let files: string[];
    try {
      files = fs.readdirSync(renewDir(this.deps.home)).filter((f) => f.endsWith('.json'));
    } catch {
      return; // none
    }
    for (const f of files) {
      const file = path.join(renewDir(this.deps.home), f);
      const r = this.read(file);
      if (!r) continue;
      if ('error' in r) {
        this.deps.log(`${file}: unreadable, not resumed (${r.error})`);
        continue;
      }
      if (r.failed) continue; // B4: the next start (a person's) takes it up
      const p = this.deps.find(r.name);
      if (!p) {
        this.deps.log(`${file}: no project "${r.name}", not resumed (its handoff stays in the file)`);
        continue;
      }
      const phase = phaseOf(r);
      if (phase === 'starting' || phase === 'done') {
        const now = p.sessionId ?? null;
        if (phase === 'done' || (now && now !== (r.oldSessionId ?? null))) {
          this.deps.log(`renew "${r.name}": its new conversation had started before the restart`);
          this.end(p, r, true, r.newSessionId ?? now);
        } else {
          this.deps.log(`renew "${r.name}": the restart came while its new conversation was starting`);
          this.end(p, r, false, null, 'start_failed', '새 대화를 띄우는 중에 데몬이 다시 떴어요');
        }
        continue;
      }
      this.deps.log(`renew "${r.name}": resumed after a restart (asked ${shortStamp(r.requestedAt)})`);
      this.launchRenewal(p, r);
    }
  }

  /** Over. The record goes, except: a handoff that never reached the inbox is kept beside it
   *  (`.failed`), a failed start keeps it (B4: the next start is a new conversation). */
  private end(p: ProjectRecord, r: RenewRecord, ok: boolean, sessionId: string | null, code?: string, error?: string): void {
    const file = renewFile(this.deps.home, p.name);
    try {
      if (ok) {
        this.addTerm(r, sessionId, p.role ? undefined : p.projectId);
        fs.rmSync(file, { force: true });
      } else if (code === 'start_failed') {
        writeAtomic(file, JSON.stringify({ ...r, phase: 'starting', failed: { code, error: error ?? '', at: Date.now() } }));
        this.deps.log(`renew "${p.name}": its next start is a new conversation with the handoff`);
      } else if (phaseOf(r) !== 'waiting') fs.rmSync(file, { force: true });
      else {
        fs.renameSync(file, `${file}.failed`);
        this.deps.log(`renew "${p.name}": its handoff is kept in ${file}.failed`);
      }
    } catch (err) {
      this.deps.log(`renew "${p.name}": ${file}: ${String(err)}`);
    }
    this.renewals.delete(p.name);
    this.renewCancel.delete(p.name);
    this.deps.log(`renew "${p.name}": ${ok ? `ok ${sessionId?.slice(0, 8)}` : `failed (${error})`}`);
    this.deps.event?.('orch_renew', r.source, {
      name: p.name,
      old_session_id: r.v === 1 ? (r.oldSessionId ?? null) : (p.sessionId ?? null),
      session_id: sessionId,
      ok,
      ...(code && { code, error }),
      ...(r.format && { format: r.format }),
    });
    this.deps.refresh();
  }

  private async renewRun(p: ProjectRecord, first: RenewRecord): Promise<void> {
    let r: RenewRecord = first.v === 1 ? first : { ...first, oldSessionId: p.sessionId ?? null };
    const save = (next: RenewRecord) => {
      r = next;
      this.saveRenewal(next);
    };
    const finish = (ok: boolean, sessionId: string | null, code?: string, error?: string) =>
      this.end(p, r, ok, sessionId, code, error);
    // 1. The caller's turn ends (counted from the request, across a restart). `shell` is an
    // ended turn whose run_in_background shell lives on: stopping the session ends it anyway.
    // K1 (G6): a background sub-agent the Lead started would not: the renew waits for it too.
    const end = r.requestedAt + this.deps.timing.renewWaitMs;
    let h: Live | null;
    let subs: number | null = 0;
    const cancelled = 'cancelled';
    const why = '사용자가 멈춰 새 대화로 넘기지 않았어요';
    for (;;) {
      if (this.deps.disposed()) return;
      if (this.renewCancel.has(p.name)) return finish(false, null, cancelled, why);
      this.deps.rereadLive();
      h = this.deps.holder(p);
      if (h && h.kind !== 'background')
        return finish(false, null, 'terminal', '터미널에서 열린 대화는 여기서 넘길 수 없어요');
      if (!h || turnEnded(h.status)) {
        const n = h && this.deps.subagents ? this.deps.subagents(p.name) : 0;
        if (n === 0) {
          this.deps.log(`renew "${p.name}": turn over (${h ? `status ${h.status}` : 'no live session'})`);
          break;
        }
        if (n !== subs)
          this.deps.log(
            `renew "${p.name}": ${n === null ? 'waits until its background sub-agents are known' : `waits for ${n} background sub-agent(s)`}`,
          );
        subs = n;
      } else subs = 0;
      if (Date.now() >= end)
        return finish(
          false,
          null,
          'not_idle',
          subs !== 0 ? '서브에이전트가 끝나지 않아 새 대화로 넘기지 않았어요' : '턴이 끝나지 않아 새 대화로 넘기지 않았어요',
        );
      await this.deps.sleep(this.deps.timing.renewPollMs);
    }
    // 2. The handoff waits in the inbox for the new conversation (v1: under the safety lines,
    // above the work basis, built now that the turn is over).
    if (phaseOf(r) === 'waiting') {
      let text = r.message;
      let built: Partial<RenewRecord> = {};
      if (r.v === 1) {
        const c = await this.deps.compose(p, r, h);
        text = c.text;
        built = { base: c.base, refs: c.refs, transcript: c.transcript };
      }
      if (!(this.deps.writeInbox?.(p.name, text) ?? false))
        return finish(false, null, 'queue_failed', '인수인계를 inbox에 쓰지 못했어요');
      save({ ...r, ...built, queued: true, phase: 'queued' });
    }
    // 3, 4. Stop the old one until it is gone, then a new conversation (one action at a time).
    this.deps.running.add(p.name);
    let out: Outcome;
    try {
      out = await this.deps.enqueue(async (): Promise<Outcome> => {
        if (this.renewCancel.has(p.name)) return { ...fail(why), code: cancelled };
        this.deps.refresh();
        const live = this.deps.holder(p);
        if (live) {
          const stopped = await this.deps.stopSession(live);
          if (!stopped.ok) return { ...stopped, code: 'stop_failed' };
        }
        save({ ...r, phase: 'starting', stoppedAt: Date.now() });
        const started = await this.deps.startProject(this.deps.find(p.name) ?? p, r.source, true);
        return started.ok ? started : { ...started, code: 'start_failed' };
      });
    } catch (err) {
      out = { ...fail(err instanceof Error ? err.message : String(err)), code: 'start_failed' };
    } finally {
      this.deps.running.delete(p.name);
    }
    const now = this.deps.find(p.name)?.sessionId ?? null;
    if (out.ok) {
      save({ ...r, phase: 'done', newSessionId: now });
      finish(true, now);
    } else finish(false, null, out.code, out.error);
  }
}
