---
name: agty-install
description: "Install, update, check or uninstall Agent Tycoon (the office tycoon) on this machine, open access from outside (router first, Tailscale as the last resort), or set up a laptop to connect to a host. Use when the user says 설치해줘, 설치, install, set up, 업데이트, 제거, 연결 설정, or asks how to open the office from a laptop or phone."
---

`agent-tycoon/install/install.mjs`가 설치와 점검을 담당한다. 큰 파일을 읽지 말고 이 절차를 따른다.

0. 이 저장소가 아직 없는 새 컴퓨터라면(`agent-tycoon/install/install.mjs`가 없음) 먼저 받는다: 사용자가 알려준 저장소 주소(없으면 `https://github.com/Keeweon-Choi/agent-tycoon.git`)를 `~/agent-tycoon`에 `git clone`하고(이미 있으면 `git pull --ff-only`) 그 안에서 `HUSKY=0 npm ci`, `npm run build`를 실행한 뒤 아래 1번부터 진행한다. git·Node 22 이상·claude가 없으면 sudo 없이 설치 방법 한 줄만 알려주고 멈춘다. 터미널 한 줄 방법은 `sh agent-tycoon/install/get.sh`가 위 과정을 그대로 한다. 사용자가 이미 정한 값(주소, 폴더, 포트)은 다시 묻지 않는다.
1. 먼저 `node agent-tycoon/install/install.mjs --check`을 실행하고 결과를 2–3줄로 요약한다.
2. 18240이 다른 프로그램 때문에 점유된 경우에만 포트를, 그 외에는 원격/휴대폰 접근을 설정할지 한 번만 묻는다.
3. `node agent-tycoon/install/install.mjs`를 실행한다. 원격 접근을 원하면 `--remote`를 덧붙인다. Windows와 WSL에서는 LibreHardwareMonitor가 없으면 센서 도구를 설치하며 Windows 관리자 확인 창(UAC)이 한 번 뜬다고 실행 전에 알린다. 원치 않으면 `--no-hw-sensors`를 붙인다.
4. 실패 시 오류 줄만 확인한다. Node가 오래되면 nvm을 안내하고 sudo는 실행하지 않는다. 포트 충돌이면 다른 포트를 사용한다. WSL의 systemd가 꺼져 있으면 사용자가 `/etc/wsl.conf`에 `[boot]`와 `systemd=true`를 추가한 뒤 WSL을 재시작하도록 안내한다.
5. 로그인 URL과 노트북/휴대폰에서 여는 방법을 한 줄씩 알려준다.
6. `--remote`는 직접 열기(공유기, 가입 없음) → SSH(노트북 앱) → Tailscale → Claude 앱으로 대화만 순서로 스스로 고르고 ✔/✖와 건너뛴 이유를 찍는다. "호스트에서 한 번:"으로 나온 sudo·관리자 명령은 실행하지 말고 그대로 사용자에게 전한다. Tailscale 단계는 tailnet 기기만 들어오는 Serve 로 열고, 공개 인터넷인 Funnel 은 사용자가 `--connector funnel` 로 고를 때만 켠다. Tailscale Serve나 Funnel이 이미 켜져 있으면 아무것도 바꾸지 않고, 켜져 있다고 가정하지도 않는다. 사용자가 고른 것만 바꾼다.

노트북 연결 설정 요청에는 `node agent-tycoon/install/install.mjs --client --target <user@host>`를 실행한다. 업데이트 요청에는 `git pull` 뒤 설치기를 다시 실행한다. 제거 요청에는 `node agent-tycoon/install/install.mjs --uninstall`을 사용한다.
