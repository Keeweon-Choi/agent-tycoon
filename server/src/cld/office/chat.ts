/** The office messenger's chat client-message routes: sends, pending edits, holds, slash commands, chat and work views. */
import * as os from 'os';
import * as path from 'path';

import { pickRefusal, type Refused, refused } from '../../../../core/src/cld/serverText.js';
import type {
  ChatCancel,
  ChatEdit,
  ChatHold,
  ChatPendingResult,
  ChatSend,
  ChatSendNow,
  ChatSendResult,
  OfficeSnapshot,
  SlashCommand,
  SlashCommandsList,
} from '../../../../core/src/messages.js';
import type { AgentStateStore } from '../../agentStateStore.js';
import {
  parseChatCancel,
  parseChatEdit,
  parseChatHold,
  parseChatSend,
  parseChatSendNow,
  sendTextRefusal,
} from '../chatSend.js';
import type { Conversations, Lead } from '../conversations.js';
import { deviceLabel } from '../device.js';
import type { Engine } from '../engine/engine.js';
import type { Messenger } from '../engine/messenger.js';
import type { ClientMessageContext, WsSend } from '../hooks.js';
import type { AgentEntry } from '../providers/types.js';
import { type SlashCatalogue, slashRefusal } from '../slashCommands.js';
import type { WorkReader, WorkTarget, WorkViews } from '../workView.js';
import { echo, fileReader, parseWorkView, subagentReader } from '../workView.js';

interface ChatDeps {
  opts: { chat?: boolean; store: AgentStateStore; home?: string };
  engine: Engine | null;
  messenger: Messenger | null;
  slash: SlashCatalogue;
  conversations: Conversations;
  work: WorkViews;
  entryOf(agentId: number): AgentEntry | null;
  leads(): Lead[];
  readScreen(agentId: number): void;
  publish<T extends { type: string }>(msg: T): void;
  officeState(): OfficeSnapshot;
}

export class OfficeChat {
  /** Catalogue refresh subscriptions, keyed by the client and its open lead. */
  private readonly slashViews = new Map<WsSend, Map<number, () => void>>();

  constructor(private readonly deps: ChatDeps) {}

  onClientMessage(msg: Record<string, unknown>, ctx: ClientMessageContext): boolean {
    const { send, privileged, userAgent } = ctx;
    if (msg.type === 'chatSend' || msg.type === 'chatSendNow') {
      const req = msg.type === 'chatSend' ? parseChatSend(msg) : parseChatSendNow(msg);
      if (!req) console.warn(`[cld] malformed ${msg.type} dropped`);
      else
        void this.chatSend(req, privileged, deviceLabel(userAgent)).then(
          (result) => send({ ...result }),
          (err: unknown) => console.warn(`[cld] send: ${String(err)}`),
        );
      return true;
    }
    if (msg.type === 'chatCancel' || msg.type === 'chatEdit') {
      const req = msg.type === 'chatCancel' ? parseChatCancel(msg) : parseChatEdit(msg);
      if (!req) console.warn(`[cld] malformed ${msg.type} dropped`);
      else
        void this.chatPending(req, privileged, deviceLabel(userAgent)).then(
          (result) => send({ ...result }),
          (err: unknown) => console.warn(`[cld] pending message: ${String(err)}`),
        );
      return true;
    }
    if (msg.type === 'chatHold') {
      const req = parseChatHold(msg);
      if (!req) console.warn('[cld] malformed chatHold dropped');
      else this.chatHold(req, privileged);
      return true;
    }
    if (msg.type === 'slashCommands') {
      if (!Number.isInteger(msg.agentId) || typeof msg.requestId !== 'string') return true;
      this.sendSlashCommands(msg.agentId as number, msg.requestId, send, privileged);
      return true;
    }
    if (msg.type === 'chatView') {
      if (!this.deps.opts.chat || typeof msg.agentId !== 'number' || typeof msg.on !== 'boolean') return true;
      this.deps.conversations.view(send, msg.agentId, msg.on);
      if (!msg.on) this.unwatchSlash(send, msg.agentId);
      else this.deps.readScreen(msg.agentId); // PERM-PROMPT: a card someone now looks at
      return true;
    }
    if (msg.type === 'chatHistory' || msg.type === 'chatSearch') {
      if (!this.deps.opts.chat || !Number.isInteger(msg.agentId) || typeof msg.requestId !== 'string')
        return true;
      const agentId = msg.agentId as number;
      if (!privileged) {
        send(
          msg.type === 'chatHistory'
            ? {
                type: 'chatHistoryResult',
                requestId: msg.requestId,
                agentId,
                items: [],
                done: false,
                ...refused('no_permission'),
              }
            : {
                type: 'chatSearchResult',
                requestId: msg.requestId,
                agentId,
                hits: [],
                truncated: false,
                ...refused('no_permission'),
              },
        );
        return true;
      }
      if (msg.type === 'chatHistory') {
        if (msg.before !== undefined && typeof msg.before !== 'string') return true;
        if (
          msg.until !== undefined &&
          (typeof msg.until !== 'number' || !Number.isFinite(msg.until))
        )
          return true;
        this.deps.conversations.history(
          send,
          agentId,
          msg.requestId,
          msg.before as string | undefined,
          msg.until as number | undefined,
        );
      } else if (typeof msg.query === 'string') {
        this.deps.conversations.search(send, agentId, msg.requestId, msg.query);
      }
      return true;
    }
    if (msg.type === 'workView') {
      const req = this.deps.opts.chat ? parseWorkView(msg) : null;
      if (!req) return true;
      if (req.on && !privileged) {
        send({
          type: 'workContent',
          ...echo(req.target),
          items: [],
          ...refused('no_permission'),
        });
        return true;
      }
      this.deps.work.view(send, req.target, req.on);
      return true;
    }
    return false;
  }

  onClientClosed(send: WsSend): void {
    this.unwatchSlash(send);
  }

  /** chatSend reaches an engine project (the engine messenger). */
  canSend(key: string, name: string): boolean {
    if (!this.deps.opts.chat || !key.startsWith('engine:')) return false;
    return !!this.deps.messenger && !!this.deps.engine?.names().includes(name);
  }

  /** The daemon owns the allow-list; raw commands exist only for engine leads. */
  private sendSlashCommands(
    agentId: number,
    requestId: string,
    send: WsSend,
    privileged: boolean,
  ): void {
    const reply = (commands: SlashCommand[], why?: Refused): SlashCommandsList => ({
      type: 'slashCommandsList',
      requestId,
      agentId,
      commands,
      ...why,
    });
    const entry = this.deps.entryOf(agentId);
    if (!this.deps.opts.chat) return void send({ ...reply([], refused('chat_off')) });
    if (!privileged) return void send({ ...reply([], refused('no_permission')) });
    if (!entry?.key.startsWith('engine:') || !this.deps.engine?.names().includes(entry.name)) {
      return void send({ ...reply([], refused('not_engine_project')) });
    }
    send({ ...reply(this.deps.slash.list(entry.dir)) });
    this.unwatchSlash(send, agentId);
    const stop = this.deps.slash.watch(entry.dir, (commands) => send({ ...reply(commands) }));
    let views = this.slashViews.get(send);
    if (!views) {
      views = new Map();
      this.slashViews.set(send, views);
    }
    views.set(agentId, stop);
  }

  private unwatchSlash(send: WsSend, agentId?: number): void {
    const views = this.slashViews.get(send);
    if (!views) return;
    if (agentId !== undefined) {
      views.get(agentId)?.();
      views.delete(agentId);
    } else {
      for (const stop of views.values()) stop();
      views.clear();
    }
    if (!views.size) this.slashViews.delete(send);
  }

  /** A reader for a temp's work view, or why there is none. */
  workReader(t: WorkTarget): WorkReader | Refused {
    const none = refused('work_record_missing');
    const store = this.deps.opts.store;
    if (t.kind === 'subagent') {
      const lead =
        store.get(t.agentId!)?.jsonlFile ||
        this.deps.leads().find((l) => l.agentId === t.agentId)?.transcript;
      return lead ? subagentReader(lead, t.id!) : none;
    }
    const id = t.agentId!;
    if (!store.get(id)?.jsonlFile) return none;
    const root = path.join(this.deps.opts.home ?? os.homedir(), '.claude/projects');
    return fileReader(() => store.get(id)?.jsonlFile ?? null, root);
  }

  /**
   * A messenger message to an engine project, through the engine messenger
   * (typed in when idle, else queued; header `[사장 · 메신저 · time]`). A
   * catalogue-listed `/` command from the privileged boss goes through the
   * engine without that header. `now` and chatSendNow (지금 보내기 on a waiting
   * one): the engine messenger may type it in while the session works. Never rejects.
   */
  private async chatSend(
    req: ChatSend | ChatSendNow,
    privileged: boolean,
    device: string,
  ): Promise<ChatSendResult> {
    const engine = !!this.deps.messenger && !!this.deps.engine?.names().includes(req.name);
    const reply = (o: Omit<ChatSendResult, 'type' | 'requestId' | 'name'>): ChatSendResult => ({
      type: 'chatSendResult',
      requestId: req.requestId,
      name: req.name,
      ...o,
    });
    const folder = this.deps.engine?.folderOf(req.name); // a Worker's own (its slash commands)
    const rawRefusal =
      req.type === 'chatSend' && req.text.startsWith('/') && folder
        ? slashRefusal(this.deps.slash.list(folder), req.text)
        : null;
    const refusal = !this.deps.opts.chat
      ? refused('chat_off')
      : !privileged
        ? refused('no_permission')
        : !engine || !this.deps.messenger
          ? refused('not_engine_project')
          : req.type === 'chatSend'
            ? (sendTextRefusal(req.text) ?? rawRefusal)
            : null;
    const what = `${req.type === 'chatSend' ? 'send' : 'send now'} ${JSON.stringify(req.name).slice(0, 66)} gui:${device}`;
    if (refusal || !this.deps.messenger) {
      console.log(`[cld engine] ${what}: refused (${refusal?.error})`);
      return reply({ ok: false, ...(refusal ?? { error: '' }) });
    }
    // The boss's words wait for the session as long as it lives: never into the
    // inbox (read only at the next start) because it stayed busy for 10 minutes.
    const r =
      req.type === 'chatSendNow'
        ? this.deps.messenger.promote(req.name, req.id)
        : await this.deps.messenger.send({
            to: req.name,
            text: req.text,
            ifIdle: false,
            from: null,
            source: `messenger:${device}`,
            ...(req.now && { now: true }),
            ...(req.replyTo && { replyTo: req.replyTo }),
            ...(req.text.startsWith('/') ? { raw: true } : {}),
          });
    console.log(`[cld engine] ${what}: ${r.ok ? r.delivered : `failed (${r.code})`}`);
    return r.ok
      ? reply({
          ok: true,
          delivered: r.delivered,
          ...(r.id && { queueId: r.id }),
          ...(r.messageId && { messageId: r.messageId }),
        })
      : reply({ ok: false, ...pickRefusal(r) });
  }

  /** Change or remove a boss message that has not reached the Typist yet. */
  private async chatPending(
    req: ChatCancel | ChatEdit,
    privileged: boolean,
    device: string,
  ): Promise<ChatPendingResult> {
    const engine = !!this.deps.messenger && !!this.deps.engine?.names().includes(req.name);
    const reply = (o: Omit<ChatPendingResult, 'type' | 'requestId' | 'name' | 'id'>) => ({
      type: 'chatPendingResult' as const,
      requestId: req.requestId,
      name: req.name,
      id: req.id,
      ...o,
    });
    const refusal = !this.deps.opts.chat
      ? refused('chat_off')
      : !privileged
        ? refused('no_permission')
        : !engine || !this.deps.messenger
          ? refused('not_engine_project')
          : req.type === 'chatEdit'
            ? sendTextRefusal(req.text)
            : null;
    if (refusal || !this.deps.messenger) return reply({ ok: false, ...(refusal ?? { error: '' }) });
    const r =
      req.type === 'chatCancel'
        ? this.deps.messenger.cancel(req.name, req.id)
        : this.deps.messenger.edit(req.name, req.id, req.text);
    console.log(
      `[cld engine] ${req.type === 'chatCancel' ? 'cancel' : 'edit'} ${JSON.stringify(req.name).slice(0, 66)} gui:${device}: ${r.ok ? 'ok' : `failed (${r.code})`}`,
    );
    // The queue is part of every open conversation's snapshot. Poll now so
    // another screen sees the edited/cancelled bubble without waiting 1.5 s.
    if (r.ok) {
      this.deps.conversations.poll();
      this.deps.publish<OfficeSnapshot>(this.deps.officeState()); // a saved or cancelled edit ends its hold
    }
    return r.ok
      ? reply({ ok: true })
      : reply({ ok: false, ...pickRefusal(r), ...((r.code === 'not_queued' || r.code === 'typing') && { gone: true }) });
  }

  /** MSG-HOLD2: the office row's mark for edits left held (a forgotten edit cannot hide). */
  heldEdits(name: string): { heldEdits?: number } {
    const n = this.deps.messenger?.queuedFor(name).filter((q) => q.held).length ?? 0;
    return n ? { heldEdits: n } : {};
  }

  /** Keep a browser's queued message in place while that browser edits it. */
  private chatHold(req: ChatHold, privileged: boolean): void {
    const engine = !!this.deps.messenger && !!this.deps.engine?.names().includes(req.name);
    if (!this.deps.opts.chat || !privileged || !engine || !this.deps.messenger) return;
    // Every open messenger shows the held state (MSG-HOLD2: a reloaded page finds it with its choices).
    if (this.deps.messenger.hold(req.name, req.id, req.on)) {
      this.deps.conversations.poll();
      this.deps.publish<OfficeSnapshot>(this.deps.officeState()); // the row's heldEdits
    }
  }
}
