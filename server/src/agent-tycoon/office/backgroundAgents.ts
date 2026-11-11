/**
 * K1 (G6): the background sub-agents a transcript says still run. A spawn is an Agent tool result
 * "Async agent launched successfully."; it runs until a `queue-operation` enqueue notifies it:
 * by the tool use id it names, or by its `<task-id>` (the `agentId:` line of the launch result), which
 * is the only name a "stopped" notice has (the Lead's session was restarted under it). A SendMessage
 * result `"resumedAgentId":"<task id>"` runs the spawn again until its next notice, and that notice
 * names the SendMessage call, not the spawn, so only the task id pairs it. Which notice ends which
 * spawn (a waiting one ends none) is `endedSpawns`, shared with the live parser. The office follows an
 * engine agent's transcript from where it was when it bound it (CharacterBinder), so after a daemon
 * restart it knows none of the spawns before: a renew asks this once per binding before it trusts
 * the live count.
 */
import * as fs from 'fs';
import * as path from 'path';

import { BACKGROUND_SCAN_BYTES, BACKGROUND_WAITING_MAX_MS } from '../../constants.js';
import { endedSpawns, isAsyncAgentResult, launchTaskId } from '../../transcriptParser.js';
import type { AgentState } from '../../types.js';

/** The text items of a tool_result's content (a plain string or an array of text items). */
function textItems(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((i) => (typeof (i as { text?: unknown })?.text === 'string' ? [(i as { text: string }).text] : []));
}

/** The task id a SendMessage result resumed: only a result that is nothing but that JSON object counts. */
function resumedTask(content: unknown): string | undefined {
  for (const t of textItems(content)) {
    if (!t.includes('resumedAgentId')) continue;
    try {
      const o = JSON.parse(t.trim()) as { success?: unknown; resumedAgentId?: unknown } | null;
      if (o?.success === true && typeof o.resumedAgentId === 'string') return o.resumedAgentId;
    } catch {
      /* some other tool output: ignored */
    }
  }
  return undefined;
}

/** The tool use ids of the spawns still running, by the last `max` bytes of `file` ([] if unreadable).
 *  `spawnOf` (task id -> spawn tool id) is filled in, so the live parser pairs later notices too. */
export function liveBackgroundAgents(file: string, max = BACKGROUND_SCAN_BYTES, spawnOf = new Map<string, string>()): string[] {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - max);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf-8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // a cut first line
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const live = new Set<string>();
  for (const line of text.split('\n')) {
    if (!['Async agent launched', '<tool-use-id>', '<task-id>', 'resumedAgentId'].some((k) => line.includes(k))) continue;
    let rec: { type?: unknown; operation?: unknown; content?: unknown; message?: { content?: unknown } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue; // malformed: ignored
    }
    if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && typeof rec.content === 'string') {
      for (const id of endedSpawns(rec.content, live, spawnOf)) live.delete(id);
      continue;
    }
    const blocks = rec.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      if (isAsyncAgentResult(b)) {
        live.add(b.tool_use_id);
        const task = launchTaskId(b);
        if (task) spawnOf.set(task, b.tool_use_id);
        continue;
      }
      const resumed = resumedTask(b.content);
      if (!resumed) continue;
      // A resume whose launch is before the scan window runs under the SendMessage call's id:
      // its notices name that id or its task id, and both pair with it.
      if (!spawnOf.has(resumed)) spawnOf.set(resumed, b.tool_use_id);
      live.add(spawnOf.get(resumed)!);
    }
  }
  return [...live];
}

/** A Lead's sidecar entry (TeamProvider.discoverTeammates). */
interface Sidecar {
  jsonlPath: string;
  toolUseId?: string;
  description?: string;
  finished?: boolean;
}

/** K1 (G6): the live spawns a renew waits for, with their sidecar description: all of `a`'s but one
 *  whose sidecar is `finished` and whose own transcript has been quiet for BACKGROUND_WAITING_MAX_MS.
 *  An id with no sidecar is counted (unknown = running). The live set and the screen keep it. */
export function renewSubagents(a: AgentState, sidecars: Sidecar[], now = Date.now()): Array<{ id: string; description?: string }> {
  const taskOf = new Map([...(a.backgroundTaskIds ?? [])].map(([task, id]) => [id, task]));
  return [...a.backgroundAgentToolIds].flatMap((id) => {
    const task = taskOf.get(id);
    const s = sidecars.find((e) => e.toolUseId === id || (task !== undefined && path.basename(e.jsonlPath) === `agent-${task}.jsonl`));
    let quiet = 0;
    try {
      if (s?.finished) quiet = now - fs.statSync(s.jsonlPath).mtimeMs;
    } catch {
      /* no transcript: counted */
    }
    return quiet >= BACKGROUND_WAITING_MAX_MS ? [] : [{ id, description: s?.description }];
  });
}
