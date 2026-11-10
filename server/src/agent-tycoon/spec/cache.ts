/**
 * SPT §4.1 (NFR-SEC-020, ADR-0019 decision 5): the match cache, `<settings>/spec/<projectId>/
 * match-cache.json.gz`, the text the identity ladder compares an item's last version by (T3 needs
 * it across restarts). A cache, not a record: losing it costs one scan matched by path, display
 * ID and text hash only, and the next scan writes it again.
 *  - folder 0700, file 0600, gzip through a temp file and a rename; the daemon is the only writer;
 *  - text is masked (extract.ts `bodyText`) before it gets here, and the ladder works on that;
 *  - a document git ignores or the owner marks 민감 keeps no text: its items' 3-gram hash sets only,
 *    keyed (a PRF under `<config>/spec.key`, 0600, outside spec/ and never in a backup) so no
 *    dictionary turns them back into text; a cache made under another key is not used, but rebuilt;
 *  - never in a log or an API answer, but the masked old text of a 같은 항목 확인 question;
 *  - deleted when tracking goes off (the Registry stays); never in a backup (1d's list leaves it out).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

import { configDirectory } from '../configPath.js';
import { bodyText, type Extracted } from './extract.js';
import { type Hasher, keyedHasher, type Mat, type Sketch, textMat } from './identity.js';
import { specDirectory } from './store.js';

export interface CacheItem {
  /** Body and title, masked and cleaned: only for a document that may keep text. */
  b?: string;
  ti?: string;
  /** Otherwise their 3-gram hashes, the body's normalised length and the flags (1 title is evidence, 2 delete mark). */
  h?: number[];
  th?: number[];
  n?: number;
  f?: number;
}
export interface MatchCache {
  v: 1;
  /** The hash key it was made under (Hasher.kid). */
  kid: string;
  items: Record<string, CacheItem>;
  docs: Record<string, Sketch>;
}

export const cacheFile = (home: string, projectId: string): string => path.join(specDirectory(home, projectId), 'match-cache.json.gz');
export const emptyCache = (kid: string): MatchCache => ({ v: 1, kid, items: {}, docs: {} });
export const keyFile = (home: string): string => path.join(configDirectory(home), 'spec.key');
const KEY_BYTES = 32;

/**
 * The per-install hash key: read, or made (random, 0600, write-then-rename) when it is missing or
 * not one. A key that cannot be kept on disk still works for this run (the next start makes
 * another, and every cache is rebuilt then).
 */
export function hasherFor(home: string): Hasher {
  const file = keyFile(home);
  try {
    const hex = fs.readFileSync(file, 'utf-8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return keyedHasher(Buffer.from(hex, 'hex'));
  } catch {
    /* missing: make one */
  }
  const key = crypto.randomBytes(KEY_BYTES);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${key.toString('hex')}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[Agent Tycoon] spec hash key not saved: ${err instanceof Error ? err.message : String(err)}`);
  }
  return keyedHasher(key);
}

/** Temp files a crash left beside the cache. */
function dropTemps(file: string): void {
  const dir = path.dirname(file);
  const base = `${path.basename(file)}.`;
  try {
    for (const name of fs.readdirSync(dir)) if (name.startsWith(base) && name.endsWith('.tmp')) fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    /* no folder yet */
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The cache, or null when it is missing, cannot be read as one or was made under another key (it is rebuilt, never trusted half). */
export function readCache(file: string, kid: string): MatchCache | null {
  dropTemps(file);
  try {
    const raw: unknown = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf-8'));
    if (!isObject(raw) || raw.v !== 1 || raw.kid !== kid || !isObject(raw.items) || !isObject(raw.docs)) return null;
    return raw as unknown as MatchCache;
  } catch {
    return null;
  }
}

export function writeCache(file: string, cache: MatchCache): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(cache)), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function deleteCache(file: string): void {
  fs.rmSync(file, { force: true });
  dropTemps(file);
}

/** An item's cache entry: its text, or (a sensitive document) only its hashes. */
export function entryOf(h: Hasher, it: Extracted, textOk: boolean): CacheItem {
  const ti = bodyText(it.title); // the title masked the same way as the body
  if (textOk) return { b: it.body, ti };
  return hashed(textMat(h, it.body, ti, it.displayId));
}
const hashed = (m: Mat): CacheItem => ({ h: [...m.set], th: [...m.tset], n: m.len, f: (m.tu ? 1 : 0) | (m.tomb ? 2 : 0) });
/** The same entry without its text (the document became sensitive or ignored). */
export const withoutText = (h: Hasher, e: CacheItem, displayId: string): CacheItem =>
  e.b === undefined ? e : hashed(textMat(h, e.b, e.ti ?? '', displayId || undefined));

/** What the ladder compares: from the text, or from the hashes as they were stored. */
export function matOf(h: Hasher, e: CacheItem | undefined, displayId: string): Mat | null {
  if (!e) return null;
  if (e.b !== undefined) return textMat(h, e.b, e.ti ?? '', displayId || undefined);
  if (!Array.isArray(e.h) || !Array.isArray(e.th)) return null;
  return { set: new Set(e.h), tset: new Set(e.th), len: e.n ?? 0, tu: !!((e.f ?? 0) & 1), tomb: !!((e.f ?? 0) & 2) };
}
