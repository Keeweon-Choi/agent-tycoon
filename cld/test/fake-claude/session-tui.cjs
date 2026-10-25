// Fake `claude attach <id>` for the engine (T-0019), run by ./engine.cjs in a
// PTY: the parts of Claude Code 2.1.306's screen cld-gui send reads. The input
// line is a `❯` row under a `─` rule, with a dim suggestion while empty; a
// bracketed paste or typing fills it; Enter submits it: one JSON line
// {id, text} to $HOME/fake-claude-typed.log, the session file's status
// `busy` (with "esc to interrupt" on screen) for FAKE_TURN_MS (300), then
// `idle`. A file $HOME/fake-draft-<id> is a draft already in the input line;
// a file $HOME/fake-bg-<id> means busy only with background sub-agents: the
// main turn is over and no working line is drawn;
// a file $HOME/fake-dialog-<id> puts a question dialog (AskUserQuestion) where
// the input box is.
// A file $HOME/fake-perm-<id> (JSON {title, desc, command}) puts a permission dialog there, drawn
// like Claude Code 2.1.31x's (PERM-PROMPT): "1" allows, "2" or Esc denies; the answer is one JSON
// line {id, answer} in $HOME/fake-claude-answers.log and the file goes (the dialog with it).
// The working line is drawn while the session file says `busy` (as the real
// attach shows the session's running turn, whoever started it), and the input
// line stays usable under it: Claude Code takes input during a turn.
// A bracketed paste longer than FAKE_FOLD_CHARS (800, Claude Code's own) is shown as
// `[Pasted text #1 +12 lines]` (`[Pasted text #1]` on one line), as in the real one; the
// submitted text (the log line) is still the whole of it.
// Ctrl+Z detaches (exit 0), as in the real one.
const { spawn } = require('child_process');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const path = require('path');

const id = process.argv[2];
const home = process.env.HOME;
const turnMs = Number(process.env.FAKE_TURN_MS || 300);
const sessDir = path.join(home, '.claude', 'sessions');
const out = (s) => process.stdout.write(s);

let input = '';
try {
  input = fs.readFileSync(path.join(home, `fake-draft-${id}`), 'utf8');
} catch {
  /* no draft */
}
let pasting = false;
const foldChars = Number(process.env.FAKE_FOLD_CHARS || 800);
/** Pastes shown as a placeholder: [start, end) of `input`, and the running `#n`. */
let folds = [];
let pasteStart = 0;
let pasteCount = 0;
/** ctrl+x pressed, waiting for ctrl+s (a chord sent as two key presses). */
let chordX = false;
let shownBusy = false;
/** The dialog drawn (its JSON, '' for none): a changed fake-perm file is redrawn. */
let shownPerm = '';

function sessionFile() {
  try {
    for (const f of fs.readdirSync(sessDir)) {
      const s = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
      if (s.jobId === id) return path.join(sessDir, f);
    }
  } catch {
    /* none */
  }
  return null;
}

function setStatus(status) {
  const f = sessionFile();
  if (!f) return;
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...s, status, statusUpdatedAt: Date.now() }));
}

function busy() {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')).status === 'busy';
  } catch {
    return false;
  }
}

function draw() {
  const cols = process.stdout.columns || 80;
  const rule = '─'.repeat(cols);
  // Claude Code draws a pasted newline as a new row of the input box.
  let at = 0;
  let view = '';
  for (const f of folds) {
    const lines = input.slice(f.start, f.end).split('\r').length - 1;
    view += `${input.slice(at, f.start)}[Pasted text #${f.n}${lines ? ` +${lines} lines` : ''}]`;
    at = f.end;
  }
  const shown = (view + input.slice(at)).replaceAll('\r', '\r\n  ');
  out('\x1b[H\x1b[2J');
  out(` fake Claude Code · session ${id}\r\n\r\n`);
  const bg = fs.existsSync(path.join(home, `fake-bg-${id}`));
  out(shownBusy && !bg ? '✻ Working… (esc to interrupt)\r\n' : '\r\n');
  const perm = permission();
  if (perm) {
    out(`${rule}\r\n ${perm.title || 'Bash command'}\r\n`);
    if (perm.desc) out(` ${perm.desc}\r\n`);
    out('\r\n');
    for (const line of String(perm.command || '').split('\n')) out(`   ${line}\r\n`);
    out('\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n\r\n');
    out(' Esc to cancel · Tab to amend\r\n');
    return;
  }
  if (fs.existsSync(path.join(home, `fake-dialog-${id}`))) {
    out(`${rule}\r\n Which one?\r\n\r\n ❯ 1. Option A\r\n   2. Option B\r\n`);
    out(`${rule}\r\n Enter to select · Esc to cancel\r\n`);
    return;
  }
  out(`${rule}\r\n`);
  out(
    shown
      ? `❯ ${shown}\x1b[7m \x1b[27m\r\n`
      : '❯ \x1b[7mT\x1b[27m\x1b[2mry "fix lint errors"\x1b[22m\r\n',
  );
  out(`${rule}\r\n`);
  out('  ⏵⏵ auto mode on · ← for agents\r\n');
}

function permission() {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, `fake-perm-${id}`), 'utf8'));
  } catch {
    return null;
  }
}

function answer(yes) {
  fs.appendFileSync(
    path.join(home, 'fake-claude-answers.log'),
    `${JSON.stringify({ id, answer: yes ? 'yes' : 'no' })}\n`,
  );
  fs.rmSync(path.join(home, `fake-perm-${id}`), { force: true });
  // A queued dialog (fake-perm-<id>.next) comes up right after, as Claude Code shows the next one.
  try {
    fs.renameSync(path.join(home, `fake-perm-${id}.next`), path.join(home, `fake-perm-${id}`));
  } catch {
    /* none queued */
  }
  shownPerm = JSON.stringify(permission() ?? '');
  draw();
}

function submit(now = false) {
  const text = input;
  input = '';
  folds = [];
  fs.appendFileSync(
    path.join(home, 'fake-claude-typed.log'),
    `${JSON.stringify({ id, text, ...(now && { now }) })}\n`,
  );
  setStatus('busy');
  shownBusy = true;
  draw();
  // The turn ends in the session, not in this attach (cld-gui ends its attach
  // right after the Enter): a detached timer sets it idle.
  const f = sessionFile();
  if (f)
    spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(() => { const fs = require('fs'); const s = JSON.parse(fs.readFileSync(${JSON.stringify(f)}, 'utf8')); fs.writeFileSync(${JSON.stringify(f)}, JSON.stringify({ ...s, status: 'idle', statusUpdatedAt: Date.now() })); }, ${turnMs});`,
      ],
      { detached: true, stdio: 'ignore' },
    ).unref();
}

const decoder = new StringDecoder('utf8');
process.stdin.setRawMode(true);
shownBusy = busy();
shownPerm = JSON.stringify(permission() ?? '');
draw();
setInterval(() => {
  const perm = JSON.stringify(permission() ?? '');
  if (busy() !== shownBusy || perm !== shownPerm) {
    shownBusy = busy();
    shownPerm = perm;
    draw();
  }
}, 100);
process.stdin.on('data', (buf) => {
  let s = decoder.write(buf); // a long paste splits a Hangul character across reads
  if (s.includes('\x1a')) process.exit(0);
  if (permission()) {
    // A permission dialog takes only its keys; anything else is dropped, as in Claude Code.
    // Each key on its own: two presses read in one chunk answer two dialogs.
    if (s === '\x1b') answer(false);
    else for (const ch of s) if (!permission()) break; else if (ch === '1' || ch === '2') answer(ch === '1');
    return;
  }
  while (s) {
    if (s.startsWith('\x1b[200~')) {
      pasting = true;
      pasteStart = input.length;
      s = s.slice(6);
      continue;
    }
    if (s.startsWith('\x1b[201~')) {
      pasting = false;
      if (input.length - pasteStart > foldChars)
        folds.push({ start: pasteStart, end: input.length, n: ++pasteCount });
      s = s.slice(6);
      continue;
    }
    if (s.startsWith('\x18\x13') && !pasting) {
      // Claude Code's chat:sendNow (ctrl+x ctrl+s): in at once, even mid-turn.
      s = s.slice(2);
      if (input) submit(true);
      continue;
    }
    // The same chord as two key presses, the way a person (and the typist since U-31) sends it.
    if (s.startsWith('\x18') && !pasting) {
      chordX = true;
      s = s.slice(1);
      continue;
    }
    if (chordX && s.startsWith('\x13') && !pasting) {
      chordX = false;
      s = s.slice(1);
      if (input) submit(true);
      continue;
    }
    chordX = false;
    const ch = s[0];
    s = s.slice(1);
    if (ch === '\r' && !pasting) {
      if (input) submit();
      continue;
    }
    if (ch === '\x7f') {
      // A placeholder goes whole, as in Claude Code.
      const last = folds.at(-1);
      if (last && last.end === input.length) input = input.slice(0, folds.pop().start);
      else input = input.slice(0, -1);
    }
    else input += ch;
  }
  draw();
});
process.stdout.on('resize', draw);
