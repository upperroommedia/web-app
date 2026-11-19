import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import vm from 'node:vm';
import { imageReplayRunner } from '../temporal-image-replay.mjs';
import { proofDigest } from '../temporal-release-runtime.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { createLocalTestEnvironment } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts', import.meta.url)
));
const sdk = require('@temporalio/worker'),
  codec = require('@temporalio/common/lib/proto-utils');
sdk.Runtime.install({ logger: new sdk.DefaultLogger('ERROR', () => undefined) });
const sha = (x) => createHash('sha256').update(x).digest('hex');
const bounded = (work, ms = 20000) => {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('LOCAL image-runner fixture deadline')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

test('actual LOCAL payload-bearing history replays through fixed runner and production SDK codec under controlled image FS', async () => {
  let environment, worker, running;
  const failures = [];
  try {
    environment = await createLocalTestEnvironment({
      server: { executable: { type: 'cached-download', version: 'v1.9.1' } },
    });
    const bundle = await bounded(
      sdk.bundleWorkflowCode({
        workflowsPath: fileURLToPath(new URL('./fixtures/image-replay-payload.ts', import.meta.url)),
      })
    );
    const queue = `owned-image-replay-${randomUUID()}`;
    worker = await bounded(
      sdk.Worker.create({
        connection: environment.nativeConnection,
        namespace: 'default',
        taskQueue: queue,
        workflowBundle: bundle,
        shutdownGraceTime: '1 second',
        shutdownForceTime: '3 seconds',
      })
    );
    running = worker.run();
    void running.catch(() => {});
    const workflowId = `payload-${randomUUID()}`,
      input = { text: 'native-☃-payload', count: 42 };
    const handle = await bounded(
      environment.connection.withDeadline(Date.now() + 10000, () =>
        environment.client.workflow.start('ImageReplayPayloadProbe', {
          workflowId,
          taskQueue: queue,
          args: [input],
          workflowExecutionTimeout: '1 minute',
        })
      )
    );
    assert.equal(await bounded(handle.result()), `${input.text}:42`);
    const history = await bounded(handle.fetchHistory());
    assert.ok(history.events[0].workflowExecutionStartedEventAttributes.input.payloads[0].data instanceof Uint8Array);
    const historyJSON = codec.historyToJSON(history),
      buildId = 'b'.repeat(40);
    const request = {
      buildId,
      kind: 'replay',
      workflowId,
      runId: handle.firstExecutionRunId,
      historyJSON,
      historyJSONSHA256: sha(historyJSON),
      historySHA256: proofDigest(history),
    };
    const bytes = Buffer.from(bundle.code),
      out = [],
      errors = [],
      exits = [];
    const fs = {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
      openSync: (path) => path,
      fstatSync: (path) => ({ isFile: () => true, size: path.includes('build-id') ? 40 : bytes.length }),
      readFileSync: (path) => (path.includes('build-id') ? buildId : bytes),
      closeSync: () => {},
    };
    const controlledProcess = {
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify(request));
      })(),
      stdout: { write: (x) => out.push(x) },
      stderr: { write: (x) => errors.push(x) },
      exit: (code) => exits.push(code),
    };
    let replays = 0;
    // Only filesystem and shared Runtime ownership are controlled. Native replay and JSON codecs are real.
    const replaySDK = {
      ...sdk,
      Worker: {
        runReplayHistory: async (...args) => {
          replays++;
          return sdk.Worker.runReplayHistory(...args);
        },
      },
      Runtime: { install: () => {}, instance: () => ({ shutdown: async () => {} }) },
    };
    await bounded(
      vm.runInNewContext(imageReplayRunner, {
        Buffer,
        TextDecoder,
        process: controlledProcess,
        require: (path) => {
          if (path === 'node:fs') return fs;
          if (path === 'node:crypto') return { createHash };
          if (path === 'node:module') {
            return {
              createRequire: (packagePath) => {
                assert.equal(packagePath, '/workspace/apps/temporal-worker/package.json');
                return (name) => {
                  if (name === '@temporalio/worker') return replaySDK;
                  if (name === '@temporalio/common/lib/proto-utils') return codec;
                  throw new Error('Unexpected worker module');
                };
              },
            };
          }
          throw new Error('Unexpected runner module');
        },
      })
    );
    assert.deepEqual(exits, [0]);
    assert.deepEqual(errors, []);
    assert.equal(replays, 1);
    const result = JSON.parse(out[0]);
    assert.equal(result.bundleSHA256, sha(bytes));
    assert.equal(result.historySHA256, request.historySHA256);
    assert.equal(result.historyJSONSHA256, sha(historyJSON));
    assert.equal(result.runId, handle.firstExecutionRunId);
    assert.equal(result.workflowId, workflowId);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (worker?.getStatus().runState === 'RUNNING') worker.shutdown();
      if (running) await bounded(running, 10000);
    } catch (error) {
      failures.push(error);
    }
    try {
      await environment?.teardown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        failures.map(() => new Error('LOCAL replay fixture step failed')),
        'Native replay fixture failed'
      );
  }
});
