import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatLibraryFile } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { CHAT_REQUEST_TIMEOUT_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { serverText } from '../serverText.js';
import { type TicketFor, useOpenAttachment } from './attachmentGallery.js';
import { sizeLabel } from './attachmentView.js';
import { libraryGone, mergeLibrary } from './libraryFiles.js';
import { bubbleClock, nextRequestId } from './parts.js';

interface Page {
  files: ChatLibraryFile[];
  next?: string;
  done: boolean;
  busy: boolean;
  error: string;
}

/** A small picture of an image file (a preview ticket); other files get a glyph. */
function Thumb({ file, ticketFor }: { file: ChatLibraryFile; ticketFor: TicketFor }) {
  const [url, setUrl] = useState('');
  const image = !!file.type?.startsWith('image/') && !libraryGone(file);
  useEffect(() => {
    if (!image || !file.path) return;
    let live = true;
    ticketFor(file.path, 'preview').then(
      (ticket) => live && setUrl(ticket),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [image, file.path, ticketFor]);
  return (
    <span className="shrink-0 w-40 h-40 border border-border bg-bg-dark flex items-center justify-center text-text-muted">
      {url ? <img src={url} alt="" className="w-full h-full object-contain" /> : '▤'}
    </span>
  );
}

/**
 * MSGLIB: the files exchanged in this conversation (the boss's attachments and the files the lead
 * sent), newest first, read from its transcript by the daemon a page at a time. A desktop gets a side
 * drawer, a phone a bottom sheet. Each row opens in the conversation's viewer, saves, or goes to its message.
 */
export function Library({
  agentId,
  name,
  phone,
  ticketFor,
  onGo,
  onClose,
}: {
  agentId: number;
  name: string;
  phone: boolean;
  ticketFor: TicketFor;
  onGo: (file: ChatLibraryFile) => void;
  onClose: () => void;
}) {
  const openViewer = useOpenAttachment();
  const [page, setPage] = useState<Page>({ files: [], done: false, busy: true, error: '' });
  const asked = useRef('');
  const timer = useRef<number | undefined>(undefined);
  const load = useCallback(
    (before?: string) => {
      const requestId = nextRequestId();
      asked.current = requestId;
      setPage((p) => ({ ...p, busy: true, error: '' }));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (asked.current !== requestId) return;
        asked.current = '';
        setPage((p) => ({ ...p, busy: false, error: t('msglib.error') }));
      }, CHAT_REQUEST_TIMEOUT_MS);
      transport.send({ type: 'chatFiles', agentId, requestId, ...(before && { before }) });
    },
    [agentId],
  );
  useEffect(() => {
    load();
    const off = transport.onMessage((msg) => {
      if (msg.type !== 'chatFilesResult' || msg.requestId !== asked.current) return;
      asked.current = '';
      window.clearTimeout(timer.current);
      const failed = !!msg.error || !!msg.errorCode;
      setPage((p) => ({
        files: mergeLibrary(p.files, msg.files),
        next: failed ? p.next : msg.next,
        done: msg.done,
        busy: false,
        error: failed ? serverText(msg, t('msglib.error')) : '',
      }));
    });
    return () => {
      off();
      window.clearTimeout(timer.current);
    };
  }, [load]);
  const [saveError, setSaveError] = useState('');
  const save = async (file: ChatLibraryFile) => {
    if (!file.path) return;
    try {
      const link = document.createElement('a');
      link.href = await ticketFor(file.path, 'download');
      link.download = file.name;
      link.click();
      setSaveError('');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('msglib.error'));
    }
  };
  return (
    <aside
      role="complementary"
      aria-label={t('msglib.title')}
      data-testid="library"
      className={`absolute z-20 flex flex-col bg-bg border-border shadow-pixel ${
        phone
          ? 'inset-x-0 bottom-0 max-h-[70%] border-t-ui'
          : 'top-0 right-0 bottom-0 w-320 max-w-full border-l-ui'
      }`}
    >
      <header className="msg-head shrink-0 flex items-center gap-8 px-12 py-6">
        <strong className="flex-1 min-w-0 truncate text-sm">{t('msglib.title')}</strong>
        <Button size="icon_md" variant="ghost" aria-label={t('common.close')} onClick={onClose}>
          ×
        </Button>
      </header>
      <ul className="flex-1 min-h-0 overflow-y-auto" data-testid="library-list">
        {page.files.map((file) => {
          const gone = libraryGone(file);
          return (
            <li
              key={`${file.id}:${file.path ?? file.name}`}
              data-testid="library-row"
              data-gone={gone || undefined}
              className="flex items-center gap-8 px-12 py-6 border-b border-border"
            >
              <Thumb file={file} ticketFor={ticketFor} />
              <span className="flex-1 min-w-0">
                <span className={`block truncate text-sm ${gone ? 'line-through text-text-muted' : ''}`} title={file.name}>
                  {file.name}
                </span>
                <span className="block truncate text-2xs text-text-muted">
                  {[
                    file.kind === 'user' ? t('msglib.fromBoss') : name,
                    file.sizeKb !== undefined ? sizeLabel(file.sizeKb) : '',
                    bubbleClock(file.at),
                    file.missing ? t('msglib.missing') : file.unavailable ? t('msglib.unavailable') : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="shrink-0 flex items-center gap-4">
                <Button
                  size="sm"
                  disabled={gone}
                  aria-label={t('messenger.attachmentOpen', { name: file.name })}
                  onClick={() => file.path && openViewer?.(file.path)}
                >
                  {t('msglib.fileOpen')}
                </Button>
                <Button
                  size="icon_md"
                  disabled={gone}
                  aria-label={t('msglib.fileSaveLabel', { name: file.name })}
                  title={t('attachment.viewer.download')}
                  onClick={() => void save(file)}
                >
                  ↓
                </Button>
                <Button
                  size="icon_md"
                  aria-label={t('msglib.fileGoLabel', { name: file.name })}
                  title={t('msglib.fileGo')}
                  onClick={() => onGo(file)}
                >
                  ↗
                </Button>
              </span>
            </li>
          );
        })}
        {!page.busy && !page.error && page.files.length === 0 && (
          <li className="px-12 py-12 text-sm text-text-muted">{t('msglib.empty')}</li>
        )}
        {page.busy && <li className="px-12 py-8 text-xs text-text-muted">{t('messenger.loading')}</li>}
        {(page.error || saveError) && (
          <li role="alert" className="px-12 py-8 text-xs text-danger">
            {page.error || saveError}
          </li>
        )}
        {!page.busy && !page.done && page.next && (
          <li className="px-12 py-8">
            <Button size="sm" data-testid="library-more" onClick={() => load(page.next)}>
              {t('msglib.more')}
            </Button>
          </li>
        )}
        {!page.busy && page.error && (
          <li className="px-12 pb-8">
            <Button size="sm" onClick={() => load(page.next)}>
              {t('msglib.retry')}
            </Button>
          </li>
        )}
      </ul>
    </aside>
  );
}
