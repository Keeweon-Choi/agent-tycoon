# Contributing to Agent Tycoon

Thanks for your interest in contributing to Agent Tycoon! All contributions are welcome — features, bug fixes, documentation improvements, refactors, and more.

This project is licensed under the [MIT License](LICENSE), so your contributions will be too. No CLA or DCO is required.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (use the version in [`.nvmrc`](.nvmrc), currently v22)

### Setup

```bash
git clone https://github.com/Keeweon-Choi/agent-tycoon.git
cd agent-tycoon
npm install
npm run build
node dist/cli.js       # the daemon; open the URL it prints
```

### Maintainer release checklist

This fork publishes no VS Code extension and no npm package. Releases are daemon bundles built by [`.github/workflows/release-bundles.yml`](.github/workflows/release-bundles.yml) on a `v*` tag (or a manual run), signed behind the `release` environment. Before tagging: set the version in `agent-tycoon/release/version.json` to match the tag, run `npm ci`, `npm test`, and wait for the CI gate and a manual full CI run (3-OS e2e) to pass on `main`.

## Development Workflow

For development with live rebuilds, run:

```bash
npm run watch
```

This starts parallel watchers for the daemon bundle (esbuild) and TypeScript type-checking.

> **Note:** The webview (Vite) is not included in `watch` — after changing webview code, run `npm run build:webview` or the full `npm run build`.

## Running the Mocked Office

You can run the mocked office web app either from the CLI or from VS Code tasks.

### Option 1: CLI

From the repository root:

```bash
npm run dev -w webview-ui
```

Vite will print a local URL (typically `http://localhost:5173`) where the mocked app is available.

### Option 2: VS Code Run Task

1. Open the command palette and run **Tasks: Run Task**.
2. Select **Mocked Office Dev Server**.
3. Open the local URL shown in the task terminal output (typically `http://localhost:5173`).

### Project Structure

Agent Tycoon uses a layered codebase. `core/` depends on nothing; `server/` and `webview-ui/` depend only on `core/`.

| Directory                   | Description                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`                     | Protocol + interface definitions (AsyncAPI 3.0 contract, HookProvider, MessageTransport, StateAdapter). Zero runtime side effects.                                                                                                                    |
| `server/`                   | Lifecycle runtime: `AgentRuntime`, `AgentStateStore`, `SessionRouter`, `DismissalTracker`, Fastify HTTP/WS server, file watching, transcript parsing, hook installer, providers, Vitest test suite. Also ships the `node dist/cli.js` standalone CLI. |
| `webview-ui/`               | React 19 + Canvas UI. Transport abstraction (`WebSocketTransport`). Depends only on `core/`.                                                                                                                                 |
| `webview-ui/public/assets/` | Bundled sprites, furniture catalog, default layout, fonts.                                                                                                                                                                                            |
| `scripts/`                  | Build/CI tooling: `generate-messages.ts` (AsyncAPI → TS), `run-e2e.mjs`, `build-allure-report.mjs`, `assemble-vercel-output.mjs`, and the asset extraction pipeline.                                                                                  |
| `e2e/`                      | Playwright suite — fixtures, helpers, specs for `standalone/`.                                                                                                                                                                                        |
| `eslint-rules/`             | Custom rules (`no-inline-colors`, `pixel-shadow`, `pixel-font`) enforced project-wide.                                                                                                                                                                |

The repo uses **npm workspaces** (`server`, `webview-ui` declared in the root `package.json`). A single `npm install` at the root installs dependencies for all workspaces; no nested `cd ... && npm install` is needed.

## Manual Hook Testing

The repo includes [server/manual-hook-events.http](server/manual-hook-events.http) for manually driving the local hook server while the daemon is running.

It covers the basic external-session lifecycle:

- `SessionStart` to stage a pending external session
- `PreToolUse` to confirm it and mark the agent active
- `PermissionRequest`, `Notification`, and `Stop` to drive permission/waiting states
- `SessionEnd` to despawn the agent

Before using it, copy `port` and `token` from `~/.pixel-agents/server.json` into the file variables and set `cwd` to the folder the daemon was started from. If `cwd` is outside it, enable **Watch All Sessions** in the office settings first.

## Code Guidelines

### Constants

**No unused locals or parameters** (`noUnusedLocals` and `noUnusedParameters` are enabled). All magic numbers and strings are centralized — don't add inline constants to source files:

- **Backend timing/scanning constants:** `server/src/constants.ts`
- **Protocol-level constants:** `core/src/constants.ts`
- **Webview:** `webview-ui/src/constants.ts` (grid, animation, rendering, camera, zoom, editor, canvas overlay rgba strings)
- **CSS variables:** `webview-ui/src/index.css` `:root` block (`--pixel-*` properties for React inline styles and CSS)

### UI Styling

The project uses a pixel art aesthetic. All overlays should use:

- Sharp corners (`border-radius: 0`)
- Solid backgrounds and `2px solid` borders
- Hard offset shadows (`2px 2px 0px`, no blur) — use `var(--pixel-shadow)`
- The FS Pixel Sans font (loaded in `index.css`)

These conventions are enforced by custom ESLint rules (`eslint-rules/agent-tycoon-rules.mjs`):

| Rule               | Scope            | What it checks                                              |
| ------------------ | ---------------- | ----------------------------------------------------------- |
| `no-inline-colors` | Server + Webview | No hex/rgb/rgba/hsl/hsla literals outside `constants.ts`    |
| `pixel-shadow`     | Webview only     | Box shadows must use `var(--pixel-shadow)` or `2px 2px 0px` |
| `pixel-font`       | Webview only     | Font family must reference FS Pixel Sans                    |

These rules are set to `error` and will block your PR if violated.

## Unit & Integration Tests

```bash
# Run all tests (webview + server)
npm test

# Run only server tests (Vitest)
npm run test:server

# Run only webview tests
npm run test:webview
```

Server tests cover `AgentStateStore` (typed mutations + events), `HookEventHandler` (routing, buffering, team gating), `SessionRouter` and `DismissalTracker`, `FileStateAdapter` (namespaced persistence), `teamUtils`, the Claude provider and its team extension, the hook installer, the HTTP server (lifecycle, auth, `/ws`, broadcast), and the hook script via a spawned-process integration test.

`claude-hook.test.ts` requires the bundled hook at `dist/hooks/claude-hook.js`, so build before running it (or use `npm test` which builds first).

## End-to-End Tests

The `e2e/` directory contains Playwright tests that start the standalone daemon in a temp HOME and drive it in a headless browser.

### Running e2e tests locally

```bash
# Build first (tests load the compiled output)
npm run build

# Runs the e2e tests
npm run e2e

# Step-by-step debug mode
npm run e2e:debug

# Keep and attach videos even for successful tests
npm run e2e -- --attach-videos-on-success

# Combine debugger + success-case videos
npm run e2e:debug -- --attach-videos-on-success
```

### Artifacts

All test artifacts are written to `test-results/e2e/`:

| Path                                   | Contents                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `test-results/e2e/videos/<test-name>/` | `.webm` screen recording for failed tests, or all tests with the debug flag |
| `playwright-report/e2e/`               | Playwright HTML report (`npx playwright show-report playwright-report/e2e`) |
| `test-results/e2e/*.png`               | Final screenshots saved on failure                                          |

By default, successful tests discard their videos after teardown. Pass `--attach-videos-on-success` when you need success-case recordings attached to the report for debugging.

### Mock claude

Tests never invoke the real `claude` CLI. A wrapper script (`e2e/fixtures/mock-claude` on POSIX, `mock-claude.cmd` on Windows) is copied into an isolated `mock-bin/` directory and prepended to the daemon's `PATH`. The wrapper delegates to `e2e/fixtures/mock-claude-runner.cjs`, which honors a scenario blob set by the test via the `MOCK_CLAUDE_SCENARIO` env var.

Tests build scenarios with the fluent `claudeScenario(...)` helper in `e2e/helpers/mock-claude.ts`:

```typescript
claudeScenario('my-scenario')
  .at(2_000)
  .appendJsonl(buildAssistantToolUseRecord('toolu-1', 'Read', { file_path: '/x' }))
  .at(3_000)
  .emitHook(preToolUseRead('sessionId', '/x'))
  .holdOpenFor(10_000)
  .build();
```

`appendJsonl` writes a record to `$HOME/.claude/projects/<project-hash>/<session-id>.jsonl` at the given offset. `emitHook` POSTs a hook event to the running server's `/api/hooks/:providerId`. `holdOpenFor` keeps the wrapper process alive (and the terminal "busy") for that many ms after the last action, then exits.

Each test runs with an isolated `HOME`, workspace directory, server and mock log file — no state leaks between runs or into your real home.

For the normative model behind this (the process-boundary principle, append-only transcript rule, assertion philosophy, and the one standalone-server exception), see [`e2e/README.md` → "Mocking model & rules"](e2e/README.md#mocking-model--rules).

### E2E test naming

Tests use behavioral sentences with `@area:<tag>` suffixes for grouping. Areas: `standalone`, `mobile`. Example:

```typescript
test('closeAgent despawns the character @area:standalone', ...);
```

The auto-generated test inventory in `e2e/README.md` groups tests by `@area:` tag. After adding or removing tests, run `npm run e2e:inventory` to regenerate — CI fails if it drifts.

## Submitting a Pull Request

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Verify everything passes locally:
   ```bash
   npm run lint                         # core + server + webview lint
   npm run check-types                  # TypeScript strict check across all packages
   npm run asyncapi:validate            # AsyncAPI spec validation
   npm run asyncapi:generate            # Regen core/src/messages.ts (must produce no git diff)
   npm run e2e:inventory                # Regen e2e/README.md (must produce no git diff)
   npm run build                        # esbuild (daemon + hooks + worker) + Vite (webview)
   npm test                             # Server vitest + webview vitest
   npm run e2e                          # Full Playwright suite; inventory lives in e2e/README.md
   ```
   CI runs these same checks automatically on every PR. The AsyncAPI and e2e inventory drift checks fail the build on any diff — always regen + commit the result.
4. Open a pull request against `main` with:
   - A **conventional commit PR title** (e.g. `feat: add zoom controls`, `fix: character freezing on terminal close`, `refactor: extract pathfinding module`). CI enforces this format — see [Conventional Commits](https://www.conventionalcommits.org/).
   - A clear description of what changed and why
   - How you tested the changes (steps to reproduce / verify)
   - **Screenshots or GIFs for any UI changes**

> **Note:** PRs are merged using **squash and merge** — all commits in your PR are combined into a single commit on `main`. Your PR title becomes the commit message, which is why the conventional commit format matters.

> **History:** commits before 2026-11-04 use free-form messages (many in Korean). Every commit from 2026-11-04 on follows Conventional Commits, so tools that read the format (changelogs, release notes) should start there. The old messages are kept as they are: rewriting them would change every commit hash.

## Reporting Bugs

[Open a bug report](https://github.com/Keeweon-Choi/agent-tycoon/issues/new?template=bug_report.yml) — the form will guide you through providing the details we need.

## Feature Requests

Have an idea? [Open a feature request](https://github.com/Keeweon-Choi/agent-tycoon/issues/new?template=feature_request.yml) — the form will guide you through describing the problem and your proposed solution.

## Security Issues

Please report security vulnerabilities privately — see [SECURITY.md](SECURITY.md) for details.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.
