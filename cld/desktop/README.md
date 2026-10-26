# Agent Tycoon (데스크톱 앱: Windows · macOS · Linux)

cld-gui 오피스를 전용 창으로 여는 Tauri v2 앱입니다. 더블클릭하면 브라우저 없이 오피스가 열립니다.
호스트에는 Tailscale 주소로 바로 붙거나, SSH 터널을 열고 일회용 로그인 코드로 들어갑니다.
Windows용 실행 파일은 이 WSL(Linux)에서 `cargo-xwin`으로 크로스 컴파일합니다. Windows 빌드 PC는 필요 없습니다.
Linux(AppImage, deb)는 이 WSL에서 바로, macOS(dmg)는 맥에서만 만들 수 있습니다. 세 OS를 한 번에 만드는 곳은 CI입니다(아래 "세 OS 빌드").
앱은 Windows 우선입니다(SSH 흐름이 Windows OpenSSH 기준). Linux·macOS 설치 파일은 "만들어지고 묶인다"까지만 확인합니다.

## 빌드

한 번만 준비합니다.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust (사용자 영역 ~/.cargo)
. ~/.cargo/env
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
sudo apt install -y nsis lld llvm clang pkg-config libayatana-appindicator3-dev
# nsis=makensis, lld=lld-link, llvm=llvm-rc, clang, 나머지 둘=tauri-cli가 Windows 빌드에서도 찾는 트레이 라이브러리
```

빌드합니다.

```bash
. ~/.cargo/env
export CARGO_TARGET_DIR=$HOME/.cache/cld-gui/desktop-target   # 선택: worktree와 main이 캐시 하나를 같이 씀
cd cld/desktop && npm ci && npm run build:win
```

- 처음에는 크레이트 약 400개를 컴파일하고, `cargo-xwin`이 MSVC CRT와 Windows SDK를 `~/.cache/cargo-xwin`에 내려받습니다.
  설치 파일 단계에서는 Tauri가 NSIS 플러그인 `nsis_tauri_utils.dll`을 GitHub에서 한 번 받아 `~/.cache/tauri`에 둡니다 (해시 검증). 첫 빌드에는 인터넷이 필요합니다.
- 다른 작업과 CPU를 나눠 써야 하면 `CARGO_BUILD_JOBS=2 nice -n 10 taskset -c 4,5 npm run build:win`처럼 돌립니다.
- `@tauri-apps/cli`는 `package.json`에 버전을 고정한 devDependency입니다. `cargo install tauri-cli`는 쓰지 않습니다.

### Linux 설치 파일 (AppImage, deb)

Linux 빌드는 WebKitGTK가 필요합니다. 한 번만 준비합니다 (Windows 빌드용 패키지와 따로 필요).

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev patchelf pkg-config file
# AppImage를 실행할 때만: libfuse2
```

```bash
. ~/.cargo/env
export CARGO_TARGET_DIR=$HOME/.cache/cld-gui/desktop-target
cd cld/desktop && npm ci && CARGO_BUILD_JOBS=2 nice -n 10 taskset -c 4,5 npm run build:linux
```

결과는 `<target>/release/bundle/appimage/Agent Tycoon_<버전>_amd64.AppImage`와 `<target>/release/bundle/deb/Agent Tycoon_<버전>_amd64.deb`입니다.
첫 AppImage 빌드는 Tauri가 linuxdeploy와 GTK 플러그인을 GitHub에서 받아 `~/.cache/tauri`에 둡니다(인터넷 필요).
Windows 설치 파일(`--target x86_64-pc-windows-msvc`)과 결과 폴더가 다릅니다: Linux는 `release/`, Windows는 `x86_64-pc-windows-msvc/release/`.

### macOS 설치 파일 (dmg)

맥에서 `cd cld/desktop && npm ci && npm run build:mac` (Xcode 명령줄 도구와 Rust 필요). 결과는 `src-tauri/target/release/bundle/dmg/*.dmg`와 `macos/Agent Tycoon.app`입니다.
macOS는 이 PC에서 만들 수 없습니다(Apple SDK 필요). CI의 `macos-15` 러너가 만듭니다.

### 세 OS 빌드 (CI)

`.github/workflows/desktop-bundles.yml`이 Linux(ubuntu-22.04), macOS(macos-15, Apple Silicon), Windows(windows-2025)에서 각각 그 OS 위에서 `tauri build`를 돌리고
설치 파일을 artifact(`agent-tycoon-linux`, `-macos`, `-windows`)로 올립니다. 손으로 실행(`workflow_dispatch`)하거나 `v*` 태그를 밀 때만 돕니다(macOS·Windows 분 단가가 큽니다).
아직 서명하지 않습니다(P9). 설치할 때 Windows는 SmartScreen "추가 정보 → 실행", macOS는 "확인할 수 없는 개발자"(앱을 우클릭 → 열기, 또는 시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기), Linux는 경고 없음(AppImage는 `chmod +x` 후 실행)입니다.

### 버전과 이름

- 버전은 `src-tauri/Cargo.toml`의 `version` 한 곳입니다. `tauri.conf.json`에는 `version`이 없어 Tauri가 Cargo 값을 씁니다. 올릴 때 `Cargo.toml`만 고치세요(`Cargo.lock`은 cargo가 맞춥니다; `package.json`의 `version`은 번들에 쓰이지 않습니다).
- 제품 이름은 `tauri.conf.json`의 `productName` = `Agent Tycoon`, 실행 파일·크레이트 이름 `agent-tycoon`(로그 파일 `agent-tycoon.log`, 새로 만드는 SSH 키 설명 `agent-tycoon@<컴퓨터>`).
- 식별자는 옛 이름 그대로 `dev.cldgui.pixeloffice`입니다. 앱 데이터 폴더(저장한 설정, 이 기기 SSH 키)가 이 이름을 따르므로 바꾸면 그것들을 잃습니다.
- 옛 **Pixel Office** 설치는 지우지 않고 그대로 옆에 남습니다(다른 제품 이름이라 설치 폴더·시작 메뉴·제거 항목이 따로). 두 앱은 설정과 키를 같이 쓰고, 한 번에 하나만 뜹니다(둘째로 연 앱은 먼저 뜬 앱 창을 앞으로 가져옴). 필요 없으면 Windows 설정 → 앱에서 Pixel Office를 제거하세요. 이미 등록한 기기 키 설명은 옛 `pixel-office@<컴퓨터>`로 남습니다.

### NSIS 3.08 (Ubuntu 22.04)

Tauri의 설치 파일 템플릿은 `Win\RestartManager.nsh`를 `!include`하는데, 이 헤더는 NSIS 3.09부터 들어 있습니다. Ubuntu 22.04의 `nsis`는 3.08이라 (`makensis -VERSION`으로 확인) 그대로는
`!include: could not find: "Win\RestartManager.nsh"`로 설치 파일 단계가 멈춥니다.

- `npm run build:win`은 `scripts/`를 PATH 맨 앞에 둡니다. 거기 있는 `makensis` 래퍼는 NSIS가 3.09 미만일 때만 저장소의 사본(`nsis/include/Win/RestartManager.nsh`, NSIS v3.13 그대로, zlib/libpng 라이선스)을 include 경로에 더하고 진짜 `makensis`를 실행합니다. 3.09 이상이면 아무것도 더하지 않습니다.
- `npx tauri build`처럼 직접 부르면 래퍼가 빠집니다. 항상 `npm run build:win`으로 빌드하세요.

### 빌드 중 오류와 경고

- `Can't detect any appindicator library`: `pkg-config`와 `libayatana-appindicator3-dev`가 없습니다. tauri-cli는 Windows용 빌드에서도 이 Linux 트레이 라이브러리를 찾습니다.
- `LNK4099`(CRT에 디버그 정보가 없음)와 `-OUTPUTCHARSET is disabled for non Win32 platforms`는 무해한 경고입니다.

## 결과물 위치

`CARGO_TARGET_DIR`를 정했으면 그 아래, 안 정했으면 `cld/desktop/src-tauri/target/` 아래에 생깁니다 (`.gitignore`에 들어 있어 커밋되지 않습니다).

| 파일 | 경로 (`<target>` = 위 폴더) |
| --- | --- |
| 실행 파일 | `<target>/x86_64-pc-windows-msvc/release/agent-tycoon.exe` |
| 설치 파일 (NSIS) | `<target>/x86_64-pc-windows-msvc/release/bundle/nsis/Agent Tycoon_0.1.0_x64-setup.exe` |
| 설치 파일 (Linux) | `<target>/release/bundle/appimage/*.AppImage`, `<target>/release/bundle/deb/*.deb` |

위의 `export`를 썼다면 `<target>`은 `~/.cache/cld-gui/desktop-target`입니다. 노트북에는 설치 파일 하나(데몬 묶음 둘을 담아 약 100 MB)만 옮기면 됩니다.

## 검사

```bash
cd cld/desktop
sh scripts/makensis.test.sh                       # 래퍼가 NSIS 3.09 미만에서만 헤더를 더하는지 (가짜 makensis로 확인)
rustc --edition 2021 --test src-tauri/src/connect.rs -o "$CARGO_TARGET_DIR/connect-tests" && "$CARGO_TARGET_DIR/connect-tests"
rustc --edition 2021 --test src-tauri/src/owner.rs -o "$CARGO_TARGET_DIR/owner-tests" && "$CARGO_TARGET_DIR/owner-tests"   # 포트 주인 조회(Linux 쪽)
# local.rs는 serde_json을 씁니다: 호스트용 serde_json을 한 번 빌드해 링크합니다.
(cd src-tauri && cargo build -q -p serde_json --target-dir "$CARGO_TARGET_DIR/host-json")
rustc --edition 2021 --test src-tauri/src/local.rs -L dependency="$CARGO_TARGET_DIR/host-json/debug/deps" \
  --extern serde_json="$(ls "$CARGO_TARGET_DIR"/host-json/debug/deps/libserde_json-*.rlib)" -o "$CARGO_TARGET_DIR/local-tests" && "$CARGO_TARGET_DIR/local-tests"
node scripts/ui-flow.mjs   # 첫 실행 화면들을 headless Chromium(--disable-gpu)과 가짜 __TAURI__로, 스크린샷은 cld/artifacts/t2p5/
cd src-tauri && cargo xwin clippy --target x86_64-pc-windows-msvc    # 경고 0개여야 함
```

`local.rs`(이 컴퓨터에서 시작)는 다음 화면 고르기, UTF-16 `wsl -l -v`, health·설치 기록·config 읽기, 무엇을 할지(열기·시작·설치 묻기),
`wsl.exe`·`tar`·관리자에게 넘기는 인자(사용자 글자는 늘 argv 한 칸, 셸 문자열로 만들지 않음), 설치 진행 단계, loopback HTTP를 시험합니다.

`connect.rs`는 Tauri 없이 표준 라이브러리만 씁니다. ssh 인자(`-i`, `IdentitiesOnly`, `UserKnownHostsFile`), 설정 검사, 재시도 간격, URL 분류와 외부 링크 출처,
"Permission denied" 판별, 키 등록 명령(임시 HOME에서 `sh`로 실제 실행), 호스트 키 줄, askpass 통로(한 번만 주고 닫힘), 로그 도우미를 여기서 시험합니다.

## 데몬 묶음 (설치 파일에 들어감)

설치 파일은 사무실 프로그램(데몬 묶음, H §3.2)을 함께 담아 인터넷 없이 설치합니다. Windows 설치 파일은 `win-x64`와 `linux-x64`(WSL용) 둘, Linux·macOS는 그 OS 것 하나입니다.
`src-tauri/build.rs`가 `AGENT_TYCOON_BUNDLES`(기본은 저장소 맨 위의 git이 무시하는 `out/bundles`) 아래 `<target>/` 폴더에서
`agent-tycoon-daemon-*-<target>.tar.gz`, `SHA256SUMS`, `SHA256SUMS.sig`, `agent-tycoon-release.pub` 네 파일만 `src-tauri/daemon/<target>/`(커밋 안 함)로 복사하고,
`tauri.conf.json`의 `resources`가 그것을 앱 옆 `daemon/`에 넣습니다. 하나라도 없으면 릴리스 빌드는 빠진 파일을 적고 멈춥니다(검사용 디버그 빌드는 경고만).
묶음의 SHA-256은 `SHA256SUMS`와 맞춰 본 뒤 앱 실행 파일에 박아 두고(`AGENT_TYCOON_BUNDLE_PINS`), 앱은 설치 전에 묶음을 그 값과 맞춰 봅니다. 다르거나 없으면 아무것도 풀지 않고 멈춥니다.
묶음은 `node cld/release/bundle/build.mjs --out <폴더>/<target>`로 만들고, 지금은 시험 키로 서명합니다(릴리스 키 서명은 P9).

## 이 컴퓨터에서 시작

처음 실행하면 **이 컴퓨터에서 시작**과 **다른 컴퓨터에 연결**(아래의 연결 설정) 둘 중 하나를 고릅니다. 고른 것은 저장되고, 두 번째부터는 바로 그쪽으로 갑니다. 설정 화면의 **이 컴퓨터**로 언제든 바꿉니다.

- **Windows**: 어디서 돌릴지 앱이 혼자 고르고 진행 화면에 한 줄로 알립니다("WSL Ubuntu-22.04 에서 사무실을 엽니다" / "Windows 에서 바로 사무실을 엽니다"). 순서(`local::auto_choice`): (1) 사무실이 이미 있는 WSL2 배포판(설치 기록, 소스 설치의 config, 응답하는 데몬), (2) Windows에 이미 설치된 것, (3) 개발 환경으로 보이는 WSL2 배포판(git이 있고 홈에 골격 파일 말고도 무언가 있음: 기본 배포판 먼저), (4) Windows에서 바로. 배포판 안은 `wsl.exe -l -v`와 읽기만 하는 스크립트로 보고(꺼진 배포판은 이때 켜짐), 설치는 늘 **설치** 화면을 거칩니다. 진행 화면의 **자세히 → 다른 방식으로 실행**과 설정의 **이 컴퓨터 → 다음**은 예전 고르는 화면(**WSL 배포판 <이름>에서 실행**, **Windows에서 바로 실행**, **다른 컴퓨터에 연결**)을 엽니다.
- **찾기**: 고른 곳의 설치 기록(`install.json`: WSL은 `wsl.exe -d <배포판> --exec sh -c …`로 배포판 안, Windows는 `%LOCALAPPDATA%\AgentTycoon`, Linux `~/.local/share/agent-tycoon`, macOS `~/Library/Application Support/AgentTycoon`)과 설정의 `config.json`을 읽고, 그 포트의 `http://127.0.0.1:<포트>/api/health`(`service`·`version`·`protocol`)를 봅니다. 새 설치는 `~/.config/agent-tycoon/config.json`(Windows `%USERPROFILE%\.config\agent-tycoon\config.json`)이고, 이 이름 변경 전 설치는 계속 `~/.config/cld-gui/config.json`(Windows `%USERPROFILE%\.config\cld-gui\config.json`)을 씁니다.
  - 응답하면 그대로 씁니다. 설치돼 있는데 꺼져 있으면 시작합니다(WSL: 배포판 안 `agty start --hold`, 앱을 닫아도 남아 에이전트 작업이 이어짐; 그 밖: `agty start`). 시작 정책이 수동이면 **시작** 버튼을 기다립니다.
  - 아무것도 없으면 설치할지 묻습니다. WSL과 Linux에서는 시작 정책(필요할 때만(기본)·항상·수동)도 묻습니다. 소스 설치만 있으면 관리자가 데이터를 그대로 둔 채 이어받습니다.
- **설치**: 앱에 든 묶음을 관리자에게 그대로 넘깁니다(터미널 없이). WSL은 배포판 안에서 묶음의 Node와 관리자를 임시 폴더에 풀어 `manager.mjs install --from <묶음> --pub <키> --installed-by gui [--start-policy … --no-linger]`, 다른 OS는 시스템 `tar`로 같은 일을 앱이 합니다(install.ps1·install.sh와 같은 넘김). 관리자의 줄은 **자세히**에, 단계(설치 파일 확인 → 프로그램 설치 → 사무실 시작 → 로그인)는 화면에 보입니다. 실패하면 그 단계에서 멈추고 설치 기록에 남은 것(풀어 둔 버전, 자동 시작, 만든 파일 수)을 보입니다.
- **입장**: health를 다시 확인하고 일회용 로그인 코드를 받아(WSL: 배포판 안의 `cld-gui-login --bare`; 그 밖: 호스트 토큰으로 `POST /api/login-code`, loopback만) `http://127.0.0.1:<포트>/login?code=…`를 엽니다. 그다음은 오피스 자신의 첫 실행·가져오기 화면입니다. 토큰과 코드는 로그에 남지 않습니다.

## Windows에 설치하고 처음 실행하기

1. `Agent Tycoon_0.1.0_x64-setup.exe`를 노트북으로 옮겨 실행합니다. 사용자 계정에만 설치되므로 관리자 권한이 필요 없습니다.
   서명하지 않은 앱이라 SmartScreen이 막으면 **추가 정보 → 실행**을 누릅니다. WebView2 런타임이 없으면 설치 중에 받습니다.
2. 시작 메뉴에서 **Agent Tycoon**을 엽니다. 처음에는 **이 컴퓨터에서 시작**과 **다른 컴퓨터에 연결**을 묻습니다(위). 아래는 **다른 컴퓨터에 연결**입니다.
3. 연결 방법을 고릅니다.
   - **Tailscale 주소 (권장)**: 노트북에서 Tailscale을 켜 두면 됩니다. 주소는 처음 실행할 때 직접 입력합니다(기본값 없음).
     데몬이 Tailscale 신원을 믿으므로 로그인 단계가 없습니다.
   - **SSH 터널**: `SSH 대상`에 `user@host`, `SSH 포트`(기본 2233), `로컬 포트`(기본 18240)를 넣습니다.
     **고급**에는 `원격 포트`(기본 18240)와 `로그인 명령`(기본 `~/.local/bin/cld-gui-login`)이 있습니다.
     미리 할 일은 없습니다. 처음 연결할 때 앱이 두 가지를 묻습니다(아래).
4. **저장하고 연결**을 누르면 상태 화면을 거쳐 오피스가 열립니다.

SSH 모드로 처음 연결할 때:

1. **호스트 키 확인**: "처음 보는 호스트 키입니다"와 지문(`SHA256:…`)이 나옵니다. 호스트에서
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`로 본 지문과 같을 때만 **수락**을 누릅니다.
   수락한 키는 앱 전용 `known_hosts`에 들어갑니다. 사용자의 `~/.ssh/known_hosts`는 건드리지 않습니다.
2. **비밀번호 한 번**: "호스트 비밀번호(한 번만): 이 기기 키를 등록합니다"에 호스트 계정 비밀번호를 넣고 **등록**을 누릅니다.
   앱이 이 기기 전용 키를 호스트의 `~/.ssh/authorized_keys`에 한 줄 더하고, 그다음부터는 키로만 접속합니다.
   비밀번호는 저장하지 않습니다.

SSH 모드에서 앱이 하는 일:

1. 이 기기 키가 없으면 Windows OpenSSH의 `ssh-keygen -t ed25519 -N "" -C agent-tycoon@<컴퓨터 이름>`으로 만듭니다 (콘솔 창 없이).
2. 앱 전용 `known_hosts`에 호스트가 없으면 `ssh-keyscan -t ed25519`로 키를 받아 지문을 보여 주고, 수락하면 그 줄을 저장합니다.
3. 모든 ssh 호출에 `-i <이 기기 키> -o IdentitiesOnly=yes -o UserKnownHostsFile=<앱 전용 파일> -o StrictHostKeyChecking=yes -o CheckHostIP=no`를 붙입니다.
   다른 키, ssh-agent, 사용자 `known_hosts`는 쓰지 않고, 모르는 호스트 키를 묻지 않고 받아들이는 일도 없습니다.
4. 로컬 포트가 비어 있으면 `ssh -N -L <로컬>:127.0.0.1:<원격> -p <SSH 포트> … -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o BatchMode=yes -- <대상>`을 콘솔 창 없이 띄웁니다.
5. 포트가 열릴 때까지 1, 2, 5, 5, 10, 10, 10, 30, 30초 간격으로 다시 시도합니다 ("호스트에 연결 중… (n번째)").
   키 인증이 `Permission denied`로 막히고 호스트가 비밀번호를 받으면, 재시도를 멈추고 비밀번호를 묻습니다.
6. 비밀번호를 받으면 `ssh … -- <대상> sh -c '…'` 한 번으로 공개 키를 stdin으로 보내 `authorized_keys`에 더합니다
   (`~/.ssh` 700, 파일 600, 이미 같은 줄이 있으면 더하지 않음). 비밀번호는 `SSH_ASKPASS`로 전합니다:
   ssh가 이 앱을 askpass 프로그램으로 다시 실행하면, 그 프로세스가 앱이 그 호출 하나를 위해 연 `127.0.0.1` 통로에서
   일회용 값(환경 변수로 받음)을 대고 비밀번호를 한 번 받아 ssh에 넘깁니다. 통로는 연결 하나만 받고 닫힙니다.
   비밀번호는 명령줄, 환경 변수, 파일 어디에도 들어가지 않습니다.
7. `ssh -p <SSH 포트> … -o BatchMode=yes -- <대상> <로그인 명령>`으로 60초짜리 일회용 코드를 받아 `http://localhost:<로컬>/login?code=…`를 엽니다.
   로그인 쿠키는 WebView2 프로필에만 남고, 호스트 토큰은 노트북에 저장하지 않습니다.
8. 터널이 끊기면 상태 화면으로 돌아가 다시 시도합니다. 앱을 종료하면 터널도 닫습니다.

설정 화면의 **이 기기 키**(SSH 모드)에는 키 지문이 나옵니다.

- **다시 등록**: 저장된 SSH 설정으로 연결하면서 키보다 먼저 비밀번호를 묻고 키를 다시 등록합니다 (호스트의 `authorized_keys`를 지웠을 때).
- **키 지우기**: 이 기기 키와 수락한 호스트 키를 지웁니다. 다음 SSH 연결 때 새 키를 만들고 호스트 키와 비밀번호를 다시 묻습니다.
  호스트의 `authorized_keys`에 남은 옛 줄(`agent-tycoon@<컴퓨터 이름>`)은 필요하면 호스트에서 지웁니다.

## Windows 앱 제거

Windows 설정 → 앱 → 설치된 앱 → **Agent Tycoon** → 제거는 이 앱이 Windows에서 설치한 사무실도 함께 정리합니다. `%LOCALAPPDATA%\AgentTycoon\install.json`이 `installedBy: gui`인 경우에만 해당하므로, CLI·소스 설치와 WSL 배포판은 건드리지 않습니다.

- **Delete the application data**를 끄면: Windows용 데몬 프로그램, `agty.cmd`/`cld-gui.cmd`, 로그온 예약 작업은 지웁니다. 새 설치의 `%USERPROFILE%\.config\agent-tycoon`과 이전 설치의 `%USERPROFILE%\.config\cld-gui` 사무실 설정·데이터는 남습니다.
- **Delete the application data**를 켜면: 위 항목과 `%USERPROFILE%\.config\cld-gui`도 지웁니다. 또한 이 앱은 Pixel Office와 공유하는 `%APPDATA%\dev.cldgui.pixeloffice`의 연결 설정·이 기기 SSH 키도 지우므로, Pixel Office까지 정리할 때만 선택하세요.

## 키와 트레이

| 키 | 동작 |
| --- | --- |
| F11 | 전체 화면 |
| Ctrl+Shift+T | 항상 위 (설정에 저장) |
| Ctrl+, | 설정 |
| Ctrl+R, F5 | 새로고침, 보던 위치 그대로 (터미널 안에서는 터미널의 키로 남겨 둠) |
| 마우스 옆 버튼, Alt+←/→, 키보드의 뒤로·앞으로 키 | 다른 화면으로 가지 않음. 뒤로는 사무실이 띄운 판·첨부 보기만 닫음 |

macOS에서는 Ctrl 대신 Cmd입니다(Cmd+R, Cmd+Shift+T, Cmd+,). 키와 버튼은 `src-tauri/src/keys.js` 한 곳에 있고 `node scripts/keys-chromium.mjs`로 시험합니다.
시작 화면(첫 실행·설정)의 우클릭은 사무실처럼 웹뷰 메뉴가 없고, 입력칸과 복사할 글(지문 등)에서만 메뉴가 뜹니다.

창의 X를 누르면 트레이로 숨습니다. 트레이 메뉴: **열기 · 설정 · 다시 연결 · 항상 위 · 종료**. 완전히 끄려면 **종료**를 누릅니다.
앱을 한 번 더 실행하면 새 창 대신 기존 창이 앞으로 나옵니다.

오피스 밖 링크(예: claude.ai **대화 열기**, 문서 링크, 새 탭 링크, `window.open`)는 앱 안이 아니라 기본 브라우저에서 열립니다.
새 창으로 여는 링크와 `window.open`은 페이지 안의 스크립트가 바로 앱에 넘기고, 같은 창 링크는 탐색 단계에서, 나머지 새 창 요청은 WebView2의 새 창 이벤트에서 받습니다.
어느 길로 오든 로그에 `외부 링크 열기: https://claude.ai`처럼 출처만 남습니다. 웹 주소가 아닌 링크(`mailto:`, `file:` 등)는 열지 않고 `링크 막음: <스킴>`을 남깁니다.

## 파일 위치

| 파일 | 경로 |
| --- | --- |
| 설정 | `%APPDATA%\dev.cldgui.pixeloffice\config.json` |
| 이 기기 키 | `%APPDATA%\dev.cldgui.pixeloffice\ssh\id_ed25519` (공개 키는 `id_ed25519.pub`) |
| 앱 전용 known_hosts | `%APPDATA%\dev.cldgui.pixeloffice\ssh\known_hosts` |
| 로그 | `%LOCALAPPDATA%\dev.cldgui.pixeloffice\logs\agent-tycoon.log` |

로그에는 연결 이벤트가 한 줄씩(UTC 시각) 쌓이고 1 MB를 넘으면 오래된 절반을 지웁니다.
키를 만들거나 등록하거나 지운 일, 수락한 호스트 키는 지문(`SHA256:…`)으로만 남습니다.
비밀번호, 키 전체, 로그인 코드, 쿠키, 토큰은 남기지 않습니다.
설정 파일을 지우면 다음 실행 때 설정 화면부터 다시 시작합니다.

## 문제 해결

- **"주소를 찾지 못했습니다" + "이 기기에 Tailscale이 설치·로그인돼 있는지 확인하세요"**: 노트북에 Tailscale이 없거나 로그인하지 않아 `*.ts.net` 이름이 풀리지 않습니다.
  상태 화면의 [tailscale.com/download](https://tailscale.com/download) 링크(기본 브라우저로 열림)에서 설치하고 같은 tailnet에 로그인합니다.
- **"Tailscale이 켜져 있는지 확인하세요"**: 이름은 풀리지만 연결이 안 됩니다. 노트북의 Tailscale이 꺼져 있거나 다른 tailnet에 로그인돼 있습니다. 브라우저로 같은 주소가 열리는지 먼저 보세요.
- **"비밀번호가 맞지 않습니다"**: 호스트 계정 비밀번호를 다시 넣습니다. 한 번 넣을 때마다 ssh는 한 번만 시도합니다.
- **"키 인증에 실패했고, 이 호스트는 비밀번호 로그인을 받지 않습니다"** (`Permission denied (publickey)`): 이 기기 공개 키
  (`%APPDATA%\dev.cldgui.pixeloffice\ssh\id_ed25519.pub`)를 호스트의 `~/.ssh/authorized_keys`에 직접 넣습니다.
- **"키를 등록했는데도 키 인증이 실패했습니다"**: 등록은 됐지만 sshd가 키를 받지 않습니다. 호스트의 홈 폴더가 그룹·기타 쓰기 가능하면
  sshd(`StrictModes`)가 키를 거절합니다(`chmod go-w ~`). `AuthorizedKeysFile`을 바꿨는지도 봅니다.
- **"ssh가 비밀번호를 묻지 않았습니다"**: 이 기기의 Windows OpenSSH가 `SSH_ASKPASS`를 쓰지 않았습니다. PowerShell에서 `ssh -V`로 버전을 보고 알려 주세요.
  그동안은 위의 공개 키를 직접 넣는 방법을 씁니다.
- **"호스트 키가 처음 수락한 키와 다릅니다"** (`Host key verification failed`): 호스트를 다시 설치한 게 아니라면 연결하지 마세요.
  다시 설치했다면 설정 → 이 기기 키 → **키 지우기** 후 다시 연결해 새 지문을 확인하고 수락합니다.
- **외부 링크가 안 열림**: 로그에 `외부 링크 열기: …`가 있는데 브라우저가 안 뜨면 그 다음 줄의 `외부 링크를 열지 못했습니다: … (오류)`를 봅니다.
  `외부 링크 열기` 줄조차 없으면 클릭이 앱에 닿지 않은 것입니다.
- **"호스트 주소와 SSH 포트를 확인하세요"** (`Connection refused`, `timed out`): 호스트 이름과 SSH 포트(기본 2233)를 확인합니다.
- **"ssh를 실행하지 못했습니다"**: Windows 설정 → 시스템 → 선택적 기능에서 **OpenSSH 클라이언트**를 켭니다.
- **로그인 코드 오류**: 호스트에 `~/.local/bin/cld-gui-login`이 있는지, 데몬이 돌고 있는지 확인합니다. 다른 경로면 설정의 **고급 → 로그인 명령**을 고칩니다.
- **"다른 프로그램이 터널 포트를 쥐고 있어 로그인 코드를 보내지 않았습니다"**: 앱은 로컬 포트가 이미 열려 있으면 빈 포트를 골라 터널을 띄우고, 그 포트를 쥔 프로세스가 앱이 띄운 ssh일 때만 로그인 코드를 보냅니다. 포트 주인이 다르거나 확인할 수 없으면(재시도 1회 뒤) 연결을 멈춥니다. 다른 프로그램을 끄고 **다시 연결**하세요.
- **재시도를 모두 썼다**: 상태 화면의 **다시 연결**이나 트레이의 **다시 연결**을 누릅니다.
- **단축키가 안 먹음**: 단축키는 `localhost`/`127.0.0.1`의 오피스(SSH 터널)에서만 동작합니다. 주소로 연결하면 `src-tauri/capabilities/office-keys.json`의 `remote.urls`에 그 주소를 넣고 다시 빌드하세요. 트레이 메뉴는 어느 주소에서나 됩니다.
- 그 밖의 일은 로그 파일의 마지막 줄들을 보면 대부분 원인이 나옵니다.
