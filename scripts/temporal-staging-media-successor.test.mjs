import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { RELEASE_DOMAINS } from './temporal-release-lib.mjs';
import { hash, nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
import { PROVIDER_USAGE_SCAN_GROUPS } from './temporal-backfill-provider-usage.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import { assertStagingMediaSuccessorLineage, commitStagingMediaSuccessor, fenceStagingPredecessorAccounts, observeStagingMediaSuccessorTransfer, observeStagingPredecessorAccounts, planStagingMediaSuccessor, readStagingMediaSuccessorBoundary, predecessorOperationId, predecessorReleaseId, predecessorPaths } from './temporal-staging-media-successor.mjs';
import { createReleaseApi } from './temporal-release-api.mjs';

const oldBuild = 'b008afa426291ad2aa94cb8319d4bf06afdce1e0';
const names = serverlessResourceNames(oldBuild, 'media');
const now = 1795187000000;

function fixture() {
  const operatorIdentity = { runtimeCommit: oldBuild };
  return {
    control: { schemaVersion: 1, releaseId: predecessorReleaseId, revision: 65, admission: 'paused',
      domains: Object.fromEntries(RELEASE_DOMAINS.map((domain) => [domain, { owner: 'temporal', admission: 'paused' }])) },
    state: { releaseId: predecessorReleaseId, controlRevision: 65, phase: 'provider-usage-ready', mode: 'durable-upgrade',
      compatibilityCommit: oldBuild, uiCommit: oldBuild, domains: RELEASE_DOMAINS,
      savedRolloutPolicy: { codebaseBranch: 'staging' }, savedUiTraffic: { build: 'prior' },
      appHostingFreezeRequestId: 'original', appHostingFreezeETag: 'previous', appHostingFrozenETag: 'frozen',
      maximumLegacyExecutionSeconds: 540, compatibilityVerifiedAt: now - 5000,
      providerUsageEpoch: 'retained', providerUsageBackfillRevision: 43 },
    providerUsage: { schemaVersion: 1, projectId: 'urm-app-staging', status: 'ready',
      groups: PROVIDER_USAGE_SCAN_GROUPS, epoch: 'retained', controlRevision: 43 },
    operation: { releaseId: predecessorReleaseId, operationId: predecessorOperationId,
      action: 'prepare-cloud-run-pool', operatorIdentity, bindingDigest: proofDigest(operatorIdentity),
      cloudPoolPreparation: { stage: 'attempted', attemptedAt: new Date(now - 1000).toISOString(), plan: {
        operationId: predecessorOperationId, releaseId: predecessorReleaseId, role: 'media', buildId: oldBuild,
        runner: names.runnerServiceAccount, body: { template: { serviceAccount: names.runnerServiceAccount },
          name: `projects/urm-app-staging/locations/us-central1/workerPools/${names.poolName}`,
          annotations: { 'urm.upperroom.media/preparation': predecessorOperationId }, scaling: { manualInstanceCount: 0 } },
      } } },
    successor: { environment: 'staging', projectId: 'urm-app-staging', backendId: 'web-staging',
      mode: 'durable-upgrade', releaseId: '44444444-5555-4666-8777-888888888888',
      compatibilityCommit: 'c'.repeat(40), uiCommit: 'c'.repeat(40), domains: RELEASE_DOMAINS },
  };
}

test('successor starts paused with inherited freeze and no borrowed readiness', () => {
  const input = fixture();
  const result = planStagingMediaSuccessor(input, now);
  assert.equal(result.control.admission, 'paused');
  assert.equal(result.control.revision, 66);
  assert.deepEqual(result.control.domains, input.control.domains);
  assert.equal(result.state.phase, 'ui-frozen');
  assert.deepEqual(result.state.savedUiTraffic, input.state.savedUiTraffic);
  assert.equal(result.state.stagingMediaSupersessionArchive, predecessorPaths.archive);
  assert.equal(Object.hasOwn(result.state, 'compatibilityVerifiedAt'), false);
  assert.equal(Object.hasOwn(result.state, 'providerUsageEpoch'), false);
  assert.notEqual(result.oldNames.poolName, result.newNames.poolName);
});

test('denies changed predecessor authority, acknowledgement and same-prefix candidate', () => {
  for (const change of [
    (input) => { input.control.revision++; },
    (input) => { input.providerUsage.epoch = 'changed'; },
    (input) => { input.operation.cloudPoolPreparation.nativeOperation = 'operations/original'; },
    (input) => { input.operation.cloudPoolPreparation.plan.body.scaling.manualInstanceCount = 1; },
    (input) => { input.operation.cloudPoolPreparation.plan.role = 'images'; },
    (input) => { input.successor.compatibilityCommit = input.successor.uiCommit = oldBuild.slice(0, 20) + 'f'.repeat(20); },
    (input) => { input.successor.projectId = 'urm-app'; },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => planStagingMediaSuccessor(input, now));
  }
});

test('reads the boundary transactionally and rejects any competing terminal or archive evidence', async () => {
  const input = fixture();
  const documents = new Map(Object.entries(predecessorPaths).map(([name, path]) => [path, input[name]]));
  const stamp = { seconds: 1795186999, nanoseconds: 123456, toDate: () => new Date(now - 1000) };
  const db = {
    doc: (path) => path,
    runTransaction: async (read, options) => {
      assert.deepEqual(options, { readOnly: true });
      return read({
        getAll: async (...paths) => paths.map((path) => ({
          exists: documents.get(path) !== undefined,
          data: () => documents.get(path),
          createTime: stamp,
          updateTime: stamp,
        })),
      });
    },
  };
  const result = await readStagingMediaSuccessorBoundary(db, input.successor, () => now);
  assert.equal(result.authority.operation.dataDigest, proofDigest(input.operation));
  assert.equal(result.transition.control.revision, 66);
  for (const field of ['success', 'noSend', 'archive']) {
    const path = predecessorPaths[field];
    documents.set(path, {});
    await assert.rejects(readStagingMediaSuccessorBoundary(db, input.successor, () => now));
    documents.delete(path);
  }
});

test('observes exact receipt-owned IAM IDs and rejects an identity recreated at the same email', async () => {
  const records = [
    ['runner', '5c565071-8d00-41c1-9a2a-95a075f702ff', '100000000000000000001', names.runnerServiceAccount],
    ['scaler', '3e74709f-a7db-4395-b184-a3dcb806e3c0', '100000000000000000002', names.invokerServiceAccount],
  ].map(([kind, operationId, uniqueId, email]) => ({
    operationId,
    releaseId: predecessorReleaseId,
    identityState: {
      stage: 'completed',
      plan: { operationId, kind, role: 'media', buildId: oldBuild, evidenceDigest: 'evidence', email },
      account: { uniqueId, email, description: 'preparation witness' },
    },
  }));
  const stamp = { seconds: 1795186999, nanoseconds: 0, toDate: () => new Date(now - 1000) };
  const db = { doc: (path) => ({ get: async () => ({
    exists: true,
    createTime: stamp,
    updateTime: stamp,
    data: () => records.find(({ operationId }) => path.endsWith(operationId)),
  }) }) };
  const originalPlan = { evidenceDigest: 'evidence', identityReceiptSHA256: hash(JSON.stringify(records[0])) };
  const observed = new Map(records.map(({ identityState: { account } }) => [account.uniqueId, {
    ...account, projectId: 'urm-app-staging', disabled: account.email === names.invokerServiceAccount,
  }]));
  const api = async (url) => {
    assert.match(url, /^https:\/\/iam\.googleapis\.com\/v1\/projects\/urm-app-staging\/serviceAccounts\/[0-9]+$/);
    return observed.get(url.split('/').at(-1));
  };
  const result = await observeStagingPredecessorAccounts(db, api, originalPlan);
  assert.deepEqual(result.map(({ kind, disabled }) => [kind, disabled]), [['runner', false], ['scaler', true]]);
  observed.get(records[0].identityState.account.uniqueId).uniqueId = '999999999999999999999';
  await assert.rejects(observeStagingPredecessorAccounts(db, api, originalPlan));
});

function transactionFixture({ lostAck = false, prepareIamJournals = true } = {}) {
  const input = fixture();
  const stamp = { seconds: 1795186999, nanoseconds: 0, toDate: () => new Date(now - 1000) };
  const commitStamp = { seconds: 1795187000, nanoseconds: 0, toDate: () => new Date(now) };
  const rows = new Map();
  const put = (path, data, updated = stamp) =>
    rows.set(path, { data, createTime: rows.get(path)?.createTime ?? updated, updateTime: updated });
  for (const key of ['control', 'state', 'operation', 'providerUsage']) put(predecessorPaths[key], input[key]);
  const snapshot = (path) => {
    const row = rows.get(path);
    return { exists: row !== undefined, data: () => row?.data, createTime: row?.createTime, updateTime: row?.updateTime };
  };
  let attempts = 0;
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path) => ({ path, get: async () => snapshot(path) }),
    runTransaction: async (run, options) => {
      if (!options.readOnly) {
        assert.deepEqual(options, { maxAttempts: 1 });
        attempts++;
      }
      const writes = [];
      const result = await run({
        getAll: async (...refs) => refs.map(({ path }) => snapshot(path)),
        get: async ({ path }) => snapshot(path),
        create: ({ path }, value) => writes.push(() => {
          assert.equal(rows.has(path), false);
          put(path, value, commitStamp);
        }),
        set: ({ path }, value) => writes.push(() => put(path, value, commitStamp)),
        delete: ({ path }, precondition) => writes.push(() => {
          assert.equal(precondition.lastUpdateTime, snapshot(path).updateTime);
          rows.delete(path);
        }),
      });
      for (const write of writes) write();
      if (writes.length && lostAck) throw new Error('lost commit acknowledgement');
      return result;
    },
  };
  const accounts = [
    ['runner', '5c565071-8d00-41c1-9a2a-95a075f702ff', '100000000000000000001', names.runnerServiceAccount],
    ['scaler', '3e74709f-a7db-4395-b184-a3dcb806e3c0', '100000000000000000002', names.invokerServiceAccount],
  ].map(([kind, receiptId, uniqueId, email]) => {
    const path = `_control/temporalCloudIdentityPreparation-${receiptId}`;
    put(path, { kind, uniqueId });
    return { kind, receiptId, uniqueId, email, disabled: true, authority: nativeSnapshotProof(snapshot(path)) };
  });
  const iamPaths = ['runner', 'scaler'].map(kind => `_control/temporalStagingMediaIdentityFence-${predecessorOperationId}-${kind}`);
  if (prepareIamJournals) {
    for (const path of iamPaths) put(path, { stage: 'attempted', fixture: true });
  }
  const resourceBinding = { projectId: 'urm-app-staging', workerBuildId: input.successor.compatibilityCommit,
    workerImage: 'image-fixture', platformConfigSHA256: 'config-fixture', peerConfigSHA256: 'peer-fixture' };
  return {
    input, db, put, rows, snapshot, iamPaths, resourceBinding, get attempts() { return attempts; },
    async options() {
      return {
        db, boundary: await readStagingMediaSuccessorBoundary(db, input.successor, () => now),
        successor: input.successor, candidate: { commit: input.successor.compatibilityCommit, image: resourceBinding.workerImage },
        resourceBinding, assertWorkExclusionFresh: () => {},
        iamJournals: prepareIamJournals ? iamPaths.map(path => nativeSnapshotProof(snapshot(path))) : [],
        accounts, pool: { name: input.operation.cloudPoolPreparation.plan.body.name, state: 'absent',
          createDisposition: 'unknown' }, workExclusion: { fixture: 'no old assigned work' },
        assertPrivateWorkIdle: async () => {}, sampleStartedAt: now, sampleStartedMonotonic: performance.now(),
        now: () => now,
      };
    },
  };
}

test('archives the exact unknown operation and confirms the joint successor after a lost acknowledgement', async () => {
  const f = transactionFixture({ lostAck: true });
  const proposal = await f.options();
  const observed = await commitStagingMediaSuccessor(proposal);
  assert.deepEqual(observed, { phase: 'ui-frozen', revision: 66,
    releaseId: f.input.successor.releaseId, archivePath: predecessorPaths.archive });
  assert.equal(f.attempts, 1);
  assert.equal(f.snapshot(predecessorPaths.operation).exists, false);
  const record = f.snapshot(predecessorPaths.archive).data();
  assert.equal(record.createDisposition, 'unknown');
  assert.deepEqual(record.original.operation, f.input.operation);
  assert.deepEqual(record.originalAuthority, proposal.boundary.authority);
  assert.deepEqual(nativeSnapshotProof(f.snapshot(predecessorPaths.providerUsage)), proposal.boundary.authority.providerUsage);
  assert.deepEqual(await observeStagingMediaSuccessorTransfer(f.db, f.input.successor, f.resourceBinding), observed);
  await assert.rejects(observeStagingMediaSuccessorTransfer(f.db, { ...f.input.successor, uiCommit: 'e'.repeat(40) }, f.resourceBinding));
  await assert.rejects(readStagingMediaSuccessorBoundary(f.db, f.input.successor, () => now));
});

async function iamFenceFixture({ apply, loseJournalAck = false }) {
  const f = transactionFixture({ lostAck: loseJournalAck, prepareIamJournals: false });
  const native = new Map();
  const attempts = [];
  const originalPlan = f.input.operation.cloudPoolPreparation.plan;
  originalPlan.evidenceDigest = 'evidence';
  const { accounts } = await f.options();
  for (const { kind, receiptId, uniqueId, email } of accounts) {
    const receipt = {
      operationId: receiptId, releaseId: predecessorReleaseId,
      identityState: {
        stage: 'completed',
        plan: { operationId: receiptId, kind, role: 'media', buildId: oldBuild, evidenceDigest: 'evidence', email },
        account: { uniqueId, email, description: 'owned media identity' },
      },
    };
    f.put(`_control/temporalCloudIdentityPreparation-${receiptId}`, receipt);
    native.set(uniqueId, { ...receipt.identityState.account, projectId: 'urm-app-staging', disabled: false });
    if (kind === 'runner') originalPlan.identityReceiptSHA256 = hash(JSON.stringify(receipt));
  }
  const api = createReleaseApi({
    getAccessToken: async () => 'fixture',
    request: async (url, { method, body }) => {
      const [, id, action] = /\/([0-9]+)(:disable)?$/.exec(url);
      const account = native.get(id);
      assert.ok(account);
      if (action) {
        const kind = account.email === names.runnerServiceAccount ? 'runner' : 'scaler';
        const journal = f.snapshot(`_control/temporalStagingMediaIdentityFence-${predecessorOperationId}-${kind}`).data();
        assert.equal(journal.stage, 'attempted');
        assert.deepEqual(journal.binding.request, { method, url, body: JSON.parse(body) });
        attempts.push(id);
        if (apply) account.disabled = true;
        throw new Error('HTTP acknowledgement lost');
      }
      assert.equal(method, 'GET');
      return Response.json(account);
    },
  });
  return {
    f, attempts, native, options: {
      ...await f.options(), api, observeWorkExclusion: async () => ({ verified: true }),
      observePool: async () => ({ state: 'absent' }),
    },
  };
}

test('IAM fencing journals before an exact numeric POST and reconciles lost HTTP acknowledgement by readback', async () => {
  const { options, attempts } = await iamFenceFixture({ apply: true });
  const receipts = await fenceStagingPredecessorAccounts(options);
  assert.equal(receipts.length, 2);
  assert.equal(new Set(attempts).size, 2);
  const candidate = { ...options.candidate, verifiedAt: new Date(now + 500).toISOString() };
  assert.deepEqual(await fenceStagingPredecessorAccounts({ ...options, candidate }), receipts);
  await assert.rejects(fenceStagingPredecessorAccounts({ ...options, candidate: { ...candidate, ciRun: 2 } }));
  assert.equal(attempts.length, 2);
});

test('uncertain IAM attempt cannot resend while still enabled, including after Firestore acknowledgement loss', async () => {
  for (const loseJournalAck of [false, true]) {
    const { options, attempts } = await iamFenceFixture({ apply: false, loseJournalAck });
    await assert.rejects(fenceStagingPredecessorAccounts(options));
    await assert.rejects(fenceStagingPredecessorAccounts(options));
    assert.equal(attempts.length, 1);
  }
});

test('IAM POST is fenced when native work protection changes between the two observations', async () => {
  const { options, attempts, f } = await iamFenceFixture({ apply: true });
  let calls = 0;
  options.observeWorkExclusion = async () => ({ temporal: { route: ++calls } });
  await assert.rejects(fenceStagingPredecessorAccounts(options));
  assert.equal(attempts.length, 0);
  assert.equal(f.attempts, 0);
});

test('preserves the held operation on authority drift, active work, stale evidence or an enabled identity', async () => {
  for (const change of [
    (f) => f.put(predecessorPaths.success, { observed: true }),
    (f) => f.put(predecessorPaths.providerUsage, { ...f.input.providerUsage, epoch: 'different' }),
    (f, options) => { options.accounts[0].disabled = false; },
    (f, options) => { options.sampleStartedAt = now - 5_001; },
    (f, options) => { options.assertPrivateWorkIdle = async () => { throw new Error('active work'); }; },
  ]) {
    const f = transactionFixture();
    const options = await f.options();
    change(f, options);
    await assert.rejects(commitStagingMediaSuccessor(options));
    assert.equal(f.snapshot(predecessorPaths.archive).exists, false);
    assert.deepEqual(f.snapshot(predecessorPaths.operation).data(), f.input.operation);
  }
});

test('successor phase checks retain the exact provider marker and immutable predecessor archive', async () => {
  const f = transactionFixture();
  const options = await f.options();
  await commitStagingMediaSuccessor(options);
  const state = f.snapshot(predecessorPaths.state).data();
  const reader = { getAll: async (...refs) => refs.map(({ path }) => f.snapshot(path)) };
  await assertStagingMediaSuccessorLineage(f.db, state, f.input.successor, reader, f.resourceBinding);
  await assert.rejects(assertStagingMediaSuccessorLineage(
    f.db, state, { ...f.input.successor, uiCommit: 'e'.repeat(40) }, reader, f.resourceBinding,
  ));
  for (const key of ['workerImage', 'platformConfigSHA256', 'peerConfigSHA256']) {
    await assert.rejects(assertStagingMediaSuccessorLineage(
      f.db, state, f.input.successor, reader, { ...f.resourceBinding, [key]: 'changed' },
    ));
  }
  const archive = f.snapshot(predecessorPaths.archive).data();
  f.put(predecessorPaths.archive, { ...archive, createDisposition: 'settled' });
  await assert.rejects(assertStagingMediaSuccessorLineage(f.db, state, f.input.successor, reader, f.resourceBinding));

  const g = transactionFixture();
  await commitStagingMediaSuccessor(await g.options());
  g.put(predecessorPaths.providerUsage, { ...g.input.providerUsage, epoch: 'another index' });
  await assert.rejects(assertStagingMediaSuccessorLineage(
    g.db, g.snapshot(predecessorPaths.state).data(), g.input.successor,
    { getAll: async (...refs) => refs.map(({ path }) => g.snapshot(path)) }, g.resourceBinding,
  ));
});

test('dedicated emulator commits the archive and both successor documents at the same native timestamp', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const config = JSON.parse(readFileSync(new URL('../firebase.test.json', import.meta.url)));
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${config.emulators.firestore.port}`);
  const require = createRequire(new URL('../functions/package.json', import.meta.url));
  const { initializeApp, deleteApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const app = initializeApp({ projectId: 'urm-app-staging' }, 'staging-media-successor-native-test');
  const db = getFirestore(app);
  const f = transactionFixture();
  const options = await f.options();
  const paths = [...f.rows.keys()];
  let seeded = false;
  try {
    const seed = db.batch();
    for (const path of paths) seed.create(db.doc(path), f.snapshot(path).data());
    await seed.commit();
    seeded = true;
    options.db = db;
    options.boundary = await readStagingMediaSuccessorBoundary(db, f.input.successor, () => now);
    for (const account of options.accounts) {
      const receipt = await db.doc(`_control/temporalCloudIdentityPreparation-${account.receiptId}`).get();
      account.authority = nativeSnapshotProof(receipt);
    }
    options.iamJournals = (await db.getAll(...f.iamPaths.map(path => db.doc(path)))).map(nativeSnapshotProof);
    options.sampleStartedMonotonic = performance.now();
    const result = await commitStagingMediaSuccessor(options);
    assert.equal(result.revision, 66);
    const [control, state, archive, operation, provider] = await db.getAll(
      ...['control', 'state', 'archive', 'operation', 'providerUsage'].map(name => db.doc(predecessorPaths[name])),
    );
    assert.equal(operation.exists, false);
    assert.equal(archive.get('createDisposition'), 'unknown');
    assert.ok(control.updateTime.isEqual(archive.createTime) && state.updateTime.isEqual(archive.createTime));
    assert.deepEqual(nativeSnapshotProof(provider), options.boundary.authority.providerUsage);
    await assertStagingMediaSuccessorLineage(db, state.data(), f.input.successor, db, f.resourceBinding);
    assert.deepEqual(await observeStagingMediaSuccessorTransfer(db, f.input.successor, f.resourceBinding), result);
  } finally {
    if (seeded) {
      const cleanup = db.batch();
      for (const path of [...paths, predecessorPaths.archive]) cleanup.delete(db.doc(path));
      await cleanup.commit();
    }
    await db.terminate();
    await deleteApp(app);
  }
});
