import { createHash, randomBytes } from 'crypto';

import { refused } from '../../../../core/src/cld/serverText.js';
import type { PermissionAnswerResult, PermissionOption, PermissionWait } from '../../../../core/src/messages.js';
import type { AgentStateStore } from '../../agentStateStore.js';
import { PTY_PERMISSION_READY_MS, PTY_PERMISSION_READY_POLL_MS, PTY_PERMISSION_WAIT_MS } from '../../constants.js';
import { hookProviders } from '../../providers/index.js';
import type { Conversations } from '../conversations.js';
import type { Typist } from '../engine/messenger.js';
import type { SocketStepUp } from '../hooks.js';
import { ENV_DUMP_NOTE, maskText } from '../mask.js';
import {
  dialogCard,
  type OpenToolCall,
  parsePermissionAnswer,
  PermissionWaits,
  subjectCall,
  toolCall,
} from '../permissionWait.js';
import { ClaudeAgentsSource, waitsForPermission } from '../providers/claudeProvider.js';
import type { AgentEntry } from '../providers/types.js';
import type { RosterStore } from '../roster.js';
import { STEPUP_REQUIRED } from '../shell/gate.js';

/** PERM-PROMPT: a confirmed permission wait of an engine lead, as the office keeps it. */
interface PermissionEntry {
  /** Which wait (a new episode gets a new one): a screen read answers only its own. */
  wait: number;
  asker?: string;
  /** The card from the transcripts, and the words an answer must find in the dialog. */
  transcript: PermissionWait & { match: string[] };
  /** The screen read of this wait: under way, or done (`dialog` when it found the whole dialog). */
  screen?: 'reading' | 'done';
  dialog?: string;
  /** TERM-P3: a PTY agent's PermissionRequest hook waits on this card: 허용/거부 is its decision.
   *  ACP-1: an ACP agent's request: the option pressed (one of `options`). */
  hook?: (decision: { allow: boolean; optionId?: string } | null, replaced?: true) => void;
  /** ACP-1: what the ACP agent offers; an answer must name one of these. */
  options?: PermissionOption[];
  /** FIX-PERM-RESTART: a PTY terminal's own dialog, answered only there (syncPty keeps it). */
  terminal?: true;
}

/** What the permission cards need from the office: closures, so late-bound members and the replaced
 *  `world` are read at call time (and the engine is still reached as `office.engine`). */
export interface PermissionDeps {
  /** The engine's claude binary; null when the engine is off (no dialog watching). */
  claudePath: string | null;
  store: AgentStateStore;
  conversations: Pick<Conversations, 'republish' | 'viewing'>;
  typist: Typist | undefined;
  chat: boolean | undefined;
  entryOf(agentId: number): AgentEntry | null;
  agentIdOfName(name: string): number | null;
  agents(): AgentEntry[];
  idOf(key: string): number | null;
  employeeOf: RosterStore['employeeOf'];
  inPty(name: string): boolean | undefined;
  /** ACP-1: `name` is an ACP agent (it asks through session/request_permission). */
  acp?(name: string): boolean | undefined;
  /** FIX-PERM-RESTART: the PTY agent's terminal holds a permission dialog now (OSC 7501 blocked:kind=permission). */
  ptyAsks(id: number): boolean;
}

export class OfficePermissions {
  /** PERM-PROMPT: engine sessions held by a permission dialog, and what each card shows. */
  readonly waits: PermissionWaits | null;
  private readonly permissions = new Map<number, PermissionEntry>();
  private serial = 0;
  /** PTY agents whose hook got the owner's answer: their terminal's dialog is that one, going. */
  private readonly decided = new Set<number>();
  private readonly startedAt = Date.now();
  /** A hook card's id names this daemon's start too: an answer pressed for an older daemon's card
   *  (the serial starts again at every start) can never answer this one's. */
  private readonly boot = randomBytes(6).toString('hex');

  constructor(private readonly deps: PermissionDeps) {
    this.waits = deps.claudePath ? this.makeWaits(deps.claudePath) : null;
  }

  /** The card a contact carries, or undefined while nothing waits. */
  cardFor(agentId: number): PermissionWait | undefined {
    const p = this.permissions.get(agentId);
    return p && this.render(p);
  }

  dispose(): void {
    this.waits?.dispose();
  }

  /**
   * PERM-PROMPT (permissionWait.ts): an engine session held by a permission dialog notifies
   * through the existing path (the lead's permission bubble, its sub-agent's, the 🔐 notice and
   * Web Push naming the asking sub-agent) and its messenger card shows what is asked.
   */
  private makeWaits(claudePath: string): PermissionWaits {
    const agents = new ClaudeAgentsSource(claudePath);
    const engineEntry = (id: number) => {
      const e = this.deps.entryOf(id);
      return e?.key.startsWith('engine:') && e.bg?.id ? e : null;
    };
    const waits = new PermissionWaits({
      // TERM-P3: a PTY agent's prompts come from its PermissionRequest hook (askPermission).
      isEngineLead: (id) => {
        const e = engineEntry(id);
        return !!e && !this.deps.inPty(e.name) && !this.deps.acp?.(e.name);
      },
      exempt: new Set(hookProviders.flatMap((p) => [...p.permissionExemptTools])),
      check: async () => {
        const rows = (await agents.list()).filter(waitsForPermission);
        const ids = new Set<number>();
        for (const a of this.deps.agents()) {
          const id = a.key.startsWith('engine:') ? this.deps.idOf(a.key) : null;
          if (id !== null && rows.some((r) => r.id === a.bg?.id || r.sessionId === a.sessionId)) ids.add(id);
        }
        return ids;
      },
      started: (id, subject, again) => {
        const e = engineEntry(id);
        const call: OpenToolCall | null =
          subject && e?.transcript ? subjectCall(e.transcript, subject) : null;
        const asker = subject?.parentToolId
          ? this.deps.employeeOf(`claude:${subject.parentToolId}`)?.nameId
          : undefined;
        // The same wait keeps its screen read (once per wait) and, once read, its screen card.
        const before = again ? this.permissions.get(id) : undefined;
        this.permissions.set(id, {
          wait: before?.wait ?? ++this.serial,
          ...((asker ?? before?.asker) && { asker: asker ?? before?.asker }),
          transcript: {
            // Answerable only with words its dialog must show.
            toolId: call?.match.length ? subject!.toolId : '',
            ...(call && { tool: call.tool }),
            ...(call?.detail && { detail: maskText(call.detail) }),
            match: call?.match ?? [],
          },
          ...(before?.screen && { screen: before.screen }),
          ...(before?.dialog && { dialog: before.dialog }),
        });
        this.readScreen(id);
        if (!again) {
          console.log(`[agty engine] "${e?.name ?? id}" waits on a permission dialog`);
          this.deps.store.broadcast({ type: 'agentToolPermission', id, ...(asker && { asker }) });
          if (subject?.parentToolId)
            this.deps.store.broadcast({
              type: 'subagentToolPermission',
              id,
              parentToolId: subject.parentToolId,
            });
        }
        this.deps.conversations.republish();
      },
      cleared: (id) => {
        this.permissions.delete(id);
        this.deps.store.broadcast({ type: 'agentToolPermissionClear', id });
        this.deps.conversations.republish();
      },
    });
    this.deps.store.on('broadcast', (m) => waits.observe(m));
    this.deps.store.on('agentRemoved', (id) => {
      waits.forget(id);
      this.permissions.get(id)?.hook?.(null);
      this.permissions.delete(id);
      this.decided.delete(id);
    });
    return waits;
  }

  /**
   * TERM-P3 (ADR-0018): a PTY agent's PermissionRequest hook (control `permission-hook`, with the
   * asking session's own token). The same card, bubble, 🔐 notice and Web Push as a PERM-PROMPT
   * wait, made from the hook's tool and input (its description and whole command: 허용 approves
   * exactly that call); 허용/거부 is the hook's decision. No answer in PTY_PERMISSION_WAIT_MS, the
   * character gone, or no such PTY agent: no decision, and Claude shows its own dialog in the
   * agent's terminal (then the card says only the terminal answers it, syncPty). Nothing is read
   * off a screen. FIX-PERM-RESTART: a hook whose wait broke with our restart asks again with what
   * is left of its time (`waitMs`), maybe before the engine has found its registered PTY agent
   * live again (we wait for it the first PTY_PERMISSION_READY_MS of this daemon).
   */
  async ask(
    name: string,
    /** `gone`: the hook hung up (Claude ended it): its card goes, unanswered. */
    ask: { tool: string; input: Record<string, unknown>; waitMs?: number; gone?: AbortSignal },
  ): Promise<'allow' | 'deny' | null> {
    // The hook's time runs from its ask, our wait for the agent included.
    const until = Date.now() + Math.min(PTY_PERMISSION_WAIT_MS, Math.max(0, ask.waitMs ?? PTY_PERMISSION_WAIT_MS));
    const agent = () => {
      const id = this.deps.agentIdOfName(name);
      const e = id === null ? undefined : this.deps.entryOf(id);
      return id !== null && e?.key.startsWith('engine:') && e.bg?.id && this.deps.inPty(name) ? id : null;
    };
    while (agent() === null && this.deps.inPty(name) && Date.now() < Math.min(until, this.startedAt + PTY_PERMISSION_READY_MS))
      await new Promise((r) => setTimeout(r, PTY_PERMISSION_READY_POLL_MS));
    const id = agent();
    if (id === null || ask.gone?.aborted) return null;
    const d = await this.card(id, name, ask, 'hook', until, ask.gone);
    return d && d !== 'replaced' ? (d.allow ? 'allow' : 'deny') : null;
  }

  /**
   * ACP-1: an ACP agent's session/request_permission: the same card, bubble, 🔐 notice and Web Push,
   * with one button per option it offers; the option pressed is the answer. No timeout: the request
   * holds the agent's turn, so the card stays until the owner answers, the turn is stopped or the
   * pipe closes (`signal`). The character gone or no such agent: null (no decision). False: a newer
   * request of the same agent took this card's place (M2: answer this one `cancelled` now, so the
   * agent's turn goes on).
   */
  askAcp(
    name: string,
    ask: { tool: string; input: Record<string, unknown>; options: PermissionOption[] },
    signal: AbortSignal,
  ): Promise<string | false | null> {
    if (!this.deps.acp?.(name) || !ask.options.length) return Promise.resolve(null);
    const id = this.deps.agentIdOfName(name);
    const e = id === null ? undefined : this.deps.entryOf(id);
    if (id === null || !e?.key.startsWith('engine:') || !e.bg?.id || signal.aborted) return Promise.resolve(null);
    return this.card(id, name, ask, 'acp', null, signal).then((d) => (d === 'replaced' ? false : (d?.optionId ?? null)));
  }

  /** One card a hook or an ACP request waits on (until `until`, or no timeout when null); resolves
   *  with the owner's answer, 'replaced' (a newer ask took its place) or null. Its id names this
   *  daemon's start (`boot`). */
  private card(
    id: number,
    name: string,
    ask: { tool: string; input: Record<string, unknown>; options?: PermissionOption[] },
    via: 'hook' | 'acp',
    until: number | null,
    signal?: AbortSignal,
  ): Promise<{ allow: boolean; optionId?: string } | 'replaced' | null> {
    // ponytail: one card per agent; a second ask while one is up ends the first with no decision
    // (a hook's goes to its terminal, an ACP request is answered `cancelled`).
    this.permissions.get(id)?.hook?.(null, true);
    this.decided.delete(id);
    const shown = this.permissions.has(id); // the terminal's card (syncPty): the bubble is up
    const call = toolCall(ask.tool, ask.input);
    const detail = call.match.length ? call.match.join('\n') : call.detail;
    const wait = ++this.serial;
    return new Promise((resolve) => {
      let settled = false;
      const done = (decision: { allow: boolean; optionId?: string } | null, replaced?: true) => {
        if (settled) return; // the timer, a hang-up and an answer may all come
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const p = this.permissions.get(id);
        if (p?.wait === wait) {
          if (!decision && via === 'hook' && this.deps.ptyAsks(id)) {
            // Claude shows its own dialog now: the same card, answered only there.
            delete p.hook;
            p.terminal = true;
            p.transcript.toolId = '';
          } else {
            this.permissions.delete(id);
            if (decision) this.decided.add(id);
            this.deps.store.broadcast({ type: 'agentToolPermissionClear', id });
          }
          this.deps.conversations.republish();
        }
        resolve(replaced ? 'replaced' : decision);
      };
      const onAbort = () => done(null);
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = until === null ? null : setTimeout(() => done(null), Math.max(0, until - Date.now()));
      timer?.unref?.();
      this.permissions.set(id, {
        wait,
        transcript: { toolId: `${via}:${this.boot}:${wait}`, tool: call.tool, ...(detail && { detail: maskText(detail) }), match: [] },
        screen: 'done',
        hook: done,
        ...(ask.options && { options: ask.options.map((o) => ({ optionId: o.optionId, name: maskText(o.name), kind: o.kind })) }),
      });
      console.log(`[agty engine] "${name}" asks a permission (${call.tool}) through ${via === 'acp' ? 'ACP' : 'its hook'}`);
      if (!shown) this.deps.store.broadcast({ type: 'agentToolPermission', id });
      this.deps.conversations.republish();
    });
  }

  /**
   * FIX-PERM-RESTART: a PTY agent's terminal holds a permission dialog no hook stands for (the hook
   * gave up, or we restarted under it): its card says so (no 허용/거부, 터미널에서 보기), with the
   * bubble and the notice; it goes when the terminal's dialog does. A dialog the owner answered
   * from the card is closing: no terminal card for it.
   */
  syncPty(): void {
    let changed = false;
    for (const a of this.deps.agents()) {
      const id = a.key.startsWith('engine:') ? this.deps.idOf(a.key) : null;
      if (id === null) continue;
      const pty = !!this.deps.inPty(a.name);
      const asks = pty && this.deps.ptyAsks(id);
      if (!asks) this.decided.delete(id);
      const p = this.permissions.get(id);
      // The hook's card, or a PERM-PROMPT one (`claude --bg`): not this one's to keep.
      if (p && !p.terminal) continue;
      const want = asks && !this.decided.has(id);
      if (want && !p) {
        this.permissions.set(id, { wait: ++this.serial, transcript: { toolId: '', match: [] }, screen: 'done', terminal: true });
        console.log(`[agty engine] "${a.name}" waits on a permission dialog in its terminal`);
        this.deps.store.broadcast({ type: 'agentToolPermission', id });
        changed = true;
      } else if (!want && p) {
        this.permissions.delete(id);
        this.deps.store.broadcast({ type: 'agentToolPermissionClear', id });
        changed = true;
      }
    }
    if (changed) this.deps.conversations.republish();
  }

  /**
   * PERM-PROMPT: while a wait is confirmed and someone views its conversation, read the dialog off
   * the session's screen, once per wait (one attach, read, detach), and
   * make it the card: what the dialog itself says, and exactly what an answer must find on screen.
   * Unreadable (no attach, a dialog taller than the screen): the transcript card stays.
   */
  readScreen(id: number): void {
    const p = this.permissions.get(id);
    const bg = this.deps.entryOf(id)?.bg?.id;
    const read = this.deps.typist?.readPermissionDialog;
    if (!p || p.screen || !bg || !read || !this.deps.conversations.viewing(id)) return;
    p.screen = 'reading';
    const done = (dialog: string | null) => {
      const cur = this.permissions.get(id);
      if (cur?.wait !== p.wait) return; // that wait is over
      cur.screen = 'done';
      if (dialog === null) delete cur.dialog;
      else cur.dialog = dialog;
      this.deps.conversations.republish();
    };
    void read.call(this.deps.typist, bg).then(done, () => done(null));
  }

  /** PERM-PROMPT: the card a contact carries (never the words an answer matches against). */
  private render(p: PermissionEntry): PermissionWait {
    const screen = p.dialog ? dialogCard(p.dialog) : null;
    const detail = screen?.detail && maskText(screen.detail);
    const shown = screen
      ? {
          // Masking that dropped whole lines (an env-style block) hid part of what 허용 approves:
          // then the card offers only the terminal.
          toolId: detail?.includes(ENV_DUMP_NOTE)
            ? ''
            : `screen:${createHash('sha256').update(p.dialog!).digest('hex').slice(0, 16)}`,
          tool: maskText(screen.tool),
          ...(detail && { detail }),
        }
      : (({ match: _match, ...card }) => card)(p.transcript);
    return { ...shown, ...(p.asker && { asker: p.asker }), ...(p.options && { options: p.options }) };
  }

  /** PERM-PROMPT: 허용/거부 on a card: privileged like typing into that session's terminal; a key
   *  only when its dialog is on screen and about the card's call (chat.ts answerPermission).
   *  ACP-1: an `allow_always` option widens what the agent may do from now on, like a permission
   *  mode change: a remote device needs a fresh step-up for it (S1). */
  async answer(
    msg: Record<string, unknown>,
    privileged: boolean,
    device: string,
    stepUp?: SocketStepUp,
  ): Promise<PermissionAnswerResult | null> {
    const req = parsePermissionAnswer(msg);
    if (!req) return null;
    const reply = (o: Partial<PermissionAnswerResult>): PermissionAnswerResult => ({
      type: 'permissionAnswerResult',
      requestId: req.requestId,
      agentId: req.agentId,
      ok: true,
      ...o,
    });
    const e = this.deps.entryOf(req.agentId);
    const refusal = !this.deps.chat
      ? refused('chat_off')
      : !privileged
        ? refused('no_permission')
        : !e?.key.startsWith('engine:') || !e.bg?.id
          ? refused('not_engine_project')
          : null;
    const what = `permission ${req.allow ? 'allow' : 'deny'} ${JSON.stringify(e?.name ?? req.agentId).slice(0, 66)} gui:${device}`;
    if (refusal || !e?.bg?.id) {
      console.log(`[agty engine] ${what}: refused (${refusal?.error})`);
      return reply({ ok: false, ...refusal });
    }
    const p = this.permissions.get(req.agentId);
    const card = p && this.render(p);
    const match = p?.dialog !== undefined ? { dialog: p.dialog } : p?.transcript.match;
    // ACP-1: a card with options takes exactly one of them, of the kind the button said (allow or reject).
    const option = p?.options?.find((o) => o.optionId === req.optionId);
    const optionOk = !p?.options || (!!option && option.kind.startsWith('allow') === req.allow);
    if (optionOk && option?.kind === 'allow_always' && card?.toolId === req.toolId && stepUp?.remote && !stepUp.fresh()) {
      console.log(`[agty engine] ${what}: refused (${STEPUP_REQUIRED})`);
      return reply({ ok: false, error: STEPUP_REQUIRED });
    }
    const result =
      !card?.toolId || card.toolId !== req.toolId || !match || !optionOk
        ? ('gone' as const)
        : p?.hook
          ? (p.hook({ allow: req.allow, ...(option && { optionId: option.optionId }) }), 'answered' as const) // the hook's or the ACP request's decision
          : ((await this.deps.typist?.answerPermission?.(e.bg.id, match, req.allow)) ?? 'failed');
    console.log(`[agty engine] ${what}: ${result}`);
    if (result === 'answered') this.waits?.answered(req.agentId);
    // Another dialog is up than the card says: read the screen again (the owner asked, once).
    if (result === 'otherDialog' && this.permissions.get(req.agentId) === p && p?.screen === 'done') {
      delete p.screen;
      this.readScreen(req.agentId);
    }
    return reply({ result });
  }
}
