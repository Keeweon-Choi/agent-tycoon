/**
 * The EZ phrase table (FR-OFC-018, ADR-0014): the one place that says which
 * emoji and words a tool or a shell command gets. Data only; `activity.ts` reads
 * it. The users' own rules (ez-rules.json, checked by the daemon) are tried
 * before these, so anything here can be added to or replaced without a code change.
 *
 * Only generic rules are here: git, npm, pytest and the like.
 *
 * Matching is case-insensitive. A tool rule names tools by letters and digits
 * only (`TodoWrite` is `todowrite`). A command rule is `program` plus optional
 * narrowing lists, all of which must match; see EzCommandRule in the protocol.
 */
import type { EzCommandRule, EzFatigue, EzToolRule } from '../../../../core/src/messages.js';

export interface Phrase {
  emoji: string;
  text: string;
}

/** A built-in tool rule. `file`: the status names a file, whose basename may ride along as the detail-mode hint. */
export interface ToolRule extends EzToolRule {
  file?: boolean;
}

/** A built-in command rule. `training`: a model-training command, so a job's progress reads "학습 중". */
export interface CommandRule extends EzCommandRule {
  training?: boolean;
}

/** States no tool or command names. */
export const PHRASES = {
  permission: { emoji: '🔐', text: 'activity.waitingApproval' },
  idle: { emoji: '☕', text: 'activity.resting' },
  /** The provider says a turn is in progress but no tool is running (T-0045). */
  thinking: { emoji: '🤔', text: 'activity.thinking' },
  unknownTool: { emoji: '⚙️', text: 'activity.working' },
  plainCommand: { emoji: '💻', text: 'activity.runningCommand' },
  /** A job's progress; the percent is appended. */
  trainingProgress: { emoji: '🏋️', text: 'activity.training' },
  jobProgress: { emoji: '⏳', text: 'activity.workingOnJob' },
} as const satisfies Record<string, Phrase>;

/** Tools whose input is a shell command: the command rules decide. */
export const SHELL_TOOLS: readonly string[] = ['bash', 'shell', 'sh', 'terminal'];

export const TOOL_RULES: readonly ToolRule[] = [
  { tool: ['agent', 'task'], emoji: '🤝', text: 'activity.delegating' },
  { tool: ['askuserquestion'], emoji: '✋', text: 'activity.waitingForYou' },
  { tool: ['todowrite', 'taskcreate', 'taskupdate'], emoji: '🗒️', text: 'activity.planning' },
  { tool: ['sendmessage'], emoji: '💬', text: 'activity.messagingPeer' },
  { tool: ['skill'], emoji: '📚', text: 'activity.readingInstructions' },
  { tool: ['schedulewakeup', 'monitor', 'sleep'], emoji: '⏰', text: 'activity.waiting' },
  { tool: ['read', 'notebookread'], emoji: '📖', text: 'activity.reading', file: true },
  { tool: ['grep', 'glob', 'ls', 'toolsearch'], emoji: '🔎', text: 'activity.searching' },
  { tool: ['edit', 'multiedit', 'notebookedit'], emoji: '✏️', text: 'activity.editingCode', file: true },
  { tool: ['write'], emoji: '📝', text: 'activity.writingFile', file: true },
  { tool: ['webfetch', 'websearch'], emoji: '🌐', text: 'activity.searchingWeb' },
];

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'];
const TEST_RUNNERS = ['vitest', 'jest', 'pytest', 'playwright'];
const TESTING = { emoji: '🧪', text: 'activity.testing' };
const INSTALLING = { emoji: '📥', text: 'activity.installing' };
const BUILDING = { emoji: '🔨', text: 'activity.building' };
const TRAINING = { emoji: '🏋️', text: 'activity.trainingModel', training: true };

/** First match wins, in this order (an `npm run build` is a build before it is any `npm`). */
export const COMMAND_RULES: readonly CommandRule[] = [
  { program: ['git'], sub: ['commit', 'push'], emoji: '📦', text: 'activity.committing' },
  { program: ['git'], emoji: '🌿', text: 'activity.checkingHistory' },

  // npm, pnpm and yarn read `run <script>` like `<script>`.
  { program: PACKAGE_MANAGERS, subContains: ['test'], ...TESTING },
  { program: PACKAGE_MANAGERS, sub: TEST_RUNNERS, ...TESTING },
  { program: PACKAGE_MANAGERS, sub: ['ci', 'install', 'i', 'add'], ...INSTALLING },
  { program: PACKAGE_MANAGERS, subContains: ['build'], ...BUILDING },
  { program: PACKAGE_MANAGERS, sub: ['tsc'], ...BUILDING },

  { program: TEST_RUNNERS, ...TESTING },
  { program: ['node'], has: ['--test'], ...TESTING },
  { program: ['python'], has: ['-m', 'pytest'], ...TESTING },

  { program: ['pip'], sub: ['install'], ...INSTALLING },
  { program: ['python'], has: ['-m', 'pip', 'install'], ...INSTALLING },
  { program: ['uv'], sub: ['sync', 'add'], ...INSTALLING },
  { program: ['uv'], has: ['pip', 'install'], ...INSTALLING },
  { program: ['apt', 'apt-get'], ...INSTALLING },

  { program: ['tsc', 'esbuild', 'make'], ...BUILDING },
  { program: ['vite'], sub: ['build'], ...BUILDING },
  { program: ['cargo'], sub: ['build'], ...BUILDING },

  { program: ['python'], contains: ['train'], ...TRAINING },
  { program: ['torchrun'], ...TRAINING },

  { program: ['codex'], emoji: '🤖', text: 'activity.delegatingCodex' },
  { program: ['sleep'], emoji: '⏰', text: 'activity.waiting' },
  { program: ['curl', 'wget'], emoji: '🌐', text: 'activity.fetching' },
  { program: ['ssh', 'scp'], emoji: '🔌', text: 'activity.remoteAccess' },
  { program: ['docker'], emoji: '🐳', text: 'activity.containerWork' },
  { program: ['nvidia-smi'], emoji: '🌡️', text: 'activity.checkingHardware' },
  {
    program: ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find'],
    emoji: '🔎',
    text: 'activity.searching',
  },
];

/**
 * 피로도 (T-0026, T-0045): exactly how full a character's context is
 * (fatigue.ts). Compactions are not part of it; they are shown beside it as
 * "압축 N/M". Every number can be replaced in ez-rules.json ("fatigue");
 * nothing about fatigue is decided anywhere else.
 */
export const FATIGUE: Required<EzFatigue> = {
  /** Without the engine's count, a context drop of more than this many points is a compaction. */
  compactionDrop: 40,
  /** From here it sweats and walks slower, and its bar turns yellow. */
  tired: 60,
  /** From here it yawns now and then, and its bar turns red. */
  yawn: 70,
  /** From here it asks for a rest. */
  rest: 80,
};
