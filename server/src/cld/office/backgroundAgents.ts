/**
 * K1 (G6): the background sub-agents a transcript says still run: an Agent spawn whose result is
 * "Async agent launched successfully." with no completion (`queue-operation` enqueue naming its
 * tool use) after it. The office follows an engine agent's transcript from where it was when it
 * bound it (CharacterBinder), so after a daemon restart it knows none of the spawns before: a
 * renew asks this once per binding before it trusts the live count.
 */
import * as fs from 'fs';

import { BACKGROUND_SCAN_BYTES } from '../../constants.js';
import { isAsyncAgentResult } from '../../transcriptParser.js';

const COMPLETED = /<tool-use-id>(.*?)<\/tool-use-id>/;

/** The tool use ids of the spawns still running, by the last `max` bytes of `file` ([] if unreadable). */
export function liveBackgroundAgents(file: string, max = BACKGROUND_SCAN_BYTES): string[] {
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
    if (!line.includes('Async agent launched') && !line.includes('<tool-use-id>')) continue;
    let rec: { type?: unknown; operation?: unknown; content?: unknown; message?: { content?: unknown } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue; // malformed: ignored
    }
    if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && typeof rec.content === 'string') {
      const m = COMPLETED.exec(rec.content);
      if (m) live.delete(m[1]);
      continue;
    }
    const blocks = rec.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<Record<string, unknown>>)
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && isAsyncAgentResult(b)) live.add(b.tool_use_id);
  }
  return [...live];
}
