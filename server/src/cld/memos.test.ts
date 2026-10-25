import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WhiteboardMemos } from '../../../core/src/messages.js';
import { MEMO_MAX } from './memos.js';
import { ROSTER, startEngineOffice } from './officeTestKit.js';

const tmp: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const BOARD = 'whiteboard:orch-alpha';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';

async function memoOffice(home?: string) {
  const {
    office,
    messages,
    home: h,
    stop,
  } = await startEngineOffice({
    projects: ROSTER,
    home,
  });
  const fake = { home: h };
  const sent: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => sent.push(m);
  const file = `${fake.home}/.config/cld-gui/memos.json`;
  const ask = (uid: unknown, text: unknown, privileged = true, ua = IPHONE) =>
    office.onClientMessage({ type: 'setWhiteboardMemo', uid, text }, send, privileged, ua);
  const memos = (list: Array<Record<string, unknown>>) =>
    (
      [...list].reverse().find((m) => m.type === 'whiteboardMemos') as unknown as
        WhiteboardMemos | undefined
    )?.memos;
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf-8'));
  return { fake, office, messages, sent, send, ask, memos, onDisk, file, stop };
}

describe('whiteboard memos (T-0065)', () => {
  it('every work room has its whiteboard in the office', async () => {
    const { office } = await memoOffice();
    const ids = (office.layoutFor().furniture as Array<{ uid: string; type: string }>)
      .filter((f) => f.type === 'WHITEBOARD')
      .map((f) => f.uid);
    expect(ids).toContain(BOARD);
    expect(ids).toContain('whiteboard:orch-gamma');
  });

  it('a memo round-trips: file 0600, everyone gets it, a restart and a new client still see it', async () => {
    const first = await memoOffice();
    first.ask(BOARD, '  오늘은 배포\nship it  ', true);
    const stored = first.onDisk();
    expect(stored.v).toBe(1);
    expect(stored.memos[BOARD]).toMatchObject({ text: '오늘은 배포\nship it', by: 'ios' });
    expect(typeof stored.memos[BOARD].updatedAt).toBe('number');
    expect(fs.statSync(first.file).mode & 0o777).toBe(0o600);
    expect(first.memos(first.messages)).toEqual([
      { uid: BOARD, text: '오늘은 배포\nship it', updatedAt: stored.memos[BOARD].updatedAt },
    ]);
    const home = first.fake.home;
    first.stop();
    const again = await memoOffice(home);
    again.office.onClientReady(again.send);
    expect(again.memos(again.sent)).toEqual(first.memos(first.messages));
  });

  it('text is trimmed, at most 600 characters, and empty text deletes the memo', async () => {
    const { ask, onDisk, memos, sent, messages } = await memoOffice();
    ask(BOARD, 'x'.repeat(MEMO_MAX));
    expect(onDisk().memos[BOARD].text).toHaveLength(MEMO_MAX);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ask(BOARD, `${' '.repeat(5)}${'y'.repeat(MEMO_MAX + 1)}`);
    expect(onDisk().memos[BOARD].text).toBe('x'.repeat(MEMO_MAX)); // unchanged
    expect(memos(sent)?.[0].text).toHaveLength(MEMO_MAX); // the sender got the truth back
    expect(warn).toHaveBeenCalled();
    ask(BOARD, ' \n ');
    expect(onDisk().memos).toEqual({});
    expect(memos(messages)).toEqual([]);
  });

  it('a malformed memos.json is renamed aside and the store starts empty', async () => {
    const fake = { home: fs.mkdtempSync(path.join(os.tmpdir(), 'cld-memos-')) };
    tmp.push(fake.home);
    const dir = `${fake.home}/.config/cld-gui`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/memos.json`, '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { office, file } = await memoOffice(fake.home);
    expect(office.memos.message().memos).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('memos.json.corrupt-'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('moved to'));
  });

  it('an unknown uid, a furniture uid that is not a whiteboard, or a non-string is refused', async () => {
    const { ask, file, sent, memos } = await memoOffice();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ask('whiteboard:nowhere', 'hi');
    ask('desk:engine:alpha', 'hi');
    ask(42, 'hi');
    ask(BOARD, 42);
    expect(fs.existsSync(file)).toBe(false);
    expect(memos(sent)).toEqual([]);
  });

  it('a read-only client cannot write a memo', async () => {
    const { ask, file, messages } = await memoOffice();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ask(BOARD, 'sneaky', false);
    expect(fs.existsSync(file)).toBe(false);
    expect(messages.some((m) => m.type === 'whiteboardMemos')).toBe(false);
  });
});
