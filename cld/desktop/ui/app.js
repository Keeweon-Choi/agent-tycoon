'use strict';
// The page only renders what Rust says (ui_state) and sends the answers back.
// Rust navigates here again whenever the screen switches (welcome, where, settings, status).
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const form = $('settings');
const password = $('password');
const where = $('where');
let config = {};
let sending = false;
let screen = '';

function showMode() {
  for (const box of form.querySelectorAll('fieldset[data-mode]')) {
    // Disabled fields skip the browser's checks, so a hidden mode never blocks saving.
    box.hidden = box.disabled = box.dataset.mode !== form.elements.mode.value;
  }
  $('save').textContent = form.elements.mode.value === 'local' ? '다음' : '저장하고 연결';
}

const fail = (el) => (err) => {
  el.textContent = String(err);
};

/** "WSL 배포판 Ubuntu" or "이 컴퓨터(Windows)": the saved choice in words. */
function localName(c, platform) {
  if (c.localEnv === 'wsl') return `WSL 배포판 ${c.distro}`;
  return `이 컴퓨터(${{ windows: 'Windows', macos: 'macOS', linux: 'Linux' }[platform] ?? platform})`;
}

function renderSteps(state) {
  const list = $('steps');
  list.hidden = state.step === null || state.step === undefined;
  if (list.hidden) return;
  list.replaceChildren(
    ...state.steps.map((name, i) => {
      const li = document.createElement('li');
      li.textContent = name;
      if (i < state.step) li.className = 'done';
      else if (i === state.step) li.className = state.failed ? 'failed' : 'now';
      return li;
    }),
  );
}

async function poll() {
  const state = await invoke('ui_state');
  if (state.screen !== screen) return location.reload();
  $('where-line').textContent = state.whereLine;
  $('where-line').hidden = !state.whereLine;
  $('other-box').hidden = !state.whereLine;
  $('status-line').textContent = state.status;
  $('status-detail').textContent = state.detail;
  $('tailscale-help').hidden = !state.tailscaleHelp;
  $('hostkey').hidden = state.ask !== 'hostkey';
  $('hostkey-fp').textContent = state.fingerprint;
  const asking = state.ask === 'password' && !sending;
  if (asking && password.hidden) {
    password.hidden = false;
    password.elements.password.focus();
  }
  password.hidden = !asking;
  $('install').hidden = state.ask !== 'install';
  $('install-adopt').hidden = !state.adopt;
  $('policy').hidden = !state.askPolicy;
  $('start').hidden = state.ask !== 'start';
  renderSteps(state);
  $('leftover').hidden = !state.failed;
  $('leftover-list').replaceChildren(
    ...state.leftover.map((line) =>
      Object.assign(document.createElement('li'), { textContent: line }),
    ),
  );
  $('lines-box').hidden = !state.lines.length;
  const text = state.lines.join('\n');
  if ($('lines').textContent !== text) $('lines').textContent = text;
}

async function showKey() {
  const fingerprint = await invoke('device_key');
  $('key-fp').textContent = fingerprint || '아직 없습니다. 처음 SSH로 연결할 때 만듭니다.';
  $('key-forget').disabled = !fingerprint;
}

/** Windows: WSL2 distros, Windows itself, or another computer (H §4.1). */
async function showWhere() {
  where.hidden = false;
  const options = await invoke('local_options');
  const choices = [
    ...options.distros.map((d) => ({
      value: `wsl:${d.name}`,
      label: `WSL 배포판 ${d.name}에서 실행`,
      note: '이미 쓰고 있는 Linux 개발 환경에서 에이전트가 일합니다.',
    })),
    {
      value: 'native',
      label: 'Windows에서 바로 실행',
      note: options.nativeInstalled
        ? '이 컴퓨터에 이미 설치돼 있어요.'
        : 'WSL 없이 Windows에서 에이전트가 일합니다.',
    },
    {
      value: 'elsewhere',
      label: '다른 컴퓨터에 연결',
      note: '이미 사무실이 있는 컴퓨터(호스트)에 붙습니다.',
    },
  ];
  $('where-list').replaceChildren(
    ...choices.map((c) => {
      const label = document.createElement('label');
      const input = Object.assign(document.createElement('input'), {
        type: 'radio',
        name: 'where',
        value: c.value,
      });
      input.checked = c.value === options.recommended;
      const small = Object.assign(document.createElement('small'), { textContent: c.note });
      label.append(input, ` ${c.label}${c.value === options.recommended ? ' (추천)' : ''}`, small);
      return label;
    }),
  );
  $('where-detail').textContent = options.distros.length
    ? `WSL2 배포판: ${options.distros.map((d) => `${d.name}${d.default ? ' (기본)' : ''}${d.running ? ' · 실행 중' : ''}`).join(', ')}\n` +
      '고른 배포판 안에서만 명령을 보냅니다(wsl.exe -d <배포판>). 설치하는 곳과 실행하는 곳이 같습니다.\n' +
      'WSL에 이미 사무실이 있으면 Windows에 또 설치하지 않습니다.'
    : 'WSL2 배포판이 없습니다(wsl.exe -l -v). Windows에서 바로 실행하거나 다른 컴퓨터에 연결하세요.';
}

async function start() {
  const state = await invoke('ui_state');
  screen = state.screen;
  config = state.config;
  if (screen === 'welcome') {
    $('welcome').hidden = false;
    return;
  }
  if (screen === 'where') return showWhere();
  if (screen === 'status') {
    $('status').hidden = false;
    poll();
    setInterval(poll, 500);
    return;
  }
  for (const el of form.elements) {
    if (el.type === 'radio') el.checked = el.value === config.mode;
    else if (el.name in config) el.value = config[el.name];
  }
  $('local-now').textContent =
    config.mode === 'local' ? `지금: ${localName(config, state.platform)}` : '';
  $('error').textContent = state.detail;
  showMode();
  form.hidden = false;
  showKey();
}

form.addEventListener('change', showMode);
/** Address + 8-digit code -> the invitation link (T-0024); a pasted invitation stays as it is. */
function withCode(url, code) {
  const digits = code.replace(/\s+/g, '');
  if (!digits || /\/login\?(.*&)?code=/.test(url)) return url;
  return `${url.replace(/\/?$/, '/')}login?code=${encodeURIComponent(digits)}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (form.elements.mode.value === 'local') return invoke('local_choose').catch(fail($('error')));
  const next = { ...config, mode: form.elements.mode.value };
  for (const el of form.elements) {
    if (el.name && el.type !== 'radio' && el.name !== 'code')
      next[el.name] = el.type === 'number' ? Number(el.value) : el.value.trim();
  }
  if (next.mode === 'tailscale') next.url = withCode(next.url, form.elements.code.value);
  try {
    await invoke('save_config', { config: next });
  } catch (err) {
    $('error').textContent = String(err);
  }
});
where.addEventListener('submit', (event) => {
  event.preventDefault();
  const choice = where.elements.where?.value;
  if (!choice) return;
  if (choice === 'elsewhere') return invoke('open_settings');
  const [env, distro = ''] = choice.split(/:(.*)/);
  invoke('choose_local', { env, distro }).catch(fail($('where-error')));
});
password.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = password.elements.password;
  const value = input.value;
  input.value = '';
  sending = true;
  password.hidden = true;
  try {
    await invoke('ssh_password', { password: value });
  } catch (err) {
    $('status-detail').textContent = String(err);
  } finally {
    sending = false;
  }
});
$('here').addEventListener('click', () => invoke('start_here').catch(fail($('status-detail'))));
$('elsewhere').addEventListener('click', () => invoke('open_settings'));
$('other').addEventListener('click', () => invoke('local_choose'));
$('where-back').addEventListener('click', () => invoke('reconnect'));
$('install-go').addEventListener('click', () => {
  const policy = $('policy').hidden
    ? null
    : document.querySelector('input[name="policy"]:checked').value;
  invoke('local_install', { policy }).catch(fail($('status-detail')));
});
$('start-go').addEventListener('click', () =>
  invoke('local_start').catch(fail($('status-detail'))),
);
$('hostkey-accept').addEventListener('click', () =>
  invoke('accept_host_key').catch(fail($('status-detail'))),
);
$('key-register').addEventListener('click', () => invoke('register_again').catch(fail($('error'))));
$('key-forget').addEventListener('click', async () => {
  if (
    !confirm(
      '이 기기 키와 수락한 호스트 키를 지울까요? 다음 SSH 연결 때 호스트 키 확인과 비밀번호를 한 번 더 묻습니다.',
    )
  )
    return;
  try {
    await invoke('forget_key');
  } catch (err) {
    $('error').textContent = String(err);
  }
  showKey();
});
$('cancel').addEventListener('click', () => invoke('reconnect'));
$('retry').addEventListener('click', () => invoke('reconnect'));
$('to-settings').addEventListener('click', () => invoke('open_settings'));
// Right click: no webview menu (reload, back, …) except where there is text to copy or edit, the
// rule of the office's input policy (webview-ui/src/cld/inputPolicy.ts) for these plain pages.
addEventListener(
  'contextmenu',
  (event) => {
    const text = 'input, textarea, [contenteditable]:not([contenteditable="false"]), code, pre';
    if (!(event.target instanceof Element && event.target.closest(text))) event.preventDefault();
  },
  true,
);
start();
