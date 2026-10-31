/** MSG-UI3: Settings' "내 프사": pick an image, crop it square in the browser, send 128x128 to the daemon.
 *  OWNER-AVATAR: and "내 캐릭터" above it: its 꾸미기 (the preset grid), and a 프사 made from its face. */
import { useRef, useState } from 'react';

import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { openLooks, OWNER_LOOK_KEY, ownerLook, useLooksUi } from './characters/looks.js';
import { FACE_PX, OwnerFace } from './messenger/Faces.js';
import { useCldStore } from './officeStore.js';
import {
  OWNER_PICTURE_SIDE,
  OWNER_PICTURE_URL,
  ownerPictureChanged,
  squarePng,
} from './ownerPicture.js';
import { serverText } from './serverText.js';
import { SettingRow } from './SettingRow.js';

const ENDPOINT = 'cld/profile/owner';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** The owner's character's face, scaled whole-pixel to the picture's side, as a PNG. */
function facePng(face: HTMLCanvasElement | null | undefined): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = OWNER_PICTURE_SIDE;
  const ctx = canvas.getContext('2d');
  if (!face || !ctx) return Promise.resolve(null);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(face, 0, 0, OWNER_PICTURE_SIDE, OWNER_PICTURE_SIDE);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** `onPickLook`: the 꾸미기 window is opening (Settings closes for it). */
export function OwnerPictureOption({ onPickLook }: { onPickLook?: () => void }) {
  const { officeReadOnly, characterPresets } = useCldStore();
  useLooksUi(); // a preset sheet that finished loading redraws the face
  const look = ownerLook(characterPresets) ?? { palette: 0, hueShift: 0 };
  const face = useRef<HTMLSpanElement>(null);
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
  const fromCharacter = async () => {
    const png = await facePng(face.current?.querySelector('canvas'));
    if (!png) return setError(t('msgui3.profile.failed', { error: 'no canvas' }));
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
    <>
      <SettingRow
        testId="owner-character-option"
        lead={
          <span ref={face} className="shrink-0 border border-border">
            <CharacterMugShot palette={look.palette} hueShift={look.hueShift} size={FACE_PX} />
          </span>
        }
        title={t('owner.settings.title')}
        help={t('owner.settings.help')}
        stacked
      >
        <Button
          size="sm"
          data-testid="owner-character-pick"
          onClick={() => {
            onPickLook?.();
            openLooks(OWNER_LOOK_KEY);
          }}
        >
          {t('owner.settings.pick')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void fromCharacter()}>
          {t('owner.settings.toPicture')}
        </Button>
      </SettingRow>
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
    </>
  );
}
