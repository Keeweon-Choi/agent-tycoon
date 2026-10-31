/**
 * P4 개발실's 병합 tab (mockups-1028/orca-tools-K, mockups-1101/devroom-W2) and its 작업 폴더 정리
 * view (W3, CleanupView.tsx). Opening the tab asks the daemon for the pre-check; a clean task shows
 * the list and K's card (병합 / 취소), a conflicting one W2's banner: 에이전트에게 맡기기 or 직접 풀기
 * (ConflictView.tsx). The owner chooses each time; no side is ever picked for them.
 */
import { useEffect, useState } from 'react';

import type { RepoActionResult } from '../../../../core/src/messages.js';
import { MERGE_CARD_W_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { cldToast } from '../officeStore.js';
import { repoAsk, repoConfirmNow } from '../repo/repoStore.js';
import { resultToast } from '../repo/repoText.js';
import { serverText } from '../serverText.js';
import { useCanAct } from '../workbench/workbenchStore.js';
import { CleanupView } from './CleanupView.js';
import { ResolvePanel } from './ConflictView.js';
import { BIG, BODY, SMALL, useDevroomGroups } from './devroomData.js';
import { setDevroomTab, syncWorktree } from './devroomStore.js';
import { fixingLock, preChecks } from './mergeState.js';
import { act, bindMergeWire, requestCheck, requestConflicts, taskKey, useMergeStore } from './mergeStore.js';
import { Face } from './WorktreeRail.js';

bindMergeWire({ send: (msg) => transport.send(msg), connected: () => transport.state === 'connected' });

const button = `border-2 border-border bg-btn-bg hover:bg-btn-hover shadow-pixel px-10 py-5 disabled:opacity-(--btn-disabled-opacity) ${BODY}`;
const accent = 'bg-accent! border-devroom-accent-line text-white';

export function MergeTab({
  project,
  task,
  view,
  phone = false,
}: {
  project: string;
  task: string | null;
  view: 'merge' | 'cleanup';
  /** The phone shows a conflict read-only: 직접 풀기 is for the PC. */
  phone?: boolean;
}) {
  if (view === 'cleanup') return <CleanupView project={project} />;
  if (!task) return null;
  return <MergePanel key={taskKey(project, task)} project={project} task={task} phone={phone} />;
}

function MergePanel({ project, task, phone }: { project: string; task: string; phone: boolean }) {
  const canAct = useCanAct();
  const { groups } = useDevroomGroups();
  const { checks, conflicts } = useMergeStore();
  const [manual, setManual] = useState(false);
  const [working, setWorking] = useState(false);
  const group = groups.find((g) => g.project === project);
  const row = group?.rows.find((r) => r.wt.task === task);
  const check = checks[taskKey(project, task)];
  const confl = conflicts[taskKey(project, task)];
  const base = check?.target ?? group?.repo?.branch ?? 'main';
  const worker = row?.wt.assignee ?? '';
  const wt = row?.wt;
  // Ask again whenever the worktree moved (a merge, a sync, the agent's commit).
  const sig = wt ? [wt.ahead, wt.behind, wt.dirty, wt.merged, wt.merge?.at, wt.conflicts?.length].join() : '';
  const conflicting = check?.ok === true && check.clean === false;

  useEffect(() => requestCheck(project, task), [project, task, sig]);
  useEffect(() => {
    if (conflicting) void requestConflicts(project, task);
  }, [project, task, conflicting, sig]);

  const say = (r: RepoActionResult) => {
    const { text, tone } = resultToast(r);
    cldToast(project, text, tone);
  };
  const refresh = () => {
    requestCheck(project, task);
    void requestConflicts(project, task);
  };
  const run = async (fn: () => Promise<void>) => {
    setWorking(true);
    try {
      await fn();
    } finally {
      setWorking(false);
    }
  };

  if (!check) return <p className={`m-auto text-text-muted ${BODY}`}>{t('merge.loading')}</p>;
  if (!check.ok) {
    return (
      <div className="m-auto flex flex-col items-center gap-8" data-testid="merge-error">
        <p className={`text-devroom-conf ${BODY}`}>{serverText(check, t('merge.checkFailed'))}</p>
        <button type="button" className={button} onClick={() => requestCheck(project, task)}>
          {t('merge.retry')}
        </button>
      </div>
    );
  }
  if (check.kind === 'already') {
    return (
      <div className="m-auto text-center" data-testid="merge-already">
        <p className={`text-devroom-ok ${BIG}`}>{t('merge.already', { base })}</p>
        <p className={`mt-6 text-text-muted ${SMALL}`}>{t('merge.alreadyHint')}</p>
      </div>
    );
  }

  if (conflicting) {
    const count = check.conflicts?.length ?? 0;
    const merging = confl?.ok === true && confl.merging === true;
    const open = manual || merging;
    const handoff = () =>
      void run(async () => {
        const r = await act({ action: 'conflictHandoff', project, task });
        say(r);
        refresh();
      });
    // 직접 풀기: bring the base into the task folder (the daemon refuses while its agent works), then list the blocks.
    const resolveMyself = () =>
      void run(async () => {
        if (!merging) {
          const r = await act({ action: 'sync', project, task });
          say(r);
          if (!r.ok) return;
        }
        // The panel opens on the merge that is now in progress, not on the list from before it.
        requestCheck(project, task);
        await requestConflicts(project, task);
        setManual(true);
      });
    return (
      <div className="flex-1 min-h-0 flex flex-col" data-testid="merge-conflict">
        <div className={`m-12 shrink-0 flex items-center gap-14 px-12 py-10 border-2 border-devroom-conf-line bg-devroom-banner-bg ${phone ? 'flex-wrap' : ''}`}>
          <Face agentId={row?.agentId ?? null} name={worker} size={40} />
          <div className="flex-1 min-w-0 leading-normal text-devroom-conf-text">
            <p className={BIG}>{t('merge.conflict.title', { base })}</p>
            <p className={`text-text-muted ${SMALL}`}>
              {t('merge.conflict.sub', { count, task: row?.title ?? task })}
            </p>
          </div>
          {canAct && (
            <button
              type="button"
              data-testid="merge-handoff"
              disabled={working || !worker}
              className={`flex flex-col items-center gap-2 px-18 py-10 border-2 shadow-pixel disabled:opacity-(--btn-disabled-opacity) ${accent} ${BIG}`}
              onClick={handoff}
            >
              {t('merge.conflict.handoff')}
              {worker && <small className={`text-devroom-tab-on ${SMALL}`}>{t('merge.conflict.handoffSub', { worker })}</small>}
            </button>
          )}
          {canAct && !phone && (
            <button
              type="button"
              data-testid="merge-manual"
              aria-expanded={open}
              disabled={working}
              className={`${button} px-14 py-10`}
              onClick={() => (open ? setManual(false) : resolveMyself())}
            >
              {t('merge.conflict.manual')} {open ? '▴' : '▾'}
            </button>
          )}
        </div>
        {phone && <p className={`mx-12 text-text-muted ${SMALL}`}>{t('merge.conflict.phone')}</p>}
        {working && !open && <p className={`mx-12 text-text-muted ${SMALL}`}>{t('merge.conflict.syncing', { base })}</p>}
        {open && !phone && (
          <ResolvePanel
            key={`${merging}`}
            project={project}
            task={task}
            files={confl?.files ?? []}
            worker={worker}
            base={base}
            canAct={canAct}
            merging={merging}
            say={say}
            onAbort={() =>
              void run(async () => {
                say(await act({ action: 'mergeAbort', project, task }));
                setManual(false);
                refresh();
              })
            }
            onAfter={refresh}
          />
        )}
      </div>
    );
  }

  // Clean: the pre-check list, and K's card.
  const locked = fixingLock(check, row?.task?.status);
  const list = preChecks(check, row?.task?.testsPassed?.value === true);
  const subject = check.kind === 'ff' ? t('merge.confirm.ff', { count: check.ahead ?? 0 }) : (check.subject ?? '');
  const merge = () => {
    if (!wt) return;
    repoAsk({ kind: 'merge', project, worktree: wt });
    repoConfirmNow((msg) => transport.send(msg), transport.state === 'connected', cldToast);
  };
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-12 flex flex-col gap-12" data-testid="merge-clean">
      <section className="border-2 border-border bg-devroom-table" aria-label={t('merge.checkTitle')}>
        <p className={`px-10 py-6 bg-devroom-th text-accent-text ${SMALL}`}>{t('merge.checkTitle')}</p>
        {list.map((c) => (
          <div
            key={c.id}
            className={`flex items-center gap-8 px-10 py-6 border-t-2 border-devroom-menu-line ${BODY}`}
            data-testid="merge-check"
            data-check={c.id}
            data-ok={c.ok}
          >
            <span className={`w-16 shrink-0 text-center ${c.ok ? 'text-devroom-ok' : 'text-devroom-conf'}`} aria-hidden="true">
              {c.ok ? '✔' : '!'}
            </span>
            <span className={`flex-1 min-w-0 ${c.ok ? '' : 'text-devroom-conf-text'}`}>{c.text}</span>
            {c.fix === 'sync' && canAct && (
              <button
                type="button"
                className={button}
                data-testid="merge-catchup"
                onClick={() => syncWorktree(project, task, (msg) => transport.send(msg), transport.state === 'connected')}
              >
                {t('merge.check.catchUp')}
              </button>
            )}
          </div>
        ))}
      </section>

      <section
        className="self-start w-full p-12 border-2 border-devroom-main-line bg-devroom-main shadow-pixel"
        style={{ maxWidth: MERGE_CARD_W_PX }}
        aria-label={t('merge.confirm.title', { base })}
        data-testid="merge-card"
      >
        <h3 className={`font-normal text-devroom-title ${BIG}`}>{t('merge.confirm.title', { base })}</h3>
        <p className={`mt-8 text-text-muted ${SMALL}`}>{t('merge.confirm.preview')}</p>
        <div className={`mt-4 px-8 py-6 border-2 border-border bg-bg-dark leading-normal ${BODY}`} data-testid="merge-subject">
          <div className="break-words">{subject}</div>
          <div className="text-text-muted break-words">{t('merge.confirm.by', { task, worker: worker || t('devroom.nobody') })}</div>
        </div>
        <div className="mt-10 flex items-center gap-8">
          {canAct && (
            <button
              type="button"
              data-testid="merge-go"
              className={`${button} ${locked ? '' : accent}`}
              disabled={locked || !wt}
              title={locked ? t('merge.locked') : undefined}
              onClick={merge}
            >
              {t('merge.confirm.go')}
            </button>
          )}
          <button type="button" className={button} onClick={() => setDevroomTab('terminal')}>
            {t('merge.confirm.cancel')}
          </button>
        </div>
        {locked && (
          <p className={`mt-8 text-devroom-conf ${SMALL}`} data-testid="merge-locked">
            {t('merge.locked')}
          </p>
        )}
        {(check.reviewNotes ?? 0) > 0 && <p className={`mt-8 text-text-muted ${SMALL}`}>{t('merge.notesNote')}</p>}
        <p className={`mt-8 text-text-muted ${SMALL}`}>{t('merge.confirm.revert')}</p>
      </section>
    </div>
  );
}
