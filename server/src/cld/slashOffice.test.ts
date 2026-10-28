/**
 * `/` commands through the office for an engine project: who may ask for the
 * catalogue, what a chatSend naming a command is refused for, and that the
 * catalogue's refresh exists only while a conversation is open. Fixture
 * folders only (never the real ~/.claude).
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../agentRuntime.js';
import { AgentStateStore } from '../agentStateStore.js';
import { claudeProvider } from '../providers/hook/claude/claude.js';
import { Office } from './office.js';
import { ClaudeSessions } from './providers/claudeProvider.js';
import { killFakeSessions, makeEngineHome, removeTestHome } from './testHome.js';

const savedEnv = { ...process.env };
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
  process.env = { ...savedEnv };
});

async function start() {
  const { home, claudePath } = makeEngineHome();
  process.env.HOME = home;
  process.env.XDG_RUNTIME_DIR = home;
  cleanup.push(() => {
    killFakeSessions(home);
    removeTestHome(home);
  });
  const store = new AgentStateStore();
  const runtime = new AgentRuntime(store, claudeProvider);
  const office = new Office({
    runtime,
    store,
    readOnly: false,
    chat: true,
    claude: new ClaudeSessions(path.join(home, '.claude/sessions'), null),
    home,
    engineClaude: claudePath,
    defaultLayout: { tiles: [1], furniture: [] },
  });
  cleanup.push(() => {
    office.dispose();
    runtime.dispose();
  });
  await office.start();
  const got: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => got.push(m);
  const folder = fs.mkdtempSync(path.join(home, 'alpha-'));
  fs.mkdirSync(path.join(folder, '.claude/commands'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, '.claude/commands/ship.md'),
    '---\ndescription: 배포해요\n---\nSECRET-BODY',
  );
  // This suite is about refusing commands for an off session. Add through a
  // non-person engine path: office adds deliberately start immediately.
  expect(
    await office.engine!.run(
      { type: 'engineAction', requestId: 'add', action: 'add', name: 'alpha', folder },
      true,
      'test',
    ),
  ).toMatchObject({ type: 'engineActionResult', ok: true });
  const agentId = office.officeState().orchestrators.find((o) => o.name === 'alpha')!.agentId!;
  const chat = async (text: string, privileged = true) => {
    const requestId = `q${got.length}`;
    office.onClientMessage({ type: 'chatSend', requestId, name: 'alpha', text }, send, privileged);
    return vi.waitFor(() => {
      const r = got.find((m) => m.type === 'chatSendResult' && m.requestId === requestId);
      expect(r).toBeDefined();
      return r!;
    });
  };
  const catalogue = (privileged = true, requestId = `c${got.length}`) => {
    office.onClientMessage({ type: 'slashCommands', requestId, agentId }, send, privileged);
    return got.find((m) => m.type === 'slashCommandsList' && m.requestId === requestId)!;
  };
  const watchers = () =>
    (office as unknown as { slash: { watchers: Map<string, unknown> } }).slash.watchers.size;
  return { office, got, send, agentId, chat, catalogue, watchers, home };
}

describe('slash commands through the office (engine project)', () => {
  it('serves the catalogue to a privileged client only, with names and descriptions only', async () => {
    const t = await start();
    expect(t.catalogue(false)).toMatchObject({
      commands: [],
      error: '이 접속에는 조작 권한이 없어요',
    });
    const list = t.catalogue();
    const commands = list.commands as Array<{ name: string; source: string }>;
    expect(commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(['compact', 'clear', 'ship']),
    );
    expect(commands.find((c) => c.name === 'ship')).toMatchObject({
      source: 'project',
      description: '배포해요',
    });
    expect(JSON.stringify(list)).not.toContain('SECRET-BODY');
    expect(t.watchers()).toBe(1);
  });

  it('refuses a peer, an unknown, a multi-line, a too long and a stray-control command, in Korean', async () => {
    const t = await start();
    expect(await t.chat('/compact', false)).toMatchObject({
      ok: false,
      error: '이 접속에는 조작 권한이 없어요',
    });
    expect(await t.chat('/nope')).toMatchObject({ ok: false, error: '모르는 명령이에요' });
    expect(await t.chat('/compact\n두 번째 줄')).toMatchObject({
      ok: false,
      error: '여러 줄은 명령으로 보낼 수 없어요',
    });
    expect(await t.chat(`/compact ${'x'.repeat(500)}`)).toMatchObject({
      ok: false,
      error: '/ 명령은 500자까지만 보낼 수 있어요',
    });
    expect(await t.chat('/compact a\tb')).toMatchObject({ ok: false });
    expect(await t.chat('/compact \x1b[31m')).toMatchObject({ ok: false });
    expect(await t.chat('/model')).toMatchObject({ ok: false });
    // A valid command with its session off is refused, never left in the inbox.
    expect(await t.chat('/compact')).toMatchObject({
      ok: false,
      error: '/ 명령은 대화가 켜져 있을 때만 보낼 수 있어요',
    });
    expect(fs.existsSync(path.join(t.home, '.config/agent-tycoon/inbox/alpha'))).toBe(false);
  });

  it('nothing is watched once the conversation closes or the client leaves', async () => {
    const t = await start();
    t.catalogue();
    expect(t.watchers()).toBe(1);
    t.office.onClientMessage({ type: 'chatView', agentId: t.agentId, on: false }, t.send, true);
    expect(t.watchers()).toBe(0);
    t.catalogue();
    expect(t.watchers()).toBe(1);
    t.office.onClientClosed(t.send);
    expect(t.watchers()).toBe(0);
  });
});
