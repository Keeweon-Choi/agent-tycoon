# Server runtime, /ws security and persistence

> Read before touching AgentRuntime, AgentStateStore, the HTTP/WebSocket gate (who may connect; there is no read-only client), hooks-preference persistence, the office folder (formerly ~/.pixel-agents) or state migration.

## Server Runtime

`AgentRuntime` (`server/src/agentRuntime.ts`) is the shared lifecycle core. `server/src/cli.ts` composes it with the `standalone` `StateAdapter` namespace, the WebSocket `MessageTransport` and the PTY `TerminalAdapter` (the VS Code surface that composed it differently was removed on 2026-11-01).

```typescript
export class AgentRuntime {
  constructor(opts: {
    store: AgentStateStore;
    providerRegistry: ProviderRegistry;
    layoutPersistence: LayoutPersistence;
    assetCache: AssetCache;
    config: Pick<AdapterSettings, 'hooksEnabled' | 'watchAllSessions'>;
    callbacks: RuntimeLifecycleCallbacks;
  });
  registerAgent / unregisterAgent / removeAgent / removeTeammate / removeTeammates
  restoreExternalAgents / handleHookEvent
  startProjectScan / startExternalScanning / startStaleCheck
  dispose();
}
```

Owns timer Maps (waiting, permission, text-idle, stale), scanners (project-dir 1 s, external 3 s, stale 30 s), `HookEventHandler`, `SessionRouter`, `DismissalTracker`. Scanners are skipped entirely while hooks are flowing (`hookDelivered` is set on every agent). `RuntimeLifecycleCallbacks` is the only seam between runtime and host.

## AgentStateStore

EventEmitter-backed container in `server/src/agentStateStore.ts`. Typed mutations, typed events (`agentAdded`, `agentRemoved`, `agentUpdated`, `broadcast`). The broadcast layer subscribes once at boot and translates `StoreEvents` into `ServerMessage` over the active transport. **No module under `server/` calls a transport method directly.**

## SessionRouter and DismissalTracker

Two extracted classes that replaced ad-hoc module state. `SessionRouter` owns `session_id → agent_id` mapping, pre-registration event buffering, and pending external sessions. `DismissalTracker` unifies four legacy globals (`dismissedJsonlFiles`, `clearDismissedFiles`, `seededMtimes`, `pendingClearFiles`) into one class with typed reasons.

## HTTP + WebSocket Server

Fastify v5 with `@fastify/cors`, `@fastify/websocket`, and (in standalone) `@fastify/static`:

| Method | Path                     | Purpose                                 |
| ------ | ------------------------ | --------------------------------------- |
| POST   | `/api/hooks/:providerId` | Bearer-authenticated hook event ingress |
| GET    | `/api/health`            | Liveness: `{ ok, version, port, pid }`  |
| GET    | `/ws`                    | Bidirectional protocol channel          |
| GET    | `/*` (standalone only)   | Webview SPA via `@fastify/static`       |

`/ws` and every HTTP route are gated the same way, because messages over the socket launch shells, grant durable machine-wide hook consent and rewrite persisted state.

1. **Who may connect.** Every route outside the public list (`standaloneRouteIsPublic` in `server/src/cld/authRoutes.ts`: login pages, health, icons, fonts) needs the host token as a Bearer header or a login session cookie (`standaloneRequestAuthorized`). The `/ws` handshake also needs an allowed Origin/Host (`isAllowedWebSocketOrigin` with `privilegedHostnames`; extra names come from `--allowed-host`), or the socket is closed (`standaloneWsRejection` in `httpServer.ts`). A browser carries its session cookie; server tokens never appear in browser URLs (`webview-ui/src/transport/index.ts`). **Never a network position**: peer address, `Host` and `Origin` all ride the channel a proxy speaks, so they can only take access away (the Host allowlist is anti-DNS-rebinding defence in depth), never grant it.
2. **What an accepted socket may do: everything.** Since 10-21 (`6e5a598d`) there is no read-only viewer: `httpServer.ts` sets `privileged = true` for every accepted socket. `readOnlyView` (`wsAuth.ts`) and `refuseReadOnly` (`clientMessageHandler.ts`) are upstream leftovers that never run, so do not build on them; mask a secret where its string is made, and every viewer gets it masked. A remote session (not this PC, not the host token) needs a fresh step-up for dangerous engine actions (S1, `SocketStepUp`). The host token persists in `<office folder>/standalone-token` (0600); `--rotate-token` replaces it, revoking every device at once.

The **hooks preference is persisted only after the install/uninstall settled and the on-disk result agrees** — writing it first strands the user when an uninstall fails: entries still firing, but a persisted hooks-off makes the next startup skip the consent/install path entirely.

Server discovery is written to `<office folder>/server.json` and `<office folder>/servers/<pid>-<port>.json` (port, pid, token, capabilities), 0600, removed on stop (self-only). A second server reuses a live registry entry of the same kind and access, or starts its own. For one release both are also written to `~/.pixel-agents/` (below).

## ClientMessageHandler

Single dispatch point for `ClientMessage`. Each variant calls into `AgentRuntime`, `AgentStateStore`, `LayoutPersistence`, or `FileStateAdapter`, or delegates to host-specific callbacks (`onLaunchAgent`, `onOpenSessionsFolder`, `onExportLayout`, `onImportLayout`, `onSetHooksEnabled`). Both surfaces wire the same handler.

## Engine agents in our PTY host (ADR-0018)

The cld engine (`server/src/cld/engine/engine.ts`) drives each agent through the provider its assignment names. Since TERM-P3 every new Claude agent is `claude-pty`: Claude run directly in our PTY host (`server/src/cld/ptyhost/`, `agents/claude/claudePty.ts`); `claude` (`claude --bg` + `claude attach`) is the emergency backup, kept as it is until P5 removes it. The tools and agents still see the CLI as `claude` (`registry.ts cliOf`).

- **Moving an agent**: `agty move-pty <name>`, the project card's 새 터미널 방식 switch, or the engine action `edit` with `provider: claude-pty` (one path, `Engine.moveToPty`). Off: only the provider changes. On: refused mid-turn or while held; then `claude stop`, `claude --resume <same id>` in the host, and success only once a host session with that id is idle (`PTY_MOVE_IDLE_MS`); anything short of that restores the record and restarts the old session, with the reason. Back to `claude` only while off.
- **Moving every agent** (owner only): `agty move-pty --all` / `--stop`, or the 모두 새 터미널로 옮기기 button in the 현황판 engine section (`engineMoveAll`, privileged; `engineState.moveAll` = `{done, total}` while it runs). `Engine.moveAll` queues the Claude-mode agents and moves them one at a time through `moveToPty`: off agents, Workers, Leads without Workers, then Leads with Workers (the orchestrators). A running agent is looked at every `PTY_MOVE_ALL_POLL_MS` and moved when idle; past `PTY_MOVE_ALL_WAIT_MS` (30 min) it is skipped with the reason and the queue goes on. One feed line per agent (`pty_move`: moved / skipped / rolled_back + reason), then a summary (`pty_move_all`). A second request while it runs is refused; stop ends it after the agent being moved. ponytail: in memory, so a daemon restart ends it; pressing again skips the agents already moved.
- **Permission prompts** of a PTY agent come from Claude Code's `PermissionRequest` hook, handed over in `--settings` (`claudePty.ts permissionHooks`; no settings file is written). The hook runs `cld-gui permission-hook`, which asks over the control socket with the session's `CLD_AGENT_TOKEN`; `Office.askPermission` shows the usual PERM-PROMPT card and the owner's 허용/거부 is the decision. No answer within `PTY_PERMISSION_WAIT_MS` (or no daemon): no decision, and Claude shows its own dialog in the agent's terminal. The screen-reading PERM-PROMPT path (`permissionWait.ts`, `claude agents --json`) runs only for remaining `--bg` agents.

## ServerAgentState (server/src/types.ts)

Per-agent runtime data: provider reference, session key, transcript-fallback fields (`jsonlFile`, `fileOffset`, `lineBuffer`), tool state Maps and Sets, team fields (`teamName`, `agentName`, `isTeamLead`, `leadAgentId`, `teamUsesTmux`), context usage (`contextTokens`, `maxContextTokens`, `sawMainChainUsage`), and the **`hookDelivered`** flag that suppresses heuristic timers when hooks are flowing.

## Persistence

```
<settings directory>/office/     officeDirectory(home): ~/.config/agent-tycoon/office (~/.config/cld-gui/office on a pre-rename install)
  config.json              { standalone, externalAssetDirectories, hooksConsent, hooksEnabled (both per-provider), directories }
  standalone-state.json    { agents, seats }
  layout.json              OfficeLayout
  standalone-token         server token (0600)
  server.json              { port, pid, token, ... } legacy single-target pointer
  servers/<pid>-<port>.json  registry the hook script fans out to
  hooks/claude-hook.js     Bundled hook script (CJS, shebang), when hooks are installed
```

**The move out of `~/.pixel-agents` (2026-11).** That folder is the upstream project's, and its VS Code extension may share it (`vscode-state.json`, its own `server.json`/`servers/` entries and hook). At every start, before anything reads, `migrateOfficeFolder` (`server/src/officeFolder.ts`) copies OUR four files (`config.json`, `standalone-state.json`, `layout.json`, `standalone-token`) into the office folder: per file copy to `<name>.migrating`, compare sha256 with the original, rename (the switch), then count that every original has its twin; a file already in the office folder is never overwritten, so a re-run changes nothing and a run cut short is finished by the next one. Nothing in `~/.pixel-agents` is moved, rewritten or deleted. For one release (`ponytail:` in officeFolder.ts and server.ts):
- every reader falls back to `~/.pixel-agents/<file>` when the office folder lacks it (`officeFileToRead`); writes always go to the office folder;
- the server writes `server.json` and its `servers/` entry to `~/.pixel-agents` too (and removes both on stop), because a Claude session started before the upgrade keeps running the settings.json entry it started with, `~/.pixel-agents/hooks/claude-hook.js`, and that old script only looks there. The new hook script reads the office folder;
- an old `~/.pixel-agents/hooks/claude-hook.js` settings entry counts as ours only while no Pixel Agents extension is installed in the home (hooks-consent.md).
The release after drops the fallback and the dual write, and then deletes only those four files (plus our own `server.json`/`servers/` entries) from `~/.pixel-agents`. Browser `localStorage` is per device and origin; the move does not change the origin, so nothing there moves.

`FileStateAdapter({ namespace })` backs both runtimes. Per-namespace settings: `soundEnabled`, `lastSeenVersion`, `alwaysShowLabels`, `watchAllSessions`, `hooksInfoShown` (the hooks preference is per-provider and machine-global, at the config top level). The `vscode` namespace (config key and `vscode-state.json`) belonged to the removed VS Code extension: a config that still has the key is read, and the next write drops it.

Layout writes are atomic via tmp + rename. Cross-window watching is hybrid (`fs.watch` + 2 s polling). `markOwnWrite()` prevents the watcher from re-reading our own write.
