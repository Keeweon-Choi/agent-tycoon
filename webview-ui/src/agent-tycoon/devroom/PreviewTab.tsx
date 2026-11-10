/**
 * P4 개발실's 미리보기 tab (mockups-1101/preview-P1 on the PC, P2 on the phone). The page of the task's
 * own dev server in an iframe, loaded straight from it: a different port is a different origin, so it
 * cannot read the office's token, and the daemon proxies nothing. Only a loopback address is accepted
 * (core/agent-tycoon/devUrl, the same rule the daemon applies to a phone's ask), never the office itself, and the
 * frame is sandboxed with no referrer. Elsewhere than the PC the tab is P2: a button that asks the PC.
 *
 * ponytail: the address is typed or pasted (a `Local: http://…` line works) and kept per worktree; the
 * scan of the agent's terminal output (devroom/AgentColumns.tsx) is not built; add it if asked.
 */
import { useEffect, useState } from 'react';

import { devServerExposed } from '../../../../core/src/agent-tycoon/devUrl.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { openExternal } from '../externalLinks.js';
import { BIG, BODY, SMALL } from './devroomData.js';
import { openDevroomPage, pickKey, setDevroomTab, setPreviewUrl, useDevroom } from './devroomStore.js';
import { onThisPc, previewAddress } from './previewHost.js';

/** The box shows `localhost:5173`, not `http://localhost:5173/`. */
const shown = (url: string): string => url.replace(/^http:\/\//, '').replace(/\/$/, '');

export function PreviewTab({ project, task, phone = false }: { project: string; task: string; phone?: boolean }) {
  const { previews } = useDevroom();
  const url = previews[pickKey(project, task)] ?? '';
  return !phone && onThisPc() ? (
    <PcPreview project={project} task={task} url={url} />
  ) : (
    <AskThePc project={project} task={task} url={url} phone={phone} />
  );
}

function PcPreview({ project, task, url }: { project: string; task: string; url: string }) {
  const [draft, setDraft] = useState(shown(url));
  const [error, setError] = useState('');
  const [exposed, setExposed] = useState(false);
  const [nonce, setNonce] = useState(0);
  // A notice (or another window) changed the address.
  useEffect(() => setDraft(shown(url)), [url]);

  const commit = () => {
    const text = draft.trim();
    setExposed(devServerExposed(text));
    if (!text) {
      setError('');
      return setPreviewUrl(project, task, '');
    }
    const a = previewAddress(text, window.location.port);
    if ('error' in a) return setError(a.error);
    setError('');
    setDraft(shown(a.url));
    setPreviewUrl(project, task, a.url);
    setNonce((n) => n + 1);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-devroom-foot" data-testid="preview" data-url={url}>
      <div className="shrink-0 flex items-center gap-8 p-8 border-b-2 border-border">
        <Button size="icon_md" aria-label={t('preview.reload')} title={t('preview.reload')} data-testid="preview-reload" disabled={!url} onClick={() => setNonce((n) => n + 1)}>
          ↻
        </Button>
        <input
          className={`flex-1 min-w-0 bg-bg border-2 px-8 py-4 ${BODY} ${error ? 'border-devroom-conf-line' : 'border-border'}`}
          aria-label={t('preview.url')}
          placeholder={t('preview.urlPlaceholder')}
          data-testid="preview-url"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          onBlur={() => draft.trim() !== shown(url) && commit()}
        />
        <Button size="sm" data-testid="preview-new-window" disabled={!url} onClick={() => openExternal(url)}>
          {t('preview.newWindow')}
        </Button>
      </div>
      {error && (
        <p className={`shrink-0 px-12 py-6 border-b-2 border-devroom-conf-line bg-devroom-conf-bg text-devroom-conf-text ${SMALL}`} data-testid="preview-error">
          {error}
        </p>
      )}
      {exposed && (
        <p className={`shrink-0 px-12 py-6 border-b-2 border-devroom-conf-line bg-devroom-conf-bg text-devroom-conf-text ${SMALL}`} data-testid="preview-exposed">
          <b className="font-normal text-devroom-conf">! {t('preview.exposed')}</b> · {t('preview.exposedHint')}
        </p>
      )}
      {url ? (
        <iframe
          key={`${url}#${nonce}`}
          title={t('preview.frame', { task })}
          src={url}
          // Its own origin (never ours, refused above), scripts and forms as a dev server needs, nothing more.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
          allow=""
          className="flex-1 min-h-0 w-full bg-white"
          data-testid="preview-frame"
        />
      ) : (
        <p className={`m-auto p-16 text-center text-text-muted ${BODY}`} data-testid="preview-empty">
          {t('preview.empty')}
        </p>
      )}
      {url && (
        <div className={`shrink-0 flex items-center gap-10 px-12 py-6 border-t-2 border-border ${SMALL}`}>
          <span className="flex-1 min-w-0 text-devroom-conf-text">{t('preview.note')}</span>
          <span className="shrink-0 text-text-muted" data-testid="preview-footer">
            {t('preview.footer', { count: 1 })}
          </span>
        </div>
      )}
    </div>
  );
}

/** P2: this screen is not the PC; the preview can only be asked for there. */
function AskThePc({ project, task, url, phone }: { project: string; task: string; url: string; phone: boolean }) {
  const [sent, setSent] = useState(false);
  const ask = () => {
    if (transport.state !== 'connected') return;
    transport.send({ type: 'previewAsk', project, task, url });
    setSent(true);
  };
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-16" data-testid="preview-phone">
      <div className="border-2 border-border bg-devroom-card p-16 shadow-pixel flex flex-col gap-12 text-center">
        <p className={`text-devroom-title ${BIG}`}>{t('preview.phone.title')}</p>
        <p className={`px-10 py-8 border-2 border-devroom-conf-line bg-devroom-conf-bg text-devroom-conf-text text-left ${SMALL}`}>
          {t('preview.phone.security')}
        </p>
        <Button variant="accent" size="md" data-testid="preview-ask" onClick={ask}>
          {sent ? t('preview.phone.sent') : t('preview.phone.ask')}
        </Button>
        <Button size="md" data-testid="preview-back" onClick={() => (phone ? openDevroomPage(project, task, 'terminal') : setDevroomTab('terminal'))}>
          {t('preview.phone.back')}
        </Button>
        <p className={`text-text-muted ${SMALL}`}>{t('preview.phone.note')}</p>
        <p className={`text-text-muted ${SMALL}`}>{t('preview.phone.tunnel')}</p>
      </div>
    </div>
  );
}
