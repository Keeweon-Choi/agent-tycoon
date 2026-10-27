// Fake interactive `claude --dangerously-skip-permissions` for BYPASS-ACCEPT. A folder with
// .fake-bypass-needed has Claude Code 2.1.311's one-time warning; Enter on Yes removes that
// marker (Claude's own recorded answer in this fixture). .fake-bypass selects a negative variant.
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const home = process.env.HOME;
const needed = path.join(cwd, '.fake-bypass-needed');
let mode = '';
try {
  mode = fs.readFileSync(path.join(cwd, '.fake-bypass'), 'utf8').trim();
} catch {
  /* plain warning */
}
const log = (key) =>
  fs.appendFileSync(path.join(home, 'fake-claude-bypass.log'), `${JSON.stringify({ cwd, key })}\n`);

process.stdin.setRawMode(true);
if (mode === 'hang') {
  process.stdin.on('data', (b) => log(`ignored:${JSON.stringify(b.toString())}`));
  setTimeout(() => process.exit(0), Number(process.env.FAKE_HANG_MS || 4000));
  return;
}

let warning = fs.existsSync(needed);
let onYes = false;
let ctrlC = 0;
function draw() {
  const cols = process.stdout.columns || 80;
  out('\x1b[H\x1b[2J');
  if (mode === 'unknown') {
    out(' Something else entirely\r\n\r\n ❯ Continue\r\n');
    return;
  }
  if (mode === 'trust') {
    out(' Accessing workspace:\r\n\r\n ❯ No, exit\r\n   Yes, I trust this folder\r\n');
    return;
  }
  if (warning) {
    out(`╭${'─'.repeat(Math.max(0, cols - 2))}╮\r\n`);
    out('│ WARNING: Claude Code running in Bypass Permissions mode\r\n│\r\n');
    out('│ In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.\r\n');
    out('│ This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.\r\n│\r\n');
    out('│ By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.\r\n│\r\n');
    out('│ https://code.claude.com/docs/en/security\r\n│\r\n');
    out(`│ ${onYes ? ' ' : '❯'} No, exit\r\n`);
    out(`│ ${onYes ? '❯' : ' '} Yes, I accept\r\n│\r\n`);
    out('│ Enter to confirm · Esc to cancel\r\n');
    out(`╰${'─'.repeat(Math.max(0, cols - 2))}╯\r\n`);
    return;
  }
  out(' fake Claude Code\r\n\r\n❯ Try "fix lint errors"\r\n');
  if (ctrlC) out(' Press Ctrl-C again to exit\r\n');
}
const out = (s) => process.stdout.write(s);
draw();
process.stdin.on('data', (buf) => {
  const s = buf.toString();
  log(s);
  if (s === '\x03') {
    if (++ctrlC >= 2) process.exit(0);
    draw();
    setTimeout(() => (ctrlC = 0), 1000);
    return;
  }
  if (!warning || mode === 'unknown' || mode === 'trust') return;
  if (s === '\x1b[B' && mode === 'swap') warning = false;
  else if (s === '\x1b[B' && mode !== 'nomove') onYes = true;
  else if (s === '\r') {
    if (!onYes || mode === 'stuck') return;
    fs.rmSync(needed, { force: true });
    warning = false;
  }
  draw();
});
