import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { t } from '../../i18n/index.js';
import { passkeyStepUp } from '../shell/shellApi.js';
import { passkeyError } from './authApi.js';
import { setStepUpAsker } from './stepUp.js';

/** S1: the passkey tap behind a dangerous action, when the device key could not prove by itself. */
export function StepUpPrompt() {
  const [done, setDone] = useState<((ok: boolean) => void) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setStepUpAsker((resolve) => {
      setError('');
      setDone(() => resolve);
    });
    return () => setStepUpAsker(null);
  }, []);
  if (!done) return null;
  const finish = (ok: boolean) => {
    done(ok);
    setDone(null);
  };
  return (
    <Modal isOpen onClose={() => finish(false)} title={t('stepup.title')} zIndex={90}>
      <div className="px-10 pb-10 flex flex-col gap-10 max-w-[400px]" data-testid="stepup-prompt">
        <p className="text-base m-0">{t('stepup.call')}</p>
        {error && <p className="text-sm text-red-400 m-0">{error}</p>}
        <div className="flex justify-end gap-8">
          <Button
            size="sm"
            variant="accent"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await passkeyStepUp();
                finish(true);
              } catch (err) {
                setError(passkeyError(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('terminal.verifyFace')}
          </Button>
          <Button size="sm" onClick={() => finish(false)}>
            {t('stepup.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
