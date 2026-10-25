import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

/**
 * The GPU renderer for a terminal pane: xterm's DOM renderer rebuilds row
 * elements on every write, which is what made typing feel sticky. Loaded after
 * `term.open()`; the DOM renderer stays when WebGL2 is missing or throws, and
 * comes back when the GPU context is lost. The pane's host says which one
 * draws (`data-renderer`).
 *
 * `localStorage['cld.terminal-renderer'] = 'dom'` keeps the DOM renderer (a
 * device whose WebGL misdraws; the test runners, which read `.xterm-rows`).
 */
export const TERMINAL_RENDERER_KEY = 'cld.terminal-renderer';

function domForced(): boolean {
  try {
    return localStorage.getItem(TERMINAL_RENDERER_KEY) === 'dom';
  } catch {
    return false;
  }
}

export function loadWebglRenderer(term: Terminal, host: HTMLElement): void {
  host.dataset.renderer = 'dom';
  if (domForced()) return;
  let webgl: WebglAddon;
  try {
    // The constructor throws too (Safari before 16 without WebGL2).
    webgl = new WebglAddon();
  } catch (err) {
    console.warn('[Webview] Terminal: no WebGL renderer, the DOM one draws', err);
    return;
  }
  try {
    term.loadAddon(webgl);
  } catch (err) {
    console.warn('[Webview] Terminal: no WebGL renderer, the DOM one draws', err);
    try {
      webgl.dispose();
    } catch {
      // never activated: nothing to undo
    }
    return;
  }
  host.dataset.renderer = 'webgl';
  webgl.onContextLoss(() => {
    webgl.dispose();
    host.dataset.renderer = 'dom';
  });
}
