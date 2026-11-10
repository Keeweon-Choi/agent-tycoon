/**
 * T-74: what broke in the page goes to the daemon (`webviewError`), so a blank screen leaves its cause in the
 * daemon log: an error boundary's catch (RegionBoundary.tsx), a `window` error and an unhandled rejection.
 * Capped here at a token boundary (the daemon cleans, masks, caps and rate-limits again) and at most ERROR_REPORT_BURST per window.
 */
import {
  WEBVIEW_ERROR_MESSAGE_MAX,
  WEBVIEW_ERROR_REGION_MAX,
  WEBVIEW_ERROR_STACK_LINES,
  WEBVIEW_ERROR_STACK_MAX,
} from '../../../core/src/constants.js';
import type { WebviewError, WebviewErrorSource } from '../../../core/src/messages.js';
import { ERROR_REPORT_BURST, ERROR_REPORT_WINDOW_MS } from '../constants.js';

/**
 * `s` cut to `max` characters at a boundary, so a token the cap runs through is dropped whole instead of left
 * as a prefix the daemon's masker no longer recognises (the page has no masker of its own: it cannot mask first).
 * Like the daemon's maskLine: the last whitespace, else the last character no token has, else nothing.
 */
export function cutAtBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  let cut = head.search(/\s\S*$/);
  if (cut <= 0) cut = head.search(/[^\w\-.+/=][\w\-.+/=]*$/);
  return s.slice(0, Math.max(cut, 0));
}

const top = (s: string | undefined | null): string | undefined => {
  const kept = s
    ?.split('\n')
    .filter((l) => l.trim())
    .slice(0, WEBVIEW_ERROR_STACK_LINES)
    .join('\n');
  return (kept && cutAtBoundary(kept, WEBVIEW_ERROR_STACK_MAX)) || undefined;
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return typeof error === 'string' ? error : (JSON.stringify(error) ?? String(error));
  } catch {
    return String(error);
  }
};

/** The capped report of `error`. */
export function errorReport(
  source: WebviewErrorSource,
  error: unknown,
  region?: string,
  componentStack?: string | null,
): WebviewError {
  const stack = top(error instanceof Error ? error.stack : undefined);
  const components = top(componentStack);
  return {
    type: 'webviewError',
    source,
    message: cutAtBoundary(describeError(error), WEBVIEW_ERROR_MESSAGE_MAX) || '?',
    ...(region && { region: region.slice(0, WEBVIEW_ERROR_REGION_MAX) }),
    ...(stack && { stack }),
    ...(components && { componentStack: components }),
  };
}

/** True while fewer than `burst` reports went out in the current window. */
export function makeLimiter(
  burst: number,
  windowMs: number,
  now: () => number = Date.now,
): () => boolean {
  let start = -Infinity;
  let count = 0;
  return () => {
    const at = now();
    if (at - start >= windowMs) {
      start = at;
      count = 0;
    }
    return ++count <= burst;
  };
}

// ponytail: one budget for boundary, error and rejection together; a throwing timer can use it up before a later
// boundary catch is sent. Upgrade: a limiter per `source` if that is ever seen in a log.
const allowed = makeLimiter(ERROR_REPORT_BURST, ERROR_REPORT_WINDOW_MS);

/** Send a report (queued by the transport until the socket is open). Never throws. */
export function reportError(
  source: WebviewErrorSource,
  error: unknown,
  region?: string,
  componentStack?: string | null,
): void {
  try {
    if (!allowed()) return;
    const report = errorReport(source, error, region, componentStack);
    // Loaded lazily: this module stays importable without a socket (tests, the boundary's first render).
    void import('../transport/index.js')
      .then(({ transport }) => transport.send(report))
      .catch(() => undefined);
  } catch {
    // Reporting must never be what breaks the page.
  }
}

/** The browser's own benign loop notice: not an error of ours. */
const BENIGN = /^ResizeObserver loop/;

export function installErrorReports(): void {
  window.addEventListener('error', (e) => {
    if (!BENIGN.test(e.message ?? '')) reportError('error', e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => reportError('rejection', e.reason));
}
