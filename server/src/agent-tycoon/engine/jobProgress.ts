/**
 * Job progress (T-0019): the tail of a job's log, and the tqdm bar in it.
 */
import * as fs from 'fs';

import type { JobProgress } from '../../../../core/src/messages.js';

const LOG_TAIL_BYTES = 8 * 1024;

/** Last 8 KB of a log file, or '' when unreadable. */
export function readLogTail(file: string, bytes = LOG_TAIL_BYTES): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Progress from the tail of a job log: the last non-empty `\r`/`\n` segment,
 * parsed as a tqdm bar `label: 45%|███▌ | 450/1000 [01:23<01:41, 5.4it/s]`.
 */
export function parseTqdm(logTail: string): JobProgress | null {
  const seg = logTail
    .split(/[\r\n]/)
    .reverse()
    .find((s) => s.trim());
  if (!seg) return null;
  const m =
    /(?:^|\s)(?:([^|]*?):\s*)?(\d{1,3})%\|[^|]*\|\s*\d+(?:\.\d+)?[kMG]?\/\d+(?:\.\d+)?[kMG]?\s*\[[^<\]]*<([^,\]]*)(?:,\s*([^\]]*))?\]/.exec(
      seg,
    );
  if (!m) return null;
  return {
    label: m[1]?.trim() || null,
    pct: Number(m[2]),
    rate: m[4]?.trim() || null,
    eta: m[3]?.trim() || null,
  };
}
