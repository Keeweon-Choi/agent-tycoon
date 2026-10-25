/**
 * The folder picker (T-0032): over the project form, the subfolders the daemon
 * lets it list (home, Windows drives, WSL /mnt drives). A tap opens a folder;
 * "이 폴더 선택" takes the one shown. Typing a path in the form stays possible.
 */
import { useEffect, useRef, useState } from 'react';

import { checkNewFolderName } from '../../../core/src/cld/projectPath.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { t } from '../i18n/index.js';
import { transport } from '../transport/index.js';
import { useCldStore } from './officeStore.js';
import { serverLine, serverText } from './serverText.js';

const chip =
  'border border-border px-8 py-4 text-xs hover:bg-border disabled:opacity-50 disabled:cursor-default';
let seq = 0;

export function FolderPicker({
  start,
  allowNew = false,
  onPick,
  onClose,
}: {
  /** The form's folder; home when it cannot be listed. */
  start: string;
  /** Let the caller make the selected child folder with its own action. */
  allowNew?: boolean;
  onPick: (path: string, options?: { isNew: true }) => void;
  onClose: () => void;
}) {
  const { folderList, hostInfo } = useCldStore();
  const [requestId, setRequestId] = useState('');
  const [hidden, setHidden] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newError, setNewError] = useState<string | null>(null);
  const fellBack = useRef(false);
  const list = (path: string | undefined, showHidden = hidden) => {
    const id = `${Date.now().toString(36)}-f${++seq}`;
    setRequestId(id);
    transport.send({
      type: 'listFolders',
      requestId: id,
      ...(path && { path }),
      ...(showHidden && { hidden: true }),
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, from the form's folder
  useEffect(() => list(start.trim() || undefined), []);
  const answer = folderList?.requestId === requestId ? folderList : null;
  useEffect(() => {
    // A typed folder that is missing or not allowed: start at home instead.
    if (answer && !answer.ok && !fellBack.current) {
      fellBack.current = true;
      list(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer]);
  useEffect(() => {
    // Capture, so Escape closes the picker and not the form under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const here = answer?.ok ? answer : null;
  const makeNewFolder = () => {
    if (!here?.path) return;
    if (!hostInfo) {
      setNewError(t('folder.loadingHost'));
      return;
    }
    const checked = checkNewFolderName(newName, hostInfo);
    if ('error' in checked) {
      setNewError(serverText(checked));
      return;
    }
    const separator = hostInfo.os === 'win32' ? '\\' : '/';
    const path = `${here.path}${here.path.endsWith(separator) ? '' : separator}${checked.name}`;
    onPick(path, { isNew: true });
  };
  return (
    <Modal isOpen onClose={onClose} title={t('folder.title')} zIndex={64}>
      <div
        className="flex flex-col gap-8 px-10 pb-10 w-[min(440px,calc(100vw-48px))]"
        aria-label={t('folder.title')}
      >
        {here ? (
          <p className="text-sm font-mono break-all">{here.path}</p>
        ) : (
          !answer && <p className="text-sm text-text-muted">{t('folder.loading')}</p>
        )}
        {allowNew && here && (
          <div className="space-y-4">
            {newOpen ? (
              <>
                <label className="block text-xs">
                  {t('folder.newName')}
                  <input
                    className="mt-4 w-full border border-border bg-black/20 px-8 py-4 text-sm"
                    value={newName}
                    autoFocus
                    onChange={(e) => {
                      setNewName(e.target.value);
                      setNewError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        makeNewFolder();
                      }
                    }}
                  />
                </label>
                {newError && (
                  <p role="alert" className="text-xs text-red-400">
                    {newError}
                  </p>
                )}
                <div className="flex gap-8">
                  <Button size="sm" variant="accent" type="button" onClick={makeNewFolder}>
                    {t('common.create')}
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    onClick={() => {
                      setNewOpen(false);
                      setNewName('');
                      setNewError(null);
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className={chip}
                onClick={() => {
                  setNewOpen(true);
                  setNewError(null);
                }}
              >
                {t('folder.new')}
              </button>
            )}
          </div>
        )}
        {here?.display && here.display !== here.path && (
          <p className="text-xs text-text-muted font-mono break-all">{here.display}</p>
        )}
        {here?.warnings?.map((w) => (
          <p key={w} className="text-xs text-yellow-300">
            ⚠ {serverLine(w)}
          </p>
        ))}
        {answer && !answer.ok && (
          <p role="alert" className="text-xs text-red-400">
            {serverText(answer)}
          </p>
        )}
        <div className="flex flex-wrap gap-8">
          {(answer?.roots ?? []).map((r) => (
            <button key={r.path} type="button" className={chip} onClick={() => list(r.path)}>
              {serverLine(r.label)}
            </button>
          ))}
          <button
            type="button"
            className={chip}
            disabled={!here?.parent}
            onClick={() => here?.parent && list(here.parent)}
          >
            {t('folder.up')}
          </button>
          <label className="flex items-center gap-4 text-xs">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked);
                list(here?.path, e.target.checked);
              }}
            />
            {t('folder.hidden')}
          </label>
        </div>
        <ul
          className="border-2 border-border max-h-[min(45vh,360px)] overflow-y-auto"
          aria-label={t('folder.children')}
        >
          {here && here.entries.length === 0 && (
            <li className="px-8 py-6 text-xs text-text-muted">{t('folder.noChildren')}</li>
          )}
          {here?.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                className="w-full text-left px-8 py-6 text-sm hover:bg-border break-all"
                onClick={() => list(e.path)}
              >
                ▸ {e.name}
              </button>
            </li>
          ))}
        </ul>
        {here?.truncated && (
          <p className="text-xs text-text-muted">{t('folder.truncated')}</p>
        )}
        <div className="flex justify-end gap-8">
          <Button
            size="sm"
            variant="accent"
            type="button"
            disabled={!here?.path}
            onClick={() => here?.path && onPick(here.path)}
          >
            {t('folder.chooseThis')}
          </Button>
          <Button size="sm" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
