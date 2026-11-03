/**
 * RENEW-STUCK: cld-gui renew, from the request to the new conversation, resumed after a daemon
 * restart (renewals/<name>.json). Extracted from engine.ts (E6).
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../core/src/cld/serverText.js';
import { turnEnded } from '../providers/claudeProvider.js';
import { fail, type Outcome } from './engineAction.js';
import { configDir, shortStamp } from './events.js';
import { writeAtomic } from './messenger.js';
import type { ProjectRecord } from './registry.js';
import type { Live } from './sessionMatch.js';

/** RENEW-STUCK: an accepted renewal, on disk until it is over, so a daemon restart resumes it.
 *  `queued`: the handoff is already in the inbox (a resume does not write it twice). */
interface RenewRecord {
  name: string;
  message: string;
  source: string;
  requestedAt: number;
  queued?: boolean;
}
const renewDir = (home: string): string => path.join(configDir(home), 'renewals');
const renewFile = (home: string, name: string): string =>
  path.join(renewDir(home), `${encodeURIComponent(name)}.json`);

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

  request(
    name: string,
    message: string,
    source: string,
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
    const r: RenewRecord = { name, message, source, requestedAt: Date.now() };
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

  /** start(): every renewal a stopped daemon left pending goes on where it was. */
  resume(): void {
    let files: string[];
    try {
      files = fs.readdirSync(renewDir(this.deps.home)).filter((f) => f.endsWith('.json'));
    } catch {
      return; // none
    }
    for (const f of files) {
      const file = path.join(renewDir(this.deps.home), f);
      let r: RenewRecord;
      try {
        r = JSON.parse(fs.readFileSync(file, 'utf-8')) as RenewRecord;
        if (typeof r.name !== 'string' || typeof r.message !== 'string') throw new Error('bad record');
      } catch (err) {
        this.deps.log(`${file}: unreadable, not resumed (${String(err)})`);
        continue;
      }
      const p = this.deps.find(r.name);
      if (!p) {
        this.deps.log(`${file}: no project "${r.name}", not resumed (its handoff stays in the file)`);
        continue;
      }
      this.deps.log(`renew "${r.name}": resumed after a restart (asked ${shortStamp(r.requestedAt)})`);
      this.launchRenewal(p, r);
    }
  }

  private async renewRun(p: ProjectRecord, r: RenewRecord): Promise<void> {
    const { message, source } = r;
    const oldId = p.sessionId ?? null;
    const file = renewFile(this.deps.home, p.name);
    let queued = r.queued === true;
    const finish = (ok: boolean, sessionId: string | null, code?: string, error?: string) => {
      // Over: the record goes. A handoff that never reached the inbox is kept beside it.
      try {
        if (queued) fs.rmSync(file, { force: true });
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
      this.deps.event?.('orch_renew', source, {
        name: p.name,
        old_session_id: oldId,
        session_id: sessionId,
        ok,
        ...(code && { code, error }),
      });
      this.deps.refresh();
    };
    // 1. The caller's turn ends (counted from the request, across a restart). `shell` is an
    // ended turn whose run_in_background shell lives on: stopping the session ends it anyway.
    const end = r.requestedAt + this.deps.timing.renewWaitMs;
    let h: Live | null;
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
        this.deps.log(`renew "${p.name}": turn over (${h ? `status ${h.status}` : 'no live session'})`);
        break;
      }
      if (Date.now() >= end)
        return finish(false, null, 'not_idle', '턴이 끝나지 않아 새 대화로 넘기지 않았어요');
      await this.deps.sleep(this.deps.timing.renewPollMs);
    }
    // 2. The handoff waits in the inbox for the new conversation.
    if (!queued) {
      if (!(this.deps.writeInbox?.(p.name, message) ?? false))
        return finish(false, null, 'queue_failed', '인수인계를 inbox에 쓰지 못했어요');
      queued = true;
      this.saveRenewal({ ...r, queued });
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
          const r = await this.deps.stopSession(live);
          if (!r.ok) return { ...r, code: 'stop_failed' };
        }
        const r = await this.deps.startProject(this.deps.find(p.name) ?? p, source, true);
        return r.ok ? r : { ...r, code: 'start_failed' };
      });
    } catch (err) {
      out = { ...fail(err instanceof Error ? err.message : String(err)), code: 'start_failed' };
    } finally {
      this.deps.running.delete(p.name);
    }
    const now = this.deps.find(p.name)?.sessionId ?? null;
    if (out.ok) finish(true, now);
    else finish(false, null, out.code, out.error);
  }
}
