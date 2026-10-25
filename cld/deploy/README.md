# 배포 및 접속

## 호스트 서비스 설치

서비스 파일은 설치기가 이 PC에 맞게 만듭니다(사용자 폴더, Node 경로, 포트). `node cld/install/install.mjs`를 실행하면 `~/.config/systemd/user/cld-gui.service`를 쓰고 켭니다. 자세한 것은 [설치 안내](../INSTALL.md)에 있습니다. 예전에 이 폴더에 있던 `cld-gui.service`는 개발 PC의 경로(`/home/…`, nvm Node)가 박혀 있어 지웠습니다(ENV-1).

WSL에는 `systemctl --user`용 사용자 버스가 없을 수 있습니다. 처음 한 번 `sudo apt install dbus-user-session` 후 Windows에서 `wsl --shutdown`으로 재시작하고, 부팅 시 자동 시작을 위해 `loginctl enable-linger $USER`를 실행합니다.

상태는 `systemctl --user status cld-gui.service`로 확인합니다.

## Windows 노트북

PowerShell에서 한 번 실행해 호스트를 저장하고 바로 가기를 만듭니다.

```powershell
.\cld\scripts\connect.ps1 -Target user@hostname -CreateShortcut
```

이후 바탕 화면의 **Pixel Office** 바로 가기를 더블 클릭합니다. SSH 키 로그인이 설정되어 있어야 합니다.

## macOS / Linux

터미널에서 최초 한 번 호스트를 지정합니다. 이후에는 저장된 호스트를 사용합니다.

```bash
./cld/scripts/connect.sh -t user@hostname
```

## 문제 해결

- **포트 사용 중:** `localhost:18240`을 점유한 앱을 종료하거나 로컬 포트를 바꿉니다. Windows는 `-LocalPort`, macOS/Linux는 `-l`을 지정합니다.
- **WSL을 재시작한 직후:** 호스트 서비스가 다시 올라올 때까지 최대 5분 기다린 뒤 다시 연결합니다.
- **코드가 만료됨:** 로그인 화면을 닫고 연결 스크립트를 다시 실행해 새 코드를 받습니다.
