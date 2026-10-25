/** GFX: the four camera modes and the way back to the title scene, one small row in the office's bottom-right corner. */
import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { askFraming, CAMERA_MODES, setCameraMode, useCameraMode } from './cameraMode.js';
import { showTitleScene } from './gfx/titleSceneState.js';

export function CameraModeControl({ phone }: { phone: boolean }) {
  const mode = useCameraMode(phone);
  return (
    <div
      className="absolute right-8 bottom-8 z-20 pixel-panel flex gap-2 p-2"
      role="group"
      aria-label={t('gfx.camera.label')}
      data-testid="camera-modes"
    >
      {CAMERA_MODES.map((m) => (
        <Button
          key={m}
          size="sm"
          variant={mode === m ? 'active' : 'default'}
          aria-pressed={mode === m}
          title={t(`gfx.camera.${m}Hint`)}
          // Pressed again: frame again (a manual pan or zoom had taken over).
          onClick={() => (mode === m ? askFraming() : setCameraMode(m))}
        >
          {t(`gfx.camera.${m}`)}
        </Button>
      ))}
      <Button
        size="sm"
        className="ml-4"
        title={t('gfx.title.openHint')}
        data-testid="title-open"
        onClick={showTitleScene}
      >
        {t('gfx.title.open')}
      </Button>
    </div>
  );
}
