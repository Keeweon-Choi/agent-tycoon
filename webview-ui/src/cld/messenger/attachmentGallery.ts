import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

import { t } from '../../i18n/index.js';
import { useEngineStore } from '../engineStore.js';
import { rootFileTicket } from '../files/filesStore.js';
import { useCldStore } from '../officeStore.js';
import type { AttachmentChip } from './attachments.js';

export interface ViewerFile {
  path: string;
  name: string;
  type: string;
  sizeKb: number;
  /** A message link rather than one of the conversation's recorded attachments. */
  linked?: boolean;
  line?: number;
}
type Mode = 'preview' | 'download';
export type TicketFor = (path: string, mode: Mode) => Promise<string>;

/** Which project and relative path an absolute attachment path belongs to (null: not under a known folder). */
export function useAttachmentTarget(project?: string, projectRoot?: string) {
  const office = useCldStore().officeSnapshot;
  const engine = useEngineStore().state;
  return useCallback(
    (absolute: string) => {
      const roots = [
        ...(engine?.projects.map((item) => ({ name: item.name, folder: item.folder })) ?? []),
        ...(office?.orchestrators.map((item) => ({ name: item.name, folder: item.dir })) ?? []),
        ...(project && projectRoot ? [{ name: project, folder: projectRoot }] : []),
      ];
      const found = roots
        .sort((a, b) => b.folder.length - a.folder.length)
        .find((item) => absolute.startsWith(`${item.folder.replace(/\/$/, '')}/`));
      return (
        found && {
          project: found.name,
          relative: absolute.slice(found.folder.replace(/\/$/, '').length + 1),
        }
      );
    },
    [engine, office, project, projectRoot],
  );
}

/**
 * A ticket for one attachment; rejects when it is outside every known folder.
 * Stable for the component's life: office/engine state arrives on every agent's
 * turn, and a new function each time would reset an open viewer's zoom.
 */
export function useTicketFor(project?: string, projectRoot?: string): TicketFor {
  const targetFor = useAttachmentTarget(project, projectRoot);
  const latest = useRef(targetFor);
  latest.current = targetFor;
  return useCallback((path, mode) => {
    const target = latest.current(path);
    if (!target) return Promise.reject(new Error(t('attachment.error.missingFolder')));
    return rootFileTicket({ kind: 'project', project: target.project }, target.relative, mode);
  }, []);
}

export const Gallery = createContext<((path: string, line?: number) => void) | null>(null);
/** The open-the-viewer function of the nearest AttachmentGallery, if any. */
export const useOpenAttachment = () => useContext(Gallery);

/** MSG-UI2: a file still in the composer opens in the same viewer, under this path prefix. */
export const DRAFT_PREFIX = 'draft:';
export const draftPath = (chip: Pick<AttachmentChip, 'id'>): string => `${DRAFT_PREFIX}${chip.id}`;

export const draftViewerFiles = (chips: readonly AttachmentChip[]): ViewerFile[] =>
  chips.map((chip) => ({
    path: draftPath(chip),
    name: chip.name,
    type: chip.type,
    sizeKb: Math.ceil(chip.size / 1024),
  }));

/**
 * `base`, plus the composer's chips: a chip's file is read from the browser's own copy (an object
 * URL), an uploaded one from its server path. Stable for the component's life, like useTicketFor.
 */
export function useDraftTicketFor(base: TicketFor, chips: readonly AttachmentChip[]): TicketFor {
  const latest = useRef(chips);
  latest.current = chips;
  const urls = useRef(new Map<string, string>());
  useEffect(() => {
    const held = urls.current;
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);
  return useCallback(
    (path, mode) => {
      if (!path.startsWith(DRAFT_PREFIX)) return base(path, mode);
      const chip = latest.current.find((c) => draftPath(c) === path);
      if (!chip) return Promise.reject(new Error(t('attachment.error.missingFolder')));
      if (chip.file) {
        let url = urls.current.get(chip.id);
        if (!url) urls.current.set(chip.id, (url = URL.createObjectURL(chip.file)));
        return Promise.resolve(url);
      }
      return chip.path ? base(chip.path, mode) : Promise.reject(new Error(chip.error ?? chip.name));
    },
    [base],
  );
}
