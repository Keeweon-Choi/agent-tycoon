# Agent Tycoon e2e tests

Playwright end-to-end tests for the standalone daemon (`node dist/cli.js`) in a headless browser. This README is the single source of truth for what's e2e-tested, what's not, and how to run the suite.

## What this suite covers

Behavioral overview by area. Each area corresponds to a `test.describe` block in the spec files, an `@area:` tag on each test title, and an Allure `epic` label.

### Standalone server (`@area:standalone`)

The daemon path (`node dist/cli.js`): hook-driven lifecycle propagates from the local server into the browser SPA via the single `/ws` WebSocket endpoint.

### Mobile shell (`@area:mobile`)

The standalone page on a phone-sized touch viewport (390×844, `hasTouch`): the mobile shell renders instead of the desktop toolbar; the + card launches an agent into the server PTY and slides to its terminal; the >_ / Office toggle, the two-step card tap (focus, then open), and the edge swipe in both directions switch pages; tapping a URL in the terminal opens it. Taps use Playwright's real touch input; the edge swipe dispatches the TouchEvent sequence of a finger drag, since `touchscreen` has no multi-step drag. The gesture state machines (edge swipe, terminal touch, card order) are unit-tested on the webview Node runner.

## What's NOT covered (gaps + deferred)

Scenarios that exist as product behavior but are not in the automated suite. PRs that close a gap should remove the corresponding row.

| Scenario                                                                           | Why not automated                                                                                                    | Tracked        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------- |
| External asset directory add/remove via Settings                                   | Needs bundled test asset packs                                                                                       | none           |
| Bypass-permissions startup flag                                                    | Security-sensitive; manual review path                                                                               | none           |
| Mobile key bar (Esc, Tab, arrow slide, paste) above the software keyboard          | Only shows while the iOS/Android keyboard shrinks the visual viewport; headless browsers have no software keyboard   | manual (phone) |
| Terminal long-press selection, copy pill, handles, flick scroll; canvas pinch zoom | Multi-touch timing gestures; the decision logic is unit-tested (`touchGesture`, `edgeSwipe`), the device feel is not | manual (phone) |
| Mobile card bar long-press reorder                                                 | Long-press + drag on a horizontal scroller; ordering rules unit-tested (`cardBar.test.ts`)                           | manual (phone) |

The VS Code extension and its e2e suite (spawn paths, lifecycle regressions, teams routing, the hooks-off matrix, layout editor) were removed on 2026-11-01; those behaviours are covered here only where the standalone specs reach them.

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

npm run e2e -- --grep "@area:standalone"     # filter by area tag
npm run e2e -- --headed                      # watch chromium

npm run e2e:inventory                        # regenerate the inventory section below
npm run test:report                          # build the Allure dashboard from latest run
npm run test:report:open                     # serve + open the Allure dashboard in a browser
```

## Mocking model & rules

E2E tests drive the daemon through a Claude-like **process boundary**, not by poking internals. The mocked `claude` (`e2e/fixtures/mock-claude` → `mock-claude-runner.cjs`) behaves like the real CLI for the parts the daemon observes: it spawns as a process (in the daemon's PTY terminal), creates its own append-only JSONL transcripts, and executes the installed hook script under `<office folder>/hooks` (or an older install's `~/.pixel-agents/hooks`) — the same path the real CLI uses. The builder API itself (`claudeScenario(...)`, `.at()`, `.appendJsonl()`, `.emitHook()`, `.holdOpenFor()`) is documented in CONTRIBUTING.md → "Mock claude".

Rules for a correct test:

- **Drive behavior through a scenario, not by hand.** Define timed actions with the `claudeScenario(...)` builder and let the mock perform them. Don't hand-write transcript files or hand-fire hooks inside a terminal-driven test body.
- **Transcripts are append-only.** Existing JSONL lines are never mutated in place; new records appear later in the stream. Scenarios model this with timed `.appendJsonl(...)` steps.
- **Assert only on Playwright-visible outcomes** — agent overlays, character state, sound hooks — never on the mock's internals. The mock never decides pass/fail.
- **Direct hook POSTs are the one exception.** `standalone/hooks.spec.ts` POSTs to the server's hook endpoint directly via `sendHookEvent` to test the hook path itself; every terminal-driven test must use the scenario builder.

## What to read before adding a test

- `CLAUDE.md` — architecture and message protocol
- `e2e/fixtures/standalone.ts` — fixture lifecycle (temp HOME, own server)
- `e2e/helpers/` — every helper, especially `hooks.ts`, `mock-claude.ts`, `office.ts`, `webview.ts`

When you add a new test:

- Pick a `test.describe` block that matches an existing `@area:` tag, OR add a new area to the "What this suite covers" section above and pick a tag.
- Add `@area:<tag>` to the test title.
- Add Allure `epic` / `feature` / `story` labels matching the area.
- Run `npm run e2e:inventory` and commit the regenerated section.

When you remove a test:

- Run `npm run e2e:inventory` so the inventory drops it.
- If the scenario it tested is now manual or deferred, add a row to "What's NOT covered".

## Narration

Shared helpers narrate universal moments (spawning/closing an agent) via the module-level `narrate` in `helpers/test-narration.ts`, written to `<tmpHome>/.claude-mock/test-narration.log`. Standalone recordings are raw browser artifacts, so the log is a debugging aid only.

**Cosmetic-only contract (never violate):** the daemon never reads terminal output — its inputs are JSONL transcripts and hook POSTs — so narration cannot change what a test exercises. Narration must **never carry an assertion, gate logic, or affect timing**. Never call the narrator from inside a browser-context callback (`page.waitForFunction`/`evaluate`/`.poll`) — it is Node-side only.

## Test inventory

This section is auto-generated. Do not edit between the markers; CI fails on drift.

<!-- BEGIN:E2E-INVENTORY -->

35 tests total. Generated by `scripts/generate-e2e-inventory.mjs`. Re-run after adding or removing tests.

### `@area:standalone` (27 tests)

- `e2e/standalone/directory-modal.spec.ts:43` — Enter on Cancel cancels and Enter on an Area toggles it; neither saves (Standalone / Directory modal keyboard)
- `e2e/standalone/directory-modal.spec.ts:77` — Enter in the path field saves (Standalone / Directory modal keyboard)
- `e2e/standalone/directory-modal.spec.ts:98` — an unnamed Directory keeps its Area under the name the host gave it (Standalone / Directory Area mapping)
- `e2e/standalone/hooks.spec.ts:21` — propagates hook-driven lifecycle into the browser UI (Standalone / hooks)
- `e2e/standalone/hooks.spec.ts:138` — the tokened page shows the Intro and Install writes the hooks (Standalone / hooks consent)
- `e2e/standalone/hooks.spec.ts:165` — an untokened spectator page never sees the consent dialog (Standalone / hooks consent)
- `e2e/standalone/hooks.spec.ts:187` — an untokened spectator page shows no toolbar, only a View only label (Standalone / hooks consent)
- `e2e/standalone/hooks.spec.ts:214` — the hooks checkbox reflects install state and its click is the consent grant (Standalone / hooks consent)
- `e2e/standalone/launch-drawer.spec.ts:45` — the server start directory is a badged host row that launches an agent labeled with it (Standalone / launch drawer)
- `e2e/standalone/launch-drawer.spec.ts:97` — a Directory added in the modal launches an agent and is still there after a reload (Standalone / user-defined Directories)
- `e2e/standalone/launch-drawer.spec.ts:152` — deleting a Directory drops its row and leaves its running agent alone (Standalone / user-defined Directories)
- `e2e/standalone/launch-drawer.spec.ts:204` — an invalid path is refused inline and nothing is persisted (Standalone / Directory validation)
- `e2e/standalone/launch-drawer.spec.ts:253` — a past session offers its working directory as a tap that fills the path (Standalone / Directory suggestions)
- `e2e/standalone/launch-drawer.spec.ts:309` — the start directory is hidden by default and Show Start Directory lists it (Standalone / host Directory setting)
- `e2e/standalone/launch-drawer.spec.ts:341` — the skip-permissions setting lands on disk and survives a reload (Standalone / permission posture)
- `e2e/standalone/launch-drawer.spec.ts:377` — turning skip-permissions on in one office shows it on in another already open (Standalone / permission posture)
- `e2e/standalone/launch-drawer.spec.ts:432` — the drawer fits the viewport, its rows scroll, and + Directory stays reachable (Standalone / long Directory lists)
- `e2e/standalone/terminal.spec.ts:26` — browser-launched agent gets a PTY terminal, hooks route to its character, close cleans up (Standalone / terminal)
- `e2e/standalone/terminal.spec.ts:82` — every tab takes mouse input, and a narrow window keeps the cards and close reachable (Standalone / terminal)
- `e2e/standalone/terminal.spec.ts:117` — copies are verbatim; Alt+C copies the selection re-flowed as text (Standalone / terminal)
- `e2e/standalone/terminal.spec.ts:214` — --no-terminal keeps the office watch-only: launch disabled, hook-driven agents still render (Standalone / terminal disabled)
- `e2e/standalone/ui.spec.ts:27` — closeAgent despawns the character (Standalone / UI)
- `e2e/standalone/ui.spec.ts:61` — Debug View renders JSONL diagnostics in standalone (Standalone / UI)
- `e2e/standalone/ui.spec.ts:95` — adding an external asset directory triggers a live asset reload (Standalone / UI)
- `e2e/standalone/ui.spec.ts:125` — browser Export Layout downloads the layout file (Standalone / UI)
- `e2e/standalone/ui.spec.ts:140` — browser Import Layout applies the chosen file (Standalone / UI)
- `e2e/standalone/ui.spec.ts:175` — ConnectionIndicator appears when the WebSocket connection drops (Standalone / UI)

### `@area:mobile` (8 tests)

- `e2e/standalone/launch-drawer.spec.ts:463` — the phone drawer fits above the card bar and keeps + Directory reachable (Standalone / long Directory lists on a phone)
- `e2e/standalone/mobile.spec.ts:164` — phone shell: + card launches and slides to the terminal; toggle, card taps and edge swipe navigate (Standalone / mobile shell)
- `e2e/standalone/mobile.spec.ts:208` — tapping a URL in the terminal opens it; a sideways drag from it does not (Standalone / mobile shell)
- `e2e/standalone/mobile.spec.ts:243` — the key bar shows while the software keyboard is up, under both viewport resize policies (Standalone / mobile shell)
- `e2e/standalone/mobile.spec.ts:272` — copy and paste work on a plain-http origin (no Clipboard API) (Standalone / mobile shell)
- `e2e/standalone/mobile.spec.ts:344` — the hooks info modal fits the phone screen (Standalone / mobile shell)
- `e2e/standalone/mobile.spec.ts:369` — a two-finger pan stops the camera following a character; a pure pinch does not (Standalone / mobile shell)
- `e2e/standalone/mobile.spec.ts:409` — the trackpad key follows the finger that pressed it, not touches[0] (Standalone / mobile shell)

<!-- END:E2E-INVENTORY -->

## Coverage philosophy

We do not measure e2e via code coverage (too noisy, doesn't map to user-observable scenarios). Coverage is tracked by:

1. **The inventory section above** — every test in the suite with its area tag and file:line.
2. **The "What's NOT covered" gap list** — deliberately maintained; closing a gap removes the corresponding row.
3. **Allure dashboard** — `epic` / `feature` / `story` labels group tests by area without needing this file. Run `npm run test:report` after a suite run, then open `allure-report/allure/index.html` → Behaviors view.
