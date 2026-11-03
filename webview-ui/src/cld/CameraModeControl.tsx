/** GFX2: one toggle, 자동 / 자유 시점, and the way back to the title scene, in the office's
 *  bottom-right corner. OWNER-AVATAR: in the free camera, '내 캐릭터' follows the owner's again, in both modes. */
import { Button } from '../components/ui/Button.js';
import { CAMERA_CONTROL_Z_INDEX } from '../constants.js';
import { t } from '../i18n/index.js';
import { setCameraMode, useCameraMode } from './cameraMode.js';
import { showTitleScene } from './gfx/titleSceneState.js';
import { followOwner } from './useGameControls.js';

/** `phone`: the group is a covered strip for the framing (UI-PHONE: the framed rooms and the lobby
 *  board sit clear of it, not under it). */
export function CameraModeControl({ phone = false }: { phone?: boolean }) {
  const mode = useCameraMode();
  const free = mode === 'free';
  return (
    <div
      className="absolute right-[calc(var(--cld-safe-right)+8px)] bottom-8 pixel-panel flex gap-2 p-2"
      style={{ zIndex: CAMERA_CONTROL_Z_INDEX }}
      role="group"
      aria-label={t('gfx.camera.label')}
      data-testid="camera-modes"
      data-hud-fixed={phone ? '' : undefined}
    >
      <Button
        size="sm"
        variant={free ? 'active' : 'default'}
        aria-pressed={free}
        title={t(free ? 'gfx.camera.freeHint' : 'gfx.camera.autoHint')}
        data-testid="camera-toggle"
        data-mode={free ? 'free' : 'auto'}
        onClick={() => setCameraMode(free ? 'auto' : 'free')}
      >
        {t(free ? 'gfx.camera.free' : 'gfx.camera.auto')}
      </Button>
      <Button
        size="sm"
        title={t('owner.followHint')}
        data-testid="owner-follow"
        onClick={followOwner}
      >
        {t('owner.me')}
      </Button>
      <Button
        size="sm"
        title={t('gfx.title.openHint')}
        data-testid="title-open"
        onClick={showTitleScene}
      >
        {t('gfx.title.open')}
      </Button>
    </div>
  );
}
