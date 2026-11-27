import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { readNewLines } from '../src/fileWatcher.js';

// B4.4: a multi-byte character across a 64 KB read must not turn into U+FFFD.
it('a UTF-8 character split by the 64 KB read cap arrives whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-read-'));
  const file = path.join(dir, 'sess.jsonl');
  const head = '{"type":"assistant","message":{"content":[{"type":"text","text":"';
  const said = 'x'.repeat(65_535 - head.length) + '한글?';
  fs.writeFileSync(file, `${head}${said}"}]}}\n`);
  expect(Buffer.byteLength(head + 'x'.repeat(65_535 - head.length))).toBe(65_535); // '한' spans 65535..65537
  const store = new AgentStateStore();
  store.set(1, createAgentState({ id: 1, sessionId: 'sess', isExternal: false, projectDir: dir, jsonlFile: file }));
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  try {
    readNewLines(1, store, timers, new Map());
    readNewLines(1, store, timers, new Map());
    expect(store.get(1)!.lastAssistantText).toBe(said);
  } finally {
    for (const t of timers.values()) clearTimeout(t);
  }
});
