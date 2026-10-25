import { useEffect, useState } from 'react';

import { defaultProjectFolder, normalizeProjectPath } from '../../../core/src/cld/projectPath.js';
import type { EngineProject } from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { t } from '../i18n/index.js';
import { transport } from '../transport/index.js';
import type { EngineForm } from './engine.js';
import {
  baseName,
  engineConfirmText,
  engineLabel,
  formError,
  formFields,
  formFor,
  rulesFileLabel,
  sessionActions,
} from './engine.js';
import {
  engineAsk,
  engineCancel,
  engineCloseForm,
  engineConfirm,
  engineConnectionLost,
  engineDismissToast,
  engineOpenForm,
  engineSubmit,
  useEngineStore,
} from './engineStore.js';
import { FloatingToast } from './FloatingToast.js';
import { FolderPicker } from './FolderPicker.js';
import { ImportProjects } from './ImportProjects.js';
import { useCldStore } from './officeStore.js';
import { serverLine } from './serverText.js';

/** The operations room (server OPS_ROOM): environment work, not a product or a personal project (user 10-22 17:05). */
// Canonical server room name; the server's room identifiers are not localized.
const OPS_ROOM = String.fromCodePoint(0xad00, 0xb9ac, 0xc2e4);

const input = 'w-full border border-border bg-black/20 px-8 py-4 text-sm';
const OFFICES_LIST = 'cld-offices';
const CUSTOM = '__custom__';

function useCanAct(): boolean {
  const { officeSnapshot: officeState, officeReadOnly } = useCldStore();
  return officeState?.readOnly === false && !officeReadOnly;
}

/** An engine project's card row: 켜기 / 끄기 / 재시작, 설정, 삭제 (T-0010's look). */
export function EngineCardButtons({ project: p }: { project: EngineProject }) {
  const { busy } = useEngineStore();
  const canAct = useCanAct();
  const running = busy[p.name] !== undefined;
  return (
    <>
      {p.needsTrust && (
        <p className="basis-full text-xs text-yellow-300 break-words">
          {t('engine.trust.before')} <code className="text-text">cd {p.folder}</code>{' '}
          {t('engine.trust.after')} <code className="text-text">claude</code>{t('engine.trust.end')}
        </p>
      )}
      {p.downNote && (
        <p className="basis-full text-xs text-yellow-300 break-words">
          {serverLine(p.downNote)} · {t('engine.retry')}
        </p>
      )}
      {canAct &&
        sessionActions(p).map((action) => (
          <Button
            size="sm"
            key={action}
            disabled={running}
            onClick={() => engineAsk(action, p.name)}
          >
            {engineLabel(action)}
          </Button>
        ))}
      {canAct && (
        <>
          <Button
            size="sm"
            disabled={running}
            onClick={() => engineOpenForm(p.name)}
          >
            {t('engine.action.edit')}
          </Button>
          <Button
            size="sm"
            disabled={running}
            onClick={() => engineAsk('remove', p.name)}
          >
            {t('engine.action.remove')}
          </Button>
        </>
      )}
      {p.live && !p.bgId && (
        <span className="self-center text-xs text-text-muted">{t('engine.terminalOpen')}</span>
      )}
      {running && <span className="self-center text-xs text-accent-text pixel-pulse">{t('engine.working')}</span>}
    </>
  );
}

/** Top of the 현황판 while the engine runs: its add forms live with the engine. */
export function EngineSection() {
  const { state } = useEngineStore();
  const canAct = useCanAct();
  if (!state) return null;
  return (
    <section aria-label={t('engine.section')} className="space-y-8">
      {state.warnings?.map((w) => (
        <p key={w} className="text-xs text-yellow-300 break-words">
          ⚠ {serverLine(w)}
        </p>
      ))}
      {canAct && (
        <div className="flex flex-wrap gap-8">
          <Button size="sm" onClick={() => engineOpenForm(null)}>
            {t('engine.addOrchestrator')}
          </Button>
          <Button
            size="sm"
            onClick={() => window.dispatchEvent(new Event('cld-import-open'))}
          >
            {t('engine.import')}
          </Button>
          <Button
            size="sm"
            onClick={() => engineOpenForm(null, { newOffice: true })}
          >
            {t('engine.addOffice')}
          </Button>
        </div>
      )}
    </section>
  );
}

function EngineFormModal({
  project,
  adding,
  newOffice,
}: {
  project: EngineProject | null;
  adding: boolean;
  newOffice: boolean;
}) {
  const { hostInfo, officeSnapshot } = useCldStore();
  const { state } = useEngineStore();
  const [f, setF] = useState<EngineForm>(() => ({
    ...formFor(project),
    ...(adding && { folder: defaultProjectFolder(hostInfo) }),
  }));
  const [picking, setPicking] = useState(false);
  /** A picker child folder is created by the add request, without another prompt. */
  const [newFolder, setNewFolder] = useState(false);
  const [advanced, setAdvanced] = useState(
    () =>
      !!project &&
      !!(
        project.rulesFile ||
        project.model ||
        project.permissionMode ||
        project.effort ||
        project.title ||
        project.remoteControl ||
        project.alwaysOn ||
        project.compactionNudge
      ),
  );
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 직접 입력 picked: the select keeps showing it while the typed value is still empty. */
  const [custom, setCustom] = useState<{ model?: boolean; effort?: boolean }>({});
  const offices = [
    OPS_ROOM, // the 관리실 is always offered (user 10-22 17:05)
    ...(state?.projects ?? []).map((p) => p.room.trim()),
    ...(officeSnapshot?.tabs ?? []).filter((tab) => tab.kind === 'orch').map((tab) => tab.name.trim()),
  ]
    .filter(Boolean)
    .filter((room, i, all) => all.indexOf(room) === i)
    .sort((a, b) => a.localeCompare(b, 'ko'));
  const claudeChoices = state?.agentChoices?.claude;
  const codexChoices = state?.agentChoices?.codex;
  const models = [
    ...(claudeChoices?.models ?? []).map((id) => ({ id, source: 'Claude Code' })),
    ...(codexChoices?.models ?? []).map((id) => ({ id, source: 'Codex' })),
  ].filter((choice, index, all) => all.findIndex((other) => other.id === choice.id) === index);
  const efforts = [
    ...new Set([...(claudeChoices?.efforts ?? []), ...(codexChoices?.efforts ?? [])]),
  ];
  const selectValue = (value: string, choices: string[]) =>
    !value ? '' : choices.includes(value) ? value : CUSTOM;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') engineCloseForm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const text = (
    key: Exclude<keyof EngineForm, 'remoteControl' | 'alwaysOn'>,
    label: string,
    placeholder = '',
  ) => (
    <label className="block text-xs">
      {label}
      <input
        className={input}
        value={key === 'rulesFile' ? rulesFileLabel(f.rulesFile) : f[key]}
        title={key === 'rulesFile' && f.rulesFile ? f.rulesFile : undefined}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          if (key === 'name') setNameTouched(true);
          if (key === 'folder') setFolder(v);
          else setF({ ...f, [key]: v });
          setError(null);
        }}
      />
    </label>
  );
  const choice = (
    key: 'model' | 'effort',
    label: string,
    choices: Array<{ id: string; source?: string }>,
  ) => {
    const ids = choices.map((item) => item.id);
    const selected = custom[key] ? CUSTOM : selectValue(f[key], ids);
    return (
      <label className="block text-xs">
        {label}
        <select
          className={input}
          value={selected}
          onChange={(e) => {
            const value = e.target.value;
            setCustom({ ...custom, [key]: value === CUSTOM });
            setF({ ...f, [key]: value === CUSTOM ? '' : value });
            setError(null);
          }}
        >
          <option value="">{t('engine.default')}</option>
          {choices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id}
              {item.source ? ` · ${item.source}` : ''}
            </option>
          ))}
          <option value={CUSTOM}>{t('engine.custom')}</option>
        </select>
        {selected === CUSTOM && (
          <input
            className={`${input} mt-4`}
            value={f[key]}
            placeholder={key === 'model' ? t('engine.newModel') : t('engine.exampleMax')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setF({ ...f, [key]: e.target.value })}
          />
        )}
      </label>
    );
  };
  const setFolder = (v: string, fromNewPicker = false) => {
    setNewFolder(fromNewPicker);
    setF({ ...f, folder: v, ...(adding && !nameTouched && { name: baseName(v) }) });
  };
  const typed = hostInfo && f.folder.trim() ? normalizeProjectPath(f.folder, hostInfo) : null;
  const folderNotes =
    typed && !('error' in typed)
      ? [
          typed.path !== f.folder.trim() && `→ ${typed.path}`,
          typed.display !== typed.path && typed.display !== f.folder.trim() && typed.display,
        ].filter((x): x is string => !!x)
      : [];
  const submit = () => {
    if (newOffice && !f.room.trim()) {
      setError(t('engine.error.office'));
      return;
    }
    const err = formError(f, adding, hostInfo);
    if (err) {
      setError(err);
      return;
    }
    engineSubmit(
      (m) => transport.send(m),
      transport.state === 'connected',
      adding ? 'add' : 'edit',
      adding ? f.name.trim() : project!.name,
      { ...formFields(f, project), ...(adding && newFolder && { mkdir: true }) },
    );
  };
  return (
    <Modal
      isOpen
      onClose={engineCloseForm}
      title={
        // Words kept whole: on a phone the title breaks at the space, not mid-word.
        <span className="break-keep">
          {adding
            ? newOffice
              ? t('engine.addOffice')
              : t('engine.addOrchestrator')
            : t('engine.editTitle', { name: project?.name ?? '' })}
        </span>
      }
      zIndex={60}
    >
      <form
        className="space-y-8 px-10 pb-10 w-[min(420px,calc(100vw-48px))]"
        aria-label={adding ? (newOffice ? t('engine.addOffice') : t('engine.addOrchestrator')) : t('engine.projectSettings')}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-end gap-8">
          <div className="flex-1 min-w-0">
            {text('folder', t('engine.folder'), defaultProjectFolder(hostInfo))}
          </div>
          <Button size="sm" onClick={() => setPicking(true)}>
            {t('engine.browse')}
          </Button>
        </div>
        {folderNotes.map((note) => (
          <p key={note} className="text-xs text-text-muted font-mono break-all">
            {note}
          </p>
        ))}
        {newFolder && <p className="text-xs text-text-muted">{t('engine.newFolderHelp')}</p>}
        {typed &&
          !('error' in typed) &&
          typed.warnings.map((w) => (
            <p key={w} className="text-xs text-yellow-300">
              ⚠ {serverLine(w)}
            </p>
          ))}
        {adding && text('name', t('engine.name'))}
        <label className="block text-xs">
          {t('engine.office')}
          <input
            className={input}
            value={f.room}
            // A new office has no default: the folder's name would read as one.
            placeholder={newOffice ? t('engine.newOfficeName') : baseName(f.folder) || t('engine.folderName')}
            list={OFFICES_LIST}
            required={newOffice}
            autoFocus={newOffice}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setF({ ...f, room: e.target.value });
              setError(null);
            }}
          />
        </label>
        <datalist id={OFFICES_LIST}>
          {offices.map((office) => (
            <option key={office} value={office} />
          ))}
        </datalist>
        {newOffice && (
          <p className="text-xs text-text-muted">{t('engine.newOfficeHelp')}</p>
        )}
        <p className="text-xs text-text-muted">{t('engine.opsRoomHelp')}</p>
        <div className="space-y-8 border-l-2 border-border pl-8">
          <div className="flex items-center justify-between gap-8">
            <p className="text-xs text-text-muted">
              {t('engine.choicesHelp')}
            </p>
            <button
              type="button"
              className="text-xs text-accent-text shrink-0"
              onClick={() => transport.send({ type: 'engineChoicesRefresh' })}
            >
              {t('engine.refresh')}
            </button>
          </div>
          {choice('model', t('engine.model'), models)}
          {choice(
            'effort',
            t('engine.effort'),
            efforts.map((id) => ({ id })),
          )}
          <p className="text-xs text-text-muted">
            {t('engine.customHelp')}
          </p>
          <label className="block text-xs">
            {t('engine.nudge')}
            <select
              className={input}
              value={f.compactionNudge}
              onChange={(e) => setF({ ...f, compactionNudge: e.target.value })}
            >
              <option value="">{t('engine.nudgeOff')}</option>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {t('engine.nudgeCount', { count: n })}
                </option>
              ))}
              {f.compactionNudge && !['1', '2', '3', '4'].includes(f.compactionNudge) && (
                <option value={f.compactionNudge}>{t('engine.nudgeCurrent', { count: f.compactionNudge })}</option>
              )}
            </select>
          </label>
          <p className="text-xs text-text-muted">
            {t('engine.nudgeHelp')}
          </p>
        </div>
        <button
          type="button"
          className="text-xs text-accent-text"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          {t('engine.advanced')} {advanced ? '▲' : '▼'}
        </button>
        {advanced && (
          <div className="space-y-8 border-l-2 border-border pl-8">
            <p className="text-xs text-text-muted">{t('engine.advancedHelp')}</p>
            {text('rulesFile', t('engine.rulesFile'), t('engine.none'))}
            {text('permissionMode', t('engine.permissionMode'), t('engine.defaultShort'))}
            {text('title', t('engine.conversationName'), f.name || project?.name || '')}
            <label className="flex gap-4 items-center text-xs">
              <input
                type="checkbox"
                checked={f.remoteControl}
                onChange={(e) => setF({ ...f, remoteControl: e.target.checked })}
              />
              {t('engine.remoteControl')}
            </label>
            <label className="flex gap-4 items-center text-xs">
              <input
                type="checkbox"
                checked={f.alwaysOn}
                onChange={(e) => setF({ ...f, alwaysOn: e.target.checked })}
              />
              {t('engine.alwaysOn')}
            </label>
          </div>
        )}
        {!adding && project?.live && (
          <p className="text-xs text-yellow-300">
            {t('engine.runningHelp')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-8">
          <Button
            size="sm"
            variant="accent"
            type="submit"
            // The accent variant has no disabled look of its own.
            className="disabled:opacity-(--btn-disabled-opacity) disabled:cursor-default"
            disabled={newOffice && !f.room.trim()}
          >
            {adding ? t('engine.action.add') : t('engine.save')}
          </Button>
          <Button size="sm" type="button" onClick={engineCloseForm}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
      {picking && (
        <FolderPicker
          start={f.folder}
          allowNew={adding}
          onClose={() => setPicking(false)}
          onPick={(p, options) => {
            setFolder(p, options?.isNew === true);
            setError(null);
            setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}

/** The engine's form, confirmation and toast; mounted once at the top level. */
export function EngineLayer() {
  const { confirm, toast, form, state } = useEngineStore();
  useEffect(
    () =>
      transport.onStateChange((s) => {
        if (s !== 'connected') engineConnectionLost();
      }),
    [],
  );
  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') engineCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(
      () => engineDismissToast(toast.id),
      toast.tone === 'error' ? 8_000 : 4_000,
    );
    return () => window.clearTimeout(timer);
  }, [toast]);
  const project = form?.name ? (state?.projects.find((p) => p.name === form.name) ?? null) : null;
  const text = !confirm
    ? null
    : confirm.mkdir
      ? { question: t('engine.missingFolder'), note: confirm.mkdir }
      : confirm.action === 'add' || confirm.action === 'edit' || confirm.action === 'promote'
        ? null // promote has its own dialog (the 작업실)
        : engineConfirmText(confirm.action, confirm.name);
  return (
    <>
      <ImportProjects />
      {form && (
        <EngineFormModal
          key={form.name ?? (form.newOffice ? 'office' : '+')}
          project={project}
          adding={!form.name}
          newOffice={form.newOffice === true}
        />
      )}
      <Modal isOpen={!!text} onClose={engineCancel} title={confirm?.name} zIndex={62}>
        {confirm && text && (
          <div className="px-10 pb-8" role="alertdialog" aria-label={text.question}>
            <p className="text-base">{text.question}</p>
            {text.note && <p className="text-sm text-text-muted mt-4 break-all">{text.note}</p>}
            <div className="flex justify-end gap-8 mt-16">
              <Button
                variant="accent"
                size="sm"
                onClick={() =>
                  engineConfirm((m) => transport.send(m), transport.state === 'connected')
                }
              >
                {confirm.mkdir ? t('common.create') : engineLabel(confirm.action)}
              </Button>
              <Button size="sm" onClick={engineCancel} autoFocus>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
      {toast && (
        <FloatingToast
          key={toast.id}
          className="fixed left-1/2 -translate-x-1/2 bottom-[calc(var(--cld-toast-bottom)+8px)] z-[70] w-max max-w-[min(420px,calc(100vw-32px))] cursor-pointer"
          frameClassName={`px-12 py-8 text-sm break-words ${toast.tone === 'error' ? 'text-red-400' : toast.tone === 'info' ? 'text-yellow-300' : 'text-text'}`}
          onDismiss={() => engineDismissToast(toast.id)}
          onTap={() => engineDismissToast(toast.id)}
        >
          <strong className="mr-8">{toast.name}</strong>
          {toast.text}
        </FloatingToast>
      )}
    </>
  );
}
