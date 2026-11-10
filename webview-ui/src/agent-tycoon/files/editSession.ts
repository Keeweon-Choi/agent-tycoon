import { useCallback, useEffect, useRef, useState } from 'react';

import { EDIT_POLL_MS } from '../../constants.js';
import { type FileRoot, readEditHash, readEditText, saveEditText } from './filesStore.js';
import { changedLines, eolOf, lf, withEol } from './lineDiff.js';

/** What the file looks like on disk once it differs from the text that was opened. */
interface DiskChange {
  hash: string;
  text: string;
}

export interface EditSession {
  /** The text the editor shows when `docKey` last changed. */
  doc: string;
  docKey: number;
  loading: boolean;
  error: string;
  dirty: boolean;
  saving: boolean;
  /** The file changed on disk since it was opened (banner). */
  changed: boolean;
  /** 1-based lines an agent changed (yellow); kept after a reload, gone after a save. */
  marks: number[];
  /** The last save, for the status line. */
  saved: boolean;
  edit(text: string): void;
  save(): Promise<void>;
  /** 그래도 저장: the disk's hash as the base, the editor's text on top. */
  saveAnyway(): Promise<void>;
  reload(): void;
}

/**
 * One file open for editing: loads it with its hash, polls the hash every EDIT_POLL_MS while the page is
 * visible, and saves with the hash it was opened at (the daemon answers 409 when the disk moved on).
 * `path` null: nothing open.
 */
export function useEditSession(root: FileRoot, path: string | null): EditSession {
  const [doc, setDoc] = useState('');
  const [docKey, setDocKey] = useState(0);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [disk, setDisk] = useState<DiskChange | null>(null);
  const [marks, setMarks] = useState<number[]>([]);
  const base = useRef({ hash: '', text: '', eol: '\n' as '\n' | '\r\n' });
  const draft = useRef('');
  const live = useRef(0);

  useEffect(() => {
    if (path === null) return;
    const mine = ++live.current;
    setLoading(true);
    setError('');
    setDirty(false);
    setSaved(false);
    setDisk(null);
    setMarks([]);
    readEditText(root, path)
      .then((file) => {
        if (mine !== live.current) return;
        base.current = { hash: file.hash, text: file.text, eol: eolOf(file.text) };
        draft.current = lf(file.text);
        setDoc(draft.current);
        setDocKey((n) => n + 1);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (mine !== live.current) return;
        setError(err.message);
        setLoading(false);
      });
  }, [root, path]);

  /** The disk's text, shown against what was opened: lines that differ are the agent's. */
  const showDisk = useCallback(async (): Promise<void> => {
    if (path === null) return;
    const mine = live.current;
    const file = await readEditText(root, path);
    if (mine !== live.current) return;
    setDisk({ hash: file.hash, text: file.text });
    setMarks(changedLines(base.current.text, file.text));
  }, [root, path]);

  // The poll: only while the page is visible, and only once the file is loaded.
  useEffect(() => {
    if (path === null || loading || error) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const mine = live.current;
      readEditHash(root, path)
        .then((hash) => {
          if (mine !== live.current || saving) return;
          if (hash !== base.current.hash && hash !== disk?.hash) return showDisk();
        })
        .catch(() => undefined);
    }, EDIT_POLL_MS);
    return () => clearInterval(timer);
  }, [root, path, loading, error, saving, disk?.hash, showDisk]);

  const write = useCallback(
    async (baseHash: string): Promise<void> => {
      if (path === null) return;
      const mine = live.current;
      setSaving(true);
      setError('');
      const text = withEol(draft.current, base.current.eol);
      try {
        const hash = await saveEditText(root, path, text, baseHash);
        if (mine !== live.current) return;
        base.current = { ...base.current, hash, text };
        setDirty(false);
        setSaved(true);
        setDisk(null);
        setMarks([]);
      } catch (err) {
        if (mine !== live.current) return;
        if ((err as { status?: number }).status === 409) await showDisk().catch(() => undefined);
        else setError((err as Error).message);
        setSaved(false);
      } finally {
        if (mine === live.current) setSaving(false);
      }
    },
    [root, path, showDisk],
  );

  return {
    doc,
    docKey,
    loading,
    error,
    dirty,
    saving,
    changed: disk !== null,
    marks,
    saved,
    edit: (text) => {
      draft.current = text;
      setDirty(text !== lf(base.current.text));
      setSaved(false);
    },
    save: () => write(base.current.hash),
    saveAnyway: () => write(disk?.hash ?? base.current.hash),
    reload: () => {
      if (!disk) return;
      base.current = { hash: disk.hash, text: disk.text, eol: eolOf(disk.text) };
      draft.current = lf(disk.text);
      setDoc(draft.current);
      setDocKey((n) => n + 1);
      setDirty(false);
      setDisk(null);
    },
  };
}
