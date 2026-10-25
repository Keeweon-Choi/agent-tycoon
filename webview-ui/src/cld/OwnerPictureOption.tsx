/** MSG-UI3: Settings' "내 프사": pick an image, crop it square in the browser, send 128x128 to the daemon. */
import { useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { OwnerFace } from './messenger/Faces.js';
import { useCldStore } from './officeStore.js';
import { OWNER_PICTURE_URL, ownerPictureChanged, squarePng } from './ownerPicture.js';
import { serverText } from './serverText.js';
import { SettingRow } from './SettingRow.js';

const ENDPOINT = 'cld/profile/owner';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function OwnerPictureOption() {
  const { officeReadOnly } = useCldStore();
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (officeReadOnly) return null;
  const send = async (init: RequestInit, has: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(ENDPOINT, { credentials: 'same-origin', ...init });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(serverText(body, `HTTP ${res.status}`));
      }
      ownerPictureChanged(has);
    } catch (err) {
      setError(t('msgui3.profile.failed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file: File) => {
    let png: Blob;
    try {
      png = await squarePng(file);
    } catch (err) {
      setError(t('msgui3.profile.failed', { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    await send(
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ png: base64(new Uint8Array(await png.arrayBuffer())) }),
      },
      true,
    );
  };
  return (
    <div data-testid="owner-picture-option" data-url={OWNER_PICTURE_URL}>
      <SettingRow
        lead={<OwnerFace />}
        title={t('msgui3.profile.title')}
        help={t('msgui3.profile.help')}
        note={
          error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )
        }
        stacked
      >
        <Button size="sm" disabled={busy} onClick={() => picker.current?.click()}>
          {t('msgui3.profile.pick')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void send({ method: 'DELETE' }, false)}>
          {t('msgui3.profile.reset')}
        </Button>
      </SettingRow>
      <input
        ref={picker}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid="owner-picture-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
