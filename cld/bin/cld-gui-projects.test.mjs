import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cld-gui', import.meta.url));

function runWithRegistry(shape) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-cli-projects-'));
  const folder = path.join(home, 'work', 'alpha');
  const file = path.join(home, '.config', 'cld-gui', 'projects.json');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const project = { name: 'alpha', folder };
  fs.writeFileSync(file, JSON.stringify(shape(project)));
  try {
    const result = spawnSync(process.execPath, [cli, 'send', 'alpha', 'hello'], {
      cwd: folder,
      env: { ...process.env, HOME: home, CLD_OUTPUT: 'json' },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const queue = path.join(home, '.config', 'cld-gui', 'queue');
    const entries = fs.readdirSync(queue);
    assert.equal(entries.length, 1);
    return JSON.parse(fs.readFileSync(path.join(queue, entries[0]), 'utf8'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('send accepts the same project from legacy, v1 and v2 projects.json', () => {
  const legacy = runWithRegistry((project) => [project]);
  const v1 = runWithRegistry((project) => ({ v: 1, projects: [project] }));
  // v2 (D2): name and folder stay in projects.json; the agent's fields moved to assignments.json.
  const v2 = runWithRegistry((project) => ({
    v: 2,
    projects: [{ projectId: 'p_aaaaaaaaaa', ...project, leadAssignmentId: 'a_aaaaaaaaaa' }],
  }));
  assert.deepEqual(
    { to: v2.to, from: v2.from ?? null, text: v2.text },
    { to: v1.to, from: v1.from ?? null, text: v1.text },
  );

  assert.deepEqual(
    { to: legacy.to, from: legacy.from ?? null, text: legacy.text },
    { to: v1.to, from: v1.from ?? null, text: v1.text },
  );
  assert.deepEqual(
    { to: legacy.to, from: legacy.from ?? null, text: legacy.text },
    { to: 'alpha', from: 'alpha', text: 'hello' },
  );
});

test('D3: with the daemon off, send queues for a Worker by its own name (assignments.json)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-cli-workers-'));
  const config = path.join(home, '.config', 'cld-gui');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(
    path.join(config, 'projects.json'),
    JSON.stringify({
      v: 2,
      projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: home, leadAssignmentId: 'a_aaaaaaaaaa' }],
    }),
  );
  fs.writeFileSync(
    path.join(config, 'assignments.json'),
    JSON.stringify({
      v: 2,
      assignments: [
        { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: false },
        { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_aaaaaaaaaa', role: 'worker', provider: 'claude', name: 'alpha-a', wantRunning: false },
      ],
    }),
  );
  const send = (to) =>
    spawnSync(process.execPath, [cli, 'send', to, 'hi'], {
      cwd: os.tmpdir(),
      env: { ...process.env, HOME: home, CLD_OUTPUT: 'json' },
      encoding: 'utf8',
      timeout: 5_000,
    });
  try {
    assert.equal(send('alpha-a').status, 0);
    assert.equal(send('ghost').status, 1);
    const queue = path.join(config, 'queue');
    const items = fs.readdirSync(queue).map((f) => JSON.parse(fs.readFileSync(path.join(queue, f), 'utf8')));
    assert.deepEqual(items.map((i) => i.to), ['alpha-a']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
