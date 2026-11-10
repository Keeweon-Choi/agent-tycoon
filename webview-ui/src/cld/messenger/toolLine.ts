import type { ChatItem, OfficeJob } from '../../../../core/src/messages.js';
import { TOOL_ROW_INPUT_MAX } from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import { describeActivity, type EzContext, PLAIN_CONTEXT } from '../ez/activity.js';

const MCP_PREFIX = 'mcp__';
/** The MCP server our engine hands its agents (cld/bin/cld-gui-mcp.js), and the name it had before
 *  T-80: old transcripts and sessions started before the update keep it until they restart. */
const ENGINE_SERVER = 'agty';
const ENGINE_SERVER_OLD = 'cld-gui'; // T-80: drop one release after the rename
const isEngineServer = (server: string): boolean =>
  server === ENGINE_SERVER || server === ENGINE_SERVER_OLD;
const MCP_EMOJI = '⚙️';
const TASK_STATUSES = new Set(['proposed', 'todo', 'doing', 'review', 'blocked', 'done']);

/** `mcp__agty__update_task` -> { server: 'agty', tool: 'update_task' }; null for any other tool. */
export function parseMcpTool(
  toolName: string | undefined,
): { server: string; tool: string } | null {
  if (!toolName?.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const cut = rest.indexOf('__');
  return cut < 1
    ? { server: '', tool: rest }
    : { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

/** The `args` line the server makes (`taskId: T-59, status: done`) as fields; the first of a key wins.
 *  ponytail: splits on ", key: ", so a value holding that text cuts early; shown fields are short ids. */
export function argFields(args: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = (args ?? '').split(/(?:^|, )([A-Za-z]\w*): /);
  for (let i = 1; i + 1 < parts.length; i += 2) out[parts[i]] ??= parts[i + 1].trim();
  return out;
}

const short = (v: string): string =>
  v.length > TOOL_ROW_INPUT_MAX ? `${v.slice(0, TOOL_ROW_INPUT_MAX)}…` : v;

/** An engine tool's row with its key input, when the line carries one (the work view's `args`). */
function engineDetail(tool: string, args: string | undefined): string | null {
  const f = argFields(args);
  const need = (k: string) => (f[k] ? short(f[k]) : null);
  switch (tool) {
    case 'create_task': {
      const title = need('title');
      return title && t('messenger.mcp.createTaskWith', { title });
    }
    case 'update_task': {
      const id = need('taskId');
      if (!id) return null;
      const status = TASK_STATUSES.has(f.status)
        ? t(`tasks.status.${f.status}` as TranslationKey)
        : null;
      return status
        ? t('messenger.mcp.updateTaskTo', { id, status })
        : t('messenger.mcp.updateTaskNote', { id });
    }
    case 'get_task_status': {
      const id = need('taskId');
      return id && t('messenger.mcp.taskStatusOf', { id });
    }
    case 'send_message': {
      const to = need('to');
      return to && t('messenger.mcp.sendTo', { to });
    }
    case 'post_to_group': {
      const room = need('room');
      return room && t('messenger.mcp.postTo', { room });
    }
    case 'add_review_note': {
      const task = need('task');
      return task && t('messenger.mcp.reviewNoteOn', { task });
    }
    default:
      return null;
  }
}

/** An MCP call's row words: an engine tool in Korean (with its key input when `withInput`), any other
 *  `server · tool`. Null: not an MCP call, or one its owner described (`desc` wins, as for Bash). */
function mcpText(
  item: Pick<ChatItem, 'toolName' | 'desc' | 'args'>,
  withInput: boolean,
): string | null {
  const mcp = item.desc?.trim() ? null : parseMcpTool(item.toolName);
  if (!mcp) return null;
  if (!isEngineServer(mcp.server))
    return t('messenger.mcp.other', { server: mcp.server || MCP_PREFIX, tool: mcp.tool });
  const key = `messenger.mcp.${mcp.tool}` as TranslationKey;
  const name = t(key);
  // An engine tool added later has no words yet: show it as another server's.
  if (name === key) return t('messenger.mcp.other', { server: mcp.server, tool: mcp.tool });
  return (withInput && engineDetail(mcp.tool, item.args)) || name;
}

/** The row's words without its input: what a run of the same tool folds under. */
export function toolRowName(
  item: Pick<ChatItem, 'toolName' | 'text' | 'desc' | 'args'>,
  context: EzContext = PLAIN_CONTEXT,
): string {
  const mcp = mcpText(item, false);
  return mcp ? `${MCP_EMOJI} ${mcp}` : toolLineLabel(item, context);
}

/** The collapsed label of a tool row (the one explanation of a tool or command: the board's job rows use it too). */
export function toolLineLabel(
  item: Pick<ChatItem, 'toolName' | 'text' | 'desc' | 'args'>,
  context: EzContext = PLAIN_CONTEXT,
): string {
  const mcp = mcpText(item, true);
  if (mcp) return `${MCP_EMOJI} ${mcp}`;
  const activity = describeActivity(
    { toolName: item.toolName, status: item.text, desc: item.desc },
    context,
  );
  return `${activity.emoji} ${activity.text}`;
}

/** A job's line: its own one-line description (`-d`) when it has one, else its command explained. */
export const jobLineLabel = (job: Pick<OfficeJob, 'cmd' | 'label'>, context?: EzContext): string =>
  toolLineLabel(
    { toolName: 'Bash', text: `Running: ${job.cmd}`, desc: job.label ?? undefined },
    context,
  );
