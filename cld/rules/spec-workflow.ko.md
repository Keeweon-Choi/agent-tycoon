# 명세 흐름 (이 프로젝트는 사용자가 Spec Kit 모양을 켰다)

이 프로젝트의 새 기능은 GitHub Spec Kit 과 같은 모양의 문서로 먼저 적고, 그 문서를 따라 일한다. Agent Tycoon 이 이 문서들을 읽어 요구사항 · 이슈 · 커밋 · 시험을 짐작 없이 잇는다.

## 먼저 볼 것
- 프로젝트에 `.specify/` 가 있으면 그 프로젝트의 Spec Kit 명령 · 템플릿(`.specify/templates/`) · 원칙(`.specify/memory/constitution.md`)이 이 규칙보다 먼저다. 아래는 그것이 말하지 않는 것만 채운다.
- 작은 고침과 버그 수정은 명세 없이 한다. 새 기능(사용자 이야기가 하나 이상인 일)만 아래 흐름을 탄다.

## 1. spec.md (코드보다 먼저)
- `specs/NNN-짧은-이름/spec.md` 를 쓴다. `NNN` 은 `specs/` 안의 다음 세 자리 번호, 이름은 영어 소문자와 `-` 다(예: `specs/004-loan-renewal/`).
- Spec Kit 템플릿의 제목을 그대로 쓴다.
  - `# Feature Specification: <제목>`
  - `### User Story N - <제목> (Priority: Pn)` 와 그 아래 `**Acceptance Scenarios**:` 와 `1. **Given** …, **When** …, **Then** …`
  - `## Requirements` 아래 `- **FR-001**: …` (번호는 기능마다 001부터)
  - `## Success Criteria` 아래 `- **SC-001**: …`
  - 모르는 것은 지어내지 말고 `[NEEDS CLARIFICATION: 무엇을 모르는지]` 로 남긴다.
- 다 쓰면 사용자에게 한 번 묻는다: "specs/004-loan-renewal 명세로 진행할까요? ⟨q:spec-004⟩". 확인 필요 표시가 있으면 그것부터 묻는다. 답을 받기 전에는 구현을 시작하지 않는다.

## 2. plan.md
- `## Technical Context` 에 `**Language/Version**: …`, `**Testing**: …` 처럼 `**이름**: 값` 줄을 쓴다.
- `## Project Structure` 에 바꾸거나 만들 폴더와 파일을 코드 블록 폴더 나무로 쓴다(이미 있는 저장소의 실제 경로).

## 3. tasks.md
- `## Phase N: <이름>` 아래 한 줄에 작업 하나: `- [ ] T001 [P] [US1] FR-002 <설명> <경로>`.
  - `[P]` 는 다른 작업과 함께 해도 될 때만, `[US1]` 은 그 작업이 채우는 이야기.
  - **그 작업이 채우는 FR 번호를 꼭 적는다**(여럿이면 `FR-002 FR-003`). Spec Kit 템플릿에는 없지만 요구사항과 작업을 잇는 유일한 표시다.
- 작업을 끝내면 그 줄을 `- [x]` 로 바꾼다.

## 4. 이슈와 커밋
- 이야기마다 이슈를 하나 만든다(MCP `create_task`). 제목은 `004-loan-renewal/US1 <이야기 제목>`.
- 커밋 메시지에 작업 번호와 FR 번호를 적는다(예: `feat(loans): renew a loan once (T007, FR-002)`).

## 하지 않는 것
- 이미 있는 요구사항 문서(SRS, PRD, `docs/` 의 표 등)는 사용자가 시킬 때만 고친다. 옮기거나 `specs/` 로 바꿔 쓰지 않는다.
- `.claude/settings.json`, `CLAUDE.md`, `AGENTS.md` 를 이 흐름 때문에 고치지 않는다.
- Spec Kit 을 직접 설치하거나 `specify` 를 실행하지 않는다. 설치는 사용자가 앱에서 정한다.
