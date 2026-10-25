import { useEffect } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { cldToast } from '../officeStore.js';
import { repoCancel, repoConfirmNow, repoConnectionLost, useRepoStore } from './repoStore.js';
import { confirmText } from './repoText.js';

/**
 * The confirmation dialog of every repository write (T-0020), the same dialog
 * as the engine's (ActionLayer). Mounted once, at the app's top level:
 * position:fixed inside the mobile shell's transformed track would size to the
 * track. The result comes back as the app's one toast.
 */
export function RepoActionLayer() {
  const { confirm } = useRepoStore();
  useEffect(
    () =>
      transport.onStateChange((state) => {
        if (state !== 'connected') repoConnectionLost(cldToast);
      }),
    [],
  );
  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') repoCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);
  const text = confirm && confirmText(confirm);
  return (
    <Modal isOpen={!!confirm} onClose={repoCancel} title={confirm?.project} zIndex={60}>
      {confirm && text && (
        <div className="px-10 pb-8" role="alertdialog" aria-label={text.question}>
          <p className="text-base">{text.question}</p>
          {text.quote && (
            <pre
              className="mt-8 max-h-[160px] overflow-auto whitespace-pre-wrap break-words bg-black/30 p-8 text-xs"
              aria-label={t('repo.commitMessage')}
            >
              {text.quote}
            </pre>
          )}
          {text.note && <p className="text-sm text-text-muted mt-4">{text.note}</p>}
          <div className="flex justify-end gap-8 mt-16">
            <Button
              variant={text.danger ? 'default' : 'accent'}
              className={text.danger ? 'bg-danger! border-danger!' : ''}
              size="sm"
              onClick={() =>
                repoConfirmNow(
                  (msg) => transport.send(msg),
                  transport.state === 'connected',
                  cldToast,
                )
              }
            >
              {text.button}
            </Button>
            <Button size="sm" onClick={repoCancel} autoFocus>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
