import type {
  ProjectFileList,
  ProjectFilePreview,
  ProjectRecentFiles,
} from '../../../../core/src/cld/projectFiles.js';
import { t } from '../../i18n/index.js';
import { serverText } from '../serverText.js';

export type FileRoot = { kind: 'project'; project: string } | { kind: 'folder'; folder: string };
export const fileRootKey = (root: FileRoot) =>
  root.kind === 'project' ? `project:${root.project}` : `folder:${root.folder}`;
const rootProject = (root: FileRoot) => (root.kind === 'project' ? root.project : '~folder');
const rootPath = (root: FileRoot) => (root.kind === 'folder' ? root.folder : undefined);

const base = (project: string) => `/api/cld/files/${encodeURIComponent(project)}`;

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
      '/api/cld/files/settings',
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
  new URLSearchParams({ ...values, ...(rootPath(root) && { root: rootPath(root) }) });

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
  mode: 'preview' | 'download',
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
      }),
    }),
  );
  return result.url;
}
