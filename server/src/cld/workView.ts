/**
 * The read-only work view of a temp (T-0056): what a sub-agent or a teammate
 * is doing, for a client that opened it from the character or
 * from the lead's "+N" list. Not a conversation: nothing here sends.
 *
 * Like the messenger (conversations.ts) it costs nothing while nobody looks:
 * a reader exists only while a client has its view open (at most MAX_OPEN_PER_CLIENT
 * per client, MAX_READERS per daemon), and polls with the office's chat timer.
 * Every string that leaves goes through the secret masker in `seal`, the one
 * choke point; nothing is masked anywhere else, so nothing can skip it.
 */
import * as fs from 'fs';
import * as path from 'path';

import { type Refused, refused } from '../../../core/src/cld/serverText.js';
import type { ChatItem, WorkKind } from '../../../core/src/messages.js';
import type { WsSend } from './hooks.js';
import { maskText } from './mask.js';
import { lineItems, spawnLineItems, TranscriptTail } from './transcriptView.js';

export const MAX_OPEN_PER_CLIENT = 2;
export const MAX_READERS = 8;
/** More than the messenger holds: a task's whole run is the point. */
export const WORK_MAX_ITEMS = 150;
const META_MAX_FILES = 400;
const META_MAX_BYTES = 8 * 1024;

export interface WorkTarget {
  kind: WorkKind;
  agentId?: number;
  id?: string;
}

/** What one poll found: the items (replacing, or `append`ed). */
export interface WorkDelta {
  items: ChatItem[];
  append?: boolean;
  title?: string;
}

export interface WorkReader {
  /** Catch up; null when nothing changed. */
  poll(): Promise<WorkDelta | null>;
  /** Everything it holds now (a client that just opened the view). */
  full(): WorkDelta;
}

const KINDS: readonly string[] = ['subagent', 'teammate'];
const ID_MAX = 200;

/** A well-formed workView: its target and on/off, or null. */
export function parseWorkView(
  msg: Record<string, unknown>,
): { target: WorkTarget; on: boolean } | null {
  const { kind, agentId, id, on } = msg;
  if (typeof on !== 'boolean' || typeof kind !== 'string' || !KINDS.includes(kind)) return null;
  if (agentId !== undefined && !Number.isInteger(agentId)) return null;
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > ID_MAX)) return null;
  const needsId = kind !== 'teammate';
  if (agentId === undefined || (needsId && id === undefined)) return null;
  return {
    on,
    target: {
      kind: kind as WorkKind,
      agentId: agentId as number,
      ...(needsId && { id: id as string }),
    },
  };
}

/** A reader for the target, or why there is none. */
export type WorkResolver = (t: WorkTarget) => WorkReader | Refused;

/** `file` is `root` or inside it, symlinks resolved (a missing file is outside). */
export function within(file: string, root: string): boolean {
  try {
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** The text a client may see: every field of a delta, masked. */
export function seal(d: WorkDelta): WorkDelta {
  const out: WorkDelta = {
    ...d,
    items: d.items.map((i) => ({ ...i, text: maskText(i.text) })),
  };
  if (d.title !== undefined) out.title = maskText(d.title);
  return out;
}

// ── Readers of Claude transcripts ────────────────────────────

/** One transcript file, a temp's own (sidechain top to bottom). `root`: where
 *  it must live (the lead's project dir, or the sessions root). */
export function fileReader(file: () => string | null, root: string): WorkReader {
  const tail = new TranscriptTail(WORK_MAX_ITEMS, (l, n) =>
    lineItems(l, n, { sidechain: true, results: true }),
  );
  const pick = () => {
    const f = file();
    return f && within(f, root) ? f : null;
  };
  return {
    async poll() {
      const d = tail.poll(pick());
      return d && { items: d.reset ? tail.items : d.added, append: !d.reset };
    },
    full: () => ({ items: tail.items }),
  };
}

/** The sub-agent's own transcript among a lead's sidecars:
 *  `<lead transcript minus .jsonl>/subagents/*.meta.json` naming the spawn's tool_use id. */
export class SidecarFinder {
  private found: string | null = null;
  private readonly seen = new Set<string>();
  constructor(
    private readonly leadTranscript: string,
    private readonly spawnId: string,
  ) {}

  get dir(): string {
    const { dir, name } = path.parse(this.leadTranscript);
    return path.join(dir, name, 'subagents');
  }

  /** The transcript file once a sidecar names the spawn, else null. Reads only sidecars not seen before. */
  find(): string | null {
    if (this.found && fs.existsSync(this.found)) return this.found;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return null;
    }
    for (const name of names.slice(0, META_MAX_FILES)) {
      if (!name.endsWith('.meta.json') || this.seen.has(name)) continue;
      const meta = path.join(this.dir, name);
      try {
        if (fs.statSync(meta).size > META_MAX_BYTES) {
          this.seen.add(name);
          continue;
        }
        const j = JSON.parse(fs.readFileSync(meta, 'utf8')) as { toolUseId?: unknown };
        this.seen.add(name);
        if (j.toolUseId !== this.spawnId) continue;
        const file = path.join(this.dir, name.replace(/\.meta\.json$/, '.jsonl'));
        if (!fs.existsSync(file)) {
          this.seen.delete(name); // the transcript is not written yet: look again
          continue;
        }
        return (this.found = file);
      } catch {
        // Torn or unreadable: look again next time.
      }
    }
    return null;
  }
}

/**
 * A sub-agent by its lead and the spawn's tool_use id: its sidecar transcript
 * when the harness wrote one (background spawns), else the sidechain records
 * the lead logged for it. Both stay inside the lead's project dir.
 */
export function subagentReader(leadTranscript: string, spawnId: string): WorkReader {
  const root = path.dirname(leadTranscript);
  const finder = new SidecarFinder(leadTranscript, spawnId);
  const inline = new TranscriptTail(WORK_MAX_ITEMS, (l, n) => spawnLineItems(l, spawnId, n));
  let own: WorkReader | null = null;
  const now = () => own ?? inlineView;
  const inlineView = {
    async poll(): Promise<WorkDelta | null> {
      const d = inline.poll(within(leadTranscript, root) ? leadTranscript : null);
      return d && { items: d.reset ? inline.items : d.added, append: !d.reset };
    },
    full: (): WorkDelta => ({ items: inline.items }),
  };
  return {
    async poll() {
      if (!own) {
        const file = finder.find();
        if (file) {
          own = fileReader(() => file, root);
          const first = await own.poll(); // a whole new view: replaces the inline one
          return first ?? { items: [] };
        }
      }
      return now().poll();
    },
    full: () => now().full(),
  };
}

// ── The views ────────────────────────────────────────────────

interface Open {
  target: WorkTarget;
  reader: WorkReader;
  sends: Set<WsSend>;
  /** Sends that still need the whole state. */
  fresh: Set<WsSend>;
}

const keyOf = (t: WorkTarget) => `${t.kind}:${t.agentId ?? ''}:${t.id ?? ''}`;

export class WorkViews {
  private readonly open = new Map<string, Open>();
  private polling = false;
  private again = false;

  constructor(
    private readonly resolve: WorkResolver,
    private readonly log: (line: string) => void = (l) => console.log(`[cld] work view: ${l}`),
  ) {}

  /** workView: open, or close. A refusal is answered with `error` and no items. */
  view(send: WsSend, target: WorkTarget, on: boolean): void {
    const key = keyOf(target);
    const entry = this.open.get(key);
    if (!on) {
      this.release(send, key);
      return;
    }
    if (entry?.sends.has(send)) return;
    const refuse = (why: Refused) =>
      send({ type: 'workContent', ...echo(target), items: [], ...why });
    const mine = [...this.open.values()].filter((o) => o.sends.has(send));
    if (mine.length >= MAX_OPEN_PER_CLIENT) {
      this.log(`${key} refused: ${MAX_OPEN_PER_CLIENT} already open`);
      return refuse(refused('work_view_limit', { max: MAX_OPEN_PER_CLIENT }));
    }
    if (entry) {
      entry.sends.add(send);
      entry.fresh.add(send);
    } else {
      if (this.open.size >= MAX_READERS) return refuse(refused('work_view_busy'));
      const reader = this.resolve(target);
      if ('error' in reader) return refuse(reader);
      this.open.set(key, {
        target,
        reader,
        sends: new Set([send]),
        fresh: new Set([send]),
      });
    }
    void this.poll();
  }

  /** A client left. */
  drop(send: WsSend): void {
    for (const key of [...this.open.keys()]) this.release(send, key);
  }

  get size(): number {
    return this.open.size;
  }

  private release(send: WsSend, key: string): void {
    const entry = this.open.get(key);
    if (!entry) return;
    entry.sends.delete(send);
    entry.fresh.delete(send);
    if (!entry.sends.size) this.open.delete(key);
  }

  /** Catch every open reader up and tell its clients (one poll at a time). */
  async poll(): Promise<void> {
    if (this.polling) {
      this.again = true; // a view opened meanwhile gets its answer right after
      return;
    }
    this.polling = true;
    try {
      for (const entry of [...this.open.values()]) {
        let delta: WorkDelta | null = null;
        try {
          delta = await entry.reader.poll();
        } catch (err) {
          this.log(`${keyOf(entry.target)}: ${err instanceof Error ? err.message : String(err)}`);
        }
        for (const send of entry.sends) {
          const first = entry.fresh.has(send);
          const body = first ? entry.reader.full() : delta;
          if (!body) continue;
          const out = seal(body);
          send({
            type: 'workContent',
            ...echo(entry.target),
            ...(out.title !== undefined && { title: out.title }),
            items: out.items,
            ...(!first && out.append && { append: true }),
          });
          entry.fresh.delete(send);
        }
      }
    } finally {
      this.polling = false;
    }
    if (this.again) {
      this.again = false;
      await this.poll();
    }
  }
}

export const echo = (t: WorkTarget) => ({
  kind: t.kind,
  ...(t.agentId !== undefined && { agentId: t.agentId }),
  ...(t.id !== undefined && { id: t.id }),
});
