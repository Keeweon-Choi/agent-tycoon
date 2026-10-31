# 에이전트 타이쿤

에이전트 타이쿤은 Claude Code 에이전트의 작업과 대화를 픽셀 사무실에서 보여 주는 앱입니다. 브라우저에서 에이전트를 살펴보고, 로그인한 기기에서 프로젝트와 세션을 다룰 수 있습니다.

## 딸깍 설치

**데스크톱 앱 (Windows · macOS · Linux)** — [설치 안내](cld/INSTALL.md#데스크톱-앱)를 따라 받으세요. 설치 파일에 코드 서명이 없어 처음 한 번 경고가 뜹니다. 넘기는 방법도 안내에 있습니다.

**터미널 설치에 필요한 것:** git, npm, Node.js 22 이상. Claude Code CLI는 에이전트를 실행할 때 필요하지만 설치 자체에는 없어도 됩니다. 자세한 설치와 원격 접속 방법은 [설치 안내](cld/INSTALL.md)에 있습니다.

**터미널에서 한 줄** (macOS · Linux · WSL)

```sh
curl -fsSL https://raw.githubusercontent.com/Keeweon-Choi/agent-tycoon/main/cld/install/get.sh | sh
```

**또는 Claude Code에 붙여넣기**

```text
에이전트 타이쿤을 설치해줘. 저장소: https://github.com/Keeweon-Choi/agent-tycoon . 받은 뒤 그 안의 .claude/skills/cld-install/SKILL.md 대로 진행해줘.
```

설치가 끝나면 로그인 URL과 코드가 나옵니다. 브라우저에서 열어 코드를 입력하세요. 다시 실행하면 같은 폴더(`~/agent-tycoon`)에서 업데이트합니다. 저장소 주소와 설치 폴더는 `AGENT_TYCOON_REPO`, `AGENT_TYCOON_DIR`로 바꿀 수 있습니다.

## 개발

```sh
git clone https://github.com/Keeweon-Choi/agent-tycoon.git
cd agent-tycoon
npm install
npm run build
```

확인은 `npm run check-types`, `npm run lint`, `npm test` 순서로 합니다. 개발 규칙과 구조는 [CONTRIBUTING.md](CONTRIBUTING.md), 용어는 [CONTEXT.md](CONTEXT.md), 종단 시험은 [e2e/README.md](e2e/README.md)에 있습니다. 이슈와 제안은 [Issues](https://github.com/Keeweon-Choi/agent-tycoon/issues)로 보내 주세요.

## 변경 내역

[CHANGELOG.md](CHANGELOG.md)를 보세요. 앱 안의 업데이트 소식에도 같은 내용이 있습니다.

## 출처와 라이선스

에이전트 타이쿤은 Pablo De Lucca의 [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)(MIT)를 바탕으로 만들었습니다. 원 프로젝트의 MIT 저작권 고지를 [LICENSE](LICENSE)에 그대로 두고 새 작업의 저작권을 함께 적었습니다. 그림과 소리 등 자료의 출처는 [ASSETS.md](ASSETS.md)에 있습니다.
