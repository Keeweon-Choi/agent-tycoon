// Fake `claude attach <id>` (T-0014), run by ./claude in a PTY: a prompt line,
// then echoes what is typed; Enter answers "you said: ...", a resize prints
// the new size. Like the real one, Ctrl+Z detaches (exit 0), and ← on an empty
// line offers the agent view ("Press ← again to go back to agents"); a second ←
// draws its footer on the bottom row.
const out = (s) => process.stdout.write(s);
process.stdin.setRawMode(true);
out(`fake claude attach ${process.argv[2]}\r\n> `);
process.stdout.on('resize', () =>
  out(`\r\n[size ${process.stdout.columns}x${process.stdout.rows}]\r\n> `),
);
let line = '';
let offered = false;
process.stdin.on('data', (buf) => {
  const s = buf.toString('utf8');
  if (s.includes('\x1a')) process.exit(0);
  if (s === '\x1b[D' || s === '\x1bOD') {
    if (line) return out('\x1b[D');
    if (offered) return out(`\x1b[${process.stdout.rows};1Henter to return · space to reply`);
    offered = true;
    return out('\r\nPress ← again to go back to agents\r\n> ');
  }
  offered = false;
  for (const ch of s) {
    if (ch === '\r') {
      out(`\r\nyou said: ${line}\r\n> `);
      line = '';
    } else if (ch === '\x7f') {
      if (line) out('\b \b');
      line = line.slice(0, -1);
    } else {
      line += ch;
      out(ch);
    }
  }
});
