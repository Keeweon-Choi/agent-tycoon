/**
 * How long and how large the engine's logs may get (U-42). The numbers live here
 * and nowhere else; `cld/bin/cld-gui-sizes.js` prints the same rules for
 * `cld-gui doctor` (logPrune.test.ts keeps the two in step).
 */

/** Logs of finished jobs and Codex tasks older than this are removed. */
export const LOG_KEEP_DAYS = 30;
/** A log folder (jobs/, codex/) over this loses its oldest finished logs until it is under. */
export const LOG_DIR_CAP_BYTES = 1024 ** 3;
/** events.jsonl moves to events.jsonl.1 (one previous file kept) once it passes this. */
export const EVENTS_ROTATE_BYTES = 5 * 1024 * 1024;
/** Pruning runs at daemon start and then this often. */
export const LOG_PRUNE_INTERVAL_MS = 86_400_000;
