/**
 * ACP-1: an ACP session's conversation, written as a transcript in Claude Code's JSONL shape, so
 * everything that follows an agent through its transcript works unchanged for an ACP agent: the
 * office character (transcriptParser: tools, turn ends, the context gauge), the messenger and the
 * 개발실's 대화 pane (transcriptView), the messenger's queue (turnOver, alreadyTyped), compactions.
 *
 * What an agent sends is untrusted: only the fields read here are kept, each a string or number of
 * a bounded size, re-serialized by JSON.stringify (nothing the agent wrote reaches the file raw).
 * Unknown update kinds are ignored. The file is ours (<settings>/acp/), named by a sanitized id.
 *
 * ACP -> transcript:
 * - our prompt -> a `user` record (its header and ⟨m:id⟩ mark as the messenger wrote them)
 * - agent_message_chunk (text) -> joined into one `assistant` text record, written at the next
 *   tool call, plan or turn end
 * - tool_call -> an `assistant` tool_use (name from the ACP tool kind: Read, Edit, Bash, Grep,
 *   WebFetch, else Tool); tool_call_update completed/failed -> its `user` tool_result
 * - plan -> a TodoWrite tool_use and its result
 * - usage_update {used, size} -> a `system` acp_usage record carrying message.usage and
 *   message.contextWindow (the gauge's reported window)
 * - compaction_update completed -> a `system` compact_boundary record
 * - the prompt's answer -> open tools closed, a `system` turn_duration record (the turn's end)
 */
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../../../core/src/agent-tycoon/serverText.js';
import {
  ACP_FIELD_MAX,
  ACP_OPEN_TOOLS_MAX,
  ACP_PLAN_MAX,
  ACP_TEXT_MAX,
  ACP_TRANSCRIPT_MAX_BYTES,
  PERMISSION_MODE_ASKS_EXACTLY,
} from '../../../../constants.js';
import { readTranscriptTail } from '../../../../contextUsage.js';
import { configDir } from '../../events.js';

const USAGE_SUBTYPE = 'acp_usage';

/** Where ACP transcripts live. */
export const acpDir = (home: string): string => path.join(configDir(home), 'acp');

/** A file name from an agent's session id: kept when it is plainly safe, else its hash. */
export function safeId(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..')
    ? id
    : createHash('sha256').update(id).digest('hex').slice(0, 32);
}

/** The agent picks its session ids (maybe a plain counter): the file is named by the preset and the
 *  folder too, so two projects (or two agents) never share one. */
export const acpTranscriptPath = (home: string, preset: string, cwd: string, sessionId: string): string =>
  path.join(acpDir(home), `${safeId(preset)}-${createHash('sha256').update(cwd).digest('hex').slice(0, 12)}-${safeId(sessionId)}.jsonl`);

const str = (v: unknown, max = ACP_FIELD_MAX): string | undefined =>
  typeof v === 'string' && v ? (v.length > max ? `${v.slice(0, max)}…` : v) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** ACP tool kinds -> the tool names the office and the messenger know how to show. */
const TOOL_OF_KIND: Readonly<Record<string, string>> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Edit',
  move: 'Edit',
  execute: 'Bash',
  search: 'Grep',
  fetch: 'WebFetch',
};

/** One ACP tool call as a tool_use: its name and the few input fields our lines show. */
export function toolUse(call: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const name = TOOL_OF_KIND[String(call.kind)] ?? 'Tool';
  const raw = obj(call.rawInput);
  const title = str(call.title);
  const first = Array.isArray(call.locations) ? str(obj(call.locations[0]).path) : undefined;
  const input: Record<string, unknown> = {};
  if (title) input.description = title;
  if (name === 'Bash') input.command = str(raw.command) ?? title ?? '';
  else if (name === 'WebFetch') input.url = str(raw.url) ?? title ?? '';
  else if (name === 'Grep') input.pattern = str(raw.pattern) ?? str(raw.query) ?? title ?? '';
  else if (first || str(raw.path) || str(raw.file_path)) input.file_path = first ?? str(raw.path) ?? str(raw.file_path);
  return { name, input };
}

export class AcpTranscript {
  private text = '';
  private cut = false;
  /** Tool calls written as tool_use and not ended yet. */
  private readonly open = new Set<string>();
  /** The file's size as we wrote it; past ACP_TRANSCRIPT_MAX_BYTES only `keep` records go in. */
  private size = 0;
  private full = false;

  constructor(
    readonly file: string,
    private readonly sessionId: string,
    private readonly log: (line: string) => void,
  ) {}

  /** The session (re)started: the mode record, once per start (this agent asks every permission
   *  through ACP, so the office never guesses a wait from a quiet tool call: permissionMode.ts). */
  begin(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    } catch {
      /* append() logs the failure */
    }
    try {
      this.size = fs.statSync(this.file).size;
    } catch {
      this.size = 0;
    }
    this.append({ type: 'permission-mode', permissionMode: PERMISSION_MODE_ASKS_EXACTLY }, true);
  }

  user(text: string): void {
    this.flush();
    this.append({ type: 'user', message: { role: 'user', content: text } }, true);
  }

  /** One session/update's `update` (untrusted; anything not understood is ignored). */
  update(raw: unknown): void {
    const u = obj(raw);
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = obj(u.content);
        if (c.type === 'text' && typeof c.text === 'string') this.chunk(c.text);
        return;
      }
      case 'tool_call': {
        const id = str(u.toolCallId, 200);
        if (!id || this.open.has(id) || this.open.size >= ACP_OPEN_TOOLS_MAX) return;
        this.flush();
        const { name, input } = toolUse(u);
        this.append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
        this.open.add(id);
        if (u.status === 'completed' || u.status === 'failed') this.result(id, u.status === 'failed');
        return;
      }
      case 'tool_call_update': {
        const id = str(u.toolCallId, 200);
        if (id && this.open.has(id) && (u.status === 'completed' || u.status === 'failed'))
          this.result(id, u.status === 'failed');
        return;
      }
      case 'plan': {
        if (!Array.isArray(u.entries)) return;
        this.flush();
        const todos = u.entries.slice(0, ACP_PLAN_MAX).flatMap((e) => {
          const content = str(obj(e).content);
          const status = obj(e).status;
          return content ? [{ content, activeForm: content, status: typeof status === 'string' && ['pending', 'in_progress', 'completed'].includes(status) ? status : 'pending' }] : [];
        });
        const id = `plan_${randomUUID()}`;
        this.append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }] } });
        this.append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } });
        return;
      }
      case 'usage_update': {
        const used = num(u.used);
        const size = num(u.size);
        if (used === undefined || !size) return;
        this.append({ type: 'system', subtype: USAGE_SUBTYPE, message: { usage: { input_tokens: used }, contextWindow: size } });
        return;
      }
      case 'compaction_update':
        if (u.status === 'completed') {
          this.flush();
          this.append({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } });
        }
        return;
      default:
        return;
    }
  }

  /** The prompt's answer (or its failure): open calls end, then the turn. */
  end(error?: string): void {
    if (error) this.chunk(`\n\n${koText('acp_turn_failed', { error: error.slice(0, 300) })}`);
    this.flush();
    for (const id of [...this.open]) this.result(id, true);
    this.append({ type: 'system', subtype: 'turn_duration' }, true);
  }

  private chunk(t: string): void {
    if (this.cut) return;
    this.text += t;
    if (this.text.length > ACP_TEXT_MAX) {
      this.text = `${this.text.slice(0, ACP_TEXT_MAX)}…`;
      this.cut = true;
    }
  }

  private flush(): void {
    const text = this.text;
    this.text = '';
    this.cut = false;
    if (text.trim())
      this.append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  }

  private result(id: string, failed: boolean): void {
    this.open.delete(id);
    this.append({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '', ...(failed && { is_error: true }) }] },
    });
  }

  /** `keep`: our prompt, the mode and the turn's end, written even past the size cap (the office
   *  and the messenger's queue follow turns by them). */
  private append(record: Record<string, unknown>, keep = false): void {
    if (this.size > ACP_TRANSCRIPT_MAX_BYTES && !keep) {
      if (!this.full) this.log(`acp transcript ${this.file}: over ${ACP_TRANSCRIPT_MAX_BYTES} bytes; the agent's words are no longer written`);
      this.full = true;
      return;
    }
    try {
      const line = `${JSON.stringify({ ...record, uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: this.sessionId })}\n`;
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
    } catch (err) {
      this.log(`acp transcript ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** How full the context is, by the newest usage record (null: none, or a compaction after it). */
export function acpFillPct(file: string): number | null {
  const text = readTranscriptTail(file);
  if (text === null) return null;
  for (const line of text.split('\n').reverse()) {
    let r: { type?: string; subtype?: string; message?: { usage?: { input_tokens?: number }; contextWindow?: number } };
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      continue;
    }
    if (r?.type !== 'system') continue;
    if (r.subtype === 'compact_boundary') return null;
    const used = r.message?.usage?.input_tokens;
    const size = r.message?.contextWindow;
    if (r.subtype === USAGE_SUBTYPE && typeof used === 'number' && typeof size === 'number' && size > 0)
      return Math.min(100, Math.round((used / size) * 100));
  }
  return null;
}
