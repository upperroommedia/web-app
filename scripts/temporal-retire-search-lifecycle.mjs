#!/usr/bin/env node
/** Reviewed staging maintenance CLI; inspect is read-only, apply requires an exact manifest digest. */
import { readFileSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateReleaseConfig, firebaseAdmin, CONTROL_PATH } from './temporal-release-lib.mjs';
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
import {
  assertRetirementAuthority,
  validateRetirementManifest,
  validateRetirementInventory,
  retireSearchLifecycleTasks,
} from './temporal-search-lifecycle-retirement.mjs';

const requireThat = (test, code) => {
  if (!test) throw Object.assign(new Error(code), { code });
};
const same = (a, b) => proofDigest(a) === proofDigest(b);
export function parseRetirementArgs(args) {
  const values = {},
    flags = new Set(['--apply', '--resume']);
  const allowed = new Set([
    '--release',
    '--runtime-root',
    '--candidate',
    '--exclusions',
    '--parents',
    '--revision',
    '--manifest',
    '--manifest-sha256',
    '--operator-commit',
    '--operation-id',
    '--output',
  ]);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    requireThat(!Object.hasOwn(values, key) && (flags.has(key) || allowed.has(key)), 'SEARCH_LIFECYCLE_ARGUMENTS');
    values[key] = flags.has(key) ? true : args[++i];
    requireThat(values[key] && !String(values[key]).startsWith('--'), 'SEARCH_LIFECYCLE_ARGUMENTS');
  }
  const apply = values['--apply'] === true;
  requireThat(
    ['--release', '--runtime-root', '--operator-commit', '--output'].every((k) => values[k]) &&
      /^[a-f0-9]{40}$/.test(values['--operator-commit']),
    'SEARCH_LIFECYCLE_ARGUMENTS'
  );
  if (apply)
    requireThat(
      values['--manifest'] &&
        /^[a-f0-9]{64}$/.test(values['--manifest-sha256'] ?? '') &&
        /^[a-f0-9-]{36}$/.test(values['--operation-id'] ?? '') &&
        !['--candidate', '--exclusions', '--parents', '--revision'].some((k) => values[k]),
      'SEARCH_LIFECYCLE_ARGUMENTS'
    );
  else
    requireThat(
      !values['--resume'] &&
        !values['--operation-id'] &&
        !values['--manifest-sha256'] &&
        !values['--manifest'] &&
        ['--candidate', '--exclusions', '--parents', '--revision'].every((k) => values[k]) &&
        /^[1-9][0-9]*$/.test(values['--revision']),
      'SEARCH_LIFECYCLE_ARGUMENTS'
    );
  return values;
}

/** Parse only exact actual CLI request/status/response lines, never trust copied candidate JSON alone. */
export function verifyCreateTaskLog(row, bytes) {
  requireThat(hash(bytes) === row.sourceSha256, 'SEARCH_LIFECYCLE_LOG_HASH_CHANGED');
  const lines = bytes.toString('utf8').split('\n'),
    endpoint = `https://cloudtasks.googleapis.com/v2/${row.name.split('/tasks/')[0]}/tasks`;
  const parse = (line, direction) => {
    const marker = `${direction} [apiv2][body] POST ${endpoint} `;
    const offset = line?.indexOf(marker) ?? -1;
    requireThat(offset > 0, 'SEARCH_LIFECYCLE_LOG_PAIR_CHANGED');
    return JSON.parse(line.slice(offset + marker.length));
  };
  const request = parse(lines[row.requestLine - 1], '>>>'),
    response = parse(lines[row.responseLine - 1], '<<<');
  requireThat(
    row.responseLine === row.requestLine + 2 &&
      lines[row.requestLine].endsWith(`<<< [apiv2][status] POST ${endpoint} 200`) &&
      same(request, row.request) &&
      same(response, row.response) &&
      response.name === row.name,
    'SEARCH_LIFECYCLE_LOG_PAIR_CHANGED'
  );
  return { request, response };
}

/** Fetch has no retries. A DELETE exception or non-2xx is an unknown outcome and retains the owned operation. */
export function cloudTasksTransport({ credential, fetchImpl = fetch }) {
  const request = async (resource, method = 'GET') => {
    requireThat(
      /^projects\/urm-app-staging\/locations\/us-central1\/queues(?:[/?]|$)/.test(resource),
      'SEARCH_LIFECYCLE_API_SCOPE'
    );
    const token = await credential.getAccessToken();
    const response = await fetchImpl(`https://cloudtasks.googleapis.com/v2/${resource}`, {
      method,
      headers: { Authorization: `Bearer ${token.access_token}`, 'X-Goog-User-Project': 'urm-app-staging' },
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
    if (method === 'GET' && response.status === 404 && /\/tasks\//.test(resource)) return null;
    requireThat(response.ok, `SEARCH_LIFECYCLE_API_${response.status}`);
    return method === 'DELETE' ? null : response.json();
  };
  const list = async (resource, key) => {
    const rows = [],
      tokens = new Set();
    let pageToken;
    for (let i = 0; i < 100; i++) {
      const page = await request(resource + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
      requireThat(page && (!page[key] || Array.isArray(page[key])), 'SEARCH_LIFECYCLE_API_SHAPE');
      rows.push(...(page[key] ?? []));
      if (!page.nextPageToken) return rows;
      requireThat(
        typeof page.nextPageToken === 'string' && !tokens.has(page.nextPageToken),
        'SEARCH_LIFECYCLE_PAGINATION'
      );
      tokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }
    throw Error('SEARCH_LIFECYCLE_PAGINATION_BOUND');
  };
  return {
    inventory: async () => {
      const queues = await list('projects/urm-app-staging/locations/us-central1/queues?pageSize=1000', 'queues');
      const entries = [];
      for (const queue of queues)
        entries.push({
          queue,
          allPages: true,
          responseView: 'FULL',
          tasks: await list(queue.name + '/tasks?pageSize=1000&responseView=FULL', 'tasks'),
        });
      return { allQueuePages: true, responseView: 'FULL', queues: entries };
    },
    getTask: (name) => request(name + '?responseView=FULL'),
    deleteTask: (name) => request(name, 'DELETE'),
  };
}

function artifact(path) {
  const bytes = readFileSync(path);
  return { proof: { path: resolve(path), sha256: hash(bytes) }, bytes, data: JSON.parse(bytes) };
}
function assertArtifacts(proofs) {
  for (const proof of proofs)
    requireThat(hash(readFileSync(proof.path)) === proof.sha256, 'SEARCH_LIFECYCLE_ARTIFACT_CHANGED');
}
async function assertQueuedSet(db, tx, manifest) {
  const query = db.collection('durableJobs').where('state', '==', 'queued');
  const snapshot = tx ? await tx.get(query) : await query.get();
  const paths = snapshot.docs
    .filter((d) => d.data().kind?.startsWith('search.'))
    .map((d) => d.ref.path)
    .sort();
  requireThat(same(paths, [...manifest.queuedSearchJobPaths].sort()), 'SEARCH_LIFECYCLE_QUEUED_SEARCH_SET_CHANGED');
}

export async function main(args = process.argv.slice(2)) {
  const v = parseRetirementArgs(args),
    apply = v['--apply'] === true;
  requireThat(
    !Object.entries(process.env).some(([k, value]) => k.includes('EMULATOR') && value),
    'SEARCH_LIFECYCLE_EMULATOR_FORBIDDEN'
  );
  const operatorRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const descriptor = artifact(v['--release']),
    release = validateReleaseConfig(descriptor.data);
  requireThat(
    release.projectId === 'urm-app-staging' && release.environment === 'staging',
    'SEARCH_LIFECYCLE_STAGING_ONLY'
  );
  const binding = pinReleaseCheckouts(operatorRoot, resolve(v['--runtime-root']), release);
  requireThat(binding.operatorCommit === v['--operator-commit'], 'SEARCH_LIFECYCLE_OPERATOR_COMMIT_CHANGED');
  const resourceBinding = loadReleaseResourceBinding(release);
  // Reserve the result before authentication. Failed or partial receipts cannot be overwritten.
  const output = openSync(v['--output'], 'wx', 0o600);
  let adc, sdk, result;
  try {
    adc = prepareLocalReleaseADC(operatorRoot, release.projectId);
    sdk = firebaseAdmin(release.projectId, resourceBinding.resources.databaseUrl);
    requireThat(sdk.credential === adc.credential, 'SEARCH_LIFECYCLE_ADC_CHANGED');
    const db = sdk.firestore;
    const principal = await verifyReleaseOperator(binding, adc.credential);
    const api = async (resource) => {
      const token = await adc.credential.getAccessToken();
      const response = await fetch(resource, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      requireThat(response.ok, 'SEARCH_LIFECYCLE_RESOURCE_IDENTITY_FAILED');
      return response.json();
    };
    const resourceIdentity = await verifyReleaseResourceIdentity(resourceBinding, api);
    const evidence = {
      descriptorSHA256: descriptor.proof.sha256,
      operatorCommit: binding.operatorCommit,
      operatorClosureDigest: binding.operatorClosureDigest,
      runtimeCommit: binding.runtimeCommit,
      resourceIdentity,
      principal,
    };
    const tasks = cloudTasksTransport({ credential: adc.credential });
    let manifest, sourceArtifacts;
    if (apply) {
      const input = artifact(v['--manifest']);
      requireThat(input.proof.sha256 === v['--manifest-sha256'], 'SEARCH_LIFECYCLE_MANIFEST_HASH_CHANGED');
      manifest = input.data.manifest;
      sourceArtifacts = input.data.sourceArtifacts;
      requireThat(
        same(input.data.evidence, evidence) &&
          manifest.descriptorSHA256 === descriptor.proof.sha256 &&
          Array.isArray(sourceArtifacts),
        'SEARCH_LIFECYCLE_OPERATOR_BINDING_CHANGED'
      );
    } else {
      const candidate = artifact(v['--candidate']),
        exclusions = artifact(v['--exclusions']),
        parents = artifact(v['--parents']);
      requireThat(
        candidate.data.projectId === release.projectId &&
          candidate.data.releaseId === release.releaseId &&
          candidate.data.revision === Number(v['--revision']) &&
          candidate.data.sourceCommit === binding.runtimeCommit &&
          parents.data.cleanupCompleted === true &&
          parents.data.parents?.length === 5,
        'SEARCH_LIFECYCLE_CANDIDATE_CHANGED'
      );
      sourceArtifacts = [descriptor.proof, candidate.proof, exclusions.proof, parents.proof];
      const protectedDocuments = [],
        protectedParents = [];
      for (const parent of parents.data.parents) {
        requireThat(parent.rows?.length === 3, 'SEARCH_LIFECYCLE_PARENT_PROOF_INVALID');
        const fields = ['job', 'intent', 'entity'],
          paths = [];
        for (let i = 0; i < 3; i++) {
          const path = parent.rows[i].path,
            document = await db.doc(path).get();
          requireThat(
            document.exists && same(document.data(), parent.proof[fields[i]]),
            'SEARCH_LIFECYCLE_PARENT_CHANGED'
          );
          protectedDocuments.push({ path, data: document.data(), native: nativeSnapshotProof(document) });
          paths.push(path);
        }
        protectedParents.push({
          instanceId: parent.instanceId,
          jobPath: paths[0],
          intentPath: paths[1],
          entityPath: paths[2],
        });
      }
      const queued = await db.collection('durableJobs').where('state', '==', 'queued').get();
      const queuedSearch = queued.docs.filter((d) => d.data().kind?.startsWith('search.'));
      for (const document of queuedSearch)
        protectedDocuments.push({
          path: document.ref.path,
          data: document.data(),
          native: nativeSnapshotProof(document),
        });
      const rows = candidate.data.tasks.map((row) => {
        const bytes = readFileSync(row.source),
          pair = verifyCreateTaskLog(row, bytes);
        sourceArtifacts.push({ path: resolve(row.source), sha256: hash(bytes) });
        return {
          name: row.name,
          task: row.actualTask,
          deploymentLogSHA256: row.sourceSha256,
          requestLine: row.requestLine,
          responseLine: row.responseLine,
          createRequest: pair.request,
          createResponse: pair.response,
        };
      });
      manifest = {
        schemaVersion: 1,
        projectId: release.projectId,
        releaseId: release.releaseId,
        revision: Number(v['--revision']),
        runtimeCommit: binding.runtimeCommit,
        descriptorSHA256: descriptor.proof.sha256,
        exclusionsSHA256: exclusions.proof.sha256,
        exclusions: exclusions.data.historicalTaskExclusions,
        tasks: rows,
        protectedDocuments,
        parents: protectedParents,
        queuedSearchJobPaths: queuedSearch.map((d) => d.ref.path),
      };
    }
    validateRetirementManifest(manifest, release);
    const assertSource = async () => {
      assertArtifacts(sourceArtifacts);
      requireThat(
        same(pinReleaseCheckouts(operatorRoot, binding.runtimeRoot, release), binding),
        'SEARCH_LIFECYCLE_SOURCE_CHANGED'
      );
      await assertReleaseRuntimeSource(binding, release, (await db.doc(CONTROL_PATH).get()).data());
    };
    await assertSource();
    if (apply)
      result = {
        mode: 'apply',
        evidence,
        manifestDigest: proofDigest(manifest),
        result: await retireSearchLifecycleTasks({
          db,
          release,
          manifest,
          operationId: v['--operation-id'],
          evidence,
          ...tasks,
          assertSource,
          assertProtectedSet: (tx, m) => assertQueuedSet(db, tx, m),
          resume: v['--resume'] === true,
        }),
      };
    else {
      const refs = [CONTROL_PATH, '_control/temporalReleaseState', '_control/temporalReleaseOperation'].map((p) =>
        db.doc(p)
      );
      const before = await db.getAll(...refs);
      assertRetirementAuthority(before[0].data(), before[1].data(), release, manifest.revision);
      requireThat(!before[2].exists, 'SEARCH_LIFECYCLE_OPERATION_HELD');
      await assertQueuedSet(db, null, manifest);
      const inventory = validateRetirementInventory(await tasks.inventory(), manifest);
      const after = await db.getAll(...refs);
      before.slice(0, 2).forEach((document, i) => assertNativeSnapshot(nativeSnapshotProof(document), after[i]));
      requireThat(!after[2].exists, 'SEARCH_LIFECYCLE_OPERATION_HELD');
      await assertSource();
      result = {
        mode: 'inspect',
        observedAt: new Date().toISOString(),
        manifest,
        sourceArtifacts,
        evidence,
        inventory,
        authority: before.slice(0, 2).map(nativeSnapshotProof),
        noMutations: true,
      };
    }
  } catch (error) {
    result = {
      result: 'failed',
      code: /^SEARCH_LIFECYCLE_|^RELEASE_/.test(error.code ?? '') ? error.code : 'SEARCH_LIFECYCLE_FAILED',
      operationId: v['--operation-id'] ?? null,
      requiresInspection: apply,
    };
    throw error;
  } finally {
    let cleanupCompleted = false;
    try {
      try {
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
