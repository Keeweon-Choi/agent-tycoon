/**
 * SPT §2.5 (ADR-0019 decisions 3 and 7), pure: one scan's documents and items against every
 * record the Registry holds (active, unresolved and retired), R2's ladder in R2's order
 * (agent-tycoon/docs/research/spec-tracking-identity-2026-11-03.md §3): D0 the same path, D1 git renames,
 * D2 the front-matter id, T1 the same text, D3 document content, T2 the same display ID (with the
 * reuse check), T3 the scored text, title and neighbours, then the post-processing. SPT 0.3 on top:
 *  - D1 comes first for a path git renamed a document away from (a new file there is new);
 *  - D0 holds only while the document continues: not when its text came from other documents rather
 *    than its own (two documents swapping paths), nor when the overlap is under 0.1 and fewer than
 *    half its old items continue by T1/T2; else 'same document?' and its items wait as provisional;
 *  - identical text that appears more than once pairs only with matching neighbours (T1n); short
 *    repeated boilerplate gets new UIDs instead of a question;
 *  - a display ID the project defines twice pairs by T2 only inside its document's lineage (SPT §2.5);
 *  - T2 is not taken when the item's text continues another record (an ID-reuse chain): T3 or a question;
 *  - the candidates of an open question are contested: no other item takes them before the owner answers;
 *  - every decision is kept on its record (how, score, rev, by), the last SPEC_DECISIONS_MAX.
 * Texts are compared as sets of 32-bit keyed 3-gram hashes (a pseudo-random function under a
 * per-install key, so a set read from the cache cannot be turned back into text with a dictionary), and a document whose
 * cache holds only hashes (git-ignored, 민감) is matched the same way. Documents compare by bottom-k
 * sketches of their masked text.
 * Nothing here reads a file or the clock: the caller hands in the snapshot and the cache.
 */
import { createCipheriv, createHmac } from 'crypto';

import { SPEC_DECISIONS_MAX, SPEC_LADDER as L, SPEC_PATH_HISTORY_MAX, SPEC_SCORE_EPSILON, SPEC_SKETCH_K } from '../../constants.js';
import { clean } from '../tracking/docs.js';
import { bodyText, type Extracted, norm } from './extract.js';
import { type Cand, currentId, type DocHow, type DocRecord, type ItemHow, type ItemRecord, type Why } from './store.js';

// ── Fingerprints ─────────────────────────────────────────

/** A keyed 32-bit hash of 3-grams; `kid` names the key (the cache records it). */
export interface Hasher {
  kid: string;
  /** The hashes of many 3-grams at once, in order. */
  many(grams: string[]): number[];
  tri(gram: string): number;
}
/** One AES block per 3-gram: its three UTF-16 units and its length. */
const BLOCK = 16;
/**
 * A pseudo-random function of each 3-gram under `key`: AES-128 of one block (the key is the HMAC of
 * the install key), the first 32 bits kept. Without the key no table maps a hash back to its 3-gram;
 * one cipher call hashes a whole text's 3-grams (no memo, nothing held between scans).
 */
export function keyedHasher(key: Buffer): Hasher {
  const aes = createHmac('sha256', key).update('spec-3gram').digest().subarray(0, BLOCK);
  const many = (grams: string[]): number[] => {
    if (!grams.length) return [];
    const buf = Buffer.alloc(grams.length * BLOCK);
    grams.forEach((g, i) => {
      for (let j = 0; j < g.length && j < 3; j++) buf.writeUInt16LE(g.charCodeAt(j), i * BLOCK + j * 2);
      buf[i * BLOCK + 6] = g.length;
    });
    const c = createCipheriv('aes-128-ecb', aes, null).setAutoPadding(false);
    const out = c.update(buf);
    return grams.map((_, i) => out.readUInt32BE(i * BLOCK));
  };
  return { kid: createHmac('sha256', key).update('spec-match-cache').digest('hex').slice(0, 16), many, tri: (g) => many([g])[0] };
}
/** The distinct 3-grams of a normalised text (a text under 3 characters is its own one). */
const grams = (n: string): string[] => {
  if (n.length < 3) return n ? [n] : [];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= n.length; i++) out.add(n.slice(i, i + 3));
  return [...out];
};
/** R2's 3-gram set of a normalised text, hashed. */
export const shingles = (n: string, h: Hasher): Set<number> => new Set(h.many(grams(n)));

/** What an item is matched by: its body's and title's 3-gram hashes, the body's length, two flags. */
export interface Mat {
  set: Set<number>;
  tset: Set<number>;
  len: number;
  /** The title is evidence (not a positional label like Kiro's "Requirement 3", not the body itself). */
  tu: boolean;
  /** A delete mark: "(삭제", "deleted", "removed", "폐기", or struck through. */
  tomb: boolean;
}
const TOMB = /^(삭제|deleted|removed|폐기)/;
export function textMat(h: Hasher, body: string, title: string, ownId?: string): Mat {
  const exact = norm(body, ownId);
  const titleN = norm(title, ownId);
  const generic = /^requirement\d+$/.test(titleN) || titleN.length < 2;
  return {
    set: shingles(exact, h),
    tset: shingles(titleN, h),
    len: exact.length,
    tu: !generic && titleN !== exact,
    tomb: TOMB.test(clean(title).replace(/^[(（~\s]+/, '')) || /^\s*~~/.test(title),
  };
}

/** R2's similarity: Jaccard, or the damped containment of the smaller side (an appended requirement). */
export function jaccard(a: Set<number>, b: Set<number>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  const [x, y] = a.size < b.size ? [a, b] : [b, a];
  if (x.size / y.size < L.sizeFloor) return 0;
  let k = 0;
  for (const v of x) if (y.has(v)) k++;
  return Math.max(k / (a.size + b.size - k), x.size >= L.containMin && y.size <= L.containRatio * x.size ? L.containDamp * (k / x.size) : 0);
}

/** A document's fingerprint: how many distinct 3-grams it has and the smallest SPEC_SKETCH_K of their hashes, ascending. */
export interface Sketch {
  n: number;
  k: number[];
}
/** Of the masked text (a secret in the document never reaches the cache, not even as hashes). */
export function sketchOf(text: string, h: Hasher): Sketch {
  const n = norm(bodyText(text));
  const set = n.length < 3 ? new Set<number>() : shingles(n, h);
  const all = Uint32Array.from(set).sort();
  return { n: set.size, k: Array.from(all.subarray(0, SPEC_SKETCH_K)) };
}
/** Bottom-k estimates of two documents' Jaccard and their shared 3-grams. */
function estimate(a: Sketch, b: Sketch): { j: number; inter: number } {
  const as = new Set(a.k);
  const bs = new Set(b.k);
  const union = [...new Set([...a.k, ...b.k])].sort((x, y) => x - y).slice(0, SPEC_SKETCH_K);
  const both = union.filter((v) => as.has(v) && bs.has(v)).length;
  const j = union.length ? both / union.length : 1;
  return { j, inter: (j / (1 + j)) * (a.n + b.n) };
}
/** R2's `jaccard` on two whole documents, from their sketches. */
export function docSim(a: Sketch, b: Sketch): number {
  if (!a.n && !b.n) return 1;
  if (!a.n || !b.n) return 0;
  const [x, y] = a.n < b.n ? [a.n, b.n] : [b.n, a.n];
  if (x / y < L.sizeFloor) return 0;
  const { j, inter } = estimate(a, b);
  return Math.max(j, x >= L.containMin && y <= L.containRatio * x ? L.containDamp * (inter / x) : 0);
}
/** D3's text score: R2 adds the containment of the old document (an append-only changelog). */
function docScore(old: Sketch, cur: Sketch): number {
  return Math.max(docSim(old, cur), old.n >= L.d3ContainMin && cur.n ? L.containDamp * Math.min(1, estimate(old, cur).inter / old.n) : 0);
}

// ── The snapshot ─────────────────────────────────────────

export interface SnapDoc {
  path: string;
  fmId?: string;
  /** Its sketch when it was read this scan. */
  sketch?: Sketch;
  /** Its items in order, or null: bytes and switches as last matched, its records stand as they are. */
  items: Extracted[] | null;
  /** Read only as a place a missing document may have gone: dropped unless D1-D3 give it one. */
  moveOnly?: boolean;
  /** Tracked by itself beside tracked documents (새 문서) when nothing matches it. */
  fresh?: boolean;
  /** Read for the first time (just enabled): its new items are not news. */
  first?: boolean;
}

export interface MatchInput {
  docs: SnapDoc[];
  /** git's renames, new path → the path at the last scan; null without git evidence. */
  renames: Map<string, string> | null;
  rev: string;
  at: string;
  /** The keyed 3-gram hash the material was made with. */
  hash: Hasher;
  /** A record's matching material (the match cache), null when there is none. */
  mat: (uid: string) => Mat | null;
  sketch: (docUid: string) => Sketch | null;
  /** A record for a document nothing matched (provisional when `unresolved`). */
  newDoc: (d: SnapDoc, unresolved: boolean) => string;
  newItem: () => string;
}

export interface MatchResult {
  /** The document UID of each snapshot path that stays. */
  docOf: Map<string, string>;
  /** The item UIDs of each document that had items, in order. */
  itemsOf: Map<string, string[]>;
  /** moveOnly paths nothing matched (not tracked). */
  dropped: string[];
}

interface Cur {
  it: Extracted;
  path: string;
  /** Its document's UID, '?path' while it has none. */
  doc: string;
  mat: Mat;
}
interface Dec {
  uid: string;
  how: ItemHow;
  score?: number;
  cands?: Cand[];
  ask?: 'item' | 'reuse';
  /** From a group of identical texts (short ones get new UIDs, never a question). */
  dup?: boolean;
}
interface DocDec {
  uid: string | null;
  how: DocHow;
  score?: number;
  from?: string;
  cands?: Cand[];
}

const pushMax = <T>(list: T[], item: T, max: number) => {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
};
const round = (n: number) => Math.round(n * 1000) / 1000;

function ladder(reg: { docs: Record<string, DocRecord>; items: Record<string, ItemRecord> }, input: MatchInput) {
  const { docs: snap } = input;
  // ── Records: by document, the unchanged documents' items fixed, the rest the pool ──
  const recsOf = new Map<string, string[]>();
  for (const [u, r] of Object.entries(reg.items)) recsOf.set(r.doc, [...(recsOf.get(r.doc) ?? []), u]);
  const byPath = new Map<string, string>();
  for (const [u, d] of Object.entries(reg.docs))
    if (d.tracked && (!byPath.has(d.path) || reg.docs[byPath.get(d.path)!].state === 'retired')) byPath.set(d.path, u);
  const fixed = new Set<string>();
  for (const d of snap) {
    const u = byPath.get(d.path);
    if (d.items === null && u) for (const r of recsOf.get(u) ?? []) if (reg.items[r].state !== 'retired') fixed.add(r);
  }
  // Items of a document the owner stopped tracking are neither seen nor free.
  const pool = Object.keys(reg.items).filter((u) => !fixed.has(u) && reg.docs[reg.items[u].doc]?.tracked !== false);

  // ── Documents: D1 git first where a document was renamed away from a path, then D0 the same path (continuity checked twice below), D2 front matter ──
  const docDec = new Map<string, DocDec>();
  const claimedDoc = new Set<string>();
  const put = (path: string, uid: string, how: DocHow, score?: number, from?: string) => {
    docDec.set(path, { uid, how, score, from });
    claimedDoc.add(uid);
  };
  const placed = (path: string) => !!docDec.get(path)?.uid;
  const sk = (d: SnapDoc) => d.sketch ?? null;
  const free = (u: string) => !claimedDoc.has(u) && reg.docs[u].tracked;
  // git renamed it away: it follows the rename even when a new file now sits at its old path (that one is new, or asked).
  if (input.renames)
    for (const d of snap) {
      if (placed(d.path) || byPath.has(d.path)) continue;
      const old = input.renames.get(d.path);
      const u = old !== undefined ? byPath.get(old) : undefined;
      if (u && free(u)) put(d.path, u, 'D1', undefined, old);
    }
  /** D0 paths read this scan → their overlap with the old version, null when there is too little text to judge. */
  const d0 = new Map<string, number | null>();
  for (const d of snap) {
    const u = byPath.get(d.path);
    if (!u || claimedDoc.has(u)) continue;
    put(d.path, u, 'D0');
    const old = input.sketch(u);
    const now = sk(d);
    if (d.items !== null) d0.set(d.path, old && now && Math.min(old.n, now.n) >= L.containMin ? docSim(old, now) : null);
  }
  if (input.renames)
    for (const d of snap) {
      if (placed(d.path)) continue;
      const old = input.renames.get(d.path);
      const u = old !== undefined ? byPath.get(old) : undefined;
      if (u && free(u)) put(d.path, u, 'D1', undefined, old);
    }
  /** D0 did not hold: the path is asked about ('same document?'), its items wait under '?path'. */
  const revoke = (path: string, score: number) => {
    const u = docDec.get(path)!.uid!;
    claimedDoc.delete(u);
    docDec.set(path, { uid: null, how: 'unresolved', cands: [{ uid: u, score: round(score), why: ['path'] }] });
    for (const c of cur) if (c.path === path) c.doc = `?${path}`;
  };
  const fmCount = new Map<string, number>();
  for (const d of snap) if (d.fmId) fmCount.set(d.fmId, (fmCount.get(d.fmId) ?? 0) + 1);
  for (const d of snap) {
    if (placed(d.path) || !d.fmId || fmCount.get(d.fmId) !== 1) continue;
    const c = Object.keys(reg.docs).filter((u) => reg.docs[u].fmId === d.fmId && free(u));
    if (c.length !== 1) continue;
    const r = reg.docs[c[0]];
    const sameName = r.path.split('/').pop() === d.path.split('/').pop();
    const old = input.sketch(c[0]);
    if (sameName || (old && sk(d) && docSim(old, sk(d)!) >= L.d2Overlap)) put(d.path, c[0], 'D2', undefined, r.path);
  }
  const docOfPath = (p: string) => docDec.get(p)?.uid ?? `?${p}`;

  // ── Items ──
  const cur: Cur[] = snap.flatMap((d) =>
    (d.items ?? []).map((it) => ({ it, path: d.path, doc: docOfPath(d.path), mat: textMat(input.hash, it.body, bodyText(it.title), it.displayId) })),
  );
  const dec = new Map<number, Dec>();
  const claimed = new Set<string>();
  const accept = (ci: number, uid: string, how: ItemHow, score?: number, dup?: boolean) => {
    dec.set(ci, { uid, how, score, dup });
    claimed.add(uid);
  };
  const rec = (u: string) => reg.items[u];
  const samePath = (i: number, j: number) => j >= 0 && j < cur.length && cur[j].path === cur[i].path;
  // The candidates of an open question wait for the owner: no item takes them meanwhile (they stay contested).
  const asked = new Set<string>();
  for (const r of Object.values(reg.items))
    if (r.state === 'unresolved') for (const c of r.candidates ?? []) if (reg.items[c.uid] && reg.items[c.uid].state !== 'active') asked.add(c.uid);

  // T1: identical text, one on each side (a short one only inside its document).
  const byHash = new Map<string, { c: number[]; r: string[] }>();
  cur.forEach((c, i) => {
    const g = byHash.get(c.it.textHash) ?? { c: [], r: [] };
    g.c.push(i);
    byHash.set(c.it.textHash, g);
  });
  for (const u of pool) byHash.get(rec(u).textHash)?.r.push(u);
  const dups: Array<{ c: number[]; r: string[] }> = [];
  for (const g of byHash.values()) {
    if (!g.r.length) continue;
    const short = cur[g.c[0]].mat.len < L.shortText;
    if (g.c.length === 1 && g.r.length === 1) {
      if ((!short || rec(g.r[0]).doc === cur[g.c[0]].doc) && !asked.has(g.r[0])) accept(g.c[0], g.r[0], 'T1');
    } else dups.push(g);
  }
  // T1n (SPT 0.3): identical text more than once pairs only where both neighbours match too.
  // An undecided neighbour matches a record's neighbour of the same text (two identical items in a row).
  const nbOk = (j: number | null, ru: string | undefined) =>
    j === null ? ru === undefined : dec.has(j) ? dec.get(j)!.uid === ru : !!ru && rec(ru)?.textHash === cur[j].it.textHash;
  const neighbours = (i: number, ru: string) => {
    const { prev, next } = rec(ru).locator;
    return nbOk(samePath(i, i - 1) ? i - 1 : null, prev) && nbOk(samePath(i, i + 1) ? i + 1 : null, next);
  };
  const pairDups = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const g of dups)
        for (const c of g.c) {
          if (dec.has(c)) continue;
          const m = g.r.filter((u) => !claimed.has(u) && !asked.has(u) && neighbours(c, u));
          if (m.length === 1) {
            accept(c, m[0], 'T1n', undefined, true);
            changed = true;
          }
        }
    }
  };
  pairDups();
  const inDup = new Set(dups.flatMap((g) => g.c));

  // ── D0 continuity, first look (SPT 0.3): its text came from other documents and not from its own: not the same document ──
  for (const [path] of d0) {
    const u = docDec.get(path)!.uid!;
    const old = (recsOf.get(u) ?? []).filter((r) => rec(r).state === 'active');
    let cont = 0;
    let foreign = 0;
    cur.forEach((c, i) => {
      if (c.path !== path || !dec.has(i)) return;
      if (rec(dec.get(i)!.uid).doc === u) cont++;
      else foreign++;
    });
    if (foreign > cont && !(old.length && cont / old.length >= L.d0Items)) revoke(path, d0.get(path) ?? 0);
  }

  // ── Template shingles (in more than max(3, 10%) of the snapshot's items) are left out of T2/T3 ──
  let df: Map<number, number> | null = null;
  const filtered = new WeakMap<Set<number>, Set<number>>();
  const f = (x: Set<number>) => {
    if (!df) {
      df = new Map();
      const sets = [...cur.map((c) => c.mat.set), ...[...fixed].flatMap((u) => input.mat(u)?.set ?? [])];
      for (const s of sets) for (const v of s) df.set(v, (df.get(v) ?? 0) + 1);
    }
    const stopAt = Math.max(L.stopMin, L.stopShare * (cur.length + fixed.size));
    let v = filtered.get(x);
    if (!v) {
      v = new Set([...x].filter((t) => (df!.get(t) ?? 0) <= stopAt));
      if (!v.size) v = x;
      filtered.set(x, v);
    }
    return v;
  };
  const sim = (a: Set<number>, b: Set<number>) => jaccard(f(a), f(b));

  // ── D3: what is still unplaced, by content and by where its items came from ──
  const freeDocs = Object.keys(reg.docs).filter(free);
  const dpairs: Array<{ path: string; u: string; score: number }> = [];
  for (const d of snap) {
    if (placed(d.path)) continue;
    const idx = cur.map((c, i) => [c, i] as const).filter(([c]) => c.path === d.path);
    for (const u of freeDocs) {
      const old = input.sketch(u);
      const textS = old && sk(d) ? docScore(old, sk(d)!) : 0;
      const from = idx.filter(([, i]) => dec.has(i) && rec(dec.get(i)!.uid).doc === u).length;
      const ov = idx.length >= 2 ? from / idx.length : 0;
      const score = Math.max(textS, ov);
      if (score >= L.d3Low) dpairs.push({ path: d.path, u, score });
    }
  }
  dpairs.sort((x, y) => y.score - x.score);
  for (const p of dpairs) {
    if (placed(p.path) || claimedDoc.has(p.u)) continue;
    const rivals = dpairs.filter((q) => (q.path === p.path && q.u !== p.u && !claimedDoc.has(q.u)) || (q.u === p.u && q.path !== p.path && !placed(q.path)));
    const second = Math.max(0, ...rivals.map((q) => q.score));
    if (p.score >= L.d3Accept && p.score - second >= L.d3Margin - SPEC_SCORE_EPSILON) put(p.path, p.u, 'D3', p.score, reg.docs[p.u].path);
    else if (!docDec.has(p.path))
      docDec.set(p.path, {
        uid: null,
        how: 'unresolved',
        cands: [p, ...rivals.filter((q) => q.path === p.path)].map((q) => ({ uid: q.u, score: round(q.score), why: ['content'] as Why[] })),
      });
  }
  for (const c of cur) if (c.doc.startsWith('?') && placed(c.path)) c.doc = docDec.get(c.path)!.uid!;

  // ── T2: the same display ID (in the document's lineage, else unique in the project), with the reuse check ──
  const ids = new Map<string, number>();
  const idsIn = new Map<string, number>();
  for (const c of cur)
    if (c.it.displayId) {
      ids.set(c.it.displayId, (ids.get(c.it.displayId) ?? 0) + 1);
      idsIn.set(`${c.doc}|${c.it.displayId}`, (idsIn.get(`${c.doc}|${c.it.displayId}`) ?? 0) + 1);
    }
  for (const u of fixed) if (currentId(rec(u))) ids.set(currentId(rec(u)), (ids.get(currentId(rec(u))) ?? 0) + 1);
  const recBy = new Map<string, string[]>();
  for (const u of pool) if (!claimed.has(u) && currentId(rec(u))) recBy.set(currentId(rec(u)), [...(recBy.get(currentId(rec(u))) ?? []), u]);
  const s = (u: string, c: Cur) => {
    const m = input.mat(u);
    return m ? sim(m.set, c.mat.set) : 0;
  };
  const conflict = (i: number, u: string) => dec.set(i, { uid: '', how: 'reuse', ask: 'reuse', score: round(s(u, cur[i])), cands: [{ uid: u, score: round(s(u, cur[i])), why: ['sameId'] }] });
  // The item's own text continues another free record (an ID-reuse chain: 002 renumbered to 001): not T2.
  const continues = (i: number, u: string): string | null => {
    const c = cur[i];
    const own = s(u, c);
    for (const r of pool) {
      if (r === u || claimed.has(r)) continue;
      if (rec(r).textHash === c.it.textHash) return r;
      const m = input.mat(r);
      if (m && sim(m.set, c.mat.set) >= L.accept && sim(m.set, c.mat.set) > own) return r;
    }
    return null;
  };
  /** Items T2 left for T3 because their text continues another record: a question when T3 does not settle them. */
  const suspect = new Map<number, [string, string]>();
  const take = (i: number, u: string, how: ItemHow) => {
    if (asked.has(u)) return;
    const o = continues(i, u);
    if (o) suspect.set(i, [u, o]);
    else accept(i, u, how, round(s(u, cur[i])));
  };
  cur.forEach((c, i) => {
    const id = c.it.displayId;
    if (dec.has(i) || !id) return;
    const all = (recBy.get(id) ?? []).filter((u) => !claimed.has(u));
    const sameAll = all.filter((u) => rec(u).doc === c.doc);
    const live = sameAll.filter((u) => rec(u).state !== 'retired');
    const same = live.length ? live : sameAll;
    const ok = (u: string, floor: number) => {
      const m = input.mat(u);
      return c.mat.tomb || !!m?.tomb || s(u, c) >= floor || (!!m?.tu && sim(m.tset, c.mat.tset) >= L.t2Title);
    };
    // The old text now lives under another current item: the ID was reused, not reworded.
    const reused = (u: string) => {
      const m = input.mat(u);
      return !!m && cur.some((o, j) => j !== i && !dec.has(j) && sim(o.mat.set, m.set) >= L.t2Reused);
    };
    if (same.length === 1 && idsIn.get(`${c.doc}|${id}`) === 1) {
      const u = same[0];
      // Its text is another record's: T3 places it (or asks), whatever the ID says.
      const o = continues(i, u);
      if (o) return void suspect.set(i, [u, o]);
      const weak = s(u, c) < L.t2Weak && !c.mat.tomb && !input.mat(u)?.tomb;
      if (weak && reused(u)) conflict(i, u);
      else if (ok(u, L.t2Same)) take(i, u, 'T2');
      else if (!reused(u)) take(i, u, 'T2r');
      else conflict(i, u);
    } else if (!same.length && all.length === 1 && ids.get(id) === 1) {
      // Across documents only for an ID the project defines once (SPT §2.5: a repeating table does not switch off the lineage's T2).
      if (ok(all[0], L.t2Other)) take(i, all[0], 'T2');
      else conflict(i, all[0]);
    }
  });
  pairDups(); // a neighbour T2 just placed can settle identical texts

  // ── D0 continuity, second look: overlap under d0Overlap and fewer than half the old items continuing (T1 or T2): ask ──
  for (const [path, overlap] of d0) {
    if (overlap === null || overlap >= L.d0Overlap || docDec.get(path)?.how !== 'D0') continue;
    const u = docDec.get(path)!.uid!;
    const old = (recsOf.get(u) ?? []).filter((r) => rec(r).state === 'active');
    const kept = cur.filter((c, i) => c.path === path && dec.has(i) && ['T1', 'T1n', 'T2', 'T2r'].includes(dec.get(i)!.how) && old.includes(dec.get(i)!.uid)).length;
    if (old.length && kept / old.length >= L.d0Items) continue;
    revoke(path, overlap);
  }

  // ── T3: the scored rest (body, title, same document, neighbours), with threshold and margin ──
  const rest = pool.filter((u) => !claimed.has(u) && input.mat(u));
  const nb = (i: number) => ({
    p: samePath(i, i - 1) ? dec.get(i - 1)?.uid : undefined,
    n: samePath(i, i + 1) ? dec.get(i + 1)?.uid : undefined,
  });
  type Pair = { c: number; u: string; score: number; why: Why[] };
  const pairs: Pair[] = [];
  /** Per item, its best candidate under `low` but from `maybeLow` ('어쩌면 같은 것' if the item ends new and the candidate retired). */
  const maybe = new Map<number, Pair>();
  cur.forEach((c, i) => {
    if (dec.has(i)) return;
    const near = nb(i);
    for (const u of rest) {
      const m = input.mat(u)!;
      const r = rec(u);
      const body = sim(c.mat.set, m.set);
      const t = c.mat.tu && m.tu ? sim(c.mat.tset, m.tset) : 0;
      const base = Math.max(body, L.titleWeight * t + (1 - L.titleWeight) * body);
      if (base < L.low - L.prefilter) continue;
      const sameDoc = r.doc === c.doc;
      const nbs = (near.p && near.p === r.locator.prev ? 0.5 : 0) + (near.n && near.n === r.locator.next ? 0.5 : 0);
      let score = base + (sameDoc ? L.sameDocBonus : 0) + L.neighbourBonus * nbs;
      // Moved AND rewritten: the title alone never confirms it.
      if (body < L.crossDocBody && !sameDoc && !nbs) score = Math.min(score, L.accept - 0.01);
      if (r.state === 'retired') score -= L.retiredPenalty;
      const why: Why[] = [];
      if (body >= L.t2Same) why.push('text');
      if (t >= L.t2Title) why.push('title');
      if (sameDoc) why.push('sameDoc');
      if (nbs) why.push('neighbours');
      if (c.it.displayId && c.it.displayId === currentId(r)) why.push('sameId');
      if (r.state === 'retired') why.push('retired');
      if (score >= L.low) pairs.push({ c: i, u, score, why });
      else if (score >= L.maybeLow && score > (maybe.get(i)?.score ?? 0)) maybe.set(i, { c: i, u, score, why }); // kept if it ends retired
    }
  });
  pairs.sort((x, y) => y.score - x.score);
  const contested = new Set<string>(asked);
  const byC = new Map<number, Pair[]>();
  const byR = new Map<string, Pair[]>();
  for (const p of pairs) {
    byC.set(p.c, [...(byC.get(p.c) ?? []), p]);
    byR.set(p.u, [...(byR.get(p.u) ?? []), p]);
  }
  for (const p of pairs) {
    if (dec.has(p.c) || claimed.has(p.u)) continue;
    const rivalsR = (byC.get(p.c) ?? []).filter((q) => q.u !== p.u && !claimed.has(q.u));
    const rivalsC = (byR.get(p.u) ?? []).filter((q) => q.c !== p.c && !dec.has(q.c));
    const second = Math.max(0, ...rivalsR.map((q) => q.score), ...rivalsC.map((q) => q.score));
    if (!contested.has(p.u) && p.score >= L.accept && p.score - second >= L.margin - SPEC_SCORE_EPSILON) {
      accept(p.c, p.u, 'T3', round(p.score));
      continue;
    }
    const cands = [p, ...rivalsR].filter((q) => p.score - q.score < L.margin || q === p);
    dec.set(p.c, { uid: '', how: 'unresolved', ask: 'item', score: round(p.score), dup: inDup.has(p.c), cands: cands.map((q) => ({ uid: q.u, score: round(q.score), why: q.why })) });
    for (const q of cands) contested.add(q.u);
  }
  // ── Post-processing ──
  for (const [i, [u, o]] of suspect)
    if (!dec.has(i)) dec.set(i, { uid: '', how: 'reuse', ask: 'reuse', cands: [{ uid: u, score: round(s(u, cur[i])), why: ['sameId'] }, { uid: o, score: round(s(o, cur[i])), why: ['text'] }] });
  for (const [i, d] of dec) {
    // An ID conflict whose old record went to the moved text is a confirmed new item.
    if (d.how === 'reuse' && d.cands?.every((c) => claimed.has(c.uid))) dec.set(i, { uid: '', how: 'new' });
    // Short repeated boilerplate (a "테스트" checkbox twice) is new, not a question.
    else if (d.how === 'unresolved' && d.dup && cur[i].mat.len < L.shortText) dec.set(i, { uid: '', how: 'new' });
  }
  return { docDec, cur, dec, fixed, pool, maybe };
}

/**
 * Match `input` into `reg` (its docs and items, changed in place). A moveOnly document nothing
 * matched is dropped and the ladder runs again without it (its items must not claim anything).
 */
export function matchSnapshot(reg: { docs: Record<string, DocRecord>; items: Record<string, ItemRecord> }, input: MatchInput): MatchResult {
  let docs = input.docs;
  let run = ladder(reg, input);
  const dropped = docs.filter((d) => d.moveOnly && !run.docDec.get(d.path)?.uid && run.docDec.get(d.path)?.how !== 'unresolved').map((d) => d.path);
  if (dropped.length) {
    docs = docs.filter((d) => !dropped.includes(d.path));
    run = ladder(reg, { ...input, docs });
  }
  const { docDec, cur, dec, fixed, pool, maybe } = run;
  const { rev, at } = input;
  const snapOf = new Map(docs.map((d) => [d.path, d]));

  // ── Documents ──
  const docOf = new Map<string, string>();
  const claimedDocs = new Set<string>();
  for (const d of docs) {
    const dd = docDec.get(d.path);
    if (dd?.uid) {
      const r = reg.docs[dd.uid];
      const moved = r.path !== d.path;
      if (moved || r.state === 'retired') {
        pushMax(r.pathHistory, { path: d.path, rev, how: dd.how }, SPEC_PATH_HISTORY_MAX);
        pushMax(r.decisions, { rev, how: dd.how, by: 'engine', at, ...(dd.score !== undefined && { score: round(dd.score) }) }, SPEC_DECISIONS_MAX);
      }
      r.path = d.path;
      if (r.state === 'retired') r.state = 'active';
      if (d.fmId) r.fmId = d.fmId;
      else delete r.fmId;
      docOf.set(d.path, dd.uid);
      claimedDocs.add(dd.uid);
      continue;
    }
    const unresolved = dd?.how === 'unresolved';
    const u = input.newDoc(d, unresolved);
    const r = reg.docs[u];
    if (d.fmId) r.fmId = d.fmId;
    if (unresolved) {
      r.state = 'unresolved';
      r.candidates = dd!.cands;
      pushMax(r.decisions, { rev, how: 'unresolved', by: 'engine', at }, SPEC_DECISIONS_MAX);
    }
    docOf.set(d.path, u);
    claimedDocs.add(u);
  }
  for (const [u, r] of Object.entries(reg.docs))
    if (r.tracked && r.state !== 'retired' && !claimedDocs.has(u)) {
      r.state = 'retired';
      pushMax(r.decisions, { rev, how: 'retired', by: 'engine', at }, SPEC_DECISIONS_MAX);
    }

  // ── Items ──
  const uids = cur.map((_, i) => {
    let d = dec.get(i);
    if (!d) dec.set(i, (d = { uid: '', how: 'new' }));
    if (!d.uid) d.uid = input.newItem();
    return d.uid;
  });
  const itemsOf = new Map<string, string[]>();
  cur.forEach((c, i) => {
    const d = dec.get(i)!;
    const doc = docOf.get(c.path)!;
    const prev = reg.items[d.uid];
    const id = c.it.displayId ?? '';
    const pendingDoc = reg.docs[doc].state === 'unresolved' && d.how === 'new';
    const state: ItemRecord['state'] =
      d.how === 'unresolved' || d.how === 'reuse' || pendingDoc || (prev?.state === 'unresolved' && d.how !== 'new') ? 'unresolved' : 'active';
    const locator = {
      line: c.it.line,
      ordinal: c.it.ordinal,
      parent: c.it.parent,
      ...(samePath(i, i - 1) && { prev: uids[i - 1] }),
      ...(samePath(i, i + 1) && { next: uids[i + 1] }),
    };
    const decision = {
      rev,
      how: d.how,
      by: 'engine' as const,
      at,
      ...(d.score !== undefined && { score: d.score }),
      ...(prev && prev.textHash !== c.it.textHash && { was: prev.textHash }),
      ...(prev && currentId(prev) !== id && { wasId: currentId(prev) }),
      ...(!prev && d.how === 'new' && snapOf.get(c.path)?.first ? { first: true as const } : {}),
    };
    if (!prev) {
      reg.items[d.uid] = {
        doc,
        kind: c.it.shape,
        state,
        displayIds: id ? [{ id, rev }] : [],
        textHash: c.it.textHash,
        locator,
        firstRev: rev,
        lastRev: rev,
        decisions: [decision],
        ...(d.cands && { candidates: d.cands, ask: d.ask }),
      };
    } else {
      const changed = prev.state !== state || prev.textHash !== c.it.textHash || currentId(prev) !== id || prev.doc !== doc;
      if (changed) pushMax(prev.decisions, decision, SPEC_DECISIONS_MAX);
      if (currentId(prev) !== id) pushMax(prev.displayIds, { id, rev }, SPEC_DECISIONS_MAX);
      Object.assign(prev, { doc, kind: c.it.shape, state, textHash: c.it.textHash, locator, lastRev: rev });
      if (state !== 'unresolved') {
        delete prev.candidates;
        delete prev.ask;
      }
    }
    itemsOf.set(doc, [...(itemsOf.get(doc) ?? []), d.uid]);
  });
  // What nothing took retires; its UID is never given to another item.
  const seen = new Set([...uids, ...fixed]);
  for (const u of pool)
    if (!seen.has(u) && reg.items[u] && reg.items[u].state !== 'retired') {
      reg.items[u].state = 'retired';
      delete reg.items[u].candidates;
      delete reg.items[u].ask;
      pushMax(reg.items[u].decisions, { rev, how: 'retired', by: 'engine', at }, SPEC_DECISIONS_MAX);
    }
  // '어쩌면 같은 것': a new item (not a first read) whose low-scored candidate is still retired after this match.
  for (const [i, m] of maybe) {
    const d = dec.get(i)!;
    const r = reg.items[d.uid];
    if (d.how !== 'new' || !r || r.decisions.length !== 1 || r.decisions[0].first || reg.items[m.u]?.state !== 'retired') continue;
    r.maybe = [{ uid: m.u, score: round(m.score), why: m.why }];
  }
  return { docOf, itemsOf, dropped };

  function samePath(i: number, j: number) {
    return j >= 0 && j < cur.length && cur[j].path === cur[i].path;
  }
}
