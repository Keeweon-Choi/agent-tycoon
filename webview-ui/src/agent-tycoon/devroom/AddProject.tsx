/**
 * DEVROOM-PROJECT: 프로젝트 추가, the way Orca adds one: open a git repository folder on the host
 * (not a repository yet: git init, or add it as it is), or clone a repository address into a new
 * folder (default ~/projects). Then the engine's add form takes the folder: a project is its Lead,
 * so the add makes the project's Lead and starts it (said in the dialog), and the dev room lists it.
 */
import { useEffect, useRef, useState } from 'react';

import { defaultProjectFolder } from '../../../../core/src/agent-tycoon/projectPath.js';
import type { ProjectRepo, ProjectRepoProgress } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { stepUpFailedText } from '../auth/authApi.js';
import { requestStepUp } from '../auth/stepUp.js';
import { baseName } from '../engine.js';
import { engineOpenForm } from '../engineStore.js';
import { FolderPicker } from '../FolderPicker.js';
import { useAgtyStore } from '../officeStore.js';
import { serverText } from '../serverText.js';

type Ask = Omit<ProjectRepo, 'type' | 'requestId'>;

/** The folder name a clone gets by default: the address's last part without `.git`. */
const repoName = (url: string): string =>
  baseName(url.trim().replace(/\.git[/\\]*$/i, '')).split(':').pop() ?? '';

const field = 'bg-bg border-2 border-border px-6 py-4 text-xs min-w-0';
const label = 'flex flex-col gap-2 text-xs';
let seq = 0;

export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const { hostInfo } = useAgtyStore();
  const [mode, setMode] = useState<'open' | 'clone'>('open');
  const [folder, setFolder] = useState('');
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(() => defaultProjectFolder(hostInfo));
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [picking, setPicking] = useState<'folder' | 'parent' | null>(null);
  const [busy, setBusy] = useState<ProjectRepo['action'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The folder the check found is no git repository: init it, or add it as it is. */
  const [notRepo, setNotRepo] = useState<string | null>(null);
  const pending = useRef<{ requestId: string; fields: Ask; retried: boolean } | null>(null);
  /** CLONE-PROGRESS: where the running clone is (git's phase, its percent, size and speed). */
  const [progress, setProgress] = useState<ProjectRepoProgress | null>(null);
  /** Stop the running clone (취소, or the dialog closed under it): the daemon removes its folder. */
  const cancelClone = () => {
    const p = pending.current;
    if (p?.fields.action === 'clone') transport.send({ type: 'projectRepoCancel', requestId: p.requestId });
  };

  const ask = (fields: Ask, retried = false) => {
    if (transport.state !== 'connected') {
      setError(t('engine.disconnectedBeforeSend'));
      return;
    }
    const msg: ProjectRepo = { type: 'projectRepo', requestId: `${Date.now().toString(36)}-p${++seq}`, ...fields };
    pending.current = { requestId: msg.requestId, fields, retried };
    setBusy(fields.action);
    setProgress(null);
    setError(null);
    setNotRepo(null);
    transport.send(msg);
  };
  // The engine's add form takes it from here (the Lead, its office, its model).
  const next = (path: string, cloned = false) => {
    engineOpenForm(null, { folder: path, ...(cloned && { cloned }) });
    onClose();
  };
  useEffect(
    () =>
      transport.onMessage((m) => {
        const p = pending.current;
        if (m.type === 'projectRepoProgress' && p && m.requestId === p.requestId) {
          setProgress(m);
          return;
        }
        if (m.type !== 'projectRepoResult' || !p || m.requestId !== p.requestId) return;
        pending.current = null;
        setProgress(null);
        // S1: a remote session's clone wants a fresh proof; then the same request once more.
        if (!m.ok && m.error === 'stepup' && !p.retried) {
          void requestStepUp().then(
            (ok) => (ok ? ask(p.fields, true) : (setBusy(null), setError(stepUpFailedText()))),
            () => (setBusy(null), setError(stepUpFailedText())),
          );
          return;
        }
        setBusy(null);
        if (!m.ok) setError(serverText(m));
        else if (m.action === 'check' && !m.repo) setNotRepo(m.folder ?? '');
        else if (m.folder) next(m.folder, m.action === 'clone');
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ask and next only use setters and refs
    [],
  );
  // Closed while cloning: the clone stops with it (its result would reach nobody).
  useEffect(() => cancelClone, []);

  const cloneName = named ? name : repoName(url);
  const sep = hostInfo?.sep ?? '/';
  const tab = (id: 'open' | 'clone') => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === id}
      data-testid={`devroom-add-mode-${id}`}
      className={`flex-1 px-8 py-6 border-2 text-xs ${mode === id ? 'bg-accent border-accent text-white' : 'bg-btn-bg border-border'}`}
      onClick={() => {
        setMode(id);
        setError(null);
        setNotRepo(null);
      }}
    >
      {t(`devroom.add.mode.${id}`)}
    </button>
  );
  const browse = (which: 'folder' | 'parent') => (
    <Button type="button" size="sm" onClick={() => setPicking(which)}>
      {t('engine.browse')}
    </Button>
  );
  return (
    <Modal isOpen onClose={onClose} title={t('devroom.add.title')}>
      <form
        className="flex flex-col gap-8 px-10 pb-10 w-[min(420px,calc(100vw-48px))]"
        data-testid="devroom-add-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          if (mode === 'open') ask({ action: 'check', folder: folder.trim() || defaultProjectFolder(hostInfo) });
          else ask({ action: 'clone', folder: parent.trim(), url: url.trim(), name: cloneName.trim() });
        }}
      >
        <div className="flex gap-6" role="radiogroup" aria-label={t('devroom.add.title')}>
          {tab('open')}
          {tab('clone')}
        </div>
        {mode === 'open' ? (
          <label className={label}>
            {t('devroom.add.folder')}
            <span className="flex gap-6">
              <input
                className={`${field} flex-1`}
                data-testid="devroom-add-folder"
                value={folder}
                placeholder={defaultProjectFolder(hostInfo)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => {
                  setFolder(e.target.value);
                  setNotRepo(null);
                }}
              />
              {browse('folder')}
            </span>
          </label>
        ) : (
          <>
            <label className={label}>
              {t('devroom.add.url')}
              <input
                autoFocus
                className={field}
                data-testid="devroom-add-url"
                value={url}
                placeholder={t('devroom.add.urlPlaceholder')}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className={label}>
              {t('devroom.add.parent')}
              <span className="flex gap-6">
                <input
                  className={`${field} flex-1`}
                  data-testid="devroom-add-parent"
                  value={parent}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setParent(e.target.value)}
                />
                {browse('parent')}
              </span>
            </label>
            <label className={label}>
              {t('devroom.add.name')}
              <input
                className={field}
                data-testid="devroom-add-name"
                value={cloneName}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => {
                  setNamed(true);
                  setName(e.target.value);
                }}
              />
            </label>
            {cloneName.trim() && parent.trim() && (
              <p className="text-2xs text-text-muted font-mono break-all">
                → {parent.trim().replace(/[/\\]+$/, '')}
                {sep}
                {cloneName.trim()}
              </p>
            )}
          </>
        )}
        {mode === 'clone' && (
          <p className="text-2xs text-yellow-300" data-testid="devroom-add-clone-warn">
            ⚠ {t('devroom.add.cloneWarn')}
          </p>
        )}
        <p className="text-2xs text-text-muted">{t('devroom.add.note')}</p>
        {notRepo !== null && (
          <div className="flex flex-col gap-6 border-2 border-border p-8" data-testid="devroom-add-not-repo">
            <p className="text-xs text-yellow-300 break-all">{t('devroom.add.notRepo', { folder: notRepo })}</p>
            <div className="flex flex-wrap gap-6">
              <Button type="button" size="sm" variant="accent" data-testid="devroom-add-init" onClick={() => ask({ action: 'init', folder: notRepo })}>
                {t('devroom.add.init')}
              </Button>
              <Button type="button" size="sm" data-testid="devroom-add-asis" onClick={() => next(notRepo)}>
                {t('devroom.add.asIs')}
              </Button>
            </div>
          </div>
        )}
        {busy && busy !== 'clone' && (
          <p className="text-xs text-accent-text pixel-pulse" data-testid="devroom-add-busy">
            {t('devroom.add.checking')}
          </p>
        )}
        {busy === 'clone' && (
          <div className="flex flex-col gap-4 border-2 border-border p-8" data-testid="devroom-add-progress" data-phase={progress?.phase}>
            <p className="flex items-center gap-6 text-xs">
              <span className={`text-accent-text ${progress ? '' : 'pixel-pulse'}`}>
                {progress ? t(`devroom.add.phase.${progress.phase}`) : t('devroom.add.cloning')}
              </span>
              {progress?.percent !== undefined && <span className="ml-auto">{progress.percent}%</span>}
            </p>
            <div className="h-12 border-2 border-border bg-bg-dark" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.percent}>
              <div className="h-full bg-accent" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <p className="flex gap-6 text-2xs text-text-muted font-mono">
              {progress?.total !== undefined && (
                <span>
                  {progress.done ?? 0}/{progress.total}
                </span>
              )}
              {progress?.size && (
                <span className="ml-auto" data-testid="devroom-add-speed">
                  {progress.size}
                  {progress.speed && ` · ${progress.speed}`}
                </span>
              )}
            </p>
            <Button type="button" size="sm" data-testid="devroom-add-cancel" className="self-end" onClick={cancelClone}>
              {t('common.cancel')}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-400 break-words" data-testid="devroom-add-error">
            {error}
          </p>
        )}
        {notRepo === null && (
          <Button
            type="submit"
            size="md"
            variant="accent"
            data-testid="devroom-add-next"
            className="disabled:opacity-(--btn-disabled-opacity) disabled:cursor-default"
            disabled={!!busy || (mode === 'clone' && (!url.trim() || !cloneName.trim() || !parent.trim()))}
          >
            {t(mode === 'open' ? 'devroom.add.next' : 'devroom.add.clone')}
          </Button>
        )}
      </form>
      {picking && (
        <FolderPicker
          start={(picking === 'folder' ? folder : parent) || defaultProjectFolder(hostInfo)}
          onClose={() => setPicking(null)}
          onPick={(p) => {
            if (picking === 'folder') setFolder(p);
            else setParent(p);
            setNotRepo(null);
            setError(null);
            setPicking(null);
          }}
        />
      )}
    </Modal>
  );
}
