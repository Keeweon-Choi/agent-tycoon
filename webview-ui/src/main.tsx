import './index.css';
// Bundled by Vite into the SPA's own CSS — the standalone server must serve
// every asset itself (no CDN).
import '@xterm/xterm/css/xterm.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { installExternalLinks } from './cld/externalLinks.js';
import { installInputPolicy } from './cld/inputPolicy.js';
import { isCldMock } from './cld/mock.js';
import { PIXEL_FONT_PRELOAD, PIXEL_FONT_PRELOAD_TEXT } from './constants.js';
import { getLanguage, subscribeLanguage, t } from './i18n/index.js';
import { isBrowserRuntime } from './runtime';

async function main() {
  installInputPolicy(); // G1: game areas get no browser menu / drag
  if (isBrowserRuntime) installExternalLinks(); // G2: another origin never replaces the app
  // The page's name in its language (index.html and the manifest carry the English one).
  const nameThePage = () => {
    document.title = t('srv.app_name');
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', document.title);
  };
  nameThePage();
  subscribeLanguage(nameThePage);
  // Korean room names can be drawn on canvas before they appear in the DOM.
  // English pages let unicode-range load Galmuri only when Hangul is drawn.
  if (getLanguage() === 'ko')
    for (const face of PIXEL_FONT_PRELOAD)
      document.fonts.load(face, PIXEL_FONT_PRELOAD_TEXT).catch(() => undefined);
  // Browser fixtures serve Vite development and the explicit ?cldMock=1 demo.
  // Otherwise assets arrive from the standalone server over WebSocket.
  if (isBrowserRuntime && (import.meta.env.DEV || isCldMock)) {
    const { initBrowserMock } = await import('./browserMock.js');
    await initBrowserMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

main().catch(console.error);
