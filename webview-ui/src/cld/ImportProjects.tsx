import { useEffect, useRef, useState } from 'react';

import type {
  ProjectImportCandidate,
  ProjectImportResult,
  ProjectImportRow,
  ServerMessage,
} from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { t, useLanguage } from '../i18n/index.js';
import { transport } from '../transport/index.js';
import { FolderPicker } from './FolderPicker.js';
import { useCldStore } from './officeStore.js';
import { serverText } from './serverText.js';

type Choice = ProjectImportCandidate & { checked: boolean; resume: boolean; start: boolean };
const input = 'w-full border border-border bg-black/20 px-8 py-4 text-sm';
let sequence = 0;
const id = () => `${Date.now().toString(36)}-import-${++sequence}`;

export function ImportProjects() {
  const language = useLanguage();
  const { hostInfo, officeReadOnly, officeSnapshot } = useCldStore();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [stage, setStage] = useState<'scan' | 'choose' | 'result'>('scan');
  const [rows, setRows] = useState<Choice[]>([]);
  const [result, setResult] = useState<ProjectImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef('');
  const canAct = officeSnapshot?.readOnly === false && !officeReadOnly;

  const scan = (selected: string) => {
    const requestId = id();
    request.current = requestId;
    setFolder(selected);
    setRows([]);
    setResult(null);
    setError(null);
    setBusy(true);
    setStage('scan');
    transport.send({ type: 'projectScan', requestId, folder: selected });
  };
  useEffect(() => {
    const openDialog = () => {
      setOpen(true);
      setPicking(true);
      setError(null);
    };
    window.addEventListener('cld-import-open', openDialog);
    const off = transport.onMessage((message: ServerMessage) => {
      if (message.type === 'projectImportSuggestion') {
        setSuggestion(message.folder);
        return;
      }
      if (message.type === 'projectScanResult' && message.requestId === request.current) {
        setBusy(false);
        if (!message.ok) {
          setError(serverText(message, t('import.folderNotFound')));
          return;
        }
        setRows(
          message.candidates.map((c) => ({
            ...c,
            checked: true,
            resume: !!c.sessionId,
            start: false,
          })),
        );
        setStage('choose');
      }
      if (message.type === 'projectImportResult' && message.requestId === request.current) {
        setBusy(false);
        setResult(message);
        setStage('result');
      }
    });
    return () => {
      window.removeEventListener('cld-import-open', openDialog);
      off();
    };
  }, []);
  const update = (folder: string, fields: Partial<Choice>) =>
    setRows((current) =>
      current.map((row) => (row.folder === folder ? { ...row, ...fields } : row)),
    );
  const dismiss = () => {
    setSuggestion(null);
    transport.send({ type: 'projectImportDismiss' });
  };
  const submit = () => {
    const selected: ProjectImportRow[] = rows
      .filter((r) => r.checked)
      .map((r) => ({
        folder: r.folder,
        name: r.name.trim(),
        room: r.room.trim(),
        resume: r.resume,
        start: r.start,
      }));
    if (!selected.length) return;
    const requestId = id();
    request.current = requestId;
    setBusy(true);
    setError(null);
    transport.send({ type: 'projectImport', requestId, folder, rows: selected });
  };
  const undo = () => {
    if (!result?.batchId) return;
    const requestId = id();
    request.current = requestId;
    setBusy(true);
    transport.send({ type: 'projectImportUndo', requestId, batchId: result.batchId });
  };

  return (
    <>
      {canAct && suggestion && !open && (
        <div
          role="status"
          className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[60] pixel-panel p-10 w-[min(440px,calc(100vw-24px))] space-y-6 text-sm"
        >
          <p>{t('import.suggestion')}</p>
          <div className="flex flex-wrap gap-8">
            <Button
              size="sm"
              variant="accent"
              onClick={() => {
                dismiss();
                setOpen(true);
                scan(suggestion);
              }}
            >
              {t('import.browse')}
            </Button>
            <Button size="sm" onClick={dismiss}>
              {t('import.later')}
            </Button>
          </div>
        </div>
      )}
      <Modal isOpen={open} onClose={() => setOpen(false)} title={t('import.title')} zIndex={60}>
        <div
          className="space-y-8 px-10 pb-10 w-[min(620px,calc(100vw-32px))] max-h-[80vh] overflow-y-auto"
          aria-label={t('import.title')}
        >
          {folder && <p className="text-xs font-mono break-all">{folder}</p>}
          {stage !== 'result' && (
            <div className="flex flex-wrap gap-8">
              <Button size="sm" onClick={() => setPicking(true)}>
                {t('import.chooseFolder')}
              </Button>
              {folder && (
                <Button size="sm" onClick={() => scan(folder)} disabled={busy}>
                  {t('import.rescan')}
                </Button>
              )}
            </div>
          )}
          {busy && (
            <p role="status" className="text-sm">
              {t('import.working')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          {stage === 'scan' && !busy && !error && (
            <p className="text-sm text-text-muted">
              {t('import.scanHelp')}
            </p>
          )}
          {stage === 'choose' && (
            <>
              <p className="text-xs text-text-muted">
                {t('import.chooseHelp')}
              </p>
              {rows.length === 0 && <p className="text-sm">{t('import.none')}</p>}
              <ul className="space-y-8" aria-label={t('import.found')}>
                {rows.map((row) => (
                  <li key={row.folder} className="border border-border p-8 space-y-6 text-xs">
                    <label className="flex gap-6 items-start font-semibold text-sm">
                      <input
                        type="checkbox"
                        checked={row.checked}
                        disabled={row.already}
                        onChange={(e) => update(row.folder, { checked: e.target.checked })}
                      />
                      <span className="min-w-0 break-all">{row.folder}</span>
                    </label>
                    {row.already && <p className="text-yellow-300">{t('import.already')}</p>}
                    <div className="flex flex-wrap gap-x-8 gap-y-2 text-text-muted">
                      {row.branch && <span>{t('import.branch')} {row.branch}</span>}
                      {row.live && <span>{t('import.running')}</span>}
                      {row.lastActivity && (
                        <span>{t('import.recent')} {new Date(row.lastActivity).toLocaleString(language === 'ko' ? 'ko-KR' : 'en-US')}</span>
                      )}
                    </div>
                    {row.title && <p className="break-words">{row.title}</p>}
                    {!row.already && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                        <label>
                          {t('import.name')}
                          <input
                            className={input}
                            value={row.name}
                            onChange={(e) => update(row.folder, { name: e.target.value })}
                          />
                        </label>
                        <label>
                          {t('import.office')}
                          <input
                            className={input}
                            value={row.room}
                            onChange={(e) => update(row.folder, { room: e.target.value })}
                          />
                        </label>
                        <label>
                          {t('import.conversation')}
                          <select
                            className={input}
                            value={row.resume ? 'resume' : 'new'}
                            onChange={(e) =>
                              update(row.folder, { resume: e.target.value === 'resume' })
                            }
                          >
                            {row.sessionId && <option value="resume">{t('import.resume')}</option>}
                            <option value="new">{t('import.newConversation')}</option>
                          </select>
                        </label>
                        <label className="flex gap-4 items-center">
                          <input
                            type="checkbox"
                            checked={row.start}
                            onChange={(e) => update(row.folder, { start: e.target.checked })}
                          />
                          {t('import.startNow')}
                        </label>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex justify-end gap-8">
                <Button
                  size="sm"
                  variant="accent"
                  onClick={submit}
                  disabled={busy || !rows.some((r) => r.checked && !r.already)}
                >
                  {t('import.button')}
                </Button>
              </div>
            </>
          )}
          {stage === 'result' && result && (
            <>
              <ul className="space-y-4" aria-label={t('import.results')}>
                {result.rows.map((r) => (
                  <li key={`${r.folder}:${r.name}`} className="text-sm break-words">
                    <strong>{r.name}</strong> ·{' '}
                    {r.status === 'added'
                      ? t('import.added')
                      : r.status === 'skipped'
                        ? t('import.skipped')
                        : r.status === 'removed'
                          ? t('import.removed')
                          : t('import.failed')}
                    {r.reason && ` · ${serverText({ ...r, error: r.reason })}`}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap justify-end gap-8">
                {result.batchId && (
                  <Button size="sm" onClick={undo} disabled={busy}>
                    {t('import.undo')}
                  </Button>
                )}
                <Button size="sm" variant="accent" onClick={() => setOpen(false)}>
                  {t('common.close')}
                </Button>
              </div>
            </>
          )}
        </div>
        {picking && (
          <FolderPicker
            start={folder || (hostInfo ? `${hostInfo.home}${hostInfo.sep}projects` : '')}
            onClose={() => setPicking(false)}
            onPick={(selected) => {
              setPicking(false);
              scan(selected);
            }}
          />
        )}
      </Modal>
    </>
  );
}
