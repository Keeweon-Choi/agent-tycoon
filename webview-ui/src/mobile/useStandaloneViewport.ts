import { useEffect } from 'react';

import { standaloneBottomShortfall } from './standaloneViewport.js';

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** An inset in px, read through the page's own variable (so a test can set it). */
function insetPx(side: 'top' | 'bottom'): number {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;visibility:hidden;padding-top:var(--cld-safe-${side})`;
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return px;
}

/**
 * A Home-Screen app whose viewport falls short of the screen (standaloneViewport.ts): the page
 * cannot draw past the viewport, so the band under it is given the Dock's colour, and the home
 * indicator, which lies in that band, is no longer padded inside the viewport.
 */
export function useStandaloneViewport(): void {
  useEffect(() => {
    const html = document.documentElement;
    const reset = () => {
      html.style.removeProperty('--cld-safe-bottom');
      html.style.removeProperty('background');
    };
    const apply = () => {
      reset();
      const shortfall = isStandalone()
        ? standaloneBottomShortfall(screen.height, window.innerHeight, insetPx('top'))
        : 0;
      if (!shortfall) return;
      html.style.setProperty(
        '--cld-safe-bottom',
        `${Math.max(0, insetPx('bottom') - shortfall)}px`,
      );
      html.style.background = 'var(--color-bg)';
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    document.addEventListener('visibilitychange', apply);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      document.removeEventListener('visibilitychange', apply);
      reset();
    };
  }, []);
}
