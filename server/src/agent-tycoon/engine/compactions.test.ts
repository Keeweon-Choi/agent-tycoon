import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RENEW_FILL_PCT } from '../../constants.js';
import { modelSwitch } from './agents/claude/claude.js';
import type { ModelSwitch } from './agents/types.js';
import { CompactionWatch } from './compactions.js';
import type { ProjectRecord } from './registry.js';
import type { Live } from './sessionMatch.js';

const MARK = '"compact_boundary"';

describe('CompactionWatch', () => {
  let dir: string;
  let file: string;
  let sessionId: string;
  let fill: number | undefined;
  let events: Array<Record<string, unknown>>;
  let nudges: Array<[string, number, number | null]>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compactions-'));
    file = path.join(dir, 't.jsonl');
    sessionId = 's1';
    fill = 10;
    events = [];
    nudges = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const project = { name: 'alpha', compactionNudge: 2 } as unknown as ProjectRecord;
  const holder = (): Live =>
    ({
      kind: 'background',
      sessionId,
      agent: { compaction: { mark: MARK, fillPct: () => fill }, transcript: () => file },
    }) as unknown as Live;
  const watch = new CompactionWatch({
    event: (_t, _s, f) => events.push(f),
    nudge: (n, c, p) => nudges.push([n, c, p]),
  });
  const check = () => watch.check([project], holder);

  it('counts a mark split across two growing writes once, and does not nudge on the first look', () => {
    // first look: one boundary already there, never reported
    fs.writeFileSync(file, `{"t":${MARK}}\n`);
    check();
    expect(watch.countFor('alpha', 's1')).toBe(1);
    expect(events).toEqual([]);
    // the next boundary arrives cut in two across writes (the carry joins them)
    fs.appendFileSync(file, '{"t":"compact_');
    check();
    expect(watch.countFor('alpha', 's1')).toBe(1);
    fs.appendFileSync(file, 'boundary"}\n');
    check();
    expect(watch.countFor('alpha', 's1')).toBe(2);
    expect(events).toEqual([{ name: 'alpha', count: 2 }]);
    expect(watch.sigPart()).toEqual([['alpha', 2]]);
    // refilled after the count: the one nudge, once
    fill = RENEW_FILL_PCT + 1;
    fs.appendFileSync(file, '{"x":1}\n');
    check();
    fs.appendFileSync(file, '{"x":2}\n');
    check();
    expect(nudges).toEqual([['alpha', 2, RENEW_FILL_PCT + 1]]);
  });

  it('T-96: a later boundary before any refill nudges once with no fill (null), not a made-up one', () => {
    fs.writeFileSync(file, `{"t":${MARK}}\n`);
    check(); // first look
    fs.appendFileSync(file, `{"t":${MARK}}\n`);
    check(); // the 2nd boundary: the count is reached, the context is empty
    expect(nudges).toEqual([]);
    fs.appendFileSync(file, `{"t":${MARK}}\n`);
    check(); // the 3rd, no refill seen between
    expect(nudges).toEqual([['alpha', 3, null]]);
    fs.appendFileSync(file, `{"t":${MARK}}\n`);
    check();
    expect(nudges).toEqual([['alpha', 3, null]]); // once
  });

  it('counts a project without compactionNudge too, and never nudges it', () => {
    const plain = { name: 'plain' } as unknown as ProjectRecord;
    const watch = new CompactionWatch({
      event: (_t, _s, f) => events.push(f),
      nudge: (n, c, p) => nudges.push([n, c, p]),
    });
    fill = RENEW_FILL_PCT + 1;
    fs.writeFileSync(file, `{"t":${MARK}}\n{"t":${MARK}}\n`);
    watch.check([plain], holder);
    expect(watch.countFor('plain', 's1')).toBe(2);
    fs.appendFileSync(file, `{"t":${MARK}}\n`);
    watch.check([plain], holder);
    expect(watch.countFor('plain', 's1')).toBe(3);
    fs.appendFileSync(file, '{"x":1}\n');
    watch.check([plain], holder);
    expect(nudges).toEqual([]);
    expect(events).toEqual([{ name: 'plain', count: 3 }]);
  });

  it('a new session id resets the count, and forget drops it', () => {
    fs.writeFileSync(file, `{"t":${MARK}}\n{"t":${MARK}}\n`);
    check();
    expect(watch.countFor('alpha', 's1')).toBe(2);
    expect(watch.countFor('alpha', 's2')).toBe(0);
    sessionId = 's2';
    fs.writeFileSync(file, `{"t":${MARK}}\n`);
    check();
    expect(watch.countFor('alpha', 's2')).toBe(1);
    watch.forget('alpha');
    expect(watch.sigPart()).toEqual([]);
  });

  describe('T-144: an explicit /model', () => {
    const STARTED = Date.parse('2026-11-13T05:00:00Z');
    const AT = STARTED + 10_000; // the default line time below
    const at = (s: number) => new Date(STARTED + s * 1000).toISOString();
    const line = (o: Record<string, unknown>, s = 10) =>
      `${JSON.stringify({ parentUuid: null, isSidechain: false, timestamp: at(s), ...o })}\n`;
    const user = (content: string, o: Record<string, unknown> = {}, s?: number) =>
      line({ type: 'user', message: { role: 'user', content }, ...o }, s);
    const command = (o: Record<string, unknown> = {}, s?: number) =>
      user(
        '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',
        o,
        s,
      );
    const result = (text: string, o: Record<string, unknown> = {}, s?: number) =>
      user(`<local-command-stdout>${text}</local-command-stdout>`, o, s);
    const switched = (shown: string, o: Record<string, unknown> = {}, s?: number) =>
      user('<local-command-caveat>Caveat.</local-command-caveat>', { isMeta: true, ...o }, s) +
      command(o, s) +
      result(`Set model to \`${shown}\` and saved as your default for new sessions`, o, s);
    const reply = (model: string, o: Record<string, unknown> = {}) =>
      line({
        type: 'assistant',
        ...(model !== '<synthetic>' && { requestedModel: model }),
        message: { model, content: [] },
        ...o,
      });

    let picks: ModelSwitch[];
    let settle: boolean;
    const follow = new CompactionWatch({ model: (_n, pick) => (picks.push(pick), settle) });
    const claudeHolder = (
      agent: Record<string, unknown> = { modelSwitch },
      startedAt: number | null = STARTED, // null: the session file has none
    ): Live =>
      ({
        kind: 'background',
        sessionId,
        startedAt: startedAt ?? undefined,
        agent: {
          compaction: { mark: MARK, fillPct: () => null },
          transcript: () => file,
          ...agent,
        },
      }) as unknown as Live;
    const look = (agent?: Record<string, unknown>, rec = project, startedAt?: number | null) =>
      follow.check([rec], () => claudeHolder(agent, startedAt));
    beforeEach(() => {
      picks = [];
      settle = true;
      follow.forget('alpha');
    });

    /** The real mid-turn order (the messenger's /model to a busy lead): a reply in flight is
     *  written after the result line, still on the old model, then a tool result, then the new. */
    const midTurn = [
      user('<local-command-caveat>Caveat.</local-command-caveat>', { isMeta: true }),
      command(),
      result('Set model to `Opus 5.5` and saved as your default for new sessions'),
      reply('claude-fable-5-2'),
      user('', {
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
      }),
      reply('claude-opus-5-5'),
    ];
    it.each([1, 2, 3, 4, 5])(
      'the mid-turn order read in two parts (cut after line %i): the shown name only',
      (k) => {
        fs.writeFileSync(file, `{}\n${midTurn.slice(0, k).join('')}`);
        look();
        fs.appendFileSync(file, midTurn.slice(k).join(''));
        look();
        expect(picks.length).toBeGreaterThan(0);
        for (const pick of picks) expect(pick).toEqual({ shown: 'Opus 5.5', at: AT });
      },
    );

    it('a switch not settled (no model list yet) is tried again at each look, a grown file or not', () => {
      settle = false;
      fs.writeFileSync(file, `{}\n${switched('Opus 5.5')}`);
      look();
      fs.appendFileSync(file, reply('claude-opus-5-5').slice(0, 20)); // a line cut mid-way: not read yet
      look();
      look(); // nothing new: still tried (a renew's look right after the /model)
      expect(picks).toEqual([
        { shown: 'Opus 5.5', at: AT },
        { shown: 'Opus 5.5', at: AT },
        { shown: 'Opus 5.5', at: AT },
      ]);
      settle = true;
      look();
      expect(picks).toHaveLength(4);
      fs.appendFileSync(file, `${reply('claude-opus-5-5').slice(20)}${reply('claude-fable-5-2')}`);
      look();
      expect(picks).toHaveLength(4); // settled: a later reply on another model is not a switch
    });

    it('a pending switch older than a later explicit choice is dropped on a look where the file grew too', () => {
      settle = false;
      fs.writeFileSync(file, `{}\n${switched('Opus 5.5')}`);
      look();
      expect(picks).toHaveLength(1);
      settle = true; // the list arrives
      fs.appendFileSync(file, reply('claude-opus-5-5')); // and the conversation goes on
      look(undefined, { ...project, modelSwitchAt: AT + 5_000 } as ProjectRecord);
      expect(picks).toHaveLength(1);
    });

    it('a pending switch older than a later explicit choice (a form edit) is dropped', () => {
      settle = false;
      fs.writeFileSync(file, `{}\n${switched('Opus 5.5')}`);
      look();
      expect(picks).toHaveLength(1);
      look(undefined, { ...project, modelSwitchAt: AT + 5_000 } as ProjectRecord);
      settle = true;
      look();
      expect(picks).toHaveLength(1);
    });

    // Every result line the installed CLI wrote on this PC (11-13 grep over all transcripts).
    it.each([
      ['Set model to `Opus 5.5` and saved as your default for new sessions', 'Opus 5.5'],
      [
        'Set model to `Opus 5.5` and saved as your default for new sessions · `max` effort for this session only',
        'Opus 5.5',
      ],
      [
        'Set model to `Opus 5.5` and saved as your default for new sessions with `max` effort',
        'Opus 5.5',
      ],
      [
        'Set model to `Fable 5.2` and saved as your default for new sessions with `xhigh` effort',
        'Fable 5.2',
      ],
      ['Set model to `Opus 5.5`', 'Opus 5.5'],
      ['Kept model as `Opus 5.5`', null],
    ])('the real result line %j', (text, shown) => {
      fs.writeFileSync(file, `{}\n${command()}${result(text)}`);
      look();
      expect(picks).toEqual(shown ? [{ shown, at: AT }] : []);
    });

    it('a kept picker as the CLI writes it (two system lines, 11-13 22:02) is not a switch', () => {
      const local = (content: string) =>
        `${JSON.stringify({ isSidechain: false, type: 'system', subtype: 'local_command', content, level: 'info', timestamp: at(10), isMeta: false, version: '2.1.323' })}\n`;
      fs.writeFileSync(
        file,
        `{}\n${local('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>')}` +
          `${local('<local-command-stdout>Kept model as `Fable 5.2`</local-command-stdout>')}${reply('claude-fable-5-2')}`,
      );
      look();
      expect(picks).toEqual([]);
    });

    it('another user line between the /model line and a result is no switch', () => {
      fs.writeFileSync(
        file,
        `{}\n${command()}${user('hello')}${result('Set model to `Opus 5.5`')}`,
      );
      look();
      expect(picks).toEqual([]);
    });

    it('a /model already followed (the record marker) is not followed again; a newer one is', () => {
      const marked = { ...project, model: 'claude-x-1', modelSwitchAt: AT } as ProjectRecord;
      fs.writeFileSync(file, `{}\n${switched('Opus 5.5')}${reply('claude-opus-5-5')}`);
      look(undefined, marked);
      expect(picks).toEqual([]);
      fs.appendFileSync(file, `${switched('Fable 5.2', {}, 11)}${reply('claude-fable-5-2')}`);
      look(undefined, marked);
      expect(picks).toEqual([{ shown: 'Fable 5.2', at: AT + 1000 }]);
    });

    it('a session with no start time: the history already written is not followed, a later /model is', () => {
      const later = (Date.now() + 60_000 - STARTED) / 1000; // seconds after STARTED, past this look
      fs.writeFileSync(file, `{}\n${switched('Opus 5.5')}${reply('claude-opus-5-5')}`);
      look(undefined, project, null);
      expect(picks).toEqual([]);
      fs.appendFileSync(file, `${switched('Fable 5.2', {}, later)}${reply('claude-fable-5-2')}`);
      look(undefined, project, null);
      expect(picks).toEqual([{ shown: 'Fable 5.2', at: STARTED + later * 1000 }]);
    });

    it('negative controls: no /model, another served model, a cancelled picker, a sidechain, a quoted line, one before the start, no parser', () => {
      fs.writeFileSync(
        file,
        `{}\n${reply('claude-fable-5-2')}${reply('claude-sonnet-4-6')}${reply('<synthetic>')}` +
          `${command()}${result('Kept model as `Opus 5.5`')}${reply('claude-fable-5-2')}` +
          `${switched('Haiku 4.5', { isSidechain: true })}${reply('claude-haiku-4-5', { isSidechain: true })}` +
          `${user('This session is being continued. <local-command-stdout>Set model to `Opus 5.5`</local-command-stdout>')}` +
          `${result('Set model to `Opus 5.5` and saved')}${reply('claude-opus-5-5')}` +
          `${switched('Opus 5.5', {}, -60)}${reply('claude-opus-5-5')}`,
      );
      look();
      expect(picks).toEqual([]);
      // Codex, ACP: no modelSwitch, so a Claude-shaped switch in their file is never read.
      follow.forget('alpha');
      fs.appendFileSync(file, `${switched('Opus 5.5')}${reply('claude-opus-5-5')}`);
      look({ modelSwitch: undefined });
      expect(picks).toEqual([]);
    });
  });
});
