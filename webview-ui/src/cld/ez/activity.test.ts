import { beforeEach, describe, expect, it } from 'vitest';

import type { EzCommandRule, EzToolRule } from '../../../../core/src/messages.js';
import { setLanguage, t, type TranslationKey } from '../../i18n/index.js';
import { type ActivityInput, describeActivity, type EzContext, PLAIN_CONTEXT } from './activity.js';
import { COMMAND_RULES, PHRASES, TOOL_RULES } from './rules.js';

const bash = (command: string): ActivityInput => ({ toolName: 'Bash', command });
beforeEach(() => setLanguage('ko'));

const cases: Array<[string, ActivityInput, string]> = [
  ['read', { toolName: 'Read', status: 'Reading: /safe/src/app.ts' }, '📖 \uc790\ub8cc \uc77d\ub294 \uc911'],
  ['notebook read', { toolName: 'NotebookRead' }, '📖 \uc790\ub8cc \uc77d\ub294 \uc911'],
  ['grep', { toolName: 'Grep' }, '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911'],
  ['glob', { toolName: 'Glob' }, '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911'],
  ['ls tool', { toolName: 'LS' }, '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911'],
  ['tool search', { toolName: 'ToolSearch' }, '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911'],
  ['edit', { toolName: 'Edit', status: 'Editing: /work/a.ts' }, '✏️ \ucf54\ub4dc \uace0\uce58\ub294 \uc911'],
  ['multi edit', { toolName: 'MultiEdit' }, '✏️ \ucf54\ub4dc \uace0\uce58\ub294 \uc911'],
  ['notebook edit', { toolName: 'NotebookEdit' }, '✏️ \ucf54\ub4dc \uace0\uce58\ub294 \uc911'],
  ['write', { toolName: 'Write', status: 'Writing: /work/new.txt' }, '📝 \uc0c8 \ud30c\uc77c \uc4f0\ub294 \uc911'],
  ['web fetch', { toolName: 'WebFetch' }, '🌐 \uc6f9 \uac80\uc0c9 \uc911'],
  ['web search', { toolName: 'WebSearch' }, '🌐 \uc6f9 \uac80\uc0c9 \uc911'],
  ['agent', { toolName: 'Agent' }, '🤝 \ubd80\ud558 \uc9c1\uc6d0\uc5d0\uac8c \ub9e1\uae40'],
  ['task', { toolName: 'Task' }, '🤝 \ubd80\ud558 \uc9c1\uc6d0\uc5d0\uac8c \ub9e1\uae40'],
  ['subagent flag', { toolName: 'Anything', subagent: true }, '🤝 \ubd80\ud558 \uc9c1\uc6d0\uc5d0\uac8c \ub9e1\uae40'],
  ['todo', { toolName: 'TodoWrite' }, '🗒️ \ud560 \uc77c \uc815\ub9ac'],
  ['task create', { toolName: 'TaskCreate' }, '🗒️ \ud560 \uc77c \uc815\ub9ac'],
  ['task update', { toolName: 'TaskUpdate' }, '🗒️ \ud560 \uc77c \uc815\ub9ac'],
  ['ask user', { toolName: 'AskUserQuestion' }, '✋ \uc0ac\uc7a5\ub2d8 \ub2f5\uc744 \uae30\ub2e4\ub9bc'],
  ['waiting input', { waitingInput: true }, '✋ \uc0ac\uc7a5\ub2d8 \ub2f5\uc744 \uae30\ub2e4\ub9bc'],
  ['permission', { permission: true, toolName: 'Read' }, '🔐 \ud5c8\ub77d\uc744 \uae30\ub2e4\ub9bc'],
  ['send message', { toolName: 'SendMessage' }, '💬 \ub3d9\ub8cc\uc5d0\uac8c \uc5f0\ub77d'],
  ['skill', { toolName: 'Skill' }, '📚 \uc9c0\uce68 \ud3b4 \ubcf4\ub294 \uc911'],
  ['schedule', { toolName: 'ScheduleWakeup' }, '⏰ \uae30\ub2e4\ub9ac\ub294 \uc911'],
  ['monitor', { toolName: 'Monitor' }, '⏰ \uae30\ub2e4\ub9ac\ub294 \uc911'],
  ['sleep', { toolName: 'sleep' }, '⏰ \uae30\ub2e4\ub9ac\ub294 \uc911'],
  ['idle', { idle: true }, '☕ \uc26c\ub294 \uc911'],
  // T-0045: precedence is tool > permission/waiting > busy (thinking) > idle.
  ['busy, no tool: thinking', { idle: true, busy: true }, '🤔 \uc0dd\uac01 \uc911'],
  ['busy, finished status: thinking', { status: 'turn ended', busy: true }, '🤔 \uc0dd\uac01 \uc911'],
  ['busy and a tool: the tool', { toolName: 'Read', busy: true }, '📖 \uc790\ub8cc \uc77d\ub294 \uc911'],
  ['busy and a command: the command', { ...bash('npm test'), busy: true }, '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['busy and permission: permission', { permission: true, busy: true }, '🔐 \ud5c8\ub77d\uc744 \uae30\ub2e4\ub9bc'],
  ['busy and waiting input: ✋', { waitingInput: true, busy: true }, '✋ \uc0ac\uc7a5\ub2d8 \ub2f5\uc744 \uae30\ub2e4\ub9bc'],
  ['not busy, no tool: idle', { idle: true, busy: false }, '☕ \uc26c\ub294 \uc911'],
  ['turn ended', { status: 'turn ended' }, '☕ \uc26c\ub294 \uc911'],
  ['upstream Idle label', { status: 'Idle' }, '☕ \uc26c\ub294 \uc911'],
  ['unknown', { toolName: 'FancyTool' }, '⚙️ \uc77c\ud558\ub294 \uc911'],
  ['git commit', bash('git commit -m done'), '📦 \uc800\uc7a5(\ucee4\ubc0b)\ud558\ub294 \uc911'],
  ['git push', bash('git push origin main'), '📦 \uc800\uc7a5(\ucee4\ubc0b)\ud558\ub294 \uc911'],
  ['git status', bash('git status --short'), '🌿 \uae30\ub85d \ud655\uc778'],
  ['npm test', bash('npm run test -- --run'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['vitest', bash('vitest run'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['pytest', bash('pytest -q'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['node test', bash('node --test'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['playwright', bash('playwright test'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['npm install', bash('pnpm install'), '📥 \uc124\uce58\ud558\ub294 \uc911'],
  ['uv sync', bash('uv sync'), '📥 \uc124\uce58\ud558\ub294 \uc911'],
  ['apt', bash('apt install ripgrep'), '📥 \uc124\uce58\ud558\ub294 \uc911'],
  ['build', bash('npm run build'), '🔨 \ube4c\ub4dc\ud558\ub294 \uc911'],
  ['tsc', bash('tsc --noEmit'), '🔨 \ube4c\ub4dc\ud558\ub294 \uc911'],
  ['cargo build', bash('cargo build'), '🔨 \ube4c\ub4dc\ud558\ub294 \uc911'],
  ['python training', bash('python3 train.py --epochs 2'), '🏋️ \ud559\uc2b5 \uc2dc\ud0a4\ub294 \uc911'],
  ['torchrun', bash('torchrun model.py'), '🏋️ \ud559\uc2b5 \uc2dc\ud0a4\ub294 \uc911'],
  ['codex cli', bash('codex exec fix-bug'), '🤖 Codex\uc5d0\uac8c \ub9e1\uae40'],
  ['curl', bash('curl https://example.test/a'), '🌐 \ubc1b\uc544\uc624\ub294 \uc911'],
  ['remote', bash('ssh host'), '🔌 \uc6d0\uaca9 \uc811\uc18d'],
  ['docker', bash('docker ps'), '🐳 \ucee8\ud14c\uc774\ub108 \uc791\uc5c5'],
  ['hardware', bash('nvidia-smi'), '🌡️ \uc7a5\ube44 \ud655\uc778'],
  ['search command', bash('rg TODO src'), '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911'],
  ['other shell', bash('echo hello'), '💻 \uba85\ub839 \uc2e4\ud589 \uc911'],
  ['env and cd prefixes', bash('MODE=ci cd web && npm test'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  [
    'wrapper prefixes',
    bash('nice -n 10 taskset -c 0 timeout 30 sudo git push'),
    '📦 \uc800\uc7a5(\ucee4\ubc0b)\ud558\ub294 \uc911',
  ],
  ['first chain command wins', bash('git status && npm test'), '🌿 \uae30\ub85d \ud655\uc778'],
  [
    'heredoc is never displayed',
    { toolName: 'Bash', status: "Running: python3 - <<'EOF'\nsecret = 'abc123'\nEOF" },
    '💻 \uba85\ub839 \uc2e4\ud589 \uc911',
  ],
  ['training progress', { jobProgress: { label: 'model training', pct: 45 } }, '🏋️ \ud559\uc2b5 \uc911 45%'],
  ['regular progress', { jobProgress: { label: 'backup', pct: 200 } }, '⏳ \uc791\uc5c5 \uc911 100%'],

  // The Claude provider's real status wording (formatToolStatus), as sub-agent
  // rows deliver it: no tool name, only the status line.
  ['status: Reading', { status: 'Reading app.ts' }, '📖 \uc790\ub8cc \uc77d\ub294 \uc911'],
  ['status: Editing notebook', { status: 'Editing notebook' }, '✏️ \ucf54\ub4dc \uace0\uce58\ub294 \uc911'],
  ['status: Writing', { status: 'Writing new.ts' }, '📝 \uc0c8 \ud30c\uc77c \uc4f0\ub294 \uc911'],
  ['status: Searching code', { status: 'Searching code' }, '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911'],
  ['status: Searching files', { status: 'Searching files' }, '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911'],
  ['status: Searching the web', { status: 'Searching the web' }, '🌐 \uc6f9 \uac80\uc0c9 \uc911'],
  ['status: Fetching', { status: 'Fetching web content' }, '🌐 \uc6f9 \uac80\uc0c9 \uc911'],
  ['status: Running', { status: 'Running: npm test' }, '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['status: Subtask', { status: 'Subtask: fix the login bug' }, '🤝 \ubd80\ud558 \uc9c1\uc6d0\uc5d0\uac8c \ub9e1\uae40'],
  ['status: Running subtask', { status: 'Running subtask' }, '🤝 \ubd80\ud558 \uc9c1\uc6d0\uc5d0\uac8c \ub9e1\uae40'],
  ['status: Using Skill', { status: 'Using Skill' }, '📚 \uc9c0\uce68 \ud3b4 \ubcf4\ub294 \uc911'],
  ['status: Using TodoWrite', { status: 'Using TodoWrite' }, '🗒️ \ud560 \uc77c \uc815\ub9ac'],
  ['status: AskUserQuestion', { status: 'Waiting for your answer' }, '✋ \uc0ac\uc7a5\ub2d8 \ub2f5\uc744 \uae30\ub2e4\ub9bc'],
  ['status: SendMessage', { status: '-> team-lead' }, '💬 \ub3d9\ub8cc\uc5d0\uac8c \uc5f0\ub77d'],
  ['empty tool name falls back', { toolName: '', status: 'Reading a.ts' }, '📖 \uc790\ub8cc \uc77d\ub294 \uc911'],

  // "idle" or "finished" inside a command is not an idle agent.
  [
    'idle word in a command',
    { toolName: 'Bash', status: 'Running: grep -rn idle src' },
    '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911',
  ],
  [
    'finished word in a command',
    { toolName: 'Bash', status: 'Running: ./finished.sh' },
    '💻 \uba85\ub839 \uc2e4\ud589 \uc911',
  ],

  // Prefix skipping.
  ['timeout with a signal', bash('timeout -s KILL 30 npm test'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['env command', bash('env -i FOO=1 npm test'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  [
    'assignment after sudo',
    bash('sudo DEBIAN_FRONTEND=noninteractive apt-get install -y jq'),
    '📥 \uc124\uce58\ud558\ub294 \uc911',
  ],
  [
    'taskset cpu list then build',
    bash('nice -n 10 taskset -c 4,5 npm run build'),
    '🔨 \ube4c\ub4dc\ud558\ub294 \uc911',
  ],
  ['npx test runner', bash('npx vitest run --pool=threads'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['npx tsc', bash('npx -y tsc --noEmit'), '🔨 \ube4c\ub4dc\ud558\ub294 \uc911'],
  ['npx playwright', bash('npx playwright test'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  [
    'setup commands',
    bash('cd /x; export A=1; source .venv/bin/activate && python3 train.py'),
    '🏋️ \ud559\uc2b5 \uc2dc\ud0a4\ub294 \uc911',
  ],
  ['subshell', bash('(cd web && npm test)'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['pipe: first command wins', bash('cat log.txt | ssh host'), '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911'],
  ['or-chain', bash('cd /nowhere || git status'), '🌿 \uae30\ub85d \ud655\uc778'],
  ['absolute program path', bash('/usr/bin/git push'), '📦 \uc800\uc7a5(\ucee4\ubc0b)\ud558\ub294 \uc911'],

  // Subcommands rather than substrings.
  ['git global option', bash('git -C /repo commit -m x'), '📦 \uc800\uc7a5(\ucee4\ubc0b)\ud558\ub294 \uc911'],
  ['git stash push is not a push', bash('git stash push'), '🌿 \uae30\ub85d \ud655\uc778'],
  ['git log grepping push', bash('git log --grep=push'), '🌿 \uae30\ub85d \ud655\uc778'],
  ['npm i', bash('npm i'), '📥 \uc124\uce58\ud558\ub294 \uc911'],
  ['yarn add', bash('yarn add lodash'), '📥 \uc124\uce58\ud558\ub294 \uc911'],
  ['npm script named ci', bash('npm run lint:ci'), '💻 \uba85\ub839 \uc2e4\ud589 \uc911'],
  ['npm test script', bash('npm run test:server'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['uv run is not an install', bash('uv run add_numbers.py'), '💻 \uba85\ub839 \uc2e4\ud589 \uc911'],
  ['python -m pytest', bash('python -m pytest -q'), '🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911'],
  ['python minor version', bash('python3.11 train.py'), '🏋️ \ud559\uc2b5 \uc2dc\ud0a4\ub294 \uc911'],
  ['pip3 install', bash('pip3 install requests'), '📥 \uc124\uce58\ud558\ub294 \uc911'],
  ['python -m pip install', bash('python3 -m pip install x'), '📥 \uc124\uce58\ud558\ub294 \uc911'],
  ['shell sleep', bash('sleep 30'), '⏰ \uae30\ub2e4\ub9ac\ub294 \uc911'],

  // Object-prototype names must not look like wrappers (and must not throw).
  ['constructor', bash('constructor foo'), '💻 \uba85\ub839 \uc2e4\ud589 \uc911'],
  ['toString', bash('toString'), '💻 \uba85\ub839 \uc2e4\ud589 \uc911'],
  ['__proto__', bash('__proto__ x && git status'), '💻 \uba85\ub839 \uc2e4\ud589 \uc911'],

  [
    'training job with a plain label',
    { command: 'python3 train.py', jobProgress: { label: 'epoch 3/10', pct: 45 } },
    '🏋️ \ud559\uc2b5 \uc911 45%',
  ],
];

const show = (input: ActivityInput, ctx?: EzContext) => {
  const result = describeActivity(input, ctx);
  return `${result.emoji} ${result.text}`;
};

describe('describeActivity', () => {
  it.each(cases)('%s', (_name, input, expected) => {
    const result = describeActivity(input);
    expect(`${result.emoji} ${result.text}`).toBe(expected);
    expect(result.text.length).toBeLessThanOrEqual(16);
  });

  it('keeps a safe basename as the detail-mode hint', () => {
    expect(describeActivity({ toolName: 'Read', status: 'Reading app.ts' }).detail).toBe('app.ts');
    expect(describeActivity({ status: 'Editing index.tsx' }).detail).toBe('index.tsx');
    expect(
      describeActivity({ toolName: 'Read', status: 'Reading: /home/me/.env?token=abc123' }).detail,
    ).toBe('.env');
    expect(
      describeActivity({ toolName: 'Write', status: 'Writing: https://example.test/x?key=abc123' })
        .detail,
    ).toBe('x');
    expect(describeActivity({ toolName: 'Read', status: 'Reading my notes.md' }).detail).toBe(
      undefined,
    );
  });

  // Commands with secret-looking arguments, in every shape a command reaches us.
  const secrets: Array<[string, string]> = [
    ['curl https://example.test/path?key=super-secret --token abc123', 'super-secret'],
    ['export API_KEY=sk-live-9f8e7d && npm test', 'sk-live-9f8e7d'],
    ['git push https://user:ghp_s3cr3t@github.com/o/r.git', 'ghp_s3cr3t'],
    ["python3 - <<'EOF'\npassword = 'hunter2'\nEOF", 'hunter2'],
    ['mysql -u root -pS3cretPw -e "select 1"', 'S3cretPw'],
    ['cld-gui send lead --token abc123 "deploy now"', 'abc123'],
  ];
  const withUserRule: EzContext = {
    user: { tools: [], commands: [{ program: ['mysql'], emoji: '🗄️', text: '\ub370\uc774\ud130\ubca0\uc774\uc2a4 \uc791\uc5c5' }] },
  };
  it.each(secrets)('never returns the command or its secret: %s', (command, secret) => {
    for (const ctx of [PLAIN_CONTEXT, withUserRule]) {
      for (const input of [
        bash(command),
        { toolName: 'Bash', status: `Running: ${command}` },
        { status: `Running: ${command}` },
        { command, jobProgress: { label: 'x', pct: 10 } },
      ]) {
        const json = JSON.stringify(describeActivity(input, ctx));
        expect(json).not.toContain(secret);
        expect(json).not.toContain(command);
        expect(describeActivity(input, ctx).detail).toBeUndefined();
      }
    }
  });
});

describe('the built-in phrase table', () => {
  it('every phrase has an emoji and fits the 16-character limit', () => {
    const all = [...Object.values(PHRASES), ...TOOL_RULES, ...COMMAND_RULES];
    for (const { emoji, text } of all) {
      expect(emoji.length).toBeGreaterThan(0);
      expect(t(text as TranslationKey).length).toBeGreaterThan(0);
      expect(t(text as TranslationKey).length).toBeLessThanOrEqual(16);
    }
    // A job's progress appends " 100%" to its phrase.
    expect(`${t(PHRASES.trainingProgress.text)} 100%`.length).toBeLessThanOrEqual(16);
    expect(`${t(PHRASES.jobProgress.text)} 100%`.length).toBeLessThanOrEqual(16);
  });

  it('has a rule for each of the commands a plain Claude Code user runs', () => {
    for (const program of ['git', 'npm', 'pytest', 'curl', 'ssh', 'docker', 'make', 'codex']) {
      expect(COMMAND_RULES.some((rule) => rule.program.includes(program))).toBe(true);
    }
  });
});

// ~/.config/cld-gui/ez-rules.json, as the daemon validated and sent it.
describe("the user's own rules", () => {
  const user = (tools: EzToolRule[], commands: EzCommandRule[]): EzContext => ({
    user: { tools, commands },
  });

  it('add a command the table does not know, and leave the rest alone', () => {
    const ctx = user(
      [],
      [{ program: ['make'], sub: ['deploy'], emoji: '🚀', text: '\ubc30\ud3ec\ud558\ub294 \uc911' }],
    );
    expect(show(bash('make deploy'), ctx)).toBe('🚀 \ubc30\ud3ec\ud558\ub294 \uc911');
    expect(show(bash('make deploy'))).toBe('🔨 \ube4c\ub4dc\ud558\ub294 \uc911'); // without the file: the built-in one
    expect(show(bash('make all'), ctx)).toBe('🔨 \ube4c\ub4dc\ud558\ub294 \uc911');
    expect(show(bash('git status'), ctx)).toBe('🌿 \uae30\ub85d \ud655\uc778');
    expect(show(bash('npm test'), ctx)).toBe('🧪 \uc2dc\ud5d8 \ub3cc\ub9ac\ub294 \uc911');
    expect(show({ toolName: 'Read' }, ctx)).toBe('📖 \uc790\ub8cc \uc77d\ub294 \uc911');
  });

  it('override a built-in command; the first user rule wins', () => {
    const ctx = user(
      [],
      [
        { program: ['git'], sub: ['push'], emoji: '🚀', text: '\uc62c\ub9ac\ub294 \uc911' },
        { program: ['git'], emoji: '📚', text: 'git \uc791\uc5c5' },
      ],
    );
    expect(show(bash('git push origin main'), ctx)).toBe('🚀 \uc62c\ub9ac\ub294 \uc911');
    expect(show(bash('git commit -m x'), ctx)).toBe('📚 git \uc791\uc5c5');
    expect(show(bash('git -C /repo push'), ctx)).toBe('🚀 \uc62c\ub9ac\ub294 \uc911');
  });

  it('narrow by subcommand, a word in it, arguments and a word inside one', () => {
    const ctx = user(
      [],
      [
        { program: ['kubectl'], sub: ['apply', 'delete'], emoji: '☸️', text: '\ud074\ub7ec\uc2a4\ud130 \ubcc0\uacbd' },
        { program: ['kubectl'], emoji: '☸️', text: '\ud074\ub7ec\uc2a4\ud130 \ud655\uc778' },
        { program: ['cargo'], subContains: ['bench'], emoji: '⏱️', text: '\uc131\ub2a5 \uc7ac\ub294 \uc911' },
        { program: ['gh'], has: ['pr', 'create'], emoji: '🔀', text: '\ubcc0\uacbd \uc694\uccad \ub9cc\ub4e6' },
        { program: ['terraform'], contains: ['prod'], emoji: '🛑', text: '\uc6b4\uc601 \ud658\uacbd \uc791\uc5c5' },
      ],
    );
    expect(show(bash('kubectl apply -f x.yaml'), ctx)).toBe('☸️ \ud074\ub7ec\uc2a4\ud130 \ubcc0\uacbd');
    expect(show(bash('kubectl get pods'), ctx)).toBe('☸️ \ud074\ub7ec\uc2a4\ud130 \ud655\uc778');
    expect(show(bash('cargo bench-all'), ctx)).toBe('⏱️ \uc131\ub2a5 \uc7ac\ub294 \uc911');
    expect(show(bash('gh pr create --fill'), ctx)).toBe('🔀 \ubcc0\uacbd \uc694\uccad \ub9cc\ub4e6');
    expect(show(bash('gh pr view'), ctx)).toBe('💻 \uba85\ub839 \uc2e4\ud589 \uc911');
    expect(show(bash('terraform apply -var env=prod'), ctx)).toBe('🛑 \uc6b4\uc601 \ud658\uacbd \uc791\uc5c5');
    expect(show(bash('terraform apply -var env=dev'), ctx)).toBe('💻 \uba85\ub839 \uc2e4\ud589 \uc911');
  });

  it("read a rule's program the way a command's is read: python3 is python", () => {
    const ctx = user(
      [],
      [
        { program: ['python3'], contains: ['migrate'], emoji: '🗃️', text: '\uc774\uc804 \uc791\uc5c5' },
        { program: ['/usr/bin/GIT'], sub: ['pull'], emoji: '⬇️', text: '\ubc1b\uc544\uc624\ub294 \uc911' },
      ],
    );
    expect(show(bash('python3.12 migrate.py'), ctx)).toBe('🗃️ \uc774\uc804 \uc791\uc5c5');
    expect(show(bash('python -m migrate'), ctx)).toBe('🗃️ \uc774\uc804 \uc791\uc5c5');
    expect(show(bash('git pull'), ctx)).toBe('⬇️ \ubc1b\uc544\uc624\ub294 \uc911');
  });

  it('match a program regardless of case, path and version', () => {
    const ctx = user(
      [],
      [{ program: ['Python'], contains: ['Notebook'], emoji: '📓', text: '\ub178\ud2b8\ubd81 \uc791\uc5c5' }],
    );
    expect(show(bash('/usr/bin/python3.12 run_notebook.py'), ctx)).toBe('📓 \ub178\ud2b8\ubd81 \uc791\uc5c5');
    expect(show(bash('PYTHON run_notebook.py'), ctx)).toBe('📓 \ub178\ud2b8\ubd81 \uc791\uc5c5');
  });

  it('rename a tool, including the waiting-for-input state that shares its phrase', () => {
    const ctx = user(
      [
        { tool: ['Read', 'NotebookRead'], emoji: '👀', text: '\uc0b4\ud3b4\ubcf4\ub294 \uc911' },
        { tool: ['ask_user_question'], emoji: '🙋', text: '\ub2f5\uc744 \uae30\ub2e4\ub9bc' },
      ],
      [],
    );
    expect(show({ toolName: 'Read', status: 'Reading a.ts' }, ctx)).toBe('👀 \uc0b4\ud3b4\ubcf4\ub294 \uc911');
    expect(show({ toolName: 'NotebookRead' }, ctx)).toBe('👀 \uc0b4\ud3b4\ubcf4\ub294 \uc911');
    expect(show({ toolName: 'AskUserQuestion' }, ctx)).toBe('🙋 \ub2f5\uc744 \uae30\ub2e4\ub9bc');
    expect(show({ waitingInput: true }, ctx)).toBe('🙋 \ub2f5\uc744 \uae30\ub2e4\ub9bc');
    expect(show({ status: 'Reading a.ts' }, ctx)).toBe('👀 \uc0b4\ud3b4\ubcf4\ub294 \uc911'); // a status-only row
    expect(show({ toolName: 'Grep' }, ctx)).toBe('🔎 \ucc3e\uc544\ubcf4\ub294 \uc911');
    expect(show({ toolName: 'Read' })).toBe('📖 \uc790\ub8cc \uc77d\ub294 \uc911');
    // A user rule is a fixed phrase: no file hint rides along.
    const detail = describeActivity({ toolName: 'Read', status: 'Reading a.ts' }, ctx).detail;
    expect(detail).toBeUndefined();
  });

  it('add a tool of their own, and a rule for the shell tool itself', () => {
    const ctx = user([{ tool: ['mcp__deploy'], emoji: '🚢', text: '\ubc30\ud3ec \ub3c4\uad6c' }], []);
    expect(show({ toolName: 'mcp__deploy' }, ctx)).toBe('🚢 \ubc30\ud3ec \ub3c4\uad6c');
    expect(show({ toolName: 'mcp__deploy' })).toBe('⚙️ \uc77c\ud558\ub294 \uc911');
    const shell = user([{ tool: ['Bash'], emoji: '🖥️', text: '\ud130\ubbf8\ub110 \uc791\uc5c5' }], []);
    expect(show(bash('npm test'), shell)).toBe('🖥️ \ud130\ubbf8\ub110 \uc791\uc5c5');
  });

  it('cannot change the states no tool names', () => {
    const ctx = user([{ tool: ['anything'], emoji: '❓', text: '\ubb54\uac00' }], []);
    expect(show({ permission: true }, ctx)).toBe('🔐 \ud5c8\ub77d\uc744 \uae30\ub2e4\ub9bc');
    expect(show({ idle: true }, ctx)).toBe('☕ \uc26c\ub294 \uc911');
  });

  it('a punctuation-only user tool never matches a row without a tool name', () => {
    const ctx = user([{ tool: ['---'], emoji: '❓', text: '\uc774\ub984 \uc5c6\uc74c' }], []);
    expect(show({}, ctx)).toBe('⚙️ \uc77c\ud558\ub294 \uc911');
  });
});
