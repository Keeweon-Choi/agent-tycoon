import type { ChatLibraryFile } from '../../../../core/src/messages.js';

/** The library's files so far plus the next page: newest first, one row for a path sent more than once. */
export function mergeLibrary(
  held: readonly ChatLibraryFile[],
  page: readonly ChatLibraryFile[],
): ChatLibraryFile[] {
  const seen = new Set<string>();
  return [...held, ...page].filter((file) => {
    if (!file.path) return true;
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

/** A row that cannot be opened: its file is gone, or the lead's copy of it was never made. */
export const libraryGone = (file: Pick<ChatLibraryFile, 'missing' | 'unavailable' | 'path'>): boolean =>
  !file.path || !!file.missing || !!file.unavailable;
