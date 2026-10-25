/**
 * D3b, the 작업실's 에이전트 tab: 'Lead 로' on a Worker's row (a confirmation that
 * says what changes, with the old Lead's choice) and the "+ Worker" form. Both are
 * engine actions (engineStore: one request per agent, the step-up retry, a toast);
 * the form also shows the engine's refusal itself.
 */
import { useEffect, useState } from 'react';

import type { EngineProject } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { engineSubmit, useEngineStore } from '../engineStore.js';
import {
  emptyWorkerForm,
  workerFields,
  type WorkerForm,
  workerFormError,
  workerProviders,
} from './workbench.js';

const button =
  'border border-border px-8 py-4 text-xs hover:bg-border disabled:opacity-50 disabled:cursor-default pointer-coarse:min-h-44';
const input = 'w-full border border-border bg-black/20 px-8 py-4 text-sm';
const send = (action: 'add' | 'promote', name: string, fields: Record<string, unknown>) =>
  engineSubmit((m) => transport.send(m), transport.state === 'connected', action, name, fields);

/** 'Lead 로' on a Worker's row, and its confirmation. */
export function PromoteButton({ name, project }: { name: string; project: string }) {
  const { busy } = useEngineStore();
  const [open, setOpen] = useState(false);
  const [oldLead, setOldLead] = useState<'worker' | 'stop'>('worker');
  return (
    <>
      <button
        type="button"
        className={button}
        disabled={busy[name] !== undefined}
        onClick={() => setOpen(true)}
      >
        {t('engine.action.promote')}
      </button>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={t('workbench.promote.title', { name })}
        zIndex={62}
      >
        <div
          className="px-10 pb-8 space-y-8 w-[min(420px,calc(100vw-48px))]"
          role="alertdialog"
          aria-label={t('workbench.promote.title', { name })}
        >
          <p className="text-sm">{t('workbench.promote.question', { name, project })}</p>
          {(['worker', 'stop'] as const).map((v) => (
            <label key={v} className="flex gap-4 items-center text-sm">
              <input
                type="radio"
                name="old-lead"
                checked={oldLead === v}
                onChange={() => setOldLead(v)}
              />
              {v === 'worker' ? t('workbench.promote.keep', { name }) : t('workbench.promote.stop')}
            </label>
          ))}
          <p className="text-xs text-text-muted break-words">
            {t('workbench.promote.note', { name, project })}
          </p>
          <div className="flex justify-end gap-8 mt-8">
            <Button
              variant="accent"
              size="sm"
              onClick={() => {
                setOpen(false);
                send('promote', name, { oldLead });
              }}
            >
              {t('workbench.promote.confirm')}
            </Button>
            <Button size="sm" onClick={() => setOpen(false)} autoFocus>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/** "+ Worker": a Worker of `project`, with the choices the installed CLI lists. */
export function AddWorker({ project }: { project: string }) {
  const { state, busy, toast } = useEngineStore();
  const engine: EngineProject[] = state?.projects ?? [];
  const folder = engine.find((p) => p.name === project && !p.role)?.folder ?? '';
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<WorkerForm>(() => emptyWorkerForm(folder));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // The answer: a refusal shows here; success closes the form.
  useEffect(() => {
    if (!pending || busy[pending]) return;
    if (toast?.name === pending && toast.tone === 'error') setError(toast.text);
    else setOpen(false);
    setPending(null);
  }, [pending, busy, toast]);
  // D5: Claude or Codex, among those installed here; the picker only when there are both.
  const providers = workerProviders(state?.agentChoices);
  const codex = f.provider === 'codex';
  const choices = state?.agentChoices?.[f.provider];
  const choice = (key: 'model' | 'effort' | 'permissionMode', label: string, ids: string[] = []) => (
    <label className="block text-xs">
      {label}
      <select
        className={input}
        value={f[key]}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
      >
        <option value="">{t(codex ? 'workbench.worker.codexDefault' : 'workbench.worker.default')}</option>
        {ids.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );
  const submit = () => {
    const err = workerFormError(f, engine);
    if (err) return setError(err);
    const name = f.name.trim();
    setError(null);
    setPending(name);
    send('add', name, workerFields(f, project, folder));
  };
  return (
    <>
      <button
        type="button"
        className={button}
        onClick={() => {
          setF(emptyWorkerForm(folder));
          setError(null);
          setOpen(true);
        }}
      >
        {t('workbench.addWorker')}
      </button>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={t('workbench.addWorkerTitle', { project })}
        zIndex={60}
      >
        <form
          className="space-y-8 px-10 pb-10 w-[min(420px,calc(100vw-48px))]"
          aria-label={t('workbench.addWorkerTitle', { project })}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {providers.length > 1 && (
            <label className="block text-xs">
              {t('workbench.worker.agent')}
              <select
                className={input}
                value={f.provider}
                data-testid="worker-provider"
                onChange={(e) => {
                  const provider = e.target.value as WorkerForm['provider'];
                  // A Codex Worker without a folder works in a task worktree per Task: start empty.
                  setF({ ...emptyWorkerForm(provider === 'codex' ? '' : folder, provider), name: f.name, role: f.role });
                }}
              >
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {t(`workbench.provider.${p}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-xs">
            {t('workbench.worker.name')}
            <input
              className={input}
              value={f.name}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => {
                setF({ ...f, name: e.target.value });
                setError(null);
              }}
            />
          </label>
          <label className="block text-xs">
            {t('workbench.worker.role')}
            <select
              className={input}
              value={f.role}
              onChange={(e) => setF({ ...f, role: e.target.value as WorkerForm['role'] })}
            >
              <option value="worker">{t('workbench.role.worker')}</option>
              <option value="reviewer">{t('workbench.role.reviewer')}</option>
            </select>
          </label>
          <label className="block text-xs">
            {t('workbench.worker.folder')}
            <input
              className={input}
              value={f.folder}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setF({ ...f, folder: e.target.value })}
            />
            <span className="text-text-muted">
              {t(codex ? 'workbench.worker.folderHelpCodex' : 'workbench.worker.folderHelp')}
            </span>
          </label>
          {choice('model', t('workbench.worker.model'), choices?.models)}
          {choice('effort', t('workbench.worker.effort'), choices?.efforts)}
          {!codex && choice('permissionMode', t('workbench.worker.permissionMode'), choices?.permissionModes)}
          {error && (
            <p role="alert" className="text-xs text-red-400 break-words">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-8">
            <Button
              size="sm"
              variant="accent"
              type="submit"
              className="disabled:opacity-(--btn-disabled-opacity) disabled:cursor-default"
              disabled={pending !== null}
            >
              {pending ? t('workbench.worker.adding') : t('workbench.worker.add')}
            </Button>
            <Button size="sm" type="button" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
