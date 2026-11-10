/** Which device a /ws client is, from its User-Agent: the label in the daemon's log lines and the `gui:<device>` source of what it does. */

/** The /ws client's device from its User-Agent (Android before Linux: its UA names both). */
export function deviceLabel(userAgent?: string): string {
  const ua = userAgent ?? '';
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh/i.test(ua)) return 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return 'web';
}

/** `gui:<device>` for one action: only [a-z0-9-], 16 characters at most. */
export function deviceSource(device: string): string {
  return `gui:${
    device
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 16) || 'web'
  }`;
}
