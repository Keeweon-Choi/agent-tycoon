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
