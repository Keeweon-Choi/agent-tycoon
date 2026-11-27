/** The office messenger's chat client-message routes: sends, pending edits, holds, slash commands, chat and work views. */
import * as os from 'os';
import * as path from 'path';

import { pickRefusal, type Refused, refused } from '../../../../core/src/agent-tycoon/serverText.js';
import type {
  ChatCancel,
  ChatEdit,
  ChatHold,
  ChatPendingResult,
  ChatSend,
  ChatSendNow,
  ChatSendResult,
  OfficeSnapshot,
  SideAnswer,
  SideAsk,
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
import { cliOf, DEFAULT_PROVIDER } from '../engine/registry.js';
import type { ClientMessageContext, WsSend } from '../hooks.js';
import type { AgentEntry } from '../providers/types.js';
import { askSide, parseSideAsk, SIDE_MODEL_RE } from '../sideQuestion.js';
import { pickerCommands, type SlashCatalogue, slashRefusal } from '../slashCommands.js';
import type { WorkReader, WorkTarget, WorkViews } from '../workView.js';
import { echo, fileReader, parseWorkView, subagentReader } from '../workView.js';

interface ChatDeps {
  opts: { chat?: boolean; store: AgentStateStore; home?: string; engineClaude?: string };
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

  /** T-115: the side question in flight (one per daemon) and who asked it, to stop it when its drawer or socket closes. */
  private side: { send: WsSend; requestId: string; stop: AbortController } | null = null;

  constructor(private readonly deps: ChatDeps) {}

  onClientMessage(msg: Record<string, unknown>, ctx: ClientMessageContext): boolean {
    const { send, privileged, userAgent } = ctx;
    if (msg.type === 'chatSend' || msg.type === 'chatSendNow') {
      const req = msg.type === 'chatSend' ? parseChatSend(msg) : parseChatSendNow(msg);
      if (!req) console.warn(`[agty] malformed ${msg.type} dropped`);
      else
        void this.chatSend(req, privileged, deviceLabel(userAgent)).then(
          (result) => send({ ...result }),
          (err: unknown) => console.warn(`[agty] send: ${String(err)}`),
        );
      return true;
    }
    if (msg.type === 'chatCancel' || msg.type === 'chatEdit') {
      const req = msg.type === 'chatCancel' ? parseChatCancel(msg) : parseChatEdit(msg);
      if (!req) console.warn(`[agty] malformed ${msg.type} dropped`);
      else
        void this.chatPending(req, privileged, deviceLabel(userAgent)).then(
          (result) => send({ ...result }),
          (err: unknown) => console.warn(`[agty] pending message: ${String(err)}`),
        );
      return true;
    }
    if (msg.type === 'chatHold') {
      const req = parseChatHold(msg);
      if (!req) console.warn('[agty] malformed chatHold dropped');
      else this.chatHold(req, privileged);
      return true;
    }
    if (msg.type === 'slashCommands') {
      if (!Number.isInteger(msg.agentId) || typeof msg.requestId !== 'string') return true;
      this.sendSlashCommands(msg.agentId as number, msg.requestId, send, privileged);
      return true;
    }
    if (msg.type === 'sideAsk') {
      const req = parseSideAsk(msg);
      if (!req) {
        console.warn('[agty] malformed sideAsk refused');
        // An ask that cannot be read still gets its answer when it can be addressed: its card must not wait forever.
        const { requestId, agentId } = msg;
        if (typeof requestId === 'string' && requestId.length <= 100 && Number.isInteger(agentId))
          send({
            type: 'sideAnswer',
            requestId,
            agentId: agentId as number,
            ok: false,
            ...refused('side_bad_request'),
          } satisfies SideAnswer);
      } else
        void this.sideAsk(req, send, privileged).catch((err: unknown) =>
          console.warn(`[agty] side question: ${String(err)}`),
        );
      return true;
    }
    if (msg.type === 'sideCancel') {
      if (this.side?.send === send && this.side.requestId === msg.requestId) this.side.stop.abort();
      return true;
    }
    if (msg.type === 'chatView') {
      if (!this.deps.opts.chat || typeof msg.agentId !== 'number' || typeof msg.on !== 'boolean') return true;
      this.deps.conversations.view(send, msg.agentId, msg.on);
      if (!msg.on) this.unwatchSlash(send, msg.agentId);
      else this.deps.readScreen(msg.agentId); // PERM-PROMPT: a card someone now looks at
      return true;
    }
    if (msg.type === 'chatHistory' || msg.type === 'chatSearch' || msg.type === 'chatFiles') {
      if (!this.deps.opts.chat || !Number.isInteger(msg.agentId) || typeof msg.requestId !== 'string')
        return true;
      const agentId = msg.agentId as number;
      if (!privileged) {
        send(
          msg.type === 'chatFiles'
            ? {
                type: 'chatFilesResult',
                requestId: msg.requestId,
                agentId,
                files: [],
                done: false,
                ...refused('no_permission'),
              }
            : msg.type === 'chatHistory'
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
      } else if (msg.type === 'chatFiles') {
        if (msg.before !== undefined && typeof msg.before !== 'string') return true;
        this.deps.conversations.files(send, agentId, msg.requestId, msg.before as string | undefined);
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
    if (this.side?.send === send) this.side.stop.abort();
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
      // T-115: the side question's picker offers what the CLI itself lists.
      ...(this.deps.slash.models().length && { models: this.deps.slash.models() }),
      ...why,
    });
    const entry = this.deps.entryOf(agentId);
    if (!this.deps.opts.chat) return void send({ ...reply([], refused('chat_off')) });
    if (!privileged) return void send({ ...reply([], refused('no_permission')) });
    if (!entry?.key.startsWith('engine:') || !this.deps.engine?.names().includes(entry.name)) {
      return void send({ ...reply([], refused('not_engine_project')) });
    }
    // T-81 C: a Lead in our PTY may send a bare picker command (its picker shows in the sheet).
    const forLead = (commands: SlashCommand[]) =>
      this.deps.engine?.inPty(entry.name) ? pickerCommands(commands) : commands;
    send({ ...reply(forLead(this.deps.slash.list(entry.dir))) });
    this.unwatchSlash(send, agentId);
    const stop = this.deps.slash.watch(entry.dir, (commands) => send({ ...reply(forLead(commands)) }));
    let views = this.slashViews.get(send);
    if (!views) {
      views = new Map();
      this.slashViews.set(send, views);
    }
    views.set(agentId, stop);
  }

  /**
   * T-115 사이드 질문: answered by a read-only fork of the Lead's latest conversation that is
   * never written (sideQuestion.ts); the Lead and its conversation are untouched. Only an
   * accepted socket asks (fully trusted); reading needs no step-up. One at a time per daemon (askSide).
   */
  private async sideAsk(req: SideAsk, send: WsSend, privileged: boolean): Promise<void> {
    const reply = (o: Omit<SideAnswer, 'type' | 'requestId' | 'agentId'>) =>
      send({ type: 'sideAnswer', requestId: req.requestId, agentId: req.agentId, ...o } satisfies SideAnswer);
    const entry = this.deps.entryOf(req.agentId);
    const engine = this.deps.engine;
    const claude = this.deps.opts.engineClaude;
    const lead = entry && engine?.roster().find((a) => a.name === entry.name);
    const known = this.deps.slash.models();
    const why = !this.deps.opts.chat
      ? refused('chat_off')
      : !privileged
        ? refused('no_permission')
        : !entry?.key.startsWith('engine:') || !engine || !claude || !lead
          ? refused('not_engine_project')
          : cliOf(lead) !== DEFAULT_PROVIDER
            ? refused('side_not_claude')
            : !entry.sessionId
              ? refused('side_no_session')
              : !SIDE_MODEL_RE.test(req.model) || (known.length > 0 && !known.some((m) => m.value === req.model))
                ? refused('side_bad_model')
                : null;
    if (why || !entry?.sessionId || !engine || !claude) return reply({ ok: false, ...(why ?? refused('side_failed')) });
    if (this.side) return reply({ ok: false, ...refused('side_busy') });
    const stop = new AbortController();
    this.side = { send, requestId: req.requestId, stop };
    const r = await askSide({
      signal: stop.signal,
      claude,
      env: engine.jobEnv(),
      cwd: engine.folderOf(entry.name) ?? entry.dir,
      sessionId: entry.sessionId,
      model: req.model,
      question: req.question,
      earlier: req.earlier,
    }).finally(() => (this.side = null));
    console.log(`[agty] side question to ${JSON.stringify(entry.name).slice(0, 66)}: ${r.ok ? 'answered' : stop.signal.aborted ? 'stopped' : r.why.errorCode}`);
    reply(r.ok ? { ok: true, text: r.text, model: req.model } : { ok: false, model: req.model, ...r.why });
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
        ? slashRefusal(
            this.deps.engine?.inPty(req.name) ? pickerCommands(this.deps.slash.list(folder)) : this.deps.slash.list(folder),
            req.text,
          )
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
      console.log(`[agty engine] ${what}: refused (${refusal?.error})`);
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
    console.log(`[agty engine] ${what}: ${r.ok ? r.delivered : `failed (${r.code})`}`);
    return r.ok
      ? reply({
          ok: true,
          delivered: r.delivered,
          ...(r.id && { queueId: r.id }),
          ...(r.messageId && { messageId: r.messageId }),
          ...(r.screen && { screen: r.screen }),
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
        : this.deps.messenger.edit(req.name, req.id, req.text, req.replyTo);
    console.log(
      `[agty engine] ${req.type === 'chatCancel' ? 'cancel' : 'edit'} ${JSON.stringify(req.name).slice(0, 66)} gui:${device}: ${r.ok ? 'ok' : `failed (${r.code})`}`,
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
