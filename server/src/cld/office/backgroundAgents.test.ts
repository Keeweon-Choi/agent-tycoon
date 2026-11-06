import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { liveBackgroundAgents } from './backgroundAgents.js';

const launched = (id: string) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: x' }] }] },
  });
const done = (id: string) =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification><tool-use-id>${id}</tool-use-id></task-notification>` });
const foreground = (id: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'the answer' }] } });

describe('K1 (G6): background sub-agents a transcript says still run', () => {
  it('a launch without its completion runs; a completed one and a foreground one do not', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-bg-')), 's.jsonl');
    fs.writeFileSync(file, [launched('t1'), launched('t2'), foreground('t3'), 'not json', done('t1')].join('\n') + '\n');
    expect(liveBackgroundAgents(file)).toEqual(['t2']);
    expect(liveBackgroundAgents(file, 60)).toEqual([]); // only the end is read: t2's launch is before it
    expect(liveBackgroundAgents(path.join(path.dirname(file), 'none.jsonl'))).toEqual([]);
  });
});
