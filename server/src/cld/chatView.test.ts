/**
 * The office messenger (T-0043; T-0014's chat view) through the office:
 * chatView streams chatTranscript (all, then appends) while someone watches,
 * messengerContacts lists the leads, chatSend answers chatSendResult through
 * the engine messenger. Fake claude and the engine's fake only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import type { ChatTranscript } from '../../../core/src/messages.js';
import { startEngineOffice } from './officeTestKit.js';

async function start(opts: { claude: string; chat?: boolean }) {
  const k = await startEngineOffice({ claude: opts.claude, chat: opts.chat ?? true });
  const { office } = k;
  const got: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => got.push(m);
  office.onClientOpened(send); // a viewer: the tails are followed only while someone watches
  const transcripts = () =>
    got.filter((m) => m.type === 'chatTranscript') as unknown as ChatTranscript[];
  return {
    fake: { home: k.home },
    office,
    send,
    got,
    broadcasts: k.messages,
    idOf: k.agentId,
    transcripts,
  };
}

const line = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`;

describe('chat view through the office', () => {
  it('a Claude session: the transcript now and on change, read-only, nothing after closing', async () => {
    const t = await start({ claude: 'S-8' });
    const file = path.join(
      t.fake.home,
      '.claude/projects/-work-alpha/a0000001-0000-4000-8000-000000000001.jsonl',
    );
    fs.writeFileSync(file, line({ type: 'user', message: { content: '안녕' } }));
    const alpha = t.idOf('alpha-orchestrator');
    t.office.onClientMessage({ type: 'chatView', agentId: alpha, on: true }, t.send, true);
    expect(t.transcripts()[0]).toMatchObject({
      type: 'chatTranscript',
      agentId: alpha,
      items: [{ kind: 'user', text: '안녕' }],
      canSend: false,
    });
    fs.appendFileSync(
      file,
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '반가워요' }] } }),
    );
    await vi.waitFor(() => expect(t.transcripts()).toHaveLength(2), 5_000);
    expect(t.transcripts()[1]).toMatchObject({
      append: true,
      items: [{ kind: 'assistant', text: '반가워요' }],
    });
    const contacts = () =>
      [...t.broadcasts].reverse().find((m) => m.type === 'messengerContacts') as
        { contacts: Array<{ name: string; preview?: string; canSend?: boolean }> } | undefined;
    expect(contacts()?.contacts.find((c) => c.name === 'alpha-orchestrator')).toMatchObject({
      preview: '반가워요',
      canSend: false,
    });

    t.office.onClientMessage({ type: 'chatView', agentId: alpha, on: false }, t.send, true);
    fs.appendFileSync(file, line({ type: 'user', message: { content: 'later' } }));
    await new Promise((r) => setTimeout(r, 2_000));
    expect(t.transcripts()).toHaveLength(2); // nothing after closing
  });

  it('an engine project: chatSend goes through the engine messenger with the boss header', async () => {
    const { home, office } = await startEngineOffice({ readOnly: false, chat: true });
    const got: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => got.push(m);
    const folder = fs.mkdtempSync(path.join(home, 'alpha-'));
    office.onClientMessage(
      { type: 'engineAction', requestId: 'r1', action: 'add', name: 'alpha', folder },
      send,
      true,
    );
    await vi.waitFor(() => expect(got[0]).toMatchObject({ type: 'engineActionResult', ok: true }));
    const chat = (text: string, privileged = true) =>
      office.onClientMessage(
        { type: 'chatSend', requestId: `q-${text}`, name: 'alpha', text },
        send,
        privileged,
        'Mozilla/5.0 (iPhone)',
      );
    const result = (text: string) =>
      vi.waitFor(() => {
        const r = got.find((m) => m.type === 'chatSendResult' && m.requestId === `q-${text}`);
        expect(r).toBeDefined();
        return r!;
      });
    chat('nope', false);
    expect(await result('nope')).toMatchObject({
      ok: false,
      error: '이 접속에는 조작 권한이 없어요',
    });
    chat('bad\x1b[31m');
    expect(await result('bad\x1b[31m')).toMatchObject({ ok: false });
    // The session is off: the message waits in its inbox, with the messenger's header.
    chat('배포해 줘');
    expect(await result('배포해 줘')).toMatchObject({ ok: true, delivered: 'inbox' });
    const inbox = path.join(home, '.config/cld-gui/inbox/alpha');
    const [file] = fs.readdirSync(inbox).filter((name) => name.endsWith('.md'));
    expect(fs.readFileSync(path.join(inbox, file), 'utf-8')).toMatch(
      /^\[사장 · 메신저 · \d\d-\d\d \d\d:\d\d\] ⟨m:[a-z2-7]{8}⟩\n배포해 줘$/,
    );
    expect(fs.existsSync(path.join(home, 'fake-claude-typed.log'))).toBe(false);
    // Pending edits and cancels are privileged too; a read-only client never
    // learns whether this inbox message exists.
    office.onClientMessage(
      { type: 'chatCancel', requestId: 'cancel-read-only', name: 'alpha', id: `inbox:${file}` },
      send,
      false,
    );
    await vi.waitFor(() =>
      expect(
        got.find((m) => m.type === 'chatPendingResult' && m.requestId === 'cancel-read-only'),
      ).toMatchObject({
        ok: false,
        error: '이 접속에는 조작 권한이 없어요',
      }),
    );
    // 지금 보내기: only a message still in the queue, only from a privileged client.
    const sendNow = (requestId: string, privileged = true) =>
      office.onClientMessage(
        { type: 'chatSendNow', requestId, name: 'alpha', id: '1-000001abcd.json' },
        send,
        privileged,
      );
    sendNow('n1');
    sendNow('n2', false);
    await vi.waitFor(() =>
      expect(
        got.filter((m) => m.type === 'chatSendResult' && /^n\d$/.test(String(m.requestId))),
      ).toHaveLength(2),
    );
    expect(got.find((m) => m.requestId === 'n1')).toMatchObject({
      ok: false,
      error: '기다리는 메시지가 아니에요',
    });
    expect(got.find((m) => m.requestId === 'n2')).toMatchObject({
      ok: false,
      error: '이 접속에는 조작 권한이 없어요',
    });
    const leadRow = office.officeState().orchestrators.find((o) => o.name === 'alpha');
    expect(leadRow?.provider).toBe('engine');
  });

  it('a Claude session that is no engine project: the view is read-only and a send is refused', async () => {
    const t = await start({ claude: 'C-4' });
    const alpha = t.idOf('alpha-orchestrator');
    t.office.onClientMessage({ type: 'chatView', agentId: alpha, on: true }, t.send, true);
    expect(t.transcripts()[0]).toMatchObject({ agentId: alpha, items: [], canSend: false });
    t.office.onClientMessage(
      { type: 'chatSend', requestId: 'q1', name: 'alpha-orchestrator', text: 'hi' },
      t.send,
      true,
    );
    await vi.waitFor(() => expect(t.got.some((m) => m.type === 'chatSendResult')).toBe(true));
    expect(t.got.find((m) => m.type === 'chatSendResult')).toMatchObject({
      ok: false,
      error: '엔진 프로젝트가 아니에요',
    });
  });

  it('with chat off nothing is served', async () => {
    const t = await start({ claude: 'S-8', chat: false });
    t.office.onClientMessage(
      { type: 'chatView', agentId: t.idOf('alpha-orchestrator'), on: true },
      t.send,
      true,
    );
    t.office.onClientMessage(
      { type: 'chatSend', requestId: 'q1', name: 'alpha-orchestrator', text: 'hi' },
      t.send,
      true,
    );
    await vi.waitFor(() => expect(t.got.some((m) => m.type === 'chatSendResult')).toBe(true));
    expect(t.transcripts()).toEqual([]);
    expect(t.got.find((m) => m.type === 'chatSendResult')).toMatchObject({
      ok: false,
      error: '대화 기능이 꺼져 있어요',
    });
  });
});

/** The read-only work view of a temp (T-0056) through the office. */
describe('work view through the office', () => {
  const workContents = (t: Awaited<ReturnType<typeof start>>) =>
    t.got.filter((m) => m.type === 'workContent');
  const agentProgress = (parent: string, message: Record<string, unknown>) =>
    line({
      type: 'progress',
      parentToolUseID: parent,
      data: { type: 'agent_progress', message },
    });

  it('a sub-agent of a lead: its prompt, text and tool lines from the lead transcript, secrets masked', async () => {
    const t = await start({ claude: 'S-8' });
    const file = path.join(
      t.fake.home,
      '.claude/projects/-work-alpha/a0000001-0000-4000-8000-000000000001.jsonl',
    );
    const spawn = 'toolu_WORKVIEW01';
    const sidechain = (content: Array<Record<string, unknown>>) =>
      agentProgress(spawn, { type: 'assistant', message: { content } });
    fs.writeFileSync(
      file,
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: spawn, name: 'Task', input: { prompt: '배포 로그를 읽어 줘' } },
          ],
        },
      }) +
        sidechain([
          { type: 'text', text: '읽는 중입니다' },
          {
            type: 'tool_use',
            id: 'toolu_in1',
            name: 'Bash',
            input: { command: 'curl -H "Authorization: Bearer HUNTER2-SECRET" https://x.test' },
          },
        ]),
    );
    const alpha = t.idOf('alpha-orchestrator');
    t.office.onClientMessage(
      { type: 'workView', kind: 'subagent', agentId: alpha, id: spawn, on: true },
      t.send,
      true,
    );
    await vi.waitFor(() => expect(workContents(t)).toHaveLength(1), 5_000);
    const [msg] = workContents(t) as unknown as Array<{
      items: Array<{ kind: string; text: string }>;
    }>;
    expect(msg.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(msg.items[0].text).toBe('배포 로그를 읽어 줘');
    expect(JSON.stringify(msg)).not.toContain('HUNTER2-SECRET');
    expect(msg.items[2].text).toContain('***');
    // Followed while open, and not after closing.
    fs.appendFileSync(file, sidechain([{ type: 'text', text: '끝났어요' }]));
    await vi.waitFor(() => expect(workContents(t)).toHaveLength(2), 5_000);
    expect(workContents(t)[1]).toMatchObject({ append: true, items: [{ text: '끝났어요' }] });
    t.office.onClientMessage(
      { type: 'workView', kind: 'subagent', agentId: alpha, id: spawn, on: false },
      t.send,
      true,
    );
    fs.appendFileSync(file, sidechain([{ type: 'text', text: '닫은 뒤' }]));
    await new Promise((r) => setTimeout(r, 2_000));
    expect(workContents(t)).toHaveLength(2);
  });

  it('gates: an unprivileged client gets a refusal; chat off serves nothing; a bad request is dropped', async () => {
    const t = await start({ claude: 'S-8' });
    const alpha = t.idOf('alpha-orchestrator');
    const view = { type: 'workView', kind: 'subagent', agentId: alpha, id: 'toolu_x', on: true };
    t.office.onClientMessage(view, t.send, false);
    expect(workContents(t)).toEqual([
      expect.objectContaining({ items: [], error: '이 접속에는 조작 권한이 없어요' }),
    ]);
    t.office.onClientMessage({ type: 'workView', kind: 'subagent', on: true }, t.send, true);
    t.office.onClientMessage({ ...view, agentId: 999_999 }, t.send, true);
    expect(workContents(t)[1]).toMatchObject({ error: '이 일의 기록을 찾지 못했어요' });
    const off = await start({ claude: 'S-8', chat: false });
    off.office.onClientMessage(view, off.send, true);
    expect(workContents(off)).toEqual([]);
  });
});
