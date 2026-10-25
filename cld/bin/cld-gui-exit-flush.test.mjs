import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cld-gui', import.meta.url));
const bytes = 2 * 1024 * 1024;
const childProgram = `
  const { exitAfterFlush } = require(process.argv[1]);
  process.stdout.write('x'.repeat(${bytes}));
  exitAfterFlush(Number(process.argv[2]));
`;

function flushingChild(code) {
  return spawn(process.execPath, ['-e', childProgram, cli, String(code)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function close(child, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not exit within ${timeout}ms`));
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('exitAfterFlush drains a 2 MB stdout pipe before retaining its exit code', async () => {
  const child = flushingChild(37);
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const result = await close(child);
  assert.deepEqual(result, { code: 37, signal: null });
  assert.equal(Buffer.concat(stdout).length, bytes);
  assert.equal(Buffer.concat(stderr).toString(), '');
});

test('exitAfterFlush handles a downstream pipe that closes after receiving output', async () => {
  const child = flushingChild(23);
  const stderr = [];
  let received = 0;
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.once('data', (chunk) => {
    received += chunk.length;
    child.stdout.destroy();
  });
  const result = await close(child);
  assert.ok(received >= 1_024, `reader only received ${received} bytes before closing`);
  assert.deepEqual(result, { code: 23, signal: null });
  assert.equal(Buffer.concat(stderr).toString(), '');
});

test('the CLI has no immediate process exits outside exitAfterFlush', () => {
  const source = fs.readFileSync(cli, 'utf8');
  assert.match(source, /async function exitAfterFlush\(code\)[\s\S]*?process\.exit\(code\);/);
  assert.equal((source.match(/\bprocess\.exit\(/g) ?? []).length, 1);
});
