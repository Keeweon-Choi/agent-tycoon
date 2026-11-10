// Fake interactive `claude` (no arguments) for AUTO-TRUST, run by ./engine.cjs in a PTY: in a
// folder with .fake-untrusted it shows Claude Code 2.1.310's trust dialog as recorded from its
// TrustDialog ("Accessing workspace:", the options without numbers, "No, exit" first and focused).
// ↓/↑ move the pointer; Enter on Yes removes .fake-untrusted (the answer recorded) and shows the
// input line; Enter on No or Esc exits 1. Without .fake-untrusted the input line shows at once.
// Ctrl+C twice exits 0. Every key is one JSON line {cwd, key} in $HOME/fake-claude-trust.log.
// A file .fake-trust in the folder picks a variant:
//   warn     the dialog also lists pre-approved tool rules ("These will apply without asking")
//   unknown  a screen that is not the trust question
//   hang     nothing drawn, every key ignored; exits by itself after FAKE_HANG_MS (4000)
//   crash    an error line, exit 1
//   stuck    Enter on Yes changes nothing
//   swap     Down draws the input line instead (the screen changed between Down and Enter)
//   latewarn Down also draws the pre-approvals ("These will apply without asking")
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const home = process.env.HOME;
const out = (s) => process.stdout.write(s);
const untrusted = path.join(cwd, '.fake-untrusted');
let mode = '';
try {
  mode = fs.readFileSync(path.join(cwd, '.fake-trust'), 'utf8').trim();
} catch {
  /* the plain dialog */
}
const log = (key) =>
  fs.appendFileSync(path.join(home, 'fake-claude-trust.log'), `${JSON.stringify({ cwd, key })}\n`);

if (mode === 'crash') {
  out('Error: fake crash\r\n');
  process.exit(1);
}
process.stdin.setRawMode(true);
if (mode === 'hang') {
  process.stdin.on('data', (b) => log(`ignored:${JSON.stringify(b.toString())}`));
  setTimeout(() => process.exit(0), Number(process.env.FAKE_HANG_MS || 4000));
  return;
}

let dialog = fs.existsSync(untrusted);
let onYes = false;
let ctrlC = 0;

function draw() {
  const cols = process.stdout.columns || 80;
  const rule = '─'.repeat(cols);
  out('\x1b[H\x1b[2J');
  if (mode === 'unknown') {
    out(' Something else entirely\r\n\r\n ❯ Continue\r\n');
    return;
  }
  if (dialog) {
    out(`╭─ Accessing workspace: ${'─'.repeat(Math.max(0, cols - 26))}╮\r\n`);
    out(`│ ${cwd}\r\n│\r\n`);
    out(
      "│ Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.\r\n│\r\n",
    );
    out("│ Claude Code'll be able to read, edit, and execute files here.\r\n│\r\n");
    if (mode === 'warn' || (mode === 'latewarn' && onYes)) {
      out('│ ⚠ This folder pre-approves 2 tool permissions in .claude/settings.json:\r\n');
      out('│   Bash(rm:*), WebFetch\r\n');
      out('│ These will apply without asking. Only proceed if you trust this configuration.\r\n│\r\n');
    }
    out('│ Security guide\r\n│\r\n');
    out(`│ ${onYes ? ' ' : '❯'} No, exit\r\n`);
    out(`│ ${onYes ? '❯' : ' '} Yes, I trust this folder\r\n│\r\n`);
    out('│ Enter to confirm · Esc to cancel\r\n');
    out(`╰${'─'.repeat(Math.max(0, cols - 2))}╯\r\n`);
    return;
  }
  out(' fake Claude Code\r\n\r\n');
  out(`${rule}\r\n❯ \x1b[2mTry "fix lint errors"\x1b[22m\r\n${rule}\r\n`);
  if (ctrlC) out(' Press Ctrl-C again to exit\r\n');
}

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
  if (!dialog || mode === 'unknown') return;
  if (s === '\x1b') process.exit(1);
  if (s === '\x1b[B' && mode === 'swap') dialog = false;
  else if (s === '\x1b[B' || s === '\x1b[A') onYes = s === '\x1b[B';
  else if (s === '\r') {
    if (!onYes) process.exit(1);
    if (mode === 'stuck') return;
    fs.rmSync(untrusted, { force: true });
    dialog = false;
  }
  draw();
});
