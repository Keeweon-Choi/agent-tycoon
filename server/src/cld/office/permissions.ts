import { createHash } from 'crypto';

import { refused } from '../../../../core/src/cld/serverText.js';
import type { PermissionAnswerResult, PermissionWait } from '../../../../core/src/messages.js';
import type { AgentStateStore } from '../../agentStateStore.js';
import { PTY_PERMISSION_WAIT_MS } from '../../constants.js';
import { hookProviders } from '../../providers/index.js';
import type { Conversations } from '../conversations.js';
import type { Typist } from '../engine/messenger.js';
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
  /** TERM-P3: a PTY agent's PermissionRequest hook waits on this card: 허용/거부 is its decision. */
  hook?: (decision: 'allow' | 'deny' | null) => void;
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
}

export class OfficePermissions {
  /** PERM-PROMPT: engine sessions held by a permission dialog, and what each card shows. */
  readonly waits: PermissionWaits | null;
  private readonly permissions = new Map<number, PermissionEntry>();
  private serial = 0;

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
        return !!e && !this.deps.inPty(e.name);
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
          console.log(`[cld engine] "${e?.name ?? id}" waits on a permission dialog`);
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
    });
    return waits;
  }

  /**
   * TERM-P3 (ADR-0018): a PTY agent's PermissionRequest hook (control `permission-hook`, with the
   * asking session's own token). The same card, bubble, 🔐 notice and Web Push as a PERM-PROMPT
   * wait, made from the hook's tool and input (its description and whole command: 허용 approves
   * exactly that call); 허용/거부 is the hook's decision. No answer in PTY_PERMISSION_WAIT_MS, the
   * character gone, or no such PTY agent: no decision, and Claude shows its own dialog in the
   * agent's terminal. Nothing is read off a screen.
   */
  ask(name: string, ask: { tool: string; input: Record<string, unknown> }): Promise<'allow' | 'deny' | null> {
    const id = this.deps.agentIdOfName(name);
    const e = id === null ? undefined : this.deps.entryOf(id);
    if (id === null || !e?.key.startsWith('engine:') || !e.bg?.id || !this.deps.inPty(name))
      return Promise.resolve(null);
    // ponytail: one card per agent; a second ask while one is up sends the first to its terminal.
    this.permissions.get(id)?.hook?.(null);
    const call = toolCall(ask.tool, ask.input);
    const detail = call.match.length ? call.match.join('\n') : call.detail;
    const wait = ++this.serial;
    return new Promise((resolve) => {
      const done = (decision: 'allow' | 'deny' | null) => {
        clearTimeout(timer);
        if (this.permissions.get(id)?.wait === wait) {
          this.permissions.delete(id);
          this.deps.store.broadcast({ type: 'agentToolPermissionClear', id });
          this.deps.conversations.republish();
        }
        resolve(decision);
      };
      const timer = setTimeout(() => done(null), PTY_PERMISSION_WAIT_MS);
      timer.unref?.();
      this.permissions.set(id, {
        wait,
        transcript: { toolId: `hook:${wait}`, tool: call.tool, ...(detail && { detail: maskText(detail) }), match: [] },
        screen: 'done',
        hook: done,
      });
      console.log(`[cld engine] "${name}" asks a permission (${call.tool}) through its hook`);
      this.deps.store.broadcast({ type: 'agentToolPermission', id });
      this.deps.conversations.republish();
    });
  }

  /**
   * PERM-PROMPT: while a wait is confirmed and someone views its conversation, read the dialog off
   * the session's screen, once per wait (one attach, read, detach: ~150 MB for a few seconds), and
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
    return { ...shown, ...(p.asker && { asker: p.asker }) };
  }

  /** PERM-PROMPT: 허용/거부 on a card: privileged like typing into that session's terminal; a key
   *  only when its dialog is on screen and about the card's call (chat.ts answerPermission). */
  async answer(
    msg: Record<string, unknown>,
    privileged: boolean,
    device: string,
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
      console.log(`[cld engine] ${what}: refused (${refusal?.error})`);
      return reply({ ok: false, ...refusal });
    }
    const p = this.permissions.get(req.agentId);
    const card = p && this.render(p);
    const match = p?.dialog !== undefined ? { dialog: p.dialog } : p?.transcript.match;
    const result =
      !card?.toolId || card.toolId !== req.toolId || !match
        ? ('gone' as const)
        : p?.hook
          ? (p.hook(req.allow ? 'allow' : 'deny'), 'answered' as const) // TERM-P3: the hook's decision
          : ((await this.deps.typist?.answerPermission?.(e.bg.id, match, req.allow)) ?? 'failed');
    console.log(`[cld engine] ${what}: ${result}`);
    if (result === 'answered') this.waits?.answered(req.agentId);
    // Another dialog is up than the card says: read the screen again (the owner asked, once).
    if (result === 'otherDialog' && this.permissions.get(req.agentId) === p && p?.screen === 'done') {
      delete p.screen;
      this.readScreen(req.agentId);
    }
    return reply({ result });
  }
}
