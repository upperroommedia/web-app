// Dedicated DEMO SDK tests of bounded publication read-only SDK views. No ADC, real mail or workflow transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSnapshotProof, proofDigest } from '../temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from '../temporal-owned-smoke-plan.mjs';
import { OWNED_SMOKE_ACTION } from '../temporal-owned-smoke-index-stage.mjs';
import { publicationReadonlyView } from '../temporal-owned-smoke-publication-evidence.mjs';
for (const name of [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
])
  if (!/^127\.0\.0\.1:\d+$/.test(process.env[name] ?? '')) throw Error('DEDICATED_DEMO_EMULATORS_REQUIRED');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(root + '/functions/package.json');
require('ts-node').register({ project: root + '/functions/tsconfig.json', transpileOnly: true });
require('tsconfig-paths').register({
  baseUrl: root + '/functions',
  paths: {
    '@upperroom/contracts/*': ['../packages/contracts/*'],
    '@upperroom/shared/*': ['../packages/shared/*'],
    '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
  },
});
const { createDurableJobStore, durableEntityKey } = require(root + '/packages/orchestration/src/job-store.ts');
const { initializeApp, deleteApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const projectId = 'demo-owned-smoke-publication';
const app = initializeApp({
  projectId,
  credential: cert({
    projectId,
    clientEmail: 'emulator-only@' + projectId + '.iam.gserviceaccount.com',
    privateKey: generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
  }),
});
const db = getFirestore(app);
const { Timestamp } = require('firebase-admin/firestore');
const path = 'readonlyFixture/a';
const allow = (p) => p === 'readonlyFixture' || p.startsWith('readonlyFixture/');
const reader = () => ({ get: (target) => target.get() });
async function fixture() {
  await db.recursiveDelete(db.collection('readonlyFixture'));
  await db.doc(path).set({ body: 'synthetic-private-body', marker: Timestamp.fromMillis(123456), count: 1 });
  await db.doc('readonlyFixture/b').set({ body: 'other-private-body', count: 2 });
}
// Explicit production leaf closure. Unused mutation/provider dependencies are inert; a call fails.
const cache = new Map();
const jobStore = require(root + '/packages/orchestration/src/job-store.ts');
const usage = require(root + '/packages/orchestration/src/provider-usage.ts');
const enabled = new Set(
  [
    'criticalRepair',
    'acknowledgedRepairCandidate',
    'criticalRepairCatalog',
    'criticalAcknowledgedRepair',
    'acknowledgedProjectionDigest',
    'providerMutationGuard',
    'providerReceipts',
    'allocationBarrier',
  ].map((n) => root + '/functions/src/temporal/publishing/' + n + '.ts')
);
for (const n of ['profile', 'store']) enabled.add(root + '/functions/src/providerSandbox/' + n + '.ts');
function leaf(file) {
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  vm.runInThisContext(
    '(function(exports, require){' +
      require('typescript').transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: {
          module: require('typescript').ModuleKind.CommonJS,
          target: require('typescript').ScriptTarget.ES2022,
        },
      }).outputText +
      '\n})'
  )(exports, (name) => {
    if (name === 'node:crypto') return crypto;
    if (name === 'firebase-admin/firestore') return require(name);
    if (name === 'firebase-functions/v2/https') return { HttpsError: class extends Error {} };
    if (name.includes('orchestration') && name.endsWith('job-store')) return jobStore;
    if (name.endsWith('/provider-usage')) return usage;
    if (name === './durableOperationContext')
      return { isCriticalPublishingRepair: () => false, PUBLISHING_EFFECT_PLANS: 'temporalPublishingEffectPlans' };
    const next = name.startsWith('.') ? resolve(dirname(file), name + '.ts') : '';
    if (enabled.has(next)) return leaf(next);
    // An unused import is inert, not a replacement for a called validator.
    return {};
  });
  return exports;
}
const pub = root + '/functions/src/temporal/publishing/';
const catalog = leaf(pub + 'criticalRepairCatalog.ts');
const guard = leaf(pub + 'providerMutationGuard.ts');
const projection = leaf(pub + 'criticalAcknowledgedRepair.ts');
const repair = leaf(pub + 'criticalRepair.ts');
const receipts = leaf(pub + 'providerReceipts.ts');
const allocation = leaf(pub + 'allocationBarrier.ts');
const profile = leaf(root + '/functions/src/providerSandbox/profile.ts');
const sandbox = leaf(root + '/functions/src/providerSandbox/store.ts');
const runtime = {
  ...catalog,
  ...guard,
  ...projection,
  ...repair,
  ...receipts,
  ...allocation,
  ...profile,
  ...sandbox,
  durableEntityKey: jobStore.durableEntityKey,
};
let testCase;
async function buildFixture() {
  // All setup producers are confined to this dedicated DEMO database. The collector itself is readonly.
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  testCase = structuredClone(incident);
  const ref = { projectId: testCase.projectId, jobId: testCase.publicationJobId };
  const workflowId = 'synthetic-original-workflow';
  const job = {
    ...ref,
    kind: 'sermon.publish',
    generation: 1,
    workflowId,
    state: 'needs_attention',
    revision: 5,
    entity: { type: 'sermon', id: testCase.sermonId },
    steps: [{ id: 'lists' }],
  };
  const intent = {
    ...ref,
    kind: job.kind,
    generation: 1,
    publishingSourceProtocol: jobStore.PUBLISHING_SOURCE_PROTOCOL,
    entity: job.entity,
    payload: { payload: { sermon: {} } },
  };
  const critical = { ...ref, generation: 1, workflowId, reasonCode: 'PUBLISH' };
  await db.doc('durableJobs/' + ref.jobId).set(job);
  await db.doc('durableJobIntents/' + ref.jobId).set(intent);
  await db.doc('durableJobCriticalSections/' + ref.jobId).set(critical);
  await db
    .doc('durableJobEntities/' + jobStore.durableEntityKey(ref.projectId, job.entity, job.kind))
    .set({ activeJobId: ref.jobId, generation: 1 });
  const resources = testCase.listIds.map((resourceId) => ({
    provider: 'subsplash',
    account: 'app:9XTSHD',
    resourceType: 'list',
    resourceId,
  }));
  const session = await guard.acquireProviderMutationSession({
    db,
    scope: { ...ref, operation: 'synthetic-list-publish' },
    resources,
    assertCurrentInTransaction: async () => {},
  });
  testCase.sessionId = session.id;
  const payload = { title: 'Synthetic frozen provider body' };
  const fingerprint = guard.providerMutationFingerprint(['PATCH', { target: resources[0], body: payload }]);
  await db.runTransaction(async (tx) => {
    const plan = await projection.prepareAcknowledgedProjectionPlan(tx, session, {
      requests: [{ step: 'lists', method: 'PATCH', fingerprint, target: resources[0], payload }],
      writes: [
        { path: 'lists/' + testCase.listIds[0], expectedFields: {}, patch: { title: 'Synthetic frozen title' } },
      ],
      verifications: [],
      uiStepIds: ['lists'],
    });
    plan.commit();
  });
  await guard.executeProviderMutationOnce({
    session,
    step: 'lists',
    method: 'PATCH',
    payload: { target: resources[0], body: payload },
    executionId: 'synthetic-run/activity-1/attempt-1',
    assertCurrentInTransaction: async () => {},
    send: async () => ({ completion: 'acknowledged', result: { updated: true } }),
  });
  const effectPath = 'temporalPublishingEffectPlans/' + ref.jobId + '/operations/' + 'c'.repeat(64);
  const effect = {
    schemaVersion: 1,
    ...ref,
    reasonCode: 'PUBLISH',
    provider: 'subsplash',
    resourceType: 'list-row',
    resourceId: 'synthetic-list-row',
    accountId: 'app:9XTSHD',
    method: 'PATCH',
    requestFingerprint: fingerprint,
    plannedAtMillis: 123,
    sourceStepIds: ['lists'],
    sourceParentRef: ref,
  };
  await db.runTransaction(async (tx) => {
    const append = await catalog.prepareCriticalRepairCatalogSourceAppend(tx, db, ref, {
      sourcePath: effectPath,
      source: effect,
    });
    append.commit();
    tx.create(db.doc(effectPath), effect);
  });
  await db.runTransaction(async (tx) => {
    const seal = await catalog.prepareCriticalRepairCatalogSourceSeal(tx, db, ref, async () => ({
      allSourceWritersEnrolled: true,
      originalSourceProgramsFrozen: true,
    }));
    seal.commit();
  });
  let compiled;
  for (let i = 0; i < 4; i++) {
    const result = await catalog.compileCriticalRepairCatalogPage(db, ref, {
      commitCurrent: async (_r, fn) => db.runTransaction(fn),
    });
    if (result.state === 'ready') {
      compiled = result.root;
      break;
    }
  }
  assert(compiled);
  const candidates = leaf(pub + 'acknowledgedRepairCandidate.ts');
  let candidateReady = false;
  for (let i = 0; i < 20; i++) {
    const result = await candidates.compileAcknowledgedRepairCandidatePage(db, ref, session.id, {
      commitCurrent: async (_r, fn) => db.runTransaction(fn),
    });
    if (result.state === 'ready') {
      candidateReady = true;
      break;
    }
  }
  assert(candidateReady);
  const acknowledged = await db.runTransaction((tx) => projection.prepareAcknowledgedRepair(tx, db, ref, session.id));
  const plan = (await db.doc('temporalPublishingAcknowledgedProjections/' + session.id).get()).data();
  const operation = {
    kind: 'acknowledged_projection',
    sessionId: session.id,
    projectionDigest: projection.acknowledgedProjectionDigest(plan),
  };
  const sourceEvidence = [
    ...acknowledged.sourceEvidence,
    {
      path: 'temporalPublishingCriticalRepairCatalogs/' + compiled.catalogId,
      digest: catalog.criticalRepairCatalogDigest(compiled),
    },
  ];
  const certificate = {
    schemaVersion: 1,
    ...ref,
    generation: 1,
    workflowId,
    acceptedUserCancellation: false,
    intentFingerprint: repair.publishingCriticalRepairDigest(intent),
    criticalFingerprint: repair.publishingCriticalRepairDigest(critical),
    catalog: compiled,
    operations: [operation],
    sourceEvidenceDigests: sourceEvidence.map((e) => e.digest),
  };
  testCase.certificateId = repair.publishingCriticalRepairDigest(certificate);
  await db
    .doc('temporalPublishingCriticalRepairs/' + testCase.certificateId)
    .set({ certificate, certificateId: testCase.certificateId, digest: testCase.certificateId, sourceEvidence });
  await db
    .doc('durableJobs/' + ref.jobId)
    .update({
      actions: ['resolve'],
      attention: { resolutionKind: 'critical_repair', certificateId: testCase.certificateId },
    });
  const sermon = {
    title: 'Synthetic owned sermon',
    durationSeconds: 65,
    soundCloudTrackId: testCase.resources[0].remoteId,
    subsplashId: testCase.resources[1].remoteId,
  };
  await db.doc('sermons/' + testCase.sermonId).set(sermon);
  const byProvider = new Map();
  for (const step of ['soundcloud-track', 'subsplash-audio', 'subsplash-transcode', 'subsplash-media-item']) {
    const provider = step === 'soundcloud-track' ? 'soundcloud' : 'subsplash';
    const operationKey = `durable:${ref.projectId}:${ref.jobId}:${testCase.sermonId}:${provider}-create`;
    const receiptId = receipts.providerReceiptId(operationKey, step);
    const intentPayload = { title: 'Synthetic owned sermon', provider };
    const resultId =
      step === 'soundcloud-track'
        ? testCase.resources[0].remoteId
        : step === 'subsplash-media-item'
        ? testCase.resources[1].remoteId
        : 'synthetic-' + step;
    await db
      .doc('temporalProviderReceipts/' + receiptId)
      .set({
        ...ref,
        operationKey,
        step,
        intentPayload,
        fingerprint: receipts.providerPayloadFingerprint(intentPayload),
        state: 'confirmed',
        result: { id: resultId },
        owner: 'synthetic-owner',
        revision: 3,
        providerExecutionProfile: { mode: 'sandbox', profileId: profile.STAGING_SANDBOX_PROFILE.profileId, version: 1 },
      });
    if (!byProvider.has(provider)) byProvider.set(provider, { operationKey, receiptIds: [] });
    byProvider.get(provider).receiptIds.push(receiptId);
  }
  for (const resource of testCase.resources)
    await db
      .doc(
        'temporalPublishingAllocations/' +
          receipts.providerPayloadFingerprint([ref.projectId, testCase.sermonId, resource.provider])
      )
      .set({
        schemaVersion: 1,
        ...ref,
        sermonId: testCase.sermonId,
        provider: resource.provider,
        ownerJobId: ref.jobId,
        state: 'bound',
        remoteId: resource.remoteId,
        ...byProvider.get(resource.provider),
        source: allocation.capturePublishingAllocationSource(sermon),
      });
  const sandboxPath = '_providerSandbox/' + profile.STAGING_SANDBOX_PROFILE.profileId;
  await db
    .doc(sandboxPath)
    .set({
      state: 'ready',
      profile: profile.STAGING_SANDBOX_PROFILE,
      catalogImportId: 'synthetic-catalog',
      sourceDigest: 'b'.repeat(64),
      resourceCount: 2,
    });
  for (const resource of testCase.resources) {
    const family = resource.provider === 'soundcloud' ? 'tracks' : 'media-items';
    const id = resource.remoteId.replace(/^soundcloud:tracks:/, '');
    const linked = { provider: resource.provider, family, id };
    await db
      .doc(sandboxPath + '/resources/' + sandbox.sandboxResourceKey(resource.provider, family, id))
      .set({ schemaVersion: 1, ...linked, deleted: false });
    await db
      .doc(sandboxPath + '/requests/' + resource.provider)
      .set({
        schemaVersion: 1,
        profileId: profile.STAGING_SANDBOX_PROFILE.profileId,
        jobId: ref.jobId,
        provider: resource.provider,
        method: 'POST',
        fault: 'success',
        outcome: 'acknowledged',
        atMillis: 123,
        resources: [linked],
      });
  }
}
function collector() {
  const exports = {};
  vm.runInThisContext(
    '(function(exports, require){' +
      require('typescript').transpileModule(
        readFileSync(root + '/scripts/temporal-owned-smoke-publication-evidence.mjs', 'utf8'),
        {
          compilerOptions: {
            module: require('typescript').ModuleKind.CommonJS,
            target: require('typescript').ScriptTarget.ES2022,
          },
          fileName: 'collector.ts',
        }
      ).outputText +
      '\n})'
  )(exports, (name) => {
    if (name === './temporal-owned-smoke-plan.mjs') return { OWNED_SMOKE_INCIDENT: testCase };
    if (name === './temporal-release-runtime.mjs') return { proofDigest, nativeSnapshotProof };
    throw Error('Unexpected collector dependency ' + name);
  });
  return exports.collectOwnedPublicationEvidence;
}
try {
  await test('whole collector accepts actual production sealed catalog/projection/session/receipt readers through real SDK without writes', async () => {
    await buildFixture();
    const before = await db.doc('durableJobs/' + testCase.publicationJobId).get();
    const proof = await db.runTransaction((tx) => collector()({ db, tx, runtime }));
    const sealed = (await db.doc('temporalPublishingCriticalRepairs/' + testCase.certificateId).get()).get(
      'certificate'
    );
    assert.equal(sealed.catalog.operationCount, 1);
    assert.equal(sealed.operations[0].kind, 'acknowledged_projection');
    assert.equal(proof.certificateId, testCase.certificateId);
    assert.equal(proof.allocationAcknowledgements.length, 2);
    assert(proof.protectedDocuments.length > 20);
    assert(!JSON.stringify(proof).includes('Synthetic frozen provider body'));
    assert.deepEqual(nativeSnapshotProof(await db.doc(before.ref.path).get()), nativeSnapshotProof(before));
  });
  for (const [name, change, pattern] of [
    [
      'altered sealed candidate',
      async () => {
        const c = await db.collection('temporalPublishingAcknowledgedRepairCandidates').limit(1).get();
        await c.docs[0].ref.update({ generation: 2 });
      },
      /incomplete or changed|projection proof is required/,
    ],
    [
      'changed frozen projection',
      async () => {
        await db
          .doc('temporalPublishingAcknowledgedProjections/' + testCase.sessionId)
          .update({ operation: 'changed' });
      },
      /incomplete or changed|certificate|projection proof is required/,
    ],
    [
      'unresolved original mutation',
      async () => {
        const q = await db
          .doc('temporalProviderMutationSessions/' + testCase.sessionId)
          .collection('requests')
          .limit(1)
          .get();
        await q.docs[0].ref.update({ state: 'unknown' });
      },
      /incomplete or changed|PROJECTION_REQUIRED|MUTATION/,
    ],
    [
      'extra unresolved allocation',
      async () => {
        await db
          .doc(
            'temporalProviderReceipts/' +
              receipts.providerReceiptId(`durable:${testCase.projectId}:${testCase.publicationJobId}:extra`, 'extra')
          )
          .set({
            projectId: testCase.projectId,
            jobId: testCase.publicationJobId,
            operationKey: `durable:${testCase.projectId}:${testCase.publicationJobId}:extra`,
            step: 'extra',
            state: 'executing',
          });
      },
      /PUBLICATION_ALLOCATION_BOUND/,
    ],
    [
      'deleted virtual original allocation',
      async () => {
        const r = testCase.resources[1];
        await db
          .doc(
            '_providerSandbox/' +
              profile.STAGING_SANDBOX_PROFILE.profileId +
              '/resources/' +
              sandbox.sandboxResourceKey(r.provider, 'media-items', r.remoteId)
          )
          .update({ deleted: true });
      },
      /PERSISTENT_SANDBOX_ALLOCATION_REQUIRED/,
    ],
    [
      'complete count exceeds the incident bound',
      async () => {
        const b = db.batch();
        for (let i = 0; i < 101; i++)
          b.set(db.doc('temporalProviderMutationSessions/' + testCase.sessionId + '/requests/synthetic-extra-' + i), {
            synthetic: true,
          });
        await b.commit();
      },
      /PUBLICATION_COUNT_BOUND/,
    ],
  ])
    await test('whole actual-source collector rejects ' + name, async () => {
      await buildFixture();
      await change();
      await assert.rejects(
        db.runTransaction((tx) => collector()({ db, tx, runtime })),
        pattern
      );
    });
} finally {
  await deleteApp(app);
}
