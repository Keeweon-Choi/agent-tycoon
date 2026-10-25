import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../agentRuntime.js';
import { AgentStateStore } from '../agentStateStore.js';
import { claudeProvider } from '../providers/hook/claude/claude.js';
import { CharacterBinder } from './characters.js';

let store: AgentStateStore;
let runtime: AgentRuntime;
let dir: string;
let messages: Array<Record<string, unknown>>;

beforeEach(() => {
  store = new AgentStateStore();
  runtime = new AgentRuntime(store, claudeProvider);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-chars-'));
  messages = [];
  store.on('broadcast', (m) => messages.push(m));
});
afterEach(() => {
  vi.useRealTimers();
  runtime.dispose();
});

const transcript = (name: string, content = '') => {
  const p = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(p, content);
  return p;
};

describe('character binder', () => {
  it('keeps one agent per key across refreshes, labeled with the name', () => {
    const b = new CharacterBinder(runtime, store);
    const t = transcript('s1');
    b.reconcile([
      { key: 'engine:alpha', label: 'alpha', transcript: t },
      { key: 'engine:gamma', label: 'gamma', transcript: null },
    ]);
    const alpha = b.idOf('engine:alpha')!;
    const gamma = b.idOf('engine:gamma')!;
    b.reconcile([
      { key: 'engine:gamma', label: 'gamma', transcript: null },
      { key: 'engine:alpha', label: 'alpha', transcript: t },
    ]);
    expect([b.idOf('engine:alpha'), b.idOf('engine:gamma')]).toEqual([alpha, gamma]);
    expect(store.size).toBe(2);
    expect(store.get(alpha)).toMatchObject({
      directoryName: 'alpha',
      jsonlFile: t,
      isExternal: false,
    });
    expect(store.get(gamma)).toMatchObject({ directoryName: 'gamma', jsonlFile: '' });
    expect(runtime.pollingTimers.has(alpha)).toBe(true);
    expect(runtime.pollingTimers.has(gamma)).toBe(false);
    expect(b.keyOf(alpha)).toBe('engine:alpha');
  });

  it('re-binds the same agent to a new session, and unbinds when it goes off', () => {
    const b = new CharacterBinder(runtime, store);
    const old = transcript('old', '{"type":"user"}\n');
    b.reconcile([{ key: 'k', label: 'alpha', transcript: old }]);
    const id = b.idOf('k')!;
    expect(store.get(id)!.fileOffset).toBe(fs.statSync(old).size); // history not replayed
    const renewed = transcript('new');
    b.reconcile([{ key: 'k', label: 'alpha', transcript: renewed }]);
    expect(b.idOf('k')).toBe(id);
    expect(store.get(id)).toMatchObject({ jsonlFile: renewed, sessionId: 'new' });
    expect(runtime.knownJsonlFiles.has(renewed)).toBe(true);
    b.reconcile([{ key: 'k', label: 'alpha', transcript: null }]);
    expect(store.get(id)).toMatchObject({ jsonlFile: '', sessionId: 'cld:k' });
    expect(runtime.pollingTimers.has(id)).toBe(false);
    expect(messages.some((m) => m.type === 'agentToolsClear' && m.id === id)).toBe(true);
  });

  it('a bound transcript animates its agent through the upstream parser', async () => {
    const b = new CharacterBinder(runtime, store);
    const t = transcript('live');
    b.reconcile([{ key: 'k', label: 'alpha', transcript: t }]);
    const id = b.idOf('k')!;
    fs.appendFileSync(
      t,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/a.ts' } }],
        },
      }) + '\n',
    );
    await vi.waitFor(
      () => expect(messages.some((m) => m.type === 'agentToolStart' && m.id === id)).toBe(true),
      {
        timeout: 3000,
      },
    );
  });

  it('removes vanished characters (after a grace period for contractors)', () => {
    vi.useFakeTimers();
    const people = new CharacterBinder(runtime, store);
    const contractors = new CharacterBinder(runtime, store, 5000);
    people.reconcile([{ key: 'a', label: 'a', transcript: null }]);
    contractors.reconcile([{ key: 'codex:1', label: 'codex·a', transcript: null }]);
    const c = contractors.idOf('codex:1')!;
    people.reconcile([]);
    contractors.reconcile([]);
    expect(people.idOf('a')).toBeNull();
    expect(store.has(c)).toBe(true);
    vi.advanceTimersByTime(5001);
    expect(store.has(c)).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([]));
  });

  it('a contractor that comes back within the grace period keeps its agent', () => {
    vi.useFakeTimers();
    const contractors = new CharacterBinder(runtime, store, 5000);
    contractors.reconcile([{ key: 'codex:1', label: 'codex·a', transcript: null }]);
    const c = contractors.idOf('codex:1');
    contractors.reconcile([]);
    vi.advanceTimersByTime(2000);
    contractors.reconcile([{ key: 'codex:1', label: 'codex·a', transcript: null }]);
    vi.advanceTimersByTime(10_000);
    expect(contractors.idOf('codex:1')).toBe(c);
  });
});
