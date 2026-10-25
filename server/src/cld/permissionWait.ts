/**
 * PERM-PROMPT: an engine session held by a Claude Code permission dialog (asked even in bypass
 * mode, e.g. a background sub-agent's "Dangerous rm ..." check) reaches the owner.
 *
 * Detection costs nothing while nothing is suspicious: no timer runs unless an engine lead has a
 * tool call open (one timer per open call). A cheap trigger (a heuristic permission signal of the
 * lead or one of its sub-agents, a tool call open PERMISSION_WAIT_SUSPECT_MS, hooks mode too, or a
 * message the messenger holds for it) asks `claude agents --json` once, at most one run per
 * PERMISSION_WAIT_CHECK_MS. A row whose `waitingFor` names a permission prompt confirms a wait: one
 * notice per episode (`started`), re-checked at that pace only while a wait is confirmed, and
 * `cleared` once the row no longer says so. A later dialog is a new episode.
 *
 * What is asked: while someone views the conversation, the dialog itself, read once per wait off
 * the session's screen (office.ts, chat.ts readPermissionDialog). Else the transcripts
 * (openToolCall): the NEWEST open call of the asker (the lead, or the sub-agent the first trigger
 * named): its older calls may be done with their results not yet read (01:56, 10-25: the card named
 * a finished `python3` call while the dialog was about the sub-agent's next one). ponytail: with
 * several askers open at once the transcript card may still name the wrong call; the answer path
 * then finds a different dialog on screen, sends nothing and the card is read off the screen.
 */
import { PERMISSION_WAIT_CHECK_MS, PERMISSION_WAIT_SUSPECT_MS } from '../constants.js';
import { tail } from './engine/messenger.js';
import { SidecarFinder } from './workView.js';

/** The open tool call a wait is about: the lead's own (no parentToolId) or a sub-agent's. */
export interface WaitSubject {
  toolId: string;
  parentToolId?: string;
}

export interface PermissionWaitDeps {
  /** The character is an engine-run session (only those are checked). */
  isEngineLead(id: number): boolean;
  /** Tool names whose open call is no suspicion (spawns, questions). */
  exempt: ReadonlySet<string>;
  /** One `claude agents --json`: the engine characters a permission dialog holds now. */
  check(): Promise<Set<number>>;
  /** A wait began (one notice), or its subject changed (`again`). */
  started(id: number, subject: WaitSubject | null, again: boolean): void;
  cleared(id: number): void;
  suspectMs?: number;
  checkMs?: number;
  now?: () => number;
}

interface Open extends WaitSubject {
  id: number;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionWaits {
  private readonly open = new Map<string, Open>();
  /** Confirmed waits: lead id -> its subject. */
  private readonly waiting = new Map<number, WaitSubject | null>();
  /** Leads suspected since the last check, with the call that made it (if any). */
  private readonly suspected = new Map<number, string | null>();
  private readonly trigger = new Map<number, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private lastCheck = -Infinity;
  /** `claude agents --json` runs so far (tests: none while nothing is suspected). */
  checks = 0;

  constructor(private readonly d: PermissionWaitDeps) {}

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** The wait this lead is in now, or undefined. */
  subject(id: number): WaitSubject | null | undefined {
    return this.waiting.get(id);
  }

  /** One main-store broadcast. */
  observe(m: Record<string, unknown>): void {
    const id = m.id;
    if (typeof id !== 'number') return;
    const parent = typeof m.parentToolId === 'string' ? m.parentToolId : undefined;
    const toolId = typeof m.toolId === 'string' ? m.toolId : undefined;
    switch (m.type) {
      case 'agentToolStart':
        if (toolId && !this.d.exempt.has(String(m.toolName))) this.opened(id, toolId);
        return;
      case 'subagentToolStart':
        if (toolId && parent) this.opened(id, toolId, parent);
        return;
      case 'agentToolDone':
      case 'subagentToolDone':
        if (toolId) this.close(`${id}|${parent ?? ''}|${toolId}`);
        return;
      case 'subagentClear':
        for (const [k, o] of this.open) if (o.id === id && o.parentToolId === parent) this.close(k);
        return;
      case 'agentToolsClear':
        for (const [k, o] of this.open) if (o.id === id) this.close(k);
        return;
      case 'agentToolPermission':
        this.suspect(id);
        return;
      case 'subagentToolPermission': {
        const k = [...this.open.keys()].find((x) => x.startsWith(`${id}|${parent ?? ''}|`));
        this.suspect(id, k ?? null);
        return;
      }
      default:
        return;
    }
  }

  /** The character is gone: its calls and its wait with it (no notice). */
  forget(id: number): void {
    for (const [k, o] of this.open) if (o.id === id) this.close(k);
    this.waiting.delete(id);
    this.suspected.delete(id);
    this.trigger.delete(id);
  }

  /** A trigger fired for lead `id` (`key`: the open call that made it). */
  suspect(id: number, key: string | null = null): void {
    if (!this.d.isEngineLead(id)) return;
    if (!this.suspected.has(id) || key) this.suspected.set(id, key);
    this.schedule();
  }

  /** The owner answered its dialog from the messenger: that episode is over; look again soon, so a
   *  next dialog is a new notice. */
  answered(id: number): void {
    if (this.waiting.delete(id)) this.d.cleared(id);
    this.suspect(id);
  }

  dispose(): void {
    for (const k of [...this.open.keys()]) this.close(k);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private opened(id: number, toolId: string, parentToolId?: string): void {
    if (!this.d.isEngineLead(id)) return;
    const key = `${id}|${parentToolId ?? ''}|${toolId}`;
    if (this.open.has(key)) return;
    const timer = setTimeout(
      () => this.suspect(id, key),
      this.d.suspectMs ?? PERMISSION_WAIT_SUSPECT_MS,
    );
    timer.unref?.();
    this.open.set(key, { id, toolId, ...(parentToolId && { parentToolId }), at: this.now, timer });
    // A wait confirmed before its call was read (a held message found it first): the card gets it now.
    if (this.waiting.get(id) === null) {
      const subject = this.subjectOf(id);
      this.waiting.set(id, subject);
      this.d.started(id, subject, true);
    }
  }

  private close(key: string): void {
    const o = this.open.get(key);
    if (!o) return;
    clearTimeout(o.timer);
    this.open.delete(key);
  }

  private schedule(): void {
    if (this.timer || this.inFlight) return;
    if (!this.suspected.size && !this.waiting.size) return;
    const gap = this.d.checkMs ?? PERMISSION_WAIT_CHECK_MS;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.run();
      },
      Math.max(0, this.lastCheck + gap - this.now),
    );
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    this.lastCheck = this.now;
    this.checks++;
    // The first trigger names the asker while its call is open (a later long call is no better guess).
    for (const [id, key] of this.suspected)
      if (key && !this.open.has(this.trigger.get(id) ?? '')) this.trigger.set(id, key);
    this.suspected.clear();
    let found: Set<number> | null = null;
    try {
      found = await this.d.check();
    } catch {
      // Unreadable this time: the confirmed waits stand until a check says otherwise.
    }
    this.inFlight = false;
    if (found) {
      for (const id of found) {
        if (!this.d.isEngineLead(id)) continue;
        const subject = this.subjectOf(id);
        const had = this.waiting.has(id);
        const before = this.waiting.get(id);
        this.waiting.set(id, subject);
        if (!had) this.d.started(id, subject, false);
        else if (JSON.stringify(before) !== JSON.stringify(subject))
          this.d.started(id, subject, true);
      }
      for (const id of [...this.waiting.keys()])
        if (!found.has(id)) {
          this.waiting.delete(id);
          this.trigger.delete(id);
          this.d.cleared(id);
        }
    }
    this.schedule();
  }

  /** The newest open call of the asker the first trigger named (its sub-agent, or the lead itself),
   *  else the lead's newest open call. A sub-agent runs one call at a time: an older one still open
   *  here is done, its result not read yet; the dialog is about the newest. */
  private subjectOf(id: number): WaitSubject | null {
    const key = this.trigger.get(id);
    const asker = key === undefined ? undefined : key.split('|')[1];
    const mine = [...this.open.values()].filter((x) => x.id === id);
    const theirs = mine.filter((x) => (x.parentToolId ?? '') === asker);
    // Insertion order breaks a tie in `at`: the later call wins.
    const o = (theirs.length ? theirs : mine).reduce<Open | undefined>(
      (a, b) => (a && a.at > b.at ? a : b),
      undefined,
    );
    return o ? { toolId: o.toolId, ...(o.parentToolId && { parentToolId: o.parentToolId }) } : null;
  }
}

/** What the card shows of an open tool call, and the words its dialog must show to be answered. */
export interface OpenToolCall {
  tool: string;
  /** Its own description, else the first line of its command, else a path or URL. */
  detail?: string;
  /** Server-side only: every one of these must be inside the dialog on screen. */
  match: string[];
}

const DETAIL_MAX = 200;

/** A `tool_use` block with this id anywhere in a record (a sub-agent's inline progress record too). */
function findToolUse(
  v: unknown,
  id: string,
  depth = 0,
): { name?: unknown; input?: unknown } | null {
  if (!v || typeof v !== 'object' || depth > 8) return null;
  const o = v as Record<string, unknown>;
  if (o.type === 'tool_use' && o.id === id) return o;
  for (const x of Array.isArray(v) ? v : Object.values(o)) {
    const hit = findToolUse(x, id, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Tool call `toolId` in the end of transcript `file`, or null. */
export function openToolCall(file: string, toolId: string): OpenToolCall | null {
  const lines = tail(file).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(toolId)) continue;
    let use: { name?: unknown; input?: unknown } | null = null;
    try {
      use = findToolUse(JSON.parse(lines[i]), toolId);
    } catch {
      continue;
    }
    if (!use) continue;
    const input = (use.input && typeof use.input === 'object' ? use.input : {}) as Record<
      string,
      unknown
    >;
    const str = (k: string) => {
      const v = input[k];
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const description = str('description')?.split('\n')[0];
    // The whole command must be in the dialog (its first line alone would match another script).
    const command = str('command');
    const detail = description ?? command?.split('\n')[0].trim() ?? str('file_path') ?? str('url');
    return {
      tool: typeof use.name === 'string' ? use.name : '?',
      ...(detail && { detail: detail.slice(0, DETAIL_MAX) }),
      match: [description, command].filter((x): x is string => !!x),
    };
  }
  return null;
}

/** The subject's call, read from the lead's transcript or its sub-agent's own. */
export function subjectCall(leadTranscript: string, s: WaitSubject): OpenToolCall | null {
  const own = s.parentToolId ? new SidecarFinder(leadTranscript, s.parentToolId).find() : null;
  return (own ? openToolCall(own, s.toolId) : null) ?? openToolCall(leadTranscript, s.toolId);
}

/**
 * PERM-PROMPT: the card of a permission dialog read off the screen (chat.ts permissionDialog,
 * whole): its title line ("Bash command · from the general-purpose agent") as the tool, and its
 * other lines (description, command, the warning) as the detail, without rules, blank lines and
 * the question. Unmasked: the caller masks what leaves the daemon.
 */
export function dialogCard(dialog: string): { tool: string; detail?: string } {
  const lines = dialog
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[─╌┄━-]+$/.test(l) && !/^Do you want to /.test(l));
  // Whole (a whole dialog fits on one screen): 허용 approves all of it, so the card shows all of it.
  const detail = lines.slice(1).join('\n');
  return { tool: lines[0] ?? '?', ...(detail && { detail }) };
}

const ID_MAX = 200;

/** A well-formed permissionAnswer, or null. */
export function parsePermissionAnswer(
  msg: Record<string, unknown>,
): { requestId: string; agentId: number; toolId: string; allow: boolean } | null {
  const { requestId, agentId, toolId, allow } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > ID_MAX) return null;
  if (typeof toolId !== 'string' || toolId.length > ID_MAX) return null;
  if (!Number.isInteger(agentId) || typeof allow !== 'boolean') return null;
  return { requestId, agentId: agentId as number, toolId, allow };
}
