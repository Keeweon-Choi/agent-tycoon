import { useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { authFetch, type Me, passkeyError, stepUpText } from './authApi.js';
import { forgetDevice } from './deviceKey.js';

/**
 * AUTH-PK2: the way out when this browser lost this device's key -- sign this device
 * out (its key on the host and here) and open the code login, where a 기기 추가 code
 * from another device makes it a new device. Shown wherever the lost-key note is
 * (`note`: the text a failed action shows); nothing for any other note.
 */
export function Relogin({ note }: { note: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (note !== stepUpText('lostKey')) return null;
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const me = await authFetch<Me>('/api/auth/me');
      await authFetch(`/api/auth/sessions/${encodeURIComponent(me.id)}`, { method: 'DELETE' });
      await forgetDevice();
      window.location.replace('/');
    } catch (err) {
      setError(passkeyError(err));
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="accent" disabled={busy} onClick={() => void go()} data-testid="security-relogin">
        {t('stepup.relogin')}
      </Button>
      {error && <p className="m-0 text-xs text-red-400">{error}</p>}
    </>
  );
}
