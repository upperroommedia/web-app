/** New finite current-state route. Historical retirement entry points are never invoked. */
import { readFileSync } from 'node:fs';
import { validateControl, RELEASE_DOMAINS } from './temporal-release-lib.mjs';
import { proofDigest, nativeSnapshotProof, assertNativeSnapshot } from './temporal-release-runtime.mjs';
import { validateRetirementInventory, HISTORICAL_TASK_EXCLUSIONS } from './temporal-search-lifecycle-retirement.mjs';
const contract = JSON.parse(
  readFileSync(new URL('../ops/temporal/current-search-lifecycle-retirement.staging.json', import.meta.url))
);
const freeze = (x) => {
  if (x && typeof x === 'object') {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
export const CURRENT_LIFECYCLE_CONTRACT = freeze(contract);
export const CURRENT_LIFECYCLE_ACTION = 'retire-current-undispatched-search-lifecycle-tasks';
const paths = ['_control/temporalRelease', '_control/temporalReleaseState', '_control/temporalReleaseOperation'];
const need = (ok, code) => {
  if (!ok) throw Object.assign(new Error('CURRENT_LIFECYCLE_' + code), { code: 'CURRENT_LIFECYCLE_' + code });
};
const same = (a, b) => proofDigest(a) === proofDigest(b),
  sha = (x) => /^[a-f0-9]{64}$/.test(x ?? '');
const exact = (x, keys) =>
  x && typeof x === 'object' && !Array.isArray(x) && same(Object.keys(x).sort(), [...keys].sort());
export const currentLifecycleExclusions = () =>
  [...HISTORICAL_TASK_EXCLUSIONS, ...contract.previousRetirement.names].sort();
export function assertCurrentLifecycleAuthority(control, state, release, revision) {
  validateControl(control);
  need(
    release.projectId === 'urm-app-staging' &&
      release.environment === 'staging' &&
      release.mode === 'durable-upgrade' &&
      release.compatibilityCommit === contract.applicationCommit &&
      release.uiCommit === contract.applicationCommit &&
      same(release.domains, ['publishing', 'emails', 'search']),
    'FIXED_NEW_UPGRADE_REQUIRED'
  );
  need(
    Number.isSafeInteger(revision) &&
      revision > 48 &&
      control.revision === revision &&
      control.releaseId === release.releaseId &&
      control.admission === 'paused' &&
      state.releaseId === release.releaseId &&
      state.controlRevision === revision &&
      state.phase === 'compatibility-ready' &&
      state.mode === release.mode &&
      state.compatibilityCommit === release.compatibilityCommit &&
      state.uiCommit === release.uiCommit &&
      same(state.domains, release.domains) &&
      RELEASE_DOMAINS.every((d) => control.domains[d]?.owner === 'temporal') &&
      release.domains.every((d) => control.domains[d]?.admission === 'paused'),
    'AUTHORITY_CHANGED'
  );
}
export function validateCurrentLifecycleManifest(m, release) {
  need(
    exact(m, [
      'schemaVersion',
      'releaseId',
      'runtimeCommit',
      'revision',
      'descriptorSHA256',
      'authority',
      'evidence',
      'tasks',
      'exclusions',
      'searchPreservation',
      'protectedDocuments',
      'sourceArtifacts',
      'queueIdentity',
    ]) &&
      m.schemaVersion === 1 &&
      m.releaseId === release.releaseId &&
      m.runtimeCommit === contract.applicationCommit &&
      Number.isSafeInteger(m.revision) &&
      m.revision > 48 &&
      sha(m.descriptorSHA256) &&
      exact(m.authority, ['control', 'state']) &&
      same(m.exclusions, currentLifecycleExclusions()),
    'MANIFEST_INVALID'
  );
  need(
    exact(m.evidence, [
      'descriptorSHA256',
      'operatorCommit',
      'operatorClosureDigest',
      'runtimeCommit',
      'resourceIdentityDigest',
      'principalDigest',
    ]) &&
      m.evidence.descriptorSHA256 === m.descriptorSHA256 &&
      m.evidence.runtimeCommit === m.runtimeCommit &&
      /^[a-f0-9]{40}$/.test(m.evidence.operatorCommit) &&
      ['descriptorSHA256', 'operatorClosureDigest', 'resourceIdentityDigest', 'principalDigest'].every((k) =>
        sha(m.evidence[k])
      ),
    'EVIDENCE_INVALID'
  );
  need(
    Array.isArray(m.tasks) && m.tasks.length === 5 && new Set(m.tasks.map((t) => t.name)).size === 5,
    'FINITE_FIVE_REQUIRED'
  );
  const instances = new Set();
  for (const row of m.tasks) {
    const match = row.name?.match(
      /^projects\/urm-app-staging\/locations\/us-central1\/queues\/kit-(images|lists|sermons|speakers|users)-index-executeFullIndexOperation\/tasks\/[0-9]+$/
    );
    need(
      exact(row, [
        'name',
        'task',
        'sourceSHA256',
        'requestLine',
        'responseLine',
        'request',
        'response',
        'deployment',
      ]) &&
        match &&
        !instances.has(match[1]) &&
        !m.exclusions.includes(row.name) &&
        sha(row.sourceSHA256) &&
        Number.isSafeInteger(row.requestLine) &&
        row.requestLine > 0 &&
        row.responseLine === row.requestLine + 2,
      'TASK_PROVENANCE_INVALID'
    );
    instances.add(match[1]);
    need(
      exact(row.deployment, [
        'functionName',
        'applicationCommit',
        'patchLine',
        'completionLine',
        'patchAcknowledgementLine',
        'operationName',
        'requestedSourceDigest',
        'requestSourceKind',
        'sourceDigest',
        'build',
        'revision',
      ]) &&
        row.deployment.applicationCommit === contract.applicationCommit &&
        row.deployment.functionName ===
          `projects/urm-app-staging/locations/us-central1/functions/kit-${match[1]}-index-executeFullIndexOperation` &&
        Number.isSafeInteger(row.deployment.patchLine) &&
        row.deployment.patchLine > 0 &&
        Number.isSafeInteger(row.deployment.completionLine) &&
        Number.isSafeInteger(row.deployment.patchAcknowledgementLine) &&
        row.deployment.patchLine < row.deployment.patchAcknowledgementLine &&
        row.deployment.patchAcknowledgementLine < row.deployment.completionLine &&
        /^projects\/urm-app-staging\/locations\/us-central1\/operations\/operation-[A-Za-z0-9-]+$/.test(
          row.deployment.operationName
        ) &&
        sha(row.deployment.requestedSourceDigest) &&
        ['managed-upload', 'immutable-source'].includes(row.deployment.requestSourceKind) &&
        row.deployment.completionLine < row.requestLine &&
        sha(row.deployment.sourceDigest) &&
        /^projects\/[0-9]+\/locations\/us-central1\/builds\/[a-f0-9-]+$/.test(row.deployment.build) &&
        typeof row.deployment.revision === 'string',
      'DEPLOYMENT_SOURCE_REQUIRED'
    );
    const identity = (r) => ({ url: r?.url?.replace(/\/$/, ''), httpMethod: r?.httpMethod, oidcToken: r?.oidcToken });
    need(
      row.request?.task?.httpRequest?.body === 'eyJkYXRhIjp7fX0=' &&
        row.response?.name === row.name &&
        row.response.view === 'BASIC' &&
        same(identity(row.request.task.httpRequest), identity(row.task.httpRequest)) &&
        same(identity(row.response.httpRequest), identity(row.task.httpRequest)) &&
        row.response.createTime === row.task.createTime &&
        row.response.scheduleTime === row.task.scheduleTime,
      'TASK_PROVENANCE_CHANGED'
    );
  }
  need(
    Array.isArray(m.sourceArtifacts) &&
      m.sourceArtifacts.length >= 4 &&
      m.sourceArtifacts.every(
        (p) => exact(p, ['path', 'sha256']) && typeof p.path === 'string' && p.path.startsWith('/') && sha(p.sha256)
      ),
    'SOURCE_ARTIFACTS_REQUIRED'
  );
  need(
    Array.isArray(m.protectedDocuments) &&
      m.protectedDocuments.length >= 23 &&
      new Set(m.protectedDocuments.map((p) => p.path)).size === m.protectedDocuments.length &&
      m.protectedDocuments.every(
        (p) =>
          exact(p, ['path', 'native']) && typeof p.path === 'string' && p.path !== paths[2] && sha(p.native?.dataDigest)
      ),
    'PROTECTED_DOCUMENTS_REQUIRED'
  );
  need(
    Array.isArray(m.searchPreservation?.protectedDocuments) &&
      m.searchPreservation.protectedDocuments.every((p) => m.protectedDocuments.some((q) => same(p, q))),
    'SEARCH_PRESERVATION_REQUIRED'
  );
  need(
    Array.isArray(m.queueIdentity) &&
      m.queueIdentity.length === 13 &&
      new Set(m.queueIdentity.map((q) => q.name)).size === 13,
    'FULL_QUEUES_REQUIRED'
  );
  return m;
}
export function validateCurrentLifecycleInventory(inventory, m, absent = []) {
  // Reuse only the established pure FULL task/target validator, never the historical apply helper.
  validateRetirementInventory(inventory, { tasks: m.tasks }, absent);
  const identity = inventory.queues
    .map((q) => ({ name: q.queue.name, state: q.queue.state }))
    .sort((a, b) => a.name.localeCompare(b.name));
  need(same(identity, m.queueIdentity), 'QUEUE_STATE_CHANGED');
  return identity;
}
/** Strict transport: no retry; every malformed/error page fails closed, even with falsy fields. */
export function currentLifecycleTransport({ credential, fetchImpl = fetch }) {
  const request = async (resource, method = 'GET') => {
    need(/^projects\/urm-app-staging\/locations\/us-central1\/queues(?:[/?]|$)/.test(resource), 'API_SCOPE');
    const token = await credential.getAccessToken(),
      response = await fetchImpl('https://cloudtasks.googleapis.com/v2/' + resource, {
        method,
        headers: { Authorization: 'Bearer ' + token.access_token, 'X-Goog-User-Project': 'urm-app-staging' },
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
    if (method === 'GET' && response.status === 404 && /\/tasks\//.test(resource)) return null;
    need(response.ok, 'API_UNKNOWN_OUTCOME');
    return method === 'DELETE' ? null : response.json();
  };
  const list = async (resource, key) => {
    const rows = [],
      seen = new Set();
    let token;
    for (let page = 0; page < 100; page++) {
      const value = await request(resource + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
      need(
        value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value).every((k) => [key, 'nextPageToken'].includes(k)) &&
          (!Object.hasOwn(value, key) || Array.isArray(value[key])) &&
          (!Object.hasOwn(value, 'nextPageToken') ||
            (typeof value.nextPageToken === 'string' && value.nextPageToken.length > 0)),
        'API_SHAPE'
      );
      rows.push(...(value[key] ?? []));
      if (!Object.hasOwn(value, 'nextPageToken')) return rows;
      token = value.nextPageToken;
      need(!seen.has(token), 'PAGINATION_CYCLE');
      seen.add(token);
    }
    throw Error('CURRENT_LIFECYCLE_PAGINATION_BOUND');
  };
  return Object.freeze({
    inventory: async () => {
      const queues = await list('projects/urm-app-staging/locations/us-central1/queues?pageSize=1000', 'queues'),
        entries = [];
      for (const q of queues) {
        need(
          typeof q?.name === 'string' &&
            /^projects\/urm-app-staging\/locations\/us-central1\/queues\/[A-Za-z0-9_-]+$/.test(q.name),
          'QUEUE_ROUTE'
        );
        entries.push({
          queue: q,
          allPages: true,
          responseView: 'FULL',
          tasks: await list(q.name + '/tasks?pageSize=1000&responseView=FULL', 'tasks'),
        });
      }
      return { allQueuePages: true, responseView: 'FULL', queues: entries };
    },
    getTask: (name) => request(name + '?responseView=FULL'),
    deleteTask: (name) => request(name, 'DELETE'),
  });
}
/** Intent is committed before the one DELETE; issued+still-present always stops explicit resume. */
export async function retireCurrentLifecycleTasks({
  db,
  release,
  manifest: m,
  manifestSHA256,
  operationId,
  evidence,
  api,
  assertSource,
  assertProtected,
  resume = false,
  now = Date.now,
}) {
  validateCurrentLifecycleManifest(m, release);
  need(
    sha(manifestSHA256) &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId ?? '') &&
      same(evidence, m.evidence),
    'OPERATION_IDENTITY_REQUIRED'
  );
  const lockRef = db.doc(paths[2]),
    auditRef = db.doc(`_control/temporalCurrentLifecycle-${operationId}-complete`),
    intents = m.tasks.map((_, i) => db.doc(`_control/temporalCurrentLifecycle-${operationId}-${i}`));
  const identity = {
    schemaVersion: 1,
    action: CURRENT_LIFECYCLE_ACTION,
    operationId,
    releaseId: release.releaseId,
    manifestDigest: proofDigest(m),
    manifestSHA256,
    evidence,
    authority: m.authority,
  };
  const requireIdentity = (data, extra) =>
    need(
      exact(data, [...Object.keys(identity), ...extra]) && Object.entries(identity).every(([k, v]) => same(data[k], v)),
      'OPERATION_IDENTITY_CHANGED'
    );
  const authority = async (tx) => {
    const [c, s] = await Promise.all(paths.slice(0, 2).map((p) => tx.get(db.doc(p))));
    assertCurrentLifecycleAuthority(c.data(), s.data(), release, m.revision);
    assertNativeSnapshot(m.authority.control, c);
    assertNativeSnapshot(m.authority.state, s);
    await assertProtected(tx, m);
  };
  const protect = async (tx) => {
    for (const row of m.protectedDocuments) assertNativeSnapshot(row.native, await tx.get(db.doc(row.path)));
  };
  const full = async (absent) => {
    await assertSource();
    const inventory = await api.inventory();
    validateCurrentLifecycleInventory(inventory, m, absent);
    return proofDigest({
      queues: m.queueIdentity,
      tasks: inventory.queues.flatMap((q) => q.tasks).sort((a, b) => a.name.localeCompare(b.name)),
    });
  };
  const requireAbsent = async () => {
    for (const task of m.tasks) need((await api.getTask(task.name)) === null, 'FINAL_TASK_PRESENT');
  };
  await assertSource();
  const completed = await auditRef.get();
  if (completed.exists) {
    need(resume, 'ALREADY_COMPLETED');
    requireIdentity(completed.data(), [
      'intentProofs',
      'finalInventoryDigest',
      'completedAtMillis',
      'providerWrites',
      'jobWrites',
      'releaseStateWrites',
      'queueStateWrites',
    ]);
    need(
      ['providerWrites', 'jobWrites', 'releaseStateWrites', 'queueStateWrites'].every((k) => completed.get(k) === 0) &&
        Number.isSafeInteger(completed.get('completedAtMillis')) &&
        completed.get('completedAtMillis') > 0,
      'COMPLETION_PROOF_INVALID'
    );
    await requireAbsent();
    const digest = await full(m.tasks.map((t) => t.name));
    need(completed.get('finalInventoryDigest') === digest, 'FINAL_INVENTORY_CHANGED');
    await db.runTransaction(async (tx) => {
      await authority(tx);
      await protect(tx);
      need(!(await tx.get(lockRef)).exists, 'COMPLETION_LOCK_CONFLICT');
      const audit = await tx.get(auditRef);
      assertNativeSnapshot(nativeSnapshotProof(completed), audit);
      const proofs = [];
      for (const ref of intents) proofs.push(nativeSnapshotProof(await tx.get(ref)));
      need(same(proofs, audit.get('intentProofs')), 'FINAL_INTENTS_CHANGED');
    });
    return { completed: true, reconciled: true, operationId, retired: m.tasks.map((t) => t.name) };
  }
  if (!resume) await full([]);
  let operation;
  await db.runTransaction(async (tx) => {
    await authority(tx);
    await protect(tx);
    const [lock, audit, ...rows] = await Promise.all([
      tx.get(lockRef),
      tx.get(auditRef),
      ...intents.map((r) => tx.get(r)),
    ]);
    need(!audit.exists, 'ALREADY_COMPLETED');
    if (resume) {
      need(lock.exists, 'OWNED_OPERATION_MISSING');
      requireIdentity(lock.data(), ['createdAtMillis']);
      need(
        Number.isSafeInteger(lock.get('createdAtMillis')) && lock.get('createdAtMillis') > 0,
        'OPERATION_CLOCK_INVALID'
      );
      operation = lock.data();
    } else {
      need(!lock.exists && rows.every((r) => !r.exists), 'OPERATION_HELD');
      operation = { ...identity, createdAtMillis: now() };
      tx.create(lockRef, operation);
    }
  });
  const acquired = await lockRef.get();
  need(acquired.exists && same(acquired.data(), operation), 'OPERATION_ACQUISITION_CHANGED');
  const operationNative = nativeSnapshotProof(acquired);
  const owned = async (tx) => {
    await authority(tx);
    await protect(tx);
    const lock = await tx.get(lockRef);
    assertNativeSnapshot(operationNative, lock);
  };
  const absent = [];
  for (let i = 0; i < m.tasks.length; i++) {
    const task = m.tasks[i],
      ref = intents[i],
      prior = await ref.get();
    let acknowledgement = 'reconciled-404';
    const intentIdentity = {
      schemaVersion: 1,
      operationId,
      manifestSHA256,
      manifestDigest: identity.manifestDigest,
      name: task.name,
      taskDigest: proofDigest(task.task),
    };
    const checkIntent = (data) =>
      need(
        data &&
          Object.entries(intentIdentity).every(([k, v]) => same(data[k], v)) &&
          ['issued', 'absent'].includes(data.status) &&
          Number.isSafeInteger(data.issuedAtMillis) &&
          exact(data, [
            ...Object.keys(intentIdentity),
            'status',
            'issuedAtMillis',
            ...(data.status === 'absent' ? ['acknowledgement', 'absenceObservedAtMillis'] : []),
          ]),
        'INTENT_CHANGED'
      );
    if (prior.exists) {
      need(resume, 'INTENT_EXISTS');
      checkIntent(prior.data());
      need((await api.getTask(task.name)) === null, 'ISSUED_DELETE_STILL_PRESENT');
    } else {
      await full(absent);
      need(same(await api.getTask(task.name), task.task), 'TASK_CHANGED');
      await db.runTransaction(async (tx) => {
        await owned(tx);
        need(!(await tx.get(ref)).exists, 'INTENT_EXISTS');
        tx.create(ref, { ...intentIdentity, status: 'issued', issuedAtMillis: now() });
      });
      await api.deleteTask(task.name);
      acknowledgement = 'received';
      need((await api.getTask(task.name)) === null, 'DELETE_ABSENCE_UNPROVEN');
    }
    absent.push(task.name);
    await db.runTransaction(async (tx) => {
      await owned(tx);
      const row = await tx.get(ref);
      checkIntent(row.data());
      if (row.get('status') === 'issued')
        tx.update(ref, { status: 'absent', acknowledgement, absenceObservedAtMillis: now() });
    });
  }
  await requireAbsent();
  const finalInventoryDigest = await full(absent),
    observedAt = now();
  await db.runTransaction(async (tx) => {
    await owned(tx);
    const [audit, ...rows] = await Promise.all([tx.get(auditRef), ...intents.map((r) => tx.get(r))]);
    need(
      !audit.exists &&
        now() >= observedAt &&
        now() - observedAt < 60000 &&
        rows.every(
          (r, i) =>
            r.get('status') === 'absent' &&
            r.get('name') === m.tasks[i].name &&
            r.get('manifestSHA256') === manifestSHA256
        ),
      'FINAL_PROOF_CHANGED'
    );
    tx.create(auditRef, {
      ...identity,
      intentProofs: rows.map(nativeSnapshotProof),
      finalInventoryDigest,
      completedAtMillis: now(),
      providerWrites: 0,
      jobWrites: 0,
      releaseStateWrites: 0,
      queueStateWrites: 0,
    });
    tx.delete(lockRef);
  });
  return { completed: true, reconciled: false, operationId, retired: absent };
}
