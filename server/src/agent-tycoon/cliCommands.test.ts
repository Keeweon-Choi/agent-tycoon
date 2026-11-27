import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeCommandsCache } from './cliCommands.js';

const TEST_TIMEOUT_MS = 2_500; // well past a node start on a loaded PC, so the fake always records its run
const TEST_RETRY_MS = 60_000;
const ACCOUNT_MARKER = 'planted-account-must-not-leak';
const dirs: string[] = [];

const fixture = path.join(__dirname, 'fixtures', 'claude-initialize.json');
const make = (mode: 'answer' | 'fail' | 'wait') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-cli-commands-'));
  dirs.push(dir);
  const home = path.join(dir, 'home');
  const executable = path.join(dir, 'fake-claude');
  const calls = path.join(dir, 'calls');
  const input = path.join(dir, 'input');
  const source = `#!/usr/bin/env node
const fs = require('fs');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.CALLS, 'run\\n');
  fs.writeFileSync(process.env.INPUT, Buffer.concat(chunks));
  if (process.env.MODE === 'fail') process.exit(1);
  if (process.env.MODE === 'wait') return setInterval(() => undefined, 1000);
  // Claude Code 2.1.323: the payload is one level deeper, under response.response.
  const inner = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
  inner.account = { marker: '${ACCOUNT_MARKER}', email: 'not-an-owner@example.test' };
  console.log(JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'agent-tycoon-initialize', response: inner },
  }));
});
`;
  fs.writeFileSync(executable, source, { mode: 0o755 });
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    CALLS: calls,
    INPUT: input,
    FIXTURE: fixture,
    MODE: mode,
  };
  const callsCount = () =>
    fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  return { executable, home, env, calls, input, callsCount };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ClaudeCommandsCache', () => {
  it('keeps only version, command and model metadata from the initialize response', async () => {
    const fake = make('answer');
    const cache = new ClaudeCommandsCache({
      claude: fake.executable,
      env: () => fake.env,
      home: fake.home,
    });
    const result = await cache.get();
    expect(fake.callsCount()).toBe(1);
    expect(JSON.parse(fs.readFileSync(fake.input, 'utf8'))).toMatchObject({
      type: 'control_request',
      request: { subtype: 'initialize' },
    });
    expect(result).toMatchObject({
      version: '2.1.323',
      commands: expect.arrayContaining([expect.objectContaining({ name: 'compact' })]),
      models: expect.arrayContaining([expect.objectContaining({ value: 'default' })]),
    });
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_MARKER);
    expect(fs.readFileSync(fake.calls, 'utf8')).not.toContain(ACCOUNT_MARKER);
  });

  it('caches one executable build, reruns after it changes, and shares concurrent callers', async () => {
    const fake = make('answer');
    const cache = new ClaudeCommandsCache({
      claude: fake.executable,
      env: () => fake.env,
      home: fake.home,
    });
    await expect(Promise.all([cache.get(), cache.get()])).resolves.toHaveLength(2);
    expect(fake.callsCount()).toBe(1);
    await cache.get();
    expect(fake.callsCount()).toBe(1);
    fs.appendFileSync(fake.executable, '\n');
    await cache.get();
    expect(fake.callsCount()).toBe(2);
  });

  it('backs off failures and timeouts instead of starting Claude for every request', async () => {
    for (const mode of ['fail', 'wait'] as const) {
      const fake = make(mode);
      const cache = new ClaudeCommandsCache({
        claude: fake.executable,
        env: () => fake.env,
        home: fake.home,
        retryMs: TEST_RETRY_MS,
        timeoutMs: TEST_TIMEOUT_MS,
      });
      await expect(cache.get()).resolves.toBeNull();
      await expect(cache.get()).resolves.toBeNull();
      expect(fake.callsCount()).toBe(1);
    }
  }, 15_000);

  it('asks again once the back-off has passed, and a later answer is kept', async () => {
    const fake = make('fail');
    let now = 1_000;
    const cache = new ClaudeCommandsCache({
      claude: fake.executable,
      env: () => fake.env,
      home: fake.home,
      now: () => now,
      retryMs: TEST_RETRY_MS,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    await expect(cache.get()).resolves.toBeNull();
    expect(fake.callsCount()).toBe(1);
    fake.env.MODE = 'answer';
    now += TEST_RETRY_MS - 1;
    await expect(cache.get()).resolves.toBeNull();
    expect(fake.callsCount()).toBe(1);
    now += 1;
    await expect(cache.get()).resolves.not.toBeNull();
    expect(fake.callsCount()).toBe(2);
    await cache.get();
    expect(fake.callsCount()).toBe(2);
  });
});
