#!/usr/bin/env node
// The desktop app's window keys and history buttons (src-tauri/src/keys.js) and the start pages'
// right-click rule (ui/app.js) in headless Chromium, the engine behind WebView2. Real input through
// the DevTools protocol (side buttons included), each navigation case with a negative control
// without keys.js.
//
//   node cld/desktop/scripts/keys-chromium.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEYS = fs.readFileSync(path.join(here, '..', 'src-tauri', 'src', 'keys.js'), 'utf8');
const START = pathToFileURL(path.join(here, '..', 'ui', 'index.html')).href;
const PAGE = `<!doctype html><title>t</title><h1>page</h1><div class="xterm"><textarea id="term"></textarea></div><input id="text">`;
const server = http.createServer((_q, r) =>
  r.writeHead(200, { 'content-type': 'text/html' }).end(PAGE),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome =
  process.env.PLAYWRIGHT_CHROME ??
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-gpu'],
  executablePath: fs.existsSync(chrome) ? chrome : undefined,
});
const results = [];
const ok = (name) => results.push(`ok ${name}`);
const step = (text) => process.env.DEBUG && console.log(`… ${text}`);

/** A page on /a, then /b (one history step back to /a). `keys`: keys.js in every page; `mac`: as on macOS. */
async function open({ keys = true, mac = false } = {}) {
  const context = await browser.newContext();
  if (mac)
    await context.addInitScript(() =>
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }),
    );
  await context.addInitScript(() => {
    window.__calls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (cmd) => void window.__calls.push(cmd) };
    window.__mark = Math.random();
  });
  if (keys) await context.addInitScript(KEYS);
  const page = await context.newPage();
  await page.goto(`${base}/a`);
  await page.goto(`${base}/b`);
  const cdp = await context.newCDPSession(page);
  const side = async (button) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await cdp.send('Input.dispatchMouseEvent', { type, x: 50, y: 20, button, clickCount: 1 });
    await page.waitForTimeout(400);
  };
  const path_ = () => new URL(page.url()).pathname;
  const mark = () => page.evaluate(() => window.__mark);
  // Keys Playwright has no name for (BrowserBack 0xA6, BrowserForward 0xA7), as a keyboard sends them.
  const media = async (key, vk) => {
    for (const type of ['keyDown', 'keyUp'])
      await cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: vk });
  };
  return { context, page, side, media, path: path_, mark };
}

try {
  // ── Side buttons ──
  {
    step('side control');
    const control = await open({ keys: false });
    await control.side('back');
    const controlMoved = control.path() === '/a';
    await control.context.close();
    const t = await open();
    await t.side('back');
    assert.equal(t.path(), '/b', 'side back navigated');
    await t.page.goBack();
    await t.page.waitForTimeout(200);
    await t.side('forward');
    assert.equal(t.path(), '/a', 'side forward navigated');
    // The office's own entry: back pops it (popstate, the overlay closes) and the page stays.
    await t.page.goForward();
    await t.page.evaluate(() => {
      history.pushState({ cldBoard: true }, '');
      window.__pops = 0;
      addEventListener('popstate', () => (window.__pops += 1));
    });
    await t.side('back');
    assert.equal(
      await t.page.evaluate(() => window.__pops),
      1,
      'side back did not pop the office entry',
    );
    assert.equal(t.path(), '/b');
    await t.side('back'); // nothing of ours left: no navigation
    assert.equal(t.path(), '/b');
    await t.context.close();
    ok(
      `side buttons never navigate; back pops the office's own entry (control without keys.js ${controlMoved ? 'navigated back' : 'did not navigate either: Chromium headless'})`,
    );
  }

  // ── Alt+Left / Alt+Right / BrowserBack ──
  {
    const prevented = async (t, key) =>
      t.page.evaluate(
        (k) =>
          new Promise((resolve) => {
            setTimeout(() => resolve('no keydown'), 1500);
            addEventListener(
              'keydown',
              (e) => e.key === k.split('+').pop() && setTimeout(() => resolve(e.defaultPrevented)),
            );
          }),
        key,
      );
    const t = await open();
    for (const key of ['Alt+ArrowLeft', 'Alt+ArrowRight', 'BrowserBack', 'BrowserForward']) {
      step(key);
      const seen = prevented(t, key);
      if (key.startsWith('Browser')) await t.media(key, key === 'BrowserBack' ? 0xa6 : 0xa7);
      else await t.page.keyboard.press(key);
      assert.equal(await seen, true, `${key} not prevented`);
      assert.equal(t.path(), '/b', `${key} navigated`);
    }
    await t.page.evaluate(() => {
      history.pushState({ cldAttach: true }, '');
      window.__pops = 0;
      addEventListener('popstate', () => (window.__pops += 1));
    });
    await t.page.keyboard.press('Alt+ArrowLeft');
    await t.page.waitForTimeout(300);
    assert.equal(
      await t.page.evaluate(() => window.__pops),
      1,
      'Alt+Left did not pop the office entry',
    );
    await t.context.close();
    const mac = await open({ mac: true });
    const seen = prevented(mac, 'Alt+ArrowLeft');
    await mac.page.keyboard.press('Alt+ArrowLeft');
    assert.equal(await seen, false, 'macOS Option+Left must stay a word move');
    await mac.context.close();
    ok(
      'Alt+Left/Right and BrowserBack/Forward prevented, back pops the office entry; macOS Option+Left left alone',
    );
  }

  // ── Reload: Ctrl+R, F5, and the terminal's own keys ──
  {
    const reloads = async (t, key, focus) => {
      const before = await t.mark();
      if (focus) await t.page.focus(focus);
      await t.page.keyboard.press(key);
      await t.page.waitForTimeout(600);
      return (await t.mark()) !== before;
    };
    const t = await open();
    assert.equal(await reloads(t, 'Control+r'), true, 'Ctrl+R');
    assert.equal(await reloads(t, 'F5'), true, 'F5');
    assert.equal(await reloads(t, 'Control+r', '#term'), false, 'Ctrl+R in a terminal');
    assert.equal(await reloads(t, 'F5', '#term'), false, 'F5 in a terminal');
    assert.equal(await reloads(t, 'Meta+r'), false, 'Win+R is not a reload off macOS');
    await t.page.keyboard.press('Control+Shift+T');
    await t.page.keyboard.press('Control+Comma');
    assert.deepEqual(await t.page.evaluate(() => window.__calls), [
      'toggle_on_top',
      'open_settings',
    ]);
    await t.context.close();
    const mac = await open({ mac: true });
    assert.equal(await reloads(mac, 'Meta+r'), true, 'Cmd+R');
    assert.equal(await reloads(mac, 'Meta+r', '#term'), false, 'Cmd+R in a terminal');
    await mac.page.keyboard.press('Meta+Shift+T');
    await mac.page.keyboard.press('Meta+Comma');
    await mac.page.keyboard.press('Control+Comma'); // Ctrl is not the macOS modifier
    assert.deepEqual(await mac.page.evaluate(() => window.__calls), [
      'toggle_on_top',
      'open_settings',
    ]);
    await mac.context.close();
    ok(
      'Ctrl+R and F5 reload (not in a terminal), Ctrl+Shift+T and Ctrl+, reach the app; macOS: the same with Cmd',
    );
  }

  // ── Start pages: right click ──
  {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.__TAURI__ = {
        core: {
          invoke: async (cmd) => (cmd === 'ui_state' ? { screen: 'welcome', config: {} } : null),
        },
      };
    });
    const page = await context.newPage();
    await page.goto(START);
    await page.waitForSelector('#welcome:not([hidden])');
    await page.evaluate(() => {
      const input = Object.assign(document.createElement('input'), { id: 'probe' });
      document
        .querySelector('main')
        .append(
          input,
          Object.assign(document.createElement('code'), { id: 'fp', textContent: 'SHA256:x' }),
        );
      window.__menus = [];
      addEventListener('contextmenu', (e) =>
        window.__menus.push([
          (e.target.closest('[id]') ?? e.target).id || e.target.tagName,
          e.defaultPrevented,
        ]),
      );
    });
    for (const target of ['h1', '#here', '#probe', '#fp'])
      await page.click(target, { button: 'right' });
    assert.deepEqual(await page.evaluate(() => window.__menus), [
      ['H1', true],
      ['here', true],
      ['probe', false],
      ['fp', false],
    ]);
    await context.close();
    ok('start pages: no webview menu, except in a text field and on copyable text');
  }
} finally {
  await browser.close();
  server.close();
}
console.log(results.join('\n'));
