import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, rm, realpath, readFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { historyToJSON, historyFromJSON } = require('@temporalio/common/lib/proto-utils');
const { temporal } = require('@temporalio/proto');
import {
  createImageReplayObserver,
  imageReplayRunner,
  imageReplayRunnerSHA256,
  assertImageReplayReceipt,
} from './temporal-image-replay.mjs';
const sha = (x) => createHash('sha256').update(x).digest('hex');
const image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'a'.repeat(64)}`;
const options = () => ({
  image,
  buildId: 'b'.repeat(40),
  operationId: randomUUID(),
  bindingDigest: 'c'.repeat(64),
  evidenceDigest: 'd'.repeat(64),
});
function fixture(mode = 'normal') {
  const o = { ...options(), historyToJSON },
    containers = new Map(),
    calls = [],
    inputs = [];
  const transport = async (args, input = '') => {
    calls.push(args);
    if (args[0] === 'image')
      return {
        code: 0,
        stdout: JSON.stringify({
          Id: `sha256:${'1'.repeat(64)}`,
          RepoDigests: mode === 'wrong-image' ? [] : [image],
          Os: 'linux',
          Architecture: 'amd64',
        }),
      };
    if (args[1] === 'create') {
      if (mode === 'lost-create') return { code: null, stdout: '', stderr: '' };
      const id = sha(args.join('|')),
        flag = (key) => args[args.indexOf(key) + 1];
      const labels = Object.fromEntries(args.flatMap((v, i) => (v === '--label' ? [args[i + 1].split('=')] : [])));
      containers.set(id, {
        Id: id,
        Image: `sha256:${'1'.repeat(64)}`,
        Name: `/${flag('--name')}`,
        Created: new Date().toISOString(),
        Config: { Image: image, User: 'node', Entrypoint: ['node'], Cmd: ['-e', imageReplayRunner], Labels: labels },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          Privileged: false,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Memory: 1024 ** 3,
          NanoCpus: 1e9,
          PidsLimit: 128,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=67108864' },
          Binds: [],
        },
        Mounts: [],
        State: { Status: 'created', Running: false, ExitCode: 0, OOMKilled: false },
      });
      await writeFile(flag('--cidfile'), id, { flag: 'wx', mode: mode === 'cid-0644' ? 0o644 : 0o600 });
      return { code: 0, stdout: id, stderr: '' };
    }
    const id = args[2] === '--attach' ? args.at(-1) : args[2],
      c = containers.get(id);
    if (args[1] === 'inspect') {
      if (!c) return { code: 1, stdout: '', stderr: `Error: No such object: ${id}\n` };
      const view = structuredClone(c);
      if (mode === 'wrong-config') view.HostConfig.NetworkMode = 'bridge';
      return { code: 0, stdout: JSON.stringify(view), stderr: '' };
    }
    if (args[1] === 'start') {
      const request = JSON.parse(input);
      inputs.push(request);
      if (mode === 'lost-start') {
        c.State = { ...c.State, Running: true, Status: 'running' };
        return { code: null, stdout: '', stderr: '' };
      }
      c.State = { ...c.State, Running: false, Status: 'exited' };
      return {
        code: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          buildId: o.buildId,
          bundleSHA256: 'e'.repeat(64),
          historySHA256: request.historySHA256,
          historyJSONSHA256: request.historyJSONSHA256,
          kind: request.kind,
          workflowId: request.workflowId,
          runId: request.runId,
        }),
        stderr: '',
      };
    }
    if (args[1] === 'kill') {
      c.State = { ...c.State, Running: false, Status: 'exited' };
      return { code: 0, stdout: id, stderr: '' };
    }
    if (args[1] === 'rm') {
      if (mode !== 'lost-remove-present') containers.delete(id);
      return { code: mode === 'lost-remove' ? null : 0, stdout: id, stderr: '' };
    }
    throw new Error('Unexpected fake Docker call');
  };
  return {
    o,
    calls,
    containers,
    inputs,
    transport,
    cleanup: async () =>
      rm(join(await realpath(tmpdir()), `urm-image-replay-${o.operationId}`), { recursive: true, force: true }),
  };
}
test('exact image inspection/replay is cleanup gated, history/run bound, durable and GET-only on repeat', async () => {
  const f = fixture(),
    history = { events: [{ eventId: '1' }] },
    runId = randomUUID();
  try {
    const first = await createImageReplayObserver(f.o, f.transport);
    const proof = await first.replayHistory(history, 'original', runId);
    assert.equal(proof.runnerSHA256, imageReplayRunnerSHA256);
    assert.equal(proof.cleanupConfirmed, true);
    assertImageReplayReceipt(proof, { image, runId, bundleSHA256: first.bundleSHA256 });
    assert.throws(() => assertImageReplayReceipt({ ...proof, runId: randomUUID() }, { image, runId }), /UNCONFIRMED/);
    assert.equal(f.containers.size, 0);
    assert.equal(f.calls.filter((x) => x[1] === 'start').length, 2);
    const count = f.calls.length;
    const second = await createImageReplayObserver(f.o, f.transport);
    assert.deepEqual(await second.replayHistory(history, 'original', runId), proof);
    assert.ok(f.calls.slice(count).every((x) => x[1] === 'inspect'));
    for (const args of f.calls.filter((x) => x[1] === 'create')) {
      assert.ok(args.includes('--read-only'));
      assert.equal(args[args.indexOf('--pull') + 1], 'never');
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      assert.equal(args.includes('--volume'), false);
      assert.equal(args.includes('--env'), false);
    }
  } finally {
    await f.cleanup();
  }
});
for (const mode of ['wrong-image', 'wrong-config', 'lost-create', 'lost-start', 'lost-remove-present'])
  test(`image replay fences ${mode} without resending uncertain effects`, async () => {
    const f = fixture(mode);
    try {
      await assert.rejects(createImageReplayObserver(f.o, f.transport), /^Error: IMMUTABLE_IMAGE_REPLAY_UNCONFIRMED$/);
      const originalCreates = f.calls.filter((x) => x[1] === 'create').length;
      await assert.rejects(createImageReplayObserver(f.o, f.transport), /UNCONFIRMED/);
      assert.equal(f.calls.filter((x) => x[1] === 'create').length, originalCreates);
      assert.ok(f.calls.filter((x) => x[1] === 'start').length <= 1);
      if (mode === 'lost-start') assert.equal(f.containers.size, 0);
    } finally {
      await f.cleanup();
    }
  });
test('lost remove ACK may succeed only after exact native CID absence', async () => {
  const f = fixture('lost-remove');
  try {
    const p = await createImageReplayObserver(f.o, f.transport);
    assert.equal(p.imageProof.cleanupConfirmed, true);
    assert.equal(f.containers.size, 0);
  } finally {
    await f.cleanup();
  }
});

for (const mode of ['inspect', 'replay', 'wrong-build', 'bad-history'])
  test(`fixed runner consumes actual supplied image bytes and image SDK / ${mode}`, async () => {
    const code = Buffer.from('fixed-image-workflow-bytes'),
      build = 'b'.repeat(40),
      historyJSON = '{"events":[]}';
    const request = {
      buildId: mode === 'wrong-build' ? 'f'.repeat(40) : build,
      kind: mode === 'inspect' ? 'inspect' : 'replay',
      historyJSON: mode === 'inspect' ? '' : historyJSON,
      historySHA256: sha(mode === 'inspect' ? '' : historyJSON),
      historyJSONSHA256: sha(mode === 'inspect' ? '' : historyJSON),
      workflowId: mode === 'inspect' ? '' : 'original',
      runId: mode === 'inspect' ? '' : randomUUID(),
    };
    if (mode === 'bad-history') request.historyJSONSHA256 = '0'.repeat(64);
    const output = [],
      errors = [],
      exits = [],
      replays = [],
      paths = [];
    const process = {
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify(request));
      })(),
      stdout: { write: (x) => output.push(x) },
      stderr: { write: (x) => errors.push(x) },
      exit: (x) => exits.push(x),
    };
    const fs = {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
      openSync: (p) => {
        paths.push(p);
        return p;
      },
      fstatSync: (p) => ({ isFile: () => true, size: p.includes('build-id') ? build.length : code.length }),
      readFileSync: (p, encoding) => (p.includes('build-id') ? build : code),
      closeSync: () => {},
    };
    const instance = { shutdown: async () => {} };
    const sdk = {
      Worker: {
        runReplayHistory: async (options, history, id) => {
          replays.push({ options, history, id });
        },
      },
      Runtime: { install: () => {}, instance: () => instance },
      DefaultLogger: class {},
    };
    await vm.runInNewContext(imageReplayRunner, {
      Buffer,
      TextDecoder,
      process,
      require: (p) =>
        p === 'node:fs'
          ? fs
          : p === 'node:crypto'
          ? { createHash }
          : p === '/workspace/apps/temporal-worker/node_modules/@temporalio/common/lib/proto-utils'
          ? { historyFromJSON }
          : p === '/workspace/apps/temporal-worker/node_modules/@temporalio/worker'
          ? sdk
          : assert.fail('Unexpected image module'),
    });
    assert.equal(paths[0], '/workspace/apps/temporal-worker/lib/workflow-bundle.js');
    if (['wrong-build', 'bad-history'].includes(mode)) {
      assert.deepEqual(exits, [1]);
      assert.deepEqual(output, []);
      assert.deepEqual(errors, ['IMAGE_REPLAY_FAILED']);
      assert.equal(replays.length, 0);
    } else {
      assert.deepEqual(exits, [0]);
      assert.equal(JSON.parse(output[0]).bundleSHA256, sha(code));
      assert.equal(replays.length, mode === 'replay' ? 1 : 0);
      if (mode === 'replay') assert.equal(replays[0].options.workflowBundle.code, code.toString());
    }
  });

test('completed replay reconciles interrupted removal checkpoint by exact CID GET-only absence', async () => {
  const f = fixture();
  try {
    const first = await createImageReplayObserver(f.o, f.transport);
    const root = join(await realpath(tmpdir()), `urm-image-replay-${f.o.operationId}`);
    const files = await readdir(root);
    const cleanup = files.find((p) => p.endsWith('.cleanup'));
    assert.ok(cleanup);
    await unlink(join(root, cleanup));
    const count = f.calls.length;
    const resumed = await createImageReplayObserver(f.o, f.transport);
    assert.deepEqual(resumed.imageProof, first.imageProof);
    assert.ok(f.calls.slice(count).every((x) => x[1] === 'inspect'));
  } finally {
    await f.cleanup();
  }
});

test('actual pinned protobuf JSON codec preserves native payload bytes for image replay', async () => {
  const f = fixture(),
    text = 'native-payload-\u2603';
  const history = temporal.api.history.v1.History.create({
    events: [
      {
        eventId: 1,
        eventType: 1,
        workflowExecutionStartedEventAttributes: {
          input: {
            payloads: [
              { metadata: { encoding: Buffer.from('json/plain') }, data: Buffer.from(JSON.stringify({ text })) },
            ],
          },
        },
      },
    ],
  });
  try {
    const observer = await createImageReplayObserver({ ...f.o, historyToJSON }, f.transport);
    await observer.replayHistory(history, 'original', randomUUID());
    const wire = f.inputs.find((x) => x.kind === 'replay').historyJSON;
    const decoded = historyFromJSON(JSON.parse(wire));
    assert.equal(
      Buffer.from(decoded.events[0].workflowExecutionStartedEventAttributes.input.payloads[0].data).toString(),
      JSON.stringify({ text })
    );
  } finally {
    await f.cleanup();
  }
});

test('Docker os.Create CID mode is normalized through owned private-directory descriptor before use', async () => {
  const f = fixture('cid-0644');
  try {
    const observer = await createImageReplayObserver(f.o, f.transport);
    assert.equal(observer.imageProof.cleanupConfirmed, true);
  } finally {
    await f.cleanup();
  }
});
