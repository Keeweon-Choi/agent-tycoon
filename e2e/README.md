# Agent Tycoon e2e tests

Playwright end-to-end tests for the standalone daemon (`node dist/cli.js`) in a headless browser. This README is the single source of truth for what's e2e-tested, what's not, and how to run the suite.

## What this suite covers

Behavioral overview by area. Each area corresponds to a `test.describe` block in the spec files, an `@area:` tag on each test title, and an Allure `epic` label.

Every flow is one path a user walks plus the one refusal that matters, on the standalone daemon with the engine on and the engine fake as `claude` (see "Mocking model & rules"). The seed of each flow is its `standaloneOptions` (agents, scenarios, `firstRun`, `noClaude`, `cliArgs`, `env`); the page is logged in through the daemon's login link, as the installer does.

### Access (`@area:access`)

The first open on a new PC asks how to connect and, once, how new agents ask for permission; the host link logs in, a code adds a second device, sign-out puts it back out.

### Dev room (`@area:devroom`)

A Worker's worktree waiting for review is read in the dev room and merged.

### Files (`@area:files`)

Browse a project's files, preview, download, edit and save.

### Jobs (`@area:jobs`)

A job an agent started shows its progress and log and stops when asked.

### Messenger (`@area:messenger`)

A direct message reaches the agent and its reply is read and kept; a group room post that mentions everyone gathers the replies under it; a permission card is answered with its buttons (never with keys).

### Office (`@area:office`)

Add an agent from the office, start, stop and remove it; watch it work, hand work to sub-agents and wait for an answer; the daemon restarts and the page, the agent and the draft are still there; without Claude Code the office says how to install it and picks it up.

### Settings (`@area:settings`)

The screen style and the language stick across a reload, and the messenger works in both styles.

### Terminal (`@area:terminal`)

The conversation opens the agent's own live terminal; closing the tab leaves the agent running.

### Mobile shell (`@area:mobile`)

The office on a phone-sized touch viewport (`PHONE`: 390×844, `hasTouch`): the Dock shows one page at a time, keeps the conversation, answers a permission, and Back stays in the app. Taps use Playwright's real touch input. The gesture state machines (edge swipe, terminal touch, card order) are unit-tested on the webview Node runner.

## What's NOT covered (gaps + deferred)

Scenarios that exist as product behavior but are not in the automated suite. PRs that close a gap should remove the corresponding row.

| Scenario                                                                             | Why not automated                                                                                                    | Tracked        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------- |
| External asset directory add/remove via Settings                                     | Needs bundled test asset packs                                                                                       | none           |
| Bypass-permissions startup flag                                                      | Security-sensitive; manual review path                                                                               | none           |
| Mobile key bar (Esc, Tab, arrow slide, paste) above the software keyboard            | Only shows while the iOS/Android keyboard shrinks the visual viewport; headless browsers have no software keyboard   | manual (phone) |
| Terminal long-press selection, copy pill, handles, flick scroll; canvas pinch zoom   | Multi-touch timing gestures; the decision logic is unit-tested (`touchGesture`, `edgeSwipe`), the device feel is not | manual (phone) |
| Mobile card bar long-press reorder                                                   | Long-press + drag on a horizontal scroller; ordering rules unit-tested (`cardBar.test.ts`)                           | manual (phone) |
| Terminal: tap a URL, two-finger pan, trackpad key; verbatim copy and Alt+C           | Gestures and clipboard rules owned by `agent-tycoon/test/run-terminal.ts`, `run-phone-zoom.ts` and the unit tests    | runner         |
| Layout editor, Directories and the launch drawer, the old Settings modal, Debug View | Not reachable in the rebuilt office; the upstream components are a cleanup of their own                              | none           |

The VS Code extension and its e2e suite (spawn paths, lifecycle regressions, teams routing, the hooks-off matrix, layout editor) were removed on 2026-11-01. The suite was rebuilt on 2026-11-13 (T-99) as the core flows above; the rest stays with the runners (`agent-tycoon/test/run-*.ts`).

## Pre-release manual smoke (~20 min)

CI green on this suite is the safety net for behavioral regressions. The checks below are what e2e can't meaningfully assert on (visual polish, real-Claude integration, cross-process behaviors).

**Visual + interactive polish** (after any change touching `renderer.ts`, `spriteCache.ts`, `colorize.ts`, `*.tsx`, CSS, or `editorActions.ts`):

- Pan around the office with middle-mouse drag — characters z-sort correctly against same-row chairs and lower-row desks, no flicker.
- Spawn 3+ agents — matrix spawn animation renders cleanly, characters move smoothly between seats.
- Open the Layout editor — paint floor with HSBC sliders, place + rotate (R) furniture, toggle on/off (T) state, drag-to-move in SELECT, multi-stage Esc unwinds correctly.
- Hover and click characters — overlay text positioning is correct, selection outline crisp, click on a seat reassigns.

**Real Claude Code integration** (mock-claude is a fixture; real Claude's JSONL has edge cases the mock doesn't):

- `node dist/cli.js`, open the printed URL in Chrome, Firefox AND Safari, run a real Claude session in a terminal — confirm characters appear and animate via WebSocket, with a few tool-heavy turns and a permission-requiring tool.
- Use a session with a large pasted image (multi-MB base64 user message) — confirm the "Possible format issue" warning doesn't false-fire and tool tracking still works.
- Test with one MCP server installed — confirm `mcp_progress` records don't break tool status.
- Refresh the browser mid-session — WebSocketTransport reconnects, agents reappear from server state.

**First-run experience** (in a temp HOME, never the real one):

- Start the daemon with an empty office folder — default layout loads, the Intro appears, no console errors.

## Running

```bash
npm run compile && npm run e2e               # full suite

npm run e2e -- --grep "@area:messenger"      # filter by area tag
npm run e2e -- --headed                      # watch chromium

npm run e2e:inventory                        # regenerate the inventory section below
npm run test:report                          # build the Allure dashboard from latest run
npm run test:report:open                     # serve + open the Allure dashboard in a browser
```

## Mocking model & rules

E2E tests drive the daemon through a Claude-like **process boundary**, not by poking internals. The fixture (`e2e/fixtures/standalone.ts` -> `e2e/helpers/standalone.ts` on `server/src/agent-tycoon/testHome.ts`, the same temp HOME the runners use) puts the **engine fake** (`agent-tycoon/test/fake-claude/engine.cjs` + `pty-tui.cjs`) in `<home>/bin/claude` and starts the daemon with `--engine on --allow-actions --allow-chat`. The engine starts each agent as `claude -n <name>` in its own PTY host, so the fake behaves like the real CLI for the parts the daemon observes: the probes (`--version`, `--help`, `-p /usage`), the trust and bypass dialogs, a session file and OSC status, an append-only JSONL transcript, typed prompts and the `PermissionRequest` hook from `--settings`. A scenario is handed to it through `<home>/.claude-mock/scenario-queue.json` (never an environment variable: the engine starts Claude with a clean one); `e2e/fixtures/mock-claude-runner.cjs` plays it.

The builder is `claudeScenario(name)` in `e2e/helpers/mock-claude.ts` (documented in CONTRIBUTING.md -> "Mock claude"). Its verbs for an engine agent:

- `.forAgent(name)` -- the scenario belongs to the session started as `claude -n <name>` and is kept: a restart or `--resume` of that agent plays it again. Probes never claim it.
- `.onPrompt(text)` -- the `.at(ms)` steps after it run when a submitted prompt contains `text`, counted from that prompt; the session is `busy` until the last step, then `idle`. No match: the fake's own echo reply.
- `.at(ms).appendJsonl(record)` -- a transcript record (`buildAssistant*Record`, `buildUserToolResultRecord`, `buildTurnDurationRecord` in `helpers/team.ts`).
- `.at(ms).emitHook(permissionRequest('{{sessionId}}', tool, input))` -- inside a prompt: the session runs its own `PermissionRequest` hook, status `waiting`, the clock stops until the card is answered; `{{permission}}` is `allow` or `deny` in the steps after it.
- `.at(ms).writeJson / .deletePath / .exit` -- as before. `withoutAutoInit` and `holdOpenFor` mean nothing for an engine session.

Rules for a correct test:

- **Drive behavior through a scenario, not by hand.** Define timed actions with the builder and let the mock perform them. A test body never writes a transcript or fires a hook.
- **Transcripts are append-only.** Existing JSONL lines are never mutated in place; new records appear later in the stream.
- **Seeding state before the daemon starts is setup, not driving.** `standaloneOptions` (`agents`, `scenarios`, `firstRun`, `noClaude`, `cliArgs`, `env`) and `agty(...)` (the CLI as a user of this HOME runs it) are the sanctioned ways in; the fixture also offers `stopHost`/`startHost` for a restart and `loginUrl()`.
- **Assert only on Playwright-visible outcomes** -- the DOM the product already marks (`[data-testid="status-icon-anchor"][data-ring]`, `agent-card`, `party-waiting`, `permission-card`, `<html data-ui-theme lang>`) -- never on the mock's internals. The mock never decides pass/fail.
- **Never touch the real thing.** Each test gets its own temp HOME, port and daemon; nothing reads `~/.claude`, `~/.config/agent-tycoon` or port 18240, and teardown ends only the PTY host and fake sessions of that HOME.

## What to read before adding a test

- `CLAUDE.md` — architecture and message protocol
- `e2e/fixtures/standalone.ts` — fixture lifecycle (temp HOME, own server)
- `e2e/helpers/` — every helper, especially `standalone.ts` (the launcher), `mock-claude.ts`, `messenger.ts`, `office.ts`, `team.ts` (record builders) and `hooks.ts` (`permissionRequest`)
- `server/src/agent-tycoon/testHome.ts` — the temp HOME, the daemon start and the page pins the fixture stands on

When you add a new test:

- Pick a `test.describe` block that matches an existing `@area:` tag, OR add a new area to the "What this suite covers" section above and pick a tag.
- Add `@area:<tag>` to the test title.
- Add Allure `epic` / `feature` / `story` labels matching the area.
- Run `npm run e2e:inventory` and commit the regenerated section.

When you remove a test:

- Run `npm run e2e:inventory` so the inventory drops it.
- If the scenario it tested is now manual or deferred, add a row to "What's NOT covered".

## Test inventory

This section is auto-generated. Do not edit between the markers; CI fails on drift.

<!-- BEGIN:E2E-INVENTORY -->

22 tests total. Generated by `scripts/generate-e2e-inventory.mjs`. Re-run after adding or removing tests.

### `@area:office` (8 tests)

- `e2e/standalone/agent-add-start-stop.spec.ts:23` — an agent added from the office starts, stops, starts again and is removed
- `e2e/standalone/daemon-restart-reconnect.spec.ts:44` — the daemon restarts and the page, the agent and the draft are still there
- `e2e/standalone/engine-smoke.spec.ts:38` — a seeded engine agent works through a scenario turn and answers
- `e2e/standalone/office-walk-after-click.spec.ts:105` — after a click on an idle employee, D walks that employee (an idle employee)
- `e2e/standalone/office-walk-after-click.spec.ts:121` — after a click on my own character, D walks it (an idle employee)
- `e2e/standalone/office-walk-after-click.spec.ts:160` — after a click on an employee at work, D looks around instead of doing nothing (an employee at work)
- `e2e/standalone/office-watch-work-and-wait.spec.ts:98` — watch an agent work, hand work to sub-agents and wait for an answer
- `e2e/standalone/plain-office-install-claude.spec.ts:18` — without Claude Code the office says how to install it and picks it up once installed

### `@area:messenger` (5 tests)

- `e2e/standalone/dm-send-reply.spec.ts:66` — a direct message reaches the agent, its turn shows, the reply is read and kept
- `e2e/standalone/group-room-mention.spec.ts:31` — a group room post mentioning everyone gathers both replies under it
- `e2e/standalone/messenger-tab-scroll-kept.spec.ts:68` — a conversation scrolled up keeps its place across tabs, the dock and split layouts
- `e2e/standalone/messenger-tab-scroll-kept.spec.ts:147` — a group room scrolled up keeps its place across tabs and split layouts
- `e2e/standalone/permission-allow-deny.spec.ts:41` — a permission card is answered with 허용 and 거부, never with keys

### `@area:terminal` (2 tests)

- `e2e/standalone/terminal-stepup-tap.spec.ts:26` — the terminal Face ID tap opens the passkey sheet at once and shows its refusal
- `e2e/standalone/terminal-view-agent.spec.ts:46` — the conversation opens the agent's own live terminal; closing the tab leaves it running

### `@area:jobs` (1 tests)

- `e2e/standalone/jobs-run-stop.spec.ts:15` — a job an agent started shows its progress and log, and stops when asked

### `@area:devroom` (1 tests)

- `e2e/standalone/devroom-worktree-merge.spec.ts:17` — a Worker worktree waiting for review is read and merged in the dev room

### `@area:files` (1 tests)

- `e2e/standalone/files-browse-preview-edit.spec.ts:17` — browse a project, preview, download, edit and save a file

### `@area:settings` (1 tests)

- `e2e/standalone/settings-style-language.spec.ts:56` — the screen style and the language stick across a reload and the messenger works in them

### `@area:access` (2 tests)

- `e2e/standalone/first-run-onboarding.spec.ts:28` — a new PC asks how to connect and, once, how new agents ask for permission
- `e2e/standalone/login-and-device-add.spec.ts:28` — the host link logs in, a code adds a device, sign-out puts it back out

### `@area:mobile` (1 tests)

- `e2e/standalone/phone-dock-pages.spec.ts:88` — the phone Dock shows one page at a time, keeps the conversation, answers a permission and Back stays in the app

<!-- END:E2E-INVENTORY -->

## Coverage philosophy

We do not measure e2e via code coverage (too noisy, doesn't map to user-observable scenarios). Coverage is tracked by:

1. **The inventory section above** — every test in the suite with its area tag and file:line.
2. **The "What's NOT covered" gap list** — deliberately maintained; closing a gap removes the corresponding row.
3. **Allure dashboard** — `epic` / `feature` / `story` labels group tests by area without needing this file. Run `npm run test:report` after a suite run, then open `allure-report/allure/index.html` → Behaviors view.
