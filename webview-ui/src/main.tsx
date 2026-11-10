import './index.css';
// Bundled by Vite into the SPA's own CSS — the standalone server must serve
// every asset itself (no CDN).
import '@xterm/xterm/css/xterm.css';
import './cld/uiTheme.js';
import './cld/game/gameMotion.js';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { installErrorReports, reportError } from './cld/errorReport.js';
import { installExternalLinks } from './cld/externalLinks.js';
import { installInputPolicy } from './cld/inputPolicy.js';
import { isCldMock } from './cld/mock.js';
import { cldGetSnapshot, cldSubscribe } from './cld/officeStore.js';
import { RegionBoundary } from './cld/RegionBoundary.js';
import { PIXEL_FONT_PRELOAD, PIXEL_FONT_PRELOAD_TEXT } from './constants.js';
import { getLanguage, t } from './i18n/index.js';

async function main() {
  installErrorReports(); // T-74: an uncaught error or rejection reaches the daemon log
  installInputPolicy(); // G1: game areas get no browser menu / drag
  installExternalLinks(); // G2: another origin never replaces the app
  // The page's name in its language (index.html and the manifest carry the English one), and
  // which host it is (MHO 3.6: two offices in one browser). The Home-Screen name stays the app's.
  const nameThePage = () => {
    const app = t('srv.app_name');
    const host = cldGetSnapshot().hostInfo?.hostName;
    const title = host ? `${app} · ${host}` : app;
    if (document.title !== title) document.title = title;
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', app);
  };
  nameThePage();
  cldSubscribe(nameThePage); // also tells of language changes
  // Korean room names can be drawn on canvas before they appear in the DOM.
  // English pages let unicode-range load Galmuri only when Hangul is drawn.
  if (getLanguage() === 'ko')
    for (const face of PIXEL_FONT_PRELOAD)
      document.fonts.load(face, PIXEL_FONT_PRELOAD_TEXT).catch(() => undefined);
  // Browser fixtures serve Vite development and the explicit ?cldMock=1 demo.
  // Otherwise assets arrive from the standalone server over WebSocket.
  if (import.meta.env.DEV || isCldMock) {
    const { initBrowserMock } = await import('./browserMock.js');
    await initBrowserMock();
  }
  // T-74: past every region's boundary, a render error still leaves its cause in the daemon log.
  createRoot(document.getElementById('root')!, {
    onUncaughtError: (error, info) => reportError('boundary', error, 'root', info.componentStack),
  }).render(
    <StrictMode>
      <RegionBoundary region="root" className="absolute inset-0 m-auto h-fit w-fit">
        <App />
      </RegionBoundary>
    </StrictMode>,
  );
}

main().catch(console.error);
