/**
 * T-186: the messenger's list of conversations through the office. Every agent's row carries its
 * conversation's last message and its time, whether the agent runs, rests or is stopped, so the
 * list's order (newest last message first) holds for all of them. Fake records only: a test HOME,
 * the engine's registry written by hand, transcripts written by hand, a fake `claude agents`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessengerContact } from '../../../core/src/messages.js';
import { registryPath, saveRegistry } from './engine/registry.js';
import { RENEW_HISTORY_VERSION, renewHistoryPath } from './engine/renewals.js';
import { startEngineOffice } from './officeTestKit.js';
import { transcriptPath } from './providers/claudeProvider.js';
import { makeEngineHome, removeTestHome } from './testHome.js';

const WAIT = { timeout: 15_000, interval: 50 };
const at = (s: number) => new Date(Date.UTC(2026, 10, 27, 1, 0, s)).toISOString();
const line = (type: 'user' | 'assistant', text: string, s: number, uuid: string) =>
  `${JSON.stringify({
    type,
    uuid,
    timestamp: at(s),
    message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
  })}\n`;
const sid = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`;

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeTestHome(h);
});

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('T-186: the list of conversations', () => {
  it('a resting, a stopped and a renewed agent show their last message and time, and sort by it with a running one', async () => {
    const { home } = makeEngineHome();
    homes.push(home);
    const folder = (name: string) => {
      const dir = path.join(home, 'work', name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const resting = folder('resting');
    const stopped = folder('stopped');
    const renewed = folder('renewed');
    const quiet = folder('quiet');
    saveRegistry(registryPath(home), [
      // Idle-stopped (TERM-P1): it rests until a message wakes it.
      { name: 'resting', folder: resting, wantRunning: true, idleRetired: true, sessionId: sid(1) },
      { name: 'stopped', folder: stopped, wantRunning: false, sessionId: sid(2) },
      // Renewed (K1): the new conversation sid(4) continues sid(3); it is off now.
      { name: 'renewed', folder: renewed, wantRunning: false, sessionId: sid(4) },
      // Never talked to: no conversation at all.
      { name: 'quiet', folder: quiet, wantRunning: false },
    ]);
    write(transcriptPath(resting, sid(1), home), line('user', 'rest q', 1, 'u1') + line('assistant', 'rest a', 5, 'a1'));
    write(transcriptPath(stopped, sid(2), home), line('user', 'stop q', 2, 'u2') + line('assistant', 'stop a', 9, 'a2'));
    const old = transcriptPath(renewed, sid(3), home);
    write(old, line('user', 'old q', 0, 'u3') + line('assistant', 'old a', 1, 'a3'));
    write(transcriptPath(renewed, sid(4), home), line('user', 'new q', 6, 'u4') + line('assistant', 'new a', 7, 'a4'));
    fs.writeFileSync(
      renewHistoryPath(home),
      JSON.stringify({
        v: RENEW_HISTORY_VERSION,
        terms: [{ name: 'renewed', sessionId: sid(3), next: sid(4), transcript: old, bytes: fs.statSync(old).size, endedAt: Date.parse(at(2)) }],
      }),
    );
    // Running: a live Claude session of the fake `claude agents` (S-8's alpha-orchestrator).
    const t = await startEngineOffice({ home, claude: 'S-8', chat: true });
    write(
      path.join(home, '.claude/projects/-work-alpha/a0000001-0000-4000-8000-000000000001.jsonl'),
      line('user', 'run q', 3, 'u5') + line('assistant', 'run a', 4, 'a5'),
    );
    t.office.onClientOpened(() => undefined); // a viewer: the contacts are polled
    const names = ['stopped', 'renewed', 'resting', 'alpha-orchestrator', 'quiet'];
    const rows = () => {
      t.office.recompute();
      const all = (t.last('messengerContacts') as { contacts: MessengerContact[] } | undefined)?.contacts ?? [];
      return all.filter((c) => names.includes(c.name));
    };
    await vi.waitFor(() => expect(rows().find((c) => c.name === 'alpha-orchestrator')?.preview).toBe('run a'), WAIT);
    const byName = Object.fromEntries(rows().map((c) => [c.name, c]));
    expect(byName.stopped).toMatchObject({ preview: 'stop a', lastAt: Date.parse(at(9)) });
    expect(byName.renewed).toMatchObject({ preview: 'new a', lastAt: Date.parse(at(7)) });
    expect(byName.resting).toMatchObject({ preview: 'rest a', lastAt: Date.parse(at(5)) });
    expect(byName['alpha-orchestrator']).toMatchObject({ preview: 'run a', lastAt: Date.parse(at(4)) });
    expect(byName.quiet.preview).toBeUndefined();
    expect(byName.quiet.lastAt).toBeUndefined();
    // The list's order (messengerStore sortConversations): the newest last message first, none last.
    const order = [...rows()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).map((c) => c.name);
    expect(order).toEqual(names);
    t.stop();
  }, 30_000);

  it("another provider's session id is never read as a Claude transcript path (no way out of ~/.claude/projects)", async () => {
    const { home } = makeEngineHome();
    homes.push(home);
    const acp = path.join(home, 'work', 'acp');
    const claude = path.join(home, 'work', 'claude');
    for (const dir of [acp, claude]) fs.mkdirSync(dir, { recursive: true });
    saveRegistry(registryPath(home), [
      // ACP-1: another agent's session id only has to be printable: it may hold `../`.
      { name: 'acp', folder: acp, wantRunning: false, provider: 'opencode', sessionId: '../../../secret' },
      { name: 'claude', folder: claude, wantRunning: false, sessionId: sid(5) },
    ]);
    // Where the Claude path rule would lead `../../../secret`: outside ~/.claude/projects.
    const outside = transcriptPath(acp, '../../../secret', home);
    expect(path.relative(path.join(home, '.claude', 'projects'), outside).startsWith('..')).toBe(true);
    write(outside, line('user', 'secret q', 1, 'u6') + line('assistant', 'secret a', 2, 'a6'));
    write(transcriptPath(claude, sid(5), home), line('user', 'claude q', 3, 'u7') + line('assistant', 'claude a', 4, 'a7'));
    const t = await startEngineOffice({ home, chat: true });
    t.office.onClientOpened(() => undefined);
    const rows = () => {
      t.office.recompute();
      return (t.last('messengerContacts') as { contacts: MessengerContact[] } | undefined)?.contacts ?? [];
    };
    await vi.waitFor(() => expect(rows().find((c) => c.name === 'claude')).toMatchObject({ preview: 'claude a', lastAt: Date.parse(at(4)) }), WAIT);
    const row = rows().find((c) => c.name === 'acp');
    expect(row).toBeDefined();
    expect(row!.preview).toBeUndefined();
    expect(row!.lastAt).toBeUndefined();
    t.stop();
  }, 30_000);
});
