/**
 * The 현황판's 실행 tab (owner 11-06 18:24): every background job and every agent run (Codex) in one
 * list, across the projects, narrowed by a project filter. A job or run notice and the control
 * center's 실행 중 open it (game/openJobs.ts, notify/openTarget.ts) with the filter on every project,
 * so the run they name is in the list.
 */
import { t } from '../../i18n/index.js';
import { AgtyScope } from '../officeStore.js';
import { CodexCards } from '../workbench/CodexCards.js';
import { JobsPanel } from '../workbench/JobsTab.js';
import { setRunsProject, useRunsScope } from './runsFilter.js';

export function RunsProjectSelect({ projects, shown }: { projects: readonly string[]; shown: string | null }) {
  return (
    <label className="flex items-center gap-4 text-xs min-w-0">
      <span className="shrink-0">{t('workbench.project')}</span>
      <select
        aria-label={t('runs.filter')}
        className="bg-bg border border-border px-4 py-2 text-xs min-w-0 pointer-coarse:min-h-44"
        value={shown ?? ''}
        onChange={(e) => setRunsProject(e.target.value || null)}
      >
        <option value="">{t('runs.all')}</option>
        {projects.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RunsPanel() {
  const { projects, shown, scope } = useRunsScope();
  return (
    <div className="space-y-8 min-w-0" data-testid="runs-panel">
      <RunsProjectSelect projects={projects} shown={shown} />
      <AgtyScope.Provider value={scope}>
        <JobsPanel />
        <CodexCards />
      </AgtyScope.Provider>
    </div>
  );
}
