/**
 * P4 개발실 W3 (mockups-1101/devroom-W3): 워크트리 정리. The merged or long-resting task folders of
 * a project with their size, a checkbox each (merged ones come checked, unmerged ones do not) and
 * the auto-cleanup toggle. The button removes the checked folders one after the other with the
 * existing `worktreeRemove`; an unmerged one is removed with `force`, which keeps its work on its
 * branch (the daemon commits it there first), and the yellow note says so before anything is sent.
 */
import { useEffect, useState } from 'react';

import type { RepoCleanupRow } from '../../../../core/src/messages.js';
import { MERGE_CHECK_PX, MERGE_TABLE_COLS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { cldToast } from '../officeStore.js';
import { serverText } from '../serverText.js';
import { useCanAct } from '../workbench/workbenchStore.js';
import { BODY, SMALL, useDevroomGroups } from './devroomData.js';
import { setDevroomTab } from './devroomStore.js';
import { dayLabel, defaultChecked, sizeText, totalBytes } from './mergeState.js';
import { act, requestCleanup, setAutoCleanup, useMergeStore } from './mergeStore.js';
import { Face } from './WorktreeRail.js';

const cell = `${SMALL}`;

export function CleanupView({ project }: { project: string }) {
  const canAct = useCanAct();
  const { cleanup, autoCleanup } = useMergeStore();
  const { groups } = useDevroomGroups();
  const group = groups.find((g) => g.project === project);
  const base = group?.repo?.branch ?? 'main';
  const data = cleanup[project];
  const rows: readonly RepoCleanupRow[] = data && data !== 'loading' && data.ok ? (data.rows ?? []) : [];
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => requestCleanup(project), [project]);
  // Once per question: the second answer (the sizes, measured after) keeps the owner's ticks.
  const answer = data && data !== 'loading' && data.ok ? data.requestId : null;
  useEffect(() => {
    if (answer && data && data !== 'loading') setChecked(defaultChecked(data.rows ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer]);
  const measuring = rows.some((r) => r.sizePending);

  const picked = rows.filter((r) => checked.has(r.task));
  const kept = picked.filter((r) => !r.merged || r.dirty > 0).length;

  const run = async () => {
    setRunning({ done: 0, total: picked.length });
    let done = 0;
    for (const r of picked) {
      const res = await act({
        action: 'worktreeRemove',
        project,
        task: r.task,
        // The note below said what stays on the branch, and the owner pressed the button.
        ...(!r.merged || r.dirty > 0 ? { force: true } : {}),
      });
      if (!res.ok) {
        cldToast(project, t('merge.cleanup.partial', { done, why: serverText(res, t('repo.failed')) }), 'error');
        break;
      }
      done++;
      setRunning({ done, total: picked.length });
    }
    if (done === picked.length) cldToast(project, t('merge.cleanup.done', { count: done }), 'ok');
    setRunning(null);
    requestCleanup(project);
  };

  const toggle = (task: string) => {
    const next = new Set(checked);
    if (!next.delete(task)) next.add(task);
    setChecked(next);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="devroom-cleanup-view">
      <div className={`h-56 shrink-0 flex items-center gap-10 px-12 bg-devroom-bar border-b-2 border-border ${BODY}`}>
        <span className="flex-1 text-devroom-title">
          {t('merge.cleanup.head', { count: rows.length, size: measuring ? t('devroomFix.sizeMeasuring') : sizeText(totalBytes(rows)) })}
        </span>
        <div className="text-right leading-snug">
          <div className="flex items-center justify-end gap-8">
            <span>{t('merge.cleanup.auto')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={autoCleanup}
              aria-label={t('merge.cleanup.auto')}
              data-testid="merge-auto"
              disabled={!canAct}
              className={`relative w-46 h-24 border-2 disabled:opacity-(--btn-disabled-opacity) ${autoCleanup ? 'bg-devroom-on-bg border-devroom-on-line' : 'bg-bg-dark border-border'}`}
              onClick={() => setAutoCleanup(!autoCleanup)}
            >
              <i className={`absolute top-2 w-16 h-16 ${autoCleanup ? 'right-2 bg-devroom-on-text' : 'left-2 bg-text-muted'}`} />
            </button>
          </div>
          <span className={`text-text-muted ${SMALL}`}>{t(autoCleanup ? 'merge.cleanup.autoOn' : 'merge.cleanup.autoOff')}</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 mx-12 mt-10 flex flex-col border-2 border-border bg-devroom-table overflow-y-auto" data-testid="merge-table">
        {data === undefined || data === 'loading' ? (
          <p className={`m-auto text-text-muted ${BODY}`}>{t('merge.cleanup.loading')}</p>
        ) : !data.ok ? (
          <p className={`m-auto text-text-muted ${BODY}`}>{serverText(data, t('merge.cleanup.failed'))}</p>
        ) : rows.length === 0 ? (
          <p className={`m-auto text-text-muted ${BODY}`}>{t('merge.cleanup.empty')}</p>
        ) : (
          <>
            <div className={`shrink-0 grid items-center h-32 pr-10 bg-devroom-th text-accent-text ${SMALL}`} style={{ gridTemplateColumns: MERGE_TABLE_COLS }}>
              <span />
              <span>{t('merge.cleanup.col.task')}</span>
              <span>{t('merge.cleanup.col.status')}</span>
              <span>{t('merge.cleanup.col.merged')}</span>
              <span>{t('merge.cleanup.col.changed')}</span>
              <span className="text-right">{t('merge.cleanup.col.size')}</span>
            </div>
            {rows.map((r) => {
              const on = checked.has(r.task);
              const info = group?.rows.find((g) => g.wt.task === r.task);
              const title = info?.title ?? r.task;
              return (
                <div
                  key={r.task}
                  className={`shrink-0 grid items-center min-h-54 pr-10 border-b-2 border-devroom-menu-line last:border-b-0 ${on ? 'bg-devroom-mine-bg' : ''}`}
                  style={{ gridTemplateColumns: MERGE_TABLE_COLS }}
                  data-testid="merge-row"
                  data-task={r.task}
                  data-merged={r.merged || undefined}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={t('merge.cleanup.select', { title })}
                    disabled={!canAct || running !== null}
                    className={`justify-self-center grid place-items-center border-2 text-white disabled:opacity-(--btn-disabled-opacity) ${on ? 'bg-accent border-devroom-accent-line' : 'bg-bg-dark border-border'}`}
                    style={{ width: MERGE_CHECK_PX, height: MERGE_CHECK_PX }}
                    onClick={() => toggle(r.task)}
                  >
                    {on ? '✔' : ''}
                  </button>
                  <span className="flex items-center gap-9 min-w-0 py-6">
                    <Face agentId={info?.agentId ?? null} name={r.assignee ?? title} />
                    <span className={`min-w-0 ${BODY}`}>
                      <span className="block truncate text-devroom-title">{title}</span>
                      <span className={`block truncate text-text-muted ${SMALL}`}>{r.assignee ?? t('devroom.nobody')}</span>
                      {!r.merged && (
                        <span className={`block text-devroom-conf ${SMALL}`}>
                          {r.unmergedFiles > 0
                            ? t('merge.cleanup.keep', { count: r.unmergedFiles })
                            : t('merge.cleanup.keepDirty')}
                        </span>
                      )}
                    </span>
                  </span>
                  <span>
                    <span
                      className={`inline-flex border-2 px-5 py-1 whitespace-nowrap ${SMALL} ${r.merged ? 'text-text-muted border-border bg-devroom-done-bg' : 'border-border bg-bg-dark'}`}
                    >
                      {t(r.merged ? 'devroom.chip.merged' : 'devroom.chip.idle')}
                    </span>
                  </span>
                  <span className={cell}>{r.merged ? dayLabel(r.mergedAt) : t('merge.cleanup.notMerged')}</span>
                  <span className={`${cell} text-text-muted`}>{dayLabel(r.lastChange)}</span>
                  <span className={`text-right ${BODY}`}>
                    {r.sizePending ? t('devroomFix.sizeMeasuring') : `${sizeText(r.sizeBytes)}${r.sizeCapped ? '+' : ''}`}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="shrink-0 mx-12 my-10 flex items-center gap-14 px-12 py-10 border-2 border-devroom-conf-line bg-devroom-confirm-bg" data-testid="merge-confirm">
        <div className={`flex-1 leading-normal text-devroom-conf-text ${SMALL}`}>
          <b className="font-normal">{t('merge.cleanup.how')}</b>
          <br />
          {picked.length === 0
            ? t('merge.cleanup.nothing')
            : kept > 0
              ? t('merge.cleanup.noteKept', { count: picked.length, kept, base })
              : t('merge.cleanup.noteMerged', { count: picked.length, base })}
        </div>
        <button type="button" className={`border-2 border-border bg-btn-bg hover:bg-btn-hover shadow-pixel px-10 py-6 ${BODY}`} onClick={() => setDevroomTab('terminal')}>
          {t('merge.cleanup.cancel')}
        </button>
        <button
          type="button"
          data-testid="merge-cleanup-run"
          disabled={!canAct || picked.length === 0 || running !== null}
          className={`border-2 border-danger bg-devroom-bad-bg text-white shadow-pixel px-14 py-8 disabled:opacity-(--btn-disabled-opacity) ${BODY}`}
          onClick={() => void run()}
        >
          {running
            ? t('merge.cleanup.running', running)
            : t('merge.cleanup.run', { count: picked.length, size: picked.some((r) => r.sizePending) ? t('devroomFix.sizeMeasuring') : sizeText(totalBytes(picked)) })}
        </button>
      </div>
    </div>
  );
}
