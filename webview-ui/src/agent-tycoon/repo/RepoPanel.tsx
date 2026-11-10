import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useState } from 'react';

import type { RepoFile, RepoState } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { useAgtyStore } from '../officeStore.js';
import { serverText } from '../serverText.js';
import type { DiffView } from './repoStore.js';
import {
  diffKey,
  repoAsk,
  repoCloseDiff,
  repoRequestDiff,
  useRepoStore,
} from './repoStore.js';
import type { DiffKind } from './repoText.js';
import {
  branchLine,
  diffRows,
  fileLetter,
  groupFiles,
  gutterCols,
  gutterTemplate,
  pushBlocked,
} from './repoText.js';
import { useRepoView } from './useRepoView.js';

const button =
  'border border-border px-8 py-4 text-xs hover:bg-border disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent';
const muted = 'text-text-muted text-xs';
// `font-mono` on each row: the base layer's `* { font-pixel }` hits every span
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
  const rows = diffRows(view.text);
  const cols = gutterCols(rows);
  return (
    <div className="mt-4 min-w-0">
      <pre
        className="max-h-[320px] overflow-auto whitespace-pre bg-black/30 p-8 text-base font-mono leading-tight"
        aria-label="diff"
      >
        {view.text === '' && t('repo.diffEmpty')}
        {rows.map((row) => (
          <span key={row.key} className="grid min-w-max" style={{ gridTemplateColumns: gutterTemplate(cols) }}>
            {cols.old > 0 && <span className="font-pixel text-right pr-4 text-text-muted tabular-nums">{row.oldNo ?? ''}</span>}
            {cols.new > 0 && <span className="font-pixel text-right pr-4 text-text-muted tabular-nums">{row.newNo ?? ''}</span>}
            <span className={DIFF_CLASS[row.kind]}>
              {row.text}
            </span>
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
 * A project's own repository (T-0020, FR-ENG-005) in the 작업실's 변경 tab: the branch, its
 * upstream and ahead/behind and the changed files with their diffs. The task worktrees live in
 * the 개발실 (P4); their review is devroom/TaskReview.tsx.
 * Reading is for every project; stage, commit and push show only when the daemon runs with
 * --allow-actions, and each asks first.
 */
export function RepoPanel({ project }: { project: string }) {
  const { officeSnapshot: officeState, officeReadOnly } = useAgtyStore();
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
