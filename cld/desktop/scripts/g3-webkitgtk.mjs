#!/usr/bin/env node
// G3 on Linux: the real desktop app (WebKitGTK) under WebDriver, the office of a daemon in a temp
// HOME, each input of the G3 table pressed for real (WebDriver actions go through GDK), what the
// page saw written to cld/artifacts/g3/webkitgtk.json, and the X screen saved after each step
// (WebDriver's own screenshot hangs here; native menus are outside the page anyway).
//
//   node cld/desktop/scripts/g3-webkitgtk.mjs --app <agent-tycoon> --tauri-driver <bin> \
//        --native-driver <WebKitWebDriver> --home <temp HOME with a running daemon> --display :97
//
// Needs an X server on --display (Xvfb; never the desktop's :0), `dbus-run-session`, python3.
// The whole driver/app process group is ours and is killed at the end. How to set it up without
// sudo: cld/docs/design/g3-input-matrix.md.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '..', 'artifacts', 'g3');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : process.argv[i + 1];
};
const o = {
  app: arg('app'),
  driver: arg('tauri-driver'),
  native: arg('native-driver'),
  home: arg('home'),
  display: arg('display', ':97'),
  port: Number(arg('port', '4444')),
};
for (const [k, v] of Object.entries(o)) if (!v) throw new Error(`--${k} is required`);
if (o.display === ':0') throw new Error('never the desktop display');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(path.join(out, 'error.png'), { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = `http://127.0.0.1:${o.port}`;
async function call(method, p, body, ms = 60_000) {
  const r = await fetch(W + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(ms),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${JSON.stringify(j.value ?? j)}`);
  return j.value;
}

const env = {
  PATH: `${path.dirname(o.native)}:/usr/bin:/bin`,
  HOME: o.home,
  // A fresh app config each run: the first-run screen again (the install record stays in HOME).
  XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'g3-config-')),
  DISPLAY: o.display,
  GDK_BACKEND: 'x11',
  NO_AT_BRIDGE: '1',
  WEBKIT_DISABLE_COMPOSITING_MODE: '1',
  LANG: 'C.UTF-8',
};
// Its own process group: dbus, tauri-driver, WebKitWebDriver and the app all end with it.
const driver = spawn(
  'dbus-run-session',
  ['--', o.driver, '--port', String(o.port), '--native-driver', o.native],
  {
    env,
    detached: true,
    stdio: [
      'ignore',
      fs.openSync(path.join(os.tmpdir(), 'g3-driver.log'), 'w'),
      fs.openSync(path.join(os.tmpdir(), 'g3-driver.log'), 'a'),
    ],
  },
);
const killAll = () => {
  try {
    process.kill(-driver.pid, 'SIGTERM');
  } catch {
    // already gone
  }
};
process.on('exit', killAll);

const shot = (name) =>
  execFileSync('python3', [
    '-I',
    path.join(here, 'xshot.py'),
    o.display,
    path.join(out, `${name}.png`),
    '1280',
    '800',
  ]);
const rows = [];
const note = (id, input, where, seen, extra = {}) => {
  rows.push({ id, input, where, seen, ...extra });
  console.log(`${id} ${input} @ ${where}: ${seen}`);
};

try {
  for (let i = 0; i < 50; i++) {
    try {
      await call('GET', '/status', undefined, 2000);
      break;
    } catch {
      await sleep(200);
    }
  }
  const s = await call(
    'POST',
    '/session',
    { capabilities: { alwaysMatch: { 'tauri:options': { application: o.app } } } },
    180_000,
  );
  const S = `/session/${s.sessionId}`;
  const js = (script, args = []) => call('POST', `${S}/execute/sync`, { script, args });
  const ELEMENT = 'element-6066-11e4-a07c-4ac2be52f05e';
  const find = async (css) =>
    Object.values(await call('POST', `${S}/element`, { using: 'css selector', value: css }))[0];
  // Pointer targets as viewport points (the centre of the element): WebKitWebDriver refuses element origins here.
  const el = async (css) => {
    const at = await js(
      'const r = document.querySelector(arguments[0]).getBoundingClientRect(); const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2); const top = document.elementFromPoint(x, y); return { x, y, top: top && top.tagName }',
      [css],
    );
    return at;
  };
  const actions = (list) =>
    call('POST', `${S}/actions`, { actions: list }).finally(() =>
      call('DELETE', `${S}/actions`).catch(() => {}),
    );
  const mouse = (at, steps) => ({
    type: 'pointer',
    id: 'mouse',
    parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerMove', origin: 'viewport', x: at.x, y: at.y }, ...steps],
  });
  const click = (origin, button) =>
    actions([
      mouse(origin, [
        { type: 'pointerDown', button },
        { type: 'pointerUp', button },
      ]),
    ]);
  const keys = (...chord) =>
    actions([
      {
        type: 'key',
        id: 'kb',
        actions: [
          ...chord.map((value) => ({ type: 'keyDown', value })),
          ...chord.reverse().map((value) => ({ type: 'keyUp', value })),
        ],
      },
    ]);
  const CTRL = '';
  const ALT = '';
  const SHIFT = '';
  const ESC = '';

  // What the page saw: events at the end of their path (window, bubble), after every handler ran.
  const PROBE = `
    const id = Math.random().toString(36).slice(2);
    window.__g3 = { id, events: [] };
    for (const type of ['contextmenu', 'mousedown', 'auxclick', 'keydown', 'wheel', 'paste', 'dragstart', 'popstate'])
      addEventListener(type, (e) => window.__g3.events.push({ type, button: e.button, key: e.key, ctrl: e.ctrlKey,
        target: e.target && e.target.tagName, prevented: e.defaultPrevented }), false);
    return id;`;
  const probe = () => js(PROBE);
  const seen = (type) =>
    js(`return window.__g3 ? window.__g3.events.filter((e) => e.type === arguments[0]) : null`, [
      type,
    ]);
  const zoom = () =>
    js(
      'return { dpr: devicePixelRatio, w: innerWidth, scale: visualViewport ? visualViewport.scale : 1 }',
    );
  const url = () => call('GET', `${S}/url`);

  // ── The bundled start page ─────────────────────────────────
  for (
    let i = 0;
    i < 60 &&
    !(await js(
      "return !!document.getElementById('here') && !document.getElementById('welcome').hidden",
    ).catch(() => false));
    i++
  )
    await sleep(500);
  await probe();
  await click(await el('h1'), 2);
  await sleep(800);
  shot('start-rightclick');
  const startMenu = await seen('contextmenu');
  note(
    'S1',
    'right click',
    'start page (ui/)',
    startMenu?.[0]?.prevented ? 'prevented: no webview menu' : 'NOT prevented',
  );
  await keys(ESC);
  await js(
    "const t = Object.assign(document.createElement('input'), { id: 'g3-start' }); document.querySelector('main').append(t); return true",
  );
  await click(await el('#g3-start'), 2);
  await sleep(500);
  note(
    'S2',
    'right click',
    'start page text field',
    (await seen('contextmenu')).at(-1)?.prevented
      ? 'prevented (wrong)'
      : "not prevented: the text menu is the webview's",
  );
  await keys(ESC);

  // ── Into the office (this computer: the temp HOME's daemon) ─
  await call('POST', `${S}/element/${await find('#here')}/click`, {});
  let office = '';
  for (let i = 0; i < 60 && !office.startsWith('http://127.0.0.1'); i++) {
    await sleep(1000);
    office = await url();
  }
  if (!office.startsWith('http://127.0.0.1'))
    throw new Error(`the office did not open (${office})`);
  await sleep(8000);
  shot('office');
  // A text area to test against: the office's own if one is visible, else two test textareas.
  await js(`
    for (const name of ['g3-a', 'g3-b']) {
      const t = document.createElement('textarea');
      t.id = name; t.value = name === 'g3-a' ? 'primary words here' : '';
      Object.assign(t.style, { position: 'fixed', left: name === 'g3-a' ? '20px' : '260px', top: '20px', width: '200px', height: '40px', zIndex: 99999 });
      document.body.append(t);
    }
    const hud = [...document.querySelectorAll('button, span, div, p, h1, h2, h3')].find((n) =>
      n.offsetParent && n.childNodes.length && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim().length > 2) &&
      !n.closest('input, textarea, [contenteditable], .xterm, [data-selectable]'));
    if (hud) hud.setAttribute('data-g3', 'hudtext');
    return true;`);
  await probe();
  const canvas = await el('canvas');
  note('--', 'canvas centre', 'office', `(${canvas.x}, ${canvas.y}) is a ${canvas.top}`);

  await click(canvas, 2);
  await sleep(800);
  shot('office-rightclick-canvas');
  const cm = await seen('contextmenu');
  note(
    'O1',
    'right click',
    'office canvas',
    cm.at(-1)?.prevented ? 'prevented: no browser menu' : 'NOT prevented',
    { events: cm },
  );
  await keys(ESC);

  await click(await el('#g3-a'), 2);
  await sleep(800);
  shot('office-rightclick-text');
  const cmText = await seen('contextmenu');
  note(
    'O2',
    'right click',
    'text area',
    cmText.at(-1)?.prevented
      ? 'prevented (wrong)'
      : 'not prevented (left to WebKitGTK; under WebDriver no menu window appeared: office-rightclick-text.png)',
    { events: cmText.slice(-1) },
  );
  await keys(ESC);

  const hud = await el('[data-g3=hudtext]').catch(() => null);
  if (hud) {
    await actions([
      mouse(hud, [
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ]),
    ]);
    const selected = await js('return String(getSelection())');
    note(
      'O3',
      'double click (select)',
      'game text (HUD)',
      selected ? `selected "${selected.slice(0, 30)}"` : 'nothing selected',
    );
  }

  for (const button of [3, 4]) {
    const before = await url();
    await click(canvas, button);
    await sleep(800);
    const after = await url();
    const md = (await seen('mousedown')).filter((e) => e.button === button);
    note(
      `O4.${button}`,
      `mouse side button ${button === 3 ? 'back' : 'forward'}`,
      'office canvas',
      `${before === after ? 'no navigation' : `navigated to ${after}`}; mousedown ${md.length ? (md.at(-1).prevented ? 'prevented' : 'not prevented') : 'not seen'}`,
    );
  }

  const z0 = await zoom();
  await actions([
    {
      type: 'key',
      id: 'kb',
      actions: [
        { type: 'keyDown', value: CTRL },
        { type: 'pause', duration: 0 },
        { type: 'pause', duration: 0 },
        { type: 'keyUp', value: CTRL },
      ],
    },
    {
      type: 'wheel',
      id: 'wheel',
      actions: [
        { type: 'pause', duration: 0 },
        { type: 'scroll', origin: 'viewport', x: canvas.x, y: canvas.y, deltaX: 0, deltaY: -240 },
        { type: 'pause', duration: 0 },
        { type: 'pause', duration: 0 },
      ],
    },
  ]);
  await sleep(800);
  const wheel = await seen('wheel');
  note(
    'O5',
    'Ctrl + wheel',
    'office canvas',
    `page zoom ${JSON.stringify(z0) === JSON.stringify(await zoom()) ? 'unchanged' : 'CHANGED'}; wheel ${wheel.length ? `reached the page (ctrl ${wheel.at(-1).ctrl}, ${wheel.at(-1).prevented ? 'prevented' : 'not prevented'})` : 'not seen'}`,
  );
  for (const [name, k] of [
    ['Ctrl + =', '='],
    ['Ctrl + -', '-'],
    ['Ctrl + 0', '0'],
  ]) {
    const before = await zoom();
    await keys(CTRL, k);
    await sleep(600);
    note(
      'O6',
      name,
      'office',
      `page zoom ${JSON.stringify(before) === JSON.stringify(await zoom()) ? 'unchanged' : 'CHANGED'}`,
    );
  }

  // Middle-click paste: select in A (the X PRIMARY selection), middle-click into B.
  const a = await el('#g3-a');
  await actions([
    mouse(a, [
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ]),
  ]);
  const sel = await js(
    "const t = document.getElementById('g3-a'); return t.value.slice(t.selectionStart, t.selectionEnd)",
  );
  await click(await el('#g3-b'), 1);
  await sleep(600);
  const pasted = await js("return document.getElementById('g3-b').value");
  note(
    'O7',
    'middle click',
    'text area',
    `${pasted ? `pasted "${pasted}"` : 'nothing pasted'} (selected first: "${sel}")`,
  );
  await click(canvas, 1);
  await sleep(400);
  const mid = (await seen('mousedown')).filter((e) => e.button === 1);
  note(
    'O7b',
    'middle click',
    'office canvas',
    `mousedown ${mid.at(-1)?.prevented ? 'prevented (pan)' : 'not prevented'}; nothing pasted into the game`,
  );

  const beforeBack = await url();
  await keys(ALT, ''); // Alt+Left
  await sleep(800);
  note(
    'O8',
    'Alt + Left',
    'office',
    beforeBack === (await url()) ? 'no navigation' : `navigated to ${await url()}`,
  );
  // The office's own entry (an overlay it pushed): Alt+Left pops it and stays on the page.
  await js(
    "history.pushState({ cldG3: true }, ''); window.__g3pops = 0; addEventListener('popstate', () => (window.__g3pops += 1)); return true",
  );
  await keys(ALT, '\uE012');
  await sleep(800);
  const pops = await js('return window.__g3pops');
  note(
    'O8b',
    'Alt + Left',
    'office with its own history entry',
    `${pops === 1 ? 'popped the entry' : `popstate ${pops}`}, ${beforeBack === (await url()) ? 'no navigation' : `navigated to ${await url()}`}`,
  );

  await keys(CTRL, SHIFT, 'i');
  await sleep(1500);
  shot('office-devtools-keys');
  note(
    'O9',
    'Ctrl + Shift + I',
    'office',
    'see office-devtools-keys.png (an inspector would be a second window)',
  );

  for (const [id, name, chord] of [
    ['O10', 'F5', ['']],
    ['O11', 'Ctrl + R', [CTRL, 'r']],
  ]) {
    const mark = await probe();
    await click(canvas, 0).catch(() => {});
    await keys(...chord);
    await sleep(3000);
    const still = await js('return window.__g3 && window.__g3.id').catch(() => null);
    note(id, name, 'office canvas', still === mark ? 'no reload' : 'reloaded');
  }
  shot('office-end');
} catch (error) {
  note('ERR', 'runner', '', String(error.message ?? error));
  try {
    shot('error');
  } catch {
    // no screen
  }
} finally {
  fs.writeFileSync(path.join(out, 'webkitgtk.json'), `${JSON.stringify(rows, null, 2)}\n`);
  killAll();
  await sleep(500);
  fs.rmSync(env.XDG_CONFIG_HOME, { recursive: true, force: true });
}
