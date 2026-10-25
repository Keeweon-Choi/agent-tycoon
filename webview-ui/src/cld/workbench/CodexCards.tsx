/**
 * UI-C1: the project's Codex runs, listed after its Lead and Workers on the 에이전트 tab
 * (moved from the 현황판's Codex tab). Live runs first; the newest few finished ones after
 * them; the older ones behind one fold. Sees what the surrounding CldScope lets it see.
 */
import { useMemo, useState } from 'react';

import type { CodexTask } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { Chevron } from '../Chevron.js';
import { useCldStore } from '../officeStore.js';
import { codexStatus, codexWord, timesText } from '../panels/jobs.js';
import { FOCUSED, section, tapButton } from './JobsTab.js';
import { codexCards } from './workbenchState.js';
import { useNow } from './workbenchStore.js';

const muted = 'text-text-muted text-xs';

function CodexCard({ task, now }: { task: CodexTask; now: number }) {
  // U-48: the step its CODEX_PROGRESS.md is on (only while the run works), so the card says what it is doing now.
  const { tracked } = useCldStore();
  const step = (task.project ? tracked[task.project]?.items : undefined)?.find(
    (i) => i.parentKey === `codex:${task.id}` && i.status === 'doing',
  );
  return (
    // data-codex-ref: a Codex-end notice opens this card (notify/openTarget.ts).
    <li
      className={`${section} text-xs ${FOCUSED}`}
      data-testid="workbench-codex"
      data-codex-ref={task.id}
    >
      <div className="flex flex-wrap items-center gap-8 min-w-0">
        <strong className="text-sm truncate min-w-0" data-testid="codex-title">
          {task.title ?? task.spec ?? t('panel.codexJob')}
        </strong>
        <span className="border border-border px-4 text-accent-text shrink-0">
          {t('workbench.role.codex')}
        </span>
        <span className="ml-auto shrink-0" data-testid="codex-state">
          {codexWord(task)}
        </span>
      </div>
      {step && (
        <p className="mt-4 break-words" data-testid="codex-step">
          {t('workbench.codexStep', { step: step.title })}
        </p>
      )}
      <p className={muted}>
        {[task.project, task.model, task.provider === 'engine' && t('status.engineBadge')]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p className="mt-4">
        {/* The engine counts commits only: it adds no progress file to the spec (ADR-0014). */}
        {task.progressTotal != null &&
          t('panel.codexProgress', { done: task.progressDone ?? '—', total: task.progressTotal })}
        {t('panel.commits', { count: task.commits ?? 0 })}
      </p>
      <p className={`${muted} mt-4`} data-testid="codex-times">
        {timesText(task.created ?? task.started, task.started, now)}
      </p>
      {task.state === 'limit' && (
        <p className="text-yellow-300 mt-4" data-testid="codex-status">
          {codexStatus(task, now)}
        </p>
      )}
      <details className="text-text-muted mt-4" data-testid="codex-details">
        <summary className="cursor-pointer">{t('panel.details')}</summary>
        <p>
          {t('panel.taskId')} {task.id}
        </p>
        <p>PID {task.pid ?? t('panel.none')}</p>
        <p>
          {t('panel.exitCode')} {task.exit ?? t('panel.none')}
        </p>
        <p>
          {t('panel.spec')} {task.spec ?? t('panel.none')}
        </p>
        <p>
          {t('panel.model')} {task.model ?? t('panel.noInfo')}
        </p>
      </details>
    </li>
  );
}

export function CodexCards() {
  const { codexTasks } = useCldStore();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const cards = useMemo(() => codexCards(codexTasks?.tasks ?? []), [codexTasks]);
  if (!cards.live.length && !cards.shown.length) return null;
  return (
    <ul className="space-y-8 min-w-0 mt-8" aria-label={t('workbench.codexRuns')}>
      {[...cards.live, ...cards.shown].map((task) => (
        <CodexCard key={task.id} task={task} now={now} />
      ))}
      {cards.more.length > 0 && (
        <li className="space-y-8">
          <button
            type="button"
            data-codex-refs={cards.more.map((x) => x.id).join(' ')}
            className={`${section} w-full text-left text-xs flex items-center gap-6 ${tapButton}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Chevron open={open} />
            <span>{t('workbench.codexMore', { count: cards.more.length })}</span>
          </button>
          {open && (
            <ul className="space-y-8">
              {cards.more.map((task) => (
                <CodexCard key={task.id} task={task} now={now} />
              ))}
            </ul>
          )}
        </li>
      )}
    </ul>
  );
}
