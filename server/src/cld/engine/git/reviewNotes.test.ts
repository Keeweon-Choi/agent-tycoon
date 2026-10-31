import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatDiffComments } from '../../../../../core/src/cld/reviewFormat.js';
import { waitFor } from '../../waitKit.js';
import { RepoManager } from './repoManager.js';
import type { ReviewNote, ReviewSendDeps, ReviewSendInput } from './reviewNotes.js';
import { ReviewNotes, sendReview } from './reviewNotes.js';
import type { TempRepo } from './testRepo.js';
import { GIT_AVAILABLE, makeTempRepo } from './testRepo.js';

const dirs: string[] = [];
const repos: TempRepo[] = [];
const managers: RepoManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ReviewNotes', () => {
  it('adds, lists, edits sent notes back to unsent, deletes, and writes atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-review-notes-'));
    dirs.push(dir);
    let id = 0;
    let now = 0;
    const file = path.join(dir, 'review-notes.json');
    const notes = new ReviewNotes(file, {
      newId: () => `note-${++id}`,
      now: () => new Date(`2026-11-01T00:00:0${now++}.000Z`),
    });
    const added = notes.add('alpha', 'task-1', { file: 'a.txt', side: 'new', line: 4, body: 'token=secret\r\nlook here' }, 'gui:phone', 'a'.repeat(40));
    expect(added).toMatchObject({ id: 'note-1', line: 4, body: 'token=***\nlook here', by: 'gui:phone' });
    expect(notes.list('alpha', 'task-1')).toEqual([added]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['review-notes.json']);

    notes.markSent('alpha', 'task-1', [added]);
    expect(notes.list('alpha', 'task-1')[0].sentAt).toBeDefined();
    const edited = notes.edit('alpha', 'task-1', added.id, 'changed', 'b'.repeat(40));
    expect(edited).toMatchObject({ body: 'changed', diffIdentity: 'b'.repeat(40), updatedAt: '2026-11-01T00:00:02.000Z' });
    expect(edited.sentAt).toBeUndefined();

    notes.delete('alpha', 'task-1', added.id);
    expect(notes.list('alpha', 'task-1')).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ v: 1, notes: {} });
  });

  it('leaves an unreadable document untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-review-notes-'));
    dirs.push(dir);
    const file = path.join(dir, 'review-notes.json');
    fs.writeFileSync(file, '{{broken');
    const notes = new ReviewNotes(file);
    expect(() => notes.list('alpha', 'task-1')).toThrow('검토 메모를 읽거나 저장하지 못했어요');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{{broken');
  });
});

describe.skipIf(!GIT_AVAILABLE)('review note handlers', () => {
  it('validates changed files, broadcasts notes, and marks a changed anchor stale', async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const project = { name: 'alpha', folder: repo.folder };
    const manager = new RepoManager({
      projects: () => [project],
      readOnly: false,
      configDir: path.join(repo.root, 'config'),
      run: repo.run,
      log: () => undefined,
    });
    managers.push(manager);
    const worktree = await manager.worktrees.createForTask(project, { taskId: 'T-1', slug: 'review', createdBy: 'user' });
    fs.writeFileSync(path.join(worktree.path, 'a.txt'), 'changed\n');
    const sent: Array<Record<string, unknown>> = [];
    const send = (message: Record<string, unknown>) => void sent.push(message);
    let request = 0;
    const ask = async (message: Record<string, unknown>) => {
      const requestId = `q${++request}`;
      manager.onClientMessage({ ...message, requestId }, send, true, 'gui:test');
      await waitFor(() => expect(sent.find((item) => item.requestId === requestId)).toBeTruthy());
      return sent.find((item) => item.requestId === requestId)!;
    };

    expect(await ask({ type: 'reviewNotesRequest', project: 'alpha', task: worktree.task })).toMatchObject({ ok: true, notes: [] });
    const added = await ask({
      type: 'reviewNoteWrite',
      project: 'alpha',
      task: worktree.task,
      op: 'add',
      file: 'a.txt',
      side: 'new',
      line: 1,
      body: 'please revise',
    });
    expect(added).toMatchObject({ type: 'reviewNoteResult', ok: true });
    await waitFor(() => expect(sent.find((item) => item.type === 'reviewNotes' && !('requestId' in item) && (item.notes as unknown[]).length === 1)).toBeTruthy());

    const bad = await ask({
      type: 'reviewNoteWrite',
      project: 'alpha',
      task: worktree.task,
      op: 'add',
      file: 'not-changed.txt',
      side: 'new',
      line: 1,
      body: 'nope',
    });
    expect(bad).toMatchObject({ type: 'reviewNoteResult', ok: false });

    fs.writeFileSync(path.join(worktree.path, 'a.txt'), 'changed again\n');
    const listed = await ask({ type: 'reviewNotesRequest', project: 'alpha', task: worktree.task });
    expect(listed).toMatchObject({ ok: true, notes: [expect.objectContaining({ stale: true })] });
  });

  it('drops note reads and writes from an unprivileged client', async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const project = { name: 'alpha', folder: repo.folder };
    const manager = new RepoManager({ projects: () => [project], readOnly: false, configDir: path.join(repo.root, 'config'), run: repo.run, log: () => undefined });
    managers.push(manager);
    const worktree = await manager.worktrees.createForTask(project, { taskId: 'T-1', slug: 'review', createdBy: 'user' });
    fs.writeFileSync(path.join(worktree.path, 'a.txt'), 'changed\n');
    const sent: Array<Record<string, unknown>> = [];
    const send = (message: Record<string, unknown>) => void sent.push(message);
    // A valid note from an unprivileged client: nothing is stored and nothing answers.
    const note = { project: 'alpha', task: worktree.task, op: 'add', file: 'a.txt', side: 'new', line: 1, body: 'x' };
    expect(manager.onClientMessage({ type: 'reviewNotesRequest', requestId: 'r', project: 'alpha', task: worktree.task }, send, false)).toBe(true);
    expect(manager.onClientMessage({ type: 'reviewNoteWrite', requestId: 'w', ...note }, send, false)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toEqual([]);
    // The same request from a privileged client finds no note.
    manager.onClientMessage({ type: 'reviewNotesRequest', requestId: 'p', project: 'alpha', task: worktree.task }, send, true);
    await waitFor(() => expect(sent.find((item) => item.requestId === 'p')).toMatchObject({ ok: true, notes: [] }));
  });
});

const note = (over: Partial<ReviewNote> = {}): ReviewNote => ({
  id: 'n1',
  file: 'src/a.ts',
  side: 'new',
  line: 3,
  body: 'rename this',
  createdAt: '2026-11-01T00:00:00.000Z',
  diffIdentity: 'a'.repeat(40),
  by: 'gui:pc',
  ...over,
});

function fakeDeps(over: Partial<ReviewSendDeps> = {}) {
  const sends: Array<{ to: string; text: string; source: string }> = [];
  const statuses: Array<[string, string, string]> = [];
  const lines: Array<[string, string, string]> = [];
  const tasks: Record<string, { status: string; assignee?: { assignmentId: string; name: string } }> = {
    'T-1': { status: 'review', assignee: { assignmentId: 'as-w', name: 'old-name' } },
  };
  const deps: ReviewSendDeps = {
    send: async (r) => {
      sends.push(r);
      return { ok: true, delivered: 'queued' };
    },
    names: () => ['shop', 'web-worker'],
    nameOf: (id) => (id === 'as-w' ? 'web-worker' : undefined),
    leadOf: (name) => (name === 'web-worker' ? 'shop' : undefined),
    task: (id) => tasks[id],
    setStatus: (id, status, by) => void statuses.push([id, status, by]),
    leadLine: (lead, task, text) => void lines.push([lead, task, text]),
    ...over,
  };
  return { deps, sends, statuses, lines, tasks };
}

describe('formatDiffComments (Orca port)', () => {
  it('pins the per-note format and its escaping', () => {
    expect(
      formatDiffComments([
        { file: 'a.ts', line: 4, body: 'say "hi"\\now\r\nnext' },
        { file: 'b.ts', line: 9, startLine: 7, body: 'range' },
        { file: 'c.ts', line: 5, startLine: 5, body: 'one' },
        { file: 'd.ts', line: 0, body: 'whole file' },
      ]),
    ).toBe(
      [
        'File: a.ts\nLine: 4\nUser comment: "say \\"hi\\"\\\\now\\r\\nnext"',
        'File: b.ts\nLines: 7-9\nUser comment: "range"',
        'File: c.ts\nLine: 5\nUser comment: "one"',
        'File: d.ts\nScope: file\nUser comment: "whole file"',
      ].join('\n\n'),
    );
  });
});

describe('sendReview', () => {
  const input = (over: Partial<ReviewSendInput> = {}): ReviewSendInput => ({
    project: 'shop',
    worktree: 't-1-cart',
    taskId: 'T-1',
    assignmentId: 'as-w',
    notes: [note(), note({ id: 'n2', line: 0, body: 'file note' }), note({ id: 'n3', body: 'already sent', sentAt: '2026-11-01T00:00:01.000Z' })],
    source: 'gui:pc',
    ...over,
  });

  it('sends the unsent notes as one boss message to the worker, moves review to doing, tells the Lead', async () => {
    const f = fakeDeps();
    const out = await sendReview(f.deps, input());
    expect(out).toMatchObject({ ok: true, to: 'web-worker', delivered: 'queued', moved: true });
    expect(out.ok && out.sent.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ to: 'web-worker', source: 'gui:pc', from: null, ifIdle: false });
    expect(f.sends[0].text.split('\n')[0]).toContain('T-1');
    expect(f.sends[0].text).toContain('File: src/a.ts\nLine: 3\nUser comment: "rename this"');
    expect(f.sends[0].text).toContain('Scope: file');
    expect(f.sends[0].text).not.toContain('already sent');
    expect(f.statuses).toEqual([['T-1', 'doing', 'gui:pc']]);
    expect(f.lines).toEqual([['shop', 'T-1', '사장님이 web-worker 에게 검토 의견 2개를 보냈어요 (Task T-1)']]);
  });

  it("falls back to the Task's assignee, then the Lead; no Lead line when the Lead is the target", async () => {
    const f = fakeDeps();
    expect(await sendReview(f.deps, input({ assignmentId: undefined }))).toMatchObject({ ok: true, to: 'web-worker' });
    const g = fakeDeps({ names: () => ['shop'] });
    expect(await sendReview(g.deps, input())).toMatchObject({ ok: true, to: 'shop' });
    expect(g.lines).toEqual([]);
  });

  it('leaves the status alone unless the Task is in review, and refuses with nobody to send to', async () => {
    const f = fakeDeps();
    f.tasks['T-1'].status = 'doing';
    expect(await sendReview(f.deps, input())).toMatchObject({ ok: true, moved: false });
    expect(f.statuses).toEqual([]);
    const g = fakeDeps({ names: () => [] });
    expect(await sendReview(g.deps, input())).toMatchObject({ ok: false, errorCode: 'review_no_target' });
    expect(await sendReview(g.deps, input({ notes: [note({ sentAt: '2026-11-01T00:00:01.000Z' })] }))).toMatchObject({
      ok: false,
      errorCode: 'review_nothing_to_send',
    });
  });

  it('changes nothing when the queue refuses', async () => {
    const f = fakeDeps({ send: async () => ({ ok: false, error: 'too long', errorCode: 'message_too_long' }) });
    expect(await sendReview(f.deps, input())).toMatchObject({ ok: false, errorCode: 'message_too_long' });
    expect(f.statuses).toEqual([]);
    expect(f.lines).toEqual([]);
  });
});

describe.skipIf(!GIT_AVAILABLE)('reviewSend handler', () => {
  async function setup(privileged = true, refuse = false) {
    const repo = makeTempRepo();
    repos.push(repo);
    const project = { name: 'alpha', folder: repo.folder };
    const f = fakeDeps({
      names: () => ['alpha', 'web-worker'],
      leadOf: () => 'alpha',
      ...(refuse && { send: async () => ({ ok: false as const, error: 'queue full', errorCode: 'queue_write_failed' }) }),
    });
    const manager = new RepoManager({
      projects: () => [project],
      readOnly: false,
      configDir: path.join(repo.root, 'config'),
      run: repo.run,
      log: () => undefined,
      reviewSend: (i) => sendReview(f.deps, i),
    });
    managers.push(manager);
    const worktree = await manager.worktrees.createForTask(project, { taskId: 'T-1', slug: 'review', createdBy: 'user', assignmentId: 'as-w' });
    fs.writeFileSync(path.join(worktree.path, 'a.txt'), 'changed\n');
    manager.reviewNotes.add('alpha', worktree.task, { file: 'a.txt', side: 'new', line: 1, body: 'one' }, 'gui:pc', 'a'.repeat(40));
    manager.reviewNotes.add('alpha', worktree.task, { file: 'a.txt', side: 'new', line: 1, body: 'two' }, 'gui:pc', 'a'.repeat(40));
    const sent: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => void sent.push(m);
    manager.onClientMessage({ type: 'reviewSend', requestId: 's1', project: 'alpha', task: worktree.task }, send, privileged, 'gui:pc');
    return { manager, worktree, sent, f };
  }

  it('queues the notes to the worker and marks them sent', async () => {
    const { manager, worktree, sent, f } = await setup();
    await waitFor(() => expect(sent.find((m) => m.requestId === 's1')).toMatchObject({ type: 'reviewSendResult', ok: true, to: 'web-worker', count: 2, delivered: 'queued', moved: true }));
    expect(f.sends.map((s) => s.to)).toEqual(['web-worker']);
    expect(manager.reviewNotes.list('alpha', worktree.task).every((n) => n.sentAt)).toBe(true);
    expect(f.lines).toEqual([['alpha', 'T-1', '사장님이 web-worker 에게 검토 의견 2개를 보냈어요 (Task T-1)']]);
  });

  it('keeps the notes unsent when the queue refuses', async () => {
    const { manager, worktree, sent } = await setup(true, true);
    await waitFor(() => expect(sent.find((m) => m.requestId === 's1')).toMatchObject({ ok: false, error: 'queue full' }));
    expect(manager.reviewNotes.list('alpha', worktree.task).some((n) => n.sentAt)).toBe(false);
  });

  it('marks only what the message carried: an earlier send keeps its time, an edit on the way stays unsent, a double click sends once', async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const project = { name: 'alpha', folder: repo.folder };
    let release: () => void = () => undefined;
    const f = fakeDeps({
      names: () => ['alpha', 'web-worker'],
      leadOf: () => 'alpha',
      send: async (r) => {
        f.sends.push(r);
        await new Promise<void>((resolve) => (release = resolve)); // the queue is typing
        return { ok: true, delivered: 'pane' };
      },
    });
    const manager = new RepoManager({ projects: () => [project], readOnly: false, configDir: path.join(repo.root, 'config'), run: repo.run, log: () => undefined, reviewSend: (i) => sendReview(f.deps, i) });
    managers.push(manager);
    const worktree = await manager.worktrees.createForTask(project, { taskId: 'T-1', slug: 'review', createdBy: 'user', assignmentId: 'as-w' });
    fs.writeFileSync(path.join(worktree.path, 'a.txt'), 'changed\n');
    const add = (body: string) => manager.reviewNotes.add('alpha', worktree.task, { file: 'a.txt', side: 'new', line: 1, body }, 'gui:pc', 'a'.repeat(40));
    const old = add('old');
    manager.reviewNotes.markSent('alpha', worktree.task, [old]);
    const oldAt = manager.reviewNotes.list('alpha', worktree.task)[0].sentAt;
    const kept = add('kept');
    const edited = add('first words');
    const sent: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => void sent.push(m);
    manager.onClientMessage({ type: 'reviewSend', requestId: 's1', project: 'alpha', task: worktree.task }, send, true, 'gui:pc');
    await waitFor(() => expect(f.sends).toHaveLength(1));
    manager.onClientMessage({ type: 'reviewSend', requestId: 's2', project: 'alpha', task: worktree.task }, send, true, 'gui:pc');
    await waitFor(() => expect(sent.find((m) => m.requestId === 's2')).toMatchObject({ ok: false, errorCode: 'project_busy' }));
    manager.reviewNotes.edit('alpha', worktree.task, edited.id, 'second words', 'a'.repeat(40));
    release();
    await waitFor(() => expect(sent.find((m) => m.requestId === 's1')).toMatchObject({ ok: true, count: 2 }));
    expect(f.sends).toHaveLength(1);
    const after = new Map(manager.reviewNotes.list('alpha', worktree.task).map((n) => [n.id, n]));
    expect(after.get(old.id)?.sentAt).toBe(oldAt);
    expect(after.get(kept.id)?.sentAt).toBeDefined();
    expect(after.get(edited.id)?.sentAt).toBeUndefined();
  });

  it('drops a send from an unprivileged client', async () => {
    const { manager, worktree, sent, f } = await setup(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toEqual([]);
    expect(f.sends).toEqual([]);
    expect(manager.reviewNotes.list('alpha', worktree.task).some((n) => n.sentAt)).toBe(false);
  });
});
