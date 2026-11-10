/**
 * RQ4 (RQW §3.4): "에이전트가 쓰는 모양". The engine project's switch (its agents keep spec / plan /
 * tasks in Spec Kit's shape from their next start), what it changes, and the optional official
 * Spec Kit: plan → the owner's consent → install → the result line; uninstall when it is there.
 * Every call goes through authFetch, so a remote device is asked for its step-up on the spot.
 * The state comes with the docs answer (`workflow`); a project the engine does not run gets one line.
 */
import { useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { authFetch } from '../auth/authApi.js';
import { useCanAct } from '../workbench/workbenchStore.js';

export interface WorkflowView {
  engine: boolean;
  on: boolean;
  uv: boolean;
  installed: boolean;
  version: string;
  busy: boolean;
}
interface Plan {
  planId: string;
  version: string;
  integrations: string[];
  skipped: string[];
  files: string[];
  untouched: string[];
}
interface Report {
  ok: boolean;
  files: string[];
  count: number;
  changed: string[];
  failed?: 'exit' | 'timeout';
  lines: string[];
}
type Step =
  | { at: 'idle' }
  | { at: 'plan'; plan: Plan }
  | { at: 'running' }
  | { at: 'done'; report: Report; removed?: boolean }
  | { at: 'uninstall' };

const route = (project: string, tail: string) =>
  `/api/agty/spec/${encodeURIComponent(project)}/${tail}`;

function What({ open }: { open: boolean }) {
  return (
    <details className="rq-fold" open={open} data-testid="reqs-workflow-what">
      <summary>{t('reqs.workflow.what')}</summary>
      <ul className="rq-workflow-list">
        {(['what1', 'what2', 'what3', 'what4', 'what5'] as const).map((k) => (
          <li key={k}>{t(`reqs.workflow.${k}`)}</li>
        ))}
      </ul>
    </details>
  );
}

function ReportLine({ step, version }: { step: Extract<Step, { at: 'done' }>; version: string }) {
  const r = step.report;
  const text = r.changed.length
    ? t('reqs.workflow.changed', { files: r.changed.join(', ') })
    : r.failed
      ? t(r.failed === 'timeout' ? 'reqs.workflow.timeout' : 'reqs.workflow.failed')
      : t(step.removed ? 'reqs.workflow.removed' : 'reqs.workflow.done', {
          count: r.count,
          version,
        });
  return (
    <div
      className="rq-workflow-result"
      data-ok={r.ok || undefined}
      data-testid="reqs-workflow-result"
    >
      <p>{text}</p>
      {!!r.lines.length && <pre className="rq-workflow-pre">{r.lines.join('\n')}</pre>}
      {!!r.files.length && (
        <details className="rq-fold">
          <summary>
            {t('reqs.workflow.files')} {r.count}
          </summary>
          <ul className="rq-workflow-files">
            {r.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function WorkflowBlock({
  project,
  view,
  reload,
  open = false,
}: {
  project: string;
  view: WorkflowView;
  reload: () => void;
  /** The empty screen's button opened it: show the explanation at once. */
  open?: boolean;
}) {
  const canAct = useCanAct();
  const [step, setStep] = useState<Step>({ at: 'idle' });
  const [note, setNote] = useState('');
  if (!view.engine)
    return (
      <p className="rq-muted" data-testid="reqs-workflow-not-engine">
        {t('reqs.workflow.notEngine')}
      </p>
    );

  const fail = (err: unknown) => {
    setNote(err instanceof Error ? err.message : String(err));
    setStep({ at: 'idle' });
  };
  const plan = async () => {
    setNote('');
    try {
      setStep({
        at: 'plan',
        plan: await authFetch<Plan>(route(project, 'workflow/plan'), { method: 'POST', body: {} }),
      });
    } catch (err) {
      fail(err);
    }
  };
  const toggle = async () => {
    const on = !view.on;
    setNote('');
    try {
      const next = await authFetch<WorkflowView>(route(project, 'workflow'), {
        method: 'POST',
        body: { on },
      });
      setNote(t(on ? 'reqs.workflow.on' : 'reqs.workflow.off'));
      reload();
      // Switched on with uv and no Spec Kit yet: show the install plan right away (optional).
      if (on && next.uv && !next.installed) await plan();
    } catch (err) {
      fail(err);
    }
  };
  const install = async (p: Plan) => {
    setStep({ at: 'running' });
    try {
      const report = await authFetch<Report>(route(project, 'workflow/install'), {
        method: 'POST',
        body: { planId: p.planId, consent: true },
      });
      setStep({ at: 'done', report });
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const uninstall = async () => {
    setStep({ at: 'running' });
    try {
      const report = await authFetch<Report>(route(project, 'workflow/uninstall'), {
        method: 'POST',
        body: {},
      });
      setStep({ at: 'done', report, removed: true });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <section className="rq-workflow" data-testid="reqs-workflow" data-on={view.on || undefined}>
      <label className="rq-workflow-switch">
        <button
          type="button"
          role="switch"
          aria-checked={view.on}
          className="rq-switch"
          disabled={!canAct || step.at === 'running'}
          onClick={() => void toggle()}
          data-testid="reqs-workflow-switch"
        >
          <span className="rq-switch-track">
            <i />
          </span>
        </button>
        <span>{t('reqs.workflow.switch')}</span>
      </label>
      <What open={open} />
      {note && (
        <p className="rq-muted" data-testid="reqs-workflow-note">
          {note}
        </p>
      )}
      {view.on && step.at === 'idle' && (
        <div className="rq-workflow-line" data-testid="reqs-workflow-kit">
          {view.installed ? (
            <>
              <p className="rq-muted">{t('reqs.workflow.installed')}</p>
              {canAct && (
                <Button
                  size="sm"
                  onClick={() => setStep({ at: 'uninstall' })}
                  data-testid="reqs-workflow-uninstall"
                >
                  {t('reqs.workflow.uninstall')}
                </Button>
              )}
            </>
          ) : view.uv ? (
            <>
              {canAct && (
                <Button
                  size="sm"
                  onClick={() => void plan()}
                  disabled={view.busy}
                  data-testid="reqs-workflow-install"
                >
                  {t('reqs.workflow.install', { version: view.version })}
                </Button>
              )}
              <p className="rq-muted">{t('reqs.workflow.installNote')}</p>
            </>
          ) : (
            <p className="rq-muted" data-testid="reqs-workflow-no-uv">
              {t('reqs.workflow.noUv')}
            </p>
          )}
        </div>
      )}
      {step.at === 'plan' && (
        <div className="rq-workflow-plan" data-testid="reqs-workflow-plan">
          <h4>{t('reqs.workflow.planTitle', { version: step.plan.version })}</h4>
          <p>{t('reqs.workflow.planFor', { agents: step.plan.integrations.join(', ') })}</p>
          <ul className="rq-workflow-files" data-testid="reqs-workflow-plan-files">
            {step.plan.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          {!!step.plan.skipped.length && (
            <p className="rq-muted">
              {t('reqs.workflow.planSkipped', { agents: step.plan.skipped.join(', ') })}
            </p>
          )}
          <p>{t('reqs.workflow.planUntouched')}</p>
          <ul className="rq-workflow-files" data-testid="reqs-workflow-plan-untouched">
            {step.plan.untouched.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="rq-muted">{t('reqs.workflow.planHow', { version: step.plan.version })}</p>
          <div className="flex gap-8 flex-wrap">
            <Button
              size="sm"
              variant="accent"
              onClick={() => void install(step.plan)}
              data-testid="reqs-workflow-consent"
            >
              {t('reqs.workflow.consent')}
            </Button>
            <Button
              size="sm"
              onClick={() => setStep({ at: 'idle' })}
              data-testid="reqs-workflow-cancel"
            >
              {t('reqs.workflow.cancel')}
            </Button>
          </div>
        </div>
      )}
      {step.at === 'uninstall' && (
        <div className="rq-workflow-plan" data-testid="reqs-workflow-uninstall-ask">
          <p>{t('reqs.workflow.uninstallNote')}</p>
          <div className="flex gap-8 flex-wrap">
            <Button
              size="sm"
              variant="accent"
              onClick={() => void uninstall()}
              data-testid="reqs-workflow-uninstall-yes"
            >
              {t('reqs.workflow.uninstallConfirm')}
            </Button>
            <Button size="sm" onClick={() => setStep({ at: 'idle' })}>
              {t('reqs.workflow.cancel')}
            </Button>
          </div>
        </div>
      )}
      {step.at === 'running' && (
        <p className="rq-muted" data-testid="reqs-workflow-running">
          {t('reqs.workflow.running')}
        </p>
      )}
      {step.at === 'done' && <ReportLine step={step} version={view.version} />}
    </section>
  );
}
