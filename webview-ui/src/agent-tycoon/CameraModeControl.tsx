/** GFX2: one toggle, 자동 / 자유 시점, and the way back to the title scene. OWNER-AVATAR: in the free
 *  camera, '내 캐릭터' follows the owner's again, in both modes. HUD-1B (owner 11-04): on a desktop a
 *  40px strip right under the elevator's ▲ 1F ▼ (FloorControls), the floor and where to look in one
 *  place; on a phone a covered strip in the office's bottom-right corner. */
import { Button } from '../components/ui/Button.js';
import { CAMERA_CONTROL_EDGE_GAP_PX, CAMERA_CONTROL_Z_INDEX } from '../constants.js';
import { t } from '../i18n/index.js';
import { setCameraMode, useCameraMode } from './cameraMode.js';
import { PixelIcon } from './game/parts.js';
import { showTitleScene } from './gfx/titleSceneState.js';
import { Icon } from './icons/Icon.js';
import { followOwner } from './useGameControls.js';

/** `phone`: the group is a covered strip for the framing (UI-PHONE: the framed rooms and the lobby
 *  board sit clear of it, not under it). */
export function CameraModeControl({ phone = false }: { phone?: boolean }) {
  const mode = useCameraMode();
  const free = mode === 'free';
  const toggle = {
    'aria-pressed': free,
    title: t(free ? 'gfx.camera.freeHint' : 'gfx.camera.autoHint'),
    'data-testid': 'camera-toggle',
    'data-mode': free ? 'free' : 'auto',
    onClick: () => setCameraMode(free ? 'auto' : 'free'),
  };
  if (!phone)
    return (
      <nav className="agty-camera-strip" aria-label={t('gfx.camera.label')} data-testid="camera-modes">
        <button type="button" className="agty-camera-btn" aria-label={t(free ? 'gfx.camera.free' : 'gfx.camera.auto')} {...toggle}>
          <Icon name="camera" pixel={null} />
          {t(free ? 'gfx.camera.freeShort' : 'gfx.camera.autoShort')}
        </button>
        <button type="button" className="agty-camera-btn" aria-label={t('owner.me')} title={t('owner.followHint')} data-testid="owner-follow" onClick={followOwner}>
          <PixelIcon name="person" />
        </button>
        <button type="button" className="agty-camera-btn" aria-label={t('gfx.title.open')} title={t('gfx.title.openHint')} data-testid="title-open" onClick={showTitleScene}>
          <PixelIcon name="home" />
        </button>
      </nav>
    );
  return (
    <div
      className="absolute bottom-8 pixel-panel flex gap-2 p-2"
      style={{ zIndex: CAMERA_CONTROL_Z_INDEX, right: `calc(var(--agty-safe-right) + ${CAMERA_CONTROL_EDGE_GAP_PX}px)` }}
      role="group"
      aria-label={t('gfx.camera.label')}
      data-testid="camera-modes"
      data-hud-fixed=""
    >
      <Button size="sm" variant={free ? 'active' : 'default'} {...toggle}>
        {t(free ? 'gfx.camera.free' : 'gfx.camera.auto')}
      </Button>
      <Button size="sm" title={t('owner.followHint')} data-testid="owner-follow" onClick={followOwner}>
        {t('owner.me')}
      </Button>
      <Button size="sm" title={t('gfx.title.openHint')} data-testid="title-open" onClick={showTitleScene}>
        {t('gfx.title.open')}
      </Button>
    </div>
  );
}
