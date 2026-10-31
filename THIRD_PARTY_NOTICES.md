# Third-party notices

## Orca (https://github.com/stablyai/orca)

Used in `server/src/cld/ptyhost/programStatus.ts`: the OSC 7501 probe reply
(`src/shared/program-status/protocol.ts`, PROGRAM_STATUS_QUERY_REPLY).
Used in `server/src/cld/ptyhost/conpty.ts`: the Windows ConPTY startup input check (the DA1/CPR and
visibility sequences, the classifier, one respawn, the check turned off when no terminal ever asked),
adapted from `src/main/daemon/pty-subprocess/conpty-startup-input-reader.ts`.
Paste timing (a 500 ms settle + 64 B/ms on Windows, 4 KB/ms elsewhere) is measured numbers from Orca, re-implemented.

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
