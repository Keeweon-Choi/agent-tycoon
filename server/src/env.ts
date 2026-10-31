/**
 * Read an `AGENT_TYCOON_<name>` environment variable, falling back to the
 * pre-rename `PIXEL_AGENTS_<name>`.
 * ponytail: the PIXEL_AGENTS_ fallback is for one release after the 2026-11 rename; drop it then.
 */
export function readEnv(name: string): string | undefined {
  return process.env[`AGENT_TYCOON_${name}`] ?? process.env[`PIXEL_AGENTS_${name}`];
}
