/**
 * True only under the Playwright e2e harness, which sets `__AGENT_TYCOON_E2E`
 * via `addInitScript` before any app code runs (so it's set in every frame).
 * Gates test-only diagnostics (window.__agentTycoonTestHooks message/sound logs,
 * the addAgent wrapper) so they never run, and never grow unbounded, in a real
 * user's session.
 */
export const isE2E: boolean =
  typeof window !== 'undefined' &&
  (window as unknown as { __AGENT_TYCOON_E2E?: boolean }).__AGENT_TYCOON_E2E === true;
