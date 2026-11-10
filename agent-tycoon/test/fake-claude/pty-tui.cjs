// Fake interactive `claude -n NAME [--resume SID] [flags]` for our PTY host (TERM-P1, ADR-0018),
// required by ./engine.cjs in the PTY's own process (its pid is the one the host spawned).
// What agent-tycoon reads from the real one (ADR-0018 P0 table):
//   - ESC]7501;? BEL and ESC[c in ONE write; OSC 7501 reports start only when the terminal
//     answered the probe before DA1 (state=idle at start, working during a turn, done after it,
//     clear at exit); $HOME/fake-pty-osc.log gets one line per report or `noreport`.
//   - ~/.claude/sessions/<pid>.json, kind interactive, status idle|busy, removed at exit.
//   - the transcript ~/.claude/projects/<cwd>/<sid>.jsonl: a user record per submitted input,
//     an assistant reply FAKE_TURN_MS (300) later.
//   - --resume SID keeps SID (flags too), --session-id SID starts SID; otherwise a new id.
// Input: a bracketed paste or typing fills the line, Enter (\r) submits it, ctrl+x ctrl+s too
// (`now`); each submit is one JSON line {name, sessionId, text, now?} in $HOME/fake-claude-typed.log.
// SIGHUP/SIGTERM (the PTY closing) end it like Claude: session file gone.
// TERM-P3: a submit containing FAKE-PERMISSION asks a permission as Claude does (P0 b): status
// waiting, OSC blocked:kind=permission, and the PermissionRequest hook from --settings run through
// `sh -c` with the hook's JSON on stdin; its decision (or `dialog` when it gave none) is one line
// {sessionId, behavior} in $HOME/fake-claude-perm.log and the turn's reply. With no decision the
// dialog stays up, as Claude's own does, until `1` (terminal-allow) or `2` (terminal-deny) is typed
// in the terminal; FAKE-PERMISSION-TERMINAL skips the hook (one that gave up) and shows it at once.
// COMPACT-COFFEE: a submit containing FAKE-COMPACT compacts as Claude Code does: its spinner line
// "✻ Compacting conversation… (Ns · esc to interrupt)" for 8 s ("FAKE-COMPACT 40": 40 s; the
// engine's clean environment drops FAKE_* variables), redrawn each second, then a compact_boundary
// record in the transcript and the turn's reply.
// STATE-SYNC: FAKE-JOB N (a background shell: status `shell` N s) and FAKE-LONG N (a tool open N s).
// DEVROOM-BOARD2: a resize (SIGWINCH) redraws the screen, row 2 ending in `|` at the PTY's last column.
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function run(args) {
  const HOME = process.env.HOME;
  const turnMs = Number(process.env.FAKE_TURN_MS || 300);
  const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const name = arg('-n') || arg('--name') || 'fake';
  const sessionId = arg('--resume') || arg('--session-id') || crypto.randomUUID();
  const cwd = process.cwd();
  const sessDir = path.join(HOME, '.claude', 'sessions');
  const sessFile = path.join(sessDir, `${process.pid}.json`);
  const transcript = path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${sessionId}.jsonl`);
  const out = (s) => process.stdout.write(s);
  const oscLog = (line) => fs.appendFileSync(path.join(HOME, 'fake-pty-osc.log'), `${process.pid} ${line}\n`);
  let reporting = false;
  let status = 'idle';
  let input = '';
  let pasting = false;
  let chordX = false;
  let last = '';
  let compactingSince = 0;
  /** Claude's own permission dialog is up (the hook gave no decision): `1` or `2` answers it. */
  let dialog = null;

  const procStart = () => {
    try {
      const s = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
    } catch {
      return undefined;
    }
  };
  const writeSession = () => {
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      sessFile,
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd,
        startedAt,
        procStart: procStart(),
        kind: 'interactive',
        name,
        nameSource: 'user',
        status,
        statusUpdatedAt: Date.now(),
      }),
    );
  };
  const osc = (state) => {
    if (!reporting) return;
    out(`\x1b]7501;state=${state}${state === 'idle' ? ':app=claude-code' : ''}\x07`);
    oscLog(state);
  };
  const record = (role, text) => {
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.appendFileSync(
      transcript,
      `${JSON.stringify(
        role === 'user'
          ? { type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId, message: { role, content: text } }
          : { type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId, message: { role, content: [{ type: 'text', text }] } },
      )}\n`,
    );
  };
  const draw = () => {
    out('\x1b[H\x1b[2J');
    out(` fake Claude Code (pty) · ${name} · ${sessionId.slice(0, 8)}\r\n\r\n`);
    out(` last: ${last.slice(0, 60)}\r\n`);
    const spin = compactingSince
      ? `✻ Compacting conversation… (${Math.round((Date.now() - compactingSince) / 1000)}s · esc to interrupt)`
      : ' ✻ Working…';
    out(status === 'busy' ? `${spin}\r\n` : '\r\n');
    if (dialog) out(' Bash command\r\n   rm -rf fake-build\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n');
    out(`${'─'.repeat(40)}\r\n❯ ${input.replaceAll('\r', '⏎')}`);
    // DEVROOM-BOARD2: a row drawn by column like a real TUI's status line, ` cols=N` and `|` in the
    // last column (cursor kept): a viewer that parses this at another width than the PTY's shows
    // the `|` somewhere else (run-devroom-board2.ts checks it). Row 2 is blank and above the input box:
    // below it the row would be a draft to the input-box check (inputBoxTaken: every message 'inputBusy').
    const cols = process.stdout.columns || 80;
    out(`\x1b7\x1b[2;1H\x1b[2K cols=${cols}\x1b[2;${cols}H|\x1b8`);
  };
  process.stdout.on('resize', () => draw()); // after Node read the new size (a SIGWINCH listener runs before)
  const askPermission = (skipHook) => {
    let hook;
    try {
      hook = JSON.parse(arg('--settings') || '{}').hooks.PermissionRequest[0].hooks[0];
    } catch {
      hook = null;
    }
    status = 'waiting';
    writeSession();
    osc('blocked:kind=permission');
    draw();
    const decided = (behavior) => {
      fs.appendFileSync(path.join(HOME, 'fake-claude-perm.log'), `${JSON.stringify({ sessionId, behavior })}\n`);
      record('assistant', `permission: ${behavior}`);
      status = 'idle';
      writeSession();
      osc('done');
      draw();
    };
    const ownDialog = () => {
      fs.appendFileSync(path.join(HOME, 'fake-claude-perm.log'), `${JSON.stringify({ sessionId, behavior: 'dialog' })}\n`);
      dialog = decided;
      draw();
    };
    if (!hook || skipHook) return ownDialog();
    const child = spawn('sh', ['-c', hook.command], { stdio: ['pipe', 'pipe', 'ignore'] });
    let said = '';
    child.stdout.on('data', (d) => (said += d));
    child.on('close', () => {
      let behavior = 'dialog';
      try {
        behavior = JSON.parse(said).hookSpecificOutput.decision.behavior;
      } catch {
        /* no decision: Claude shows its own dialog */
      }
      if (behavior === 'dialog') ownDialog();
      else decided(behavior);
    });
    child.stdin.end(
      JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf fake-build', description: 'Fake permission check' },
      }),
    );
  };
  const submit = (now) => {
    const text = input;
    input = '';
    if (!text) return draw();
    fs.appendFileSync(path.join(HOME, 'fake-claude-typed.log'), `${JSON.stringify({ name, sessionId, text: text.replaceAll('\r', '\n'), ...(now && { now }) })}\n`);
    record('user', text.replaceAll('\r', '\n'));
    last = text.replaceAll('\r', ' ');
    status = 'busy';
    writeSession();
    osc('working');
    draw();
    if (text.includes('FAKE-PERMISSION')) return askPermission(text.includes('FAKE-PERMISSION-TERMINAL'));
    const compact = /FAKE-COMPACT(?: (\d+))?/.exec(text);
    if (compact) {
      compactingSince = Date.now();
      draw();
      const tick = setInterval(draw, 1_000);
      return setTimeout(() => {
        clearInterval(tick);
        compactingSince = 0;
        fs.appendFileSync(
          transcript,
          `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId, compactMetadata: { trigger: 'manual' } })}\n`,
        );
        record('assistant', 'compacted');
        status = 'idle';
        writeSession();
        osc('done');
        draw();
      }, Number(compact[1] || 8) * 1000);
    }
    // STATE-SYNC: "FAKE-JOB N" starts a background shell (a training job) and ends its turn; the
    // session file then says `shell` (Claude Code: idle while a shell runs) for N s, then idle.
    // "FAKE-LONG N" keeps one foreground tool call open N s (busy, the transcript quiet).
    const job = /FAKE-(JOB|LONG)(?: (\d+))?/.exec(text);
    if (job) {
      const add = (r) =>
        fs.appendFileSync(transcript, `${JSON.stringify({ uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId, ...r })}\n`);
      const id = `toolu_${crypto.randomUUID().slice(0, 8)}`;
      const background = job[1] === 'JOB';
      const end = (said) => {
        add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: said }] } });
        record('assistant', said);
        add({ type: 'system', subtype: 'turn_duration', durationMs: 1000 });
      };
      // An engine session skips permissions: no heuristic permission timer on the open call.
      add({ type: 'permission-mode', permissionMode: 'bypassPermissions' });
      add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'python train.py', ...(background && { run_in_background: true }) } }] } });
      const ms = Number(job[2] || 30) * 1000;
      if (!background)
        return setTimeout(() => {
          end('trained');
          status = 'idle';
          writeSession();
          osc('done');
          draw();
        }, ms);
      return setTimeout(() => {
        end('Command running in background with ID: b1');
        status = 'shell';
        writeSession();
        osc('done');
        draw();
        setTimeout(() => {
          status = 'idle';
          writeSession();
        }, ms);
      }, turnMs);
    }
    setTimeout(() => {
      record('assistant', `ok: ${last.slice(0, 40)}`);
      status = 'idle';
      writeSession();
      osc('done');
      draw();
    }, turnMs);
  };
  const bye = (code) => {
    fs.rmSync(sessFile, { force: true });
    try {
      osc('clear'); // a hung-up terminal (SIGHUP) takes no more output
    } catch {
      /* gone */
    }
    process.exit(code);
  };
  process.stdout.on('error', () => bye(129));

  const startedAt = Date.now();
  process.on('SIGHUP', () => bye(129));
  process.on('SIGTERM', () => bye(143));
  process.stdin.setRawMode(true);
  // The probe, as Claude Code sends it: OSC 7501 query and DA1 in one write.
  let probe = '';
  let probing = true;
  const endProbe = () => {
    if (!probing) return;
    probing = false;
    oscLog(reporting ? 'answered' : 'noreport');
    writeSession();
    osc('idle');
    draw();
  };
  setTimeout(endProbe, 1_000);
  out('\x1b]7501;?\x07\x1b[c');
  // A long paste comes in several reads: a character or an escape split between two waits for the next.
  process.stdin.setEncoding('utf8');
  let carry = '';
  process.stdin.on('data', (chunk) => {
    let s = carry + chunk;
    carry = '';
    const cut = s.lastIndexOf('\x1b');
    if (cut >= 0 && /^\x1b(\[[\d;?]*)?$/.test(s.slice(cut))) {
      carry = s.slice(cut);
      s = s.slice(0, cut);
    }
    if (probing) {
      probe += s;
      const a = probe.indexOf('\x1b]7501;?');
      const d = probe.search(/\x1b\[\?[\d;]*c/);
      if (d < 0) return;
      reporting = a >= 0 && a < d;
      s = probe.replace(/\x1b\]7501;[^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[\?[\d;]*c/g, '');
      endProbe();
    }
    while (s) {
      if (s.startsWith('\x1b[200~')) {
        pasting = true;
        s = s.slice(6);
      } else if (s.startsWith('\x1b[201~')) {
        pasting = false;
        s = s.slice(6);
      } else if (s.startsWith('\x1b[')) {
        // A terminal answer or a key we do not draw (CPR, arrows): dropped.
        const m = /^\x1b\[[\d;?]*[A-Za-z~]/.exec(s);
        s = s.slice(m ? m[0].length : 2);
      } else {
        const ch = s[0];
        s = s.slice(1);
        if (dialog && (ch === '1' || ch === '2')) {
          const done = dialog;
          dialog = null;
          done(ch === '1' ? 'terminal-allow' : 'terminal-deny');
        } else if (dialog) continue;
        else if (ch === '\x18') chordX = true;
        else if (ch === '\x13' && chordX) {
          chordX = false;
          submit(true);
        } else if (ch === '\r' && !pasting) submit(false);
        else if (ch === '\x7f') input = input.slice(0, -1);
        else if (ch === '\x03') bye(0);
        else if (ch >= ' ' || ch === '\r' || ch === '\n' || ch === '\t') input += ch;
      }
    }
    if (!probing) draw();
  });
};
