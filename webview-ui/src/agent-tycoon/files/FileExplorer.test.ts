/**
 * The 파일 window's explorer with a file open for editing: what may take the unsaved edit away. The
 * webview has no DOM test library, so `react`'s hooks run on a minimal stand-in (as in
 * messenger/draftHooks.test.ts): state and refs by call order, effects after each render. One render
 * calls FileExplorer and then the Explorer element it returns, and the test presses buttons by calling
 * their onClick from the element tree.
 */
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  effects: [] as Array<() => void>,
  cleanups: new Map<number, () => void>(),
}));
vi.mock('react', async (real) => ({
  ...(await real<typeof import('react')>()),
  useState: (init: unknown) => {
    const k = hooks.at++;
    if (!(k in hooks.slots)) hooks.slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      hooks.slots[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(hooks.slots[k]) : v;
    };
    return [hooks.slots[k], set];
  },
  useRef: (init: unknown) => {
    const k = hooks.at++;
    if (!(k in hooks.slots)) hooks.slots[k] = { current: init };
    return hooks.slots[k];
  },
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const k = hooks.at++;
    const prev = hooks.slots[k] as { deps: unknown[]; value: unknown } | undefined;
    if (prev && deps.every((d, j) => Object.is(d, prev.deps[j]))) return prev.value;
    hooks.slots[k] = { deps, value: fn() };
    return (hooks.slots[k] as { value: unknown }).value;
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const k = hooks.at++;
    const prev = hooks.slots[k] as { deps?: unknown[] } | undefined;
    if (prev?.deps && deps?.every((d, j) => Object.is(d, prev.deps![j]))) return;
    hooks.slots[k] = { deps };
    hooks.effects.push(() => {
      hooks.cleanups.get(k)?.();
      const cleanup = fn();
      if (cleanup) hooks.cleanups.set(k, cleanup);
      else hooks.cleanups.delete(k);
    });
  },
}));
const fake = vi.hoisted(() => ({
  mobile: false,
  dirty: true,
  /** The root each render handed the edit session. */
  roots: [] as unknown[],
  attached: 0,
}));
vi.mock('../../transport/index.js', () => ({ transport: { send: () => undefined, onStateChange: () => () => undefined } }));
vi.mock('../../hooks/useIsMobile.js', () => ({ useIsMobile: () => fake.mobile }));
vi.mock('../repo/useRepoView.js', () => ({ useRepoView: () => undefined }));
vi.mock('../zoomStore.js', () => ({ useTextZoom: () => ({ zoom: 1 }), useZoomHost: () => undefined }));
vi.mock('../engineStore.js', () => ({
  useEngineStore: () => ({ state: { projects: [{ name: 'alpha', folder: '/w/alpha' }, { name: 'beta', folder: '/w/beta' }] } }),
}));
vi.mock('../officeStore.js', () => ({
  useAgtyStore: () => ({ events: [], officeSnapshot: null, officeReadOnly: false, hostInfo: null }),
}));
vi.mock('../messenger/messengerStore.js', () => ({
  useMessenger: () => ({ contacts: [{ name: 'alpha', agentId: 1, canSend: true }] }),
  messengerGetSnapshot: () => ({ attachments: {} }),
  setAttachments: () => void fake.attached++,
  openMessenger: () => undefined,
}));
vi.mock('./editSession.js', () => ({
  useEditSession: (root: unknown, path: string | null) => {
    fake.roots.push(root);
    const dirty = path !== null && fake.dirty;
    return { doc: '', docKey: 1, loading: false, error: '', dirty, saving: false, changed: false, marks: [], saved: false, edit: () => undefined, save: async () => undefined, saveAnyway: async () => undefined, reload: () => undefined };
  },
}));
vi.mock('./filesStore.js', async (real) => ({
  ...(await real<typeof import('./filesStore.js')>()),
  recentProjectFiles: async () => ({ entries: [], partial: false }),
  ignoredRootFiles: async () => [],
  fileSettings: async () => ({ allowSensitive: false }),
  previewRootFile: async (_root: unknown, path: string) => ({ kind: 'text', path, size: 4, truncated: false, text: 'one\n' }),
  rootFileTicket: async () => 'ticket',
}));

import { t } from '../../i18n/index.js';
import { chooseFileRoot, openProjectFile, usePendingFile } from './explorerState.js';
import { FileExplorer } from './FileExplorer.js';
import type { FileRoot } from './filesStore.js';

const confirm = vi.fn(() => false);
beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true, confirm });
  vi.stubGlobal('document', { body: { nodeType: 1 }, visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined });
  fake.mobile = false;
  fake.dirty = true;
  fake.roots = [];
  fake.attached = 0;
  confirm.mockReset().mockReturnValue(false);
});
afterEach(() => {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.slots = [];
  hooks.cleanups.clear();
  vi.unstubAllGlobals();
});

type Node = ReactElement<Record<string, unknown>>;
function all(node: ReactNode, out: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach((n) => all(n as ReactNode, out));
  else if (node && typeof node === 'object') {
    const portal = node as { children?: ReactNode; props?: { children?: ReactNode } };
    if ('props' in node && portal.props) {
      out.push(node as Node);
      all(portal.props.children, out);
    } else if ('children' in portal) all(portal.children, out); // createPortal's object
  }
  return out;
}
/** One render: the explorer and the elements it draws. */
function render() {
  hooks.at = 0;
  const shell = all(FileExplorer());
  const explorer = shell.find((el) => typeof el.type === 'function' && 'root' in el.props)!;
  const tree = all((explorer.type as (p: unknown) => ReactNode)(explorer.props));
  for (const run of hooks.effects.splice(0)) run();
  return { root: explorer.props.root as FileRoot, tree };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const press = (tree: Node[], match: (el: Node) => boolean) => (tree.find(match)!.props.onClick as () => void)();

/** alpha's a.ts open in the editor with unsaved text. */
async function editing() {
  const { tree } = render();
  const folder = tree.find((el) => typeof el.props.onFile === 'function')!;
  (folder.props.onFile as (e: unknown) => void)({ name: 'a.ts', path: 'a.ts', kind: 'file', size: 4, mtime: 0 });
  await flush();
  // The desktop's switch, the phone's toggle button.
  press(render().tree, (el) => el.props['data-testid'] === 'edit-switch' || el.props.children === t('files.edit.toggle'));
  const shown = render();
  expect(shown.tree.some((el) => el.props['data-testid'] === 'edit-save')).toBe(true);
  return shown;
}

it('U1.1: another root asks before the unsaved edit goes, and a no keeps the root', async () => {
  await editing();
  chooseFileRoot({ kind: 'project', project: 'beta' });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(render().root).toMatchObject({ project: 'alpha' });
  // The docs tab's row of another project: kept out too, and its file does not open later.
  openProjectFile('beta', { name: 'b.md', path: 'b.md', kind: 'file', size: 1, mtime: 0 });
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(render().root).toMatchObject({ project: 'alpha' });
  expect(usePendingFile()).toBeNull();
  confirm.mockReturnValue(true);
  chooseFileRoot({ kind: 'project', project: 'beta' });
  expect(render().root).toMatchObject({ project: 'beta' });
});

it('U1.2: picking the shown root again keeps the edit: no confirm, and the session is not reloaded', async () => {
  chooseFileRoot({ kind: 'project', project: 'alpha' }); // nothing open yet: no guard
  await editing();
  const before = fake.roots.at(-1);
  chooseFileRoot({ kind: 'project', project: 'alpha' }); // the active project button, the picker's main row
  render();
  expect(confirm).not.toHaveBeenCalled();
  // A new root object would rerun the session's load and put the disk text over the draft.
  expect(fake.roots.at(-1)).toBe(before);
});

it('U1.7: the phone sends a file being edited to the messenger only after the discard confirm', async () => {
  fake.mobile = true;
  chooseFileRoot({ kind: 'project', project: 'alpha' });
  await editing();
  const send = (el: Node) => el.props.children === t('files.sendMessenger');
  press(render().tree, send);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(fake.attached).toBe(0); // a no: nothing attached, the edit stays open
  expect(render().tree.some((el) => el.props['data-testid'] === 'edit-save')).toBe(true);
  confirm.mockReturnValue(true);
  press(render().tree, send);
  expect(fake.attached).toBe(1);
  const after = render();
  expect(after.tree.some((el) => el.props['data-testid'] === 'edit-save')).toBe(false);
  // Closed out of editing: the next file opens without asking about text no one can see.
  const folder = after.tree.find((el) => typeof el.props.onFile === 'function')!;
  (folder.props.onFile as (e: unknown) => void)({ name: 'b.ts', path: 'b.ts', kind: 'file', size: 4, mtime: 0 });
  expect(confirm).toHaveBeenCalledTimes(2);
});
