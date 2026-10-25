# Agent status tracking and context usage

> Read before touching transcript parsing, file watching, hook-vs-heuristic detection, permission or idle timers, or the context gauge.

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = workspace path with `:`/`\`/`/` → `-`.

**JSONL record types**: `assistant` (tool_use or thinking), `user` (tool_result or text prompt), `system` with `subtype: "turn_duration"` (reliable turn-end signal), `progress` with `data.type`: `agent_progress` (sub-agent tool_use/tool_result, non-exempt tools trigger permission timers), `bash_progress` (Bash output — restarts permission timer), `mcp_progress` (MCP tool — same timer restart). Also observed but not tracked: `file-history-snapshot`, `queue-operation`.

**File watching**: 500 ms polling with partial-line buffering for mid-write reads. Tool-done messages delayed 300 ms to prevent React batching from hiding brief active states.

## Dual-mode detection

| Mode                     | Source                                                 | Detection                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hooks** (preferred)    | Claude Code Hooks API → HTTP POST → `HookEventHandler` | Instant, reliable. Installed events are `CLAUDE_HOOK_EVENTS`. `UserPromptSubmit`/`TaskCreated` are deliberately NOT installed — they normalize to null, so installing them only forwarded prompt text to be dropped; `normalizeHookEvent` still tolerates them for stale installs |
| **Heuristic** (fallback) | Polling JSONL files                                    | Per-agent 500 ms JSONL polling for /clear detection; 1 s main scanner for terminal adoption; 3 s external scanner; 30 s stale check. Content-based /clear detection (`/clear</command-name>` in first 8 KB)                                                                       |

The `hookDelivered` flag (per agent) and `hooksEnabled` (global) gate timer logic. JSONL polling always runs in both modes for tool content (status text, animations); only permission (7 s) and text-idle (5 s) timers are suppressed by `hookDelivered`.

## Sub-agent permission detection (heuristic)

When a sub-agent runs a non-exempt tool, `startPermissionTimer` fires on the parent agent. If `PERMISSION_TIMER_DELAY_MS` (7 s) elapses with no data, permission bubbles appear on both parent and sub-agent characters via `agentToolPermission` + `subagentToolPermission` broadcasts.

`activeSubagentToolNames: Map<parentToolId, Map<subToolId, toolName>>` tracks which sub-tools are active for the exempt check. Cleared when data resumes, Task completes, or `turn_duration` arrives.

**Timing budget for tests**: the test waits for the bubble AFTER waiting for the "Subtask:" overlay. But the Subtask overlay appears when the parent's **Task tool_use** is parsed (scenario time T), while the timer only starts when the **sub-tool tool_use** in the progress record is parsed (~1 s later). Plus 7 s timer + 300 ms IPC/render slop = a wait timeout less than ~10 s is unsafe.

## Permission waits of engine sessions (PERM-PROMPT)

Claude Code asks some permissions even in bypass mode (a background sub-agent's "Dangerous rm ..." check), and a bypass session gets no heuristic permission timer. For engine-run background sessions the precise signal is `claude agents --json`: the row says `waitingFor: "permission prompt"` (`state: blocked`). `server/src/cld/permissionWait.ts` runs that check only on a cheap trigger: a heuristic `agentToolPermission` / `subagentToolPermission`, an engine lead's (or its sub-agent's) tool call open `PERMISSION_WAIT_SUSPECT_MS` (hooks mode too), or a message the messenger holds for it; at most one run per `PERMISSION_WAIT_CHECK_MS`, re-checked at that pace only while a wait is confirmed. Nothing waiting and nothing suspected: no timer but the per-open-call ones, no spawn. A confirmed wait is one episode: the office broadcasts the lead's `agentToolPermission` (with `asker`, the sub-agent's staff name id, when one asks, plus its `subagentToolPermission`), which carries the bubble, the 🔐 notice and Web Push; the messenger contact gets `permission`: while someone views that conversation, the dialog itself, read off the session's screen once per wait (one attach, read, detach; a whole dialog only, its rule visible), else the asker's newest open call from the lead's or sub-agent's transcript (an older open call may be done with its result unread); it ends with `agentToolPermissionClear` when the row no longer says permission. 허용/거부 on the card (`permissionAnswer`, privileged) go through `ChatManager.answerPermission`: on the attach's screen it presses `1` (allow, never a "don't ask again" option) or Esc only when a permission dialog is up right now and is exactly the screen card's dialog (or, for a transcript card, shows its description and command), then waits for it to go; anything else sends nothing and says so. `held()` also holds a session whose row waits for a permission prompt, so queued messages wait (and say why) until the dialog is answered.

## Context usage (server/src/contextUsage.ts)

Every agent's context gauge. Fed from `message.usage` on assistant records by `processTranscriptLine`, broadcast as `agentContextUsage` and rendered by `ToolOverlay`.

- **Snapshot, not a total.** Context = the newest turn's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`. Summing turns measures spend, not occupancy, and misses the cached tokens that ARE the context (`input_tokens` is single digits once caching kicks in). Falls on compaction and `/clear` for free.
- **All-zero usage means "no news"** — synthetic records (API errors, interrupts) report zeros and must not blank the gauge.
- **Sidechain rule**: a lead's sidechain records are its sub-agents' turns and must not move its gauge; a teammate's own transcript is sidechain top to bottom and would otherwise never report. Positional latch (`sawMainChainUsage`): once a file produces a main-chain turn, later sidechain records belong to someone else.
- **The window comes from the provider**, not from the runtime: `HookProvider.contextWindowForModel(model)` (Claude: 1M for the current line, 200k for Haiku and the older models, `undefined` for ids it can't place). Transcripts state usage but never the limit, and guessing 200k for a 1M model reads five times too full. `widenContextWindow` is the backstop for unrecognized models and unknown-larger windows — it only ever widens, since a context that doesn't fit disproves the assumption while a shrinking one proves nothing.
- **`seedContextUsage` runs once per agent in `startFileWatching`** — the single seam every watched agent passes through. Agents adopted or restored mid-session start at end-of-file, so without a tail read they'd have no gauge until their next turn.
- Sub-agents get no `agentContextUsage` of their own (no session of their own); the shadow store hands a watched sub-agent's context to `SubagentWatch.onContext` only, which cld-gui's staff roster (`server/src/cld/tempStaff.ts`) shows as the employee's fatigue.
