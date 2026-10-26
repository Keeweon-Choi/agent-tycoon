//! "이 컴퓨터에서 시작" (T2+P5, H §4.1-4.2): the pure parts of starting the office on this
//! computer. Which screen comes next, the WSL distro list, the install record and health
//! answers, what to do with what was found, and every argv handed to `wsl.exe`, `tar` or the
//! manager. Std and serde_json only (tests: `rustc --test`, see README "검사").
//!
//! Nothing here builds a shell string from user text: the WSL scripts are constants and every
//! value reaches them as its own argv element (`wsl.exe --exec sh -c <script> sh <args…>`), the
//! way `cld/install/wizard.mjs` runs `wslInstallArgv`.

use serde_json::Value;
use std::path::PathBuf;

/// The page the bundled ui/ shows. First run: welcome (no saved choice); then the saved choice.
pub fn screen(saved: bool, settings: bool, choosing: bool) -> &'static str {
    if settings {
        "settings"
    } else if choosing {
        "where"
    } else if !saved {
        "welcome"
    } else {
        "status"
    }
}

/// `wsl.exe` prints its own text in UTF-16LE (a BOM sometimes); what a Linux program prints
/// through it stays UTF-8.
pub fn decode(bytes: &[u8]) -> String {
    let utf16 = bytes.len() >= 2 && bytes.chunks(2).take(64).any(|c| c.len() == 2 && c[1] == 0);
    let text = if utf16 {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.replace(['\u{feff}', '\0'], "")
}

#[derive(Clone, Debug, PartialEq)]
pub struct Distro {
    pub name: String,
    pub running: bool,
    pub default: bool,
}

/// A WSL distro name as wsl.exe and the manager's logon task accept it.
pub fn valid_distro(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// `wsl.exe -l -v`: header row (localized), then `[*] NAME STATE VERSION` per distro. The state
/// may be localized and hold spaces ("실행 중"), so the name is the first column and the version
/// the last. WSL2 only; Docker Desktop's own distros are not for agents (as wizard.mjs).
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<Distro> {
    decode(bytes)
        .lines()
        .skip(1)
        .filter_map(|line| {
            let line = line.trim();
            let (default, rest) = match line.strip_prefix('*') {
                Some(rest) => (true, rest.trim_start()),
                None => (false, line),
            };
            let cols: Vec<&str> = rest.split_whitespace().collect();
            let (name, version) = (*cols.first()?, *cols.last()?);
            if cols.len() < 3 || version != "2" || !valid_distro(name) {
                return None;
            }
            if name.to_ascii_lowercase().starts_with("docker-desktop") {
                return None;
            }
            let state = cols[1..cols.len() - 1].join(" ");
            Some(Distro {
                name: name.into(),
                running: state.eq_ignore_ascii_case("running") || state == "실행 중",
                default,
            })
        })
        .collect()
}

/// Which choice the "where" screen preselects: an existing Windows install, else the default
/// WSL2 distro (a WSL dev environment is there), else Windows itself.
pub fn recommend(distros: &[Distro], native_installed: bool) -> String {
    if native_installed {
        return "native".into();
    }
    distros
        .iter()
        .find(|d| d.default)
        .or(distros.first())
        .map_or("native".into(), |d| format!("wsl:{}", d.name))
}

/// 이 컴퓨터에서 시작 on Windows decides by itself (owner 10-25): (1) a WSL2 distro that already
/// holds an office, (2) an existing Windows install, (3) a WSL2 distro that looks like a dev
/// setup, (4) Windows itself. The default distro is tried first each time; `office` and `dev`
/// boot a distro to look inside, so they run only as far as needed. `(env, distro)`.
pub fn auto_choice(
    distros: &[Distro],
    native_installed: bool,
    mut office: impl FnMut(&str) -> bool,
    mut dev: impl FnMut(&str) -> bool,
) -> (&'static str, String) {
    let mut order: Vec<&Distro> = distros.iter().filter(|d| d.default).collect();
    order.extend(distros.iter().filter(|d| !d.default));
    if let Some(d) = order.iter().find(|d| office(&d.name)) {
        return ("wsl", d.name.clone());
    }
    if native_installed {
        return ("native", String::new());
    }
    match order.iter().find(|d| dev(&d.name)) {
        Some(d) => ("wsl", d.name.clone()),
        None => ("native", String::new()),
    }
}

/// The one plain line the progress screen shows for the decision (Windows only).
pub fn where_line(os: &str, mode: &str, env: &str, distro: &str) -> String {
    match (os, mode, env) {
        ("windows", "local", "wsl") => format!("WSL {distro} 에서 사무실을 엽니다"),
        ("windows", "local", _) => "Windows 에서 바로 사무실을 엽니다".into(),
        _ => String::new(),
    }
}

/// Inside a distro: `dev` when it looks like a dev setup (git, and a home with more than the
/// skeleton: any visible entry, a git config or an agent's own folder). Reads only.
pub const WSL_DEV: &str = r#"command -v git >/dev/null 2>&1 || exit 0
for f in "$HOME"/* "$HOME/.gitconfig" "$HOME/.claude" "$HOME/.codex"; do
  [ -e "$f" ] && { echo dev; exit 0; }
done
exit 0"#;

/// `/api/health` of a cld-gui daemon: `service`, `version`, `protocol`. Anything else is not ours.
#[derive(Debug, PartialEq)]
pub struct Health {
    pub version: String,
    pub protocol: u64,
}

pub fn parse_health(body: &str) -> Option<Health> {
    let v: Value = serde_json::from_str(body).ok()?;
    if v.get("service")?.as_str()? != "cld-gui" {
        return None;
    }
    Some(Health {
        version: v
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        protocol: v.get("protocol").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// What the manager's install record (`<root>/install.json`) says, as far as the app needs it.
#[derive(Debug, Default, PartialEq)]
pub struct Record {
    pub port: Option<u16>,
    pub current: Option<String>,
    pub start_policy: String,
    pub versions: Vec<String>,
    pub service: Option<String>,
    pub files: usize,
}

pub fn parse_record(text: &str) -> Option<Record> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("schema")?.as_u64()? != 1 {
        return None;
    }
    let port = v
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok());
    Some(Record {
        port: port.filter(|p| *p > 0),
        current: v.get("current").and_then(Value::as_str).map(String::from),
        start_policy: v
            .get("startPolicy")
            .and_then(Value::as_str)
            .filter(|p| ["on-demand", "always", "manual"].contains(p))
            .unwrap_or("on-demand")
            .into(),
        versions: v
            .get("versions")
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default(),
        service: v
            .get("service")
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .map(String::from),
        files: v
            .get("files")
            .and_then(Value::as_object)
            .map_or(0, |m| m.len()),
    })
}

/// `~/.config/cld-gui/config.json`'s port (a source install has only this).
pub fn config_port(text: &str) -> Option<u16> {
    let v: Value = serde_json::from_str(text).ok()?;
    u16::try_from(v.get("port")?.as_u64()?)
        .ok()
        .filter(|p| *p > 0)
}

/// An existing install in the chosen environment.
#[derive(Debug, Default, PartialEq)]
pub struct Found {
    pub record: Option<Record>,
    /// A cld-gui config.json is there (a source install, or the manager's own config).
    pub config_port: Option<u16>,
}

pub const DEFAULT_PORT: u16 = 18240;

impl Found {
    pub fn from_texts(record: &str, config: &str) -> Found {
        let config_port = config_port(config);
        Found {
            record: parse_record(record),
            config_port,
        }
    }
    pub fn port(&self) -> u16 {
        self.record
            .as_ref()
            .and_then(|r| r.port)
            .or(self.config_port)
            .unwrap_or(DEFAULT_PORT)
    }
}

/// Marker between the record and the config in `WSL_FIND`'s output.
pub const FIND_MARK: &str = "--agent-tycoon-config--";

/// The daemon's settings folder, as the daemon picks it (core/src/cld/configPath.cjs): the legacy
/// `~/.config/cld-gui` while it exists, else `~/.config/agent-tycoon` (installs since 10-27).
pub fn settings_dir(home: &std::path::Path) -> std::path::PathBuf {
    let legacy = home.join(".config").join("cld-gui");
    if legacy.exists() {
        legacy
    } else {
        home.join(".config").join("agent-tycoon")
    }
}

/// Prints the distro's install record, the marker, then the daemon's config.json (each may be
/// absent; the settings folder chosen as `settings_dir` does).
pub const WSL_FIND: &str = r#"r=${AGENT_TYCOON_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-tycoon}
cat "$r/install.json" 2>/dev/null
printf '\n%s\n' '--agent-tycoon-config--'
d="$HOME/.config/cld-gui"; [ -d "$d" ] || d="$HOME/.config/agent-tycoon"
cat "$d/config.json" 2>/dev/null
exit 0"#;

pub fn split_find(out: &str) -> Found {
    let (record, config) = out.split_once(FIND_MARK).unwrap_or((out, ""));
    Found::from_texts(record.trim(), config.trim())
}

/// What the app does with what it found.
#[derive(Debug, PartialEq)]
pub enum Plan {
    /// A daemon answers: log in and open the office.
    Open,
    /// Installed but not answering: start it (the start request, never a second daemon).
    Start,
    /// Installed, off, and the start policy is manual: the user presses 시작.
    AskStart,
    /// Nothing answers and nothing the manager installed is here: ask, then install.
    /// `adopt`: an older source install's config is there; the manager takes it over.
    AskInstall { adopt: bool },
}

pub fn plan(found: &Found, healthy: bool) -> Plan {
    match (&found.record, healthy) {
        (_, true) => Plan::Open,
        (Some(r), false) if r.start_policy == "manual" => Plan::AskStart,
        (Some(_), false) => Plan::Start,
        (None, false) => Plan::AskInstall {
            adopt: found.config_port.is_some(),
        },
    }
}

/// The start policy (H §4.3) is asked where the manager applies it: inside WSL and on Linux.
pub fn asks_policy(env: &str, os: &str) -> bool {
    env == "wsl" || os == "linux"
}

pub const POLICIES: [&str; 3] = ["on-demand", "always", "manual"];

/// The daemon bundles the installer carries (H §3.2), per runtime: `daemon/<target>/`.
pub fn bundle_target(env: &str, os: &str, arch: &str) -> Option<&'static str> {
    // ponytail: WSL is taken as x64 (as wizard.mjs takes the Windows side); add linux-arm64 for Windows on Arm.
    Some(match (env, os, arch) {
        ("wsl", "windows", _) => "linux-x64",
        ("native", "windows", "x86_64") => "win-x64",
        ("native", "linux", "x86_64") => "linux-x64",
        ("native", "linux", "aarch64") => "linux-arm64",
        ("native", "macos", "aarch64") => "darwin-arm64",
        ("native", "macos", "x86_64") => "darwin-x64",
        _ => return None,
    })
}

/// The one daemon bundle for `target` among a folder's file names.
pub fn bundle_name(names: &[String], target: &str) -> Option<String> {
    let tail = format!("-{target}.tar.gz");
    let mut found = names
        .iter()
        .filter(|n| n.starts_with("agent-tycoon-daemon-") && n.ends_with(&tail));
    let first = found.next()?;
    found.next().is_none().then(|| first.clone())
}

/// The SHA-256 build.rs pinned for `target` (`AGENT_TYCOON_BUNDLE_PINS`: `target=sha256,…`).
pub fn pinned<'a>(pins: &'a str, target: &str) -> Option<&'a str> {
    pins.split(',')
        .find_map(|pin| pin.strip_prefix(target)?.strip_prefix('='))
        .filter(|sha| sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The manager's install root for this OS, as `cld-gui-maintenance.js` installRoot() has it.
pub fn install_root(os: &str, env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(root) = env("AGENT_TYCOON_ROOT").filter(|r| !r.is_empty()) {
        return Some(root.into());
    }
    let home = || {
        env(if os == "windows" {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .filter(|h| !h.is_empty())
    };
    Some(match os {
        "windows" => PathBuf::from(
            env("LOCALAPPDATA")
                .filter(|l| !l.is_empty())
                .or_else(|| home().map(|h| format!("{h}\\AppData\\Local")))?,
        )
        .join("AgentTycoon"),
        "macos" => PathBuf::from(home()?).join("Library/Application Support/AgentTycoon"),
        _ => env("XDG_DATA_HOME")
            .filter(|x| !x.is_empty())
            .map(PathBuf::from)
            .or_else(|| home().map(|h| PathBuf::from(h).join(".local/share")))?
            .join("agent-tycoon"),
    })
}

/// The manager's `install` from the bundle's own runtime, non-interactive (no terminal):
/// signature with the bundled key, unpack, self-test, service, record, health.
pub fn manager_install_args(
    manager: &str,
    bundle: &str,
    pubkey: &str,
    policy: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        manager.into(),
        "install".into(),
        "--from".into(),
        bundle.into(),
        "--pub".into(),
        pubkey.into(),
        "--installed-by".into(),
        "gui".into(),
    ];
    if let Some(policy) = policy.filter(|p| POLICIES.contains(p)) {
        // --no-linger: the manager would ask on a terminal; the app has none (wizard.mjs --yes takes no too).
        args.extend(["--start-policy".into(), policy.into(), "--no-linger".into()]);
    }
    args
}

/// `tar` arguments that unpack only the runtime and the manager (as install.ps1 and install.sh).
pub fn unpack_args(bundle: &str, into: &str) -> Vec<String> {
    [
        "-xf",
        bundle,
        "-C",
        into,
        "node",
        "cld",
        "core",
        "package.json",
    ]
    .map(String::from)
    .to_vec()
}

/// Inside the distro: $1 bundle and $2 key as Windows paths, the rest for the manager. Unpacks the
/// runtime into a temp dir (removed on exit) and runs the manager's install, as install.sh does.
pub const WSL_INSTALL: &str = r#"set -e
b=$(wslpath -u "$1"); p=$(wslpath -u "$2"); shift 2
t=$(mktemp -d "${TMPDIR:-/tmp}/agent-tycoon-install.XXXXXX")
trap 'rm -rf "$t"' 0
trap 'exit 1' HUP INT TERM PIPE
gzip -dc "$b" | tar -xf - -C "$t" node cld core package.json
"$t/node/bin/node" "$t/cld/install/manager.mjs" install --from "$b" --pub "$p" --installed-by gui "$@""#;

/// A one-time login code from the distro's daemon: the installed version's cld-gui-login, else a
/// source install's (loopback, host token; the 60 s code, bare).
pub const WSL_LOGIN: &str = r#"r=${AGENT_TYCOON_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-tycoon}
for f in "$r/current/cld/bin/cld-gui-login" "$HOME/.local/bin/cld-gui-login"; do
  [ -f "$f" ] && exec bash "$f" --bare
done
echo 'cld-gui-login not found' >&2
exit 127"#;

/// `/api/health` from inside the distro, $1 the port (curl: cld-gui-login needs it too).
pub const WSL_HEALTH: &str = r#"exec curl -fsS --max-time 3 "http://127.0.0.1:$1/api/health""#;

/// `agty start --hold`: starts the daemon only if it does not answer, then keeps the distro up
/// while it answers (the manager's holder, as the logon task runs it).
pub const WSL_HOLD: &str = r#"r=${AGENT_TYCOON_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-tycoon}
exec "$r/bin/agty" start --hold"#;

pub fn wsl_script_argv(distro: &str, script: &str, args: &[&str]) -> Vec<String> {
    let mut argv: Vec<String> = ["-d", distro, "--exec", "sh", "-c", script, "sh"]
        .map(String::from)
        .to_vec();
    argv.extend(args.iter().map(|a| a.to_string()));
    argv
}

pub fn wsl_install_argv(
    distro: &str,
    bundle: &str,
    pubkey: &str,
    policy: Option<&str>,
) -> Vec<String> {
    let mut rest = vec![bundle, pubkey];
    if let Some(policy) = policy.filter(|p| POLICIES.contains(p)) {
        rest.extend(["--start-policy", policy, "--no-linger"]);
    }
    wsl_script_argv(distro, WSL_INSTALL, &rest)
}

/// A Windows path as wslpath reads it: without the `\\?\` verbatim prefix.
pub fn plain_path(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

/// The install steps the main screen shows, and which one a manager line finishes.
pub const STEPS: [&str; 4] = ["설치 파일 확인", "프로그램 설치", "사무실 시작", "로그인"];

/// The manager's fixed bundle-progress line: `… 풀기 1234/5208 (23%)` or `… 확인 …`.
/// Keep this parser strict so unrelated manager output cannot alter the install bar.
#[derive(Clone, Debug, PartialEq)]
pub struct InstallProgress {
    pub phase: &'static str,
    pub percent: u8,
}

pub fn install_progress(line: &str) -> Option<InstallProgress> {
    let line = line.strip_prefix("… ")?;
    let (phase, counts) = line.split_once(' ')?;
    let phase = match phase {
        "풀기" => "풀기",
        "확인" => "확인",
        _ => return None,
    };
    let (done, rest) = counts.split_once('/')?;
    let (total, percent) = rest.split_once(" (")?;
    let done = done.parse::<u64>().ok()?;
    let total = total.parse::<u64>().ok()?;
    let percent = percent.strip_suffix("%)")?.parse::<u8>().ok()?;
    if total == 0
        || done > total
        || percent > 100
        || percent as u64 != done.saturating_mul(100) / total
    {
        return None;
    }
    Some(InstallProgress { phase, percent })
}

pub fn step_after(line: &str) -> Option<usize> {
    if line.contains("signature, SHA-256") {
        Some(1)
    } else if line.contains("self-test") && line.starts_with('✔') {
        Some(2)
    } else if line.contains("is running on port") {
        Some(3)
    } else {
        None
    }
}

/// After a failed install: what the manager left on this computer, from its record.
pub fn leftovers(record: Option<&Record>) -> Vec<String> {
    let Some(r) = record else {
        return vec!["이 컴퓨터에는 설치된 것이 없습니다.".into()];
    };
    let mut lines = Vec::new();
    if !r.versions.is_empty() {
        lines.push(format!("풀어 둔 버전: {}", r.versions.join(", ")));
    }
    if let Some(service) = &r.service {
        lines.push(format!("등록한 자동 시작: {service}"));
    }
    if r.files > 0 {
        lines.push(format!("만든 파일 {}개 (설치 기록에 적혀 있음)", r.files));
    }
    if lines.is_empty() {
        lines.push("설치 기록만 남았습니다.".into());
    }
    lines.push("다시 시도하면 이어서 설치합니다. 지우려면 자세히의 명령을 쓰세요.".into());
    lines
}

/// The host token a local daemon wrote (as install.mjs hostToken): server.json, else the
/// persistent standalone token.
pub fn host_token(server_json: Option<&str>, standalone: Option<&str>) -> Option<String> {
    let from_server = server_json
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| v.get("token")?.as_str().map(String::from))
        .filter(|t| !t.is_empty());
    from_server.or_else(|| {
        standalone
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(String::from)
    })
}

/// A plain HTTP/1.1 request to the daemon on 127.0.0.1 (the only place the app sends the token).
pub fn http_request(
    method: &str,
    path: &str,
    port: u16,
    token: Option<&str>,
    body: &str,
) -> String {
    let auth = token.map_or(String::new(), |t| format!("Authorization: Bearer {t}\r\n"));
    let length = if method == "POST" {
        format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        )
    } else {
        String::new()
    };
    format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}{length}Connection: close\r\n\r\n{body}")
}

/// Status and body of a whole HTTP/1.1 response (chunked or not).
pub fn parse_http(response: &[u8]) -> Option<(u16, String)> {
    let text = String::from_utf8_lossy(response);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = head
        .lines()
        .any(|l| l.to_ascii_lowercase().replace(' ', "") == "transfer-encoding:chunked");
    if !chunked {
        return Some((status, body.into()));
    }
    let (mut out, mut rest) = (String::new(), body);
    loop {
        let (size, after) = rest.split_once("\r\n")?;
        let size = usize::from_str_radix(size.split(';').next()?.trim(), 16).ok()?;
        if size == 0 {
            return Some((status, out));
        }
        out.push_str(after.get(..size)?);
        rest = after.get(size..)?.strip_prefix("\r\n")?;
    }
}

/// `/api/login-code`'s code.
pub fn login_code(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.get("code")?.as_str().map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str) -> Vec<u8> {
        let mut out = vec![0xff, 0xfe];
        for unit in text.encode_utf16() {
            out.extend(unit.to_le_bytes());
        }
        out
    }

    #[test]
    fn screens() {
        assert_eq!(screen(false, false, false), "welcome");
        assert_eq!(screen(true, false, false), "status"); // second start: the saved choice
        assert_eq!(screen(false, true, false), "settings");
        assert_eq!(screen(true, true, true), "settings");
        assert_eq!(screen(false, false, true), "where");
        assert_eq!(screen(true, false, true), "where");
    }

    #[test]
    fn wsl_list_utf16() {
        let out = utf16(
            "  NAME              STATE           VERSION\r\n* Ubuntu-22.04      Running         2\r\n  docker-desktop    Stopped         2\r\n  Legacy            Stopped         1\r\n  Debian            Stopped         2\r\n",
        );
        assert_eq!(
            parse_wsl_list(&out),
            vec![
                Distro {
                    name: "Ubuntu-22.04".into(),
                    running: true,
                    default: true
                },
                Distro {
                    name: "Debian".into(),
                    running: false,
                    default: false
                },
            ]
        );
        // Korean Windows: localized header and state with a space.
        let ko = utf16("  이름      상태      버전\r\n* Ubuntu    실행 중   2\r\n");
        assert_eq!(
            parse_wsl_list(&ko),
            vec![Distro {
                name: "Ubuntu".into(),
                running: true,
                default: true
            }]
        );
        // No WSL: wsl.exe prints a help text (exit code non-zero); nothing parses as a distro.
        assert!(parse_wsl_list(&utf16(
            "Windows Subsystem for Linux has no installed distributions.\r\n"
        ))
        .is_empty());
        assert!(parse_wsl_list(b"").is_empty());
        // UTF-8 (a Linux program's output through wsl.exe) passes as it is.
        assert_eq!(decode("Ubuntu\n".as_bytes()), "Ubuntu\n");
    }

    #[test]
    fn distro_names() {
        assert!(valid_distro("Ubuntu-22.04"));
        assert!(!valid_distro("-u"));
        assert!(!valid_distro("Ubuntu; rm"));
        assert!(!valid_distro(""));
    }

    #[test]
    fn automatic_choice() {
        let d = |name: &str, default| Distro {
            name: name.into(),
            running: false,
            default,
        };
        let distros = [
            d("Debian", false),
            d("Ubuntu-22.04", true),
            d("Alpine", false),
        ];
        let mut asked = Vec::new();
        // (1) an office in a distro wins, default first, and the probing stops there.
        let pick = auto_choice(
            &distros,
            true,
            |n| {
                asked.push(n.to_string());
                n == "Debian"
            },
            |_| true,
        );
        assert_eq!(pick, ("wsl", "Debian".into()));
        assert_eq!(asked, ["Ubuntu-22.04", "Debian"]);
        // (2) no office anywhere: an existing Windows install.
        assert_eq!(
            auto_choice(&distros, true, |_| false, |_| true),
            ("native", String::new())
        );
        // (3) the default distro when it is a dev setup, else the first that is.
        assert_eq!(
            auto_choice(&distros, false, |_| false, |_| true),
            ("wsl", "Ubuntu-22.04".into())
        );
        assert_eq!(
            auto_choice(&distros, false, |_| false, |n| n == "Alpine"),
            ("wsl", "Alpine".into())
        );
        // (4) no dev setup, or no WSL2 distro at all: Windows itself.
        assert_eq!(
            auto_choice(&distros, false, |_| false, |_| false),
            ("native", String::new())
        );
        assert_eq!(
            auto_choice(&[], false, |_| unreachable!(), |_| unreachable!()),
            ("native", String::new())
        );
        assert_eq!(
            where_line("windows", "local", "wsl", "Ubuntu-22.04"),
            "WSL Ubuntu-22.04 에서 사무실을 엽니다"
        );
        assert_eq!(
            where_line("windows", "local", "native", ""),
            "Windows 에서 바로 사무실을 엽니다"
        );
        assert_eq!(where_line("linux", "local", "native", ""), "");
        assert_eq!(where_line("windows", "ssh", "", ""), "");
    }

    #[test]
    fn recommended() {
        let d = |name: &str, default| Distro {
            name: name.into(),
            running: false,
            default,
        };
        assert_eq!(
            recommend(&[d("Debian", false), d("Ubuntu", true)], false),
            "wsl:Ubuntu"
        );
        assert_eq!(recommend(&[d("Debian", false)], false), "wsl:Debian");
        assert_eq!(recommend(&[], false), "native");
        assert_eq!(recommend(&[d("Ubuntu", true)], true), "native");
    }

    #[test]
    fn health() {
        assert_eq!(
            parse_health(
                r#"{"status":"ok","service":"cld-gui","version":"0.1.0-rc.1","protocol":1,"pid":4}"#
            ),
            Some(Health {
                version: "0.1.0-rc.1".into(),
                protocol: 1
            })
        );
        assert_eq!(parse_health(r#"{"status":"ok","service":"other"}"#), None);
        assert_eq!(parse_health("<html>"), None);
        assert_eq!(parse_health(r#"{"status":"ok"}"#), None);
    }

    #[test]
    fn existing_installs() {
        let record = r#"{"schema":1,"port":18241,"current":"0.1.0","startPolicy":"manual","versions":{"0.1.0":{}},"service":{"name":"agent-tycoon"},"files":{"a":"x","b":"y"}}"#;
        let found = split_find(&format!("{record}\n{FIND_MARK}\n{{\"port\":18240}}\n"));
        assert_eq!(found.port(), 18241); // the record's port wins
        let r = found.record.as_ref().unwrap();
        assert_eq!(
            (r.start_policy.as_str(), r.files, r.service.as_deref()),
            ("manual", 2, Some("agent-tycoon"))
        );
        assert_eq!(plan(&found, false), Plan::AskStart);
        assert_eq!(plan(&found, true), Plan::Open);

        let on_demand = split_find(&format!(
            "{}\n{FIND_MARK}\n",
            record.replace("manual", "on-demand")
        ));
        assert_eq!(plan(&on_demand, false), Plan::Start);

        // A source install (get.sh): config only.
        let source = split_find(&format!("\n{FIND_MARK}\n{{\"port\":18250}}"));
        assert_eq!((source.record.is_none(), source.port()), (true, 18250));
        assert_eq!(plan(&source, true), Plan::Open);
        assert_eq!(plan(&source, false), Plan::AskInstall { adopt: true });

        // Nothing: the default port, install.
        let none = split_find(&format!("\n{FIND_MARK}\n"));
        assert_eq!(
            (none.port(), plan(&none, false)),
            (DEFAULT_PORT, Plan::AskInstall { adopt: false })
        );
        // A record this app cannot read is not taken as an install.
        assert_eq!(split_find(r#"{"schema":2}"#).record, None);
        assert_eq!(
            Found::from_texts("not json", "{\"port\":0}"),
            Found::default()
        );
    }

    #[test]
    fn roots() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(
            install_root(
                "windows",
                env(&[("LOCALAPPDATA", r"C:\Users\a b\AppData\Local")])
            ),
            Some(PathBuf::from(r"C:\Users\a b\AppData\Local").join("AgentTycoon"))
        );
        assert_eq!(
            install_root("linux", env(&[("HOME", "/home/a")])),
            Some(PathBuf::from("/home/a/.local/share/agent-tycoon"))
        );
        assert_eq!(
            install_root(
                "linux",
                env(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "/x")])
            ),
            Some(PathBuf::from("/x/agent-tycoon"))
        );
        assert_eq!(
            install_root("macos", env(&[("HOME", "/Users/a")])),
            Some(PathBuf::from(
                "/Users/a/Library/Application Support/AgentTycoon"
            ))
        );
        assert_eq!(
            install_root("linux", env(&[("AGENT_TYCOON_ROOT", "/r"), ("HOME", "/h")])),
            Some(PathBuf::from("/r"))
        );
        assert_eq!(install_root("linux", env(&[])), None);
    }

    #[test]
    fn bundles() {
        assert_eq!(bundle_target("wsl", "windows", "x86_64"), Some("linux-x64"));
        assert_eq!(
            bundle_target("native", "windows", "x86_64"),
            Some("win-x64")
        );
        assert_eq!(
            bundle_target("native", "macos", "aarch64"),
            Some("darwin-arm64")
        );
        assert_eq!(bundle_target("wsl", "linux", "x86_64"), None);
        let names: Vec<String> = [
            "SHA256SUMS",
            "agent-tycoon-daemon-0.1.0-linux-x64.tar.gz",
            "agent-tycoon-daemon-0.1.0-win-x64.tar.gz",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            bundle_name(&names, "linux-x64").as_deref(),
            Some("agent-tycoon-daemon-0.1.0-linux-x64.tar.gz")
        );
        assert_eq!(bundle_name(&names, "darwin-x64"), None);
        let two = [
            names[1].clone(),
            "agent-tycoon-daemon-0.2.0-linux-x64.tar.gz".into(),
        ];
        assert_eq!(bundle_name(&two, "linux-x64"), None); // never a guess between two
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        let pins = format!("win-x64={a},linux-x64={b}");
        assert_eq!(pinned(&pins, "linux-x64"), Some(b.as_str()));
        assert_eq!(pinned(&pins, "win-x64"), Some(a.as_str()));
        assert_eq!(pinned(&pins, "linux-arm64"), None);
        assert_eq!(pinned("", "linux-x64"), None); // built without bundles
        assert_eq!(pinned("linux-x64=zz", "linux-x64"), None);
    }

    #[test]
    fn argv_never_a_shell_string() {
        let evil = r"C:\Users\x\$(rm -rf ~)\a b;'.tar.gz";
        let argv = wsl_install_argv("Ubuntu", evil, r"C:\k.pub", Some("always"));
        assert_eq!(
            &argv[..7],
            &["-d", "Ubuntu", "--exec", "sh", "-c", WSL_INSTALL, "sh"]
        );
        assert_eq!(
            &argv[7..],
            &[evil, r"C:\k.pub", "--start-policy", "always", "--no-linger"]
        );
        assert!(!WSL_INSTALL.contains("Ubuntu") && !WSL_INSTALL.contains("rm -rf ~"));
        // An unknown policy never reaches the manager.
        assert_eq!(wsl_install_argv("U", "b", "p", Some("--evil")).len(), 9);
        assert_eq!(
            manager_install_args(
                "/t/cld/install/manager.mjs",
                "/r/b.tar.gz",
                "/r/k.pub",
                None
            ),
            [
                "/t/cld/install/manager.mjs",
                "install",
                "--from",
                "/r/b.tar.gz",
                "--pub",
                "/r/k.pub",
                "--installed-by",
                "gui"
            ]
        );
        assert_eq!(
            manager_install_args("m", "b", "p", Some("on-demand"))[8..],
            ["--start-policy", "on-demand", "--no-linger"]
        );
        assert_eq!(
            unpack_args("b", "t"),
            ["-xf", "b", "-C", "t", "node", "cld", "core", "package.json"]
        );
        assert_eq!(wsl_script_argv("Ubuntu", WSL_LOGIN, &[]).len(), 7);
        assert_eq!(
            wsl_script_argv("Ubuntu", WSL_HEALTH, &["18240"])[5..],
            [WSL_HEALTH, "sh", "18240"]
        );
        assert_eq!(plain_path(r"\\?\C:\Program Files\x"), r"C:\Program Files\x");
        assert_eq!(plain_path(r"C:\x"), r"C:\x");
    }

    #[test]
    fn policy_question() {
        assert!(asks_policy("wsl", "windows"));
        assert!(asks_policy("native", "linux"));
        assert!(!asks_policy("native", "windows")); // the manager: Linux and WSL only for now
        assert!(!asks_policy("native", "macos"));
    }

    #[test]
    fn settings_dir_keeps_the_legacy_folder() {
        let home = std::env::temp_dir().join(format!("at-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        assert_eq!(settings_dir(&home), home.join(".config").join("agent-tycoon"));
        std::fs::create_dir_all(home.join(".config").join("cld-gui")).unwrap();
        assert_eq!(settings_dir(&home), home.join(".config").join("cld-gui"));
        // a new folder beside it never moves an existing install off its data
        std::fs::create_dir_all(home.join(".config").join("agent-tycoon")).unwrap();
        assert_eq!(settings_dir(&home), home.join(".config").join("cld-gui"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn bundle_install_progress() {
        assert_eq!(step_after("✔ agent-tycoon-daemon-0.1.0-linux-x64.tar.gz: signature, SHA-256 and linux-x64 match"), Some(1));
        assert_eq!(step_after("✔ self-test 0.1.0"), Some(2));
        assert_eq!(
            step_after("✔ Agent Tycoon 0.1.0 is running on port 18240"),
            Some(3)
        );
        assert_eq!(step_after("✖ self-test of 0.1.0 failed:"), None);
        assert_eq!(
            install_progress("… 풀기 1234/5208 (23%)"),
            Some(InstallProgress {
                phase: "풀기",
                percent: 23,
            })
        );
        assert_eq!(
            install_progress("… 확인 5208/5208 (100%)"),
            Some(InstallProgress {
                phase: "확인",
                percent: 100,
            })
        );
        assert_eq!(install_progress("… 풀기 12/20 (99%)"), None);
        assert_eq!(install_progress("풀기 12/20 (60%)"), None);
        assert_eq!(leftovers(None), ["이 컴퓨터에는 설치된 것이 없습니다."]);
        let r = Record {
            versions: vec!["0.1.0".into()],
            files: 3,
            ..Record::default()
        };
        let lines = leftovers(Some(&r));
        assert!(lines[0].contains("0.1.0") && lines[1].contains("3개"));
    }

    #[test]
    fn login_over_loopback() {
        assert_eq!(
            host_token(Some(r#"{"token":"t1","port":1}"#), Some("t2")),
            Some("t1".into())
        );
        assert_eq!(host_token(Some("{}"), Some("t2\n")), Some("t2".into()));
        assert_eq!(host_token(None, None), None);
        let req = http_request("POST", "/api/login-code", 18240, Some("tok"), "{}");
        assert!(req.starts_with("POST /api/login-code HTTP/1.1\r\nHost: 127.0.0.1:18240\r\nAuthorization: Bearer tok\r\n"));
        assert!(req.ends_with("Content-Length: 2\r\nConnection: close\r\n\r\n{}"));
        assert!(!http_request("GET", "/api/health", 1, None, "").contains("Authorization"));
        let plain = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 14\r\n\r\n{\"code\":\"abc\"}";
        assert_eq!(parse_http(plain), Some((200, "{\"code\":\"abc\"}".into())));
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"cod\r\n9\r\ne\":\"xyz\"}\r\n0\r\n\r\n";
        let (status, body) = parse_http(chunked).unwrap();
        assert_eq!((status, login_code(&body)), (200, Some("xyz".into())));
        assert_eq!(
            parse_http(b"HTTP/1.1 401 Unauthorized\r\n\r\nunauthorized").map(|r| r.0),
            Some(401)
        );
        assert_eq!(parse_http(b"garbage"), None);
    }
}
