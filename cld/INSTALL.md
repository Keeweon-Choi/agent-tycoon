# 에이전트 타이쿤 설치

## 데스크톱 앱

git이나 Node.js 없이 화면으로 쓰려면 데스크톱 앱을 설치하세요. 사무실 프로그램도 앱 안에 들어 있습니다.

### 받기

1. [Desktop bundles](https://github.com/Keeweon-Choi/agent-tycoon/actions/workflows/desktop-bundles.yml)에서 초록색 체크가 있는 가장 새 실행을 열고, 아래 **Artifacts**에서 운영체제에 맞는 zip을 받으세요. GitHub 로그인 계정이 필요합니다.
2. Chrome 또는 Edge가 흔치 않거나 위험할 수 있다며 받기를 보류하면 `Ctrl+J`의 다운로드 목록에서 **계속** 또는 **유지**를 고르세요. Edge는 **… → 유지 → 자세히 표시 → 그래도 계속**을 고릅니다.
3. 설치 파일은 실행 뒤 90일 동안 받을 수 있습니다. 받을 것이 없으면 저장소의 Issues에 알려 주세요.

### Windows

1. `agent-tycoon-windows` zip을 받은 뒤 파일을 우클릭해 **모두 압축 풀기**를 누르고, `Agent Tycoon_<버전>_x64-setup.exe`를 실행하세요.
2. SmartScreen의 **Windows의 PC 보호**가 나오면 **추가 정보**를 누른 뒤 **실행**을 누르세요. 관리자 권한 없이 현재 사용자에게 설치합니다.

### macOS

1. `agent-tycoon-macos` zip의 `Agent Tycoon_<버전>_aarch64.dmg`를 여세요. Apple Silicon 전용이며 Intel 빌드는 아직 없습니다.
2. dmg에서 **Agent Tycoon**을 **응용 프로그램**으로 드래그하세요.
3. 처음 열 때 Apple이 악성 소프트웨어를 확인할 수 없다는 메시지가 나오면 **완료**를 누르고, **시스템 설정 → 개인정보 보호 및 보안** 아래쪽의 **그래도 열기**를 눌러 Mac 암호를 입력하세요. macOS 15부터는 우클릭 **열기**로 넘길 수 없습니다.
4. **손상되었기 때문에 열 수 없습니다**라고 나오면 터미널에서 `xattr -dr com.apple.quarantine "/Applications/Agent Tycoon.app"`를 실행하고 다시 여세요.

### Linux

1. `agent-tycoon-linux` zip의 AppImage는 `chmod +x <.AppImage 파일>` 뒤 `./<.AppImage 파일>`로 실행하세요. FUSE 2가 필요하면 `sudo apt install libfuse2`를, Ubuntu 24.04에서는 `sudo apt install libfuse2t64`를 실행하세요.
2. deb는 `sudo apt install ./<.deb 파일>`로 설치하세요.

### 처음 실행

1. 첫 화면에서 **이 컴퓨터에서 시작** 또는 **다른 컴퓨터에 연결**을 고르세요.
2. **이 컴퓨터에서 시작**은 앱에 든 사무실 프로그램(데몬)을 진행 표시줄과 함께 설치하며, 이 단계에는 인터넷이 필요 없습니다. Windows에서 이미 사무실을 실행하는 WSL 배포판이 있으면 그것을 씁니다.
3. Claude Code가 없으면 **에이전트 CLI(Claude Code)를 설치해 주세요**가 나옵니다. **Git 설치**(Windows에서 Git이 없을 때만)와 **Claude Code 설치**를 차례로 누르면 사무실 터미널에서 설치가 돌아갑니다. 끝나면 **다시 찾기**를 누르고, 터미널에서 `claude`를 한 번 실행해 로그인하세요.

### 업데이트와 제거

1. 업데이트는 새 설치 파일을 기존 설치 위에 실행하세요. 앱만 새 버전으로 바뀌고, 이미 설치된 사무실 프로그램과 데이터는 그대로 남습니다.
2. Windows에서 지우려면 **설정 → 앱 → 설치된 앱 → Agent Tycoon → 제거**를 여세요. 앱이 설치한 사무실 프로그램도 함께 지워지며, 제거기의 앱 데이터 삭제 상자를 고르면 설정과 로그인도 지워집니다. WSL의 사무실이나 터미널 설치기는 건드리지 않습니다.

## 가장 쉬운 방법

저장소를 클론한 뒤 Claude Code에서 **“설치해줘”**라고 말하세요. 프로젝트 스킬이 상태를 확인하고, 의존성·빌드·백그라운드 서비스를 준비한 뒤 로그인 주소를 알려줍니다.

요구 사항은 Node.js 22 이상, npm, git입니다. Claude CLI는 권장 사항이며 설치 자체에는 필요하지 않습니다.

## 한 줄 설치 (공개 릴리스 뒤)

Node 가 없어도 됩니다. 릴리스에 붙은 스크립트가 이 OS·CPU 의 데몬 묶음을 받아 확인하고, 묶음 안의 전용 Node 로 관리자(설치 마법사)를 띄웁니다. 묻는 것은 모두 마법사가 묻습니다.

```sh
# Linux, macOS, WSL
curl -fsSL <릴리스 주소>/install.sh | sh
```

```powershell
# Windows (Windows PowerShell 5.1, PowerShell 7)
irm <릴리스 주소>/install.ps1 | iex
```

공개 릴리스와 그 주소는 아직 없습니다(P9). 저장소가 비공개인 지금은 아래 '비공개·개발용' 방법을 씁니다.

마법사는 OS·CPU, WSL 과 배포판, Claude Code·Codex 가 있는지를 보이고, 다음을 묻습니다.

- **에이전트가 일할 곳**: WSL 배포판이 있는 Windows 에서만 묻습니다(`Ubuntu (WSL2) — 추천` / `Windows 에서 바로` / `다른 컴퓨터에 연결`). WSL 을 고르면 같은 릴리스의 `install.sh` 를 그 배포판 안에서 실행하고, 데스크톱 앱은 Windows 쪽에 깝니다(WSL 안에 Linux 앱을 깔지 않음). Linux·macOS·WSL 에서는 이 컴퓨터에 데몬을 깝니다.
- **데스크톱 앱도 깔까요?** 화면이 있는 데스크톱이면 기본 '예', 화면이 없거나(Linux 에 `DISPLAY`·`WAYLAND_DISPLAY` 없음) SSH 접속이거나 터미널이 아니면 기본 '건너뜀'. 앱은 같은 릴리스의 서명된 `SHA256SUMS` 에 있고 해시가 맞을 때만 쓰고, 설치 파일을 실행하기 전에 한 번 더 묻습니다. 릴리스에 앱이 없으면 한 줄로 알리고 넘어갑니다.
- **지금 입장할까요?** `agty open` 과 같습니다: 앱, 없으면 일회용 로그인 링크로 브라우저, 화면이 없으면 주소·QR·기기 등록 방법. 터미널이 없으면(자동화 로그) 기본은 '안 함'이라 일회용 링크가 로그에 남지 않습니다(`--launch yes` 로 켬).

| 옵션 | 뜻 |
| --- | --- |
| `--yes` | 모든 질문에 기본값, 묻지 않음 |
| `--gui yes\|no` | 데스크톱 앱 설치 여부 |
| `--launch yes\|no` | 끝에 사무실을 열지 |
| `--remote` | 다른 컴퓨터의 사무실에 연결만: 데몬·런타임을 깔지 않고 열 방법만 보임 |
| `--port N`, `--service KIND`, `--add-path` | 관리자 `install` 옵션 그대로 |
| `--from <폴더> --pub <키>` | 내려받지 않고 릴리스 폴더에서 설치 |
| `--base-url <주소>` | 릴리스 주소 바꾸기(시험용). `http://` 는 `127.0.0.1`·`localhost` 에만, `--insecure-localhost` 와 함께 |

터미널이 아니고 `--yes` 도 없으면 묻지 않고 기본값으로 진행한다고 알립니다. `LC_ALL`·`LC_MESSAGES`·`LANG` 이 `ko` 로 시작하면 한국어, 아니면 영어로 말합니다.

### 무엇을 확인하나

1. **스크립트에 박힌 해시표.** 릴리스 때 `cld/release/stamp-installers.mjs` 가 `install.sh`·`install.ps1` 에 버전, 릴리스 주소, 릴리스 공개 키, 그 릴리스의 모든 데몬 묶음 SHA-256 을 채웁니다. 스크립트는 받은 묶음의 SHA-256(`sha256sum`·`shasum -a 256`·`Get-FileHash`)을 이 표와 맞춰 보고, 다르면 아무것도 풀지 않고 멈춥니다. 내려받기는 새 임시 폴더로, HTTPS 로만(리디렉션도 HTTPS 만, Linux·macOS 는 `curl` 필요) 하고, 어떻게 끝나든 임시 폴더를 지웁니다.
2. **관리자의 서명 확인.** 그다음 관리자가 `SHA256SUMS` 의 Ed25519 서명을 스크립트에 박힌 키로 확인하고(`--pub`), 묶음을 풀어 `manifest.json` 의 파일 해시를 모두 맞춥니다.
3. **키 고정.** 그 키를 설치 루트의 `release.pub` 로 고정합니다. 이후 업데이트는 이 키로만 확인합니다(묶음 옆에 놓인 키가 아님).

저장소 안의 `install.sh`·`install.ps1` 은 틀(도장 찍기 전)이라 릴리스 키를 품고 있지 않습니다. 그래서 아무것도 내려받지 않고 `--from <폴더> --pub <키>` 로만 동작합니다. 무엇이든 풀거나 실행하기 전에 OpenSSL 3(`openssl pkeyutl -verify -rawin`)으로 그 폴더의 `SHA256SUMS.sig` 가 `--pub` 키의 서명인지 확인하고, 그다음 묶음을 그 `SHA256SUMS` 와 맞춰 봅니다. `openssl` 이 없거나 Ed25519 를 확인하지 못하면(macOS 기본 LibreSSL 등) 설치를 거절합니다. 이때 믿는 근거는 스크립트가 아니라 사용자가 준 `--pub` 키라서, 경고를 한 줄 보입니다.

### 비공개·개발용 (지금)

```sh
gh release download v<버전> --dir rel        # 묶음, SHA256SUMS, SHA256SUMS.sig, agent-tycoon-release.pub
sh cld/install/install.sh --from rel --pub <따로 받아 둔 릴리스 공개 키>
```

`--pub` 에는 릴리스 폴더에 같이 받은 키가 아니라 따로 확인해 둔 키를 주세요(같이 받은 키는 그 폴더를 만든 사람이 서명했다는 것만 보여 줍니다). Windows 는 `powershell -ExecutionPolicy Bypass -File cld\install\install.ps1 --from rel --pub <키>` 이고, 이때도 PATH 에 OpenSSL 3 의 `openssl.exe` 가 있어야 합니다. 지울 때는 `agty uninstall --program`(데이터 유지) 또는 `--reset`(완전 초기화)입니다.

## 직접 설치 (소스)

저장소 루트에서 실행합니다. 개발자용 소스 설치이며 관리자 설치 기록(`install.json`)을 만들지 않습니다: 관리자는 기록이 없는 설치를 소스 설치로 보고 건드리지 않습니다.

```sh
node cld/install/install.mjs
```

설치기는 기본 포트 `18240`, 읽기 전용 모드와 내장 엔진(자동)을 사용합니다. 설정은 `~/.config/agent-tycoon/config.json`(이 이름을 쓰기 전에 설치한 컴퓨터는 `~/.config/cld-gui/config.json`)에 남으며 다음 실행에서도 유지됩니다. 실행할 명령과 파일만 보고 싶다면 `--dry-run`, 현재 상태만 보려면 `--check`를 사용하세요. 현황판에서 프로젝트를 켜고 끄고 고치려면 `--allow-actions`를 붙여 다시 실행하고, 되돌릴 때는 `--read-only`를 붙입니다. 내장 엔진(프로젝트의 세션을 Claude Code 백그라운드 세션으로 돌림)은 `--engine auto`(기본, 켜짐), `--engine on`, `--engine off`로 정합니다.

```sh
node cld/install/install.mjs --dry-run
node cld/install/install.mjs --check
```

## 명령줄 점검과 복구

설치하면 `agty` 명령이 생깁니다. 예전 이름 `cld-gui`도 같은 명령으로 그대로 됩니다(`cld`는 그 이름이 비어 있을 때만 만듭니다). `agty`를 다른 프로그램이 이미 쓰고 있으면 만들지 않고 `cld-gui`를 쓰라고 알려 드립니다. 현재 상태, 환경, 로그와 서비스를 터미널에서도 확인할 수 있습니다.

```sh
agty status
agty doctor
agty logs -n 200
agty restart
```

- `status`는 데몬·프로젝트·실행 중인 Codex/백그라운드 작업·원격 연결과 HW 한 줄을 한 화면에 보여 줍니다. 데몬이 꺼져 있으면 다음 복구 명령도 알려 줍니다.
- `doctor`는 아무것도 바꾸지 않고 Node, Claude CLI, 서비스, `agty` 이름(우리 것인지, 다른 프로그램인지, 없는지), HTTP 상태, 설정, 디스크와 도구를 점검합니다. `✖`가 하나라도 있으면 종료 코드 1입니다.
- `logs [-n N] [-f]`는 Linux/WSL에서는 사용자 서비스 journal, macOS와 Windows에서는 설치기가 설정한 데몬 로그를 읽습니다.
- `restart`는 현재 사용자 서비스만 다시 시작하고 최대 20초 동안 `/api/health`를 기다립니다. sudo는 쓰지 않습니다.

네 명령 모두 `--json`을 받아 자동화에서 쓸 수 있습니다(`logs -f --json`은 스트리밍 출력과 한 줄 JSON이 서로 맞지 않아 함께 쓸 수 없습니다).

캐릭터를 눌러 백그라운드 세션의 Claude Code 대화를 브라우저에서 그대로 쓰려면 `--allow-chat`을 붙여 다시 실행하세요. 기본은 꺼져 있고, 로그인한 브라우저만 쓸 수 있습니다. 끌 때는 `--no-chat`을 붙입니다.

설치가 끝나면 QR 코드와 `/login?code=…` 주소가 나옵니다. 첫 기기는 10분 안에 QR을 찍거나 주소를 여세요(한 번만 쓸 수 있습니다). 로그인한 뒤 "Face ID로 다음부터 바로 들어오기"에서 패스키를 등록하면 다음부터는 코드 없이 들어옵니다.

다음 기기는 로그인 화면에 8자리 코드(`1234 5678`, 5분 동안 한 번)를 입력합니다. 코드는 로그인한 기기의 **기기 추가** 버튼이나 호스트의 `cld-gui-login`(Linux, WSL, macOS)이 줍니다. `cld-gui-login --qr`은 QR과 10분짜리 주소를, `--link`는 60초짜리 주소를 줍니다. 로그인한 기기 목록과 패스키는 **보안**에서 보고 지울 수 있습니다.

다른 기기가 "승인 요청"을 보내고 로그인한 기기에서 코드를 입력해 들여보내는 방식도 있지만 기본은 꺼져 있습니다. 남이 시작한 요청을 승인하게 만드는 피싱에 쓰이기 쉬워서입니다. 켜려면 `--allow-approval-requests`, 끄려면 `--no-approval-requests`를 붙여 다시 실행하세요.

## H/W 센서(온도·전력)

HW 패널은 CPU 사용률, 메모리, 디스크를 어디서나 보여 주고, 온도와 전력은 운영체제마다 다른 곳에서 읽습니다. 값마다 어디서 왔는지(LHM, sysfs, OS, nvidia-smi)가 붙습니다.

- **Windows, WSL:** 설치기가 LibreHardwareMonitor 0.9.6을 `C:\Program Files\cld-gui\LibreHardwareMonitor`에 받아 SHA-256을 확인하고, 웹 서버(기본 `:8085`)를 켜고 트레이로 시작하게 설정하고, 로그인할 때 켜지는 예약 작업 `cld-gui-lhm`을 만듭니다. 온도 드라이버 PawnIO가 없으면 함께 설치합니다. 이때 Windows 관리자 확인 창(UAC)이 한 번 뜹니다. 이미 LibreHardwareMonitor가 웹 서버를 켜고 돌고 있으면 아무것도 설치하지 않고 그 값을 읽습니다. 건너뛰려면 `--no-hw-sensors`, 다시 켜려면 `--hw-sensors`, 포트를 바꾸려면 `--lhm-port <포트>`를 붙입니다. `--uninstall`은 우리가 만든 예약 작업과 그 폴더만 지우고, PawnIO와 다른 LibreHardwareMonitor는 남깁니다.
- **Linux:** 설치할 것이 없습니다. `/sys/class/hwmon`에서 CPU 온도를, AMD GPU면 온도·전력·사용률·VRAM까지 읽습니다. CPU 온도를 찾지 못하면 설치기가 선택 사항으로 `sudo apt install lm-sensors && sudo sensors-detect`를 알려 줍니다.
- **macOS:** 설치할 것이 없습니다. 온도와 전력은 관리자 권한이나 별도 프로그램이 있어야 해서 보여 주지 않습니다.
- **NVIDIA GPU를 nvidia-smi로:** 기본은 꺼져 있습니다. `--nvidia-smi`로 켜면 다른 곳에서 GPU 값을 얻지 못할 때만 조회하고, 앞선 nvidia-smi가 2초 넘게 멈춰 있거나 1.5초 안에 답하지 않으면 그 차례를 건너뜁니다(큰 학습 중 멈춤 방지).

## 노트북과 휴대폰

호스트가 아닌 노트북에서는 SSH 터널 연결만 만듭니다.

```sh
node cld/install/install.mjs --client --target user@host --ssh-port 2233
```

Windows에서는 PowerShell 연결 스크립트와 바로가기를, macOS/Linux에서는 `connect.sh`를 사용합니다.

### 연결 방식(커넥터)

새로 설치하면 **같은 와이파이(LAN)**에서 `http://<이 PC의 LAN 주소>:18240`으로 열립니다(`--connector lan`). 예전 설치는 이 PC 안에서만(`local`), Tailscale을 쓰던 설치는 그대로(`tailscale`) 둡니다. 직접 정하려면 `--connector local|lan|tailscale|direct`를 붙입니다. LAN 주소는 http라서 패스키는 못 쓰고 8자리 코드와 QR로 들어옵니다.

WSL은 기본(NAT 모드)이면 같은 와이파이의 기기도 WSL 안을 보지 못합니다. 설치기와 앱이 Windows 쪽에서 한 번 할 일을 정확한 명령으로 보여 줍니다(`.wslconfig`의 `networkingMode=mirrored`, 관리자 PowerShell의 방화벽 규칙 하나).

### 밖에서도 접속하기

```sh
node cld/install/install.mjs --remote
```

설치기가 길을 스스로 고르고, 건너뛴 길은 이유를 한 줄로 말합니다. 순서는 다음과 같습니다.

1. **이미 Tailscale+Funnel이 이 PC를 열고 있으면** 그대로 둡니다(할 일 없음).
2. **직접 열기(가입 없음):** 공유기에 UPnP로 외부 443을 이 PC로 연결하고, Let's Encrypt에서 공인 IP 인증서(160시간, 2/3 지나면 자동 갱신)를 받고, 바깥에서 확인합니다. 통신사 NAT(CGNAT)나 이중 NAT, UPnP가 꺼진 공유기면 건너뜁니다. 공유기에서 직접 포트포워드(외부 TCP 443 → 이 PC:18443)를 넣었다면 `--manual-forward`로 다시 하세요. 이미 DuckDNS 이름이 있으면 `--ddns <이름>.duckdns.org --ddns-token-file <토큰 파일>`로 IP 대신 이름에 인증서를 받습니다(IP가 바뀌어도 주소가 그대로입니다).
3. **SSH(노트북 앱만):** 이 PC에 sshd가 열려 있으면 알려 줍니다. 아이폰은 쓸 수 없습니다.
4. **Tailscale(마지막 길):** 로그인돼 있으면 Tailscale Serve 로 엽니다. 같은 tailnet 에 들어 있는 기기(Tailscale 앱이 깔린 폰·노트북)에서만 들어올 수 있습니다. 공개 인터넷으로 여는 Funnel 은 `--connector funnel` 로 직접 고를 때만 켜고, 이미 켜 둔 Funnel 은 재설치·업데이트 뒤에도 그대로 둡니다. Funnel 을 고르면 tailnet 이 아직 허용하지 않았을 때 허용 링크를 QR로 보여 주고 최대 10분 기다립니다. Tailscale이 없으면 관리자 권한이 필요한 설치 명령(Linux·WSL은 sudo, Windows는 UAC 한 번)과 `tailscale up --qr`을 먼저 보여 주고, 터미널에서 "예"라고 답할 때만 실행합니다.
5. 그래도 안 되면 **"Claude 앱으로 대화만"**: 엔진 프로젝트 설정에서 remote-control을 켜면 Claude 앱에서 그 세션과 대화할 수 있습니다. Anthropic이 대화를 중계·저장하고, 요청마다 토큰이 들고, 픽셀 오피스는 없습니다.

직접 열기의 주소는 `https://<공인 IP>/<비밀 경로>/` 하나입니다. 비밀 경로 없이 오는 접속(스캐너 등)에는 빈 404만 돌려줍니다. 초대(설치 끝의 QR, **기기 추가**, `cld-gui-login`)에는 늘 이 주소가 들어 있어서, 로그인한 휴대폰의 **기기 추가**(주소 + 8자리 코드 + QR)로 카페의 노트북도 들어올 수 있습니다. 노트북 앱은 "주소 · 초대 링크"에 초대 링크를 붙여 넣거나 주소와 코드를 넣습니다. 비밀 경로는 **보안 → 바깥 직접 연결**에서 바꿀 수 있고, 바꾸면 다른 기기는 모두 다시 초대해야 합니다.

공인 IP가 바뀌면 10분 안에 알아채고 인증서를 다시 받습니다. 밖에 있는 기기는 새 주소를 스스로 알 수 없으니, 집 와이파이에서 한 번 다시 연결하세요(LAN 화면에 안내가 뜹니다). DuckDNS 이름을 쓰면 이 일이 없습니다. 지금 상태는 `node cld/install/install.mjs --check`가 보여 줍니다.

## 업데이트와 제거

```sh
git pull
node cld/install/install.mjs
node cld/install/install.mjs --uninstall
```

`--uninstall`은 서비스만 제거하고 설정은 보존합니다. 직접 열기(`direct`)를 쓰던 PC에서는 먼저 공유기의 외부 443 연결과 HTTPS 대기를 닫습니다. 설정도 지우려면 `--uninstall --purge`를 사용하세요. 인증서·키·비밀 주소·DuckDNS 토큰(`~/.config/agent-tycoon/tls`, 이 이름을 쓰기 전에 설치한 컴퓨터는 `~/.config/cld-gui/tls`)도 함께 지웁니다.

### 새 버전 알림 (관리자로 깐 설치만)

사무실 화면이 열려 있을 때만, 8시간에 한 번 이하로 `agty update --check` 와 같은 확인(고정한 릴리스 키로 서명된 `SHA256SUMS`)을 데몬이 합니다. 열려 있는 화면이 없으면 아무것도 묻지 않고, 확인이 실패하면 조용히 넘어갑니다. 새 버전이 있으면 "새 버전 X.Y.Z"(릴리스가 서명된 `release-notes.txt` 를 달았으면 바뀐 점)와 "설치"가 뜨고, 누르면 한 번 더 묻습니다. 원격 기기는 step-up 이 필요하고, 읽기 전용이면 알림만 보입니다. 설치는 `agty update` 그대로라 데몬만 잠깐 멈추고 세션·작업 공간·작업은 계속 돌며, 병합이 진행 중이거나 업데이트가 이미 돌고 있으면 이유를 말하고 미룹니다. 소스 설치와, 서비스가 데몬과 함께 업데이트 프로그램을 끌 수 있는 방식(launchd·Windows 작업)은 터미널 명령만 알려 줍니다.

화면은 "이 빌드는 서명을 확인할 수 있다"(기능)와 "이 릴리스의 서명이 확인됐다"(결과)를 따로 보입니다. 공식 릴리스 키와 Windows·macOS 코드 서명은 아직 없다고 함께 적습니다(공개 릴리스 P9 에서 `updateNotice.ts` 의 두 상수를 바꿉니다). 확인 주소는 `UPDATE_SOURCE`(공개 저장소가 생기기 전까지는 자리표시자라 알림이 뜨지 않습니다).

## 문제 해결

- **포트가 사용 중입니다:** 설치기는 18240–18299의 다음 빈 포트를 고릅니다. 직접 지정하려면 `--port 18241`을 사용하세요.
- **WSL에서 systemd가 없습니다:** `/etc/wsl.conf`에 아래를 사용자가 추가한 뒤 WSL을 재시작하세요. 설치기는 sudo를 실행하지 않습니다.

  ```ini
  [boot]
  systemd=true
  ```

- **Tailscale HTTPS가 안 됩니다:** Tailscale 관리자 콘솔에서 HTTPS 인증서를 활성화해야 합니다.
- **직접 열기가 "Let's Encrypt가 확인하지 못했어요"로 끝납니다:** 바깥에서 443으로 이 PC에 닿지 않는다는 뜻입니다. 공유기 위에 모뎀(공유기)이 하나 더 있거나(브리지 모드 요청), 통신사가 443을 막거나, 포트포워드가 다른 기기를 가리킵니다. 실패한 발급은 한 시간에 한 번만 다시 시도합니다.
- **로그인 코드가 만료되었습니다:** 8자리 코드는 5분, QR은 10분, `--link` 주소는 60초 동안 한 번만 쓸 수 있습니다. `cld/bin/cld-gui-login`이나 로그인한 기기의 **기기 추가**로 새 코드를 받으세요.
- **"잠시 후 다시 시도하세요":** 틀린 코드가 많으면 5분(같은 기기) 또는 10분(8자리 코드 전체) 동안 막힙니다. 그동안에도 QR, 패스키, 승인 요청은 쓸 수 있습니다.
