import type {
  ProjectFileList,
  ProjectFilePreview,
  ProjectRecentFiles,
} from '../../../../core/src/agent-tycoon/projectFiles.js';
import { t } from '../../i18n/index.js';
import { serverText } from '../serverText.js';

export type FileRoot =
  | { kind: 'project'; project: string }
  | { kind: 'worktree'; project: string; task: string }
  | { kind: 'folder'; folder: string };
export const fileRootKey = (root: FileRoot) =>
  root.kind === 'project'
    ? `project:${root.project}`
    : root.kind === 'worktree'
      ? `worktree:${root.project}:${root.task}`
      : `folder:${root.folder}`;
export const rootProject = (root: FileRoot) => (root.kind === 'folder' ? '~folder' : root.project);
const rootPath = (root: FileRoot) => (root.kind === 'folder' ? root.folder : undefined);
const rootTask = (root: FileRoot) => (root.kind === 'worktree' ? root.task : undefined);

const base = (project: string) => `/api/agty/files/${encodeURIComponent(project)}`;

async function response<T>(result: Response): Promise<T> {
  if (!result.ok) {
    const body = (await result.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(
      new Error(serverText(body, t('files.requestFailed', { status: result.status }))),
      {
        status: result.status,
      },
    );
  }
  return result.json() as Promise<T>;
}

export async function recentProjectFiles(
  project: string,
  hidden: boolean,
): Promise<ProjectRecentFiles> {
  const query = new URLSearchParams({ hidden: hidden ? '1' : '0' });
  return response(
    await fetch(`${base(project)}/recent?${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  );
}

export function isIgnoredPath(relative: string, ignored: readonly string[]): boolean {
  return ignored.some(
    (entry) =>
      relative === entry ||
      relative === entry.replace(/\/$/, '') ||
      relative.startsWith(entry.endsWith('/') ? entry : `${entry}/`),
  );
}

export async function fileSettings(allowSensitive?: boolean): Promise<{ allowSensitive: boolean }> {
  return response(
    await fetch(
      '/api/agty/files/settings',
      allowSensitive === undefined
        ? { credentials: 'same-origin', cache: 'no-store' }
        : {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ allowSensitive }),
          },
    ),
  );
}

const rootQuery = (root: FileRoot, values: Record<string, string>) =>
  new URLSearchParams({
    ...values,
    ...(rootPath(root) && { root: rootPath(root) }),
    ...(rootTask(root) && { task: rootTask(root) }),
  });

export async function listRootFiles(
  root: FileRoot,
  relative: string,
  offset: number,
  hidden: boolean,
) {
  const query = rootQuery(root, {
    path: relative,
    offset: String(offset),
    hidden: hidden ? '1' : '0',
  });
  return response<ProjectFileList>(
    await fetch(`${base(rootProject(root))}/list?${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  );
}

export async function ignoredRootFiles(root: FileRoot): Promise<string[]> {
  const query = rootQuery(root, {});
  const result = await response<{ ignored: string[] }>(
    await fetch(`${base(rootProject(root))}/ignored?${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  );
  return result.ignored;
}

export async function previewRootFile(root: FileRoot, relative: string) {
  const query = rootQuery(root, { path: relative });
  return response<ProjectFilePreview>(
    await fetch(`${base(rootProject(root))}/preview?${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  );
}

export async function rootFileTicket(
  root: FileRoot,
  relative: string,
  mode: 'preview' | 'download' | 'open',
) {
  const result = await response<{ url: string }>(
    await fetch(`${base(rootProject(root))}/ticket`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: relative,
        mode,
        ...(rootPath(root) && { root: rootPath(root) }),
        ...(rootTask(root) && { task: rootTask(root) }),
      }),
    }),
  );
  return result.url;
}

/** The editor's file: the whole text and the hash a save must present. */
export interface EditText {
  path: string;
  text: string;
  hash: string;
}

export const readEditText = async (root: FileRoot, relative: string): Promise<EditText> =>
  response(
    await fetch(`${base(rootProject(root))}/text?${rootQuery(root, { path: relative })}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  );

/** Only the hash, for the 5 s poll while a file is open for editing. */
export async function readEditHash(root: FileRoot, relative: string): Promise<string> {
  const query = rootQuery(root, { path: relative, hashOnly: '1' });
  const result = await response<{ hash: string }>(
    await fetch(`${base(rootProject(root))}/text?${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  );
  return result.hash;
}

/** Refused with 409 when the file changed on disk since `baseHash`: the error carries the disk's `hash`. */
export async function saveEditText(
  root: FileRoot,
  relative: string,
  text: string,
  baseHash: string,
): Promise<string> {
  const result = await fetch(`${base(rootProject(root))}/text`, {
    method: 'PUT',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: relative,
      text,
      baseHash,
      ...(rootPath(root) && { root: rootPath(root) }),
      ...(rootTask(root) && { task: rootTask(root) }),
    }),
  });
  if (result.status === 409)
    throw Object.assign(new Error('changed on disk'), {
      status: 409,
      hash: ((await result.json().catch(() => ({}))) as { hash?: string }).hash,
    });
  return (await response<{ hash: string }>(result)).hash;
}
