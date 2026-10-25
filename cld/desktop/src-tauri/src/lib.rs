//! Agent Tycoon: one window around the cld-gui office (this computer, Tailscale or an ssh tunnel).

mod connect;
#[cfg(desktop)]
mod local;
#[cfg(desktop)]
mod owner;

use connect::{Nav, LADDER};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// The bundled ui/ page; its origin per platform is spelled out in `connect::classify`.
const LOCAL_UI: &str = if cfg!(any(windows, target_os = "android")) {
    "http://tauri.localhost/index.html"
} else {
    "tauri://localhost/index.html"
};
const LOG_MAX: u64 = 1_000_000;

/// Window keys and the history buttons for every page in the main window, the remote office
/// included (keys.js). The office-keys capability lets the office call only the window commands
/// and open_external.
#[cfg(desktop)]
const KEYS_JS: &str = include_str!("keys.js");

/// Links that would open a second window (target=_blank, Ctrl/Shift-click) and window.open:
/// the app has no second window, so web URLs go to the default browser via open_external.
/// If the page may not call it (an office origin outside office-keys), the native new-window
/// request still reaches on_new_window, which opens the browser too. Same-window links are
/// left to on_navigation. The page's own handlers run first (bubble phase on window).
#[cfg(desktop)]
const LINKS_JS: &str = r#"
(() => {
  const nativeOpen = window.open;
  const web = (href) => {
    try {
      const url = new URL(String(href), location.href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  };
  const external = (url) =>
    Promise.resolve()
      .then(() => window.__TAURI_INTERNALS__.invoke('open_external', { url }))
      .catch(() => nativeOpen.call(window, url, '_blank', 'noopener'));
  window.open = function (url, ...rest) {
    const href = url ? web(url) : null;
    if (!href) return nativeOpen.call(this, url, ...rest);
    external(href);
    return null;
  };
  addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || e.defaultPrevented || e.button !== 0) return;
    const target = (a.getAttribute('target') || '_self').toLowerCase();
    const away = !['_self', '_top', '_parent'].includes(target) || e.ctrlKey || e.shiftKey || e.metaKey;
    const href = away ? web(a.href) : null;
    if (!href) return;
    e.preventDefault();
    external(href);
  });
})();
"#;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    mode: String,
    url: String,
    ssh_target: String,
    ssh_port: u16,
    local_port: u16,
    remote_port: u16,
    login_command: String,
    always_on_top: bool,
    /// mode "local" (이 컴퓨터에서 시작): "wsl" (Windows, in `distro`) or "native".
    local_env: String,
    distro: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mode: "tailscale".into(),
            url: String::new(), // the user types it: no default host ships in the app
            ssh_target: String::new(),
            ssh_port: 2233,
            local_port: 18240,
            remote_port: 18240,
            login_command: "~/.local/bin/cld-gui-login".into(),
            always_on_top: false,
            local_env: String::new(),
            distro: String::new(),
        }
    }
}

impl Config {
    /// Checked before saving and before every use: nothing odd reaches ssh or the window.
    fn check(&self) -> Result<(), String> {
        let ports = [self.ssh_port, self.local_port, self.remote_port];
        let problem = match self.mode.as_str() {
            "tailscale" if !connect::valid_url(&self.url) => {
                "주소는 https:// 로 시작해야 합니다 (테스트용으로 http://localhost 허용)"
            }
            "ssh" if !connect::valid_target(&self.ssh_target) => {
                "SSH 대상은 user@host 형식이어야 합니다 (영문, 숫자, . _ - 만)"
            }
            "ssh" if ports.contains(&0) => "포트는 1–65535 사이여야 합니다",
            "ssh" if !connect::valid_login(&self.login_command) => {
                "로그인 명령은 제어 문자 없는 한 줄이어야 합니다"
            }
            "local" if self.local_env == "native" => return Ok(()),
            #[cfg(desktop)]
            "local"
                if self.local_env == "wsl"
                    && cfg!(windows)
                    && local::valid_distro(&self.distro) =>
            {
                return Ok(())
            }
            "local" => "이 컴퓨터에서 실행할 곳을 다시 고르세요",
            "tailscale" | "ssh" => return Ok(()),
            _ => "연결 방법이 올바르지 않습니다",
        };
        Err(problem.into())
    }
}

#[derive(Default)]
struct App {
    /// None until the first save.
    config: Mutex<Option<Config>>,
    /// What the local page shows; it polls `ui_state`.
    view: Mutex<View>,
    /// Bumped by every (re)connect and by opening settings; older loops see it and stop.
    generation: AtomicU64,
    tunnel: Mutex<Option<Tunnel>>,
    /// 다시 등록: the next SSH connect asks for the password before trying the key.
    #[cfg(desktop)]
    register_next: std::sync::atomic::AtomicBool,
    /// A registration just succeeded; if the key still fails, the password dialog says why.
    #[cfg(desktop)]
    registered: std::sync::atomic::AtomicBool,
    #[cfg(desktop)]
    on_top_item: std::sync::OnceLock<tauri::menu::CheckMenuItem<tauri::Wry>>,
    /// `agty start --hold` in the chosen WSL distro: keeps it (and the daemon) up. Left running
    /// when the app quits, so agents keep working (H §4.3 "필요할 때만": closing keeps the work going).
    holder: Mutex<Option<Child>>,
}

#[derive(Clone, Default)]
struct View {
    settings: bool,
    status: String,
    detail: String,
    /// A question in the status view. The ladder stops until the answer reconnects.
    ask: Ask,
    /// Tailscale mode could not resolve the office host: show the install/login hint.
    tailscale_help: bool,
    /// The tunnel's port is held by another program: nothing more is tried until 다시 연결.
    refused: bool,
    /// 이 컴퓨터에서 시작 on Windows: the "where" screen (WSL distro, Windows, elsewhere).
    choosing: bool,
    /// 이 컴퓨터에서 시작 on Windows is looking at the distros to choose by itself.
    deciding: bool,
    /// Install progress: index into `local::STEPS` while installing or after a failure.
    step: Option<usize>,
    failed: bool,
    /// The manager's own lines, shown under 자세히 (never a code or token: it prints neither).
    lines: Vec<String>,
    /// After a failed install: what was left on this computer.
    leftover: Vec<String>,
}

#[derive(Clone, Default, PartialEq)]
enum Ask {
    #[default]
    Nothing,
    /// The host refused this device's key but takes a password: register the key with it.
    Password,
    /// First contact: the user accepts this known_hosts line by its fingerprint.
    HostKey { line: String, fingerprint: String },
    /// Nothing installed here: install the bundled daemon (asking the start policy where it applies).
    Install { adopt: bool, policy: bool },
    /// Installed, off, start policy manual: the user presses 시작.
    Start,
}

struct Tunnel {
    child: Child,
    /// The 127.0.0.1 port this ssh forwards; the office URL and the login code use it.
    port: u16,
    /// A first tunnel already lost its port to another program; this one is the retry.
    retried: bool,
    /// Newest non-empty stderr line, kept by the thread that drains the pipe.
    last_err: Arc<Mutex<String>>,
}

#[tauri::command]
fn ui_state(app: AppHandle) -> serde_json::Value {
    let st = app.state::<App>();
    let config = st.config.lock().unwrap().clone();
    let view = st.view.lock().unwrap().clone();
    let (ask, fingerprint) = match &view.ask {
        Ask::Nothing => ("", ""),
        Ask::Password => ("password", ""),
        Ask::HostKey { fingerprint, .. } => ("hostkey", fingerprint.as_str()),
        Ask::Install { .. } => ("install", ""),
        Ask::Start => ("start", ""),
    };
    let (adopt, ask_policy) = match view.ask {
        Ask::Install { adopt, policy } => (adopt, policy),
        _ => (false, false),
    };
    #[cfg(desktop)]
    const STEPS: [&str; 4] = local::STEPS;
    #[cfg(not(desktop))]
    const STEPS: [&str; 0] = [];
    #[cfg(desktop)]
    let screen = local::screen(
        config.is_some() || view.deciding,
        view.settings,
        view.choosing,
    );
    #[cfg(desktop)]
    let where_line = config.as_ref().map_or(String::new(), |c| {
        local::where_line(std::env::consts::OS, &c.mode, &c.local_env, &c.distro)
    });
    #[cfg(not(desktop))]
    let where_line = String::new();
    #[cfg(not(desktop))]
    let screen = if view.settings || config.is_none() {
        "settings"
    } else {
        "status"
    };
    serde_json::json!({
        "screen": screen,
        "whereLine": where_line,
        "platform": std::env::consts::OS,
        "adopt": adopt,
        "askPolicy": ask_policy,
        "step": view.step,
        "steps": STEPS,
        "failed": view.failed,
        "lines": view.lines,
        "leftover": view.leftover,
        "settings": screen == "settings",
        "status": view.status,
        "detail": view.detail,
        "ask": ask,
        "fingerprint": fingerprint,
        "tailscaleHelp": view.tailscale_help,
        "saved": config.is_some(),
        "config": config.unwrap_or_default(),
    })
}

#[tauri::command]
fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    config.check()?;
    let mut config = config;
    // Ctrl+Shift+T and the tray own this one.
    config.always_on_top = main_window(&app).is_some_and(|w| w.is_always_on_top().unwrap_or(false));
    write_config(&app, &config).map_err(|e| format!("설정을 저장하지 못했습니다: {e}"))?;
    *app.state::<App>().config.lock().unwrap() = Some(config);
    connect(&app);
    Ok(())
}

#[tauri::command]
fn reconnect(app: AppHandle) {
    connect(&app);
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    show_settings(&app, "");
}

#[tauri::command]
fn toggle_fullscreen(window: WebviewWindow) {
    let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
}

#[tauri::command]
fn toggle_on_top(app: AppHandle) {
    let Some(window) = main_window(&app) else {
        return;
    };
    let on = !window.is_always_on_top().unwrap_or(false);
    let _ = window.set_always_on_top(on);
    let st = app.state::<App>();
    #[cfg(desktop)]
    if let Some(item) = st.on_top_item.get() {
        let _ = item.set_checked(on);
    }
    let mut config = st.config.lock().unwrap();
    if let Some(config) = config.as_mut() {
        config.always_on_top = on;
        let _ = write_config(&app, config);
    }
}

/// A link the page hands over (LINKS_JS): web pages open in the default browser.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|_| "주소가 올바르지 않습니다".to_string())?;
    open_in_browser(&app, &url);
    Ok(())
}

/// The password from the status view: registers this device's key, then connects again.
#[cfg(desktop)]
#[tauri::command]
fn ssh_password(app: AppHandle, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("비밀번호를 입력하세요".into());
    }
    let st = app.state::<App>();
    if st.view.lock().unwrap().ask != Ask::Password {
        return Err("지금은 비밀번호를 받지 않습니다. 다시 연결을 누르세요.".into());
    }
    let Some(config) = st.config.lock().unwrap().clone() else {
        return Err("저장된 설정이 없습니다".into());
    };
    let generation = st.generation.fetch_add(1, SeqCst) + 1;
    view(&app, |v| {
        *v = View {
            status: "이 기기 키를 등록하는 중…".into(),
            ..View::default()
        }
    });
    let app = app.clone();
    thread::spawn(move || {
        let result = register(&app, &config, password);
        let st = app.state::<App>();
        if st.generation.load(SeqCst) != generation {
            return; // 다시 연결 or settings in the meantime
        }
        match result {
            Ok(()) => {
                st.registered.store(true, SeqCst);
                connect(&app);
            }
            Err(Refused::Password) => {
                log(
                    &app,
                    "기기 키 등록 실패: 호스트가 비밀번호를 받지 않았습니다",
                );
                view(&app, |v| {
                    *v = View {
                        status: "비밀번호가 맞지 않습니다".into(),
                        detail: "다시 입력하세요.".into(),
                        ask: Ask::Password,
                        ..View::default()
                    }
                });
            }
            Err(Refused::Other(detail)) => {
                log(&app, &format!("기기 키 등록 실패: {detail}"));
                view(&app, |v| {
                    *v = View {
                        status: "이 기기 키를 등록하지 못했습니다".into(),
                        detail,
                        ..View::default()
                    }
                });
            }
        }
    });
    Ok(())
}

/// The user compared the fingerprint: trust that key for this host, then connect again.
#[cfg(desktop)]
#[tauri::command]
fn accept_host_key(app: AppHandle) -> Result<(), String> {
    let Ask::HostKey { line, fingerprint } = app.state::<App>().view.lock().unwrap().ask.clone()
    else {
        return Err("확인할 호스트 키가 없습니다. 다시 연결을 누르세요.".into());
    };
    let path = ssh_files(&app)?.known_hosts;
    let saved = path
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|_| fs::OpenOptions::new().create(true).append(true).open(&path))
        .and_then(|mut file| writeln!(file, "{line}"));
    saved.map_err(|e| format!("호스트 키를 저장하지 못했습니다: {e}"))?;
    let name = line.split_whitespace().next().unwrap_or_default();
    log(&app, &format!("호스트 키 수락: {name} {fingerprint}"));
    connect(&app);
    Ok(())
}

/// Fingerprint of this device's key for the settings page; None before the first SSH connect.
#[cfg(desktop)]
#[tauri::command(async)]
fn device_key(app: AppHandle) -> Option<String> {
    key_fingerprint(&ssh_files(&app).ok()?)
}

/// 다시 등록: connect with the saved SSH settings, asking for the password first.
#[cfg(desktop)]
#[tauri::command]
fn register_again(app: AppHandle) -> Result<(), String> {
    let st = app.state::<App>();
    if !st
        .config
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|c| c.mode == "ssh")
    {
        return Err("먼저 SSH 설정을 저장하세요".into());
    }
    st.register_next.store(true, SeqCst);
    connect(&app);
    Ok(())
}

/// 키 지우기: this device's key and the host keys it accepted. The next SSH connect makes a
/// new key, asks about the host key and asks for the password once more.
#[cfg(desktop)]
#[tauri::command(async)]
fn forget_key(app: AppHandle) -> Result<(), String> {
    let files = ssh_files(&app)?;
    let fingerprint = key_fingerprint(&files);
    for path in [&files.key, &files.public, &files.known_hosts] {
        match fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("{}을(를) 지우지 못했습니다: {e}", path.display()));
            }
            _ => {}
        }
    }
    log(
        &app,
        &format!(
            "기기 키와 수락한 호스트 키 지움: {}",
            fingerprint.as_deref().unwrap_or("기기 키 없음")
        ),
    );
    Ok(())
}

/// 이 컴퓨터에서 시작: on Windows the app chooses where by itself (`local::auto_choice`) and says so
/// on the progress screen; elsewhere straight to this computer. Nothing is installed or changed
/// here: the choice only leads to today's flow (reuse, or the 설치 question).
#[cfg(desktop)]
#[tauri::command]
fn start_here(app: AppHandle) -> Result<(), String> {
    if !cfg!(windows) {
        return choose_local(app, "native".into(), String::new());
    }
    let generation = app.state::<App>().generation.fetch_add(1, SeqCst) + 1;
    view(&app, |v| {
        *v = View {
            deciding: true,
            status: "이 컴퓨터를 살펴보는 중…".into(),
            ..View::default()
        }
    });
    show_local(&app);
    thread::spawn(move || {
        let distros = wsl_distros();
        let native = native_root().is_some_and(|root| root.join("install.json").is_file());
        let office = |d: &str| {
            find_in_distro(d).is_ok_and(|f| f.record.is_some() || f.config_port.is_some())
                || wsl_health(d, local::DEFAULT_PORT)
        };
        let (env, distro) = local::auto_choice(&distros, native, office, wsl_dev);
        if app.state::<App>().generation.load(SeqCst) != generation {
            return; // 다른 방식으로 실행 or settings in the meantime
        }
        log(
            &app,
            &format!(
                "이 컴퓨터: 고른 곳 {env} {distro} (WSL2 배포판 {}개)",
                distros.len()
            ),
        );
        if let Err(problem) = choose_local(app.clone(), env.into(), distro) {
            view(&app, |v| {
                v.deciding = false;
                v.status = "이 컴퓨터에서 사무실을 열지 못했습니다".into();
                v.detail = problem;
            });
        }
    });
    Ok(())
}

/// 다른 방식으로 실행 (자세히) and settings: today's choice screen (a WSL distro, Windows, elsewhere).
#[cfg(desktop)]
#[tauri::command]
fn local_choose(app: AppHandle) {
    app.state::<App>().generation.fetch_add(1, SeqCst);
    view(&app, |v| {
        *v = View {
            choosing: true,
            ..View::default()
        }
    });
    show_local(&app);
}

/// The distro looks like a dev setup (`local::WSL_DEV`, read only).
#[cfg(desktop)]
fn wsl_dev(distro: &str) -> bool {
    run_tool(
        hidden("wsl.exe").args(local::wsl_script_argv(distro, local::WSL_DEV, &[])),
        b"",
        Duration::from_secs(90),
    )
    .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == "dev")
}

/// What the "where" screen offers: the WSL2 distros (`wsl.exe -l -v`, read only) and whether
/// a Windows install is already there.
#[cfg(desktop)]
#[tauri::command(async)]
fn local_options() -> serde_json::Value {
    let distros = wsl_distros();
    let native_installed = native_root().is_some_and(|root| root.join("install.json").is_file());
    serde_json::json!({
        "recommended": local::recommend(&distros, native_installed),
        "nativeInstalled": native_installed,
        "distros": distros.iter().map(|d| serde_json::json!({
            "name": d.name, "running": d.running, "default": d.default,
        })).collect::<Vec<_>>(),
    })
}

/// The WSL2 distros (`wsl.exe -l -v`, read only); none off Windows.
#[cfg(desktop)]
fn wsl_distros() -> Vec<local::Distro> {
    if !cfg!(windows) {
        return Vec::new();
    }
    run_tool(
        hidden("wsl.exe").args(["-l", "-v"]),
        b"",
        Duration::from_secs(15),
    )
    .ok()
    .filter(|out| out.status.success())
    .map(|out| local::parse_wsl_list(&out.stdout))
    .unwrap_or_default()
}

/// Saves "this computer" (`env` wsl in `distro`, or native) as the choice and starts it.
#[cfg(desktop)]
#[tauri::command]
fn choose_local(app: AppHandle, env: String, distro: String) -> Result<(), String> {
    let st = app.state::<App>();
    let mut config = st.config.lock().unwrap().clone().unwrap_or_default();
    config.mode = "local".into();
    config.distro = if env == "wsl" { distro } else { String::new() };
    config.local_env = env;
    config.check()?;
    config.always_on_top = main_window(&app).is_some_and(|w| w.is_always_on_top().unwrap_or(false));
    write_config(&app, &config).map_err(|e| format!("설정을 저장하지 못했습니다: {e}"))?;
    *st.config.lock().unwrap() = Some(config);
    connect(&app);
    Ok(())
}

/// The answer to "설치할까요?": installs with the chosen start policy, then opens the office.
#[cfg(desktop)]
#[tauri::command]
fn local_install(app: AppHandle, policy: Option<String>) -> Result<(), String> {
    let policy = policy.and_then(|p| local::POLICIES.into_iter().find(|known| *known == p));
    answer_local(
        &app,
        |ask| matches!(ask, Ask::Install { .. }),
        Action::Install(policy),
    )
}

/// 시작 for a manually managed daemon that is off.
#[cfg(desktop)]
#[tauri::command]
fn local_start(app: AppHandle) -> Result<(), String> {
    answer_local(&app, |ask| *ask == Ask::Start, Action::Start)
}

#[cfg(desktop)]
fn answer_local(
    app: &AppHandle,
    asked: impl Fn(&Ask) -> bool,
    action: Action,
) -> Result<(), String> {
    let st = app.state::<App>();
    if !asked(&st.view.lock().unwrap().ask) {
        return Err("지금은 그 답을 받지 않습니다. 다시 연결을 누르세요.".into());
    }
    let Some(config) = st.config.lock().unwrap().clone() else {
        return Err("저장된 설정이 없습니다".into());
    };
    let generation = st.generation.fetch_add(1, SeqCst) + 1;
    view(app, |v| *v = View::default());
    let app = app.clone();
    thread::spawn(move || local_flow(&app, &config, generation, action));
    Ok(())
}

#[cfg(desktop)]
#[derive(Clone, Copy)]
enum Action {
    Look,
    Install(Option<&'static str>),
    Start,
}

/// 이 컴퓨터에서 시작 (H §4.2): find the install, reuse or start it, or install the bundled
/// daemon after asking; then the health check, a one-time login code, and the office.
#[cfg(desktop)]
fn local_flow(app: &AppHandle, config: &Config, generation: u64, action: Action) {
    let live = || app.state::<App>().generation.load(SeqCst) == generation;
    let result = local_steps(app, config, &live, action);
    if !live() {
        return;
    }
    match result {
        Ok(Some(url)) => {
            log(app, &format!("오피스 열기: {}", connect::redact(&url)));
            view(app, |v| {
                v.status = "연결됨".into();
                v.detail.clear();
            });
            if let (Some(window), Ok(url)) = (main_window(app), Url::parse(&url)) {
                let _ = window.navigate(url);
            }
        }
        Ok(None) => {} // a question is on the screen
        Err(problem) => {
            log(app, &format!("이 컴퓨터: {problem}"));
            view(app, |v| {
                v.status = "이 컴퓨터에서 사무실을 열지 못했습니다".into();
                v.detail = problem;
            });
        }
    }
}

#[cfg(desktop)]
fn local_steps(
    app: &AppHandle,
    config: &Config,
    live: &dyn Fn() -> bool,
    action: Action,
) -> Result<Option<String>, String> {
    let wsl = config.local_env == "wsl";
    let status = |text: &str| view(app, |v| v.status = text.into());
    status("이 컴퓨터의 사무실을 찾는 중…");
    let mut found = find_local(config)?;
    let mut healthy = daemon_health(found.port()).is_some();
    if !healthy
        && matches!(action, Action::Look)
        && found.record.is_none()
        && found.config_port.is_some()
    {
        // A source install that does not answer may be restarting: wait before offering to take it over.
        status("이 컴퓨터의 사무실이 다시 켜지기를 기다리는 중…");
        for _ in 0..20 {
            if !live() {
                return Ok(None);
            }
            thread::sleep(Duration::from_secs(1));
            if daemon_health(found.port()).is_some() {
                healthy = true;
                break;
            }
        }
    }
    if !healthy && wsl && wsl_health(&config.distro, found.port()) {
        return Err(format!(
            "WSL 배포판 {} 안에서는 사무실이 돌고 있지만 Windows에서 닿지 않습니다(포트 {}). 아무것도 바꾸지 않았습니다.\nWSL 설정의 localhost 전달(localhostForwarding)을 확인하세요.",
            config.distro,
            found.port()
        ));
    }
    log(
        app,
        &format!(
            "이 컴퓨터({}): 설치 기록 {}, 포트 {}, 응답 {}",
            if wsl {
                config.distro.as_str()
            } else {
                std::env::consts::OS
            },
            if found.record.is_some() {
                "있음"
            } else {
                "없음"
            },
            found.port(),
            if healthy { "있음" } else { "없음" }
        ),
    );
    match action {
        Action::Look => match local::plan(&found, healthy) {
            local::Plan::Open => {}
            local::Plan::Start => start_local(app, config)?,
            local::Plan::AskStart => {
                ask(app, Ask::Start);
                return Ok(None);
            }
            local::Plan::AskInstall { adopt } if cfg!(windows) && !wsl => {
                // One office per user: never a Windows install beside a WSL one that is just off.
                if let Some(d) = wsl_distros().into_iter().find(|d| {
                    find_in_distro(&d.name)
                        .is_ok_and(|f| f.record.is_some() || f.config_port.is_some())
                }) {
                    return Err(format!(
                        "WSL 배포판 {}에 이미 사무실이 있어 Windows에는 설치하지 않았습니다.\n설정 > 이 컴퓨터에서 그 배포판을 고르세요.",
                        d.name
                    ));
                }
                ask(
                    app,
                    Ask::Install {
                        adopt,
                        policy: false,
                    },
                ); // the policy: WSL and Linux only
                return Ok(None);
            }
            local::Plan::AskInstall { adopt } => {
                let policy = local::asks_policy(&config.local_env, std::env::consts::OS);
                ask(app, Ask::Install { adopt, policy });
                return Ok(None);
            }
        },
        Action::Start => start_local(app, config)?,
        Action::Install(_) if healthy => {} // it answers now: nothing to install
        Action::Install(policy) => {
            install_local(app, config, policy, live)?;
            found = find_local(config)?;
        }
    }
    let port = found.port();
    if wsl && found.record.is_some() {
        hold_distro(app, &config.distro);
    }
    status("사무실을 시작하는 중…");
    let mut waited = 0;
    while daemon_health(port).is_none() {
        if !live() {
            return Ok(None);
        }
        if waited >= 60 {
            return Err(format!(
                "사무실 프로그램이 60초 안에 응답하지 않았습니다 (포트 {port})."
            ));
        }
        thread::sleep(Duration::from_secs(1));
        waited += 1;
    }
    if view_step(app).is_some() {
        view(app, |v| v.step = Some(3));
    }
    status("로그인하는 중…");
    let code = login_local(config, port).map_err(|problem| {
        if found.record.is_none() && found.config_port.is_none() {
            format!("{problem}\n이 컴퓨터의 다른 곳(다른 WSL 배포판이나 Windows)에서 도는 사무실이 이 포트를 쓰는 것 같습니다. 설정에서 그곳을 고르세요.")
        } else {
            problem
        }
    })?;
    Ok(Some(format!("http://127.0.0.1:{port}/login?code={code}")))
}

#[cfg(desktop)]
fn view_step(app: &AppHandle) -> Option<usize> {
    app.state::<App>().view.lock().unwrap().step
}

/// The manager's install root on this computer (not WSL).
#[cfg(desktop)]
fn native_root() -> Option<PathBuf> {
    local::install_root(std::env::consts::OS, |k| std::env::var(k).ok())
}

#[cfg(desktop)]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// The install record and cld-gui's config in the chosen environment (read only).
#[cfg(desktop)]
fn find_local(config: &Config) -> Result<local::Found, String> {
    if config.local_env == "wsl" {
        return find_in_distro(&config.distro);
    }
    let read = |path: Option<PathBuf>| {
        path.and_then(|p| fs::read_to_string(p).ok())
            .unwrap_or_default()
    };
    Ok(local::Found::from_texts(
        &read(native_root().map(|r| r.join("install.json"))),
        &read(home_dir().map(|h| h.join(".config").join("cld-gui").join("config.json"))),
    ))
}

#[cfg(desktop)]
fn find_in_distro(distro: &str) -> Result<local::Found, String> {
    let out = run_tool(
        hidden("wsl.exe").args(local::wsl_script_argv(distro, local::WSL_FIND, &[])),
        b"",
        Duration::from_secs(90),
    )?;
    if !out.status.success() {
        return Err(format!(
            "WSL 배포판 {distro}을(를) 열지 못했습니다.\n{}",
            local::decode(&out.stderr).trim()
        ));
    }
    Ok(local::split_find(&String::from_utf8_lossy(&out.stdout)))
}

/// `/api/health` asked from inside the distro (WSL's localhost forwarding may be off).
#[cfg(desktop)]
fn wsl_health(distro: &str, port: u16) -> bool {
    let port = port.to_string();
    run_tool(
        hidden("wsl.exe").args(local::wsl_script_argv(distro, local::WSL_HEALTH, &[&port])),
        b"",
        Duration::from_secs(30),
    )
    .is_ok_and(|out| {
        out.status.success() && local::parse_health(&String::from_utf8_lossy(&out.stdout)).is_some()
    })
}

/// One HTTP/1.1 exchange with the daemon on 127.0.0.1 (health, login code).
#[cfg(desktop)]
fn http(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> Option<(u16, String)> {
    use std::io::Read;
    let mut stream =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .ok()?;
    stream
        .write_all(local::http_request(method, path, port, token, body).as_bytes())
        .ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    local::parse_http(&response)
}

#[cfg(desktop)]
fn daemon_health(port: u16) -> Option<local::Health> {
    match http(port, "GET", "/api/health", None, "")? {
        (200, body) => local::parse_health(&body),
        _ => None,
    }
}

/// A one-time login code from this computer's daemon, the way the CLI does it: inside WSL its
/// cld-gui-login; natively the host token over loopback (as the manager's open()). The token
/// and the code are never logged.
#[cfg(desktop)]
fn login_local(config: &Config, port: u16) -> Result<String, String> {
    let code = if config.local_env == "wsl" {
        let out = run_tool(
            hidden("wsl.exe").args(local::wsl_script_argv(
                &config.distro,
                local::WSL_LOGIN,
                &[],
            )),
            b"",
            Duration::from_secs(30),
        )?;
        if !out.status.success() {
            return Err(format!(
                "로그인 코드를 받지 못했습니다: {}",
                last_line(local::decode(&out.stderr).as_bytes())
            ));
        }
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        let home = home_dir().ok_or("홈 폴더를 찾지 못했습니다")?;
        let dir = home.join(".pixel-agents");
        let token = local::host_token(
            fs::read_to_string(dir.join("server.json")).ok().as_deref(),
            fs::read_to_string(dir.join("standalone-token"))
                .ok()
                .as_deref(),
        )
        .ok_or("이 컴퓨터의 사무실 열쇠(호스트 토큰)를 찾지 못했습니다.")?;
        match http(port, "POST", "/api/login-code", Some(&token), "{}") {
            Some((200, body)) => local::login_code(&body).unwrap_or_default(),
            Some((status, _)) => {
                return Err(format!("로그인 코드를 받지 못했습니다 (HTTP {status})."))
            }
            None => return Err("로그인 코드를 받지 못했습니다: 사무실이 응답하지 않습니다.".into()),
        }
    };
    if connect::valid_code(&code) {
        Ok(code)
    } else {
        Err("로그인 코드가 올바르지 않습니다.".into())
    }
}

/// Starts an installed daemon that does not answer: the distro's holder (WSL), else `agty start`.
#[cfg(desktop)]
fn start_local(app: &AppHandle, config: &Config) -> Result<(), String> {
    view(app, |v| v.status = "사무실을 시작하는 중…".into());
    if config.local_env == "wsl" {
        hold_distro(app, &config.distro);
        return Ok(());
    }
    let root = native_root().ok_or("설치 폴더를 찾지 못했습니다")?;
    let agty = root
        .join("bin")
        .join(if cfg!(windows) { "agty.cmd" } else { "agty" });
    let out = run_tool(
        hidden(&agty.to_string_lossy()).arg("start"),
        b"",
        Duration::from_secs(60),
    )?;
    if out.status.success() {
        log(app, "이 컴퓨터: 데몬 시작");
        Ok(())
    } else {
        Err(format!(
            "사무실을 시작하지 못했습니다: {}",
            last_line(&out.stderr)
        ))
    }
}

/// One holder per app run (`agty start --hold` in the distro, no window).
#[cfg(desktop)]
fn hold_distro(app: &AppHandle, distro: &str) {
    use std::process::Stdio;
    let st = app.state::<App>();
    let mut slot = st.holder.lock().unwrap();
    if slot
        .as_mut()
        .is_some_and(|c| matches!(c.try_wait(), Ok(None)))
    {
        return;
    }
    // ponytail: one holder for the first distro of this run; a switch in settings keeps the old one until it ends by itself.
    match hidden("wsl.exe")
        .args(local::wsl_script_argv(distro, local::WSL_HOLD, &[]))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => *slot = Some(child),
        Err(e) => log(app, &format!("WSL 유지 프로세스를 띄우지 못했습니다: {e}")),
    }
}

/// Installs the daemon bundle this installer carries (H §3.2) by handing over to the manager,
/// non-interactively: inside the distro (WSL) or with the bundle's own runtime here. On failure
/// the view keeps the step it stopped at and what the manager left.
#[cfg(desktop)]
fn install_local(
    app: &AppHandle,
    config: &Config,
    policy: Option<&'static str>,
    live: &dyn Fn() -> bool,
) -> Result<(), String> {
    let wsl = config.local_env == "wsl";
    view(app, |v| {
        v.status = "설치하는 중…".into();
        v.step = Some(0);
        v.failed = false;
        v.lines.clear();
        v.leftover.clear();
    });
    log(
        app,
        &format!("이 컴퓨터: 설치 시작 (시작 정책 {})", policy.unwrap_or("-")),
    );
    let result = bundled_daemon(app, &config.local_env).and_then(|(bundle, pubkey)| {
        if wsl {
            let (bundle, pubkey) = (bundle.to_string_lossy(), pubkey.to_string_lossy());
            stream_lines(
                app,
                hidden("wsl.exe").args(local::wsl_install_argv(
                    &config.distro,
                    local::plain_path(&bundle),
                    local::plain_path(&pubkey),
                    policy,
                )),
                live,
            )
        } else {
            native_install(app, &bundle, &pubkey, policy, live)
        }
    });
    if let Err(problem) = result {
        let record = find_local(config).ok().and_then(|f| f.record);
        view(app, |v| {
            v.failed = true;
            v.leftover = local::leftovers(record.as_ref());
        });
        log(app, &format!("이 컴퓨터: 설치 실패: {problem}"));
        return Err(format!("설치하지 못했습니다: {problem}"));
    }
    log(app, "이 컴퓨터: 설치 끝");
    Ok(())
}

/// `daemon/<target>/` among the app's resources: the bundle and the key its SHA256SUMS is signed with.
#[cfg(desktop)]
fn bundled_daemon(app: &AppHandle, env: &str) -> Result<(PathBuf, PathBuf), String> {
    let target = local::bundle_target(env, std::env::consts::OS, std::env::consts::ARCH)
        .ok_or("이 컴퓨터용 설치 파일이 이 앱에 들어 있지 않습니다.")?;
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("앱 폴더를 찾지 못했습니다: {e}"))?
        .join("daemon")
        .join(target);
    let names: Vec<String> = fs::read_dir(&dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    let bundle = local::bundle_name(&names, target).ok_or_else(|| {
        format!(
            "이 앱에 {target}용 설치 파일이 없습니다 ({}).",
            dir.display()
        )
    })?;
    let pin = local::pinned(env!("AGENT_TYCOON_BUNDLE_PINS"), target)
        .ok_or("이 앱은 설치 파일 없이 만들어졌습니다. 아무것도 풀지 않았습니다.")?;
    let path = dir.join(&bundle);
    if bundle_sha256(&path).as_deref() != Some(pin) {
        return Err(format!("설치 파일 {bundle}이(가) 이 앱을 만들 때와 다릅니다(SHA-256). 아무것도 풀지 않았습니다. 앱을 다시 설치하세요."));
    }
    Ok((path, dir.join("agent-tycoon-release.pub")))
}

/// The bundle's SHA-256, checked against the pin before tar or the manager sees the file.
#[cfg(desktop)]
fn bundle_sha256(path: &std::path::Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    std::io::copy(&mut fs::File::open(path).ok()?, &mut hasher).ok()?;
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

/// install.ps1 / install.sh's hand-over without a shell: unpack the bundle's runtime and manager
/// into a temp dir with the system tar, run the manager's install with that runtime, clean up.
#[cfg(desktop)]
fn native_install(
    app: &AppHandle,
    bundle: &std::path::Path,
    pubkey: &std::path::Path,
    policy: Option<&'static str>,
    live: &dyn Fn() -> bool,
) -> Result<(), String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let tmp = std::env::temp_dir().join(format!(
        "agent-tycoon-install-{}-{nanos}",
        std::process::id()
    ));
    // A fresh dir only (never one someone made first in a shared /tmp), private on Unix.
    #[cfg_attr(not(unix), allow(unused_mut))] // only Unix sets a mode
    let mut dir = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut dir, 0o700);
    dir.create(&tmp)
        .map_err(|e| format!("임시 폴더를 만들지 못했습니다: {e}"))?;
    let result = (|| {
        // Windows tar.exe (bsdtar) and GNU/BSD tar read .tar.gz with -x.
        let tar = if cfg!(windows) {
            PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()))
                .join("System32")
                .join("tar.exe")
        } else {
            PathBuf::from("tar")
        };
        let (b, t) = (bundle.to_string_lossy(), tmp.to_string_lossy());
        let out = run_tool(
            hidden(&tar.to_string_lossy()).args(local::unpack_args(&b, &t)),
            b"",
            Duration::from_secs(300),
        )?;
        if !out.status.success() {
            return Err(format!(
                "설치 파일을 풀지 못했습니다: {}",
                last_line(&out.stderr)
            ));
        }
        let node = if cfg!(windows) {
            tmp.join("node").join("node.exe")
        } else {
            tmp.join("node").join("bin").join("node")
        };
        let manager = tmp.join("cld").join("install").join("manager.mjs");
        stream_lines(
            app,
            hidden(&node.to_string_lossy()).args(local::manager_install_args(
                &manager.to_string_lossy(),
                &b,
                &pubkey.to_string_lossy(),
                policy,
            )),
            live,
        )
    })();
    let _ = fs::remove_dir_all(&tmp);
    result
}

/// Runs the installer, showing each of its lines (자세히) and the step it reached (main screen).
/// Not stopped when the user leaves the screen: a half-run manager is worse than a finished one.
#[cfg(desktop)]
fn stream_lines(
    app: &AppHandle,
    command: &mut std::process::Command,
    live: &dyn Fn() -> bool,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;
    use std::sync::mpsc;
    const LIMIT: Duration = Duration::from_secs(20 * 60);
    const KEEP: usize = 300;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| not_started(command, e))?;
    let (tx, rx) = mpsc::channel::<String>();
    let pipes: [Option<Box<dyn Read + Send>>; 2] = [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    ];
    for pipe in pipes.into_iter().flatten() {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(pipe).split(b'\n').map_while(Result::ok) {
                let _ = tx.send(local::decode(&line).trim().to_string());
            }
        });
    }
    drop(tx);
    let deadline = std::time::Instant::now() + LIMIT;
    let mut last_error = String::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) if line.is_empty() => {}
            Ok(line) => {
                if line.starts_with('✖') || line.starts_with("agty install:") {
                    last_error = line.trim_start_matches('✖').trim().to_string();
                }
                log(app, &format!("설치: {line}"));
                if live() {
                    view(app, |v| {
                        if let Some(step) = local::step_after(&line) {
                            v.step = Some(step);
                        }
                        v.lines.push(line);
                        let extra = v.lines.len().saturating_sub(KEEP);
                        v.lines.drain(..extra);
                    });
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) if std::time::Instant::now() < deadline => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{}분 안에 끝나지 않아 멈췄습니다",
                    LIMIT.as_secs() / 60
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else if last_error.is_empty() {
        Err(format!(
            "설치 프로그램이 종료 코드 {}로 끝났습니다",
            status.code().unwrap_or(-1)
        ))
    } else {
        Err(last_error)
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn view(app: &AppHandle, change: impl FnOnce(&mut View)) {
    change(&mut app.state::<App>().view.lock().unwrap());
}

fn show_local(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.navigate(Url::parse(LOCAL_UI).expect("LOCAL_UI is a URL"));
    }
}

fn show_settings(app: &AppHandle, detail: &str) {
    app.state::<App>().generation.fetch_add(1, SeqCst);
    view(app, |v| {
        *v = View {
            settings: true,
            detail: detail.into(),
            ..View::default()
        }
    });
    show_local(app);
}

/// (Re)starts connecting with the saved config; without a usable one, shows settings.
fn connect(app: &AppHandle) {
    let st = app.state::<App>();
    let generation = st.generation.fetch_add(1, SeqCst) + 1;
    stop_tunnel(app);
    let config = st.config.lock().unwrap().clone();
    let Some(config) = config else {
        // First run: the welcome screen (이 컴퓨터에서 시작 · 다른 컴퓨터에 연결).
        view(app, |v| *v = View::default());
        return show_local(app);
    };
    if let Err(problem) = config.check() {
        return show_settings(app, &problem);
    }
    log(app, &format!("연결 시작 ({})", config.mode));
    view(app, |v| {
        *v = View {
            status: "연결 준비 중…".into(),
            ..View::default()
        }
    });
    show_local(app);
    let app = app.clone();
    #[cfg(desktop)]
    if config.mode == "local" {
        thread::spawn(move || local_flow(&app, &config, generation, Action::Look));
        return;
    }
    thread::spawn(move || ladder(&app, &config, generation));
}

/// Tries once right away, then after each LADDER wait; gives up when the ladder runs out,
/// and stops early when the status view asks the user something.
fn ladder(app: &AppHandle, config: &Config, generation: u64) {
    let live = || app.state::<App>().generation.load(SeqCst) == generation;
    for attempt in 0..=LADDER.len() {
        if !live() {
            return;
        }
        view(app, |v| {
            v.status = format!("호스트에 연결 중… ({}번째)", attempt + 1)
        });
        let result = match config.mode.as_str() {
            #[cfg(desktop)]
            "ssh" => ssh_attempt(app, config),
            _ => tailscale_attempt(app, config),
        };
        match result {
            Ok(url) => {
                if live() {
                    log(app, &format!("오피스 열기: {}", connect::redact(&url)));
                    view(app, |v| {
                        *v = View {
                            status: "연결됨".into(),
                            ..View::default()
                        }
                    });
                    if let (Some(window), Ok(url)) = (main_window(app), Url::parse(&url)) {
                        let _ = window.navigate(url);
                    }
                    // An invitation's code is spent by this visit: keep the office address.
                    if let Some(base) = connect::invite_base(&config.url) {
                        keep_office_url(app, base);
                    }
                    #[cfg(desktop)]
                    if config.mode == "ssh" {
                        watch_tunnel(app, generation);
                    }
                }
                return;
            }
            Err(problem) => {
                log(app, &problem);
                let st = app.state::<App>();
                let mut v = st.view.lock().unwrap();
                v.detail = problem;
                if v.ask != Ask::Nothing || v.refused {
                    return; // the answer (or 다시 연결) starts a new connect
                }
            }
        }
        let Some(&wait) = LADDER.get(attempt) else {
            break;
        };
        for _ in 0..wait * 10 {
            if !live() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    if live() {
        stop_tunnel(app);
        log(app, "연결 포기: 재시도를 모두 썼습니다");
        view(app, |v| {
            v.status = "연결하지 못했습니다. 다시 연결을 누르거나 설정을 확인하세요.".into()
        });
    }
}

/// Saves `url` as the office address (after an invitation was used), for the next start.
fn keep_office_url(app: &AppHandle, url: String) {
    let st = app.state::<App>();
    let mut saved = st.config.lock().unwrap();
    if let Some(config) = saved.as_mut() {
        config.url = url;
        if let Err(e) = write_config(app, config) {
            log(app, &format!("주소를 저장하지 못했습니다: {e}"));
        }
    }
}

/// Address mode (Tailscale, the direct connector or the LAN): the office host must take a TCP
/// connection within 3 s. A `*.ts.net` name that does not resolve usually means Tailscale is
/// missing or logged out on this device.
fn tailscale_attempt(app: &AppHandle, config: &Config) -> Result<String, String> {
    let (_, host, port) = connect::origin(&config.url).ok_or("주소가 올바르지 않습니다")?;
    let addrs = (host.as_str(), port).to_socket_addrs();
    view(app, |v| {
        v.tailscale_help = addrs.is_err() && host.ends_with(".ts.net")
    });
    let Ok(mut addrs) = addrs else {
        return Err(format!("{host} 주소를 찾지 못했습니다."));
    };
    if addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(3)).is_ok()) {
        Ok(config.url.clone())
    } else {
        Err(format!(
            "{host}:{port}에 연결할 수 없습니다.\n주소(초대 링크)를 확인하세요. Tailscale 주소라면 이 기기의 Tailscale이 켜져 있어야 해요."
        ))
    }
}

/// One ssh step: device key, host key, then the tunnel when the local port is closed, then a
/// login code. Questions for the user (host key, password) stop the ladder via `ask`.
#[cfg(desktop)]
fn ssh_attempt(app: &AppHandle, config: &Config) -> Result<String, String> {
    let st = app.state::<App>();
    let files = ssh_files(app)?;
    ensure_key(app, &files)?;
    let (host, port) = (connect::host_of(&config.ssh_target), config.ssh_port);
    let known = fs::read_to_string(&files.known_hosts).unwrap_or_default();
    if !connect::host_known(&known, host, port) {
        let (line, fingerprint) = scan_host_key(host, port)?;
        ask(app, Ask::HostKey { line, fingerprint });
        return Err(format!(
            "처음 연결하는 호스트입니다: {}",
            connect::known_name(host, port)
        ));
    }
    if st.register_next.swap(false, SeqCst) {
        ask(app, Ask::Password);
        return Err("이 기기 키를 다시 등록합니다.".into());
    }
    // The tunnel is ours and on a port only we hold, or the login code goes nowhere.
    let (port, pid) = {
        let mut slot = st.tunnel.lock().unwrap();
        match slot.as_mut().map(|t| t.child.try_wait()) {
            None => {
                let port = free_port(config.local_port)?;
                *slot = Some(spawn_tunnel(config, &files, port, false)?);
                return Err("SSH 터널을 여는 중…".into());
            }
            Some(Ok(None)) => {} // still running
            Some(_) => {
                // It exited: show why; the next attempt spawns a new one.
                let last = slot
                    .as_ref()
                    .map(|t| t.last_err.lock().unwrap().clone())
                    .unwrap_or_default();
                *slot = None;
                drop(slot);
                return Err(ssh_failed(app, &last));
            }
        }
        let tunnel = slot.as_mut().unwrap();
        let (port, pid) = (tunnel.port, tunnel.child.id());
        if !listening(port) {
            return Err("SSH 터널을 여는 중…".into());
        }
        match connect::judge(owner::listener_pids(port).as_deref(), pid, tunnel.retried) {
            connect::Verdict::Send => (port, pid),
            connect::Verdict::Retry => {
                log(
                    app,
                    &format!("포트 {port}를 다른 프로그램이 쓰고 있어 새 포트로 다시 엽니다"),
                );
                let _ = tunnel.child.kill();
                let _ = tunnel.child.wait();
                *slot = None;
                let port = free_port(0)?;
                *slot = Some(spawn_tunnel(config, &files, port, true)?);
                return Err(
                    "다른 프로그램이 포트를 쓰고 있어 새 포트로 터널을 다시 여는 중…".into(),
                );
            }
            connect::Verdict::Refuse => {
                let _ = tunnel.child.kill();
                let _ = tunnel.child.wait();
                *slot = None;
                drop(slot);
                view(app, |v| {
                    v.refused = true;
                    v.status = "안전하지 않아 연결을 멈췄습니다.".into()
                });
                return Err(
                    "이 PC의 다른 프로그램이 터널 포트를 쥐고 있거나 포트 주인을 확인할 수 없어, 로그인 코드를 보내지 않았습니다. 설정에서 로컬 포트를 바꾸거나 다른 프로그램을 끈 뒤 다시 연결하세요.".into(),
                );
            }
        }
    };
    let out = run_tool(
        hidden("ssh").args(connect::login_args(
            &config.ssh_target,
            config.ssh_port,
            &config.login_command,
            &files.opts(),
        )),
        b"",
        Duration::from_secs(30),
    )?;
    let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && connect::valid_code(&code) {
        // The code is about to go to 127.0.0.1:port: look once more, closest to the send.
        if owner::listener_pids(port).as_deref().map(<[u32]>::to_vec) != Some(vec![pid]) {
            stop_tunnel(app);
            return Err("터널 포트의 주인이 바뀌어 로그인 코드를 보내지 않았습니다.".into());
        }
        st.registered.store(false, SeqCst);
        return Ok(format!("http://127.0.0.1:{port}/login?code={code}"));
    }
    let last = last_line(&out.stderr);
    Err(ssh_failed(
        app,
        if last.is_empty() {
            "로그인 코드를 받지 못했습니다"
        } else {
            &last
        },
    ))
}

#[cfg(desktop)]
fn spawn_tunnel(
    config: &Config,
    files: &SshFiles,
    port: u16,
    retried: bool,
) -> Result<Tunnel, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    let args = connect::tunnel_args(
        &config.ssh_target,
        config.ssh_port,
        port,
        config.remote_port,
        &files.opts(),
    );
    let mut child = hidden("ssh")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(no_ssh)?;
    let last_err = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sink = last_err.clone();
        // Drain stderr so ssh never stalls on a full pipe.
        thread::spawn(move || {
            for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
                let line = String::from_utf8_lossy(&line).trim().to_string();
                if !line.is_empty() {
                    *sink.lock().unwrap() = line;
                }
            }
        });
    }
    Ok(Tunnel {
        child,
        port,
        retried,
        last_err,
    })
}

/// Something on 127.0.0.1:`port` answers, or the port cannot be bound.
#[cfg(desktop)]
fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)).is_ok()
}

/// A port for the tunnel: `preferred` when it is free (0: never), else one the OS picks.
#[cfg(desktop)]
fn free_port(preferred: u16) -> Result<u16, String> {
    let busy = |port: u16| {
        port == 0 || listening(port) || std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
    };
    let fresh = || {
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
        Some(socket.local_addr().ok()?.port())
    };
    connect::pick_port(preferred, busy, fresh)
        .ok_or_else(|| "빈 로컬 포트를 찾지 못했습니다".into())
}

/// Waits while the office is up; when our tunnel exits, back to the status view and the ladder.
#[cfg(desktop)]
fn watch_tunnel(app: &AppHandle, generation: u64) {
    let st = app.state::<App>();
    while st.generation.load(SeqCst) == generation {
        thread::sleep(Duration::from_secs(1));
        let mut slot = st.tunnel.lock().unwrap();
        let Some(tunnel) = slot.as_mut() else { return }; // a tunnel we didn't start
        if matches!(tunnel.child.try_wait(), Ok(Some(_))) {
            let last = tunnel.last_err.lock().unwrap().clone();
            *slot = None;
            drop(slot);
            if st.generation.load(SeqCst) == generation {
                log(app, &format!("SSH 터널이 끊겼습니다: {last}"));
                connect(app);
            }
            return;
        }
    }
}

fn stop_tunnel(app: &AppHandle) {
    let tunnel = app.state::<App>().tunnel.lock().unwrap().take();
    if let Some(mut tunnel) = tunnel {
        let _ = tunnel.child.kill();
        let _ = tunnel.child.wait();
        log(app, "SSH 터널 닫음");
    }
}

/// Where this device's ssh files live: `app_data_dir()/ssh/`.
#[cfg(desktop)]
struct SshFiles {
    key: PathBuf,
    public: PathBuf,
    known_hosts: PathBuf,
}

#[cfg(desktop)]
impl SshFiles {
    /// `-i`, IdentitiesOnly, UserKnownHostsFile, StrictHostKeyChecking for every ssh call.
    fn opts(&self) -> Vec<String> {
        connect::key_opts(
            &self.key.to_string_lossy(),
            &self.known_hosts.to_string_lossy(),
        )
    }
}

#[cfg(desktop)]
fn ssh_files(app: &AppHandle) -> Result<SshFiles, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("앱 데이터 폴더를 찾지 못했습니다: {e}"))?
        .join("ssh");
    Ok(SshFiles {
        key: dir.join("id_ed25519"),
        public: dir.join("id_ed25519.pub"),
        known_hosts: dir.join("known_hosts"),
    })
}

/// Makes this device's key with Windows OpenSSH's ssh-keygen on the first SSH connect.
#[cfg(desktop)]
fn ensure_key(app: &AppHandle, files: &SshFiles) -> Result<(), String> {
    static MAKING: Mutex<()> = Mutex::new(());
    let _one_at_a_time = MAKING.lock().unwrap_or_else(|e| e.into_inner());
    if files.key.exists() && files.public.exists() {
        return Ok(());
    }
    // Half a pair is no use, and ssh-keygen would stop to ask before overwriting it.
    let _ = fs::remove_file(&files.key);
    let _ = fs::remove_file(&files.public);
    if let Some(dir) = files.key.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("키 폴더를 만들지 못했습니다: {e}"))?;
    }
    let comment = connect::key_comment(&std::env::var("COMPUTERNAME").unwrap_or_default());
    let out = run_tool(
        hidden("ssh-keygen").args(connect::keygen_args(&files.key.to_string_lossy(), &comment)),
        b"",
        Duration::from_secs(30),
    )?;
    if !out.status.success() || !files.public.exists() {
        return Err(format!(
            "이 기기 키를 만들지 못했습니다: {}",
            last_line(&out.stderr)
        ));
    }
    let fingerprint = key_fingerprint(files).unwrap_or_default();
    log(app, &format!("기기 키 만듦: {fingerprint}"));
    Ok(())
}

#[cfg(desktop)]
fn key_fingerprint(files: &SshFiles) -> Option<String> {
    fingerprint(fs::read_to_string(&files.public).ok()?.trim())
}

/// `SHA256:…` of a public key or known_hosts line, from `ssh-keygen -l -f -`.
#[cfg(desktop)]
fn fingerprint(line: &str) -> Option<String> {
    let input = format!("{line}\n");
    let out = run_tool(
        hidden("ssh-keygen").args(["-l", "-f", "-"]),
        input.as_bytes(),
        Duration::from_secs(10),
    )
    .ok()?;
    connect::fingerprint_of(&String::from_utf8_lossy(&out.stdout)).map(String::from)
}

/// The host's ed25519 key as a known_hosts line, with its fingerprint for the user to check.
#[cfg(desktop)]
fn scan_host_key(host: &str, port: u16) -> Result<(String, String), String> {
    let out = run_tool(
        hidden("ssh-keyscan").args(connect::keyscan_args(host, port)),
        b"",
        Duration::from_secs(20),
    )?;
    let Some(line) = connect::scanned_key(&String::from_utf8_lossy(&out.stdout), host, port) else {
        return Err(format!(
            "호스트 키를 받지 못했습니다. 호스트 주소와 SSH 포트를 확인하세요.\n{}",
            last_line(&out.stderr)
        )
        .trim()
        .to_string());
    };
    let fingerprint = fingerprint(&line).ok_or("호스트 키 지문을 만들지 못했습니다")?;
    Ok((line, fingerprint))
}

/// Why a registration failed: the host refused the password (ask again), or anything else.
#[cfg(desktop)]
enum Refused {
    Password,
    Other(String),
}

/// Appends this device's public key to the host's authorized_keys, signing in with the
/// password once. ssh gets the password from this exe run as SSH_ASKPASS, over the
/// one-shot channel in `connect::Askpass`; it is never in argv, the environment or a file.
#[cfg(desktop)]
fn register(app: &AppHandle, config: &Config, password: String) -> Result<(), Refused> {
    let files = ssh_files(app).map_err(Refused::Other)?;
    ensure_key(app, &files).map_err(Refused::Other)?;
    let public = fs::read_to_string(&files.public).unwrap_or_default();
    let public = public.trim();
    if !connect::valid_public_key(public) {
        return Err(Refused::Other(
            "공개 키 파일이 올바르지 않습니다. 설정 → 이 기기 키 → 키 지우기 후 다시 연결하세요."
                .into(),
        ));
    }
    let exe = std::env::current_exe()
        .map_err(|e| Refused::Other(format!("실행 파일 경로를 찾지 못했습니다: {e}")))?;
    let channel = connect::Askpass::serve(password.into_bytes())
        .map_err(|e| Refused::Other(format!("비밀번호 통로를 열지 못했습니다: {e}")))?;
    let out = run_tool(
        hidden("ssh")
            .args(connect::register_args(
                &config.ssh_target,
                config.ssh_port,
                &files.opts(),
            ))
            .env("SSH_ASKPASS", exe)
            // OpenSSH 8.4+ (Windows OpenSSH 8.6+): the askpass program for every prompt.
            .env("SSH_ASKPASS_REQUIRE", "force")
            // Windows OpenSSH 8.1 (inbox before Windows 11 24H2) has no SSH_ASKPASS_REQUIRE;
            // it runs the askpass program only when DISPLAY is set and there is no terminal.
            .env("DISPLAY", ":0")
            .env(connect::ASKPASS_ENV, channel.env()),
        format!("{public}\n").as_bytes(),
        Duration::from_secs(60),
    );
    let handed = channel.close();
    const NOT_ASKED: &str = "ssh가 이 앱에 비밀번호를 묻지 않았습니다. 이 기기의 Windows OpenSSH가 SSH_ASKPASS를 쓰지 않는 것 같습니다. PowerShell에서 ssh -V로 버전을 확인하세요.";
    let out = match out {
        Ok(out) => out,
        Err(e) if !handed => return Err(Refused::Other(format!("{e}. {NOT_ASKED}"))),
        Err(e) => return Err(Refused::Other(e)),
    };
    let line = last_line(&out.stderr);
    if out.status.success() {
        let fingerprint = key_fingerprint(&files).unwrap_or_default();
        log(
            app,
            &format!("기기 키 등록: {fingerprint} ({})", config.ssh_target),
        );
        Ok(())
    } else if out.status.code() != Some(255) {
        // ssh itself fails with 255; anything else is the remote command's own status.
        Err(Refused::Other(format!(
            "호스트에서 키를 더하지 못했습니다: {line}"
        )))
    } else if !connect::wants_password(&line) {
        Err(Refused::Other(ssh_detail(&line)))
    } else if handed {
        Err(Refused::Password)
    } else {
        Err(Refused::Other(NOT_ASKED.into()))
    }
}

/// Runs an OpenSSH tool with no window: `input` on stdin, killed after `limit`.
#[cfg(desktop)]
fn run_tool(
    command: &mut std::process::Command,
    input: &[u8],
    limit: Duration,
) -> Result<std::process::Output, String> {
    use std::io::Read;
    use std::process::Stdio;
    fn drain(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<Vec<u8>> {
        thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| not_started(command, e))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input); // dropped here: EOF
    }
    let (stdout, stderr) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let (stdout, stderr) = (
        stdout.join().unwrap_or_default(),
        stderr.join().unwrap_or_default(),
    );
    let status =
        status.ok_or_else(|| format!("{}초 안에 끝나지 않아 멈췄습니다", limit.as_secs()))?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(desktop)]
fn hidden(program: &str) -> std::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))] // only Windows sets a creation flag
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
    command
}

/// A tool that would not start: the OpenSSH hint for ssh*, the plain error for the rest.
#[cfg(desktop)]
fn not_started(command: &std::process::Command, e: std::io::Error) -> String {
    let program = command.get_program().to_string_lossy().into_owned();
    if program.starts_with("ssh") {
        no_ssh(e)
    } else {
        format!("{program}을(를) 실행하지 못했습니다 ({e})")
    }
}

#[cfg(desktop)]
fn no_ssh(e: std::io::Error) -> String {
    format!("ssh를 실행하지 못했습니다 ({e}).\nWindows 설정 > 선택적 기능에서 OpenSSH 클라이언트를 켜세요.")
}

#[cfg(desktop)]
fn last_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// The status view's question; the ladder stops when it sees one.
#[cfg(desktop)]
fn ask(app: &AppHandle, ask: Ask) {
    let status = match ask {
        Ask::Password => "호스트 비밀번호가 필요합니다",
        Ask::HostKey { .. } => "처음 보는 호스트 키입니다",
        Ask::Install { .. } => "이 컴퓨터에 Agent Tycoon을 설치할까요?",
        Ask::Start => "사무실이 꺼져 있습니다",
        Ask::Nothing => "",
    };
    view(app, |v| {
        v.status = status.into();
        v.ask = ask;
    });
}

/// Detail for a failed ssh. A refused key on a host that takes passwords asks for the
/// password instead of retrying.
#[cfg(desktop)]
fn ssh_failed(app: &AppHandle, line: &str) -> String {
    if !connect::wants_password(line) {
        return ssh_detail(line);
    }
    let again = app.state::<App>().registered.swap(false, SeqCst);
    ask(app, Ask::Password);
    if again {
        "키를 등록했는데도 키 인증이 실패했습니다. 호스트의 홈 폴더 권한(그룹·기타 쓰기 금지)과 sshd의 AuthorizedKeysFile 설정을 확인하세요."
    } else {
        "이 기기 키가 아직 호스트에 등록되지 않았습니다."
    }
    .into()
}

#[cfg(desktop)]
fn ssh_detail(line: &str) -> String {
    format!("{line}\n{}", connect::ssh_hint(line))
        .trim()
        .to_string()
}

/// on_navigation: our pages, the office and localhost stay; everything else goes to
/// `open_in_browser`, which opens web pages in the default browser and drops the rest.
fn route(app: &AppHandle, url: &Url) -> bool {
    let office = app
        .state::<App>()
        .config
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.url.clone());
    if connect::classify(url.as_str(), &office.unwrap_or_default()) == Nav::Stay {
        return true;
    }
    open_in_browser(app, url);
    false
}

/// Every link that leaves the app ends here: web pages open in the default browser and the
/// log keeps their origin only; anything else is dropped, with a log line as well.
fn open_in_browser(app: &AppHandle, url: &Url) {
    let Some(origin) = connect::web_origin(url.as_str()) else {
        return log(app, &format!("링크 막음: {}", url.scheme()));
    };
    log(app, &format!("외부 링크 열기: {origin}"));
    let (app, url) = (app.clone(), url.to_string());
    // A thread of its own, as the opener plugin's own command runs, never inside a
    // WebView2 event handler on the UI thread.
    thread::spawn(move || {
        if let Err(e) = app.opener().open_url(url, None::<&str>) {
            log(
                &app,
                &format!("외부 링크를 열지 못했습니다: {origin} ({e})"),
            );
        }
    });
}

/// The app data dirs come from the bundle identifier `dev.cldgui.pixeloffice` (tauri.conf.json),
/// kept from the Pixel Office days on purpose: they hold the owner's saved config and SSH keys,
/// and a new identifier would orphan them.
fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("config.json"))
}

fn load_config(app: &AppHandle) -> Option<Config> {
    let text = fs::read_to_string(config_path(app)?).ok()?;
    serde_json::from_str(&text)
        .map_err(|e| log(app, &format!("config.json을 읽지 못했습니다: {e}")))
        .ok()
}

fn write_config(app: &AppHandle, config: &Config) -> std::io::Result<()> {
    let path =
        config_path(app).ok_or_else(|| std::io::Error::other("설정 폴더를 찾을 수 없습니다"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_vec_pretty(config)?)
}

/// One line per connection event in app_log_dir()/agent-tycoon.log, kept under 1 MB.
/// URLs go through `connect::redact` or `connect::web_origin`; codes, cookies, tokens,
/// passwords and keys never reach this (keys only by fingerprint).
fn log(app: &AppHandle, message: &str) {
    static LOCK: Mutex<()> = Mutex::new(());
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let path = dir.join("agent-tycoon.log");
    let _guard = LOCK.lock();
    let _ = fs::create_dir_all(&dir);
    if fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX) {
        if let Ok(old) = fs::read_to_string(&path) {
            let _ = fs::write(&path, connect::trim_log(&old, LOG_MAX as usize));
        }
    }
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            file,
            "{} {}",
            connect::utc(secs),
            message.replace('\n', " / ")
        );
    }
}

#[cfg(desktop)]
fn show(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn tray(app: &AppHandle, on_top: bool) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem};
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let top = CheckMenuItem::with_id(app, "top", "항상 위", true, on_top, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &item("open", "열기")?,
            &item("settings", "설정")?,
            &item("reconnect", "다시 연결")?,
            &top,
            &item("quit", "종료")?,
        ],
    )?;
    let mut tray = tauri::tray::TrayIconBuilder::new()
        .tooltip("Agent Tycoon")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "settings" => {
                show(app);
                show_settings(app, "");
            }
            "reconnect" => {
                show(app);
                connect(app);
            }
            "top" => toggle_on_top(app.clone()),
            "quit" => app.exit(0), // RunEvent::Exit then stops the tunnel
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    let _ = app.state::<App>().on_top_item.set(top);
    Ok(())
}

fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let config = load_config(app);
    *app.state::<App>().config.lock().unwrap() = config.clone();

    let nav = app.clone();
    let builder = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
        .on_navigation(move |url| route(&nav, url))
        .on_page_load(|window, page| {
            if matches!(page.event(), PageLoadEvent::Finished) {
                log(
                    window.app_handle(),
                    &format!("페이지 로드: {}", connect::redact(page.url().as_str())),
                );
            }
        });
    #[cfg(desktop)]
    let builder = {
        let app = app.clone();
        builder
            .initialization_script(KEYS_JS)
            .initialization_script(LINKS_JS)
            .on_new_window(move |url, _| {
                // A second window never opens inside the app: the default browser instead.
                open_in_browser(&app, &url);
                tauri::webview::NewWindowResponse::Deny
            })
    };
    let window = builder.build()?;
    let on_top = config.is_some_and(|c| c.always_on_top);
    let _ = window.set_always_on_top(on_top);
    #[cfg(desktop)]
    if let Err(e) = tray(app, on_top) {
        log(app, &format!("트레이 아이콘을 만들지 못했습니다: {e}"));
    }
    log(app, "Agent Tycoon 시작");
    connect(app);
    Ok(())
}

/// This exe as ssh's SSH_ASKPASS (`connect::Askpass`): prints the password from the
/// channel for ssh and exits, with no window and no Tauri.
#[cfg(desktop)]
fn askpass(channel: &str) -> i32 {
    let Ok(secret) = connect::askpass_fetch(channel) else {
        return 1;
    };
    let mut out = std::io::stdout().lock();
    let printed = out
        .write_all(&secret)
        .and_then(|_| out.write_all(b"\n"))
        .and_then(|_| out.flush());
    i32::from(printed.is_err())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    if let Some(channel) = std::env::var_os(connect::ASKPASS_ENV) {
        std::process::exit(askpass(&channel.to_string_lossy()));
    }
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close(); // closing hides to the tray; 종료 there quits
                let _ = window.hide();
            }
        });
    builder
        .plugin(tauri_plugin_opener::init())
        .manage(App::default())
        .invoke_handler(tauri::generate_handler![
            ui_state,
            save_config,
            reconnect,
            open_settings,
            toggle_fullscreen,
            toggle_on_top,
            open_external,
            #[cfg(desktop)]
            ssh_password,
            #[cfg(desktop)]
            accept_host_key,
            #[cfg(desktop)]
            device_key,
            #[cfg(desktop)]
            register_again,
            #[cfg(desktop)]
            forget_key,
            #[cfg(desktop)]
            start_here,
            #[cfg(desktop)]
            local_options,
            #[cfg(desktop)]
            local_choose,
            #[cfg(desktop)]
            choose_local,
            #[cfg(desktop)]
            local_install,
            #[cfg(desktop)]
            local_start
        ])
        .setup(|app| setup(app.handle()))
        .build(tauri::generate_context!())
        .expect("error while building Agent Tycoon")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_tunnel(app);
            }
        });
}
