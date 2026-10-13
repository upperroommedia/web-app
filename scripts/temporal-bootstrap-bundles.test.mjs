import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  BUNDLE_TYPES,
  runBundleBootstrap,
  parseBootstrapArgs,
  bootstrapRequestId,
  isolateFirebaseEnvironment,
} from './temporal-bootstrap-bundles.mjs';
const options = {
  projectId: 'urm-app-staging',
  releaseId: '12345678-1234-4123-8123-123456789abc',
  controlRevision: 7,
  timeoutMs: 50,
  pollMs: 1,
};
const control = () => ({
  schemaVersion: 1,
  releaseId: options.releaseId,
  revision: 7,
  admission: 'paused',
  domains: { bundles: { owner: 'temporal' } },
});
const proof = (type, i) => {
  const jobId = `job-${String(i + 1).padStart(48, '0')}`;
  return {
    entity: { projectId: options.projectId, entity: { type: 'bundle', id: type }, generation: 2, activeJobId: jobId },
    job: {
      jobId,
      projectId: options.projectId,
      kind: 'bundle.regenerate',
      entity: { type: 'bundle', id: type },
      generation: 2,
      state: 'succeeded',
    },
    pointer: {
      projectId: options.projectId,
      jobId,
      generation: 2,
      count: 0,
      storagePath: `bundles/durable/${type}/${jobId}/12345678-1234-4123-8123-123456789abc.bin`,
    },
  };
};
function fixture() {
  let clock = 0;
  const submitted = [];
  return {
    submitted,
    readControl: async () => control(),
    submit: async (r) => {
      submitted.push(r);
      return { projectId: options.projectId, jobId: `bootstrap-${r.entity.id}`, generation: 1 };
    },
    readProofs: async () => BUNDLE_TYPES.map(proof),
    readArtifact: async (path) => ({
      exists: true,
      contentType: 'application/octet-stream',
      size: '12',
      metadata: { [`${path.split('/')[2]}-count`]: '0' },
    }),
    confirmProofs: async () => true,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
}
test('converged newer jobs supersede bootstrap safely and return all six actual types', async () => {
  const deps = fixture();
  const result = await runBundleBootstrap(options, deps);
  assert.equal(result.result, 'passed');
  assert.deepEqual(result.bundleTypes, BUNDLE_TYPES);
  assert.equal(result.jobIds.length, 6);
  assert.notDeepEqual(result.jobIds, result.bootstrapJobIds);
  for (const r of deps.submitted) {
    assert.equal(r.continuation, true);
    assert.equal(r.actorUid, 'system:firebase-event');
    assert.deepEqual(r.expectedReleaseControl, { releaseId: options.releaseId, revision: 7 });
  }
});
test('request IDs are deterministic per release/type', () => {
  assert.equal(bootstrapRequestId(options.releaseId, 'topics'), bootstrapRequestId(options.releaseId, 'topics'));
  assert.notEqual(bootstrapRequestId(options.releaseId, 'topics'), bootstrapRequestId(options.releaseId, 'subtitles'));
});
test('changed control aborts before submission', async () => {
  const deps = fixture();
  deps.readControl = async () => ({ ...control(), revision: 8 });
  await assert.rejects(runBundleBootstrap(options, deps), { code: 'BOOTSTRAP_CONTROL_MISMATCH' });
  assert.equal(deps.submitted.length, 0);
});
test('control change during final proof fails closed', async () => {
  const deps = fixture();
  let changed = false;
  deps.confirmProofs = async () => {
    changed = true;
    return true;
  };
  deps.readControl = async () => ({ ...control(), revision: changed ? 8 : 7 });
  await assert.rejects(runBundleBootstrap(options, deps), { code: 'BOOTSTRAP_CONTROL_MISMATCH' });
});
test('queued active generation times out without false proof', async () => {
  const deps = fixture();
  deps.readProofs = async () =>
    BUNDLE_TYPES.map((t, i) => {
      const p = proof(t, i);
      p.job.state = 'queued';
      return p;
    });
  await assert.rejects(runBundleBootstrap(options, deps), { code: 'BOOTSTRAP_TIMEOUT' });
});
test('mismatched immutable pointer is rejected', async () => {
  const deps = fixture();
  deps.readProofs = async () =>
    BUNDLE_TYPES.map((t, i) => {
      const p = proof(t, i);
      p.pointer.generation = 1;
      return p;
    });
  await assert.rejects(runBundleBootstrap(options, deps), { code: 'BOOTSTRAP_PROOF_INVALID' });
});
test('artifact count mismatch rejects proof', async () => {
  const deps = fixture();
  deps.readArtifact = async () => ({
    exists: true,
    contentType: 'application/octet-stream',
    size: 10,
    metadata: { 'topics-count': '9' },
  });
  await assert.rejects(runBundleBootstrap(options, deps), { code: 'BOOTSTRAP_ARTIFACT_INVALID' });
});
test('generation changes during storage check retries latest snapshot', async () => {
  const deps = fixture();
  let checks = 0;
  deps.confirmProofs = async () => ++checks > 1;
  assert.equal((await runBundleBootstrap(options, deps)).result, 'passed');
  assert.equal(checks, 2);
});
test('CLI requires apply and validates timeout/project before Firebase loading', () => {
  const args = ['--project', options.projectId, '--release-id', options.releaseId, '--control-revision', '7'];
  assert.throws(() => parseBootstrapArgs(args), { code: 'BOOTSTRAP_APPLY_REQUIRED' });
  assert.deepEqual(parseBootstrapArgs([...args, '--apply']), {
    projectId: options.projectId,
    releaseId: options.releaseId,
    controlRevision: 7,
  });
  assert.throws(() => parseBootstrapArgs([...args, '--apply', '--timeout-ms', 'NaN']), {
    code: 'INVALID_BOOTSTRAP_ARGUMENTS',
  });
});
test('project isolation rejects emulators and clears inherited service selectors', () => {
  assert.throws(() => isolateFirebaseEnvironment(options.projectId, { FIRESTORE_EMULATOR_HOST: 'localhost:8080' }), {
    code: 'BOOTSTRAP_EMULATOR_FORBIDDEN',
  });
  const env = {
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'urm-app',
    FIREBASE_CONFIG: '/old.json',
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'old',
    NODE_ENV: 'development',
  };
  isolateFirebaseEnvironment(options.projectId, env);
  assert.equal(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID, options.projectId);
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.FIREBASE_CONFIG, undefined);
  assert.equal(env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET, undefined);
});
test('help succeeds without SDK credentials or Firebase loads', () => {
  const result = spawnSync(process.execPath, ['scripts/temporal-bootstrap-bundles.mjs', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: 'deliberately-invalid' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--apply/);
  assert.equal(result.stderr, '');
});
