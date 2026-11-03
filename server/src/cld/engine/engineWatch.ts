/**
 * The engine's revive at daemon start, the watch (T-0091), idle retirement (TOKEN-GUARD S-04,
 * TERM-P1 idleStops) and the bounded re-look for a Claude daemon respawn (T-0126). Extracted
 * from engine.ts (E7).
 */
import * as fs from 'fs';

import { turnEnded } from '../providers/claudeProvider.js';
import type { AgentProvider } from './agents/types.js';
import type { Outcome } from './engineAction.js';
import type { ProjectRecord } from './registry.js';
import type { ReviveGuard } from './reviveGuard.js';
import type { Live } from './sessionMatch.js';

/** The identities Claude preserves when its daemon respawns a background worker. */
interface Adoption {
  sessionId?: string;
  backgroundId?: string;
}

export interface EngineWatchDeps {
  /** The engine's timing object (read at each call, so a test's override is seen). */
  timing: { reviveGapMs: number; reviveWindowMs: number; adoptMs: number; idleStopMs: number };
  /** The registry file (log lines). */
  file: string;
  /** The Engine's own sets (shared, never copied). */
  running: Set<string>;
  untrusted: Set<string>;
  guard: ReviveGuard;
  projects: () => ProjectRecord[];
  live: () => Live[];
  agents: () => Iterable<AgentProvider>;
  disposed: () => boolean;
  broken: () => string | null;
  readOnly: () => boolean;
  now: () => number;
  find: (name: string) => ProjectRecord | undefined;
  holder: (p: ProjectRecord) => Live | null;
  agentOf: (p: ProjectRecord) => AgentProvider | undefined;
  notReady: (p: ProjectRecord) => string | null;
  /** A renewal of `name` is pending (Renewals). */
  renewing: (name: string) => boolean;
  reviveBudget: (name: string, backoff?: boolean) => 'go' | 'wait' | 'stop';
  reviveOne: (p: ProjectRecord, cause: 'reboot' | 'restart' | 'died', firstPrompt?: boolean) => Promise<Outcome>;
  patch: (name: string, fields: Partial<ProjectRecord>) => void;
  enqueue: (fn: () => Promise<Outcome>) => Promise<Outcome>;
  stopSession: (h: Live, accepted?: () => void) => Promise<Outcome>;
  refresh: () => void;
  /** Forget `name` among the projects live at the last refresh (an adoption that ended in an exit). */
  dropLive: (name: string) => void;
  waitFor: <T>(fn: () => T | null, ms: number) => Promise<T | null>;
  sleep: (ms: number) => Promise<void>;
  changed: () => void;
  event: (type: string, source: string, fields: Record<string, unknown>) => void;
  log: (line: string) => void;
}

export class EngineWatch {
  /** TOKEN-GUARD (S-04): when each always-on project was last resumed after an idle retirement. */
  private readonly idleResumedAt = new Map<string, number>();
  /** T-0126: a vanished worker may be Claude's own daemon takeover, not a dead conversation. */
  private readonly pendingAdoptions = new Map<string, Adoption>();
  /** Why revive finds sessions off: the machine booted again, or only cld-gui did. */
  reviveCause: 'reboot' | 'restart' = 'reboot';
  /** revive() or a watch pass is running: the watch does not start another. */
  private watching = false;
  // ponytail: one flag for the one provider with a daemon (Claude); per provider when D5 adds another.
  daemonWasUp = false;
  /** D5 (6.3): agents revive and the watch skipped (no provider, or it is not ready), logged once. */
  private readonly skipLogged = new Set<string>();
  /** TERM-P1: since when each PTY-host agent has been idle with no viewer (idleStops). */
  private readonly idleSince = new Map<string, number>();

  constructor(private readonly deps: EngineWatchDeps) {}

  /** A re-look for `name`'s conversation is pending. */
  adopting(name: string): boolean {
    return this.pendingAdoptions.has(name);
  }

  /** The names with a pending re-look, in insertion order. */
  adoptionNames(): string[] {
    return [...this.pendingAdoptions.keys()];
  }

  /** Forget `name`'s pending re-look (its result is then ignored). */
  dropAdoption(name: string): void {
    this.pendingAdoptions.delete(name);
  }

  /**
   * At daemon start: every project with wantRunning that is not live, one at
   * a time, 2 s apart, one log line each (the engine's revive).
   */
  async revive(): Promise<void> {
    this.watching = true;
    try {
      const retired = this.idleLooks();
      for (const name of this.deps.projects().filter((p) => p.wantRunning).map((p) => p.name)) {
        const p = this.deps.find(name);
        if (this.deps.disposed()) return;
        // A pending renewal (resumed by start()) starts its own new conversation.
        if (!p?.wantRunning || this.deps.running.has(name) || this.deps.renewing(name)) continue;
        if (this.skipped(p)) continue;
        this.deps.refresh();
        if (this.deps.holder(p)) {
          this.deps.log(`revive "${name}": already live`);
          continue;
        }
        if (this.retiredForIdleness(p, retired)) {
          await this.idleRetired(p);
          continue;
        }
        // TOKEN-GUARD: a restart's revive counts too; one left down stays down.
        if (this.deps.reviveBudget(name, false) !== 'go') continue;
        const out = await this.deps.reviveOne(p, this.reviveCause);
        this.deps.guard.noteError(name, out.ok ? undefined : (out.error ?? ''));
        await this.deps.sleep(this.deps.timing.reviveGapMs);
      }
    } finally {
      this.watching = false;
    }
  }

  /** A persisted marker also survives a log rotation before the daemon restarts. */
  retiredForIdleness(p: ProjectRecord, retired = this.idleLooks()): boolean {
    return p.idleRetired || retired(p);
  }

  /** One look per provider at what its daemon retired for idleness (Claude's daemon log),
   *  shared by one revive or watch pass. */
  private idleLooks(): (p: ProjectRecord) => boolean {
    const looks = new Map<AgentProvider, (ids: Array<string | undefined>) => boolean>();
    return (p) => {
      const agent = this.deps.agentOf(p);
      if (!agent?.idleRetired) return false;
      let look = looks.get(agent);
      if (!look) looks.set(agent, (look = agent.idleRetired()));
      return look([p.backgroundId, p.sessionId]);
    };
  }

  /** Leave ordinary projects resting; always-on projects resume without a prompt or model turn. */
  private async idleRetired(p: ProjectRecord): Promise<void> {
    if (!p.idleRetired) {
      this.deps.patch(p.name, { idleRetired: true });
      this.deps.log(`watch "${p.name}": Claude retired its idle session; left resting`);
      this.deps.changed();
    }
    if (!p.alwaysOn || this.deps.guard.gaveUp(p.name) !== undefined) return;
    // TOKEN-GUARD (S-04): Claude retires a session after hours of idleness. A "retirement" within
    // minutes of our resume is an old daemon-log line over a crash: that goes through the budget.
    const now = this.deps.now();
    const last = this.idleResumedAt.get(p.name);
    if (last !== undefined && now - last < this.deps.timing.reviveWindowMs && this.deps.reviveBudget(p.name) !== 'go')
      return;
    this.idleResumedAt.set(p.name, now);
    const out = await this.deps.reviveOne(this.deps.find(p.name) ?? p, 'died', false);
    if (!out.ok) this.deps.guard.noteError(p.name, out.error ?? '');
  }

  /** Start one bounded re-look for the same conversation; it never runs Claude or writes a prompt. */
  lookForAdoption(p: ProjectRecord): void {
    if (this.pendingAdoptions.has(p.name)) return;
    const adoption: Adoption = {
      ...(p.sessionId && { sessionId: p.sessionId }),
      ...(p.backgroundId && { backgroundId: p.backgroundId }),
    };
    if (!adoption.sessionId && !adoption.backgroundId) return;
    this.pendingAdoptions.set(p.name, adoption);
    void this.deps.waitFor(() => this.adoptionHolder(adoption), this.deps.timing.adoptMs).then((session) => {
      if (this.deps.disposed() || this.pendingAdoptions.get(p.name) !== adoption) return;
      this.pendingAdoptions.delete(p.name);
      const current = this.deps.find(p.name);
      if (session && current?.wantRunning && !this.deps.running.has(p.name)) {
        try {
          this.deps.patch(p.name, {
            sessionId: session.sessionId,
            ...(session.id && { backgroundId: session.id }),
            idleRetired: false,
          });
        } catch (err) {
          this.deps.log(`could not save ${this.deps.file}: ${String(err)}`);
        }
        this.deps.log(`watch "${p.name}": adopted Claude daemon respawn pid=${session.pid}`);
        this.deps.event('orch_start', 'engine', {
          name: p.name,
          session_id: session.sessionId,
          resumed: true,
          remote_control: current.remoteControl === true,
        });
      } else {
        this.deps.dropLive(p.name);
        this.deps.event('orch_exit', 'engine', { name: p.name, code: null });
      }
      this.deps.refresh();
    });
  }

  /** A replacement must be a live background worker for the tracked conversation or job. */
  private adoptionHolder(adoption: Adoption): Live | null {
    return (
      this.deps.live().find(
        (s) =>
          s.kind === 'background' &&
          ((adoption.sessionId !== undefined && s.sessionId === adoption.sessionId) ||
            (adoption.backgroundId !== undefined && s.id === adoption.backgroundId)),
      ) ?? null
    );
  }

  /**
   * T-0091: every watchMs, a wantRunning project whose session died while the
   * daemon runs is revived. The look is the sessions directory refresh() reads
   * anyway (a live session file and its pid): nothing is spawned unless a
   * session is found dead, and startProject then re-reads before it acts. A
   * project the user turned off (no wantRunning), one with an action or renew
   * in flight, or one waiting on a trust answer is left alone. The Nth dead
   * check inside the window is not revived: the project stays down, marked
   * (state().downNote), with one log line and one notice event.
   */
  async watch(): Promise<void> {
    if (this.watching || this.deps.disposed() || this.deps.broken() || this.deps.readOnly()) return;
    this.watching = true;
    try {
      this.deps.refresh();
      for (const agent of this.deps.agents()) {
        if (!agent.daemonUp) continue;
        const daemon = agent.daemonUp();
        if (this.daemonWasUp && daemon === false)
          this.deps.log(`${agent.id} daemon is gone; its background sessions are revived below`);
        this.daemonWasUp = daemon === true;
      }
      await this.idleStops();
      const retired = this.idleLooks();
      for (const name of this.deps.projects().filter((p) => p.wantRunning).map((p) => p.name)) {
        const p = this.deps.find(name);
        if (this.deps.disposed()) return;
        if (!p?.wantRunning) continue;
        if (this.pendingAdoptions.has(name)) continue;
        if (this.deps.holder(p)) {
          // Live again (a person started it elsewhere): the mark goes.
          this.deps.guard.clearGaveUp(name);
          continue;
        }
        // D5 (F5): one left down while its CLI was missing comes back as revive would have.
        const waited = this.skipLogged.has(name);
        if (this.skipped(p)) continue;
        if (this.retiredForIdleness(p, retired)) {
          await this.idleRetired(p);
          continue;
        }
        if (
          this.deps.running.has(name) ||
          this.deps.renewing(name) ||
          this.deps.untrusted.has(name) ||
          this.deps.guard.gaveUp(name) !== undefined
        )
          continue;
        // A live file read mid-write or of a newer shape: this one may be alive. Next pass.
        if (this.deps.agentOf(p)?.liveUnsure()) continue;
        if (this.deps.reviveBudget(name) !== 'go') continue;
        const out = await this.deps.reviveOne(p, waited ? this.reviveCause : 'died');
        this.deps.guard.noteError(name, out.ok ? undefined : (out.error ?? ''));
        await this.deps.sleep(this.deps.timing.reviveGapMs);
      }
    } finally {
      this.watching = false;
    }
  }

  /**
   * TERM-P1: nobody retires an idle session in our PTY host but us. A session whose turn has been
   * over for idleStopMs (since the later of its first idle look and its transcript's last write),
   * with no one watching its terminal, is stopped and marked idleRetired: the wantRunning agent
   * then rests until a message wakes it (wake: `--resume`). An always-on agent is never stopped.
   */
  private async idleStops(): Promise<void> {
    for (const p of this.deps.projects()) {
      const h = this.deps.holder(p);
      const watched = !h?.agent.viewed || h.agent.viewed(h);
      if (!h || watched || !turnEnded(h.status) || p.alwaysOn || this.deps.running.has(p.name) || this.deps.renewing(p.name)) {
        this.idleSince.delete(p.name);
        continue;
      }
      let wrote = 0;
      try {
        wrote = fs.statSync(h.agent.transcript(h)).mtimeMs;
      } catch {
        /* no transcript yet */
      }
      const since = Math.max(this.idleSince.get(p.name) ?? this.deps.now(), wrote);
      this.idleSince.set(p.name, since);
      if (this.deps.now() - since < this.deps.timing.idleStopMs) continue;
      this.idleSince.delete(p.name);
      this.deps.running.add(p.name);
      try {
        const out = await this.deps.enqueue(() =>
          this.deps.stopSession(h, () => this.deps.patch(p.name, { idleRetired: true })),
        );
        this.deps.log(`watch "${p.name}": idle ${Math.round((this.deps.now() - since) / 60_000)} min, no viewer: ${out.ok ? 'stopped, resting' : `not stopped (${out.error})`}`);
        if (out.ok) this.deps.event('orch_idle_stop', 'engine', { name: p.name, session_id: h.sessionId });
      } finally {
        this.deps.running.delete(p.name);
      }
    }
  }

  /** revive and the watch leave an agent that cannot start alone: no inbox notice, no count. */
  private skipped(p: ProjectRecord): boolean {
    const why = this.deps.notReady(p);
    if (!why) {
      this.skipLogged.delete(p.name);
      return false;
    }
    if (!this.skipLogged.has(p.name)) {
      this.skipLogged.add(p.name);
      this.deps.log(`"${p.name}": ${why}; not revived`);
    }
    return true;
  }
}
