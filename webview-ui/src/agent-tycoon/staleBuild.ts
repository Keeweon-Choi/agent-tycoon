interface ModuleScript {
  getAttribute(name: string): string | null;
}

interface BuildDocument {
  querySelector(selector: string): ModuleScript | null;
}

/** This page's normalized Vite entry module path. */
export function ownBuild(doc: BuildDocument): string | undefined {
  const src = doc.querySelector('script[type="module"]')?.getAttribute('src');
  return src?.replace(/^(?:\.\/|\/)+/, '') || undefined;
}

/** A server build matters only when the current page can identify itself too. */
export const isStale = (own: string | undefined, server: string | undefined): boolean =>
  own !== undefined && server !== undefined && own !== server;

function isEditableTextField(element: unknown): element is {
  tagName?: unknown;
  value?: unknown;
  isContentEditable?: unknown;
  textContent?: unknown;
} {
  if (!element || typeof element !== 'object') return false;
  const { isContentEditable, tagName } = element as {
    tagName?: unknown;
    isContentEditable?: unknown;
  };
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || isContentEditable === true;
}

/** A reload waits only for text actively being entered in the focused field. */
export function typingForStaleBuild(active: unknown): boolean {
  if (!isEditableTextField(active)) return false;
  const element = active;
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    return typeof element.value === 'string' && element.value.length > 0;
  }
  return element.isContentEditable === true && typeof element.textContent === 'string' && element.textContent.length > 0;
}

export type StaleBusyReason = 'typing' | 'terminal' | 'unsaved' | 'dialog' | 'upload';

/** DOM and application facts read by App before deciding whether a stale page is safe to reload. */
export interface StaleBuildBusyState {
  typing: boolean;
  terminal: boolean;
  unsaved: boolean;
  dialog: boolean;
  upload: boolean;
}

/** The first reason is shown in the banner; all reasons prevent an automatic reload. */
export function busyForStaleBuild(state: StaleBuildBusyState): StaleBusyReason | null {
  if (state.typing) return 'typing';
  if (state.terminal) return 'terminal';
  if (state.unsaved) return 'unsaved';
  if (state.dialog) return 'dialog';
  if (state.upload) return 'upload';
  return null;
}

const staleRecheckListeners = new Set<() => void>();

/** Ask a stale page to reconsider immediately after work is programmatically cleared. */
export function requestStaleRecheck(): void {
  staleRecheckListeners.forEach((listener) => listener());
}

/** Subscribe while a stale banner is present; returns the matching unsubscribe function. */
export function subscribeStaleRecheck(listener: () => void): () => void {
  staleRecheckListeners.add(listener);
  return () => staleRecheckListeners.delete(listener);
}

/** Whether an editing event can make a postponed stale-build reload safe. */
export function shouldRecheckStaleBuild(
  event: 'focusout' | 'blur' | 'input',
  target: unknown,
  active: unknown,
): boolean {
  if (!isEditableTextField(target)) return false;
  return event !== 'input' || (target === active && !typingForStaleBuild(target));
}

export interface ReloadDecisionInput {
  stale: boolean;
  visible: boolean;
  busy: StaleBusyReason | null;
  reloadedFor: string | undefined;
  server: string | undefined;
}

/** Choose a safe response to a server newer than the page currently running. */
export function reloadDecision({
  stale,
  visible,
  busy,
  reloadedFor,
  server,
}: ReloadDecisionInput): 'reload' | 'banner' | 'none' {
  if (!stale || !visible || !server) return 'none';
  if (busy || reloadedFor === server) return 'banner';
  return 'reload';
}

/** Translation key for the stale banner's most useful current explanation. */
export function staleBuildBannerMessage(
  reloadedFor: string | undefined,
  server: string | undefined,
  busy: StaleBusyReason | null,
):
  | 'build.stale.reloaded'
  | 'build.stale.busy.typing'
  | 'build.stale.busy.terminal'
  | 'build.stale.busy.unsaved'
  | 'build.stale.busy.dialog'
  | 'build.stale.busy.upload'
  | 'build.stale.message' {
  if (reloadedFor === server) return 'build.stale.reloaded';
  return busy ? `build.stale.busy.${busy}` : 'build.stale.message';
}
