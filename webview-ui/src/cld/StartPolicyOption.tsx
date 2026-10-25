/**
 * 설정's start-and-recovery section (R3): when the office starts (the start policy, R1 + P6), what is in
 * place for it (logon task, linger, WSL apart from the daemon), and how agents come back. The policy is
 * changed by the daemon through the installer manager; a remote device is asked for its step-up by
 * authFetch. linger is never turned on without asking here first.
 */
import { useEffect, useState } from 'react';

import type { Coded } from '../../../core/src/cld/serverText.js';
import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { authFetch } from './auth/authApi.js';
import { useEngineStore } from './engineStore.js';
import { timeAgo } from './format.js';
import { serverText } from './serverText.js';

const POLICIES = ['on-demand', 'always', 'manual'] as const;
type Policy = (typeof POLICIES)[number];
const POLICY_KEY = { 'on-demand': 'onDemand', always: 'always', manual: 'manual' } as const;

/** GET /api/cld/start-policy (server/src/cld/startPolicy.ts). */
interface StartPolicyView {
  platform: string;
  blocked: (Coded & { error: string }) | null;
  policy: Policy | null;
  service: { name: string; kind: string } | null;
  logonTask: { name: string | null; present: boolean | null } | null;
  linger: { user: string; on: boolean; ours: boolean } | null;
  wsl: { distro: string; systemd: boolean } | null;
  daemon: { pid: number; startedAt: string; version: string | null };
  canChange: boolean;
}

/** `always` needs linger on systemd and it is not on: ask before turning it on. */
const lingerMissing = (v: StartPolicyView) => !!v.linger && !v.linger.on;

export function StartPolicyOption() {
  const [view, setView] = useState<StartPolicyView | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const engine = useEngineStore();

  useEffect(() => {
    authFetch<StartPolicyView>('/api/cld/start-policy', { noStepUp: true }).then(setView, () =>
      undefined,
    );
  }, []);
  if (!view) return null;

  const change = async (policy: Policy, linger = false) => {
    setAsking(false);
    setBusy(true);
    setNote('');
    try {
      const r = await authFetch<{ view: StartPolicyView }>('/api/cld/start-policy', {
        method: 'POST',
        body: { policy, linger },
      });
      setView(r.view);
      setNote(t('startPolicy.changed', { policy: t(`startPolicy.${POLICY_KEY[policy]}`) }));
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const choose = (policy: Policy) => {
    if (policy === 'always' && lingerMissing(view)) setAsking(true);
    else void change(policy);
  };

  const projects = engine.state?.projects ?? [];
  const alwaysOn = projects.filter((p) => p.alwaysOn).map((p) => p.name);
  const leftDown = projects.filter((p) => p.downNote).map((p) => p.name);
  const always = view.policy === 'always';
  const yesNo = (on: boolean) => t(on ? 'settings.on' : 'settings.off');

  return (
    <div className="space-y-4" data-testid="start-policy-option">
      <p className="text-base">{t('startPolicy.title')}</p>
      <p className="text-sm text-text-muted">{t('startPolicy.help')}</p>
      {view.blocked ? (
        <p className="text-sm text-yellow-300" data-testid="start-policy-blocked">
          {serverText(view.blocked)}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-4" role="group" aria-label={t('startPolicy.title')}>
            {POLICIES.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={view.policy === p ? 'active' : 'default'}
                aria-pressed={view.policy === p}
                disabled={!view.canChange || busy || view.policy === p}
                data-policy={p}
                onClick={() => choose(p)}
              >
                {t(`startPolicy.${POLICY_KEY[p]}`)}
              </Button>
            ))}
          </div>
          {view.policy && (
            <p className="text-sm text-text-muted">
              {t(`startPolicy.${POLICY_KEY[view.policy]}.help`)}
            </p>
          )}
          {!view.canChange && (
            <p className="text-sm text-text-muted">{t('startPolicy.cannotChange')}</p>
          )}
        </>
      )}
      {asking && (
        <div className="border-2 border-border p-6 space-y-4" data-testid="start-policy-linger-ask">
          <p className="text-sm">{t('startPolicy.lingerAsk', { user: view.linger?.user ?? '' })}</p>
          <div className="flex flex-wrap gap-4">
            <Button size="sm" variant="accent" onClick={() => void change('always', true)}>
              {t('startPolicy.lingerYes')}
            </Button>
            <Button size="sm" onClick={() => void change('always', false)}>
              {t('startPolicy.lingerNo')}
            </Button>
            <Button size="sm" onClick={() => setAsking(false)}>
              {t('stepup.cancel')}
            </Button>
          </div>
        </div>
      )}
      <ul className="m-0 pl-0 list-none text-sm text-text-muted space-y-2" data-testid="start-policy-facts">
        <li>
          {t('startPolicy.daemon', {
            version: view.daemon.version ?? '?',
            pid: view.daemon.pid,
            started: timeAgo(view.daemon.startedAt),
          })}
        </li>
        {view.wsl && (
          <li>{t('startPolicy.wsl', { distro: view.wsl.distro || '?', systemd: yesNo(view.wsl.systemd) })}</li>
        )}
        {view.service && (
          <li>{t('startPolicy.service', { name: view.service.name, kind: view.service.kind })}</li>
        )}
        {view.logonTask && (
          <li>
            {t(
              view.logonTask.present === null
                ? 'startPolicy.task.unknown'
                : view.logonTask.present
                  ? 'startPolicy.task.present'
                  : 'startPolicy.task.absent',
              { name: view.logonTask.name ?? '' },
            )}
          </li>
        )}
        {view.linger && (
          <li>
            {t(
              !view.linger.on
                ? 'startPolicy.linger.off'
                : view.linger.ours
                  ? 'startPolicy.linger.ours'
                  : 'startPolicy.linger.on',
            )}
          </li>
        )}
      </ul>
      {always && view.logonTask?.present === false && (
        <div className="space-y-2" data-testid="start-policy-task-missing">
          <p className="text-sm text-yellow-300">{t('startPolicy.taskMissing')}</p>
          {view.canChange && (
            <Button size="sm" disabled={busy} onClick={() => choose('always')}>
              {t('startPolicy.retry')}
            </Button>
          )}
        </div>
      )}
      {always && view.linger && !view.linger.on && (
        <div className="space-y-2" data-testid="start-policy-no-linger">
          <p className="text-sm text-yellow-300">
            {t('startPolicy.noLinger', { user: view.linger.user })}
          </p>
          {view.canChange && !asking && (
            <Button size="sm" disabled={busy} onClick={() => setAsking(true)}>
              {t('startPolicy.lingerYes')}
            </Button>
          )}
        </div>
      )}
      {note && (
        <p className="text-sm" role="status" data-testid="start-policy-note">
          {note}
        </p>
      )}
      <p className="text-base pt-4">{t('startPolicy.recovery')}</p>
      <ul className="m-0 pl-0 list-none text-sm text-text-muted space-y-2" data-testid="start-policy-recovery">
        <li>{t('startPolicy.recovery.auto')}</li>
        <li>
          {alwaysOn.length
            ? t('startPolicy.recovery.alwaysOn', { names: alwaysOn.join(', ') })
            : t('startPolicy.recovery.alwaysOnNone')}
        </li>
        {leftDown.length > 0 && (
          <li className="text-yellow-300">
            {t('startPolicy.recovery.leftDown', { names: leftDown.join(', ') })}
          </li>
        )}
      </ul>
    </div>
  );
}
