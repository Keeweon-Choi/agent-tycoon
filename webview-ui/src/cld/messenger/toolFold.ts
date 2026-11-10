import type { ChatItem } from '../../../../core/src/messages.js';
import { TOOL_RUN_MIN } from '../../constants.js';
import type { EzContext } from '../ez/activity.js';
import { parseMcpTool, toolRowName } from './toolLine.js';

/** What makes two tool rows "the same call": an MCP tool by its name, any other tool by its collapsed words
 *  (three Bash rows with their own descriptions stay three). Null: not a tool row. */
export function toolRunKey(item: ChatItem, context?: EzContext): string | null {
  if (item.kind !== 'tool') return null;
  return parseMcpTool(item.toolName) && !item.desc?.trim()
    ? `mcp:${item.toolName}`
    : `row:${toolRowName(item, context)}`;
}

export interface ToolRuns {
  /** First index of each run of TOOL_RUN_MIN or more rows -> the run's items (the first included). */
  heads: Map<number, ChatItem[]>;
  /** The indexes the head draws for them: every later item of a run. */
  hidden: Set<number>;
}

/** Consecutive rows of one tool as runs. A text message, a result, another tool or a `breaks(i)` (a divider
 *  or a record sits between item i - 1 and i) ends a run. */
export function toolRuns(
  items: readonly ChatItem[],
  breaks: (index: number) => boolean = () => false,
  context?: EzContext,
): ToolRuns {
  const heads = new Map<number, ChatItem[]>();
  const hidden = new Set<number>();
  let start = 0;
  for (let i = 1; i <= items.length; i++) {
    const key = toolRunKey(items[start], context);
    if (i < items.length && key !== null && !breaks(i) && toolRunKey(items[i], context) === key)
      continue;
    if (i - start >= TOOL_RUN_MIN) {
      heads.set(start, items.slice(start, i));
      for (let k = start + 1; k < i; k++) hidden.add(k);
    }
    start = i;
  }
  return { heads, hidden };
}
