import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const get = path.join(root, 'cld/install/get.sh');

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', ...options });
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function makeTools(dir, { claude = true, nodeVersion = 'v22.3.0' } = {}) {
  writeExecutable(
    path.join(dir, 'node'),
    `#!/bin/sh
if [ "${'$'}1" = '--version' ]; then echo ${nodeVersion}; exit 0; fi
if [ "${'$'}1" = 'cld/install/install.mjs' ]; then
  printf '%s\\n' '첫 기기 로그인 URL: http://localhost:18240/login?code=TEST_CODE'
  exit 0
fi
printf '%s\\n' "unexpected node: ${'$'}*" >> "${'$'}TEST_LOG"
exit 1
`,
  );
  writeExecutable(
    path.join(dir, 'npm'),
    `#!/bin/sh
printf 'npm %s\\n' "${'$'}*" >> "${'$'}TEST_LOG"
exit 0
`,
  );
  writeExecutable(
    path.join(dir, 'sudo'),
    `#!/bin/sh
printf '%s\\n' sudo >> "${'$'}TEST_LOG"
exit 97
`,
  );
  if (claude) writeExecutable(path.join(dir, 'claude'), '#!/bin/sh\nexit 0\n');
}

test('get.sh clones, uses the requested build steps, and updates an existing checkout without sudo', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tycoon-get-'));
  try {
    const bare = path.join(temp, 'source.git');
    const destination = path.join(temp, 'agent-tycoon');
    const home = path.join(temp, 'home');
    const bin = path.join(temp, 'bin');
    const log = path.join(temp, 'commands.log');
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    makeTools(bin);
    // The fresh-machine source is exactly the worktree HEAD, not a copy of its uncommitted files.
    run('git', ['clone', '--bare', '--no-local', root, bare]);
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_LOG: log,
      AGENT_TYCOON_REPO: pathToFileURL(bare).href,
      AGENT_TYCOON_DIR: destination,
    };

    const first = spawnSync('sh', [get], { cwd: temp, env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(fs.existsSync(path.join(destination, '.git')));
    for (const line of [
      '✔ git 확인',
      '✔ Node.js v22.3.0 확인',
      '✔ Claude Code CLI 확인',
      '✔ 저장소 받기',
      '✔ 의존성 설치',
      '✔ 에이전트 타이쿤 설치기 실행',
    ])
      assert.match(first.stdout, new RegExp(line));
    assert.match(first.stdout, /login\?code=TEST_CODE/);
    // npm ci only: the installer builds; `npm run build` (type-check + lint) never runs on a user's machine.
    assert.match(fs.readFileSync(log, 'utf8'), /npm ci/);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /npm run build/);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /sudo/);

    const updater = path.join(temp, 'updater');
    run('git', ['clone', bare, updater]);
    run('git', ['-C', updater, 'config', 'user.email', 'test@localhost']);
    run('git', ['-C', updater, 'config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(updater, 'rerun-marker.txt'), 'updated\n');
    run('git', ['-C', updater, 'add', 'rerun-marker.txt']);
    run('git', ['-C', updater, 'commit', '-m', 'test update']);
    run('git', ['-C', updater, 'push', 'origin', 'HEAD']);

    const second = spawnSync('sh', [get], { cwd: temp, env, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /✔ 저장소 업데이트/);
    assert.equal(fs.readFileSync(path.join(destination, 'rerun-marker.txt'), 'utf8'), 'updated\n');
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /sudo/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('get.sh gives the Korean Claude Code hint and stops before installation when claude is absent', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tycoon-no-claude-'));
  try {
    const bin = path.join(temp, 'bin');
    const home = path.join(temp, 'home');
    const log = path.join(temp, 'commands.log');
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    makeTools(bin, { claude: false });
    writeExecutable(
      path.join(bin, 'git'),
      `#!/bin/sh
printf 'git ${'$'}*\\n' >> "${'$'}TEST_LOG"
exit 98
`,
    );
    const env = {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      TEST_LOG: log,
      AGENT_TYCOON_REPO: 'file:///must-not-clone',
      AGENT_TYCOON_DIR: path.join(temp, 'agent-tycoon'),
    };
    const result = spawnSync('sh', [get], { cwd: temp, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✖ Claude Code CLI가 없습니다/);
    assert.match(result.stdout, /docs\.anthropic\.com/);
    assert.equal(fs.existsSync(log), false, 'no git, npm, installer, or sudo command may run');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('get.sh names the Node version it needs and stops before cloning when Node is too old', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tycoon-old-node-'));
  try {
    const bin = path.join(temp, 'bin');
    const log = path.join(temp, 'commands.log');
    fs.mkdirSync(bin);
    makeTools(bin, { nodeVersion: 'v18.19.0' });
    writeExecutable(
      path.join(bin, 'git'),
      '#!/bin/sh\nprintf "git %s\\n" "$*" >> "$TEST_LOG"\nexit 98\n',
    );
    const env = {
      HOME: temp,
      PATH: `${bin}:/usr/bin:/bin`,
      TEST_LOG: log,
      AGENT_TYCOON_REPO: 'file:///must-not-clone',
      AGENT_TYCOON_DIR: path.join(temp, 'agent-tycoon'),
    };
    const result = spawnSync('sh', [get], { cwd: temp, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✖ Node\.js 22 이상이 필요합니다/);
    assert.equal(fs.existsSync(log), false, 'nothing may run after a failed prerequisite');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
