/** GFX2: one toggle, 자동 / 자유 시점, and the way back to the title scene, in the office's
 *  bottom-right corner. */
import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { setCameraMode, useCameraMode } from './cameraMode.js';
import { showTitleScene } from './gfx/titleSceneState.js';

export function CameraModeControl() {
  const mode = useCameraMode();
  const free = mode === 'free';
  return (
    <div
      className="absolute right-[calc(var(--cld-safe-right)+8px)] bottom-8 z-20 pixel-panel flex gap-2 p-2"
      role="group"
      aria-label={t('gfx.camera.label')}
      data-testid="camera-modes"
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
        title={t('gfx.title.openHint')}
        data-testid="title-open"
        onClick={showTitleScene}
      >
        {t('gfx.title.open')}
      </Button>
    </div>
  );
}
