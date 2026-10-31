# Key decisions

> Read before reversing or bypassing an architectural choice (layering, protocol, transport, providers, persistence, e2e policy).

## Key Decisions

- **Layered codebase** (core → server; core → webview-ui). The VS Code adapter was removed on 2026-11-01 (only the standalone daemon ships).
- **AsyncAPI 3.0 contract**, generated TS bindings, CI drift check. Single source of truth for the wire protocol.
- **AgentRuntime** shared lifecycle core, composed by both surfaces.
- **AgentStateStore** as single source of truth with typed mutations and typed events. No transport calls outside the broadcast layer.
- **Transport abstraction**: `MessageTransport` interface, `WebSocketTransport` (the VS Code `PostMessageTransport` is deleted). One branching point in the entire UI.
- **HookProvider** as the integration boundary, with optional file fallback. New CLIs are a single subdirectory under `server/src/providers/hook/<id>/`.
- **TeamProvider** as optional extension. Claude Agent Teams is the only implementation.
- **Per-adapter namespaced persistence**, in the office folder since 2026-11 (formerly `~/.pixel-agents/`, server-runtime.md). The (removed) VS Code surface and standalone never clobbered each other; the `vscode` key is read and no longer written.
- **Single `WebviewViewProvider`** (panel area, not editor area).
- **Inline esbuild problem matcher** (no extra extension needed).
- **`erasableSyntaxOnly`** in webview forbids `enum` — use `as const` objects.
- **Server always starts** regardless of hooks toggle. Only hook installation is gated by the setting.
- **E2E over webview unit tests** for OSS friction. Community PRs change webview internals constantly; unit tests would force contributors to update internals tests on top of feature work. E2E pins user-facing behavior, which is stable across internal refactors.
