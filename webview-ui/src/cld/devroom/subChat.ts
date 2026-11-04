/**
 * DEVROOM-SUBCHAT (owner 11-04 22:09): a sub-agent's transcript read like a messenger. What it said
 * stays as it is; the tool calls between two sayings fold into one summary line (kinds and counts),
 * a failed one stays visible, and the lead's task is a card on top. Pure: the view is SubTranscript.
 */
import type { ChatItem } from '../../../../core/src/messages.js';
import { DEVROOM_COMMIT_CHIP_CHARS, DEVROOM_OUTPUT_CHIPS_MAX } from '../../constants.js';

/** What a tool call is for, in the summary line's words. */
export type StepKind = 'command' | 'read' | 'edit' | 'other';
/** The summary line lists the kinds in this order. */
export const STEP_KINDS: readonly StepKind[] = ['command', 'read', 'edit', 'other'];

const KIND_OF: Record<string, StepKind> = {
  Bash: 'command',
  BashOutput: 'command',
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  LS: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
};
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export const stepKind = (toolName: string | undefined): StepKind => KIND_OF[toolName ?? ''] ?? 'other';

/** One tool call and what came back (absent while it runs). */
export interface Step {
  call: ChatItem;
  result?: ChatItem;
  /** The tool reported an error. */
  failed: boolean;
}

export type ChatBlock = { kind: 'say'; item: ChatItem } | { kind: 'steps'; id: string; steps: Step[] };

export interface Folded {
  /** The lead's task (the first user item). */
  prompt: ChatItem | null;
  blocks: ChatBlock[];
}

/**
 * Items to blocks: the sayings (assistant text, any later user text) in order, each run of tool
 * calls between them one `steps` block. A result joins the oldest call still waiting for one
 * (calls and results come in the same order); a result whose call fell out of the window is dropped.
 */
export function foldTranscript(items: readonly ChatItem[]): Folded {
  const blocks: ChatBlock[] = [];
  const waiting: Step[] = [];
  let prompt: ChatItem | null = null;
  for (const [i, item] of items.entries()) {
    if (item.kind === 'user' && i === 0) {
      prompt = item;
      continue;
    }
    if (item.kind === 'tool') {
      const step: Step = { call: item, failed: false };
      waiting.push(step);
      const last = blocks.at(-1);
      if (last?.kind === 'steps') last.steps.push(step);
      else blocks.push({ kind: 'steps', id: item.id, steps: [step] });
    } else if (item.kind === 'result') {
      const step = waiting.shift();
      if (step) {
        step.result = item;
        step.failed = item.failed === true;
      }
    } else blocks.push({ kind: 'say', item });
  }
  return { prompt, blocks };
}

/** Per kind, how many calls (kinds with none left out), in STEP_KINDS order. */
export function countSteps(steps: readonly Step[]): [StepKind, number][] {
  return STEP_KINDS.map((k): [StepKind, number] => [k, steps.filter((s) => stepKind(s.call.toolName) === k).length]).filter(
    ([, n]) => n > 0,
  );
}

const FAIL_WORD = /error|fail|✗|✖|not found|denied|cannot|exception/i;

/** The line of a failed result that says what went wrong: the first that names an error, else the first. */
export function failureHint(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => FAIL_WORD.test(l)) ?? lines[0] ?? '';
}

export const failedSteps = (steps: readonly Step[]): Step[] => steps.filter((s) => s.failed);

/** A deliverable: a file it wrote or changed, or a commit it made. */
export interface OutputChip {
  kind: 'file' | 'commit';
  label: string;
  /** The full path of a file. */
  title: string;
}

const COMMIT_LINE = /^\[[^\]\n]+ ([0-9a-f]{7,40})\]\s*(.*)$/m;

/** The files written and commits made by the calls that succeeded: each once, the first `DEVROOM_OUTPUT_CHIPS_MAX`. */
export function outputsOf(blocks: readonly ChatBlock[]): OutputChip[] {
  const out: OutputChip[] = [];
  const seen = new Set<string>();
  const add = (chip: OutputChip) => {
    if (!seen.has(`${chip.kind}:${chip.title}`)) {
      seen.add(`${chip.kind}:${chip.title}`);
      out.push(chip);
    }
  };
  for (const b of blocks) {
    if (b.kind !== 'steps') continue;
    for (const s of b.steps) {
      if (s.failed || !s.result) continue;
      const { toolName, args } = s.call;
      if (FILE_TOOLS.has(toolName ?? '') && args) add({ kind: 'file', label: args.split(/[\\/]/).pop() || args, title: args });
      else if (toolName === 'Bash' && /\bgit\s+commit\b/.test(args ?? '')) {
        const m = COMMIT_LINE.exec(s.result.text);
        if (m) add({ kind: 'commit', label: `${m[1].slice(0, 7)} ${m[2].slice(0, DEVROOM_COMMIT_CHIP_CHARS)}`.trim(), title: m[1] });
      }
    }
  }
  return out.slice(0, DEVROOM_OUTPUT_CHIPS_MAX);
}
