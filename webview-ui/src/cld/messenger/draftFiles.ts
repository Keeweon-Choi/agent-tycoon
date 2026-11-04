/**
 * REDEPLOY-STATE (owner 11-04 16:51): the files attached to a conversation but not sent yet
 * survive a reload (a deploy reloads the page) and an agent id that changed with the daemon,
 * like the draft text does. They stay in this browser's IndexedDB under the draft key, the File
 * itself included: nothing is uploaded before 보내기, so no other device or viewer can reach them.
 * Any storage failure leaves this visit as before (the chips in memory only).
 */
import { useEffect, useRef } from 'react';

import type { AttachmentChip } from './attachments.js';
import { DRAFT_TTL_MS } from './messengerStore.js';

const DB_NAME = 'cld-draft-files';
const STORE = 'chips';

interface Stored {
  at: number;
  chips: AttachmentChip[];
}

/** What a reload brings back: an upload cut short is to send again. */
export const storedChips = (chips: readonly AttachmentChip[]): AttachmentChip[] =>
  chips.map((chip) => (chip.state === 'uploading' ? { ...chip, state: 'pending', progress: 0 } : chip));

/** The chips kept under a key, or none when older than a draft lives (24 h). */
export const liveChips = (stored: Stored | undefined, now: number): AttachmentChip[] =>
  stored && Array.isArray(stored.chips) && now - stored.at < DRAFT_TTL_MS ? stored.chips : [];

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(STORE, mode);
        const request = op(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result as T);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
  });
}

// ponytail: a conversation never opened again keeps its files until the next visit to it
// (then dropped after 24 h); sweep the whole store if browsers ever run short of space.
async function load(key: string): Promise<AttachmentChip[]> {
  return liveChips(await run<Stored | undefined>('readonly', (s) => s.get(key)), Date.now());
}

function save(key: string, chips: readonly AttachmentChip[]): Promise<unknown> {
  return run('readwrite', (s) =>
    chips.length ? s.put({ at: Date.now(), chips: storedChips(chips) } satisfies Stored, key) : s.delete(key),
  ).catch(() => undefined);
}

/**
 * Keep `chips` (the composer's, held in memory under the agent id) under `key`: a composer that
 * mounts without any takes back the ones kept; every change after that is written.
 */
export function useDraftFiles(
  key: string,
  chips: readonly AttachmentChip[],
  restore: (chips: AttachmentChip[]) => void,
): void {
  const ready = useRef<string | null>(null);
  const latest = useRef({ chips, restore });
  latest.current = { chips, restore };
  useEffect(() => {
    ready.current = null;
    if (typeof indexedDB === 'undefined') return;
    let live = true;
    void (async () => {
      let kept: AttachmentChip[] = [];
      try {
        if (!latest.current.chips.length) kept = await load(key);
      } catch {
        return; // No storage here: this visit keeps them in memory only.
      }
      if (!live) return;
      const restoring = kept.length > 0 && !latest.current.chips.length;
      if (restoring) latest.current.restore(kept);
      ready.current = key;
      // What memory holds wins (chips added meanwhile, or by 파일 while no composer showed); none
      // drops an expired entry.
      if (!restoring) void save(key, latest.current.chips);
    })();
    return () => {
      live = false;
    };
  }, [key]);
  useEffect(() => {
    // Not before the kept ones are read: an empty first render must not erase them.
    if (ready.current === key) void save(key, chips);
  }, [key, chips]);
}
