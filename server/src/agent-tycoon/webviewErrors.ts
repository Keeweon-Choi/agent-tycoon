/**
 * T-74: the page's error reports (`webviewError`: a boundary's catch, a `window` error or an unhandled
 * rejection) go to the daemon log as `[Webview] ...`, so a blank screen leaves its cause behind. The page
 * caps them; here they are checked again (they come off the wire): controls out, masked (maskText), then
 * capped, and rate-limited per socket. A malformed report is dropped; nothing here throws.
 */
import {
  WEBVIEW_ERROR_MESSAGE_MAX,
  WEBVIEW_ERROR_REGION_MAX,
  WEBVIEW_ERROR_STACK_LINES,
  WEBVIEW_ERROR_STACK_MAX,
} from '../../../core/src/constants.js';
import { WEBVIEW_ERROR_BURST, WEBVIEW_ERROR_WINDOW_MS } from '../constants.js';
import { maskText } from './mask.js';

const SOURCES: ReadonlySet<unknown> = new Set(['boundary', 'error', 'rejection']);

/** C0 and C1 controls (but not `\n`, which stackOf splits on), DEL and the Unicode line separators. */
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
/** A field from the wire: controls out (`\r` and ESC could forge or clear a log line), secrets masked, then cut (a token is never left half-cut). */
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? maskText(v.replace(CONTROLS, ' ')).slice(0, max) : undefined;
/** A stack's top lines, each indented under the report (no line of it can pass for a log line of its own). */
const stackOf = (v: unknown): string | undefined =>
  text(v, WEBVIEW_ERROR_STACK_MAX)
    ?.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, WEBVIEW_ERROR_STACK_LINES)
    .map((l) => `    ${l}`)
    .join('\n');

/** The log lines for a report (each field cleaned and masked), or null when it is malformed. */
export function webviewErrorLine(msg: Record<string, unknown>): string | null {
  if (!SOURCES.has(msg.source)) return null;
  const message = text(msg.message, WEBVIEW_ERROR_MESSAGE_MAX)?.replace(/\s+/g, ' ');
  if (message === undefined) return null;
  const region = text(msg.region, WEBVIEW_ERROR_REGION_MAX)?.replace(/[^\w.:-]/g, '');
  const stack = stackOf(msg.stack);
  const components = stackOf(msg.componentStack);
  return [
    `[Webview] ${String(msg.source)}${region ? ` in ${region}` : ''}: ${message}`,
    ...(stack ? ['  stack:', stack] : []),
    ...(components ? ['  components:', components] : []),
  ].join('\n');
}

/** Per socket (its `send`, stable for the socket's life): WEBVIEW_ERROR_BURST reports per window, the rest counted. */
export class WebviewErrorLog {
  private readonly windows = new WeakMap<object, { start: number; count: number }>();

  constructor(
    private readonly log: (line: string) => void = (line) => console.error(line),
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the report was logged. */
  report(socket: object, msg: Record<string, unknown>): boolean {
    try {
      const line = webviewErrorLine(msg);
      if (line === null) return false;
      const at = this.now();
      let w = this.windows.get(socket);
      if (!w || at - w.start >= WEBVIEW_ERROR_WINDOW_MS) {
        // ponytail: the dropped count is told with the next report after its window, not on a timer.
        if (w && w.count > WEBVIEW_ERROR_BURST)
          this.log(
            `[Webview] ${w.count - WEBVIEW_ERROR_BURST} more report(s) from one page were dropped`,
          );
        w = { start: at, count: 0 };
        this.windows.set(socket, w);
      }
      if (++w.count > WEBVIEW_ERROR_BURST) return false;
      this.log(line);
      return true;
    } catch {
      return false; // a report never takes the daemon down
    }
  }
}

export const webviewErrors = new WebviewErrorLog();
