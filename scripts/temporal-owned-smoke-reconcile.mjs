#!/usr/bin/env node
/** Complete normal staging maintenance CLI. No live use before whole review and required CI. */
import { readFileSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { validateReleaseConfig, firebaseAdmin } from './temporal-release-lib.mjs';
import {
  pinReleaseCheckouts,
  loadReleaseResourceBinding,
  assertReleaseRuntimeSource,
  prepareLocalReleaseADC,
  verifyReleaseOperator,
  verifyReleaseResourceIdentity,
  nativeSnapshotProof,
  assertNativeSnapshot,
  hash,
  proofDigest,
  canonical,
} from './temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident, capturedEmailProjection } from './temporal-owned-smoke-plan.mjs';
import {
  assertOwnedSmokeAuthority,
  validateOwnedIndexPlan,
  applyOwnedIndexStage,
  assertOwnedIndexPoststate,
} from './temporal-owned-smoke-index-stage.mjs';
import {
  applyOwnedEmailStage,
  ownedEmailAuditIdentity,
  verifyOwnedEmailStagePoststate,
  validateOwnedEmailPlan,
} from './temporal-owned-smoke-email-stage.mjs';
import { acquireOwnedSmokeOperation, finishOwnedSmokeOperation } from './temporal-owned-smoke-operation.mjs';
import { collectOwnedMirrorIndexPlan } from './temporal-owned-smoke-index-evidence.mjs';
import { collectOwnedPublicationEvidence } from './temporal-owned-smoke-publication-evidence.mjs';
import { collectOwnedEmailEvidence } from './temporal-owned-smoke-email-evidence.mjs';
import {
  collectOwnedSearchPreservation,
  assertOwnedSearchPreservation,
  collectOwnedEmptyQueueInventory,
} from './temporal-owned-smoke-preservation.mjs';
import { readOriginalOwnedEmailNative } from './temporal-owned-smoke-native.mjs';
import { loadOwnedSmokeRuntime } from './temporal-owned-smoke-runtime.mjs';
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error('OWNED_SMOKE_' + code), { code: 'OWNED_SMOKE_' + code });
};
const same = (a, b) => proofDigest(a) === proofDigest(b);
const exact = (o, keys) =>
  o && typeof o === 'object' && !Array.isArray(o) && same(Object.keys(o).sort(), [...keys].sort());
const sha = (x) => /^[a-f0-9]{64}$/.test(x ?? '');
const uuid = (x) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x ?? '');
function combineProofs(rows) {
  const map = new Map();
  for (const row of rows) {
    need(!map.has(row.path) || same(map.get(row.path), row), 'PROTECTED_PROOF_CONFLICT');
    map.set(row.path, row);
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}
function assertSafeNative(native) {
  need(exact(native, ['createTime', 'updateTime', 'dataDigest']) && sha(native.dataDigest), 'MANIFEST_NATIVE_INVALID');
  for (const stamp of [native.createTime, native.updateTime])
    need(
      exact(stamp, ['seconds', 'nanoseconds']) &&
        Number.isSafeInteger(stamp.seconds) &&
        Number.isInteger(stamp.nanoseconds) &&
        stamp.nanoseconds >= 0 &&
        stamp.nanoseconds < 1e9,
      'MANIFEST_NATIVE_INVALID'
    );
}
function safeRows(rows) {
  need(Array.isArray(rows) && rows.length <= 1000, 'MANIFEST_PROTECTED_INVALID');
  const seen = new Set();
  for (const row of rows) {
    need(
      typeof row.path === 'string' &&
        /^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)+$/.test(row.path) &&
        row.path.length < 2048 &&
        !seen.has(row.path),
      'MANIFEST_PROTECTED_INVALID'
    );
    seen.add(row.path);
    if (row.exists === false) need(exact(row, ['path', 'exists']), 'MANIFEST_PROTECTED_INVALID');
    else {
      need(exact(row, ['path', 'native']), 'MANIFEST_PROTECTED_INVALID');
      assertSafeNative(row.native);
    }
  }
}
export function parseOwnedSmokeArgs(args) {
  const v = {},
    flags = new Set(['--apply', '--resume']);
  const allowed = new Set([
    '--release',
    '--runtime-root',
    '--operator-commit',
    '--output',
    '--witness-root',
    '--manifest',
    '--manifest-sha256',
    '--operation-id',
  ]);
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    need(!Object.hasOwn(v, k) && (flags.has(k) || allowed.has(k)), 'ARGUMENTS');
    v[k] = flags.has(k) ? true : args[++i];
    need(v[k] && !String(v[k]).startsWith('--'), 'ARGUMENTS');
  }
  need(
    ['--release', '--runtime-root', '--operator-commit', '--output', '--witness-root'].every((k) => v[k]) &&
      /^[a-f0-9]{40}$/.test(v['--operator-commit']),
    'ARGUMENTS'
  );
  if (v['--apply']) need(v['--manifest'] && sha(v['--manifest-sha256']) && uuid(v['--operation-id']), 'ARGUMENTS');
  else need(!v['--resume'] && !v['--manifest'] && !v['--manifest-sha256'] && !v['--operation-id'], 'ARGUMENTS');
  return v;
}

/** Consume the exact exclusive inspect receipt; callers never extract or rewrite its manifest. */
export function parseOwnedManifestReceipt(bytes) {
  const receipt = JSON.parse(bytes);
  need(
    exact(receipt, ['mode', 'noMutations', 'manifest', 'manifestDigest', 'cleanupCompleted']) &&
      receipt.mode === 'inspect' &&
      receipt.noMutations === true &&
      receipt.cleanupCompleted === true &&
      sha(receipt.manifestDigest) &&
      receipt.manifestDigest === proofDigest(receipt.manifest),
    'INSPECT_RECEIPT_REQUIRED'
  );
  return receipt.manifest;
}

/** Real business readers/stages are fixed imports; only bounded infrastructure transports are injected. */
export function ownedSmokeCoordinator({ db, release, descriptorSHA256, evidence, runtime, readNative, readExternal }) {
  async function external(expected) {
    const actual = await readExternal();
    need(same(actual.evidence, evidence), 'SOURCE_OR_IDENTITY_CHANGED');
    if (expected) need(same(actual.queueInventory, expected.queueInventory), 'QUEUE_INVENTORY_CHANGED');
    return actual;
  }
  async function authority(tx, m) {
    const [control, state] = await Promise.all(
      ['_control/temporalRelease', '_control/temporalReleaseState'].map((p) => tx.get(db.doc(p)))
    );
    assertOwnedSmokeAuthority(control.data(), state.data(), release, m.revision);
    assertNativeSnapshot(m.authority.control, control);
    assertNativeSnapshot(m.authority.state, state);
  }
  async function protectedState(tx, m) {
    await authority(tx, m);
    safeRows(m.protectedDocuments);
    for (const row of m.protectedDocuments) {
      const s = await tx.get(db.doc(row.path));
      if (row.exists === false) need(!s.exists, 'PROTECTED_ABSENCE_CHANGED');
      else assertNativeSnapshot(row.native, s);
    }
    need(
      same(await collectOwnedPublicationEvidence({ db, tx, runtime }), m.publication),
      'PUBLICATION_INVENTORY_CHANGED'
    );
    await assertOwnedSearchPreservation({ db, tx, runtime, expected: m.searchPreservation });
  }
  const emailProtectedPaths = [
    'durableJobIntents/' + incident.emailJobId,
    'durableJobEntities/' +
      runtime.durableEntityKey(incident.projectId, { type: 'mail', id: 'mail/' + incident.mailId }, 'email.deliver'),
    'durableJobCriticalSections/' + incident.emailJobId,
    'mail/' + incident.mailId,
    'durableEmailReceipts/' + incident.emailJobId,
    '_mailSandboxCaptures/' + incident.captureId,
    'durableJobOutbox/' + incident.emailJobId,
    'durableJobCancellationIntents/' + incident.emailJobId,
  ];
  function validate(m) {
    need(
      exact(m, [
        'schemaVersion',
        'incidentDigest',
        'runtimeCommit',
        'releaseId',
        'revision',
        'descriptorSHA256',
        'evidence',
        'authority',
        'indexPlan',
        'emailPlan',
        'publication',
        'searchPreservation',
        'queueInventory',
        'protectedDocuments',
      ]) &&
        m.schemaVersion === 1 &&
        m.incidentDigest === proofDigest(incident) &&
        m.runtimeCommit === incident.runtimeCommit &&
        m.releaseId === release.releaseId &&
        m.descriptorSHA256 === descriptorSHA256 &&
        same(m.evidence, evidence),
      'MANIFEST_IDENTITY_CHANGED'
    );
    need(exact(m.authority, ['control', 'state']), 'MANIFEST_AUTHORITY_INVALID');
    assertSafeNative(m.authority.control);
    assertSafeNative(m.authority.state);
    validateOwnedIndexPlan(m.indexPlan);
    validateOwnedEmailPlan(m.emailPlan);
    safeRows(m.protectedDocuments);
    need(
      m.emailPlan?.native?.historyDigest === incident.emailHistoryDigest &&
        exact(m.emailPlan, ['schemaVersion', 'jobNative', 'patch', 'native', 'acceptedCapture']),
      'MANIFEST_EMAIL_INVALID'
    );
    assertSafeNative(m.emailPlan.jobNative);
    need(
      same(
        m.emailPlan.patch,
        capturedEmailProjection({
          job: {
            projectId: incident.projectId,
            jobId: incident.emailJobId,
            kind: 'email.deliver',
            state: 'running',
            revision: m.emailPlan.patch.expectedRevision,
            generation: incident.emailGeneration,
            workflowId: incident.emailWorkflowId,
            entity: { type: 'mail', id: 'mail/' + incident.mailId },
          },
          native: m.emailPlan.native,
          acceptedCapture: m.emailPlan.acceptedCapture,
        })
      ),
      'MANIFEST_EMAIL_INVALID'
    );
    safeRows(m.publication?.protectedDocuments);
    safeRows(m.searchPreservation?.protectedDocuments);
    need(
      m.publication.certificateId === incident.certificateId &&
        m.publication.sessionId === incident.sessionId &&
        same(
          [
            ...new Set([
              ...m.publication.protectedDocuments.map((r) => r.path),
              ...m.searchPreservation.protectedDocuments.map((r) => r.path),
              ...emailProtectedPaths,
            ]),
          ].sort(),
          m.protectedDocuments.map((r) => r.path).sort()
        ) &&
        m.protectedDocuments.find((r) => r.path === 'durableJobCriticalSections/' + incident.emailJobId)?.exists ===
          false,
      'MANIFEST_PROTECTED_INCOMPLETE'
    );
  }
  async function inspect() {
    const before = await external(),
      native = await readNative();
    let manifest;
    await db.runTransaction(async (tx) => {
      const [control, state, op] = await Promise.all(
        ['_control/temporalRelease', '_control/temporalReleaseState', '_control/temporalReleaseOperation'].map((p) =>
          tx.get(db.doc(p))
        )
      );
      assertOwnedSmokeAuthority(control.data(), state.data(), release, control.get('revision'));
      need(!op.exists, 'OPERATION_HELD');
      const publication = await collectOwnedPublicationEvidence({ db, tx, runtime });
      const searchPreservation = await collectOwnedSearchPreservation({ db, tx, runtime });
      const email = await collectOwnedEmailEvidence({ db, tx, runtime, native });
      const indexPlan = await collectOwnedMirrorIndexPlan({ db, tx, runtime });
      const extra = [];
      for (const path of emailProtectedPaths.slice(-2)) {
        const snapshot = await tx.get(db.doc(path));
        extra.push(snapshot.exists ? { path, native: nativeSnapshotProof(snapshot) } : { path, exists: false });
      }
      manifest = {
        schemaVersion: 1,
        incidentDigest: proofDigest(incident),
        runtimeCommit: incident.runtimeCommit,
        releaseId: release.releaseId,
        revision: control.get('revision'),
        descriptorSHA256,
        evidence: structuredClone(evidence),
        authority: { control: nativeSnapshotProof(control), state: nativeSnapshotProof(state) },
        indexPlan,
        emailPlan: email.emailPlan,
        publication,
        searchPreservation,
        queueInventory: before.queueInventory,
        protectedDocuments: combineProofs([
          ...publication.protectedDocuments,
          ...searchPreservation.protectedDocuments,
          ...email.protectedDocuments,
          ...extra,
        ]),
      };
      validate(manifest);
    });
    need(same(await readNative(), native), 'NATIVE_EMAIL_CHANGED');
    await external(manifest);
    await db.runTransaction((tx) => protectedState(tx, manifest));
    return manifest;
  }
  async function finalState(tx, m, id, manifestSHA256) {
    const index = await tx.get(db.doc(`_control/temporalOwnedSmoke-${id}-index`)),
      email = await tx.get(db.doc(`_control/temporalOwnedSmoke-${id}-email`));
    need(index.exists && email.exists, 'STAGE_AUDITS_REQUIRED');
    const expected = {
      schemaVersion: 1,
      stage: 'index',
      operationId: id,
      releaseId: release.releaseId,
      manifestDigest: proofDigest(m),
      manifestSHA256,
      planDigest: proofDigest(m.indexPlan),
      edgeCreates: 6,
      countUpdates: 2,
      providerWrites: 0,
      canonicalWrites: 0,
    };
    need(
      exact(index.data(), [...Object.keys(expected), 'recordedAtMillis']) &&
        Object.entries(expected).every(([k, v]) => same(index.get(k), v)) &&
        Number.isSafeInteger(index.get('recordedAtMillis')),
      'INDEX_AUDIT_CONFLICT'
    );
    await assertOwnedIndexPoststate(tx, db, m.indexPlan, index);
    const publicEmailNative = await verifyOwnedEmailStagePoststate(
      tx,
      db,
      email,
      ownedEmailAuditIdentity(release, m, { operationId: id, manifestSHA256 })
    );
    return {
      indexAuditNative: nativeSnapshotProof(index),
      emailAuditNative: nativeSnapshotProof(email),
      publicEmailNative,
      inventoryDigest: m.queueInventory.inventoryDigest,
      protectedDigest: proofDigest(m.protectedDocuments),
      nativeEmailHistoryDigest: m.emailPlan.native.historyDigest,
    };
  }
  async function apply(m, id, resume = false, manifestSHA256) {
    need(sha(manifestSHA256), 'MANIFEST_BYTES_REQUIRED');
    validate(m);
    await external(m);
    need(same(await readNative(), m.emailPlan.native), 'NATIVE_EMAIL_CHANGED');
    const common = {
      db,
      release,
      manifest: m,
      validateManifest: validate,
      assertSourceAndInventories: () => external(m),
      assertProtectedState: (tx) => protectedState(tx, m),
      describeOriginalEmail: readNative,
    };
    const complete = await db.doc(`_control/temporalOwnedSmoke-${id}-complete`).get();
    let operation;
    if (complete.exists) {
      need(resume, 'COMPLETION_ALREADY_EXISTS');
      operation = { operationId: id, evidence, manifestSHA256 };
      return finishOwnedSmokeOperation({
        ...common,
        operation,
        resume: true,
        verifyFinalState: (tx) => finalState(tx, m, id, manifestSHA256),
      });
    }
    operation = await acquireOwnedSmokeOperation({ ...common, operationId: id, evidence, manifestSHA256, resume });
    await applyOwnedIndexStage({
      ...common,
      operation,
      resume,
      collectIndexPlan: (tx) => collectOwnedMirrorIndexPlan({ db, tx, runtime }),
    });
    await applyOwnedEmailStage({
      ...common,
      operation,
      resume,
      createStore: runtime.createDurableJobStore,
      collectEmailPlan: async (tx) =>
        (
          await collectOwnedEmailEvidence({ db, tx, runtime, native: m.emailPlan.native })
        ).emailPlan,
    });
    return finishOwnedSmokeOperation({
      ...common,
      operation,
      resume,
      verifyFinalState: (tx) => finalState(tx, m, id, manifestSHA256),
    });
  }
  return Object.freeze({ inspect, apply, validate });
}

export async function main(args = process.argv.slice(2)) {
  const v = parseOwnedSmokeArgs(args);
  need(!Object.entries(process.env).some(([k, x]) => k.includes('EMULATOR') && x), 'EMULATOR_FORBIDDEN');
  const operatorRoot = resolve(fileURLToPath(new URL('..', import.meta.url))),
    descriptor = readFileSync(v['--release']),
    release = validateReleaseConfig(JSON.parse(descriptor));
  need(
    release.projectId === incident.projectId &&
      release.compatibilityCommit === incident.runtimeCommit &&
      release.mode === 'durable-upgrade',
    'FIXED_RELEASE_REQUIRED'
  );
  const binding = pinReleaseCheckouts(operatorRoot, resolve(v['--runtime-root']), release);
  need(binding.operatorCommit === v['--operator-commit'], 'OPERATOR_COMMIT_CHANGED');
  const resources = loadReleaseResourceBinding(release),
    config = JSON.parse(readFileSync(release.platformConfig));
  need(
    config.temporalNamespace === incident.temporalNamespace &&
      config.cloudAddress === 'urm-app-staging.qwejt.tmprl.cloud:7233',
    'TEMPORAL_NAMESPACE_CHANGED'
  );
  const output = openSync(v['--output'], 'wx', 0o600);
  let adc,
    sdk,
    connection,
    result = { result: 'incomplete' },
    cleanupCompleted = false;
  try {
    const witnesses = {
      ...incident.originalEvidenceSHA256,
      'urm-temporal-fa8bf437-lifecycle-retirement-inspect-r2.json':
        '9d972d986ac3cd86fa0ecc28010964f4bcabeb1f1809e8468b8b90ea0d630adb',
    };
    const checkWitnesses = () => {
      need(hash(readFileSync(v['--release'])) === hash(descriptor), 'DESCRIPTOR_CHANGED');
      for (const [name, digest] of Object.entries(witnesses))
        need(hash(readFileSync(resolve(v['--witness-root'], name))) === digest, 'ORIGINAL_WITNESS_CHANGED');
    };
    checkWitnesses();
    adc = prepareLocalReleaseADC(operatorRoot, release.projectId);
    sdk = firebaseAdmin(release.projectId, resources.resources.databaseUrl);
    need(sdk.credential === adc.credential, 'ADC_CHANGED');
    const db = sdk.firestore;
    await assertReleaseRuntimeSource(binding, release, (await db.doc('_control/temporalRelease').get()).data());
    const runtime = loadOwnedSmokeRuntime(binding);
    const principal = await verifyReleaseOperator(binding, adc.credential);
    need(principal.verified && principal.adcAndGcloudAccountMatch === true, 'OPERATOR_IDENTITY_UNVERIFIED');
    const get = async (url) => {
      const token = await adc.credential.getAccessToken();
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(60000),
      });
      need(response.ok, 'READONLY_API_FAILED');
      return response.json();
    };
    const resource = await verifyReleaseResourceIdentity(resources, get);
    const evidence = {
      descriptorSHA256: hash(descriptor),
      operatorCommit: binding.operatorCommit,
      operatorClosureDigest: binding.operatorClosureDigest,
      runtimeCommit: binding.runtimeCommit,
      runtimeTree: incident.runtimeTree,
      resourceIdentityDigest: proofDigest({
        resource,
        platformConfigSHA256: resources.platformConfigSHA256,
        peerConfigSHA256: resources.peerConfigSHA256,
        temporalNamespace: config.temporalNamespace,
        cloudAddress: config.cloudAddress,
      }),
      principalDigest: proofDigest(principal),
    };
    const readExternal = async () => {
      checkWitnesses();
      need(same(loadReleaseResourceBinding(release), resources), 'PLATFORM_RESOURCE_CONFIG_CHANGED');
      const current = pinReleaseCheckouts(operatorRoot, binding.runtimeRoot, release);
      need(
        current.operatorCommit === binding.operatorCommit &&
          current.operatorClosureDigest === binding.operatorClosureDigest,
        'SOURCE_CLOSURE_CHANGED'
      );
      await assertReleaseRuntimeSource(current, release, (await db.doc('_control/temporalRelease').get()).data());
      need(
        same(await verifyReleaseOperator(current, adc.credential), principal) &&
          same(await verifyReleaseResourceIdentity(resources, get), resource),
        'OPERATOR_OR_RESOURCE_CHANGED'
      );
      return {
        evidence,
        queueInventory: await collectOwnedEmptyQueueInventory({
          getJSON: (path) => {
            need(
              path.startsWith(`projects/${incident.projectId}/locations/us-central1/queues?`) ||
                path.startsWith(`projects/${incident.projectId}/locations/us-central1/queues/`),
              'QUEUE_URL_INVALID'
            );
            return get('https://cloudtasks.googleapis.com/v2/' + path);
          },
        }),
      };
    };
    const req = createRequire(binding.runtimeRoot + '/apps/temporal-worker/package.json'),
      { Connection } = req('@temporalio/client'),
      { historyToJSON } = req('@temporalio/common/lib/proto-utils');
    const key = execFileSync(
      'gcloud',
      ['secrets', 'versions', 'access', '1', '--secret=TEMPORAL_WORKER_API_KEY', '--project=urm-app-staging'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }
    ).trim();
    connection = await Connection.connect({
      address: config.cloudAddress,
      tls: true,
      apiKey: key,
      connectTimeout: 30000,
    });
    const readNative = () =>
      readOriginalOwnedEmailNative({
        namespace: config.temporalNamespace,
        historyToJSON,
        request: (method, payload) => {
          need(
            ['describeWorkflowExecution', 'getWorkflowExecutionHistory'].includes(method),
            'NATIVE_METHOD_FORBIDDEN'
          );
          return connection.withDeadline(Date.now() + 30000, () => connection.workflowService[method](payload));
        },
      });
    const coordinator = ownedSmokeCoordinator({
      db,
      release,
      descriptorSHA256: hash(descriptor),
      evidence,
      runtime,
      readNative,
      readExternal,
    });
    if (v['--apply']) {
      const bytes = readFileSync(v['--manifest']);
      need(hash(bytes) === v['--manifest-sha256'], 'MANIFEST_HASH_CHANGED');
      const manifest = parseOwnedManifestReceipt(bytes);
      const completion = await coordinator.apply(manifest, v['--operation-id'], v['--resume'] === true, hash(bytes));
      result = { mode: v['--resume'] ? 'resume' : 'apply', completed: true, manifestSHA256: hash(bytes), completion };
    } else {
      const manifest = await coordinator.inspect();
      result = { mode: 'inspect', noMutations: true, manifest, manifestDigest: proofDigest(manifest) };
    }
  } catch (error) {
    result = {
      result: 'failed',
      code:
        typeof error?.code === 'string' && /^[A-Za-z0-9_/-]{1,100}$/.test(error.code)
          ? error.code
          : 'OWNED_SMOKE_FAILED',
      operationId: v['--operation-id'] ?? null,
    };
    throw error;
  } finally {
    try {
      try {
        await connection?.close();
        await sdk?.close();
      } finally {
        adc?.close();
      }
      cleanupCompleted = true;
    } finally {
      writeFileSync(output, JSON.stringify({ ...result, cleanupCompleted }, null, 2) + '\n');
      closeSync(output);
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        code:
          typeof error?.code === 'string' && /^[A-Za-z0-9_/-]{1,100}$/.test(error.code)
            ? error.code
            : 'OWNED_SMOKE_FAILED',
      })
    );
    process.exitCode = 1;
  });
