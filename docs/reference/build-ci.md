# Build, CI and code conventions

> Read before changing the build (esbuild bundles, watch mode), CI, TypeScript settings, the constants policy, error handling or log prefixes.

## Build & Dev

**npm workspaces monorepo** (private, never published) (`server`, `webview-ui`). A single `npm install` at the root installs deps for all workspaces; `cd webview-ui && npm install` is redundant.

```bash
npm install                # installs root + workspaces in one shot
npm run compile            # asyncapi:generate, check-types, lint, esbuild, vite
npm run build              # alias for compile
npm run package            # production build (esbuild --production)
npm test                   # webview + server vitest
npm run e2e                # Playwright
```

`esbuild.js` runs these bundles:

1. **Daemon** (`dist/cli.js`) from `server/src/cli.ts`. Externals pulled at install time (`fastify`, `@fastify/*`).
2. **Worker** (`dist/cld-worker.js`) and the login page (`dist/login/`).
3. **Hook scripts** (`dist/hooks/claude-hook.js`) from `server/src/providers/hook/claude/hooks/claude-hook.ts`. CJS, shebang.

`define: { 'process.env.AGENT_TYCOON_VERSION': JSON.stringify(version) }` stamps the package version into all bundles.

**Watch mode**:

```bash
npm run watch                       # parallel esbuild watch + tsc --noEmit watch
cd webview-ui && npm run dev        # Vite dev server (separate terminal)
```

The webview Vite dev server is **not** included in `npm run watch` — it has to be run separately.

## CI

Single workflow runs (in order): install, lint, `asyncapi:validate`, `asyncapi:generate` + drift check, `e2e:inventory` + drift check, `check-types`, `test:server`, `test:webview`, `e2e` (standalone specs, 3-OS x 3-shard matrix: Linux, macOS, Windows, manual runs and tags only), `package`, then a PR-only Vercel preview deploy of the combined Allure report (gated on secrets; gracefully skips on forks, non-blocking on failure). Pushes to `main` run the checks but never deploy to Vercel.

The drift checks are the central guarantees: `core/asyncapi.yaml` ↔ `core/src/messages.ts` stay in lockstep; `e2e/README.md` stays in sync with the spec list.

## Publishing a release

Releases live on the public repo `Keeweon-Choi/agent-tycoon` (the private repo has Actions off on purpose). Daemons and installers read `https://github.com/Keeweon-Choi/agent-tycoon/releases/latest/download`, which resolves only to a published (non-draft, non-prerelease) release, so `0.1.0-rc.N` versions are published as normal releases.

**CI never holds the release key.** The secret `AGENT_TYCOON_SIGNING_KEY` is no longer used by any workflow (it can be deleted from the repo). The matrix in `release-bundles.yml` signs its bundles with a throwaway key only to self-test them; the key lives on the owner's PC (`~/.config/cld-gui/release/agent-tycoon-release.{key,pub}`), and its public half is committed at `cld/release/agent-tycoon-release.pub`, which `stamp-installers.mjs` writes into `install.sh`/`install.ps1`.

1. Bump `cld/release/version.json` (never done by the script), merge to `main`, push.
2. Write the Korean release notes (a few lines, at most 4000 characters) to a file.
3. From the private main checkout: `node cld/release/publish.mjs --notes <file> --dry-run` first (export, gate, notes staged, sync into the public clone, `git status`/`diff --stat`, clone reset), then without `--dry-run`.

The script: checks a clean tree, `HEAD == origin/main`, the version not yet tagged on the public repo, and that the local key pair exists and its public half equals the committed one; exports and gates HEAD with `cld/release/release-notes.txt` in it; syncs the public clone (`.worktrees/public-agent-tycoon`, plain commit `release: v<version>`, no force-push); pushes the annotated tag `v<version>`; waits at most 75 minutes for `release-bundles.yml` (five bundles, stamped installers, notes, a DRAFT release). Then, locally: it downloads the draft, writes `SHA256SUMS` over the bundles and `release-notes.txt`, signs it with the local key, and verifies (`verifyRelease`): the key beside the sums equals the local and the committed key, all five bundles verify against the local key, the notes are signed, and both installers carry every bundle hash and the public key. Only then does it upload `SHA256SUMS`, `SHA256SUMS.sig` and `agent-tycoon-release.pub` (`--clobber`), re-checks the asset list and the uploaded bytes, runs `gh release edit --draft=false --prerelease=false --latest` and curls `releases/latest/download/SHA256SUMS`.

Before the tag is pushed the script also signs and verifies a probe with the local private key against the committed public key, so a wrong key pair stops it before a version is burned. After the tag, a failure leaves the tag and a draft that is never published by itself; the script prints the run URL and the next step. Fix the cause (re-run failed CI jobs with `gh run rerun <id> --failed`), then run `node cld/release/publish.mjs --resume v<version>`. Resume does only the last part (download the draft, sign locally, verify everything, upload, re-download and verify the whole draft, refuse unexpected assets, un-draft) and refuses if the tag's own `version.json` is another version or the release is already published. Do not publish a draft with `gh release edit` by hand: it would make an unsigned release `latest`. Tags and releases are never deleted automatically.

**Desktop installers** (`desktop-bundles.yml`) are started by hand after the release is published: `gh workflow run desktop-bundles.yml -R Keeweon-Choi/agent-tycoon -f tag=v<version>`. They carry that release's signed daemon files (downloaded with `gh release download`, compared with the committed key and verified; nothing is built or signed) and a last job uploads the installers to the release. The workflow has no `push` trigger.

## TypeScript Constraints

- **No `enum`** (`erasableSyntaxOnly` in webview) — use `as const` objects (`TileType`, `CharacterState`, `Direction`, `EditTool`).
- **`import type`** required for type-only imports (`verbatimModuleSyntax` in webview; convention in server).
- **`noUnusedLocals` / `noUnusedParameters`** — strict everywhere.
- **`.js` extensions** on all relative imports in server and core (Node16 module resolution).
- **Module Node16, target ES2022** in server/core. **`erasableSyntaxOnly`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`** in the webview.

## Constants Policy

All magic numbers and strings are centralized — never inline:

| Where                              | What lives there                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `server/src/constants.ts`          | All timing/scanning constants (`PERMISSION_TIMER_DELAY_MS`, `TEXT_IDLE_DELAY_MS`, scanner intervals)               |
| `core/src/constants.ts`            | Protocol-level constants (e.g., transport state names)                                                             |
| `webview-ui/src/constants.ts`      | Webview magic numbers (grid, animation, rendering, camera, zoom, editor, game logic) + canvas overlay rgba strings |
| `webview-ui/src/index.css` `:root` | CSS custom properties (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...) for React inline styles and CSS      |
| `webview-ui/src/office/types.ts`   | Re-exports grid constants from `constants.ts` for convenience                                                      |

## Error Handling

- **Try-catch with graceful degradation** — errors logged but never crash the daemon.
- **Malformed JSONL lines** silently ignored (catch block in `processTranscriptLine`).
- **Missing assets** logged with warning, operation continues with null/fallback.
- No centralized error reporting or telemetry.

## Logging

Use `console.log`/`error`/`warn` with prefixed context:

- Daemon: `[Agent Tycoon]`
- Asset loading: `[AssetLoader]`
- Webview: `[Webview]`
