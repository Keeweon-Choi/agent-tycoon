import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useState } from 'react';

import type { RepoFile, RepoMerge, RepoState, RepoWorktree } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { useCldStore } from '../officeStore.js';
import { serverText } from '../serverText.js';
import type { DiffView } from './repoStore.js';
import {
  detailKey,
  diffKey,
  repoAsk,
  repoCloseDetail,
  repoCloseDiff,
  repoRequestDetail,
  repoRequestDiff,
  useRepoStore,
} from './repoStore.js';
import type { DiffKind } from './repoText.js';
import { branchLine, diffRuns, fileLetter, groupFiles, mergeHistoryLine, mergeLine, pushBlocked } from './repoText.js';
import { useRepoView } from './useRepoView.js';

const button =
  'border border-border px-8 py-4 text-xs hover:bg-border disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent';
const muted = 'text-text-muted text-xs';
// `font-mono` on each run: the base layer's `* { font-pixel }` hits every span
// itself, so a span would not inherit the monospace face of its <pre>.
const DIFF_CLASS: Record<DiffKind, string> = {
  add: 'font-mono text-green-300',
  del: 'font-mono text-red-400',
  hunk: 'font-mono text-accent-text',
  meta: 'font-mono text-text-muted',
  ctx: 'font-mono',
};
const LETTER_CLASS: Record<string, string> = {
  M: 'text-yellow-300',
  A: 'text-green-300',
  D: 'text-red-400',
  U: 'text-red-400',
  R: 'text-accent-text',
  C: 'text-accent-text',
  '?': 'text-text-muted',
};

function DiffBlock({ view, onMore }: { view: DiffView; onMore: () => void }) {
  if (view.loading && !view.text) return <p className={`${muted} mt-4`}>{t('repo.diffLoading')}</p>;
  if (view.error && !view.text) return <p className="text-xs text-red-400 mt-4">{view.error}</p>;
  return (
    <div className="mt-4 min-w-0">
      <pre
        className="max-h-[320px] overflow-auto whitespace-pre bg-black/30 p-8 text-2xs font-mono leading-tight"
        aria-label="diff"
      >
        {view.text === '' && t('repo.diffEmpty')}
        {diffRuns(view.text).map((run, i) => (
          <span key={i} className={DIFF_CLASS[run.kind]}>
            {run.text}
            {'\n'}
          </span>
        ))}
      </pre>
      {view.error && <p className="text-xs text-red-400 mt-4">{view.error}</p>}
      {view.nextOffset !== undefined && (
        <div className="mt-4 flex flex-wrap items-center gap-8">
          <button type="button" className={button} disabled={view.loading} onClick={onMore}>
            {view.loading ? t('messenger.loading') : t('messenger.showMore')}
          </button>
          <span className={muted}>{t('repo.diffShown', { amount: Math.round(view.nextOffset / 1024) })}</span>
        </div>
      )}
      {view.limited && <p className={`${muted} mt-4`}>{t('repo.diffLimited')}</p>}
    </div>
  );
}

function FileRow({
  project,
  file,
  side,
  checkbox,
  checked,
  onCheck,
}: {
  project: string;
  file: RepoFile;
  side: 'staged' | 'worktree';
  /** Writes are enabled: show the selection box. */
  checkbox: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
}) {
  const { diffs } = useRepoStore();
  const staged = side === 'staged';
  const view = diffs[diffKey(project, file.path, staged)];
  const { letter, label } = fileLetter(file, side);
  const toggle = () =>
    view
      ? repoCloseDiff(project, file.path, staged)
      : repoRequestDiff(project, file.path, staged, (msg) => transport.send(msg));
  return (
    <li className="min-w-0">
      <div className="flex items-start gap-4">
        {checkbox && (
          <input
            type="checkbox"
            className="mt-4 shrink-0"
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
            aria-label={t('repo.selectFile', { path: file.path })}
          />
        )}
        <span
          className={`shrink-0 w-16 text-center text-xs ${LETTER_CLASS[letter] ?? ''}`}
          title={label}
          aria-label={label}
        >
          {letter}
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 text-left text-xs break-all hover:text-accent-text"
          aria-expanded={!!view}
          title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
          onClick={toggle}
        >
          {file.origPath && <span className="text-text-muted">{file.origPath} → </span>}
          {file.path}
        </button>
      </div>
      {view && (
        <DiffBlock
          view={view}
          onMore={() =>
            repoRequestDiff(project, file.path, staged, (msg) => transport.send(msg), true)
          }
        />
      )}
    </li>
  );
}

/** W4: a task worktree's changed files (tabs, one diff at a time), its commits, the guard note. */
function WorktreeDetail({ project, w }: { project: string; w: RepoWorktree }) {
  const { details, diffs } = useRepoStore();
  const send = (msg: Parameters<typeof transport.send>[0]) => transport.send(msg);
  const [picked, setPicked] = useState<string | null>(null);
  const d = details[detailKey(project, w.task)];
  // ponytail: refreshed when the counts move (every 10 s poll); an edit that keeps them equal waits for the button.
  useEffect(() => {
    repoRequestDetail(project, w.task, send);
  }, [project, w.task, w.ahead, w.behind, w.dirty]);
  useEffect(() => () => repoCloseDetail(project, w.task), [project, w.task]);
  const file = d?.files.find((f) => f.path === picked) ?? d?.files[0];
  useEffect(() => {
    if (!file) return;
    repoRequestDiff(project, file.path, false, send, false, w.task);
    return () => repoCloseDiff(project, file.path, false, w.task);
  }, [project, w.task, file?.path, w.ahead, w.behind, w.dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = file ? diffs[diffKey(project, file.path, false, w.task)] : undefined;
  if (!d || (d.loading && !d.files.length && !d.commits.length)) return <p className={`${muted} mt-4`}>{t('messenger.loading')}</p>;
  if (d.error) return <p className="text-xs text-red-400 mt-4">{d.error}</p>;
  return (
    <div className="mt-4 space-y-4 min-w-0" data-testid="worktree-detail">
      <div className="flex items-center justify-between gap-8">
        <h5 className="text-xs font-bold">{t('repo.changedFiles', { count: d.files.length })}</h5>
        <button type="button" className={button} disabled={d.loading} onClick={() => repoRequestDetail(project, w.task, send)}>
          {t('repo.detailRefresh')}
        </button>
      </div>
      {d.files.length === 0 && <p className={muted}>{t('repo.noChangedFilesWt')}</p>}
      <div className="flex flex-wrap gap-4 max-h-[96px] overflow-auto" role="tablist" aria-label={t('repo.changedFiles', { count: d.files.length })}>
        {d.files.map((f) => (
          <button
            key={f.path}
            type="button"
            role="tab"
            aria-selected={f.path === file?.path}
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
            className={`${button} min-w-0 max-w-full break-all text-left ${f.path === file?.path ? 'bg-border' : ''}`}
            data-testid="worktree-file-tab"
            onClick={() => setPicked(f.path)}
          >
            <span className={LETTER_CLASS[f.status] ?? ''}>{f.status}</span> {f.path.split('/').pop()}
          </button>
        ))}
      </div>
      {file && <p className={`${muted} break-all`}>{file.origPath ? `${file.origPath} → ${file.path}` : file.path}</p>}
      {view && <DiffBlock view={view} onMore={() => file && repoRequestDiff(project, file.path, false, send, true, w.task)} />}
      {d.filesTruncated && <p className={muted}>{t('repo.changedFilesCut')}</p>}
      <h5 className="text-xs font-bold">{t('repo.recentCommits', { count: d.commits.length })}</h5>
      {d.commits.length === 0 ? (
        <p className={muted}>{t('repo.noCommitsWt')}</p>
      ) : (
        <ul className="space-y-2" data-testid="worktree-commits">
          {d.commits.map((c) => (
            <li key={c.sha} className="break-words">
              <span className="text-accent-text">{c.sha.slice(0, 7)}</span> {c.subject}
              <span className={muted}> · {c.author} · {c.at.slice(0, 16).replace('T', ' ')}</span>
            </li>
          ))}
        </ul>
      )}
      {d.guard && <p className={muted} data-testid="worktree-guard">{d.guard}</p>}
    </div>
  );
}

function DetailToggle({ project, w }: { project: string; w: RepoWorktree }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <button type="button" className={button} aria-expanded={open} data-testid="worktree-detail-toggle" onClick={() => setOpen(!open)}>
        {open ? t('repo.hideDetail') : t('repo.showDetail')}
      </button>
      {open && <WorktreeDetail project={project} w={w} />}
    </div>
  );
}

function Worktrees({
  project,
  worktrees,
  canWrite,
  running,
}: {
  project: string;
  worktrees: RepoWorktree[];
  canWrite: boolean;
  running: boolean;
}) {
  return (
    <section className="mt-12 border-t border-border pt-8" aria-label={t('repo.workspaces')}>
      <h4 className="text-xs font-bold mb-4">{t('repo.workspacesCount', { count: worktrees.length })}</h4>
      <ul className="space-y-4">
        {worktrees.map((w) => (
          <li key={w.task} className="border border-border p-8 text-xs min-w-0" data-testid="worktree-row" data-task={w.task}>
            <div className="flex items-start justify-between gap-8">
              <strong className="break-all">{w.task}</strong>
              {canWrite && (
                <span className="flex gap-4 shrink-0">
                  {/* W3: its branch into its base (ff, else a merge commit; a conflict changes nothing). */}
                  {!w.merged && w.ahead > 0 && (
                    <button
                      type="button"
                      className={`${button} border-accent text-accent-text`}
                      disabled={running}
                      data-testid="worktree-merge"
                      onClick={() => repoAsk({ kind: 'merge', project, worktree: w })}
                    >
                      {t('repo.merge')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={button}
                    disabled={running}
                    onClick={() => repoAsk({ kind: 'worktreeRemove', project, worktree: w })}
                  >
                    {t('repo.remove')}
                  </button>
                </span>
              )}
            </div>
            <p className={`${muted} break-all`}>
              {w.branch} ← {w.base}
            </p>
            {/* W2: the Task it was made for and who it is given to. */}
            <p className="break-words" data-testid="worktree-task" data-task-id={w.taskId ?? ''}>
              {w.taskId ? t('repo.worktreeTask', { id: w.taskId }) : t('repo.worktreeNoTask')}
              {' · '}
              {w.assignee ? t('repo.worktreeAssignee', { name: w.assignee }) : t('repo.worktreeNobody')}
            </p>
            <p>
              <span title={t('repo.aheadBehind')}>
                ↑{w.ahead} ↓{w.behind}
              </span>
              {' · '}
              {!w.exists ? t('repo.folderMissing') : w.dirty > 0 ? t('repo.dirtyCount', { count: w.dirty }) : t('repo.clean')}
              {' · '}
              <span className={w.merged ? 'text-green-300' : 'text-yellow-300'}>
                {w.merged ? t('repo.merged') : t('repo.unmerged')}
              </span>
            </p>
            {w.merge && (
              <p
                className={`break-words ${w.merge.ok ? 'text-green-300' : 'text-yellow-300'}`}
                data-testid="worktree-merge-result"
              >
                {mergeLine(w.merge)}
              </p>
            )}
            <DetailToggle project={project} w={w} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** W4: the project's merges, newest first (kept across restarts). */
function MergeHistory({ merges }: { merges: RepoMerge[] }) {
  return (
    <section className="mt-12 border-t border-border pt-8" aria-label={t('repo.mergeHistory', { count: merges.length })}>
      <h4 className="text-xs font-bold mb-4">{t('repo.mergeHistory', { count: merges.length })}</h4>
      <ul className="space-y-2 text-xs" data-testid="merge-history">
        {merges.map((m, i) => (
          <li key={i} className={`break-words ${m.ok ? 'text-green-300' : 'text-yellow-300'}`}>
            {mergeHistoryLine(m)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The worktree tab: the task worktrees (or a line saying there are none) and the merge history. */
function WorktreeList(props: {
  project: string;
  worktrees: RepoWorktree[];
  merges: RepoMerge[];
  canWrite: boolean;
  running: boolean;
}) {
  const { merges, ...rest } = props;
  return (
    <>
      {rest.worktrees.length > 0 ? <Worktrees {...rest} /> : <p className={muted}>{t('repo.noWorktrees')}</p>}
      {merges.length > 0 && <MergeHistory merges={merges} />}
    </>
  );
}

function RepoBody({
  project,
  state,
  canWrite,
  running,
}: {
  project: string;
  state: RepoState;
  canWrite: boolean;
  running: boolean;
}) {
  const files = state.files ?? [];
  const groups = groupFiles(files);
  const unstaged = [...groups.conflicts, ...groups.changed, ...groups.untracked];
  const [pickedStage, setPickedStage] = useState<Set<string>>(new Set());
  const [pickedUnstage, setPickedUnstage] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  // A new commit (this one, or one made in a terminal) ends the message that was being written.
  useEffect(() => setMessage(''), [state.head]);
  const stagePaths = unstaged.filter((f) => pickedStage.has(f.path)).map((f) => f.path);
  const unstagePaths = groups.staged.filter((f) => pickedUnstage.has(f.path)).map((f) => f.path);
  const pick = (setter: Dispatch<SetStateAction<Set<string>>>, path: string, on: boolean) =>
    setter((current) => {
      const next = new Set(current);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  const blocked = pushBlocked(state);
  const row = (file: RepoFile, side: 'staged' | 'worktree') => (
    <FileRow
      key={`${side}:${file.path}`}
      project={project}
      file={file}
      side={side}
      checkbox={canWrite}
      checked={(side === 'staged' ? pickedUnstage : pickedStage).has(file.path)}
      onCheck={(on) => pick(side === 'staged' ? setPickedUnstage : setPickedStage, file.path, on)}
    />
  );
  return (
    <div className="space-y-8 min-w-0">
      <div>
        <p className="text-xs">
          <strong className="break-all">{branchLine(state)}</strong>
        </p>
        {state.ahead != null && (
          <p className={muted} aria-label={t('repo.aheadBehindCount', { ahead: state.ahead, behind: state.behind ?? 0 })}>
            ↑{state.ahead} ↓{state.behind ?? 0}
            {state.head ? ` · ${state.head}` : ''}
          </p>
        )}
      </div>

      {files.length === 0 && <p className={muted}>{t('repo.noChangedFiles')}</p>}

      {groups.staged.length > 0 && (
        <section aria-label={t('repo.staged')}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h4 className="text-xs font-bold">{t('repo.stagedCount', { count: groups.staged.length })}</h4>
            {canWrite && (
              <div className="flex gap-4">
                {unstagePaths.length > 0 && (
                  <button
                    type="button"
                    className={button}
                    disabled={running}
                    onClick={() =>
                      repoAsk({
                        kind: 'unstage',
                        project,
                        paths: unstagePaths,
                        count: unstagePaths.length,
                      })
                    }
                  >
                    {t('repo.unstageSelected', { count: unstagePaths.length })}
                  </button>
                )}
                <button
                  type="button"
                  className={button}
                  disabled={running}
                  onClick={() => repoAsk({ kind: 'unstage', project, count: groups.staged.length })}
                >
                  {t('repo.unstageAll')}
                </button>
              </div>
            )}
          </div>
          <ul className="space-y-4 mt-4">{groups.staged.map((f) => row(f, 'staged'))}</ul>
          {state.statStaged && (
            <pre
              className="mt-4 max-h-[160px] overflow-auto whitespace-pre font-mono leading-tight text-2xs text-text-muted"
              aria-label={t('repo.stagedStat')}
            >
              {state.statStaged}
            </pre>
          )}
        </section>
      )}

      {unstaged.length > 0 && (
        <section aria-label={t('repo.unstaged')}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h4 className="text-xs font-bold">{t('repo.unstagedCount', { count: unstaged.length })}</h4>
            {canWrite && (
              <div className="flex gap-4">
                {stagePaths.length > 0 && (
                  <button
                    type="button"
                    className={button}
                    disabled={running}
                    onClick={() =>
                      repoAsk({
                        kind: 'stage',
                        project,
                        paths: stagePaths,
                        count: stagePaths.length,
                      })
                    }
                  >
                    {t('repo.stageSelected', { count: stagePaths.length })}
                  </button>
                )}
                <button
                  type="button"
                  className={button}
                  disabled={running}
                  onClick={() => repoAsk({ kind: 'stage', project, count: unstaged.length })}
                >
                  {t('repo.stageAll')}
                </button>
              </div>
            )}
          </div>
          <ul className="space-y-4 mt-4">{unstaged.map((f) => row(f, 'worktree'))}</ul>
          {groups.conflicts.length > 0 && (
            <p className="text-xs text-red-400 mt-4">
              {t('repo.conflicts', { count: groups.conflicts.length })}
            </p>
          )}
          {state.statUnstaged && (
            <pre
              className="mt-4 max-h-[160px] overflow-auto whitespace-pre font-mono leading-tight text-2xs text-text-muted"
              aria-label={t('repo.unstagedStat')}
            >
              {state.statUnstaged}
            </pre>
          )}
        </section>
      )}

      {state.filesTruncated && <p className={muted}>{t('repo.filesTruncated')}</p>}

      {canWrite && (
        <div className="space-y-4">
          <textarea
            className="w-full bg-black/30 border border-border p-4 text-xs"
            rows={2}
            maxLength={10_000}
            placeholder={t('repo.commitMessage')}
            aria-label={t('repo.commitMessage')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-8">
            <button
              type="button"
              className={button}
              disabled={running || groups.staged.length === 0 || message.trim() === ''}
              onClick={() =>
                repoAsk({ kind: 'commit', project, message, count: groups.staged.length })
              }
            >
              {t('repo.commit')}
            </button>
            <button
              type="button"
              className={button}
              disabled={running || blocked !== null}
              onClick={() =>
                repoAsk({ kind: 'push', project, upstream: state.upstream!, ahead: state.ahead! })
              }
            >
              push{state.ahead ? ` ↑${state.ahead}` : ''}
            </button>
            {blocked && <span className={muted}>{blocked}</span>}
            {running && <span className="text-xs text-accent-text pixel-pulse">{t('repo.processing')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A project's repository (T-0020, FR-ENG-005), now in the 작업실 (W1): the 변경 tab shows
 * the branch, its upstream and ahead/behind and the changed files with their diffs; the
 * worktree tab, the task worktrees.
 * Reading is for every project; stage, commit, push and removing a worktree
 * show only when the daemon runs with --allow-actions, and each asks first.
 */
export type RepoPart = 'changes' | 'worktrees';

export function RepoPanel({ project, part }: { project: string; part: RepoPart }) {
  const { officeSnapshot: officeState, officeReadOnly } = useCldStore();
  const { states, busy } = useRepoStore();
  useRepoView(project);
  const state = states[project];
  const canWrite = !!officeState && !officeState.readOnly && !officeReadOnly;
  return (
    <div className="mt-12 border-t border-border pt-8 min-w-0" aria-label={t('repo.repoLabel', { project })}>
      {!state ? (
        <p className={muted}>{t('repo.repoLoading')}</p>
      ) : !state.ok ? (
        <p className={muted}>{serverText(state, t('repo.repoMissing'))}</p>
      ) : part === 'worktrees' ? (
        <WorktreeList
          project={project}
          worktrees={state.worktrees ?? []}
          merges={state.merges ?? []}
          canWrite={canWrite}
          running={busy[project] !== undefined}
        />
      ) : (
        <RepoBody
          project={project}
          state={state}
          canWrite={canWrite}
          running={busy[project] !== undefined}
        />
      )}
    </div>
  );
}
