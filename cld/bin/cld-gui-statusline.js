#!/usr/bin/env node
// cld-gui-statusline: the status line of the sessions the cld-gui engine starts
// (ENV-2; the engine sets it through `--settings`, never in a settings file).
//
// Claude Code hands every status-line command the session's JSON on stdin, and
// for Pro/Max accounts that JSON carries `rate_limits` (5-hour and 7-day
// windows) after the first response (https://code.claude.com/docs/en/statusline).
// This keeps those two windows in ~/.config/cld-gui/usage-claude.json for the
// office's usage bar, then runs the user's own status line (project, then user
// settings) with the same input and prints what it prints, so their display
// stays as it was. It never makes the status line fail on our account.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SELF = 'cld-gui-statusline';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The user's own status line command, as Claude Code would pick it without ours; null for none. */
function userCommand(projectDir, env = process.env, home = os.homedir()) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const files = [
    ...(projectDir
      ? [
          path.join(projectDir, '.claude', 'settings.local.json'),
          path.join(projectDir, '.claude', 'settings.json'),
        ]
      : []),
    path.join(configDir, 'settings.json'),
  ];
  for (const file of files) {
    const line = readJson(file)?.statusLine;
    if (line && typeof line === 'object' && typeof line.command === 'string' && line.command.trim())
      return line.command.includes(SELF) ? null : line.command;
  }
  return null;
}

/** Keep the two windows of `input.rate_limits` in `file` (atomic); false when there are none. */
function keep(input, file, now = Date.now()) {
  const rl = input && typeof input === 'object' ? input.rate_limits : null;
  if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return false;
  const { five_hour, seven_day } = rl;
  if (!five_hour && !seven_day) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ts: new Date(now).toISOString(), five_hour, seven_day }));
  fs.renameSync(tmp, file);
  return true;
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    /* no input */
  }
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    /* not JSON: nothing to keep, the user's line still runs */
  }
  try {
    keep(input, path.join(os.homedir(), '.config', 'cld-gui', 'usage-claude.json'));
  } catch {
    /* a full disk must not blank the status line */
  }
  const command = userCommand(input?.workspace?.project_dir || input?.cwd || process.cwd());
  if (!command) return;
  // ponytail: the platform shell (cmd.exe on Windows); a bash-only user line there needs Claude's own shell choice.
  const r = spawnSync(command, {
    shell: true,
    input: raw,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  process.exitCode = r.status ?? 0;
}

if (require.main === module) main();
module.exports = { userCommand, keep };
