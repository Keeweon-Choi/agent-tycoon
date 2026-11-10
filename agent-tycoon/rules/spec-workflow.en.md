# Spec workflow (the owner switched on the Spec Kit shape for this project)

New features in this project are written down first, as documents in GitHub Spec Kit's shape, and the work follows them. Agent Tycoon reads these documents to tie requirements, issues, commits and tests together without guessing.

## Look first
- If the project has `.specify/`, its Spec Kit commands, templates (`.specify/templates/`) and constitution (`.specify/memory/constitution.md`) come before these rules. What follows only fills in what they do not say.
- Small fixes and bug fixes need no spec. Only a new feature (work with one or more user stories) goes through the steps below.

## 1. spec.md (before any code)
- Write `specs/NNN-short-name/spec.md`. `NNN` is the next three-digit number in `specs/`; the name is lower-case English and `-` (for example `specs/004-loan-renewal/`).
- Use Spec Kit's template headings as they are:
  - `# Feature Specification: <title>`
  - `### User Story N - <title> (Priority: Pn)`, then `**Acceptance Scenarios**:` and `1. **Given** …, **When** …, **Then** …`
  - under `## Requirements`: `- **FR-001**: …` (numbered from 001 in each feature)
  - under `## Success Criteria`: `- **SC-001**: …`
  - What you do not know, do not invent: leave `[NEEDS CLARIFICATION: what is unknown]`.
- When it is written, ask the owner once: "Go ahead with the spec specs/004-loan-renewal? ⟨q:spec-004⟩". Ask about any clarification marks first. Do not start implementing before the answer.

## 2. plan.md
- Under `## Technical Context`, `**Name**: value` lines such as `**Language/Version**: …`, `**Testing**: …`.
- Under `## Project Structure`, the folders and files you will change or add, as a folder tree in a code block (the repository's real paths).

## 3. tasks.md
- Under `## Phase N: <name>`, one task per line: `- [ ] T001 [P] [US1] FR-002 <description> <path>`.
  - `[P]` only when it can run alongside other tasks; `[US1]` is the story it serves.
  - **Always write the FR numbers the task fulfils** (several: `FR-002 FR-003`). Spec Kit's template has no such mark, but it is the only thing that ties a requirement to its tasks.
- When a task is done, change its line to `- [x]`.

## 4. Issues and commits
- One issue per story (MCP `create_task`), titled `004-loan-renewal/US1 <story title>`.
- Commit messages name the task and FR numbers (for example `feat(loans): renew a loan once (T007, FR-002)`).

## Never
- Existing requirement documents (SRS, PRD, tables in `docs/`, ...) are changed only when the owner asks. Do not move them or rewrite them into `specs/`.
- Do not edit `.claude/settings.json`, `CLAUDE.md` or `AGENTS.md` for this workflow.
- Do not install Spec Kit or run `specify` yourself. The owner decides that in the app.
