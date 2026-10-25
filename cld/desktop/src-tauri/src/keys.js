// Window keys and history buttons for every page in the main window (the bundled start pages and
// the office alike), injected by lib.rs. The office-keys capability lets the office call only the
// window commands used here. Tested in Chromium by cld/desktop/scripts/keys-chromium.mjs.
(() => {
  // macOS takes Cmd where Windows and Linux take Ctrl (Cmd+R, Cmd+Shift+T, Cmd+,).
  const mac = /Mac/.test(navigator.platform);
  const mod = (e) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;
  // The office's own history entries ({cldBoard}, {cldAttach}, {cldTab}: an overlay or panel it
  // pushed). Back pops those, which closes them; it never leaves the page.
  const inPage = () => {
    const state = history.state;
    return (
      !!state && typeof state === 'object' && Object.keys(state).some((k) => k.startsWith('cld'))
    );
  };
  const back = () => {
    if (inPage()) history.back();
  };

  addEventListener(
    'keydown',
    (e) => {
      // Alt+Left / Alt+Right and the keyboard's Back / Forward keys never navigate the window
      // (macOS: Option+arrows stay word moves; WKWebView has no back key of its own).
      const nav =
        e.key === 'BrowserBack' || e.key === 'BrowserForward'
          ? e.key
          : !mac &&
              e.altKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
            ? e.key
            : '';
      if (nav) {
        e.preventDefault();
        if (!e.repeat && (nav === 'BrowserBack' || nav === 'ArrowLeft')) back();
        return;
      }
      if (e.repeat) return;
      let cmd = null;
      if (e.code === 'F11' && !e.ctrlKey && !e.metaKey) cmd = 'toggle_fullscreen';
      else if (mod(e) && e.shiftKey && e.code === 'KeyT') cmd = 'toggle_on_top';
      else if (mod(e) && !e.shiftKey && e.code === 'Comma') cmd = 'open_settings';
      else if (
        (mod(e) && !e.shiftKey && e.code === 'KeyR') ||
        (e.code === 'F5' && !e.ctrlKey && !e.metaKey && !e.altKey)
      ) {
        // In a terminal both stay the terminal's (Ctrl+R: the shell's reverse search, F5: a TUI key).
        if (e.target.closest && e.target.closest('.xterm')) return;
        e.preventDefault();
        location.reload(); // the office restores its place itself (G1)
        return;
      }
      if (!cmd) return;
      e.preventDefault();
      window.__TAURI_INTERNALS__.invoke(cmd).catch(() => {});
    },
    true,
  );

  // Mouse side buttons (3 back, 4 forward): never a navigation. Back still pops the office's own entry.
  // Not on pointerdown: preventing it would also drop the mouse events the page listens to.
  for (const type of ['mousedown', 'mouseup', 'auxclick']) {
    addEventListener(
      type,
      (e) => {
        if (e.button !== 3 && e.button !== 4) return;
        e.preventDefault();
        if (type === 'mouseup' && e.button === 3) back();
      },
      true,
    );
  }
})();
