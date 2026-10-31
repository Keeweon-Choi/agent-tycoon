/**
 * P4 S1 (개발실): merge pre-check, sync / resolve / continue / abort, auto-cleanup, the cleanup
 * list, the Lead's review note and its merge lock, `fixed` and `since`, and the /ws gate.
 * Real git in temp repositories; nothing outside the temp dir.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleClientMessage } from '../../../clientMessageHandler.js';
import { startEngineOffice } from '../../officeTestKit.js';
import { waitFor } from '../../waitKit.js';
import { applyChoices, parseConflicts } from './conflicts.js';
import { RepoManager } from './repoManager.js';
import type { ReviewSendDeps } from './reviewNotes.js';
import { sendReview } from './reviewNotes.js';
import type { TempRepo } from './testRepo.js';
import { GIT_AVAILABLE, makeTempRepo } from './testRepo.js';

vi.setConfig({ testTimeout: 60_000 });

type Msg = Record<string, unknown>;
const repos: TempRepo[] = [];
const done: Array<() => void> = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const c of done.splice(0)) c();
  for (const r of repos.splice(0)) r.cleanup();
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

function setup() {
  const r = makeTempRepo();
  repos.push(r);
  const flags = { auto: true, busy: false };
  const delivered: Array<{ to: string; text: string; from: string | null }> = [];
  const leadLines: string[] = [];
  const deps: ReviewSendDeps = {
    send: async (q) => (delivered.push({ to: q.to, text: q.text, from: q.from }), { ok: true, delivered: 'pane' }),
    names: () => ['alpha', 'web-worker'],
    nameOf: (id) => (id === 'as-w' ? 'web-worker' : undefined),
    leadOf: () => 'alpha',
    task: () => undefined,
    setStatus: () => undefined,
    leadLine: (_lead, _task, text) => void leadLines.push(text),
  };
  const mgr = new RepoManager({
    projects: () => [{ name: 'alpha', folder: r.folder }],
    readOnly: false,
    configDir: path.join(r.root, 'config'),
    run: r.run,
    pollMs: 60_000,
    log: () => undefined,
    nameOf: deps.nameOf,
    reviewSend: (input) => sendReview(deps, input),
    agentBusy: () => flags.busy,
    autoCleanup: () => flags.auto,
  });
  done.push(() => mgr.dispose());
  const project = mgr.project('alpha')!;
  const sent: Msg[] = [];
  const send = (m: Msg) => void sent.push(m);
  let n = 0;
  const ask = async (msg: Msg) => {
    const requestId = `q${++n}`;
    expect(mgr.onClientMessage({ requestId, project: 'alpha', ...msg }, send, true)).toBe(true);
    await waitFor(() => expect(sent.find((m) => m.requestId === requestId)).toBeTruthy());
    return sent.find((m) => m.requestId === requestId)!;
  };
  const act = (action: string, extra: Msg = {}) => ask({ type: 'repoAction', action, ...extra });
  const sha = (ref: string, cwd?: string) => r.git(['rev-parse', ref], cwd).trim();
  const wtDir = (task: string) => path.join(r.folder, '.worktrees', task);
  /** Worktree `task` and main both change a.txt and sub/b.txt, differently: two conflicting files. */
  const conflicting = async (task: string) => {
    await mgr.worktrees.create(project, task, { assignmentId: 'as-w' });
    fs.writeFileSync(path.join(wtDir(task), 'a.txt'), 'mine\n');
    fs.writeFileSync(path.join(wtDir(task), 'sub/b.txt'), 'mine b\n');
    r.git(['commit', '-qam', 'task work'], wtDir(task));
    r.write('a.txt', 'theirs\n');
    r.write('sub/b.txt', 'theirs b\n');
    r.git(['commit', '-qam', 'main work']);
  };
  return { r, mgr, project, flags, delivered, leadLines, sent, send, ask, act, sha, wtDir, conflicting };
}

describe('conflict markers', () => {
  const text = ['top', '<<<<<<< HEAD', 'a1', 'a2', '=======', 'b1', '>>>>>>> main', 'mid', '<<<<<<< HEAD', '||||||| base', 'o', '=======', '>>>>>>> main', 'end'].join('\n');
  it('parses blocks (diff3 style too) and applies each choice', () => {
    expect(parseConflicts(text)).toEqual([
      { startLine: 2, endLine: 7, ours: 'a1\na2', theirs: 'b1' },
      { startLine: 9, endLine: 13, ours: '', theirs: '' },
    ]);
    expect(applyChoices(text, ['theirs', 'ours'])).toBe('top\nb1\nmid\nend');
    expect(applyChoices(text, ['both', 'keep'])).toBe(['top', 'a1', 'a2', 'b1', 'mid', ...text.split('\n').slice(8)].join('\n'));
    expect(applyChoices(text, ['ours'])).toBeNull(); // the block count changed
  });
});

describe.skipIf(!GIT_AVAILABLE)('dev room git (P4 S1)', () => {
  it('pre-check: conflicting files reported, a clean one clean, and no ref or folder moved', async () => {
    const { mgr, project, ask, sha, wtDir, conflicting, r } = setup();
    await conflicting('feat');
    await mgr.worktrees.create(project, 'side');
    fs.writeFileSync(path.join(wtDir('side'), 'new.txt'), 'n\n');
    r.git(['add', 'new.txt'], wtDir('side'));
    r.git(['commit', '-qm', 'side'], wtDir('side'));
    r.write('c.txt', 'c\n');
    r.git(['add', 'c.txt']);
    r.git(['commit', '-qm', 'more main']);
    const before = [sha('main'), sha('task/feat'), sha('task/side')];

    expect(await ask({ type: 'repoMergeCheck', task: 'feat' })).toMatchObject({
      ok: true, clean: false, conflicts: ['a.txt', 'sub/b.txt'], kind: 'merge', behind: 2, ahead: 1, target: 'main',
      subject: "Merge branch 'task/feat' into main",
    });
    expect(await ask({ type: 'repoMergeCheck', task: 'side' })).toMatchObject({ ok: true, clean: true, conflicts: [], kind: 'merge' });
    expect([sha('main'), sha('task/feat'), sha('task/side')]).toEqual(before);
    expect(fs.readdirSync(path.join(r.folder, '.worktrees')).sort()).toEqual(['feat', 'side']);
    expect(r.git(['status', '--porcelain'])).toBe('');

    // The dev room's view: the rail's chip comes from the background pre-check, then cached.
    const seen: Msg[] = [];
    const viewer = (m: Msg) => void seen.push(m);
    mgr.devroomView(viewer, true);
    const row = (task: string) =>
      (seen.filter((m) => m.type === 'repoState').at(-1)?.worktrees as Msg[] | undefined)?.find((w) => w.task === task);
    await waitFor(() => expect(row('feat')?.conflicts).toEqual(['a.txt', 'sub/b.txt']));
    await waitFor(() => expect(row('side')?.conflicts).toEqual([])); // one at a time: side after feat
    expect(row('feat')?.lastChange).toEqual(expect.any(String));
    mgr.devroomView(viewer, false);
  });

  it('sync → resolve both files → continue → merge → auto-cleanup removed the folder', async () => {
    const { flags, act, ask, sha, wtDir, conflicting, r } = setup();
    await conflicting('feat');
    flags.busy = true;
    expect(await act('sync', { task: 'feat' })).toMatchObject({ ok: false });
    flags.busy = false;
    expect(await act('sync', { task: 'feat' })).toMatchObject({ ok: true, conflicts: ['a.txt', 'sub/b.txt'] });
    const listed = await ask({ type: 'repoConflicts', task: 'feat' });
    expect(listed).toMatchObject({ ok: true, merging: true });
    expect((listed.files as Array<{ path: string; blocks: unknown[] }>).map((f) => [f.path, f.blocks.length])).toEqual([['a.txt', 1], ['sub/b.txt', 1]]);
    expect(await act('mergeContinue', { task: 'feat' })).toMatchObject({ ok: false }); // still unresolved
    expect(await act('resolve', { task: 'feat', path: 'a.txt', choices: ['ours', 'theirs'] })).toMatchObject({ ok: false }); // wrong count
    expect(await act('resolve', { task: 'feat', path: 'a.txt', choices: ['ours'] })).toMatchObject({ ok: true });
    expect(await act('resolve', { task: 'feat', path: 'sub/b.txt', choices: ['theirs'] })).toMatchObject({ ok: true });
    expect(await act('mergeContinue', { task: 'feat' })).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(wtDir('feat'), 'a.txt'), 'utf-8')).toBe('mine\n');
    expect(fs.readFileSync(path.join(wtDir('feat'), 'sub/b.txt'), 'utf-8')).toBe('theirs b\n');

    const merged = await act('merge', { task: 'feat' });
    expect(merged).toMatchObject({ ok: true, cleaned: true });
    expect(fs.existsSync(wtDir('feat'))).toBe(false);
    expect(r.git(['show', 'main:a.txt'])).toBe('mine\n');
    expect(r.git(['branch', '--list', 'task/feat'])).toBe(''); // merged: the branch went too
    expect(sha('main')).toBeTruthy();
  });

  it('mergeAbort leaves the worktree exactly as before the sync', async () => {
    const { act, sha, wtDir, conflicting, r } = setup();
    await conflicting('feat');
    const head = sha('HEAD', wtDir('feat'));
    expect(await act('sync', { task: 'feat' })).toMatchObject({ ok: true, conflicts: ['a.txt', 'sub/b.txt'] });
    expect(await act('mergeAbort', { task: 'feat' })).toMatchObject({ ok: true });
    expect(sha('HEAD', wtDir('feat'))).toBe(head);
    expect(r.git(['status', '--porcelain'], wtDir('feat'))).toBe('');
    expect(fs.readFileSync(path.join(wtDir('feat'), 'a.txt'), 'utf-8')).toBe('mine\n');
    expect(await act('mergeAbort', { task: 'feat' })).toMatchObject({ ok: false }); // nothing to abort now
  });

  it('auto-cleanup only takes merged, clean worktrees, and only while on; the cleanup list sizes them', async () => {
    const { flags, project, mgr, act, ask, wtDir, r } = setup();
    for (const t of ['dirty', 'off']) {
      await mgr.worktrees.create(project, t);
      fs.writeFileSync(path.join(wtDir(t), `${t}.txt`), `${t}\n`);
      r.git(['add', `${t}.txt`], wtDir(t));
      r.git(['commit', '-qm', t], wtDir(t));
    }
    fs.writeFileSync(path.join(wtDir('dirty'), 'loose.txt'), 'l\n');
    expect(await act('merge', { task: 'dirty' })).toMatchObject({ ok: true });
    expect(fs.existsSync(wtDir('dirty'))).toBe(true); // uncommitted work: kept
    flags.auto = false;
    const off = await act('merge', { task: 'off' });
    expect(off).toMatchObject({ ok: true });
    expect(off.cleaned).toBeUndefined();
    expect(fs.existsSync(wtDir('off'))).toBe(true);

    const list = await ask({ type: 'repoCleanupList' });
    expect(list).toMatchObject({ ok: true });
    const rows = list.rows as Array<Record<string, unknown>>;
    expect(rows.map((x) => [x.task, x.merged, x.dirty])).toEqual([['dirty', true, 1], ['off', true, 0]]);
    expect(rows.every((x) => (x.sizeBytes as number) > 0 && typeof x.mergedAt === 'string' && typeof x.lastChange === 'string')).toBe(true);
  });

  it("the Lead's note goes to the Worker at once with a Lead line, and locks the automatic merge (control: no note merges)", async () => {
    const { mgr, project, delivered, leadLines, wtDir, r } = setup();
    r.git(['branch', 'dev']); // not protected: the notes are the only reason to refuse
    for (const id of ['T-1', 'T-2']) {
      const rec = await mgr.worktrees.createForTask(project, { taskId: id, title: 'x', base: 'dev', assignmentId: 'as-w', createdBy: 'user' });
      fs.writeFileSync(path.join(wtDir(rec.task), 'a.txt'), `${id}\n`);
      r.git(['commit', '-qam', id], wtDir(rec.task));
    }
    const note = await mgr.leadReviewNote({ project: 'alpha', task: 't-1-x', file: 'a.txt', line: 1, body: 'name it better', lead: 'alpha' });
    expect(note).toMatchObject({ ok: true, to: 'web-worker' });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ to: 'web-worker', from: 'alpha' });
    expect(delivered[0].text).toContain('name it better');
    expect(leadLines).toEqual(['alpha 가 web-worker 에게 검토 의견을 보냈어요 (Task T-1)']);
    expect(mgr.reviewNotes.list('alpha', 't-1-x')[0]).toMatchObject({ by: 'agent:alpha', sentAt: expect.any(String) });

    const locked = await mgr.merge('alpha', 't-1-x', { privileged: true, source: 'engine', auto: true });
    expect(locked).toMatchObject({ ok: false, code: 'review_notes' });
    expect(r.git(['show', 'dev:a.txt'])).toBe('one\n');
    // Negative control: the same automatic merge of the Task without notes goes through.
    expect(await mgr.merge('alpha', 't-2-x', { privileged: true, source: 'engine', auto: true })).toMatchObject({ ok: true });
    expect(r.git(['show', 'dev:a.txt'])).toBe('T-2\n');
  });

  it('sent notes carry sentHead; fixed once the line changes; since diffs from the send', async () => {
    const { mgr, project, ask, wtDir } = setup();
    const rec = await mgr.worktrees.createForTask(project, { taskId: 'T-1', title: 'x', base: 'main', assignmentId: 'as-w', createdBy: 'user' });
    const wt = wtDir(rec.task);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\n');
    expect(await ask({ type: 'reviewNoteWrite', task: rec.task, op: 'add', file: 'a.txt', side: 'new', line: 2, body: 'why two' })).toMatchObject({ ok: true });
    expect(await ask({ type: 'reviewSend', task: rec.task })).toMatchObject({ ok: true, to: 'web-worker', count: 1 });
    const sentList = await ask({ type: 'reviewNotesRequest', task: rec.task });
    const sentHead = sentList.sentHead as string;
    expect(sentHead).toMatch(/^[0-9a-f]{40}$/);
    expect((sentList.notes as Msg[])[0]).toMatchObject({ fixed: false, sentHead });
    expect((sentList.notes as Msg[])[0].sentAnchor).toBeUndefined();

    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n2\n');
    const after = await ask({ type: 'reviewNotesRequest', task: rec.task });
    expect((after.notes as Msg[])[0]).toMatchObject({ fixed: true });
    const diff = await ask({ type: 'repoDiffRequest', task: rec.task, path: 'a.txt', staged: false, since: sentHead });
    expect(diff).toMatchObject({ ok: true, since: sentHead });
    expect(diff.text).toContain('-two\n+2\n');
    expect(diff.text).not.toContain('+one');
  });
});

describe.skipIf(!GIT_AVAILABLE)('the /ws gate', () => {
  it('a read-only client gets nothing from the dev room messages; a privileged one does', async () => {
    const r = makeTempRepo();
    repos.push(r);
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
    const { store } = await startEngineOffice({ readOnly: false, projects: [{ name: 'alpha', folder: r.folder }] });
    const sent: Msg[] = [];
    const send = (m: Msg) => void sent.push(m);
    const handle = (msg: Msg, privileged: boolean) =>
      handleClientMessage(msg, send, { store, cache: null, standalone: true, privileged });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const msg of [
      { type: 'devroomView', on: true },
      { type: 'devroomSettingsSet', autoCleanupAfterMerge: false },
      { type: 'repoMergeCheck', requestId: 'a', project: 'alpha', task: 'x' },
      { type: 'repoConflicts', requestId: 'b', project: 'alpha', task: 'x' },
      { type: 'repoCleanupList', requestId: 'c', project: 'alpha' },
      { type: 'repoAction', requestId: 'd', action: 'mergeAbort', project: 'alpha', task: 'x' },
      { type: 'previewAsk', project: 'alpha', task: 'x', url: 'http://localhost:5173' },
    ])
      handle(msg, false);
    await new Promise((res) => setTimeout(res, 300));
    expect(sent).toEqual([]);

    handle({ type: 'devroomView', on: true }, true);
    await waitFor(() => expect(sent.map((m) => m.type)).toEqual(expect.arrayContaining(['devroomSettings', 'devroomStats', 'repoState'])));
    expect(sent.find((m) => m.type === 'devroomSettings')).toEqual({ type: 'devroomSettings', autoCleanupAfterMerge: true });
    handle({ type: 'devroomView', on: false }, true);
  });
});
