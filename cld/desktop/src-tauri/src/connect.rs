//! Connection rules with no Tauri in them: ssh arguments, config checks, the retry
//! ladder, URL classes, log helpers, the device key and the askpass channel. std only,
//! so the tests run with plain rustc:
//! `rustc --edition 2021 --test src-tauri/src/connect.rs -o connect-tests && ./connect-tests`

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Seconds to wait after each failed attempt. When it runs out the app stops and
/// offers 다시 연결, so a dead host never means an endless ssh loop.
pub const LADDER: [u64; 9] = [1, 2, 5, 5, 10, 10, 10, 30, 30];

/// Options every ssh call gets: only this device's key, only the app's own known_hosts,
/// and never a host key prompt (the app asks about an unknown key first). ssh's config
/// parser reads the known_hosts value, so it is quoted (spaces in the profile path) and
/// uses `/` (OpenSSH versions disagree on backslash escapes there).
pub fn key_opts(key: &str, known_hosts: &str) -> Vec<String> {
    let known = format!("UserKnownHostsFile=\"{}\"", known_hosts.replace('\\', "/"));
    [
        "-i",
        key,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        &known,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "CheckHostIP=no",
    ]
    .map(String::from)
    .to_vec()
}

/// `-p <port> <keys> -o <option>… -- <rest>`. `--` ends option parsing before the
/// target, and ssh takes everything after the target as the remote command.
fn ssh_args(port: u16, keys: &[String], options: &[&str], rest: &[&str]) -> Vec<String> {
    let mut args = vec!["-p".to_string(), port.to_string()];
    args.extend_from_slice(keys);
    for option in options {
        args.extend(["-o".to_string(), option.to_string()]);
    }
    args.push("--".into());
    args.extend(rest.iter().map(|s| s.to_string()));
    args
}

/// `ssh` arguments for the tunnel.
pub fn tunnel_args(
    target: &str,
    ssh_port: u16,
    local_port: u16,
    remote_port: u16,
    keys: &[String],
) -> Vec<String> {
    // Bound to 127.0.0.1 only: the one address the office URL names and `owner` checks.
    let forward = format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}");
    let mut args = vec!["-N".to_string(), "-L".to_string(), forward];
    let options = [
        "ExitOnForwardFailure=yes",
        "ServerAliveInterval=15",
        "BatchMode=yes",
    ];
    args.extend(ssh_args(ssh_port, keys, &options, &[target]));
    args
}

/// The local port for a new tunnel: `preferred` unless something already answers there,
/// else a port from `fresh` (the OS's pick) that is not busy either. None: no port found.
pub fn pick_port(
    preferred: u16,
    busy: impl Fn(u16) -> bool,
    fresh: impl FnOnce() -> Option<u16>,
) -> Option<u16> {
    if !busy(preferred) {
        return Some(preferred);
    }
    fresh().filter(|&port| !busy(port))
}

/// What to do with a tunnel whose listening port has been looked up.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Only our ssh holds the port: the login code may go to it.
    Send,
    /// Another process holds it: close our ssh and open a new tunnel on a fresh port.
    Retry,
    /// Do not send, ever: still another process after the retry, or the owner is unknown.
    Refuse,
}

/// `owners`: pids holding a listening socket on the port (None: not determinable). `ours`:
/// the pid of the ssh this app spawned. Unknown or empty is a refusal, not a guess; so is
/// any listener that is not ours, even beside ours.
pub fn judge(owners: Option<&[u32]>, ours: u32, retried: bool) -> Verdict {
    match owners {
        None | Some([]) => Verdict::Refuse,
        Some(pids) if pids.iter().all(|&pid| pid == ours) => Verdict::Send,
        Some(_) if retried => Verdict::Refuse,
        Some(_) => Verdict::Retry,
    }
}

/// `ssh` arguments that print a one-time login code.
pub fn login_args(
    target: &str,
    ssh_port: u16,
    login_command: &str,
    keys: &[String],
) -> Vec<String> {
    ssh_args(ssh_port, keys, &["BatchMode=yes"], &[target, login_command])
}

/// `ssh` arguments that register this device's key, with the public key on stdin. No
/// BatchMode: ssh asks the askpass program for the password, once.
pub fn register_args(target: &str, ssh_port: u16, keys: &[String]) -> Vec<String> {
    let options = ["NumberOfPasswordPrompts=1", "ConnectTimeout=15"];
    ssh_args(ssh_port, keys, &options, &[target, APPEND_KEY])
}

/// The remote half of the registration, run by the login shell with the public key on
/// stdin. It appends the key only when that exact line is missing (`grep -qxF`), and ends
/// a file that lacks its final newline first, so a hand-edited last key is never glued to ours.
pub const APPEND_KEY: &str = r#"sh -c 'umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && cd ~/.ssh && k=$(cat) && { grep -qxF "$k" authorized_keys 2>/dev/null || { [ -s authorized_keys ] && [ -n "$(tail -c1 authorized_keys)" ] && echo >> authorized_keys; printf "%s\n" "$k" >> authorized_keys; }; } && chmod 600 authorized_keys'"#;

/// `ssh-keygen` arguments for this device's key: ed25519 without a passphrase.
pub fn keygen_args(path: &str, comment: &str) -> Vec<String> {
    ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", path]
        .map(String::from)
        .to_vec()
}

/// `agent-tycoon@<computer>`, keeping only `[A-Za-z0-9._-]` of the computer name.
pub fn key_comment(computer: &str) -> String {
    let name: String = computer
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c))
        .collect();
    format!(
        "agent-tycoon@{}",
        if name.is_empty() { "pc" } else { &name }
    )
}

/// One line holding an ed25519 public key, as ssh-keygen writes it.
pub fn valid_public_key(line: &str) -> bool {
    line.starts_with("ssh-ed25519 ") && line.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
}

/// `SHA256:…` from `ssh-keygen -l` output (`256 SHA256:… comment (ED25519)`).
pub fn fingerprint_of(listing: &str) -> Option<&str> {
    listing
        .split_whitespace()
        .nth(1)
        .filter(|fp| fp.starts_with("SHA256:"))
}

/// The host part of a valid `user@host` target.
pub fn host_of(target: &str) -> &str {
    target.split_once('@').map_or(target, |(_, host)| host)
}

/// How known_hosts names a host: `[host]:port`, or the bare host on port 22, lower case
/// as ssh looks it up.
pub fn known_name(host: &str, port: u16) -> String {
    let host = host.to_ascii_lowercase();
    if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    }
}

/// Whether the app's known_hosts already holds a key for this host.
pub fn host_known(known_hosts: &str, host: &str, port: u16) -> bool {
    let name = known_name(host, port);
    known_hosts
        .lines()
        .any(|line| line.split_whitespace().next() == Some(name.as_str()))
}

/// `ssh-keyscan` arguments for the host's ed25519 key.
pub fn keyscan_args(host: &str, port: u16) -> Vec<String> {
    ["-T", "10", "-p", &port.to_string(), "-t", "ed25519", host]
        .map(String::from)
        .to_vec()
}

/// The known_hosts line for the ed25519 key in `ssh-keyscan` output, named as ssh looks
/// it up. It is stored only after the user accepts its fingerprint.
pub fn scanned_key(output: &str, host: &str, port: u16) -> Option<String> {
    output.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let (_, kind, blob) = (fields.next()?, fields.next()?, fields.next()?);
        let base64 = |b: u8| b.is_ascii_alphanumeric() || b"+/=".contains(&b);
        (kind == "ssh-ed25519" && blob.bytes().all(base64))
            .then(|| format!("{} {kind} {blob}", known_name(host, port)))
    })
}

/// ssh refused the key and the host takes a password: the app may ask for it once.
pub fn wants_password(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    line.contains("permission denied")
        && (line.contains("password") || line.contains("keyboard-interactive"))
}

/// Environment variable that carries `<port>:<nonce>` to the askpass child. Its presence
/// also turns the exe into the askpass program: ssh passes that program nothing but its
/// prompt as argv[1], so a `--askpass` flag cannot ride along.
pub const ASKPASS_ENV: &str = "AGENT_TYCOON_ASKPASS";

/// One-shot loopback channel for the password. ssh runs this exe as SSH_ASKPASS; that child
/// connects, presents the nonce from its environment and gets the password. The listener
/// takes exactly one connection, right nonce or not, then closes: the password is handed out
/// at most once and never touches argv, the environment or a file. Other users can't read
/// the nonce from our ssh's environment, so they can't ask for the password.
pub struct Askpass {
    env: String,
    stop: Arc<AtomicBool>,
    worker: thread::JoinHandle<bool>,
}

impl Askpass {
    pub fn serve(secret: Vec<u8>) -> io::Result<Askpass> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let nonce = nonce();
        let env = format!("{}:{nonce}", listener.local_addr()?.port());
        let stop = Arc::new(AtomicBool::new(false));
        let quit = stop.clone();
        let worker = thread::spawn(move || {
            while !quit.load(SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => return hand_over(stream, &nonce, &secret),
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20))
                    }
                    Err(_) => return false,
                }
            }
            false
        });
        Ok(Askpass { env, stop, worker })
    }

    /// `<port>:<nonce>`, the value of ASKPASS_ENV for the one ssh that may ask.
    pub fn env(&self) -> &str {
        &self.env
    }

    /// Closes the channel if it is still open; true when the password was handed out.
    pub fn close(self) -> bool {
        self.stop.store(true, SeqCst);
        self.worker.join().unwrap_or(false)
    }
}

fn hand_over(stream: TcpStream, nonce: &str, secret: &[u8]) -> bool {
    let mut line = String::new();
    // Accepted sockets inherit the listener's non-blocking mode on Windows.
    let read = stream
        .set_nonblocking(false)
        .and_then(|_| stream.set_read_timeout(Some(Duration::from_secs(5))))
        .and_then(|_| BufReader::new((&stream).take(128)).read_line(&mut line));
    read.is_ok() && line.trim_end() == nonce && (&stream).write_all(secret).is_ok()
}

/// The askpass side: presents the nonce and reads the password. Nothing back means refused.
pub fn askpass_fetch(env: &str) -> io::Result<Vec<u8>> {
    let bad = || io::Error::new(io::ErrorKind::InvalidInput, "bad askpass channel");
    let (port, nonce) = env.split_once(':').ok_or_else(bad)?;
    let port: u16 = port.parse().map_err(|_| bad())?;
    let addr = ([127, 0, 0, 1], port).into();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.write_all(format!("{nonce}\n").as_bytes())?;
    let mut secret = Vec::new();
    stream.read_to_end(&mut secret)?;
    if secret.is_empty() {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "refused"));
    }
    Ok(secret)
}

/// 128 random bits as hex from std's RandomState, whose SipHash keys come from the OS RNG.
/// Enough for a nonce that lives seconds on loopback; use a CSPRNG crate if it ever guards more.
fn nonce() -> String {
    use std::hash::{BuildHasher, Hasher};
    let half = || {
        std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish()
    };
    format!("{:016x}{:016x}", half(), half())
}

/// `user@host` from `[A-Za-z0-9._-]`; neither part may start with `-`.
pub fn valid_target(target: &str) -> bool {
    let part = |s: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    matches!(target.split_once('@'), Some((user, host)) if part(user) && part(host))
}

/// `https://…`, or `http://localhost` / `http://127.0.0.1` for testing.
pub fn valid_url(url: &str) -> bool {
    url.bytes().all(|b| b.is_ascii_graphic())
        && match origin(url) {
            Some((scheme, host, _)) => {
                scheme == "https" || (scheme == "http" && (loopback(&host) || private_lan(&host)))
            }
            None => false,
        }
}

/// A home-network IPv4 address (10/8, 172.16/12, 192.168/16): a LAN host's plain-http office
/// (T-0024 `lan` connector). Names never qualify: plain http only to an address typed as such.
fn private_lan(host: &str) -> bool {
    let parts: Vec<u8> = host.split('.').filter_map(|p| p.parse().ok()).collect();
    parts.len() == 4
        && host.split('.').count() == 4
        && match parts[..] {
            [10, ..] => true,
            [172, b, ..] => (16..=31).contains(&b),
            [192, 168, ..] => true,
            _ => false,
        }
}

/// An invitation (T-0024): `<office>/login?code=…` from another device's "기기 추가" or the
/// host's `cld-gui-login --qr`. The office address to keep (ending in `/`, the direct
/// connector's secret path included) once the one-time code is spent; None for anything else.
pub fn invite_base(url: &str) -> Option<String> {
    let (path, query) = url.split_once('?')?;
    let base = path.strip_suffix("login")?;
    let has_code = query
        .split('&')
        .any(|pair| pair.strip_prefix("code=").is_some_and(|c| !c.is_empty()));
    (has_code && base.ends_with('/') && valid_url(base)).then(|| base.to_string())
}

/// One line with no control characters.
pub fn valid_login(command: &str) -> bool {
    !command.trim().is_empty() && !command.chars().any(char::is_control)
}

/// What the login command prints: `^[A-Za-z0-9_-]{6,128}$`.
pub fn valid_code(code: &str) -> bool {
    (6..=128).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `(scheme, host, port)` of an absolute URL, lower-cased. None for userinfo, IPv6,
/// odd host characters or a bad port; port 0 means "no default for this scheme".
pub fn origin(url: &str) -> Option<(String, String, u16)> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()?),
        None => (
            authority,
            match scheme.as_str() {
                "https" => 443,
                "http" => 80,
                _ => 0,
            },
        ),
    };
    let host_ok = !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b));
    host_ok.then(|| (scheme, host.to_ascii_lowercase(), port))
}

/// `scheme://host[:port]` of an http(s) URL: all the log keeps of a link opened in the
/// default browser. None for every other URL; the app opens only web pages there.
pub fn web_origin(url: &str) -> Option<String> {
    let (scheme, host, port) = origin(url)?;
    let default = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    Some(if port == default {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{port}")
    })
}

fn loopback(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1"
}

#[derive(Debug, PartialEq)]
pub enum Nav {
    /// Our own pages, the office origin and localhost: load in the window.
    Stay,
    /// Any other web page: hand it to the default browser.
    Browser,
    /// Everything else (about:, data:, file:, javascript:, …): drop it.
    Block,
}

/// Where a main-window navigation may go. `office` is the configured office URL.
pub fn classify(url: &str, office: &str) -> Nav {
    let Some(target) = origin(url) else {
        return Nav::Block;
    };
    let (scheme, host) = (target.0.as_str(), target.1.as_str());
    let web = scheme == "http" || scheme == "https";
    // The bundled ui/: tauri://localhost on macOS/Linux/iOS, http://tauri.localhost on Windows/Android.
    let local_ui = (scheme == "tauri" && host == "localhost") || (web && host == "tauri.localhost");
    if local_ui || (scheme == "http" && loopback(host)) || origin(office) == Some(target.clone()) {
        Nav::Stay
    } else if web {
        Nav::Browser
    } else {
        Nav::Block
    }
}

/// URL without query and fragment: the login code and any token stay out of the log.
pub fn redact(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or_default()
}

/// Korean hint for the last stderr line of a failed ssh. A refused key on a host that
/// takes passwords never gets here: the app asks for the password instead.
pub fn ssh_hint(line: &str) -> &'static str {
    let line = line.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| line.contains(n));
    if has(&["permission denied", "publickey", "too many authentication"]) {
        "키 인증에 실패했고, 이 호스트는 비밀번호 로그인을 받지 않습니다. 이 기기 공개 키(설정 폴더의 ssh\\id_ed25519.pub)를 호스트의 ~/.ssh/authorized_keys에 넣으세요."
    } else if has(&[
        "host key verification failed",
        "remote host identification has changed",
    ]) {
        "호스트 키가 처음 수락한 키와 다릅니다. 호스트를 다시 설치한 게 아니라면 연결하지 마세요. 다시 설치했다면 설정 → 이 기기 키 → 키 지우기 후 다시 연결해 새 지문을 확인하세요."
    } else if has(&[
        "connection refused",
        "timed out",
        "could not resolve",
        "no route",
        "kex_exchange_identification",
        "connection closed",
        "bad port",
    ]) {
        "호스트 주소와 SSH 포트를 확인하세요."
    } else {
        "SSH 설정(대상, 포트, 로그인 명령)을 확인하세요."
    }
}

/// Keeps the newest half of a log that grew past `max` bytes, starting at a line.
pub fn trim_log(log: &str, max: usize) -> &str {
    if log.len() <= max {
        return log;
    }
    let start = log.len() - max / 2;
    match log.as_bytes()[start..].iter().position(|&b| b == b'\n') {
        Some(newline) => &log[start + newline + 1..],
        None => "",
    }
}

/// `YYYY-MM-DD HH:MM:SSZ` for Unix seconds (civil-from-days, H. Hinnant).
pub fn utc(secs: u64) -> String {
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let z = days + 719_468;
    let (era, doe) = (z / 146_097, z % 146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = era * 400 + yoe + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem / 60 % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> Vec<String> {
        key_opts(
            r"C:\Users\A B\AppData\Roaming\dev.cldgui.pixeloffice\ssh\id_ed25519",
            r"C:\Users\A B\AppData\Roaming\dev.cldgui.pixeloffice\ssh\known_hosts",
        )
    }

    #[test]
    fn key_options() {
        assert_eq!(
            keys(),
            [
                "-i",
                r"C:\Users\A B\AppData\Roaming\dev.cldgui.pixeloffice\ssh\id_ed25519",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "UserKnownHostsFile=\"C:/Users/A B/AppData/Roaming/dev.cldgui.pixeloffice/ssh/known_hosts\"",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "CheckHostIP=no",
            ]
        );
    }

    #[test]
    fn tunnel_login_register_args() {
        let k = keys().join(" ");
        assert_eq!(
            tunnel_args("user@host.example", 2233, 18240, 18241, &keys()).join(" "),
            format!(
                "-N -L 127.0.0.1:18240:127.0.0.1:18241 -p 2233 {k} -o ExitOnForwardFailure=yes \
                 -o ServerAliveInterval=15 -o BatchMode=yes -- user@host.example"
            )
        );
        assert_eq!(
            login_args("choi@host", 2233, "~/.local/bin/cld-gui-login", &keys()).join(" "),
            format!("-p 2233 {k} -o BatchMode=yes -- choi@host ~/.local/bin/cld-gui-login")
        );
        let register = register_args("choi@host", 2233, &keys());
        assert_eq!(
            register.join(" "),
            format!(
                "-p 2233 {k} -o NumberOfPasswordPrompts=1 -o ConnectTimeout=15 -- choi@host {APPEND_KEY}"
            )
        );
        // The password goes through askpass: never BatchMode, and nothing secret in argv.
        assert!(!register.iter().any(|a| a.contains("BatchMode")));
        // The remote command is one argument after the target.
        assert_eq!(register.last().map(String::as_str), Some(APPEND_KEY));
    }

    #[test]
    fn keygen_and_comment() {
        assert_eq!(
            keygen_args(r"C:\x y\id_ed25519", "agent-tycoon@LAPTOP-1").join("|"),
            r"-q|-t|ed25519|-N||-C|agent-tycoon@LAPTOP-1|-f|C:\x y\id_ed25519"
        );
        assert_eq!(key_comment("DESKTOP-AB12"), "agent-tycoon@DESKTOP-AB12");
        assert_eq!(key_comment("최 의 PC; rm"), "agent-tycoon@PCrm");
        assert_eq!(key_comment(""), "agent-tycoon@pc");
        assert!(valid_public_key(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB agent-tycoon@PC"
        ));
        for bad in [
            "",
            "ssh-rsa AAAA x",
            "ssh-ed25519 AAAA\nssh-ed25519 BBBB",
            "ssh-ed25519 A\tB",
        ] {
            assert!(!valid_public_key(bad), "{bad:?}");
        }
        assert_eq!(
            fingerprint_of("256 SHA256:n4Tz/abc+def agent-tycoon@PC (ED25519)\n"),
            Some("SHA256:n4Tz/abc+def")
        );
        assert_eq!(fingerprint_of("(stdin) is not a public key file.\n"), None);
    }

    #[test]
    fn host_keys() {
        assert_eq!(host_of("choi@Host.Example"), "Host.Example");
        assert_eq!(known_name("Host.Example", 2233), "[host.example]:2233");
        assert_eq!(known_name("h", 22), "h");
        let scan = "[Host.Example]:2233 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA+b/c=\n";
        let line = scanned_key(scan, "Host.Example", 2233).unwrap();
        assert_eq!(
            line,
            "[host.example]:2233 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA+b/c="
        );
        assert!(host_known(
            &format!("other x y\n{line}\n"),
            "HOST.example",
            2233
        ));
        assert!(!host_known(&line, "host.example", 22));
        assert!(!host_known("", "host.example", 2233));
        assert!(!host_known(
            "# [host.example]:2233 ssh-ed25519 x",
            "host.example",
            2233
        ));
        for bad in [
            "",
            "# h:2233 SSH-2.0-OpenSSH_9.6",
            "h ssh-rsa AAAA",
            "h ssh-ed25519 AA;rm",
        ] {
            assert_eq!(scanned_key(bad, "h", 2233), None, "{bad:?}");
        }
        assert_eq!(
            keyscan_args("h", 2233).join(" "),
            "-T 10 -p 2233 -t ed25519 h"
        );
    }

    #[test]
    fn permission_denied() {
        for yes in [
            "choi@host: Permission denied (publickey,password).",
            "choi@host: Permission denied (publickey,keyboard-interactive).",
            "Permission denied, please try again.\nchoi@host: Permission denied (publickey,password).",
        ] {
            assert!(wants_password(yes), "{yes}");
        }
        for no in [
            "choi@host: Permission denied (publickey).",
            "Host key verification failed.",
            "ssh: connect to host h port 2233: Connection refused",
            "",
        ] {
            assert!(!wants_password(no), "{no}");
        }
    }

    /// Runs APPEND_KEY the way sshd does (`<login shell> -c <command>`), with HOME in a
    /// scratch directory, so the real ~/.ssh is never touched.
    #[cfg(unix)]
    #[test]
    fn append_command() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};
        let home = std::env::temp_dir().join(format!("agent-tycoon-append-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let append = |key: &str| {
            let mut child = Command::new("sh")
                .arg("-c")
                .arg(APPEND_KEY)
                .env("HOME", &home)
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(key.as_bytes())
                .unwrap();
            assert!(child.wait().unwrap().success());
        };
        let file = home.join(".ssh/authorized_keys");
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB agent-tycoon@PC";
        append(&format!("{key}\n"));
        append(&format!("{key}\n")); // already there: not added twice
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{key}\n"));
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&home.join(".ssh")), mode(&file)), (0o700, 0o600));
        // A hand-edited file without its final newline keeps its last key intact.
        std::fs::write(&file, "ssh-rsa OLD me@old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        append(key);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            format!("ssh-rsa OLD me@old\n{key}\n")
        );
        assert_eq!(mode(&file), 0o600);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn askpass_one_shot() {
        let channel = Askpass::serve(b"pa ss".to_vec()).unwrap();
        let env = channel.env().to_string();
        assert_eq!(askpass_fetch(&env).unwrap(), b"pa ss");
        // Handed out once; the listener is gone afterwards.
        assert!(askpass_fetch(&env).is_err());
        assert!(channel.close());
    }

    #[test]
    fn askpass_wrong_nonce_spends_the_shot() {
        let channel = Askpass::serve(b"secret".to_vec()).unwrap();
        let env = channel.env().to_string();
        let (port, _) = env.split_once(':').unwrap();
        assert!(askpass_fetch(&format!("{port}:00000000000000000000000000000000")).is_err());
        assert!(askpass_fetch(&env).is_err());
        assert!(!channel.close());
    }

    #[test]
    fn askpass_closed_unused() {
        let channel = Askpass::serve(b"secret".to_vec()).unwrap();
        let env = channel.env().to_string();
        let (_, nonce) = env.split_once(':').unwrap();
        assert_eq!(nonce.len(), 32);
        assert!(nonce.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(!channel.close());
        assert!(askpass_fetch(&env).is_err());
        assert!(askpass_fetch("not-a-channel").is_err());
        let other = Askpass::serve(Vec::new()).unwrap();
        assert_ne!(other.env().split_once(':').unwrap().1, nonce);
        other.close();
    }

    #[test]
    fn targets() {
        for ok in ["choi@host", "a.b-c_d@x.example", "u@10.0.0.2"] {
            assert!(valid_target(ok), "{ok}");
        }
        let bad = [
            "-oProxyCommand=x",
            "-oProxyCommand=calc@host",
            "choi@-oProxyCommand=x",
            "-oProxyCommand@host",
            "choi@-p22",
            "host",
            "@host",
            "choi@",
            "a@b@c",
            "choi@host;calc",
            "choi@host x",
            "choi@ho$t",
            "",
        ];
        for bad in bad {
            assert!(!valid_target(bad), "{bad}");
        }
    }

    #[test]
    fn urls_logins_ports() {
        for ok in [
            "https://office.tail0000.ts.net",
            "https://h.example:8443/x?y",
            "http://localhost:18240/",
            "http://127.0.0.1:1",
        ] {
            assert!(valid_url(ok), "{ok}");
        }
        for bad in [
            "http://office.tail0000.ts.net",
            "https://user@evil",
            "https://[::1]/",
            "ftp://x",
            "https://",
            "https://a b",
            "https://h:99999",
            "javascript:alert(1)",
            "https://h:",
        ] {
            assert!(!valid_url(bad), "{bad}");
        }
        assert!(valid_login("~/.local/bin/cld-gui-login"));
        assert!(!valid_login("a\nb") && !valid_login("a\u{1b}b") && !valid_login("  "));
        // T-0024: a LAN office over plain http, by its private address only
        for ok in [
            "http://192.168.0.100:18240/",
            "http://10.1.2.3:18240",
            "http://172.20.0.5:1",
        ] {
            assert!(valid_url(ok), "{ok}");
        }
        for bad in [
            "http://172.32.0.1/",
            "http://8.8.8.8/",
            "http://192.168.0/",
            "http://192.168.0.1.evil.com/",
        ] {
            assert!(!valid_url(bad), "{bad}");
        }
    }

    #[test]
    fn invitations() {
        let secret = "AbCdEfGhIjKlMnOpQrStUv";
        assert_eq!(
            invite_base(&format!("https://203.0.113.7/{secret}/login?code=xyz_-123")),
            Some(format!("https://203.0.113.7/{secret}/"))
        );
        assert_eq!(
            invite_base("https://office.tail0000.ts.net/login?code=12345678"),
            Some("https://office.tail0000.ts.net/".to_string())
        );
        assert_eq!(
            invite_base("http://192.168.0.100:18240/login?code=12345678"),
            Some("http://192.168.0.100:18240/".to_string())
        );
        for not in [
            "https://office.tail0000.ts.net/",
            "https://office.tail0000.ts.net/login",
            "https://office.tail0000.ts.net/login?code=",
            "https://office.tail0000.ts.net/xlogin?code=1",
            "http://evil.example/login?code=1",
        ] {
            assert_eq!(invite_base(not), None, "{not}");
        }
    }

    #[test]
    fn codes() {
        assert!(valid_code("Ab3_-x") && valid_code(&"a".repeat(128)));
        for bad in [
            "abc12",
            "",
            "abc def",
            "abc&def=1",
            "abcdef\n",
            "한글코드입니다",
        ] {
            assert!(!valid_code(bad), "{bad}");
        }
        assert!(!valid_code(&"a".repeat(129)));
    }

    #[test]
    fn port_choice() {
        // free: the preferred port stays
        assert_eq!(
            pick_port(18240, |_| false, || panic!("not needed")),
            Some(18240)
        );
        // busy before spawn: a different port is chosen
        assert_eq!(
            pick_port(18240, |p| p == 18240, || Some(40001)),
            Some(40001)
        );
        // the fresh port must not be busy either; no fresh port: nothing
        assert_eq!(pick_port(18240, |_| true, || Some(40001)), None);
        assert_eq!(pick_port(18240, |p| p == 18240, || None), None);
    }

    #[test]
    fn owner_verdicts() {
        let ours = 4242;
        // owner is our child: send
        assert_eq!(judge(Some(&[ours]), ours, false), Verdict::Send);
        assert_eq!(judge(Some(&[ours, ours]), ours, true), Verdict::Send);
        // another pid: no send; retry once, then refuse
        assert_eq!(judge(Some(&[7]), ours, false), Verdict::Retry);
        assert_eq!(judge(Some(&[7]), ours, true), Verdict::Refuse);
        // a foreign listener beside ours is still a foreign listener
        assert_eq!(judge(Some(&[ours, 7]), ours, false), Verdict::Retry);
        assert_eq!(judge(Some(&[ours, 7]), ours, true), Verdict::Refuse);
        // unknown owner (other platform, unreadable /proc, nobody listening): refuse at once
        assert_eq!(judge(None, ours, false), Verdict::Refuse);
        assert_eq!(judge(Some(&[]), ours, false), Verdict::Refuse);
    }

    #[test]
    fn ladder() {
        assert_eq!(LADDER, [1, 2, 5, 5, 10, 10, 10, 30, 30]);
        assert_eq!(LADDER.iter().sum::<u64>(), 103);
    }

    #[test]
    fn navigation_classes() {
        let office = "https://office.tail0000.ts.net";
        for stay in [
            "https://office.tail0000.ts.net/",
            "https://OFFICE.tail0000.ts.net/a?b#c",
            "http://localhost:18240/login?code=x",
            "http://127.0.0.1:5173/",
            "http://tauri.localhost/index.html",
            "tauri://localhost/index.html",
        ] {
            assert_eq!(classify(stay, office), Nav::Stay, "{stay}");
        }
        for out in [
            "https://claude.ai/chat/1",
            "https://claude.ai/code/session_01Q4hidBRaSYMi6pW8uBMvBv",
            "https://tailscale.com/download",
            "https://github.com/pixel-agents-hq/pixel-agents#readme",
            "https://office.tail0000.ts.net.evil.com/",
            "http://localhost.evil.com/",
            "https://office.tail0000.ts.net:8443/",
            "http://office.tail0000.ts.net/",
            "https://localhost/",
        ] {
            assert_eq!(classify(out, office), Nav::Browser, "{out}");
        }
        for block in [
            "about:blank",
            "data:text/html,x",
            "file:///C:/x",
            "javascript:alert(1)",
            "mailto:a@b",
            "ms-msdt://x",
            "https://claude.ai@evil.example/",
        ] {
            assert_eq!(classify(block, office), Nav::Block, "{block}");
        }
    }

    #[test]
    fn external_link_origins() {
        for (url, logged) in [
            (
                "https://claude.ai/code/session_01Q4hidBRaSYMi6pW8uBMvBv?x=SECRET#y",
                "https://claude.ai",
            ),
            ("https://tailscale.com/download", "https://tailscale.com"),
            ("HTTPS://GitHub.com:443/a", "https://github.com"),
            ("http://docs.example:8080/p?q", "http://docs.example:8080"),
            (
                "https://office.tail0000.ts.net/",
                "https://office.tail0000.ts.net",
            ),
        ] {
            assert_eq!(web_origin(url).as_deref(), Some(logged), "{url}");
        }
        for never in [
            "about:blank",
            "mailto:a@b",
            "javascript:alert(1)",
            "file:///C:/x",
            "ms-msdt://x",
            "ftp://x/y",
            "https://claude.ai@evil.example/",
            "https://[::1]/",
            "",
        ] {
            assert_eq!(web_origin(never), None, "{never}");
        }
    }

    #[test]
    fn log_helpers() {
        assert_eq!(
            redact("http://localhost:18240/login?code=SECRET1#x"),
            "http://localhost:18240/login"
        );
        assert_eq!(trim_log("short\n", 100), "short\n");
        let log = "1111\n2222\n3333\n4444\n";
        assert_eq!(trim_log(log, 12), "4444\n");
        assert!(trim_log("한글한글한글\n끝\n", 10).ends_with("끝\n"));
        assert_eq!(utc(0), "1970-01-01 00:00:00Z");
        assert_eq!(utc(1_761_034_503), "2025-10-21 08:15:03Z");
        assert_eq!(utc(951_782_400), "2000-02-29 00:00:00Z");
    }

    #[test]
    fn hints() {
        assert!(ssh_hint("choi@host: Permission denied (publickey).").contains("authorized_keys"));
        assert!(ssh_hint("Host key verification failed.").contains("호스트 키"));
        assert!(ssh_hint("ssh: connect to host h port 22: Connection refused").contains("포트"));
    }
}
