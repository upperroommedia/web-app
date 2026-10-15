import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ownerSource = fileURLToPath(
  new URL('../../apps/temporal-worker/src/test-support/local-test-server.cjs', import.meta.url)
);
const options = {
  server: {
    namespace: 'demo-owner-protocol',
    ip: '127.0.0.1',
    executable: { type: 'existing-path', path: '/fixture-only/temporal' },
  },
};

function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function killOwnedGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

// Exercise the actual committed owner artifact, substituting only its SDK
// boundary. These tests prove IPC/cleanup behavior, never native SDK behavior.
for (const mode of ['normal', 'startup-error', 'cleanup-report', 'disconnect']) {
  test(`actual server owner protocol with stub SDK: ${mode}`, { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'urm-owner-protocol-'));
    const marker = join(directory, 'closed.json');
    let child;
    let exited;
    let output = '';
    const messages = [];
    try {
      await mkdir(join(directory, 'node_modules/@temporalio/testing'), { recursive: true });
      await copyFile(ownerSource, join(directory, 'owner.cjs'));
      await writeFile(
        join(directory, 'node_modules/@temporalio/testing/index.js'),
        `exports.TestWorkflowEnvironment = {
  createLocal: async (options) => {
    if (process.env.PROTOCOL_MODE === 'startup-error') throw new Error('SYNTHETIC_STARTUP_CAUSE');
    return {
      address: '127.0.0.1:12345',
      namespace: options.server.namespace,
      teardown: async () => {
        require('node:fs').writeFileSync(process.env.PROTOCOL_MARKER, JSON.stringify(options));
        if (process.env.PROTOCOL_MODE === 'cleanup-report') console.error(new Error('SYNTHETIC_CLEANUP_CAUSE'));
      },
    };
  },
};\n`
      );
      child = fork(join(directory, 'owner.cjs'), [], {
        detached: true,
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // Do not inherit outer CI output paths, validation receipts or credentials.
        env: { PATH: process.env.PATH, PROTOCOL_MODE: mode, PROTOCOL_MARKER: marker },
      });
      const outputEnded = Promise.all([child.stdout, child.stderr].map((stream) =>
        new Promise((yes) => { stream.once('end', yes); stream.once('close', yes); })
      ));
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      exited = new Promise((yes, no) => {
        child.once('error', no);
        child.once('exit', (code, signal) => yes({ code, signal }));
      });
      // Both the explicit deadline and finally cleanup remain effective if the
      // owner never sends readiness or never exits. Jest/Node timeouts alone do not.
      const protocolError = new Promise((_, reject) => {
        child.on('message', (message) => {
          messages.push(message);
          if (message.type !== 'ready') return;
          if (mode === 'disconnect') child.disconnect();
          else child.send({ type: 'stop' }, (error) => { if (error) reject(error); });
        });
      });
      const started = new Promise((yes, no) => {
        child.send({ type: 'start', options }, (error) => (error ? no(error) : yes()));
      });
      const result = await deadline(
        Promise.race([started.then(() => exited), protocolError]),
        5_000,
        `Owner protocol ${mode}`
      );
      await deadline(outputEnded, 1_000, 'Owned output drainage');
      assert.equal(result.signal, null, output);
      assert.equal(result.code, ['normal', 'disconnect'].includes(mode) ? 0 : 1, output);
      if (mode !== 'startup-error') {
        assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), options);
        assert.ok(messages.some((message) =>
          message.type === 'ready' && message.namespace === options.server.namespace &&
          message.address === '127.0.0.1:12345'
        ));
      }
      if (mode === 'startup-error') {
        assert.match(output, /SYNTHETIC_STARTUP_CAUSE/);
        assert.ok(messages.some((message) => message.error?.message === 'SYNTHETIC_STARTUP_CAUSE'));
      }
      if (mode === 'cleanup-report') {
        assert.match(output, /SYNTHETIC_CLEANUP_CAUSE/);
        assert.ok(messages.some((message) => message.causes?.some((cause) => cause.message === 'SYNTHETIC_CLEANUP_CAUSE')));
      }
      assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
    } finally {
      try {
        killOwnedGroup(child);
        if (exited) await deadline(exited.catch(() => undefined), 2_000, 'Owned failure cleanup');
      } finally {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        if (child?.connected) child.disconnect();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
}
