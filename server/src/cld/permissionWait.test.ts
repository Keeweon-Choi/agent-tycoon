import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dialogCard,
  openToolCall,
  PermissionWaits,
  subjectCall,
  type WaitSubject,
} from './permissionWait.js';

const SUSPECT = 8_000;
const CHECK = 15_000;

function rig() {
  let dialog = new Set<number>();
  const log: string[] = [];
  const w = new PermissionWaits({
    isEngineLead: (id) => id === 1 || id === 2,
    exempt: new Set(['Agent', 'Task', 'AskUserQuestion']),
    check: () => Promise.resolve(new Set(dialog)),
    started: (id, s: WaitSubject | null, again) =>
      log.push(
        `${again ? 'again' : 'start'} ${id} ${s ? `${s.parentToolId ?? ''}/${s.toolId}` : '-'}`,
      ),
    cleared: (id) => log.push(`clear ${id}`),
    suspectMs: SUSPECT,
    checkMs: CHECK,
  });
  return { w, log, setDialog: (ids: number[]) => (dialog = new Set(ids)) };
}

const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('PermissionWaits (PERM-PROMPT)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('no checks while nothing is suspected: quick tools, exempt tools, other characters', async () => {
    const { w } = rig();
    w.observe({ type: 'agentToolStart', id: 1, toolId: 'a', toolName: 'Read' });
    await tick(SUSPECT - 1);
    w.observe({ type: 'agentToolDone', id: 1, toolId: 'a' });
    w.observe({ type: 'agentToolStart', id: 1, toolId: 'b', toolName: 'Agent' });
    w.observe({ type: 'agentToolStart', id: 7, toolId: 'c', toolName: 'Bash' });
    w.observe({ type: 'agentToolPermission', id: 7 });
    await tick(10 * CHECK);
    expect(w.checks).toBe(0);
  });

  it('trigger -> one check -> one notice; re-checked while it waits; clear -> no more checks', async () => {
    const { w, log, setDialog } = rig();
    setDialog([1]);
    w.observe({ type: 'agentToolStart', id: 1, toolId: 'bash1', toolName: 'Bash' });
    await tick(SUSPECT + 1);
    expect(w.checks).toBe(1);
    expect(log).toEqual(['start 1 /bash1']);
    // Still waiting: re-checked at the slow pace, no second notice.
    await tick(CHECK * 2);
    expect(w.checks).toBe(3);
    expect(log).toEqual(['start 1 /bash1']);
    // The dialog is gone: cleared once, then no checks at all.
    setDialog([]);
    await tick(CHECK);
    expect(log).toEqual(['start 1 /bash1', 'clear 1']);
    const n = w.checks;
    await tick(CHECK * 5);
    expect(w.checks).toBe(n);
  });

  it('a check that finds nothing ends the suspicion (no polling)', async () => {
    const { w, log } = rig();
    w.observe({ type: 'agentToolStart', id: 1, toolId: 'build', toolName: 'Bash' });
    await tick(SUSPECT + 1);
    expect(w.checks).toBe(1);
    await tick(CHECK * 5);
    expect(w.checks).toBe(1);
    expect(log).toEqual([]);
  });

  it("a sub-agent's call names the subject; a later dialog notifies again", async () => {
    const { w, log, setDialog } = rig();
    setDialog([1]);
    w.observe({ type: 'agentToolStart', id: 1, toolId: 'lead', toolName: 'Bash' });
    w.observe({
      type: 'subagentToolStart',
      id: 1,
      parentToolId: 'spawn',
      toolId: 'sub1',
      status: 'x',
    });
    w.observe({ type: 'subagentToolPermission', id: 1, parentToolId: 'spawn' });
    await tick(0);
    expect(log).toEqual(['start 1 spawn/sub1']);
    w.observe({ type: 'subagentToolDone', id: 1, parentToolId: 'spawn', toolId: 'sub1' });
    setDialog([]);
    await tick(CHECK);
    expect(log.at(-1)).toBe('clear 1');
    // A new dialog: a new episode, a new notice.
    setDialog([1]);
    w.observe({ type: 'agentToolPermission', id: 1 });
    await tick(CHECK);
    expect(log.at(-1)).toBe('start 1 /lead');
    expect(log.filter((l) => l.startsWith('start'))).toHaveLength(2);
  });

  it('answered from the messenger: cleared at once, a dialog still there is a new notice', async () => {
    const { w, log, setDialog } = rig();
    setDialog([2]);
    w.suspect(2);
    await tick(0);
    expect(log).toEqual(['start 2 -']);
    w.answered(2);
    expect(log).toEqual(['start 2 -', 'clear 2']);
    await tick(CHECK);
    expect(log).toEqual(['start 2 -', 'clear 2', 'start 2 -']);
  });

  it('a wait found before its call was read gets the call as soon as it opens (no second notice)', async () => {
    const { w, log, setDialog } = rig();
    setDialog([1]);
    w.suspect(1); // a held message
    await tick(1);
    w.observe({ type: 'agentToolStart', id: 1, toolId: 'late', toolName: 'Bash' });
    expect(log).toEqual(['start 1 -', 'again 1 /late']);
  });

  it("names the asker's NEWEST open call: an older one still open is done, its result unread (10-25 01:56)", async () => {
    const { w, log, setDialog } = rig();
    setDialog([1]);
    w.observe({ type: 'agentToolStart', id: 1, toolId: 'leadLong', toolName: 'Bash' });
    w.observe({ type: 'subagentToolStart', id: 1, parentToolId: 'spawn', toolId: 'python3', status: 'x' });
    await tick(1_000);
    // The python3 call finished (its result not read yet); the next call raised the dialog.
    w.observe({ type: 'subagentToolStart', id: 1, parentToolId: 'spawn', toolId: 'rmCall', status: 'x' });
    w.observe({ type: 'subagentToolStart', id: 1, parentToolId: 'other', toolId: 'otherCall', status: 'x' });
    // The older call's long-open timer is the first trigger: it names the asker, not the call.
    await tick(SUSPECT);
    expect(log).toEqual(['start 1 spawn/rmCall']);
  });

  it('throttled: many triggers, at most one check per interval', async () => {
    const { w } = rig();
    for (let i = 0; i < 10; i++) w.suspect(1);
    await tick(0);
    for (let i = 0; i < 10; i++) w.suspect(2);
    await tick(CHECK - 1);
    expect(w.checks).toBe(1);
    await tick(1);
    expect(w.checks).toBe(2);
  });
});

describe('openToolCall', () => {
  it("reads the call's tool, description or first command line, and what its dialog must show", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-perm-'));
    try {
      const lead = path.join(dir, 'sess.jsonl');
      const use = (id: string, input: Record<string, unknown>) =>
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] },
        });
      fs.writeFileSync(
        lead,
        [
          use('t1', { command: 'rm -f $M/*\necho done', description: 'Clean the marks' }),
          use('t2', { command: 'ls -la\npwd' }),
        ].join('\n') + '\n',
      );
      expect(openToolCall(lead, 't1')).toEqual({
        tool: 'Bash',
        detail: 'Clean the marks',
        match: ['Clean the marks', 'rm -f $M/*\necho done'],
      });
      expect(openToolCall(lead, 't2')).toEqual({
        tool: 'Bash',
        detail: 'ls -la',
        match: ['ls -la\npwd'],
      });
      expect(openToolCall(lead, 'nope')).toBeNull();
      // A sub-agent's own transcript, found by its sidecar.
      const subs = path.join(dir, 'sess', 'subagents');
      fs.mkdirSync(subs, { recursive: true });
      fs.writeFileSync(
        path.join(subs, 'agent-a.meta.json'),
        JSON.stringify({ toolUseId: 'spawn' }),
      );
      fs.writeFileSync(
        path.join(subs, 'agent-a.jsonl'),
        `${use('s1', { command: 'git log -5' })}\n`,
      );
      expect(subjectCall(lead, { parentToolId: 'spawn', toolId: 's1' })).toMatchObject({
        detail: 'git log -5',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dialogCard', () => {
  it('a long dialog is shown whole: the card never hides the end of what Allow approves', () => {
    const body = Array.from({ length: 30 }, (_, i) => `   echo line ${i} ${'x'.repeat(60)}`);
    const dialog = [' Bash command', ...body, '   rm -rf "$DIR"/*', '', ' Do you want to proceed?'].join('\n');
    expect(dialogCard(dialog).detail).toContain('rm -rf "$DIR"/*');
  });
  it("the screen's dialog as a card: its title, then its words without rules, blanks and the question", () => {
    const dialog = [
      ' Bash command · from the general-purpose agent',
      ' Run shell command',
      '',
      '   cd /work && rm -f cld/artifacts/x/*',
      ' ╌╌╌╌╌╌',
      ' Dangerous rm operation on statically-unresolvable target: /work/cld/artifacts/x/*',
      '',
      ' Do you want to proceed?',
    ].join('\n');
    expect(dialogCard(dialog)).toEqual({
      tool: 'Bash command · from the general-purpose agent',
      detail:
        'Run shell command\ncd /work && rm -f cld/artifacts/x/*\nDangerous rm operation on statically-unresolvable target: /work/cld/artifacts/x/*',
    });
  });
});
