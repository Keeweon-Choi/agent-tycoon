/**
 * SPT-P2 §4.3: a project's Link Store, `<settings directory>/spec/<projectId>/links.json` (0600 in
 * 0700, tmp + rename, `v:1`; the daemon is the only writer; backed up by name). It holds the owner's
 * decisions only: confirmed and rejected links, deploy confirmations, and their history. Observed
 * and suggested links are computed from the sources on every read and never stored. A file this
 * store cannot read is `corrupt`: left as it is, never written over, every link write refused.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { EvidenceKind, LinkRel, NodeRef } from '../../../../core/src/cld/spec/trace.js';
import { opaqueId } from '../engine/registry.js';
import { readJson, writeJsonAtomic } from '../jsonFile.js';
import { specDirectory } from './store.js';

export const LINKS_VERSION = 1;
export const LINK_ID_RE = /^l_[a-z2-7]{10}$/;
export const LINK_RELS = ['implements', 'changes', 'verifies', 'discusses', 'realizes', 'refs'] as const;
export const EVIDENCE_KINDS = ['unit', 'integration', 'deploy', 'other'] as const;

/** The other end each relation names (SPT §4.3's table). */
export const END_OF: Record<LinkRel, NodeRef['t']> = {
  implements: 'task',
  changes: 'commit',
  verifies: 'job',
  discusses: 'msg',
  realizes: 'comp',
  refs: 'req',
};

export interface LinkBy {
  kind: 'owner' | 'agent';
  name: string;
  device?: string;
}

export interface SpecLink {
  id: string;
  /** Always the requirement (req ↔ req: the smaller UID). */
  from: { t: 'req'; uid: string };
  to: NodeRef;
  rel: LinkRel;
  status: 'confirmed' | 'rejected';
  by: LinkBy;
  at: string;
  /** The requirement's version when decided: link review compares `textHash` with now. */
  basis: { textHash: string; docBlob: string; note?: string };
  /** for 'verifies' */
  kind?: EvidenceKind;
}

/** 배포 확인: the owner says the deploy a verifies(deploy) job ran is live. */
export interface DeployConfirm {
  job: string;
  by: LinkBy;
  at: string;
  note?: string;
}

export type LinkAction = 'confirmed' | 'rejected' | 'added' | 'edited' | 'unlinked' | 'reviewed' | 'deployConfirmed';
export interface LinkEvent {
  at: string;
  /** The requirement it is about. */
  uid: string;
  action: LinkAction;
  /** The other end's id (a Task, a commit, a job, a UID), never text. */
  detail?: string;
  by: LinkBy;
}

export interface LinkFile {
  v: typeof LINKS_VERSION;
  /** Bumped on every save; `specChanged` carries the Registry's rev plus this one. */
  rev: number;
  links: SpecLink[];
  deploys: DeployConfirm[];
  history: LinkEvent[];
}

export const linksFile = (home: string, projectId: string): string => path.join(specDirectory(home, projectId), 'links.json');
export const createLinkId = (): string => opaqueId('l');
export const emptyLinks = (): LinkFile => ({ v: LINKS_VERSION, rev: 0, links: [], deploys: [], history: [] });

/** A NodeRef as the trace's node id: a UID, a Task id, a full SHA, a job id. */
export const refId = (r: NodeRef): string => (r.t === 'req' || r.t === 'comp' ? r.uid : r.t === 'commit' ? r.sha : r.t === 'msg' ? `${r.where}:${r.id}` : r.id);
/** One key per (requirement, other end, relation): a decision replaces an earlier one. */
export const linkKey = (from: string, to: string, rel: LinkRel): string => `${from}>${rel}>${to}`;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validRef = (r: unknown): r is NodeRef => {
  if (!isObject(r)) return false;
  if (r.t === 'req' || r.t === 'comp') return typeof r.uid === 'string';
  if (r.t === 'commit') return typeof r.sha === 'string';
  if (r.t === 'task' || r.t === 'job') return typeof r.id === 'string';
  return r.t === 'msg' && typeof r.where === 'string' && typeof r.id === 'string';
};
const validBy = (b: unknown): b is LinkBy => isObject(b) && (b.kind === 'owner' || b.kind === 'agent') && typeof b.name === 'string';
function validLink(l: unknown): l is SpecLink {
  return (
    isObject(l) &&
    typeof l.id === 'string' &&
    LINK_ID_RE.test(l.id) &&
    isObject(l.from) &&
    l.from.t === 'req' &&
    typeof l.from.uid === 'string' &&
    validRef(l.to) &&
    (LINK_RELS as readonly unknown[]).includes(l.rel) &&
    (l.status === 'confirmed' || l.status === 'rejected') &&
    validBy(l.by) &&
    typeof l.at === 'string' &&
    isObject(l.basis) &&
    typeof l.basis.textHash === 'string' &&
    typeof l.basis.docBlob === 'string' &&
    (l.kind === undefined || (EVIDENCE_KINDS as readonly unknown[]).includes(l.kind))
  );
}

export type LoadedLinks = { links: LinkFile; corrupt: string | null };

/** The project's links (none yet: empty); corrupt (why) when the file is not one, then an empty view that is never saved. */
export function readLinks(file: string): LoadedLinks {
  let raw: unknown;
  try {
    raw = readJson(file);
  } catch (err) {
    return { links: emptyLinks(), corrupt: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null) return { links: emptyLinks(), corrupt: null };
  if (!isObject(raw) || raw.v !== LINKS_VERSION || typeof raw.rev !== 'number' || !Array.isArray(raw.links))
    return { links: emptyLinks(), corrupt: `not a v${LINKS_VERSION} links file` };
  const bad = raw.links.findIndex((l) => !validLink(l));
  if (bad >= 0) return { links: emptyLinks(), corrupt: `a bad link record (#${bad})` };
  // The extras: a value of the wrong shape is dropped, never a reason to refuse the file.
  const deploys = Array.isArray(raw.deploys) ? raw.deploys.filter((d): d is DeployConfirm => isObject(d) && typeof d.job === 'string' && validBy(d.by) && typeof d.at === 'string') : [];
  const history = Array.isArray(raw.history) ? raw.history.filter((h): h is LinkEvent => isObject(h) && typeof h.at === 'string' && typeof h.uid === 'string' && typeof h.action === 'string' && validBy(h.by)) : [];
  return { links: { v: LINKS_VERSION, rev: raw.rev, links: raw.links as SpecLink[], deploys, history }, corrupt: null };
}

/** Write a spec sidecar file (0600 via tmp + rename) with its folders 0700. */
export function writeSpecJson(file: string, data: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(dir), 0o700);
  fs.chmodSync(dir, 0o700);
  writeJsonAtomic(file, data, 0);
}
export const writeLinks = (file: string, links: LinkFile): void => writeSpecJson(file, links);
