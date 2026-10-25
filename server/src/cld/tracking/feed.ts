/**
 * U-48 phase 1: the office's side of the tracked items. A refresh runs only while
 * someone views (`watching`), builds the Tracker's input from the office's world
 * (which project each session belongs to) and the engine's Codex tasks, and
 * broadcasts one `trackedItems` message per project whose items changed. Results
 * live in memory; `clear()` (the last viewer left) drops all of it.
 */
import type { CodexTask, TrackedItems, TrackingProjectSettings, TrackingSources } from '../../../../core/src/messages.js';
import type { AgentEntry } from '../providers/types.js';
import { DocTracker, resolveDocs } from './docTracker.js';
import { type SettingsError, trackingPath, TrackingSettingsStore } from './settings.js';
import { type TrackCodex, Tracker,type TrackSession } from './tracker.js';

const STALE = '';
const DOCS_FOLLOW_UP_MS = 200;
/** The documents found that a settings answer lists at most. */
export const FOUND_SENT_MAX = 200;

export interface FeedDeps {
  home: string;
  /** Viewers whose page is showing; 0 = nothing is read. */
  watching: () => number;
  broadcast: (msg: TrackedItems) => void;
  /** The engine's project for an engine agent (its assignment), else the project folder holding `cwd`; null = not ours. */
  projectOf: (agent: Pick<AgentEntry, 'key' | 'name' | 'dir'>) => string | null;
  /** Where a Codex task works (its record's dir), or null. */
  codexDir: (id: string) => string | null;
  /** U-48 phase 2a: the projects whose folders hold documents to read. */
  projects?: () => Array<{ name: string; folder: string }>;
  /** The board's Task ids (a document line defining one goes under that Task's card). */
  taskIds?: () => ReadonlySet<string>;
  now?: () => number;
}

type CodexInput = ReadonlyArray<Pick<CodexTask, 'id' | 'project' | 'state' | 'ended'>>;

export class TrackingFeed {
  private readonly tracker: Tracker;
  private readonly docs = new DocTracker();
  readonly settings: TrackingSettingsStore;
  /** A follow-up refresh while documents are left unread (DocTracker.pending). */
  private followUp: ReturnType<typeof setTimeout> | null = null;
  /** project -> the "켤까요?" candidates its settings last opened with. */
  private readonly candidates = new Map<string, string[]>();
  /** The last refresh's input, so a settings change shows at once. */
  private lastInput: { agents: readonly AgentEntry[]; codex: CodexInput } | null = null;
  /** project -> the message last sent (JSON), or STALE: sent before the office slept, so the page may still show it. */
  private readonly sent = new Map<string, string>();
  private readonly codexDirs = new Map<string, string | null>();
  /** How long the last refresh took (ms), for the footprint numbers. */
  lastMs = 0;

  constructor(private readonly deps: FeedDeps) {
    this.tracker = new Tracker(deps.home);
    this.settings = new TrackingSettingsStore(trackingPath(deps.home));
  }

  get reads(): number {
    return this.tracker.reads + this.docs.reads;
  }

  refresh(agents: readonly AgentEntry[], codex: CodexInput): void {
    if (this.deps.watching() === 0) return;
    this.lastInput = { agents, codex };
    const t0 = performance.now();
    const sessions: TrackSession[] = [];
    for (const a of agents) {
      if (!a.sessionId) continue;
      const project = this.deps.projectOf(a);
      if (project) sessions.push({ sessionId: a.sessionId, name: a.title || a.name, project, live: a.state === 'running', busy: a.busy });
    }
    const runs: TrackCodex[] = [];
    for (const c of codex) {
      if (c.project === '?') continue;
      if (!this.codexDirs.has(c.id)) this.codexDirs.set(c.id, this.deps.codexDir(c.id));
      const dir = this.codexDirs.get(c.id);
      if (dir) runs.push({ id: c.id, project: c.project, state: c.state, dir, ended: c.ended ?? null });
    }
    const now = this.deps.now?.() ?? Date.now();
    const byProject = this.tracker.refresh({ sessions, codex: runs, now });
    const projects = (this.deps.projects?.() ?? []).map((p) => ({ ...p, settings: this.settings.get(p.name) }));
    for (const [project, d] of this.docs.refresh(projects, this.deps.taskIds?.() ?? new Set(), now)) {
      const p = byProject.get(project);
      if (p) {
        p.items.push(...d.items);
        p.more.push(...d.more);
      } else byProject.set(project, d);
    }
    for (const [project, { items, more }] of byProject) this.send(project, items, more);
    for (const project of [...this.sent.keys()]) if (!byProject.has(project)) this.send(project, [], []);
    this.lastMs = performance.now() - t0;
    // Documents left over (a cold start at the limits): read on in a moment, only while someone views.
    if (this.docs.pending && !this.followUp) {
      this.followUp = setTimeout(() => {
        this.followUp = null;
        if (this.lastInput) this.refresh(this.lastInput.agents, this.lastInput.codex);
      }, DOCS_FOLLOW_UP_MS);
      this.followUp.unref?.();
    }
  }

  private send(project: string, items: TrackedItems['items'], more: NonNullable<TrackedItems['more']>): void {
    const msg: TrackedItems = { type: 'trackedItems', project, items, ...(more.length && { more }) };
    const json = JSON.stringify(msg);
    if (this.sent.get(project) === json) return;
    if (items.length === 0) this.sent.delete(project);
    else this.sent.set(project, json);
    this.deps.broadcast(msg);
  }

  /** What a client that just connected needs. */
  snapshot(): TrackedItems[] {
    return [...this.sent.values()].filter((j) => j !== STALE).map((j) => JSON.parse(j) as TrackedItems);
  }

  /**
   * trackingSettings: change a project's document settings (when `canChange`), then answer
   * the sender with the settings, the documents found and the "켤까요?" candidates.
   */
  async onSettings(msg: Record<string, unknown>, send: (m: TrackingSources) => void, canChange: boolean): Promise<void> {
    const project = typeof msg.project === 'string' ? msg.project : '';
    const folder = this.deps.projects?.().find((p) => p.name === project)?.folder;
    const change = msg.settings !== undefined || msg.hide !== undefined;
    let error: SettingsError | null = null;
    if (!folder) error = 'project';
    else if (change && !canChange) error = 'denied';
    else if (msg.settings !== undefined)
      error =
        msg.settings && typeof msg.settings === 'object'
          ? this.settings.set(project, folder, msg.settings as TrackingProjectSettings)
          : 'path';
    else if (msg.hide !== undefined) error = this.settings.hide(project, msg.hide);
    const settings = this.settings.get(project);
    const found = folder
      ? resolveDocs(folder, settings).map((d) => {
          const items = this.docs.itemsOf(project, folder, d.path);
          return items === undefined ? d : { ...d, items };
        })
      : [];
    const known = new Set(found.map((d) => d.path));
    // The git query runs when the settings open; a change (a toggle, 숨기기) reuses that answer.
    const candidates = !folder
      ? []
      : change
        ? (this.candidates.get(project) ?? []).filter((c) => !known.has(c))
        : await this.docs.candidates(folder, settings, known);
    if (folder) this.candidates.set(project, candidates);
    send({
      type: 'trackingSources',
      project,
      settings,
      found: found.slice(0, FOUND_SENT_MAX),
      candidates,
      ...(error && { error }),
    });
    if (change && !error && this.lastInput) this.refresh(this.lastInput.agents, this.lastInput.codex);
  }

  /**
   * The last viewer looked away: the index and the items are dropped. The project names stay
   * (marked STALE) because a page that stays connected still shows them; the next refresh
   * sends an empty message to any that have nothing now.
   */
  clear(): void {
    this.tracker.clear();
    this.docs.clear();
    this.candidates.clear();
    this.lastInput = null;
    if (this.followUp) clearTimeout(this.followUp);
    this.followUp = null;
    for (const project of this.sent.keys()) this.sent.set(project, STALE);
    this.codexDirs.clear();
  }
}
