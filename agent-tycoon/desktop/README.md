# Agent Tycoon (desktop app: Windows, macOS, Linux)

A Tauri v2 app that opens the agent-tycoon office in its own window. Double-click it and the office opens without a browser.
It reaches the host either directly through a Tailscale address, or through an SSH tunnel with a one-time login code.
The Windows executable is cross-compiled from this WSL (Linux) with `cargo-xwin`, so no Windows build PC is needed.
Linux packages (AppImage, deb) build right here in WSL; the macOS dmg can only be built on a Mac. CI builds all three OSes at once (see "Three-OS build" below).
The app targets Windows first (the SSH flow assumes Windows OpenSSH). For the Linux and macOS installers we only verify that they build and bundle.

The app UI is in Korean. Button and message names below are given as English (Korean) on first mention, then in English only; where a message is something you will search for (errors, log lines), the Korean text is kept.

## Build

One-time setup:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust (user-level ~/.cargo)
. ~/.cargo/env
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
sudo apt install -y nsis lld llvm clang pkg-config libayatana-appindicator3-dev
# nsis=makensis, lld=lld-link, llvm=llvm-rc, clang; the last two are the tray libraries tauri-cli looks for even in a Windows build
```

Build:

```bash
. ~/.cargo/env
export CARGO_TARGET_DIR=$HOME/.cache/agent-tycoon/desktop-target   # optional: worktrees and main share one cache
cd agent-tycoon/desktop && npm ci && npm run build:win
```

- The first build compiles about 400 crates, and `cargo-xwin` downloads the MSVC CRT and Windows SDK into `~/.cache/cargo-xwin`.
  At the installer step Tauri downloads the NSIS plugin `nsis_tauri_utils.dll` from GitHub once and keeps it in `~/.cache/tauri` (hash-verified). The first build needs internet.
- To share the CPU with other work, run it as `CARGO_BUILD_JOBS=2 nice -n 10 taskset -c 4,5 npm run build:win`.
- `@tauri-apps/cli` is a devDependency pinned in `package.json`. Do not use `cargo install tauri-cli`.

### Linux installers (AppImage, deb)

The Linux build needs WebKitGTK. One-time setup (separate from the packages for the Windows build):

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev patchelf pkg-config file
# only to run the AppImage: libfuse2
```

```bash
. ~/.cargo/env
export CARGO_TARGET_DIR=$HOME/.cache/agent-tycoon/desktop-target
cd agent-tycoon/desktop && npm ci && CARGO_BUILD_JOBS=2 nice -n 10 taskset -c 4,5 npm run build:linux
```

The outputs are `<target>/release/bundle/appimage/Agent Tycoon_<version>_amd64.AppImage` and `<target>/release/bundle/deb/Agent Tycoon_<version>_amd64.deb`.
The first AppImage build has Tauri download linuxdeploy and the GTK plugin from GitHub into `~/.cache/tauri` (internet required).
The output folder differs from the Windows installer (`--target x86_64-pc-windows-msvc`): Linux uses `release/`, Windows uses `x86_64-pc-windows-msvc/release/`.

### macOS installer (dmg)

On a Mac, run `cd agent-tycoon/desktop && npm ci && npm run build:mac` (needs the Xcode command line tools and Rust). The outputs are `src-tauri/target/release/bundle/dmg/*.dmg` and `macos/Agent Tycoon.app`.
macOS cannot be built on this PC (the Apple SDK is required). The `macos-15` runner in CI builds it.

### Three-OS build (CI)

`.github/workflows/desktop-bundles.yml` runs `tauri build` on Linux (ubuntu-22.04), macOS (macos-15, Apple Silicon) and Windows (windows-2025), each on its own OS,
and uploads the installers as artifacts (`agent-tycoon-linux`, `-macos`, `-windows`). It runs only when started by hand (`workflow_dispatch`) or when a `v*` tag is pushed (macOS and Windows minutes are expensive).
The installers are not signed yet (P9). On install, Windows shows a SmartScreen warning ("More info", then "Run anyway"); macOS says the developer cannot be verified (right-click the app and choose Open, or System Settings, Privacy & Security, Open Anyway); Linux shows no warning (for the AppImage, `chmod +x` and run it).

### Version and name

- The version lives in one place, `version` in `src-tauri/Cargo.toml`. `tauri.conf.json` has no `version`, so Tauri uses the Cargo value. When bumping, change only `Cargo.toml` (cargo keeps `Cargo.lock` in sync; the `version` in `package.json` is not used in the bundle).
- The product name is `productName` = `Agent Tycoon` in `tauri.conf.json`; the executable and crate name is `agent-tycoon` (log file `agent-tycoon.log`; the description of a newly created SSH key is `agent-tycoon@<computer>`).
- The identifier is `dev.agenttycoon.app`. App data folders follow this name. Windows: `%APPDATA%\<identifier>` (settings, this device's SSH key) and `%LOCALAPPDATA%\<identifier>` (logs, and the WebView2 profile `EBWebView` holding the office page's localStorage, IndexedDB device key and cookies). macOS: `~/Library/Application Support/<identifier>`, `~/Library/Logs/<identifier>`, the WKWebView storage `~/Library/WebKit/<identifier>` and `~/Library/HTTPStorages/<identifier>`. Linux: `~/.config/<identifier>` (settings) and `~/.local/share/<identifier>` (key, logs, webview).
- `bundle.publisher` is pinned to `Agent Tycoon`. Tauri's NSIS installer uses the publisher (the second segment of the identifier if unset) to create the install-location key `HKCU\Software\<publisher>\Agent Tycoon`, and on upgrade the "uninstall first" step calls the old uninstaller through that key. If the publisher changes, the key is empty and the old uninstall fails.
- There is no upgrade path from the pre-rename app (clean break): uninstall it first, then install this one. The new installer keeps its install folder (`%LOCALAPPDATA%\Agent Tycoon`) and its uninstall entry under the publisher `Agent Tycoon`; on macOS dragging the `.app` into `/Applications` replaces an app of the same name.

### NSIS 3.08 (Ubuntu 22.04)

Tauri's installer template `!include`s `Win\RestartManager.nsh`, a header that ships with NSIS 3.09 and later. Ubuntu 22.04's `nsis` is 3.08 (check with `makensis -VERSION`), so as is the installer step stops with
`!include: could not find: "Win\RestartManager.nsh"`.

- `npm run build:win` puts `scripts/` first on PATH. The `makensis` wrapper there adds the repository's copy of the header (`nsis/include/Win/RestartManager.nsh`, unchanged from NSIS v3.13, zlib/libpng license) to the include path only when NSIS is older than 3.09, then runs the real `makensis`. On 3.09 or later it adds nothing.
- Calling it directly, as in `npx tauri build`, skips the wrapper. Always build with `npm run build:win`.

### Errors and warnings during the build

- `Can't detect any appindicator library`: `pkg-config` and `libayatana-appindicator3-dev` are missing. tauri-cli looks for this Linux tray library even for a Windows build.
- `LNK4099` (no debug info in the CRT) and `-OUTPUTCHARSET is disabled for non Win32 platforms` are harmless warnings.

## Output locations

Under `CARGO_TARGET_DIR` if you set it, otherwise under `agent-tycoon/desktop/src-tauri/target/` (in `.gitignore`, so never committed).

| File | Path (`<target>` = the folder above) |
| --- | --- |
| Executable | `<target>/x86_64-pc-windows-msvc/release/agent-tycoon.exe` |
| Installer (NSIS) | `<target>/x86_64-pc-windows-msvc/release/bundle/nsis/Agent Tycoon_0.1.0_x64-setup.exe` |
| Installer (Linux) | `<target>/release/bundle/appimage/*.AppImage`, `<target>/release/bundle/deb/*.deb` |

With the `export` above, `<target>` is `~/.cache/agent-tycoon/desktop-target`. You only need to carry one installer (about 100 MB, holding two daemon bundles) to the laptop.

## Tests

```bash
cd agent-tycoon/desktop
sh scripts/makensis.test.sh                       # the wrapper adds the header only below NSIS 3.09 (checked with a fake makensis)
rustc --edition 2021 --test src-tauri/src/connect.rs -o "$CARGO_TARGET_DIR/connect-tests" && "$CARGO_TARGET_DIR/connect-tests"
rustc --edition 2021 --test src-tauri/src/owner.rs -o "$CARGO_TARGET_DIR/owner-tests" && "$CARGO_TARGET_DIR/owner-tests"   # port owner lookup (Linux side)
rustc --edition 2021 --test src-tauri/src/downloads.rs -o "$CARGO_TARGET_DIR/downloads-tests" && "$CARGO_TARGET_DIR/downloads-tests"   # download names (Windows-forbidden characters, device names such as CONIN$ and COM¹, length, non-colliding names, refusing when full)
# local.rs uses serde_json: build the host serde_json once and link it.
(cd src-tauri && cargo build -q -p serde_json --target-dir "$CARGO_TARGET_DIR/host-json")
rustc --edition 2021 --test src-tauri/src/local.rs -L dependency="$CARGO_TARGET_DIR/host-json/debug/deps" \
  --extern serde_json="$(ls "$CARGO_TARGET_DIR"/host-json/debug/deps/libserde_json-*.rlib)" -o "$CARGO_TARGET_DIR/local-tests" && "$CARGO_TARGET_DIR/local-tests"
node scripts/ui-flow.mjs   # the first-run screens, in headless Chromium (--disable-gpu) with a fake __TAURI__; screenshots go to agent-tycoon/artifacts/t2p5/
cd src-tauri && cargo xwin clippy --target x86_64-pc-windows-msvc    # must have 0 warnings
```

`local.rs` (start on this computer) tests choosing the next screen, UTF-16 `wsl -l -v`, reading health, the install record and config, deciding what to do (open, start, ask to install),
the arguments handed to `wsl.exe`, `tar` and the manager (user text is always a single argv entry, never built into a shell string), the install progress steps, and loopback HTTP.

`connect.rs` uses only the standard library, no Tauri. It tests the ssh arguments (`-i`, `IdentitiesOnly`, `UserKnownHostsFile`), config validation, retry intervals, URL classification and external-link origins,
detecting "Permission denied", the key registration command (actually run with `sh` in a temporary HOME), host key lines, the askpass channel (hands over once, then closes) and the log helpers.

## Daemon bundles (inside the installer)

The installer carries the office program (the daemon bundle, H §3.2) so it can install without internet. The Windows installer holds two, `win-x64` and `linux-x64` (for WSL); Linux and macOS hold the one for their own OS.
`src-tauri/build.rs` looks in the `<target>/` folder under `AGENT_TYCOON_BUNDLES` (by default the git-ignored `out/bundles` at the repository root) and copies only four files,
`agent-tycoon-daemon-*-<target>.tar.gz`, `SHA256SUMS`, `SHA256SUMS.sig` and `agent-tycoon-release.pub`, to `src-tauri/daemon/<target>/` (not committed).
The `resources` entry in `tauri.conf.json` puts them in `daemon/` next to the app. If any is missing, a release build names the missing files and stops (a debug build for testing only warns).
The bundle's SHA-256 is checked against `SHA256SUMS` and then baked into the app executable (`AGENT_TYCOON_BUNDLE_PINS`); before installing, the app checks the bundle against that value, and if it differs or is missing it unpacks nothing and stops.
Build a bundle with `node agent-tycoon/release/bundle/build.mjs --out <folder>/<target>`. For now it is signed with a test key (the release key signing is P9).

## Start on this computer

On first run you choose between **Start on this computer** (이 컴퓨터에서 시작) and **Connect to another computer** (다른 컴퓨터에 연결, see the connection setup below). The choice is saved, and from the second run on the app goes straight there. Change it any time with **This computer** (이 컴퓨터) in the settings screen.

- **Windows**: the app picks where to run by itself and says so in one line on the progress screen ("WSL Ubuntu-22.04 에서 사무실을 엽니다" / "Windows 에서 바로 사무실을 엽니다", meaning it opens the office in WSL Ubuntu-22.04 or directly in Windows). The order (`local::auto_choice`) is: (1) a WSL2 distribution that already has the office (install record, a source install's config, a responding daemon); (2) something already installed on Windows; (3) a WSL2 distribution that looks like a dev environment (has git, and the home folder holds more than skeleton files; default distribution first); (4) directly on Windows. Distributions are inspected with `wsl.exe -l -v` and a read-only script (a stopped distribution is started by this), and installing always goes through the **Install** screen. **Details** (자세히) then **Run another way** (다른 방식으로 실행) on the progress screen, and **This computer** then **Next** (다음) in the settings, open the old picker (**Run in WSL distribution <name>** (WSL 배포판 <이름>에서 실행), **Run directly on Windows** (Windows에서 바로 실행), **Connect to another computer**).
- **Finding it**: the app reads the chosen place's install record (`install.json`: for WSL, inside the distribution via `wsl.exe -d <distribution> --exec sh -c …`; on Windows `%LOCALAPPDATA%\AgentTycoon`, on Linux `~/.local/share/agent-tycoon`, on macOS `~/Library/Application Support/AgentTycoon`) and the settings' `config.json`, then checks `http://127.0.0.1:<port>/api/health` on that port (`service`, `version`, `protocol`). A new install uses `~/.config/agent-tycoon/config.json` (Windows `%USERPROFILE%\.config\agent-tycoon\config.json`); installs from before the rename keep using `~/.config/agent-tycoon/config.json` (Windows `%USERPROFILE%\.config\agent-tycoon\config.json`).
  - If it responds, the app uses it. If it is installed but not running, the app starts it (WSL: `agty start --hold` inside the distribution, which survives closing the app so agent work continues; elsewhere: `agty start`). If the start policy is manual, it waits for the **Start** (시작) button.
  - If nothing is there, it asks whether to install. On WSL and Linux it also asks for a start policy (only when needed (default), always, manual). If only a source install exists, the manager takes it over and leaves the data untouched.
- **Install**: the bundle inside the app is handed to the manager as is, with no terminal. On WSL it unpacks the bundle's Node and the manager into a temporary folder inside the distribution and runs `manager.mjs install --from <bundle> --pub <key> --installed-by gui [--start-policy … --no-linger]`; on other OSes the app does the same with the system `tar` (the same handoff as install.ps1 and install.sh). The manager's output lines are under **Details**, and the steps (verify the installer files, install the program, start the office, log in) show on screen. On failure it stops at that step and shows what the install record has (the unpacked version, auto start, number of files created).
- **Entry**: the app checks health again and gets a one-time login code (WSL: `agty-login --bare` inside the distribution; elsewhere: `POST /api/login-code` with the host token, loopback only), then opens `http://127.0.0.1:<port>/login?code=…`. What follows is the office's own first-run and import screens. Tokens and codes are not written to the log.

## Installing on Windows and first run

1. Copy `Agent Tycoon_0.1.0_x64-setup.exe` to the laptop and run it. It installs for the current user only, so no administrator rights are needed.
   If SmartScreen blocks the unsigned app, choose **More info**, then **Run anyway**. If the WebView2 runtime is missing, it is downloaded during the install.
2. Open **Agent Tycoon** from the Start menu. The first screen asks **Start on this computer** or **Connect to another computer** (see above). The steps below are for **Connect to another computer**.
3. Choose a connection method.
   - **Tailscale address (recommended)**: just keep Tailscale on on the laptop. You type the address yourself on first run (there is no default).
     The daemon trusts the Tailscale identity, so there is no login step.
   - **SSH tunnel**: enter `user@host` in `SSH 대상` (SSH target), `SSH 포트` (SSH port, default 2233) and `로컬 포트` (local port, default 18240).
     **Advanced** (고급) holds `원격 포트` (remote port, default 18240) and `로그인 명령` (login command, default `~/.local/bin/agty-login`).
     There is nothing to prepare. On the first connection the app asks for two things (below).
4. Click **Save and connect** (저장하고 연결). After a status screen the office opens.

On the first connection in SSH mode:

1. **Host key check**: the app shows "처음 보는 호스트 키입니다" ("this host key is new") and a fingerprint (`SHA256:…`). Click **Accept** (수락) only if it matches the fingerprint you get on the host from
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
   The accepted key goes into the app's own `known_hosts`. The user's `~/.ssh/known_hosts` is not touched.
2. **One password**: under "호스트 비밀번호(한 번만): 이 기기 키를 등록합니다" ("host password, just once: registers this device's key"), enter the host account's password and click **Register** (등록).
   The app adds this device's own key as one line in the host's `~/.ssh/authorized_keys`, and from then on connects with the key only.
   The password is not stored.

What the app does in SSH mode:

1. If this device has no key, it creates one with Windows OpenSSH's `ssh-keygen -t ed25519 -N "" -C agent-tycoon@<computer name>` (without a console window).
2. If the host is not in the app's own `known_hosts`, it fetches the key with `ssh-keyscan -t ed25519`, shows the fingerprint, and stores that line once you accept.
3. Every ssh call gets `-i <this device's key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<the app's own file> -o StrictHostKeyChecking=yes -o CheckHostIP=no`.
   It uses no other key, no ssh-agent and not the user's `known_hosts`, and it never silently accepts an unknown host key.
4. If the local port is free, it starts `ssh -N -L <local>:127.0.0.1:<remote> -p <SSH port> … -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o BatchMode=yes -- <target>` without a console window.
5. Until the port opens it retries at intervals of 1, 2, 5, 5, 10, 10, 10, 30, 30 seconds (the screen says "호스트에 연결 중… (n번째)", "connecting to the host, attempt n").
   If key authentication fails with `Permission denied` and the host accepts passwords, it stops retrying and asks for the password.
6. Once it has the password, a single `ssh … -- <target> sh -c '…'` sends the public key on stdin and appends it to `authorized_keys`
   (`~/.ssh` 700, the file 600, no duplicate line). The password is passed through `SSH_ASKPASS`:
   ssh runs this app again as the askpass program, and that process connects to a `127.0.0.1` channel the app opened for that one call,
   presents a one-time value (received through an environment variable), receives the password once and hands it to ssh. The channel accepts one connection and closes.
   The password appears nowhere on a command line, in an environment variable or in a file.
7. `ssh -p <SSH port> … -o BatchMode=yes -- <target> <login command>` returns a one-time code valid for 60 seconds, and the app opens `http://localhost:<local>/login?code=…`.
   The login cookie stays only in the WebView2 profile, and the host token is not stored on the laptop.
8. If the tunnel drops, the app goes back to the status screen and retries. Quitting the app closes the tunnel.

The settings screen's **This device's key** (이 기기 키, SSH mode) shows the key fingerprint.

- **Register again** (다시 등록): connects with the saved SSH settings, asking for the password before the key and registering the key again (use it after deleting the host's `authorized_keys`).
- **Delete key** (키 지우기): deletes this device's key and the accepted host keys. On the next SSH connection the app creates a new key and asks for the host key and the password again.
  Remove the old line (`agent-tycoon@<computer name>`) left in the host's `authorized_keys` on the host if you want it gone.

## Uninstalling on Windows

Windows Settings, Apps, Installed apps, **Agent Tycoon**, Uninstall also cleans up the office this app installed on Windows. This applies only when `%LOCALAPPDATA%\AgentTycoon\install.json` says `installedBy: gui`, so CLI and source installs and WSL distributions are left alone.

- With **Delete the application data** off: the Windows daemon program, `agty.cmd` and the logon scheduled task are removed. The office settings and data in `%USERPROFILE%\.config\agent-tycoon` stay.
- With **Delete the application data** on: the above, plus `%USERPROFILE%\.config\agent-tycoon`. It also deletes `%APPDATA%\dev.agenttycoon.app` and `%LOCALAPPDATA%\dev.agenttycoon.app` (connection settings, this device's SSH key, logs, webview data).

## Keys and tray

| Key | Action |
| --- | --- |
| F11 | Full screen |
| Ctrl+Shift+T | Always on top (saved in the settings) |
| Ctrl+, | Settings |
| Ctrl+R, F5 | Reload, keeping your place (inside the terminal these stay the terminal's keys) |
| Mouse side buttons, Alt+Left/Right, the keyboard's Back and Forward keys | Do not navigate to another page. Back only closes panels and attachment views opened by the office |

On macOS use Cmd instead of Ctrl (Cmd+R, Cmd+Shift+T, Cmd+,). The keys and buttons live in one place, `src-tauri/src/keys.js`, and are tested with `node scripts/keys-chromium.mjs`.
On the start screens (first run, settings), right-click has no webview menu as the office does; a menu appears only on input fields and on text you can copy (such as fingerprints).

Clicking the window's X hides it to the tray. Tray menu: **Open · Settings · Reconnect · Always on top · Quit** (열기 · 설정 · 다시 연결 · 항상 위 · 종료). Choose **Quit** to shut down completely.
Launching the app a second time brings the existing window to the front instead of opening a new one.

Links that leave the office (for example claude.ai's **open conversation** (대화 열기), documentation links, new-tab links, `window.open`) open in the default browser, not inside the app.
Links that open a new window and `window.open` are passed to the app directly by the script in the page, same-window links are caught at the navigation step, and other new-window requests are caught by WebView2's new-window event.
Whichever way it arrives, the log keeps only the origin, as in `외부 링크 열기: https://claude.ai` ("opening external link"). Links that are not web addresses (`mailto:`, `file:` and so on) are not opened, and the log gets `링크 막음: <scheme>` ("link blocked").
**Open in new tab** (새 탭에서 열기) on a messenger attachment also goes to the default browser: since that browser has no login cookie, the office makes a one-time `open` address (valid 60 seconds) that works without cookies and hands that over.
Downloads from any page are saved to the user's Downloads folder under a Windows-safe name, and `name (1).ext` if the name already exists (`src/downloads.rs`); when done the office shows 「다운로드 폴더에 저장했어요」 ("saved to the Downloads folder"). The log keeps only `내려받기 시작/끝/실패` (download started/finished/failed), never the file name.
**Save and share** is the app's save-location dialog (WebView2's `showSaveFilePicker`). WebView2 has no usable share sheet.

## File locations

| File | Path |
| --- | --- |
| Settings | `%APPDATA%\dev.agenttycoon.app\config.json` |
| This device's key | `%APPDATA%\dev.agenttycoon.app\ssh\id_ed25519` (public key in `id_ed25519.pub`) |
| App-only known_hosts | `%APPDATA%\dev.agenttycoon.app\ssh\known_hosts` |
| Log | `%LOCALAPPDATA%\dev.agenttycoon.app\logs\agent-tycoon.log` |

The log gets one line per connection event (UTC time) and drops its older half once it passes 1 MB.
Creating, registering or deleting a key, and accepting a host key, are recorded only as the fingerprint (`SHA256:…`).
Passwords, whole keys, login codes, cookies and tokens are never logged.
If you delete the settings file, the next run starts again from the settings screen.

## Troubleshooting

- **"주소를 찾지 못했습니다" ("could not find the address") plus "이 기기에 Tailscale이 설치·로그인돼 있는지 확인하세요" ("check that Tailscale is installed and logged in on this device")**: the laptop has no Tailscale or is not logged in, so `*.ts.net` names do not resolve.
  Install it from the [tailscale.com/download](https://tailscale.com/download) link on the status screen (opens in the default browser) and log in to the same tailnet.
- **"Tailscale이 켜져 있는지 확인하세요" ("check that Tailscale is on")**: the name resolves but the connection fails. The laptop's Tailscale is off or logged in to a different tailnet. First see whether the same address opens in a browser.
- **"비밀번호가 맞지 않습니다" ("wrong password")**: enter the host account's password again. ssh tries only once per entry.
- **"키 인증에 실패했고, 이 호스트는 비밀번호 로그인을 받지 않습니다" ("key authentication failed and this host does not accept password login")** (`Permission denied (publickey)`): put this device's public key
  (`%APPDATA%\dev.agenttycoon.app\ssh\id_ed25519.pub`) into the host's `~/.ssh/authorized_keys` yourself.
- **"키를 등록했는데도 키 인증이 실패했습니다" ("key authentication failed even though the key was registered")**: registration worked but sshd does not accept the key. If the host's home folder is writable by group or others,
  sshd (`StrictModes`) rejects the key (`chmod go-w ~`). Also check whether `AuthorizedKeysFile` was changed.
- **"ssh가 비밀번호를 묻지 않았습니다" ("ssh did not ask for a password")**: this device's Windows OpenSSH did not use `SSH_ASKPASS`. Run `ssh -V` in PowerShell and report the version.
  Until then, use the manual public-key method above.
- **"호스트 키가 처음 수락한 키와 다릅니다" ("the host key differs from the one first accepted")** (`Host key verification failed`): do not connect unless the host was reinstalled.
  If it was, go to Settings, This device's key, **Delete key**, then reconnect, check the new fingerprint and accept it.
- **External links do not open**: if the log has `외부 링크 열기: …` but no browser appears, look at the next line, `외부 링크를 열지 못했습니다: … (오류)` ("could not open the external link").
  If even the `외부 링크 열기` line is missing, the click never reached the app.
- **"호스트 주소와 SSH 포트를 확인하세요" ("check the host address and SSH port")** (`Connection refused`, `timed out`): check the host name and the SSH port (default 2233).
- **"ssh를 실행하지 못했습니다" ("could not run ssh")**: turn on **OpenSSH Client** in Windows Settings, System, Optional features.
- **Login code error**: check that `~/.local/bin/agty-login` exists on the host and that the daemon is running. If it is elsewhere, fix **Advanced, Login command** in the settings.
- **"다른 프로그램이 터널 포트를 쥐고 있어 로그인 코드를 보내지 않았습니다" ("another program holds the tunnel port, so the login code was not sent")**: if the local port is already in use, the app picks a free port for the tunnel, and sends the login code only when the process holding that port is the ssh the app started. If the port's owner is someone else or cannot be determined (after one retry), it stops the connection. Close the other program and click **Reconnect**.
- **Retries used up**: click **Reconnect** (다시 연결) on the status screen or in the tray.
- **Shortcuts do not work**: for an office at `localhost`/`127.0.0.1` (this computer, SSH tunnel), `src-tauri/capabilities/office-keys.json` allows them. For an office connected by address (direct remote, Tailscale, LAN), the app allows the window commands (full screen, always on top, settings, outside links) at runtime only for the single origin in the saved connection settings (scheme, host and port exactly as saved) (`allow_office_keys`). Manager settings are not granted to a remote origin. The tray menu works from any address.
- For anything else, the last lines of the log file usually show the cause.
