// Dedicated DEMO SDK tests of bounded publication read-only SDK views. No ADC, real mail or workflow transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
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
  await db.doc('durableJobs/' + ref.jobId).update({
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
    await db.doc('temporalProviderReceipts/' + receiptId).set({
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
  await db.doc(sandboxPath).set({
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
    await db.doc(sandboxPath + '/requests/' + resource.provider).set({
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
async function loadOperatorModules() {
  const cache = new Map();
  const module = async (url) => {
    if (cache.has(url)) return cache.get(url);
    if (url.startsWith('node:')) {
      let ns = await import(url);
      if (url === 'node:fs')
        ns = {
          ...ns,
          readFileSync: (path, ...args) =>
            String(path).includes('/ops/temporal/owned-smoke-incident.staging.json')
              ? JSON.stringify(testCase)
              : fs.readFileSync(path, ...args),
        };
      const result = new vm.SyntheticModule(
        Object.keys(ns),
        function () {
          for (const [k, v] of Object.entries(ns)) this.setExport(k, v);
        },
        { identifier: url }
      );
      cache.set(url, result);
      return result;
    }
    const result = new vm.SourceTextModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
      identifier: url,
      initializeImportMeta: (meta) => {
        meta.url = url;
      },
      importModuleDynamically: async (specifier, ref) => {
        const target = await module(new URL(specifier, ref.identifier).href);
        if (target.status === 'unlinked') await target.link(linker);
        if (target.status === 'linked') await target.evaluate();
        return target;
      },
    });
    cache.set(url, result);
    return result;
  };
  const linker = (specifier, ref) =>
    module(specifier.startsWith('node:') ? specifier : new URL(specifier, ref.identifier).href);
  const url = pathToFileURL(root + '/scripts/temporal-owned-smoke-reconcile.mjs').href;
  const result = await module(url);
  await result.link(linker);
  await result.evaluate();
  const loader = await module(pathToFileURL(root + '/scripts/temporal-owned-smoke-runtime.mjs').href);
  if (loader.status === 'unlinked') await loader.link(linker);
  if (loader.status === 'linked') await loader.evaluate();
  return {
    coordinator: result.namespace.ownedSmokeCoordinator,
    parseReceipt: result.namespace.parseOwnedManifestReceipt,
    loadRuntime: loader.namespace.loadOwnedSmokeRuntime,
  };
}
const preservation = JSON.parse(
  fs.readFileSync(root + '/ops/temporal/owned-smoke-search-preservation.staging.json', 'utf8')
);
const operationId = '31111111-2222-4333-8444-555555555555';
const fixtureRoot = fs.mkdtempSync(resolve(tmpdir(), 'owned-smoke-runtime-'));
// Portable pinned Git fixture of the checked-out production sources. No dependency installation,
// cloud source fetch, default Firebase app or provider transport is used.
const sourcePaths = execFileSync(
  'git',
  [
    'ls-files',
    'functions/src',
    'packages',
    'function-kits/firestore-send-email/src',
    'package.json',
    'functions/package.json',
  ],
  { cwd: root, encoding: 'utf8' }
)
  .trim()
  .split('\n');
for (const path of sourcePaths) {
  if (!fs.statSync(resolve(root, path)).isFile()) continue;
  fs.mkdirSync(dirname(resolve(fixtureRoot, path)), { recursive: true });
  fs.copyFileSync(resolve(root, path), resolve(fixtureRoot, path));
}
execFileSync('git', ['init', '-q'], { cwd: fixtureRoot });
execFileSync('git', ['add', '.'], { cwd: fixtureRoot });
execFileSync(
  'git',
  [
    '-c',
    'user.name=Synthetic Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'Synthetic production source fixture',
  ],
  { cwd: fixtureRoot }
);
const fixtureCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' }).trim(),
  fixtureTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixtureRoot, encoding: 'utf8' }).trim();
fs.symlinkSync(root + '/node_modules', fixtureRoot + '/node_modules', 'dir');
let modules, actualRuntime, native, release, evidence, queueInventory;
function jsonCanonical(value) {
  if (Array.isArray(value)) return '[' + value.map(jsonCanonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + jsonCanonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
async function wholeFixture() {
  await buildFixture();
  testCase.runtimeCommit = fixtureCommit;
  testCase.runtimeTree = fixtureTree;
  // Only the source incident dependency is synthetic. All business readers/stages and the real
  // store factory below are production modules; platform identity/native transport are inert fixtures.
  const provisional = await loadOperatorModules();
  actualRuntime = provisional.loadRuntime({ runtimeRoot: fixtureRoot, runtimeCommit: testCase.runtimeCommit });
  const messageId = actualRuntime.emailMessageId(testCase.projectId, testCase.emailJobId);
  const options = JSON.parse(
    JSON.stringify(
      actualRuntime.secureMailOptions(
        {
          from: 'sender@example.test',
          replyTo: 'reply@example.test',
          to: ['private@example.test'],
          cc: [],
          bcc: [],
          subject: 'Synthetic private subject',
          text: 'Synthetic private body',
          html: '<p>Synthetic private body</p>',
        },
        messageId
      )
    )
  );
  testCase.payloadSha256 = crypto.createHash('sha256').update(jsonCanonical(options)).digest('hex');
  const payload = {
    to: ['private@example.test'],
    message: { subject: options.subject, text: options.text, html: options.html },
    meta: { source: 'runtime-alert', metadata: { mediaItemId: testCase.resources[1].remoteId } },
  };
  const entity = { type: 'mail', id: 'mail/' + testCase.mailId },
    ref = { projectId: testCase.projectId, jobId: testCase.emailJobId };
  const store = actualRuntime.createDurableJobStore({ firestore: db, projectId: testCase.projectId, now: () => 100 });
  await db.runTransaction(async (tx) =>
    store.createInTransaction(tx, {
      ref,
      kind: 'email.deliver',
      entity,
      actorUid: 'system:email',
      payload: { mailPath: entity.id, payload },
      requestId: 'synthetic-whole-fixture',
      generation: 1,
      createdAt: 100,
      dispatch: {
        workflowType: 'emailDeliveryWorkflow',
        workflowId: testCase.emailWorkflowId,
        taskQueue: 'urm-email',
        ref,
      },
    })
  );
  await store.project(ref, {
    state: 'running',
    steps: [{ id: 'deliver', label: 'Delivery', state: 'succeeded', attempt: 1 }],
  });
  const deliveryProfile = {
    schemaVersion: 1,
    mode: 'capture',
    projectId: testCase.projectId,
    profileId: 'urm-app-staging-mail-capture-v1',
    version: 1,
  };
  const transport = { ...deliveryProfile, captureId: testCase.captureId, payloadSha256: testCase.payloadSha256 };
  const info = { messageId, accepted: options.to, rejected: [], pending: [], deliveryTransport: transport };
  await db.doc(entity.id).set({
    ...payload,
    delivery: {
      state: 'SUCCESS',
      jobId: ref.jobId,
      orchestrator: 'temporal',
      messageId,
      info,
      deliveryTransport: transport,
    },
  });
  await db
    .doc('durableEmailReceipts/' + ref.jobId)
    .set({ state: 'accepted', messageId, deliveryProfile, options, info });
  await db.doc('_mailSandboxCaptures/' + testCase.captureId).set({
    schemaVersion: 1,
    messageId,
    externalDelivery: false,
    payloadSha256: testCase.payloadSha256,
    deliveryProfile,
    options,
    capturedAt: Timestamp.fromMillis(Date.parse(testCase.capturedAtIso)),
  });
  const batch = db.batch();
  for (const p of preservation.parents) {
    const jobId = p.jobPath.split('/')[1];
    batch.set(db.doc(p.jobPath), {
      projectId: testCase.projectId,
      jobId,
      kind: 'search.backfill',
      state: 'succeeded',
      generation: 2,
      entity: p.entity,
    });
    batch.set(db.doc(p.intentPath), {
      projectId: testCase.projectId,
      jobId,
      kind: 'search.backfill',
      generation: 2,
      entity: p.entity,
    });
    batch.set(db.doc(p.entityPath), {
      projectId: testCase.projectId,
      activeJobId: jobId,
      generation: 2,
      entity: p.entity,
    });
  }
  for (const path of preservation.historicalSearchJobPaths)
    batch.set(db.doc(path), { projectId: testCase.projectId, kind: 'search.sync', state: 'queued' });
  batch.set(db.doc('_control/temporalProviderUsage'), {
    schemaVersion: 1,
    projectId: testCase.projectId,
    epoch: testCase.originalEpoch,
    status: 'ready',
  });
  const canonical = { subsplashId: testCase.resources[1].remoteId, soundCloudTrackId: testCase.resources[0].remoteId };
  for (const id of testCase.listIds) batch.set(db.doc(`lists/${id}/listItems/${testCase.sermonId}`), canonical);
  const sermonPath = 'sermons/' + testCase.sermonId;
  for (const resource of testCase.resources) {
    const path = `temporalProviderUsage/${actualRuntime.providerResourceKey(resource)}/epochs/${
      testCase.originalEpoch
    }`;
    batch.set(db.doc(path), { ...resource, epoch: testCase.originalEpoch, state: 'active', referenceCount: 1 });
    batch.set(db.doc(path + '/edges/' + actualRuntime.providerEdgeKey(sermonPath)), {
      canonicalPath: sermonPath,
      projectId: testCase.projectId,
    });
  }
  release = {
    environment: 'staging',
    projectId: testCase.projectId,
    mode: 'durable-upgrade',
    compatibilityCommit: testCase.runtimeCommit,
    uiCommit: testCase.runtimeCommit,
    releaseId: '939dd424-7473-4cae-a7a8-ea8e2dcc9977',
    domains: ['publishing', 'emails', 'search'],
  };
  batch.set(db.doc('_control/temporalRelease'), {
    schemaVersion: 1,
    releaseId: release.releaseId,
    revision: 55,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
        d,
        { owner: 'temporal', admission: release.domains.includes(d) ? 'paused' : 'open' },
      ])
    ),
  });
  batch.set(db.doc('_control/temporalReleaseState'), { ...release, controlRevision: 55, phase: 'ownership-changed' });
  await batch.commit();
  native = {
    workflowId: testCase.emailWorkflowId,
    runId: testCase.emailRunId,
    latestRunId: testCase.emailRunId,
    status: 'FAILED',
    failureType: 'EMAIL_STALE_JOB',
    pendingActivities: 0,
    terminalEventType: 'WORKFLOW_EXECUTION_FAILED',
    historyDigest: testCase.emailHistoryDigest,
  };
  modules = await loadOperatorModules();
  actualRuntime = modules.loadRuntime({ runtimeRoot: fixtureRoot, runtimeCommit: testCase.runtimeCommit });
  evidence = {
    descriptorSHA256: 'a'.repeat(64),
    operatorCommit: 'b'.repeat(40),
    operatorClosureDigest: 'c'.repeat(64),
    runtimeCommit: testCase.runtimeCommit,
    runtimeTree: testCase.runtimeTree,
    resourceIdentityDigest: 'd'.repeat(64),
    principalDigest: 'e'.repeat(64),
  };
  queueInventory = {
    schemaVersion: 1,
    projectId: testCase.projectId,
    allQueuePages: true,
    responseView: 'FULL',
    queues: preservation.queues.map((q) => ({
      ...q,
      queueDigest: 'f'.repeat(64),
      allPages: true,
      responseView: 'FULL',
      taskCount: 0,
      tasksDigest: proofDigest([]),
    })),
  };
  queueInventory.inventoryDigest = proofDigest(queueInventory.queues);
}
function coordinator(database = db, extra = {}) {
  return modules.coordinator({
    db: database,
    release,
    descriptorSHA256: evidence.descriptorSHA256,
    evidence,
    runtime: actualRuntime,
    readNative: async () => structuredClone(native),
    readExternal: async () => ({
      evidence: structuredClone(evidence),
      queueInventory: structuredClone(queueInventory),
    }),
    ...extra,
  });
}
function receipt(manifest) {
  const bytes = JSON.stringify({
    mode: 'inspect',
    noMutations: true,
    manifest,
    manifestDigest: proofDigest(manifest),
    cleanupCompleted: true,
  });
  return { bytes, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function lostAckDatabase(stage, before = false) {
  let issued = false;
  return new Proxy(db, {
    get(target, key) {
      if (key === 'runTransaction')
        return async (callback, ...options) => {
          let selected = false;
          const result = await target.runTransaction(async (tx) => {
            const facade = new Proxy(tx, {
              get(t, k) {
                const value = t[k];
                if (['create', 'set', 'update', 'delete'].includes(k))
                  return (ref, ...args) => {
                    if (ref.path === `_control/temporalOwnedSmoke-${operationId}-${stage}`) selected = true;
                    return value.call(t, ref, ...args);
                  };
                return typeof value === 'function' ? value.bind(t) : value;
              },
            });
            const value = await callback(facade);
            if (selected && !issued && before) {
              issued = true;
              throw Error('SYNTHETIC_UNKNOWN_ACK');
            }
            return value;
          }, ...options);
          if (selected && !issued) {
            issued = true;
            throw Error('SYNTHETIC_UNKNOWN_ACK');
          }
          return result;
        };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
try {
  await test('whole inspect/apply runs actual collectors and real store, repairs exactly six edges and one public projection, atomically releases owned operation', async () => {
    await wholeFixture();
    const c = coordinator(),
      manifest = await c.inspect();
    assert(!(await db.doc('_control/temporalReleaseOperation').get()).exists);
    assert(!JSON.stringify(manifest).includes('Synthetic private body'));
    const before = (await db.doc('durableJobs/' + testCase.emailJobId).get()).data();
    const bytes = JSON.stringify({
      mode: 'inspect',
      noMutations: true,
      manifest,
      manifestDigest: proofDigest(manifest),
      cleanupCompleted: true,
    });
    assert.deepEqual(modules.parseReceipt(bytes), manifest);
    await c.apply(
      modules.parseReceipt(bytes),
      operationId,
      false,
      crypto.createHash('sha256').update(bytes).digest('hex')
    );
    assert(!(await db.doc('_control/temporalReleaseOperation').get()).exists);
    assert((await db.doc(`_control/temporalOwnedSmoke-${operationId}-complete`).get()).exists);
    const after = (await db.doc('durableJobs/' + testCase.emailJobId).get()).data();
    assert.equal(after.state, 'succeeded');
    assert.equal(after.revision, before.revision + 1);
    assert.equal(native.status, 'FAILED');
    for (const resource of testCase.resources) {
      const path = `temporalProviderUsage/${actualRuntime.providerResourceKey(resource)}/epochs/${
        testCase.originalEpoch
      }`;
      assert.equal((await db.doc(path).get()).get('referenceCount'), 4);
      assert.equal((await db.collection(path + '/edges').get()).size, 4);
    }
  });
  for (const stage of ['index', 'email', 'complete'])
    await test(`whole lost ${stage} commit ACK resumes identical bytes without repeated writes`, async () => {
      await wholeFixture();
      const m = await coordinator().inspect(),
        r = receipt(m),
        before = (await db.doc('durableJobs/' + testCase.emailJobId).get()).get('revision');
      await assert.rejects(
        coordinator(lostAckDatabase(stage)).apply(m, operationId, false, r.sha),
        /SYNTHETIC_UNKNOWN_ACK/
      );
      const changedBytes = JSON.stringify(JSON.parse(r.bytes), null, 2),
        changedSha = crypto.createHash('sha256').update(changedBytes).digest('hex');
      await assert.rejects(coordinator().apply(m, operationId, true, changedSha), /IDENTITY_CHANGED|AUDIT_CONFLICT/);
      await coordinator().apply(m, operationId, true, r.sha);
      assert(!(await db.doc('_control/temporalReleaseOperation').get()).exists);
      assert.equal((await db.doc('durableJobs/' + testCase.emailJobId).get()).get('revision'), before + 1);
      for (const resource of testCase.resources) {
        const path = `temporalProviderUsage/${actualRuntime.providerResourceKey(resource)}/epochs/${
          testCase.originalEpoch
        }`;
        assert.equal((await db.doc(path).get()).get('referenceCount'), 4);
        assert.equal((await db.collection(path + '/edges').get()).size, 4);
      }
      assert.equal(native.status, 'FAILED');
    });
  await test('whole precommit unknown ACK retains operation and resumes once; malformed inspect receipts reject', async () => {
    await wholeFixture();
    const m = await coordinator().inspect(),
      r = receipt(m);
    assert.deepEqual(modules.parseReceipt(r.bytes), m);
    for (const patch of [
      { cleanupCompleted: false },
      { manifestDigest: '0'.repeat(64) },
      { mode: 'apply' },
      { privateBody: 'forbidden' },
    ])
      assert.throws(
        () => modules.parseReceipt(JSON.stringify({ ...JSON.parse(r.bytes), ...patch })),
        /INSPECT_RECEIPT_REQUIRED/
      );
    await assert.rejects(
      coordinator(lostAckDatabase('index', true)).apply(m, operationId, false, r.sha),
      /SYNTHETIC_UNKNOWN_ACK/
    );
    assert((await db.doc('_control/temporalReleaseOperation').get()).exists);
    assert(!(await db.doc(`_control/temporalOwnedSmoke-${operationId}-index`).get()).exists);
    await coordinator().apply(m, operationId, true, r.sha);
  });
  await test('whole source, native, manifest and private proof changes fail before writes; foreign owner is retained', async () => {
    await wholeFixture();
    const m = await coordinator().inspect(),
      r = receipt(m),
      before = (await db.doc('durableJobs/' + testCase.emailJobId).get()).data();
    const altered = structuredClone(m);
    altered.emailPlan.patch.result.deliveryTransport.extra = 'forbidden';
    await assert.rejects(coordinator().apply(altered, operationId, false, r.sha));
    await assert.rejects(
      coordinator(db, { readNative: async () => ({ ...native, latestRunId: 'another-run' }) }).apply(
        m,
        operationId,
        false,
        r.sha
      ),
      /NATIVE_EMAIL_CHANGED/
    );
    await assert.rejects(
      coordinator(db, {
        readExternal: async () => ({ evidence: { ...evidence, principalDigest: '0'.repeat(64) }, queueInventory }),
      }).apply(m, operationId, false, r.sha),
      /SOURCE_OR_IDENTITY_CHANGED/
    );
    const foreign = { operationId: 'foreign', createdAtMillis: 100 };
    await db.doc('_control/temporalReleaseOperation').create(foreign);
    await assert.rejects(coordinator().apply(m, operationId, false, r.sha), /OPERATION_HELD_OR_STAGE_EXISTS/);
    assert.deepEqual((await db.doc('_control/temporalReleaseOperation').get()).data(), foreign);
    // Test fixture cleanup only; the operator itself never deletes a foreign lock.
    await db.doc('_control/temporalReleaseOperation').delete();
    await db.doc('_mailSandboxCaptures/' + testCase.captureId).update({ 'options.text': 'Changed private capture' });
    await assert.rejects(coordinator().apply(m, operationId, false, r.sha), /NATIVE|PROTECTED/);
    assert(!(await db.doc('_control/temporalReleaseOperation').get()).exists);
    assert.deepEqual((await db.doc('durableJobs/' + testCase.emailJobId).get()).data(), before);
    for (const resource of testCase.resources) {
      const path = `temporalProviderUsage/${actualRuntime.providerResourceKey(resource)}/epochs/${
        testCase.originalEpoch
      }`;
      assert.equal((await db.doc(path).get()).get('referenceCount'), 1);
      assert.equal((await db.collection(path + '/edges').get()).size, 1);
    }
  });
} finally {
  await deleteApp(app);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
