/** The `[첨부] <absolute path> (<type>, <n> KB)` lines a message carries for each file it sends. */
export interface AttachmentLine {
  path: string;
  name: string;
  type: string;
  sizeKb: number;
}

/** The message text without its trailing `[첨부]` lines, and the files they name. */
export function splitAttachmentText(text: string): { body: string; attachments: AttachmentLine[] } {
  const attachments: AttachmentLine[] = [];
  const lines = text.split('\n');
  while (lines.length) {
    const line = lines.at(-1)!;
    // An absolute path: POSIX, a Windows drive (C:\...) or UNC (\\wsl.localhost\...).
    const match = /^\[\ucca8\ubd80\] ((?:\/|[A-Za-z]:[\\/]|\\\\)[^\n]+) \(([^(),]+), (\d+) KB\)$/.exec(line);
    if (!match) break;
    const savedName = match[1].split(/[\\/]/).at(-1)!;
    attachments.unshift({
      path: match[1],
      name: savedName.replace(/^\d{8}-\d{6}-(?:-\d+-)?/, ''),
      type: match[2],
      sizeKb: Number(match[3]),
    });
    lines.pop();
  }
  return { body: lines.join('\n').trimEnd(), attachments };
}
