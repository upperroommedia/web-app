#!/usr/bin/env node
/** Separate current-state normal maintenance command; inactive until reviews and required CI. */
import { readFileSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
} from './temporal-release-runtime.mjs';
import { verifyCreateTaskLog } from './temporal-retire-search-lifecycle.mjs';
import { HISTORICAL_WITNESS_SHA256S } from './temporal-search-lifecycle-retirement.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from './temporal-owned-smoke-plan.mjs';
import { loadOwnedSmokeRuntime } from './temporal-owned-smoke-runtime.mjs';
import { collectOwnedSearchPreservation, assertOwnedSearchPreservation } from './temporal-owned-smoke-preservation.mjs';
import {
  CURRENT_LIFECYCLE_CONTRACT as contract,
  assertCurrentLifecycleAuthority,
  currentLifecycleExclusions,
  validateCurrentLifecycleManifest,
  validateCurrentLifecycleInventory,
  currentLifecycleTransport,
  retireCurrentLifecycleTasks,
} from './temporal-current-search-lifecycle.mjs';
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error('CURRENT_LIFECYCLE_' + code), { code: 'CURRENT_LIFECYCLE_' + code });
};
const same = (a, b) => proofDigest(a) === proofDigest(b),
  sha = (x) => /^[a-f0-9]{64}$/.test(x ?? '');
const exact = (x, keys) =>
  x && typeof x === 'object' && !Array.isArray(x) && same(Object.keys(x).sort(), [...keys].sort());
export function parseCurrentLifecycleArgs(args) {
  const v = {},
    flags = new Set(['--apply', '--resume']),
    allowed = new Set([
      '--release',
      '--runtime-root',
      '--operator-commit',
      '--witness-root',
      '--candidate',
      '--manifest',
      '--manifest-sha256',
      '--operation-id',
      '--output',
    ]);
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    need(!Object.hasOwn(v, k) && (flags.has(k) || allowed.has(k)), 'ARGUMENTS');
    v[k] = flags.has(k) ? true : args[++i];
    need(v[k] && !String(v[k]).startsWith('--'), 'ARGUMENTS');
  }
  need(
    ['--release', '--runtime-root', '--operator-commit', '--witness-root', '--output'].every((k) => v[k]) &&
      /^[a-f0-9]{40}$/.test(v['--operator-commit']),
    'ARGUMENTS'
  );
  if (v['--apply'])
    need(
      !v['--candidate'] &&
        v['--manifest'] &&
        sha(v['--manifest-sha256']) &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v['--operation-id'] ?? ''),
      'ARGUMENTS'
    );
  else
    need(
      v['--candidate'] && !['--resume', '--manifest', '--manifest-sha256', '--operation-id'].some((k) => v[k]),
      'ARGUMENTS'
    );
  return v;
}
export function parseCurrentLifecycleReceipt(bytes) {
  const r = JSON.parse(bytes);
  need(
    exact(r, ['mode', 'noMutations', 'manifest', 'manifestDigest', 'cleanupCompleted']) &&
      r.mode === 'inspect' &&
      r.noMutations === true &&
      r.cleanupCompleted === true &&
      r.manifestDigest === proofDigest(r.manifest),
    'CLEAN_INSPECT_REQUIRED'
  );
  return r.manifest;
}
/** Join this task POST to the same log's actual successful function update and source request.
 * This is GCP/Firebase metadata provenance, not independent compiled-byte or SLSA evidence. */
export function verifyCurrentDeploymentLog(row, bytes) {
  const pair = verifyCreateTaskLog(row, bytes),
    lines = bytes.toString('utf8').split('\n'),
    match = row.name.match(/\/queues\/kit-(images|lists|sermons|speakers|users)-index-executeFullIndexOperation\//);
  need(match, 'DEPLOYMENT_INSTANCE_REQUIRED');
  const instance = match[1],
    functionName = `projects/urm-app-staging/locations/us-central1/functions/kit-${instance}-index-executeFullIndexOperation`,
    patchMarker = `>>> [apiv2][body] PATCH https://cloudfunctions.googleapis.com/v2/${functionName} `;
  const endpoint = `https://cloudfunctions.googleapis.com/v2/${functionName}`;
  let patch, acknowledged, finished, patchStatus;
  for (let i = 0; i < row.requestLine - 1; i++) {
    const line = lines[i],
      patchAt = line.indexOf(patchMarker);
    if (patchAt > 0) {
      const value = JSON.parse(line.slice(patchAt + patchMarker.length));
      if (value.name === functionName) {
        patch = { value, line: i + 1 };
        acknowledged = finished = patchStatus = undefined;
      }
    }
    if (patch && line.endsWith(`<<< [apiv2][status] PATCH ${endpoint} 200`)) patchStatus = i + 1;
    const ackMarker = `<<< [apiv2][body] PATCH ${endpoint} `,
      ackAt = line.indexOf(ackMarker);
    if (patch && patchStatus && ackAt > 0) {
      const value = JSON.parse(line.slice(ackAt + ackMarker.length));
      need(
        /^projects\/urm-app-staging\/locations\/us-central1\/operations\/operation-[A-Za-z0-9-]+$/.test(
          value.name ?? ''
        ) &&
          patch.line < patchStatus &&
          patchStatus < i + 1,
        'SUCCESSFUL_DEPLOYMENT_REQUIRED'
      );
      need(!acknowledged, 'DEPLOYMENT_ACK_DUPLICATED');
      acknowledged = { name: value.name, line: i + 1 };
    }
    if (!acknowledged) continue;
    const marker = `<<< [apiv2][body] GET https://cloudfunctions.googleapis.com/v2/${acknowledged.name} `;
    const offset = line.indexOf(marker);
    if (offset > 0) {
      const value = JSON.parse(line.slice(offset + marker.length));
      need(value.name === acknowledged.name, 'DEPLOYMENT_OPERATION_CHANGED');
      if (value.done === true && !value.error && value.response?.name === functionName)
        finished = { value: value.response, request: value.metadata?.requestResource, line: i + 1 };
    }
  }
  need(
    patch &&
      acknowledged &&
      finished &&
      patch.line < acknowledged.line &&
      acknowledged.line < finished.line &&
      finished.line < row.requestLine &&
      lines.slice(row.responseLine).some((line) => line.includes('Deploy complete!')),
    'SUCCESSFUL_DEPLOYMENT_REQUIRED'
  );
  const current = finished.value,
    request = patch.value,
    normalizedRequest = finished.request,
    source = current.buildConfig?.source?.storageSource,
    requestedSource = request.buildConfig?.source?.storageSource,
    env = current.serviceConfig?.environmentVariables;
  const runtimeMatches = (value) =>
    value?.TEMPORAL_RELEASE_COMMIT === contract.applicationCommit &&
    value.STAGING_PROVIDER_MODE === 'sandbox' &&
    ['MEDIA', 'PUBLISHING', 'IMAGES', 'EMAILS', 'ACCOUNTS', 'BUNDLES', 'SEARCH'].every(
      (d) => value['TASK_ORCHESTRATOR_' + d] === 'temporal'
    );
  // The API resolves its temporary upload object into the immutable function-source object.
  // Only the operation ACK returned for this exact PATCH may attest that transformation.
  const managedUpload =
    exact(requestedSource, ['bucket', 'object']) &&
    requestedSource.bucket === 'gcf-v2-uploads-251680231116.us-central1.cloudfunctions.appspot.com' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.zip$/.test(requestedSource.object);
  const directSource = same(source, requestedSource);
  need(
    current.state === 'ACTIVE' &&
      runtimeMatches(env) &&
      runtimeMatches(request.serviceConfig?.environmentVariables) &&
      normalizedRequest?.name === functionName &&
      runtimeMatches(normalizedRequest.serviceConfig?.environmentVariables) &&
      same(source, normalizedRequest.buildConfig?.source?.storageSource) &&
      same(source, current.buildConfig?.sourceProvenance?.resolvedStorageSource) &&
      (managedUpload || directSource) &&
      source?.bucket === 'gcf-v2-sources-251680231116-us-central1' &&
      source.object === `kit-${instance}-index-executeFullIndexOperation/function-source.zip` &&
      /^[1-9][0-9]*$/.test(String(source.generation)) &&
      /^projects\/(251680231116|urm-app-staging)\/locations\/us-central1\/builds\/[a-f0-9-]+$/.test(
        current.buildConfig?.build ?? ''
      ) &&
      current.serviceConfig?.uri?.replace(/\/$/, '') === row.actualTask.httpRequest.url.replace(/\/$/, '') &&
      current.serviceConfig.serviceAccountEmail === row.actualTask.httpRequest.oidcToken.serviceAccountEmail &&
      typeof current.serviceConfig.revision === 'string',
    'DEPLOYED_SOURCE_JOIN_CHANGED'
  );
  return {
    ...pair,
    deployment: {
      functionName,
      applicationCommit: contract.applicationCommit,
      patchLine: patch.line,
      patchAcknowledgementLine: acknowledged.line,
      operationName: acknowledged.name,
      requestedSourceDigest: proofDigest(requestedSource),
      requestSourceKind: managedUpload ? 'managed-upload' : 'immutable-source',
      completionLine: finished.line,
      sourceDigest: proofDigest(source),
      build: current.buildConfig.build,
      revision: current.serviceConfig.revision,
    },
  };
}

/** All business reads are actual fixed collectors. Injection is limited to read-only SDK/identity and task transport. */
export function currentLifecycleCoordinator({ db, release, evidence, runtime, sourceArtifacts, assertSource, api }) {
  const extraPaths = [
    'durableJobs/' + incident.publicationJobId,
    'durableJobIntents/' + incident.publicationJobId,
    'durableJobCriticalSections/' + incident.publicationJobId,
    'durableJobs/' + incident.emailJobId,
    'durableJobIntents/' + incident.emailJobId,
    'mail/' + incident.mailId,
    'durableEmailReceipts/' + incident.emailJobId,
    '_mailSandboxCaptures/' + incident.captureId,
  ];
  const protectedSet = async (tx, m) => {
    await assertOwnedSearchPreservation({ db, tx, runtime, expected: m.searchPreservation });
    const expected = [
      ...new Set([...m.searchPreservation.protectedDocuments.map((p) => p.path), ...extraPaths]),
    ].sort();
    need(same(expected, m.protectedDocuments.map((p) => p.path).sort()), 'PROTECTED_SET_INCOMPLETE');
    for (const row of m.protectedDocuments) assertNativeSnapshot(row.native, await tx.get(db.doc(row.path)));
  };
  const validate = (m) => {
    validateCurrentLifecycleManifest(m, release);
    need(same(m.evidence, evidence) && same(m.sourceArtifacts, sourceArtifacts), 'SOURCE_IDENTITY_CHANGED');
  };
  return Object.freeze({
    inspect: async (tasks) => {
      await assertSource();
      const inventory = await api.inventory();
      let m;
      await db.runTransaction(async (tx) => {
        const [c, s, lock] = await Promise.all(
          ['_control/temporalRelease', '_control/temporalReleaseState', '_control/temporalReleaseOperation'].map((p) =>
            tx.get(db.doc(p))
          )
        );
        assertCurrentLifecycleAuthority(c.data(), s.data(), release, c.get('revision'));
        need(!lock.exists, 'OPERATION_HELD');
        const searchPreservation = await collectOwnedSearchPreservation({ db, tx, runtime }),
          rows = new Map(searchPreservation.protectedDocuments.map((p) => [p.path, p]));
        for (const path of extraPaths) {
          const d = await tx.get(db.doc(path));
          need(d.exists, 'OWNED_INCIDENT_DOCUMENT_MISSING');
          rows.set(path, { path, native: nativeSnapshotProof(d) });
        }
        m = {
          schemaVersion: 1,
          releaseId: release.releaseId,
          runtimeCommit: release.compatibilityCommit,
          revision: c.get('revision'),
          descriptorSHA256: evidence.descriptorSHA256,
          authority: { control: nativeSnapshotProof(c), state: nativeSnapshotProof(s) },
          evidence,
          tasks,
          exclusions: currentLifecycleExclusions(),
          searchPreservation,
          protectedDocuments: [...rows.values()].sort((a, b) => a.path.localeCompare(b.path)),
          sourceArtifacts,
          queueIdentity: inventory.queues
            .map((q) => ({ name: q.queue.name, state: q.queue.state }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
        validate(m);
        validateCurrentLifecycleInventory(inventory, m);
      });
      await assertSource();
      validateCurrentLifecycleInventory(await api.inventory(), m);
      await db.runTransaction(async (tx) => {
        const [c, s] = await Promise.all(
          ['_control/temporalRelease', '_control/temporalReleaseState'].map((p) => tx.get(db.doc(p)))
        );
        assertCurrentLifecycleAuthority(c.data(), s.data(), release, m.revision);
        assertNativeSnapshot(m.authority.control, c);
        assertNativeSnapshot(m.authority.state, s);
        await protectedSet(tx, m);
      });
      return m;
    },
    apply: async (m, operationId, manifestSHA256, resume = false) => {
      validate(m);
      return retireCurrentLifecycleTasks({
        db,
        release,
        manifest: m,
        evidence,
        manifestSHA256,
        operationId,
        resume,
        api,
        assertSource,
        assertProtected: protectedSet,
      });
    },
  });
}
export async function main(args = process.argv.slice(2)) {
  const v = parseCurrentLifecycleArgs(args);
  need(!Object.entries(process.env).some(([k, x]) => k.includes('EMULATOR') && x), 'EMULATOR_FORBIDDEN');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url))),
    descriptorBytes = readFileSync(v['--release']),
    release = validateReleaseConfig(JSON.parse(descriptorBytes)),
    binding = pinReleaseCheckouts(root, resolve(v['--runtime-root']), release);
  need(
    binding.operatorCommit === v['--operator-commit'] && binding.runtimeCommit === contract.applicationCommit,
    'SOURCE_COMMIT_CHANGED'
  );
  const resources = loadReleaseResourceBinding(release),
    out = openSync(v['--output'], 'wx', 0o600);
  let adc,
    sdk,
    result = { result: 'incomplete' },
    cleanupCompleted = false;
  try {
    const sourceArtifacts = [{ path: resolve(v['--release']), sha256: hash(descriptorBytes) }];
    for (const witness of [contract.previousRetirement, contract.originalInspection]) {
      const path = resolve(v['--witness-root'], witness.filename),
        bytes = readFileSync(path);
      need(hash(bytes) === witness.sha256, 'ORIGINAL_WITNESS_CHANGED');
      sourceArtifacts.push({ path, sha256: witness.sha256 });
      if (witness === contract.previousRetirement) {
        const old = JSON.parse(bytes);
        need(
          old.cleanupCompleted === true &&
            old.result?.operationId === witness.operationId &&
            same(old.result.retired, witness.names),
          'PREVIOUS_RETIREMENT_CHANGED'
        );
      }
    }
    // The three pre-fa8 witnesses remain independently pinned; filenames are supplied only through
    // the original exclusions receipt, and all hashes must match the committed historical contract.
    const oldExclusionPath = resolve(
        v['--witness-root'],
        'urm-temporal-99c76a6e-drain39-historical-exclusions-r1.json'
      ),
      exclusionBytes = readFileSync(oldExclusionPath),
      exclusion = JSON.parse(exclusionBytes),
      witnesses = [exclusion.firstSixHistoricalSource, ...(exclusion.actualRetirementWitnesses ?? [])];
    need(
      same(witnesses.map((w) => w?.sha256).sort(), [...HISTORICAL_WITNESS_SHA256S].sort()),
      'HISTORICAL_WITNESSES_CHANGED'
    );
    sourceArtifacts.push({ path: oldExclusionPath, sha256: hash(exclusionBytes) });
    for (const w of witnesses) {
      const path = resolve(w.path);
      need(hash(readFileSync(path)) === w.sha256, 'HISTORICAL_WITNESSES_CHANGED');
      sourceArtifacts.push({ path, sha256: w.sha256 });
    }
    const originalArtifacts = structuredClone(sourceArtifacts);
    let manifest, tasks;
    if (v['--apply']) {
      const bytes = readFileSync(v['--manifest']);
      need(hash(bytes) === v['--manifest-sha256'], 'MANIFEST_BYTES_CHANGED');
      manifest = parseCurrentLifecycleReceipt(bytes);
      need(
        Array.isArray(manifest.sourceArtifacts) &&
          originalArtifacts.every((p) => manifest.sourceArtifacts.some((q) => same(p, q))),
        'ORIGINAL_ARTIFACTS_REQUIRED'
      );
      sourceArtifacts.splice(0, sourceArtifacts.length, ...manifest.sourceArtifacts);
      for (const row of manifest.tasks) {
        const logs = sourceArtifacts.filter((p) => p.sha256 === row.sourceSHA256);
        need(logs.length > 0, 'CREATE_LOG_MISSING');
        const pair = verifyCurrentDeploymentLog(
          {
            name: row.name,
            sourceSha256: row.sourceSHA256,
            requestLine: row.requestLine,
            responseLine: row.responseLine,
            request: row.request,
            response: row.response,
            actualTask: row.task,
          },
          readFileSync(logs[0].path)
        );
        need(
          same(pair.request, row.request) && same(pair.response, row.response) && same(pair.deployment, row.deployment),
          'CREATE_LOG_CHANGED'
        );
      }
    } else {
      const candidatePath = resolve(v['--candidate']),
        bytes = readFileSync(candidatePath),
        candidate = JSON.parse(bytes);
      need(
        exact(candidate, ['schemaVersion', 'projectId', 'releaseId', 'sourceCommit', 'tasks']) &&
          candidate.schemaVersion === 1 &&
          candidate.projectId === release.projectId &&
          candidate.releaseId === release.releaseId &&
          candidate.sourceCommit === binding.runtimeCommit &&
          Array.isArray(candidate.tasks) &&
          candidate.tasks.length === 5,
        'FRESH_CANDIDATE_REQUIRED'
      );
      sourceArtifacts.push({ path: candidatePath, sha256: hash(bytes) });
      tasks = candidate.tasks.map((row) => {
        need(
          typeof row.source === 'string' && row.source.startsWith('/') && sha(row.sourceSha256),
          'CREATE_LOG_REQUIRED'
        );
        const log = readFileSync(row.source),
          pair = verifyCurrentDeploymentLog(row, log);
        sourceArtifacts.push({ path: resolve(row.source), sha256: hash(log) });
        return {
          name: row.name,
          task: row.actualTask,
          sourceSHA256: row.sourceSha256,
          requestLine: row.requestLine,
          responseLine: row.responseLine,
          request: pair.request,
          response: pair.response,
          deployment: pair.deployment,
        };
      });
    }
    const rehash = () => {
      for (const p of sourceArtifacts) need(hash(readFileSync(p.path)) === p.sha256, 'ARTIFACT_CHANGED');
      need(hash(readFileSync(v['--release'])) === hash(descriptorBytes), 'DESCRIPTOR_CHANGED');
    };
    rehash();
    adc = prepareLocalReleaseADC(root, release.projectId);
    sdk = firebaseAdmin(release.projectId, resources.resources.databaseUrl);
    need(sdk.credential === adc.credential, 'ADC_CHANGED');
    const db = sdk.firestore;
    const get = async (url) => {
      const token = await adc.credential.getAccessToken(),
        r = await fetch(url, {
          headers: { Authorization: 'Bearer ' + token.access_token },
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        });
      need(r.ok, 'RESOURCE_READ_FAILED');
      return r.json();
    };
    const principal = await verifyReleaseOperator(binding, adc.credential);
    need(principal.verified && principal.adcAndGcloudAccountMatch === true, 'OPERATOR_IDENTITY');
    const identity = await verifyReleaseResourceIdentity(resources, get);
    const evidence = {
      descriptorSHA256: hash(descriptorBytes),
      operatorCommit: binding.operatorCommit,
      operatorClosureDigest: binding.operatorClosureDigest,
      runtimeCommit: binding.runtimeCommit,
      resourceIdentityDigest: proofDigest({
        identity,
        platform: resources.platformConfigSHA256,
        peer: resources.peerConfigSHA256,
      }),
      principalDigest: proofDigest(principal),
    };
    const assertSource = async () => {
      rehash();
      const current = pinReleaseCheckouts(root, binding.runtimeRoot, release);
      need(
        current.operatorCommit === binding.operatorCommit &&
          current.operatorClosureDigest === binding.operatorClosureDigest &&
          same(loadReleaseResourceBinding(release), resources),
        'SOURCE_CHANGED'
      );
      await assertReleaseRuntimeSource(current, release, (await db.doc('_control/temporalRelease').get()).data());
      need(
        same(await verifyReleaseOperator(current, adc.credential), principal) &&
          same(await verifyReleaseResourceIdentity(resources, get), identity),
        'RESOURCE_OR_PRINCIPAL_CHANGED'
      );
    };
    await assertSource();
    const runtime = loadOwnedSmokeRuntime(binding),
      api = currentLifecycleTransport({ credential: adc.credential }),
      coordinator = currentLifecycleCoordinator({ db, release, evidence, runtime, sourceArtifacts, assertSource, api });
    if (v['--apply']) {
      const value = await coordinator.apply(
        manifest,
        v['--operation-id'],
        v['--manifest-sha256'],
        v['--resume'] === true
      );
      result = { mode: v['--resume'] ? 'resume' : 'apply', completed: true, ...value };
    } else {
      manifest = await coordinator.inspect(tasks);
      result = { mode: 'inspect', noMutations: true, manifest, manifestDigest: proofDigest(manifest) };
    }
  } catch (e) {
    result = {
      result: 'failed',
      operationId: v['--operation-id'] ?? null,
      code: typeof e?.code === 'string' && /^[A-Za-z0-9_/-]{1,100}$/.test(e.code) ? e.code : 'CURRENT_LIFECYCLE_FAILED',
    };
    throw e;
  } finally {
    try {
      try {
        await sdk?.close();
      } finally {
        adc?.close();
      }
      cleanupCompleted = true;
    } finally {
      writeFileSync(out, JSON.stringify({ ...result, cleanupCompleted }, null, 2) + '\n');
      closeSync(out);
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((e) => {
    console.error(
      JSON.stringify({
        code:
          typeof e?.code === 'string' && /^[A-Za-z0-9_/-]{1,100}$/.test(e.code) ? e.code : 'CURRENT_LIFECYCLE_FAILED',
      })
    );
    process.exitCode = 1;
  });
