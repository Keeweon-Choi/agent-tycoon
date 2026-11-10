/**
 * U-48 phase 1 through the office: the agents' own lists reach a viewer under
 * their project, only a session inside a project folder counts, and nothing is
 * read or sent while nobody views.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import type { TrackedItems } from '../../../../core/src/messages.js';
import { startEngineOffice } from '../officeTestKit.js';

const procStart = (pid: number) => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};

describe.runIf(process.platform === 'linux')('tracked items through the office', () => {
  it('reaches a viewer for a session inside a project folder, never without one', async () => {
    const folder = '/work/alpha';
    const { home, office, messages } = await startEngineOffice({ projects: [{ name: 'alpha', folder }] });
    const sessions = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const live = (pid: number, sessionId: string, cwd: string, name: string) =>
      fs.writeFileSync(
        path.join(sessions, `${pid}.json`),
        JSON.stringify({ pid, sessionId, cwd, kind: 'interactive', name, status: 'busy', procStart: procStart(pid), startedAt: Date.now() }),
      );
    live(process.pid, 'sess-inside', `${folder}/sub`, 'inside');
    live(process.ppid, 'sess-outside', '/somewhere/else', 'outside');
    for (const sid of ['sess-inside', 'sess-outside']) {
      fs.mkdirSync(path.join(home, '.claude', 'tasks', sid), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.claude', 'tasks', sid, '1.json'),
        JSON.stringify({ id: '1', subject: `plan of ${sid} T-12`, status: 'in_progress', blockedBy: [] }),
      );
    }
    const tracking = (office as unknown as { tracking: { reads: number; snapshot(): TrackedItems[] } }).tracking;
    const tracked = () => messages.filter((m) => m.type === 'trackedItems') as unknown as TrackedItems[];

    await office.refreshClaude(); // nobody views
    expect(tracking.reads).toBe(0);
    expect(tracked()).toEqual([]);

    const viewer = vi.fn();
    office.onClientOpened(viewer);
    await vi.waitFor(() => expect(tracked().length).toBeGreaterThan(0));
    const last = tracked().at(-1)!;
    expect(last.project).toBe('alpha');
    expect(last.items.map((i) => [i.kind, i.title, i.status, i.source, i.taskId])).toEqual([
      ['session', 'inside', 'doing', 'observed', undefined],
      ['agentList', 'plan of sess-inside T-12', 'doing', 'reported', 'T-12'],
    ]);
    expect(JSON.stringify(tracked())).not.toContain('sess-outside');
    expect(JSON.stringify(tracked())).not.toContain(home);

    const ready: Array<Record<string, unknown>> = [];
    const second = (m: Record<string, unknown>) => ready.push(m);
    office.onClientReady(second);
    expect(ready.filter((m) => m.type === 'trackedItems')).toHaveLength(1);

    office.onClientClosed(second);
    office.onClientClosed(viewer); // the last viewer: nothing stays in memory
    expect(tracking.snapshot()).toEqual([]);
    const reads = tracking.reads;
    await office.refreshClaude();
    expect(tracking.reads).toBe(reads);
  });
});
