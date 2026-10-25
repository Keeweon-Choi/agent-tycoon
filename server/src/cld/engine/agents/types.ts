/**
 * The agent provider seam (ADR-0016 decision 1, D4): everything the engine
 * needs from one agent CLI. The engine's lifecycle (registry, revive and
 * watch, idle retirement and wake, renew, one action at a time, inbox,
 * events) stays in engine.ts and reaches an agent only through this. Each
 * agent is driven by the provider its assignment names (`provider` in
 * assignments.json, 'claude' when absent). Claude Code (agents/claude/) is
 * the first implementation; D5 adds Codex (agents/codex/, Workers only) and D7 ACP beside it.
 */
import type { ProjectRecord } from '../registry.js';

export type Protocol = 'claude' | 'codex' | 'acp' | 'pty';

/**
 * What the engine and the UI may offer for a provider. F-11: the approval
 * policy and the sandbox are two settings, never one "permission" knob, and
 * only what really applies to the provider is shown.
 */
export interface AgentCapabilities {
  /** The provider's own approval-policy values (Claude: `--permission-mode`). */
  approvalPolicy: readonly string[];
  /** The provider's sandbox values; null: it has none, so no sandbox setting is offered. */
  sandbox: readonly string[] | null;
  /** How a person joins a live session: a PTY program we start (attachArgv); null: there is
   *  no terminal to join (the chat button is not offered). */
  attach: 'pty' | null;
  /** A stopped conversation starts again under its id. */
  resume: boolean;
  /** A live session's name against the one it was started with: 'numbered' = Claude's
   *  `<name> (N)` when the name is taken (nameMatches); fixed at start (`-n`), a new
   *  title applies from the next conversation. */
  naming: 'numbered' | 'none';
  /** Where the 5-hour and 7-day usage comes from: the engine sessions' status line. */
  usage: 'statusLine' | null;
  /** 'session': a session the agent's own daemon holds is always there (Claude --bg).
   *  'run': one process per message and nothing in between (Codex exec, D5): an assignment
   *  that is on and has no run is a resting session the engine makes (holder()). With
   *  `naming: 'none'` sessions are found by assignment id, never by name. */
  lifetime: 'session' | 'run';
}

/** A live session as the engine sees it (Claude: ~/.claude/sessions/<pid>.json). */
export interface LiveSession {
  /** The id stop and attach take (Claude's short background id). */
  id?: string;
  pid: number;
  cwd: string;
  /** 'background': the agent's own daemon holds it; anything else is open in a person's terminal. */
  kind: string;
  startedAt?: number;
  /** The conversation's id (Claude's UUID). */
  sessionId: string;
  name?: string;
  /** busy | idle | waiting (Claude's session file). */
  status?: string;
  /** The provider knows this session's assignment (found by it, not by name or folder). */
  assignmentId?: string;
  /** The engine's resting session: an on assignment of a 'run' provider with no run now. */
  resting?: true;
}

export type StartResult =
  | {
      ok: true;
      /** The id the start printed, if any. */
      id: string | null;
      /** C7a: the role playbook the session got (`<role>-<hash>`), for the start event. */
      playbook?: string;
    }
  | { ok: false; error: string; /** The CLI's own words, for the client only. */ detail?: string; needsTrust?: true };

export type StopResult = { ok: true } | { ok: false; error: string; detail?: string };

export interface AgentProvider {
  /** The id an assignment's `provider` names. */
  readonly id: string;
  readonly protocol: Protocol;
  readonly capabilities: AgentCapabilities;
  /** Live sessions, from files: nothing is spawned. */
  live(): LiveSession[];
  /** A live process whose record cannot be read right now: an agent may look dead and not be. */
  liveUnsure(): boolean;
  /** `cb` when the live sessions may have changed; returns the unsubscribe. */
  onChange(cb: () => void): () => void;
  /** Live session name `name` belongs to a session started under `base`. */
  nameMatches(name: string | null | undefined, base: string): boolean;
  /** Start `p`'s session, resuming `resume`. `token()` issues the session's CLD_AGENT_TOKEN,
   *  called only when the start can carry one. `flags` (D3b's promote): always with `p`'s
   *  own flags, never a bare wake (Claude then continues the conversation in a copy). */
  start(
    p: ProjectRecord,
    o: { resume?: string; token: () => string | null; flags?: boolean },
  ): Promise<StartResult>;
  /** Ask the agent to stop live session `s` (the engine waits for it to leave). */
  stop(s: LiveSession): Promise<StopResult>;
  /** The PTY program that joins live session `id` (chat, the messenger's Typist). */
  attachArgv?(id: string): string[];
  /** Just before typing into `s`: it waits on something only its terminal can answer. */
  held(s: LiveSession): Promise<boolean>;
  /** The conversation's transcript file. */
  transcript(s: Pick<LiveSession, 'cwd' | 'sessionId'>): string;
  /** Compaction records in the transcript, and how full the context is (percent, null unknown). */
  compaction?: { mark: string; fillPct(transcript: string): number | null };
  /** One look at what the agent's daemon retired for idleness: is one of these ids among them? */
  idleRetired?(): (ids: Array<string | undefined>) => boolean;
  /** The agent's own daemon runs (true), is gone (false), or there is none to tell (null). */
  daemonUp?(): boolean | null;
  /** Something about the agent's daemon the user should know, or null. */
  warning?(): string | null;
  /** D5: why this provider cannot start anything here now (its CLI is not installed), or null. */
  ready?(): string | null;
  /** D5: a provider that takes a message itself (Codex: one run per message); the messenger
   *  calls this instead of its Typist. `text` is the message with its header line. */
  deliver?(
    p: ProjectRecord,
    text: string,
    o: { task?: string; group?: { id: string; messageId?: string }; messageId?: string },
  ): Promise<'typed' | 'notReady' | 'failed'>;
}
