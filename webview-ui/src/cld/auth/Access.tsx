import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { t, useLanguage } from '../../i18n/index.js';
import { writeClipboardText } from '../../terminal/clipboard.js';
import { openExternal } from '../externalLinks.js';
import { useCldStore } from '../officeStore.js';
import { serverLine } from '../serverText.js';
import { AddDeviceButton, OutsideDeviceInvite } from './AddDevice.js';
import { type AdminSetup,canRunAdminSetup, runAdminSetup } from './adminSetup.js';
import { authFetch, type Me } from './authApi.js';
import { CustomAddressCard, type CustomStatus } from './CustomAddress.js';
import type { ConnectorStatus } from './Remote.js';

type Connector = ConnectorStatus['connector'];
type Choice = 'local' | 'lan' | 'direct' | 'ssh' | 'duckdns' | 'tailscale' | 'funnel' | 'tunnel';
type Via = 'local' | 'lan' | 'direct' | 'tailscale' | 'funnel' | 'tunnel';
type Action = { kind: 'open'; url: string; label: string } | { kind: 'copy'; text: string; label: string };
interface Step {
  ok: boolean;
  text: string;
  /** A further line (a reason, a session seen, the next thing to do). */
  fix?: string;
  /** A typed Windows administrator action; the desktop app builds its own PowerShell. */
  admin?: AdminSetup;
  guide?: string;
  actions?: Action[];
  suggest?: Choice;
  /** The person says they ran `actions`: nothing on this PC can read the rule back. */
  confirm?: boolean;
  /** Passed, but not checkable from this PC. */
  unknown?: boolean;
}
interface SetupResult {
  ok: boolean;
  steps: Step[];
  url?: string;
  connector?: Connector | 'duckdns' | 'funnel' | 'tunnel';
  pending?: boolean;
  test?: { checkedAt: number; steps?: Step[] };
}
interface AccessStatus extends ConnectorStatus {
  setup?: SetupResult | null;
  remoteTest?: { ok: boolean; checkedAt: number; url: string; steps?: Step[] } | null;
  maySetup: boolean;
  /** The card O6 and the other changes: this device may change connectors. */
  mayAct?: boolean;
  custom?: CustomStatus | null;
  start: boolean;
  direct: (NonNullable<ConnectorStatus['direct']> & { name: string | null; ip: string | null }) | null;
  ssh?: { port: number; open: boolean; banner: string; user: string };
  tailscale?: { host: string; serving: { host: string; funnel: boolean } | null } | null;
}
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
const OPTIONS: Choice[] = ['local', 'direct', 'ssh', 'duckdns', 'tailscale', 'funnel', 'tunnel', 'lan'];
/** Targets that keep the current connection until their outside check passed. */
const REMOTE_TARGETS: Choice[] = ['direct', 'duckdns', 'tailscale', 'funnel', 'tunnel'];
const outsideOf = (status: AccessStatus) =>
  status.remoteTest?.ok ? status.remoteTest.url : status.direct?.enabled ? status.direct.url : null;

function StepActions({ steps, onSuggest, onAdminSuccess, suggestKey = 'access.otherMethod', testId = 'access-steps' }: {
  steps: Step[];
  onSuggest: (choice: Choice) => void;
  onAdminSuccess?: () => Promise<void>;
  suggestKey?: 'access.otherMethod' | 'access.existing.go';
  testId?: string;
}) {
  const [copied, setCopied] = useState('');
  const [adminMessage, setAdminMessage] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const runAdmin = async (request: AdminSetup) => {
    setAdminBusy(true);
    setAdminMessage('');
    try {
      const result = await runAdminSetup(request);
      if (result.canceled) setAdminMessage(t('access.admin.canceled'));
      else if (!result.ok) setAdminMessage(t('access.admin.failed', { code: result.exitCode }));
      else await onAdminSuccess?.();
    } catch {
      setAdminMessage(t('access.admin.error'));
    } finally { setAdminBusy(false); }
  };
  return <ul className="m-0 p-0 list-none flex flex-col gap-6 text-xs" data-testid={testId}>
    {steps.map((step, index) => <li key={index} className="flex flex-col gap-3">
      <span className={step.ok ? 'text-accent-text' : 'text-text'}>{step.unknown ? '?' : step.ok ? '✔' : '✖'} {serverLine(step.text)}</span>
      {step.fix && <p className="m-0 whitespace-pre-wrap text-text-muted">{step.fix.split('\n').map(serverLine).join('\n')}</p>}
      {step.guide && <p className="m-0 whitespace-pre-wrap text-text-muted">{step.guide.split('\n').map(serverLine).join('\n')}</p>}
      {step.admin && canRunAdminSetup() && <div className="flex flex-col gap-3">
        <Button size="sm" variant="accent" disabled={adminBusy} onClick={() => void runAdmin(step.admin!)} data-testid="access-run-admin">{t('access.admin.run')}</Button>
        {adminMessage && <p className="m-0 text-xs text-red-400" role="alert">{adminMessage}</p>}
      </div>}
      {(step.actions ?? []).map((action, item) => <div key={item} className="flex flex-col gap-3">
        {action.kind === 'copy' && <pre className="m-0 p-6 text-xs bg-bg-dark border border-border whitespace-pre-wrap break-all select-text" data-testid="access-commands">{action.text}</pre>}
        <Button size="sm" onClick={() => {
          if (action.kind === 'open') openExternal(action.url);
          else void writeClipboardText(action.text).then(() => setCopied(action.label));
        }}>{copied === action.label ? t('access.copied') : serverLine(action.label)}</Button>
      </div>)}
      {step.suggest && <Button size="sm" variant="accent" onClick={() => onSuggest(step.suggest!)}>{t(suggestKey, { name: t(`access.card.${step.suggest}.title`) })}</Button>}
    </li>)}
  </ul>;
}

export function AccessPanel({ onSwitched }: { onSwitched?: (to: Connector) => void }) {
  const language = useLanguage();
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Choice | null>(null);
  const [run, setRun] = useState<SetupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<{ choice: Choice; until: number; confirmCut: boolean } | null>(null);
  /** S6: the server asked first — this change would cut the page's own connection. */
  const [cut, setCut] = useState<{ choice: Choice; via: Via } | null>(null);
  /** LAN is deliberately a second, informed choice before opening a listener. */
  const [lanWarning, setLanWarning] = useState(false);
  const [duckdnsName, setDuckdnsName] = useState('');
  const [duckdnsToken, setDuckdnsToken] = useState('');
  /** Ways in this PC already has (a read-only scan, once per open); null while it runs. */
  const [existing, setExisting] = useState<Step[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [loaded, identity] = await Promise.all([
        authFetch<AccessStatus>('/api/cld/connector?access=1'),
        authFetch<Me>('/api/auth/me'),
      ]);
      setStatus(loaded);
      setMe(identity);
      setError('');
      return { loaded, identity };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    authFetch<{ found: Step[] }>('/api/cld/connector/existing').then((r) => setExisting(r.found), () => setExisting([]));
  }, []);

  const move = useCallback(async () => {
    try {
      const { url } = await authFetch<{ url: string }>('/api/auth/move-code', { method: 'POST' });
      window.location.assign(url);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);

  const setup = useCallback(async (choice: Choice, retry = false, confirmCut = false, firewallDone = false) => {
    setSelected(choice);
    setBusy(true);
    setRun({ ok: false, steps: [{ ok: true, text: t('access.checking') }] });
    try {
      const result = await authFetch<SetupResult>('/api/cld/connector/setup', {
        method: 'POST', body: { choice, ...(confirmCut ? { confirmCut: true } : {}), ...(firewallDone ? { firewallDone: true } : {}), ...(choice === 'duckdns' && duckdnsName && duckdnsToken ? { duckdnsName, duckdnsToken } : {}) },
      });
      setRun(result);
      if (result.pending) setWaiting((previous) => previous?.choice === choice && retry ? previous : { choice, until: Date.now() + 15 * 60_000, confirmCut });
      else setWaiting(null);
      if (result.ok && result.connector && result.connector !== 'tunnel')
        onSwitched?.(result.connector === 'duckdns' ? 'direct' : result.connector === 'funnel' ? 'tailscale' : result.connector);
      const fresh = await load();
      // This page's own connection closes in a few seconds: move only with the server-approved target.
      if (confirmCut && result.ok) {
        if (fresh?.identity.moveTo && fresh.identity.deviceId && new URL(fresh.identity.moveTo).origin !== window.location.origin)
          await move();
      }
    } catch (err) {
      const answer = err as Error & { status?: number; data?: { error?: string; via?: Via } };
      if (answer.status === 409 && answer.data?.error === 'cut') {
        setCut({ choice, via: answer.data.via ?? 'local' });
        setRun(null);
        setWaiting(null);
        return;
      }
      setRun({ ok: false, steps: [{ ok: false, text: err instanceof Error ? err.message : String(err) }] });
      setWaiting(null);
    } finally { setBusy(false); }
  }, [duckdnsName, duckdnsToken, load, move, onSwitched]);

  useEffect(() => {
    if (!waiting || busy) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() >= waiting.until) { setWaiting(null); return; }
      void setup(waiting.choice, true, waiting.confirmCut);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [waiting, busy, setup]);

  const moveTo = (choice: Choice) => {
    setRun(null);
    setWaiting(null);
    setSelected(choice);
    document.getElementById(`access-choice-${choice}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  if (!status) return <p className="m-0 px-10 pb-10 text-sm" data-testid="access-panel">{error || t('access.loading')}</p>;
  const outside = outsideOf(status);
  const canMove = !!me?.moveTo && !!me.deviceId && new URL(me.moveTo).origin !== window.location.origin;
  const active = (choice: Choice) =>
    choice === 'duckdns' ? status.connector === 'direct' && !!status.direct?.name :
    choice === 'direct' ? status.connector === 'direct' && !status.direct?.name :
    choice === 'tunnel' ? !!status.remoteTest?.ok && status.remoteTest.url.includes('trycloudflare.com') :
    choice === 'tailscale' ? status.connector === 'tailscale' && !status.tailscale?.serving?.funnel :
    choice === 'funnel' ? status.connector === 'tailscale' && !!status.tailscale?.serving?.funnel :
    choice === 'ssh' ? false : status.connector === choice;

  return <div className="px-10 pb-10 flex flex-col gap-10 max-w-[860px]" data-testid="access-panel">
    <p className="m-0 text-sm">{t('access.current')} <b data-testid="access-current">{t(`access.connector.${status.connector}`)}</b> · <span className="break-all text-text-muted">{status.canonicalUrl}</span></p>
    <section className="flex flex-col gap-5 p-8 border-2 border-accent" data-testid="access-one-click">
      <h3 className="m-0 text-base">{t('access.outside.title')}</h3>
      <p className="m-0 text-sm">{t('access.outside.help')}</p>
      {outside && <div className="flex flex-col gap-4 text-xs">
        <p className="m-0 text-accent-text">{t('access.outside.address')} <a href={outside} className="break-all">{outside}</a></p>
        {status.remoteTest?.ok && !status.remoteTest.steps?.some((step) => step.unknown) && <p className="m-0 text-accent-text" role="status">{t('access.outside.verified', { time: new Date(status.remoteTest.checkedAt).toLocaleTimeString(language === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) })}</p>}
        <OutsideDeviceInvite targetUrl={outside} />
      </div>}
      {canMove && <Button size="sm" variant="accent" onClick={() => void move()}>{t('access.outside.move')}</Button>}
      {error && <p className="m-0 text-xs text-red-400" role="alert">{error}</p>}
    </section>
    {!!existing?.length && <section className="flex flex-col gap-5 p-8 border-2 border-border" data-testid="access-existing">
      <h3 className="m-0 text-base">{t('access.existing.title')}</h3>
      <p className="m-0 text-xs text-text-muted">{t('access.existing.help')}</p>
      <StepActions steps={existing} onSuggest={moveTo} suggestKey="access.existing.go" testId="access-existing-list" />
    </section>}
    <div className="grid gap-8 grid-cols-1 md:grid-cols-2">
      {OPTIONS.map((option) => <section id={`access-choice-${option}`} key={option}
        data-selected={selected === option}
        className={`flex flex-col gap-5 p-8 border-2 min-w-0 ${active(option) ? 'border-accent' : 'border-border'}`}
        data-testid={`access-card-${option}`}>
        <div className="flex items-center gap-5"><h3 className="m-0 text-base flex-1">{t(`access.card.${option}.title`)}</h3>{(option === 'duckdns' || option === 'tailscale') && <span className="text-xs text-accent-text">{t('access.recommended')}</span>}{active(option) && <span className="text-xs text-accent-text">{t('access.inUse')}</span>}</div>
        <p className="m-0 text-sm">{t(`access.card.${option}.detail`)}</p>
        <p className="m-0 text-xs text-text-muted">{t('access.requirements')} {t(`access.card.${option}.needs`)}</p>
        <p className="m-0 text-xs" data-testid={`access-state-${option}`}>
          {option === 'direct' && status.direct?.enabled ? t('access.enabled', { address: status.direct.url ?? '' }) :
           option === 'ssh' ? (status.ssh?.open ? t('access.ssh.responded', { banner: status.ssh.banner || 'SSH' }) : t('access.ssh.check')) :
           option === 'tailscale' ? (status.tailscale?.serving && !status.tailscale.serving.funnel ? t('access.enabled', { address: `https://${status.tailscale.serving.host}/` }) : t('access.notConfigured')) :
           option === 'funnel' ? (status.tailscale?.serving?.funnel ? t('access.enabled', { address: `https://${status.tailscale.serving.host}/` }) : t('access.notConfigured')) :
           active(option) ? t('access.inUse') : t('access.available')}
        </p>
        {option === 'funnel' && <p className="m-0 text-xs text-red-400" data-testid="access-funnel-warning">{t('access.funnel.warning')}</p>}
        {option === 'local' && <AddDeviceButton label={t('access.device.qr')} zIndex={70} />}
        {/* Registering a device never touches the connector; turning remote off is its own, guarded action. */}
        {option === 'local' && status.maySetup && <Button size="sm" variant={active(option) ? 'active' : 'default'} disabled={busy} onClick={() => void setup('local')}>{t('access.local.switch')}</Button>}
        {option === 'duckdns' && <div className="flex flex-col gap-3">
          <input aria-label={t('access.duckdns.subdomain')} placeholder="myoffice.duckdns.org" value={duckdnsName} onChange={(e) => setDuckdnsName(e.target.value)} className="bg-bg-dark border border-border p-4 text-xs" />
          <input aria-label={t('access.duckdns.token')} type="password" placeholder={t('access.duckdns.token')} value={duckdnsToken} onChange={(e) => setDuckdnsToken(e.target.value)} className="bg-bg-dark border border-border p-4 text-xs" />
        </div>}
        {option === 'tailscale' && <div className="flex flex-wrap gap-4">
          <Button size="sm" onClick={() => openExternal('https://tailscale.com/download/ios')}>{t('access.tailscale.ios')}</Button>
          <Button size="sm" onClick={() => openExternal('https://tailscale.com/download/android')}>{t('access.tailscale.android')}</Button>
        </div>}
        {option === 'lan' && status.maySetup && <Button size="sm" variant={active(option) ? 'active' : 'accent'} disabled={busy} onClick={() => setLanWarning(true)} aria-label={`${t('access.card.lan.title')} — ${t('access.openWith')}`}>{t('access.openWith')}</Button>}
        {option !== 'local' && option !== 'lan' && status.maySetup && <Button size="sm" variant={active(option) ? 'active' : 'accent'} disabled={busy} onClick={() => void setup(option)} aria-label={`${t(`access.card.${option}.title`)} — ${t('access.openWith')}`}>{t('access.openWith')}</Button>}
        {selected === option && run && <div className="flex flex-col gap-5" data-testid={`access-run-${option}`}>
          <StepActions steps={run.steps} onSuggest={moveTo} onAdminSuccess={() => setup(option, true)} />
          {run.pending && <Button size="sm" disabled={busy} onClick={() => void setup(option, true)}>{t('access.recheck')}</Button>}
          {run.steps.at(-1)?.confirm && <Button size="sm" variant="accent" disabled={busy} onClick={() => void setup(option, false, false, true)}>{t('access.firewallDone')}</Button>}
          {run.ok && run.test && !run.test.steps?.some((step) => step.unknown) && <p className="m-0 text-xs text-accent-text" role="status">{t('access.outside.verified', { time: new Date(run.test.checkedAt).toLocaleTimeString(language === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) })} · {run.url}</p>}
        </div>}
      </section>)}
      <CustomAddressCard key={status.custom?.url ?? ''} custom={status.custom ?? null} mayAct={status.mayAct === true} onChanged={load} />
    </div>
    {cut && <Modal isOpen onClose={() => setCut(null)} title={t('access.cut.title')} zIndex={80}>
      <div className="px-10 pb-10 flex flex-col gap-8 text-sm max-w-[480px]" data-testid="access-cut">
        <p className="m-0">{t('access.cut.body', { name: t(`access.via.${cut.via}`) })}</p>
        {REMOTE_TARGETS.includes(cut.choice) && <p className="m-0 text-text-muted">{t('access.cut.remote')}</p>}
        <div className="flex flex-wrap gap-6 justify-end">
          <Button size="sm" onClick={() => setCut(null)}>{t('access.cut.keep')}</Button>
          <Button size="sm" variant="accent" onClick={() => { const { choice } = cut; setCut(null); void setup(choice, false, true); }}>{t('access.cut.confirm')}</Button>
        </div>
      </div>
    </Modal>}
    {lanWarning && <Modal isOpen onClose={() => setLanWarning(false)} title={t('access.lanWarning.title')} zIndex={80}>
      <div className="px-10 pb-10 flex flex-col gap-8 text-sm max-w-[480px]" data-testid="access-lan-warning">
        <p className="m-0">{t('access.lanWarning.body')}</p>
        <p className="m-0 text-text-muted">{t('access.lanWarning.prefer')}</p>
        <div className="flex flex-wrap gap-6 justify-end">
          <Button size="sm" onClick={() => setLanWarning(false)}>{t('access.lanWarning.cancel')}</Button>
          <Button size="sm" variant="accent" disabled={busy} onClick={() => { setLanWarning(false); void setup('lan'); }}>{t('access.lanWarning.confirm')}</Button>
        </div>
      </div>
    </Modal>}
  </div>;
}

/** 설정 → 접속 방식. */
export function AccessButton() {
  const [open, setOpen] = useState(false);
  return <>
    <Button size="sm" onClick={() => setOpen(true)}>{t('access.open')}</Button>
    {open && <Modal isOpen onClose={() => setOpen(false)} title={t('access.title')} zIndex={62}><AccessPanel /></Modal>}
  </>;
}

/** The host's first open on localhost, before choosing a connection. */
export function AccessStart() {
  const [open, setOpen] = useState(false);
  // Owner 10-27: without Claude Code the install notice comes first; this grew over it and took its clicks.
  const waitingForCli = useCldStore().agentCli !== null;
  useEffect(() => {
    if (!LOOPBACK.test(window.location.hostname)) return;
    authFetch<AccessStatus>('/api/cld/connector').then((s) => setOpen(s.start && s.maySetup), () => undefined);
  }, []);
  if (!open || waitingForCli) return null;
  const later = () => {
    setOpen(false);
    void authFetch('/api/cld/connector/chosen', { method: 'POST', body: {} }).catch(() => undefined);
  };
  return <Modal isOpen onClose={later} title={t('access.start.title')} zIndex={62}>
    <p className="m-0 px-10 pb-6 text-sm">{t('access.start.help')}</p>
    <AccessPanel />
    <div className="px-10 pb-10 flex justify-end"><Button size="sm" onClick={later}>{t('access.later')}</Button></div>
  </Modal>;
}
