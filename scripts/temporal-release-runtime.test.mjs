import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pinReleaseCheckouts,
  releaseScript,
  loadReleaseResourceBinding,
  validateBucketProject,
  artifactProof,
  assertSameArtifact,
  nativeSnapshotProof,
  assertNativeSnapshot,
  confirmBundleProofInTransaction,
  proofDigest,
} from './temporal-release-runtime.mjs';
import { createHash } from 'node:crypto';
const projectId = 'urm-app-staging';
const runtimeCommit = '8'.repeat(40),
  operatorCommit = '2'.repeat(40);
function pins() {
  const map = new Map();
  const paths = [
    'scripts/temporal-release.mjs',
    'scripts/temporal-release-runtime.mjs',
    'ops/temporal/canary.cjs',
    'ops/temporal/single-vm/media-storage.py',
    'package.json',
    'pnpm-lock.yaml',
  ];
  const git = (root, args) => {
    if (args[0] === 'rev-parse') return root === '/operator' ? operatorCommit : runtimeCommit;
    if (args[0] === 'ls-files') return args.includes('--others') ? '' : paths.join('\0') + '\0';
    if (args[0] === 'show') return map.get(root + ':' + args[1].split(':').slice(1).join(':')) ?? 'committed';
    throw Error('UNEXPECTED_GIT');
  };
  return {
    map,
    git,
    read: (p) => Buffer.from(map.get(p) ?? 'committed'),
    stat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    realpath: (p) => p,
  };
}
test('different committed operator and runtime stay separate; readiness uses new operator while application source commands use runtime', () => {
  const f = pins();
  const b = pinReleaseCheckouts('/operator', '/runtime', { compatibilityCommit: runtimeCommit }, f);
  assert.equal(b.operatorCommit, operatorCommit);
  assert.equal(b.runtimeCommit, runtimeCommit);
  assert.equal(releaseScript(b, 'deploy-temporal-platform.mjs'), '/operator/scripts/deploy-temporal-platform.mjs');
  assert.equal(releaseScript(b, 'temporal-bootstrap-bundles.mjs'), '/operator/scripts/temporal-bootstrap-bundles.mjs');
  for (const name of ['temporal-backfill-provider-usage.mjs', 'temporal-bootstrap-search.mjs'])
    assert.equal(releaseScript(b, name), '/runtime/scripts/' + name);
  assert.throws(() => releaseScript(b, 'firebase-deploy.mjs'), /ORIGIN_UNREVIEWED/);
});
test('default same-root binding pins the same committed identity', () => {
  const f = pins();
  f.git = (root, args) => (args[0] === 'rev-parse' ? runtimeCommit : args[0] === 'ls-files' ? '' : 'committed');
  const b = pinReleaseCheckouts('/runtime', '/runtime', { compatibilityCommit: runtimeCommit }, f);
  assert.equal(b.operatorCommit, b.runtimeCommit);
});
for (const scenario of [
  'runtime-commit',
  'operator-source',
  'operator-dependency',
  'operator-python',
  'runtime-source',
  'untracked-import',
])
  test(`source pin rejects ${scenario}`, () => {
    const f = pins();
    const original = f.git;
    if (scenario === 'runtime-commit')
      f.git = (r, a) => (r === '/runtime' && a[0] === 'rev-parse' ? '9'.repeat(40) : original(r, a));
    if (scenario === 'operator-source') f.map.set('/operator/scripts/temporal-release.mjs', 'uncommitted');
    if (scenario === 'operator-dependency') f.map.set('/operator/ops/temporal/canary.cjs', 'uncommitted');
    if (scenario === 'operator-python') f.map.set('/operator/ops/temporal/single-vm/media-storage.py', 'uncommitted');
    if (scenario === 'runtime-source') f.map.set('/runtime/functions/src/temporal/bridge.ts', 'uncommitted');
    if (scenario === 'untracked-import')
      f.git = (r, a) => (a.includes('--others') ? 'scripts/new-unreviewed.mjs' : original(r, a));
    assert.throws(
      () => pinReleaseCheckouts('/operator', '/runtime', { compatibilityCommit: runtimeCommit }, f),
      /RELEASE_/
    );
  });
function resources() {
  return {
    projectId,
    resources: {
      storageBucket: 'urm-app-staging.firebasestorage.app',
      imagesBucket: 'urm-app-staging-images',
      databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/',
    },
    resourceDigest: 'reviewed',
  };
}
test('canonical resource selector preserves exact platform and peer byte hashes and rejects stale appspot fallback', () => {
  const r = resources();
  const c = {
    projectId,
    environment: 'staging',
    databaseUrl: r.resources.databaseUrl,
    platformConfig: 'p',
    platformPeerConfig: 'peer',
  };
  const read = (p) =>
    Buffer.from(
      JSON.stringify(
        p === 'p'
          ? {
              firebaseProjectId: projectId,
              environment: 'staging',
              firebaseResources: r.resources,
              workerBuildId: runtimeCommit,
              workerImage: 'old-image',
            }
          : { firebaseProjectId: 'urm-app' }
      )
    );
  const b = loadReleaseResourceBinding(c, { read, validate: () => {} });
  assert.equal(b.resources.storageBucket, r.resources.storageBucket);
  assert.notEqual(b.platformConfigSHA256, b.peerConfigSHA256);
  assert.throws(() =>
    loadReleaseResourceBinding(c, {
      read: (p) =>
        p === 'p'
          ? Buffer.from(
              JSON.stringify({
                firebaseProjectId: projectId,
                environment: 'staging',
                firebaseResources: { ...r.resources, storageBucket: 'urm-app-staging.appspot.com' },
              })
            )
          : read(p),
      validate: () => {},
    })
  );
  assert.throws(
    () => loadReleaseResourceBinding({ ...c, projectId: 'urm-app' }, { read, validate: () => {} }),
    /PROJECT_CHANGED/
  );
});
test('actual project number, exact bucket name, and live project lifecycle must agree', () => {
  const r = resources(),
    p = { projectId, projectNumber: '1234', lifecycleState: 'ACTIVE' },
    b = { name: r.resources.storageBucket, projectNumber: '1234', metageneration: '1' };
  assert.equal(validateBucketProject(r, p, b).projectNumber, '1234');
  for (const changed of [
    { ...b, name: 'urm-app.appspot.com' },
    { ...b, projectNumber: '999' },
    { ...b, metageneration: undefined },
  ])
    assert.throws(() => validateBucketProject(r, p, changed), /PROJECT_CHANGED/);
  assert.throws(() => validateBucketProject(r, { ...p, lifecycleState: 'DELETE_REQUESTED' }, b));
});
const pointer = {
  projectId,
  jobId: 'job-' + 'a'.repeat(48),
  generation: 2,
  count: 101,
  storagePath: 'bundles/durable/topics/job-' + 'a'.repeat(48) + '/abc.bin',
};
const metadata = () => ({
  bucket: resources().resources.storageBucket,
  name: pointer.storagePath,
  contentType: 'application/octet-stream',
  metadata: { 'topics-count': '101' },
  size: '194389',
  generation: '1791967813006692',
  metageneration: '1',
});
test('real provider metadata types/count/path and immutable generation are retained without coercing authority', () => {
  const m = metadata(),
    proof = artifactProof('topics', pointer, m, m.bucket);
  assert.equal(proof.count, '101');
  assert.equal(proof.generation, m.generation);
  assert.equal(proof.metageneration, '1');
  for (const changed of [
    { ...m, contentType: 'text/plain' },
    { ...m, metadata: { 'topics-count': '101.0' } },
    { ...m, metadata: { 'topics-count': '102' } },
    { ...m, size: '0' },
    { ...m, name: 'elsewhere' },
    { ...m, generation: undefined },
    { ...m, metageneration: undefined },
    { ...m, bucket: 'urm-app.appspot.com' },
  ])
    assert.throws(() => artifactProof('topics', pointer, changed, m.bucket), /ARTIFACT_INVALID/);
  for (const changed of [
    { ...m, generation: '1791967813006693' },
    { ...m, metageneration: '2' },
  ])
    assert.throws(
      () => assertSameArtifact(proof, artifactProof('topics', pointer, changed, m.bucket)),
      /ARTIFACT_CHANGED/
    );
});
const stamp = (seconds, nanoseconds = 1) => ({ seconds, nanoseconds, toDate: () => new Date(seconds * 1000) });
const snap = (data) => ({ data: () => data, createTime: stamp(10), updateTime: stamp(11) });
test('native full authority CAS rejects same revision with changed checkpoint or high precision timestamp', () => {
  const s = snap({ revision: 11, phase: 'backend-ready' }),
    p = nativeSnapshotProof(s);
  assertNativeSnapshot(p, s);
  assert.throws(() => assertNativeSnapshot(p, snap({ revision: 11, phase: 'different' })), /AUTHORITY_CHANGED/);
  assert.throws(() => assertNativeSnapshot(p, { ...s, updateTime: stamp(11, 2) }), /AUTHORITY_CHANGED/);
  assert.throws(
    () => nativeSnapshotProof({ ...s, updateTime: { seconds: 11, nanoseconds: 1 } }),
    /NATIVE_AUTHORITY_REQUIRED/
  );
});
function bundleRows() {
  const types = ['topics', 'subtitles', 'bible-chapters', 'sunday-homilies', 'holy-week', 'latest-list'];
  const records = new Map(),
    artifacts = [],
    jobIds = [];
  for (const type of types) {
    const jobId = 'job-' + createHash('sha256').update(type).digest('hex').slice(0, 48);
    jobIds.push(jobId);
    const p = { ...pointer, jobId, storagePath: `bundles/durable/${type}/${jobId}/abc.bin` };
    const key = createHash('sha256')
      .update(JSON.stringify([projectId, 'bundle', type, 'bundle']))
      .digest('hex');
    records.set('durableJobEntities/' + key, {
      projectId,
      entity: { type: 'bundle', id: type },
      activeJobId: jobId,
      generation: 2,
    });
    records.set('durableJobs/' + jobId, {
      projectId,
      kind: 'bundle.regenerate',
      entity: { type: 'bundle', id: type },
      jobId,
      generation: 2,
      state: 'succeeded',
    });
    records.set('_durableBundlePointers/' + type, p);
    artifacts.push({
      ...artifactProof('topics', pointer, metadata(), metadata().bucket),
      bundleType: type,
      path: p.storagePath,
      pointerDigest: proofDigest(p),
    });
  }
  return { records, proof: { bundleTypes: types, jobIds, artifactProofs: artifacts } };
}
test('final transaction uses exact current six entity/job/pointer fences; stale and newer generation cannot be adopted', async () => {
  const f = bundleRows(),
    db = { doc: (p) => p },
    tx = { get: async (p) => ({ data: () => f.records.get(p) }) };
  await confirmBundleProofInTransaction(tx, db, f.proof, projectId);
  for (const change of ['pointer', 'job', 'entity']) {
    const q = bundleRows();
    const target = [...q.records.keys()].find((k) =>
      k.startsWith(
        change === 'pointer' ? '_durableBundlePointers' : change === 'job' ? 'durableJobs' : 'durableJobEntities'
      )
    );
    q.records.set(target, { ...q.records.get(target), generation: 3 });
    await assert.rejects(
      confirmBundleProofInTransaction({ get: async (p) => ({ data: () => q.records.get(p) }) }, db, q.proof, projectId),
      /PROOF_CHANGED/
    );
  }
});

test('unsupported Compute/external ADC fails before SDK acquisition or network', async () => {
  const { prepareLocalReleaseADC } = await import('./temporal-release-runtime.mjs');
  let calls = 0,
    destroyed = 0;
  const base = {
    env: { HOME: '/fixture' },
    realpath: (p) => p,
    agent: { destroy: () => destroyed++ },
    sdkRequire: () => {
      calls++;
      throw Error('MUST_NOT_LOAD_SDK');
    },
  };
  for (const type of ['external_account', 'impersonated_service_account', undefined])
    assert.throws(
      () => prepareLocalReleaseADC('/root', projectId, { ...base, read: () => Buffer.from(JSON.stringify({ type })) }),
      /LOCAL_ADC_TYPE_UNSUPPORTED/
    );
  assert.equal(calls, 0);
  assert.equal(destroyed, 3);
});
test('actual official SDK factory honors bounded agent; a cached unbounded credential is rejected without network', async () => {
  const { prepareLocalReleaseADC } = await import('./temporal-release-runtime.mjs');
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { resolve } = await import('node:path');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const require = createRequire(resolve(root, 'functions/package.json'));
  const adc = prepareLocalReleaseADC(root, projectId, {
    env: { HOME: '/fixture' },
    realpath: (p) => p,
    read: (p) => (String(p).startsWith('/fixture') ? Buffer.from('{"type":"authorized_user"}') : readFileSync(p)),
    sdkRequire: require,
  });
  const sdk = require('firebase-admin/app');
  const app = sdk.initializeApp({ projectId, credential: adc.credential }, 'offline-bounded-sdk');
  assert.equal(app.options.credential, adc.credential);
  assert.equal(adc.adcType, 'authorized_user');
  assert.match(adc.sdkCredentialImplementationSHA256, /^[a-f0-9]{64}$/);
  await sdk.deleteApp(app);
  adc.close();
  // Official SDK caches the prior credential; a newly requested agent is not silently assumed honored.
  assert.throws(
    () =>
      prepareLocalReleaseADC(root, projectId, {
        env: { HOME: '/fixture' },
        realpath: (p) => p,
        read: (p) => (String(p).startsWith('/fixture') ? Buffer.from('{"type":"authorized_user"}') : readFileSync(p)),
        sdkRequire: require,
      }),
    /ADC_AGENT_NOT_BOUND/
  );
});
test('absolute HTTPS deadline destroys a real request whose response headers arrive but body never finishes', async () => {
  const { BoundedReleaseHttpsAgent } = await import('./temporal-release-runtime.mjs');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const https = await import('node:https');
  const dir = mkdtempSync(join(tmpdir(), 'release-agent-test-')),
    agent = new BoundedReleaseHttpsAgent(80);
  let server;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' }
    );
    server = https.createServer(
      { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('headers-and-partial-body');
      }
    );
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const started = Date.now();
    await assert.rejects(
      new Promise((resolve, reject) => {
        const req = https.get(
          { hostname: '127.0.0.1', port: server.address().port, path: '/', agent, rejectUnauthorized: false },
          (res) => {
            res.on('data', () => {});
            res.on('error', reject);
            res.on('end', resolve);
          }
        );
        req.on('error', reject);
      }),
      /ADC_HTTP_TIMEOUT/
    );
    assert(Date.now() - started < 2000);
  } finally {
    agent.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
