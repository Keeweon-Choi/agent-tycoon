/** The visible −, %, + and reset of a text zoom surface (the gestures are zoomStore's `useZoomHost`). */
import { t } from '../i18n/index.js';
import { zoomPercent,type ZoomSurface } from './zoomState.js';
import { useTextZoom } from './zoomStore.js';

const btn =
  'border-2 border-border bg-btn-bg px-6 min-w-24 leading-[1.4] shadow-pixel hover:bg-btn-hover disabled:opacity-(--btn-disabled-opacity)';

export function ZoomBar({ surface }: { surface: ZoomSurface }) {
  const { zoom, step, reset } = useTextZoom(surface);
  return (
    <span
      className="inline-flex items-center gap-4 text-xs"
      role="group"
      aria-label={t('zoom.label')}
      data-testid={`zoom-${surface}`}
      data-zoom={zoom}
    >
      <button type="button" className={btn} aria-label={t('zoom.out')} title={t('zoom.out')} onClick={() => step(-1)}>
        −
      </button>
      <button
        type="button"
        className="min-w-44 text-center tabular-nums hover:text-accent-text"
        aria-label={t('zoom.reset')}
        title={t('zoom.reset')}
        onClick={reset}
      >
        {zoomPercent(zoom)}%
      </button>
      <button type="button" className={btn} aria-label={t('zoom.in')} title={t('zoom.in')} onClick={() => step(1)}>
        +
      </button>
    </span>
  );
}
