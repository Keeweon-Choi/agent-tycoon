/**
 * PERM-PROMPT through the office: an engine session held by a permission dialog (the fake claude's
 * fake-perm-<id>) shows the lead's permission bubble and the messenger card naming the open call;
 * a read-only client cannot answer; the owner's 허용 presses "1" and the card goes. While someone
 * views the conversation the card is the dialog read off the screen. Fake claude, temp HOME (never
 * the real ~/.claude).
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../agentRuntime.js';
import { AgentStateStore } from '../agentStateStore.js';
import { claudeProvider } from '../providers/hook/claude/claude.js';
import { ChatManager } from './chat.js';
import type { Lead } from './conversations.js';
import { Office } from './office.js';
import { ClaudeSessions } from './providers/claudeProvider.js';
import type { AgentEntry } from './providers/types.js';
import { killFakeSessions, makeEngineHome, removeTestHome } from './testHome.js';

const saved = { HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
  // Assigned back on process.env itself (never a replaced copy): os.homedir() reads the real
  // environment, and a later test's spawns run in that folder.
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const toolUse = (id: string, input: Record<string, unknown>) =>
  `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] },
  })}\n`;

/** An office with the engine project `alpha` running in the fake claude. */
async function start() {
  const { home, claudePath } = makeEngineHome();
  process.env.HOME = home;
  process.env.XDG_RUNTIME_DIR = home;
  const store = new AgentStateStore();
  const runtime = new AgentRuntime(store, claudeProvider);
  const reads: string[] = [];
  const chat = new ChatManager({
    claudePath,
    env: { HOME: home },
    log: (l) => reads.push(l),
    typeTiming: { readyMs: 5_000 },
  });
  const office = new Office({
    runtime,
    store,
    readOnly: false,
    chat: true,
    claude: new ClaudeSessions(path.join(home, '.claude/sessions'), null),
    home,
    engineClaude: claudePath,
    typist: chat,
    defaultLayout: { tiles: [1], furniture: [] },
  });
  cleanup.push(() => {
    killFakeSessions(home);
    removeTestHome(home);
  });
  cleanup.push(() => {
    void chat.disposeAll();
    office.dispose();
    runtime.dispose();
  });
  await office.start();
  const broadcasts: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m) => broadcasts.push(m));
  const got: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => got.push(m);
  const folder = fs.mkdtempSync(path.join(home, 'alpha-'));
  office.onClientMessage(
    { type: 'engineAction', requestId: 'add', action: 'add', name: 'alpha', folder },
    send,
    true,
  );
  await vi.waitFor(() =>
    expect(got.find((m) => m.requestId === 'add')).toMatchObject({ ok: true }),
  );
  office.onClientMessage(
    { type: 'engineAction', requestId: 'go', action: 'start', name: 'alpha' },
    send,
    true,
  );
  await vi.waitFor(
    () => expect(got.find((m) => m.requestId === 'go')).toMatchObject({ ok: true }),
    15_000,
  );
  const inner = office as unknown as { entryOf(id: number): AgentEntry | null; leads(): Lead[] };
  const agentId = await vi.waitFor(() => {
    const id = office.officeState().orchestrators.find((o) => o.name === 'alpha')?.agentId;
    expect(id && inner.entryOf(id)?.bg?.id && inner.entryOf(id)?.transcript).toBeTruthy();
    return id!;
  }, 15_000);
  const entry = inner.entryOf(agentId)!;
  fs.mkdirSync(path.dirname(entry.transcript!), { recursive: true });
  const card = () => inner.leads().find((l) => l.agentId === agentId)?.permission;
  const answer = async (privileged: boolean, toolId: string) => {
    const requestId = `a${got.length}`;
    office.onClientMessage(
      { type: 'permissionAnswer', requestId, agentId, toolId, allow: true },
      send,
      privileged,
    );
    return vi.waitFor(() => {
      const r = got.find((m) => m.type === 'permissionAnswerResult' && m.requestId === requestId);
      expect(r).toBeDefined();
      return r!;
    }, 15_000);
  };
  const answers = () =>
    fs.existsSync(path.join(home, 'fake-claude-answers.log'))
      ? fs.readFileSync(path.join(home, 'fake-claude-answers.log'), 'utf-8')
      : '';
  const perm = path.join(home, `fake-perm-${entry.bg!.id}`);
  return {
    office,
    store,
    home,
    agentId,
    entry,
    send,
    broadcasts,
    card,
    answer,
    answers,
    perm,
    reads,
  };
}

describe('PERM-PROMPT through the office', () => {
  it('notifies, shows the card, refuses a read-only answer and answers for the owner', async () => {
    const t = await start();
    // The open call in the lead's transcript, and its dialog on the session's screen.
    fs.appendFileSync(
      t.entry.transcript!,
      toolUse('toolu_perm', { command: 'rm -f $M/*', description: 'Clean the marks' }),
    );
    fs.writeFileSync(t.perm, JSON.stringify({ desc: 'Clean the marks', command: 'rm -f $M/*' }));
    // The trigger: the call opens (and a heuristic permission signal for it).
    t.store.broadcast({
      type: 'agentToolStart',
      id: t.agentId,
      toolId: 'toolu_perm',
      status: 'Running',
      toolName: 'Bash',
    });
    t.store.broadcast({ type: 'agentToolPermission', id: t.agentId });
    await vi.waitFor(() => expect(t.card()).toBeDefined(), 10_000);
    // Nobody views the conversation: the transcript card, and no attach was spent reading the screen.
    expect(t.card()).toEqual({ toolId: 'toolu_perm', tool: 'Bash', detail: 'Clean the marks' });
    expect(t.reads.some((l) => l.startsWith('permission dialog in'))).toBe(false);
    // Our own notice: the lead's permission bubble (the push and the 🔐 notice ride on it).
    expect(
      t.broadcasts.filter((m) => m.type === 'agentToolPermission' && m.id === t.agentId),
    ).toHaveLength(2);
    // A read-only client: refused, nothing pressed.
    expect(await t.answer(false, 'toolu_perm')).toMatchObject({
      ok: false,
      errorCode: 'no_permission',
    });
    // A stale card (another call): nothing pressed.
    expect(await t.answer(true, 'toolu_other')).toMatchObject({ ok: true, result: 'gone' });
    expect(t.answers()).toBe('');
    // The owner: "1. Yes", the dialog goes, the card with it.
    expect(await t.answer(true, 'toolu_perm')).toMatchObject({ ok: true, result: 'answered' });
    expect(t.answers()).toContain('"answer":"yes"');
    expect(t.card()).toBeUndefined();
    expect(
      t.broadcasts.some((m) => m.type === 'agentToolPermissionClear' && m.id === t.agentId),
    ).toBe(true);
  }, 90_000);

  it('a screen card whose masking hid lines (an env-style block) offers no Allow: the owner never saw them', async () => {
    const t = await start();
    const command = 'SRC=/tmp/a\nOUT=/tmp/b\nTMP=/tmp/c\nDIR=/home/someone\nrm -rf "$DIR"/*';
    fs.writeFileSync(t.perm, JSON.stringify({ title: 'Bash command', desc: 'Clean up', command }));
    t.store.broadcast({ type: 'agentToolStart', id: t.agentId, toolId: 'toolu_x', status: 'Running', toolName: 'Bash' });
    t.store.broadcast({ type: 'agentToolPermission', id: t.agentId });
    await vi.waitFor(() => expect(t.card()).toBeDefined(), 10_000);
    t.office.onClientMessage({ type: 'chatView', agentId: t.agentId, on: true }, t.send, true);
    await vi.waitFor(() => expect(t.card()?.detail).toContain('rm -rf'), 15_000);
    expect(t.card()?.detail).not.toContain('DIR=/home/someone');
    expect(t.card()?.toolId).toBe('');
  }, 90_000);

  it('the live case (10-25 01:56): the newer call of the sub-agent, then the dialog read off the screen once while viewed', async () => {
    const t = await start();
    // A background sub-agent's own transcript (its sidecar names the spawn): an older python3 call
    // whose result is not read yet, and the newer call that raised the dialog.
    const subs = path.join(t.entry.transcript!.replace(/\.jsonl$/, ''), 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    fs.writeFileSync(
      path.join(subs, 'agent-a1.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_spawn' }),
    );
    const newer = 'cd /work/ui-audit && npm run -s build:webview && rm -f cld/artifacts/ui-audit/*';
    fs.writeFileSync(
      path.join(subs, 'agent-a1.jsonl'),
      toolUse('toolu_old', { command: "cd /work/ui-audit && python3 - <<'E'\nprint(1)\nE" }) +
        toolUse('toolu_new', { command: newer, description: 'Run shell command' }),
    );
    fs.writeFileSync(
      t.perm,
      JSON.stringify({
        title: 'Bash command · from the general-purpose agent',
        desc: 'Run shell command',
        command: newer,
      }),
    );
    for (const toolId of ['toolu_old', 'toolu_new'])
      t.store.broadcast({
        type: 'subagentToolStart',
        id: t.agentId,
        parentToolId: 'toolu_spawn',
        toolId,
        status: 'Running',
      });
    t.store.broadcast({
      type: 'subagentToolPermission',
      id: t.agentId,
      parentToolId: 'toolu_spawn',
    });
    // Nobody looks yet: the transcript card names the NEWER call, not the older python3 one.
    await vi.waitFor(() => expect(t.card()).toMatchObject({ toolId: 'toolu_new' }), 10_000);
    expect(t.card()?.detail).toBe('Run shell command');
    // The owner opens the conversation: the dialog itself, read off the screen once.
    t.office.onClientMessage({ type: 'chatView', agentId: t.agentId, on: true }, t.send, true);
    await vi.waitFor(() => expect(t.card()?.toolId).toMatch(/^screen:[0-9a-f]{16}$/), 15_000);
    const screen = t.card()!;
    expect(screen.tool).toBe('Bash command · from the general-purpose agent');
    expect(screen.detail).toContain('rm -f cld/artifacts/ui-audit/*');
    t.office.onClientMessage({ type: 'chatView', agentId: t.agentId, on: false }, t.send, true);
    t.office.onClientMessage({ type: 'chatView', agentId: t.agentId, on: true }, t.send, true);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.reads.filter((l) => l.startsWith('permission dialog in'))).toHaveLength(1);
    // The transcript card's id no longer answers: nothing pressed.
    expect(await t.answer(true, 'toolu_new')).toMatchObject({ result: 'gone' });
    expect(t.answers()).toBe('');
    // The dialog changed under the card (the next call's): nothing pressed, and the owner's press
    // reads the screen again, so the card becomes the dialog that is up now.
    const next = {
      title: 'Bash command · from the general-purpose agent',
      desc: 'Next',
      command: 'rm -f /work/next/*',
    };
    fs.writeFileSync(t.perm, JSON.stringify(next));
    expect(await t.answer(true, screen.toolId)).toMatchObject({ ok: true, result: 'otherDialog' });
    expect(t.answers()).toBe('');
    await vi.waitFor(() => expect(t.card()?.detail).toContain('rm -f /work/next/*'), 15_000);
    // 허용 on the screen card: exactly that dialog, "1. Yes".
    expect(await t.answer(true, t.card()!.toolId)).toMatchObject({ ok: true, result: 'answered' });
    expect(t.answers()).toContain('"answer":"yes"');
    expect(t.card()).toBeUndefined();
  }, 90_000);
});
