/** Finite maintenance operation. Never changes release state, queues, jobs, or provider data. */
import { validateControl, RELEASE_DOMAINS } from './temporal-release-lib.mjs';
import { nativeSnapshotProof, assertNativeSnapshot, proofDigest } from './temporal-release-runtime.mjs';

export const RETIREMENT_ACTION = 'retire-undispatched-search-lifecycle-tasks';
const CONTROL = '_control/temporalRelease';
const STATE = '_control/temporalReleaseState';
const LOCK = '_control/temporalReleaseOperation';
const INSTANCES = ['images', 'lists', 'sermons', 'speakers', 'users'];
const fail = (code) => Object.assign(new Error(`SEARCH_LIFECYCLE_${code}`), { code: `SEARCH_LIFECYCLE_${code}` });
const same = (a, b) => proofDigest(a) === proofDigest(b);
const requireThat = (test, code) => {
  if (!test) throw fail(code);
};
const sha = (v) => /^[a-f0-9]{64}$/.test(v ?? '');
const taskPrefix = 'projects/urm-app-staging/locations/us-central1/queues/';

export function assertRetirementAuthority(control, state, release, revision) {
  validateControl(control);
  requireThat(
    release?.projectId === 'urm-app-staging' &&
      release.environment === 'staging' &&
      release.mode === 'durable-upgrade' &&
      release.domains.includes('search'),
    'STAGING_DURABLE_UPGRADE_REQUIRED'
  );
  requireThat(
    Number.isSafeInteger(revision) &&
      revision > 0 &&
      control.revision === revision &&
      control.releaseId === release.releaseId &&
      control.admission === 'paused' &&
      state?.releaseId === release.releaseId &&
      state.controlRevision === revision &&
      state.phase === 'compatibility-ready' &&
      state.mode === release.mode &&
      state.compatibilityCommit === release.compatibilityCommit &&
      state.uiCommit === release.uiCommit &&
      same(state.domains, release.domains) &&
      RELEASE_DOMAINS.every((domain) => control.domains[domain]?.owner === 'temporal') &&
      release.domains.every((domain) => control.domains[domain]?.admission === 'paused'),
    'AUTHORITY_CHANGED'
  );
}

/** The CLI must hash and parse the actual deployment logs before supplying these provenance rows. */
export function validateRetirementManifest(manifest, release) {
  requireThat(
    manifest?.schemaVersion === 1 &&
      manifest.projectId === release.projectId &&
      manifest.releaseId === release.releaseId &&
      manifest.runtimeCommit === release.compatibilityCommit &&
      sha(manifest.descriptorSHA256) &&
      sha(manifest.exclusionsSHA256) &&
      Number.isSafeInteger(manifest.revision) &&
      manifest.revision > 0,
    'MANIFEST_INVALID'
  );
  requireThat(
    Array.isArray(manifest.exclusions) &&
      manifest.exclusions.length >= 16 &&
      new Set(manifest.exclusions).size === manifest.exclusions.length &&
      manifest.exclusions.every((v) => typeof v === 'string' && v.startsWith(taskPrefix)),
    'EXCLUSIONS_INVALID'
  );
  requireThat(Array.isArray(manifest.tasks) && manifest.tasks.length === 5, 'FINITE_FIVE_REQUIRED');
  const instances = new Set();
  for (const row of manifest.tasks) {
    const match = row.name?.match(
      /^projects\/urm-app-staging\/locations\/us-central1\/queues\/kit-(images|lists|sermons|speakers|users)-index-executeFullIndexOperation\/tasks\/[0-9]+$/
    );
    requireThat(match && !instances.has(match[1]) && !manifest.exclusions.includes(row.name), 'TASK_SCOPE_INVALID');
    instances.add(match[1]);
    requireThat(
      sha(row.deploymentLogSHA256) &&
        Number.isSafeInteger(row.requestLine) &&
        row.requestLine > 0 &&
        Number.isSafeInteger(row.responseLine) &&
        row.responseLine > row.requestLine &&
        row.createResponse?.name === row.name &&
        row.createResponse.view === 'BASIC',
      'CREATE_PROVENANCE_REQUIRED'
    );
    validateTask(row.task, row.name);
    const desired = row.createRequest?.task?.httpRequest;
    requireThat(
      desired &&
        desired.body === 'eyJkYXRhIjp7fX0=' &&
        same(requestIdentity(desired), requestIdentity(row.task.httpRequest)) &&
        same(requestIdentity(row.createResponse.httpRequest), requestIdentity(row.task.httpRequest)) &&
        row.createResponse.createTime === row.task.createTime &&
        row.createResponse.scheduleTime === row.task.scheduleTime,
      'CREATE_PROVENANCE_CHANGED'
    );
  }
  requireThat(
    INSTANCES.every((i) => instances.has(i)),
    'FINITE_FIVE_REQUIRED'
  );
  // Exact original parents and all queued search work are independently collected by the CLI.
  requireThat(
    Array.isArray(manifest.protectedDocuments) &&
      manifest.protectedDocuments.length >= 13 &&
      new Set(manifest.protectedDocuments.map((d) => d.path)).size === manifest.protectedDocuments.length &&
      manifest.protectedDocuments.every(
        (d) =>
          /^durable(Jobs|JobIntents|JobEntities)\/[A-Za-z0-9_-]+$/.test(d.path) &&
          sha(d.native?.dataDigest) &&
          d.native.dataDigest === proofDigest(d.data)
      ),
    'PROTECTED_DOCUMENTS_REQUIRED'
  );
  const documents = new Map(manifest.protectedDocuments.map((d) => [d.path, d]));
  requireThat(
    Array.isArray(manifest.parents) &&
      manifest.parents.length === 5 &&
      new Set(manifest.parents.map((p) => p.instanceId)).size === 5 &&
      Array.isArray(manifest.queuedSearchJobPaths) &&
      manifest.queuedSearchJobPaths.length === 8 &&
      new Set(manifest.queuedSearchJobPaths).size === 8,
    'PRESERVED_SEARCH_SET_REQUIRED'
  );
  for (const parent of manifest.parents) {
    const job = documents.get(parent.jobPath)?.data,
      intent = documents.get(parent.intentPath)?.data,
      entity = documents.get(parent.entityPath)?.data;
    requireThat(
      INSTANCES.includes(parent.instanceId?.replace(/-index$/, '')) &&
        job?.projectId === release.projectId &&
        job.kind === 'search.backfill' &&
        job.state === 'succeeded' &&
        job.generation === 2 &&
        parent.jobPath === `durableJobs/${job.jobId}` &&
        parent.intentPath === `durableJobIntents/${job.jobId}` &&
        intent?.projectId === release.projectId &&
        intent.jobId === job.jobId &&
        intent.kind === 'search.backfill' &&
        intent.generation === 2 &&
        intent.payload?.instanceId === parent.instanceId &&
        entity?.projectId === release.projectId &&
        entity.activeJobId === job.jobId &&
        entity.generation === 2 &&
        entity.scope === 'search' &&
        same(job.entity, intent.entity) &&
        same(job.entity, entity.entity),
      'PARENT_CHANGED'
    );
  }
  requireThat(
    manifest.queuedSearchJobPaths.every((path) => {
      const job = documents.get(path)?.data;
      return (
        job?.projectId === release.projectId &&
        job.state === 'queued' &&
        job.kind === 'search.sync' &&
        path === `durableJobs/${job.jobId}`
      );
    }),
    'QUEUED_SEARCH_CHANGED'
  );
  return manifest;
}

function requestIdentity(request) {
  // Cloud Tasks normalizes the Cloud Run target's trailing slash on CreateTask.
  return { url: request?.url?.replace(/\/$/, ''), httpMethod: request?.httpMethod, oidcToken: request?.oidcToken };
}

function validateTask(task, name) {
  requireThat(
    task?.name === name &&
      task.view === 'FULL' &&
      task.httpRequest?.httpMethod === 'POST' &&
      task.httpRequest.body === 'eyJkYXRhIjp7fX0=' &&
      typeof task.createTime === 'string' &&
      Number.isFinite(Date.parse(task.createTime)) &&
      typeof task.scheduleTime === 'string' &&
      Number.isFinite(Date.parse(task.scheduleTime)) &&
      task.dispatchDeadline === '600s' &&
      (task.dispatchCount ?? 0) === 0 &&
      (task.responseCount ?? 0) === 0 &&
      !task.firstAttempt &&
      !task.lastAttempt &&
      !task.pullMessage &&
      !task.appEngineHttpRequest,
    'TASK_DISPATCHED_OR_CHANGED'
  );
  const instance = name.split('/queues/kit-')[1].split('-index-')[0];
  requireThat(
    new RegExp(`^https://kit-${instance}-index-executefullindexoperation-[a-z0-9-]+\\.a\\.run\\.app/?$`).test(
      task.httpRequest.url
    ) &&
      /^firebase-fn-[0-9]+@urm-app-staging\.iam\.gserviceaccount\.com$/.test(
        task.httpRequest.oidcToken?.serviceAccountEmail ?? ''
      ) &&
      task.httpRequest.oidcToken?.audience === task.httpRequest.url.replace(/\/$/, ''),
    'TASK_TARGET_CHANGED'
  );
}

/** Reject unrelated work rather than broadening the finite allowlist or suppressing the drain. */
export function validateRetirementInventory(inventory, manifest, absentNames = []) {
  requireThat(
    inventory?.allQueuePages === true &&
      inventory.responseView === 'FULL' &&
      Array.isArray(inventory.queues) &&
      inventory.queues.length === 13 &&
      new Set(inventory.queues.map((q) => q.queue.name)).size === 13,
    'FULL_INVENTORY_REQUIRED'
  );
  const expected = new Map(manifest.tasks.map((t) => [t.name, t]));
  const seen = new Set();
  const expectedSearchQueues = INSTANCES.flatMap((i) => [
    `${taskPrefix}kit-${i}-index-executeFullIndexOperation`,
    `${taskPrefix}ext-${i}-index-executeFullIndexOperation`,
  ]);
  const legacyQueues = ['addintrooutrotaskhandler', 'processaudiofiletask', 'processaudioyoutubetask'].map(
    (n) => taskPrefix + n
  );
  for (const entry of inventory.queues) {
    const name = entry.queue.name;
    requireThat(
      entry.allPages === true && entry.responseView === 'FULL' && Array.isArray(entry.tasks),
      'FULL_INVENTORY_REQUIRED'
    );
    requireThat(expectedSearchQueues.includes(name) || legacyQueues.includes(name), 'QUEUE_SCOPE_CHANGED');
    if (expectedSearchQueues.includes(name)) requireThat(entry.queue.state === 'PAUSED', 'QUEUE_NOT_PAUSED');
    for (const task of entry.tasks) {
      requireThat(
        expected.has(task.name) &&
          !absentNames.includes(task.name) &&
          !seen.has(task.name) &&
          task.name.startsWith(name + '/tasks/'),
        'UNEXPECTED_TASK'
      );
      validateTask(task, task.name);
      requireThat(same(task, expected.get(task.name).task), 'TASK_METADATA_CHANGED');
      seen.add(task.name);
    }
  }
  requireThat(
    expectedSearchQueues.every((q) => inventory.queues.some((e) => e.queue.name === q)),
    'QUEUE_SCOPE_CHANGED'
  );
  requireThat(
    manifest.tasks.every((t) => seen.has(t.name) !== absentNames.includes(t.name)),
    'TASK_ABSENCE_UNPROVEN'
  );
  return inventory;
}

/**
 * All writes are normal operation ownership, per-task intent/absence receipts, and a final audit.
 * There is deliberately no finally-unlock. A failed/unknown DELETE leaves the operation owned.
 * Resume can reconcile an issued DELETE through GET404, but NEVER issues it a second time.
 */
export async function retireSearchLifecycleTasks({
  db,
  release,
  manifest,
  operationId,
  evidence,
  inventory,
  getTask,
  deleteTask,
  assertSource,
  assertProtectedSet,
  resume = false,
  now = Date.now,
}) {
  validateRetirementManifest(manifest, release);
  requireThat(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId ?? ''),
    'OPERATION_REQUIRED'
  );
  const manifestDigest = proofDigest(manifest);
  const controlRef = db.doc(CONTROL),
    stateRef = db.doc(STATE),
    lockRef = db.doc(LOCK);
  const auditRef = db.doc(`_control/temporalSearchLifecycleRetirement-${operationId}`);
  const intentRefs = manifest.tasks.map((_, i) =>
    db.doc(`_control/temporalSearchLifecycleRetirement-${operationId}-${i}`)
  );
  let authority, operation;
  const assertAuthority = (c, s) => assertRetirementAuthority(c.data(), s.data(), release, manifest.revision);
  const protect = async (tx) => {
    await assertProtectedSet(tx, manifest);
    for (const document of manifest.protectedDocuments) {
      assertNativeSnapshot(document.native, await tx.get(db.doc(document.path)));
    }
  };
  await assertSource();
  if (!resume) {
    requireThat(!(await auditRef.get()).exists, 'ALREADY_COMPLETED');
    validateRetirementInventory(await inventory(), manifest);
  }
  await db.runTransaction(async (tx) => {
    const [c, s, lock, audit, ...intents] = await Promise.all([
      tx.get(controlRef),
      tx.get(stateRef),
      tx.get(lockRef),
      tx.get(auditRef),
      ...intentRefs.map((r) => tx.get(r)),
    ]);
    assertAuthority(c, s);
    await protect(tx);
    requireThat(!audit.exists, 'ALREADY_COMPLETED');
    authority = { control: nativeSnapshotProof(c), state: nativeSnapshotProof(s) };
    if (resume) {
      requireThat(
        lock.exists &&
          lock.data().operationId === operationId &&
          lock.data().action === RETIREMENT_ACTION &&
          lock.data().releaseId === release.releaseId &&
          lock.data().manifestDigest === manifestDigest &&
          same(lock.data().evidence, evidence) &&
          same(lock.data().authority, authority),
        'RESUME_IDENTITY_CHANGED'
      );
    } else {
      requireThat(!lock.exists && intents.every((i) => !i.exists), 'OPERATION_HELD');
      tx.create(lockRef, {
        schemaVersion: 1,
        operationId,
        action: RETIREMENT_ACTION,
        releaseId: release.releaseId,
        manifestDigest,
        authority,
        evidence,
        createdAtMillis: now(),
      });
    }
  });
  operation = nativeSnapshotProof(await lockRef.get());
  const owned = async (tx) => {
    const [c, s, lock] = await Promise.all([tx.get(controlRef), tx.get(stateRef), tx.get(lockRef)]);
    assertAuthority(c, s);
    assertNativeSnapshot(authority.control, c);
    assertNativeSnapshot(authority.state, s);
    assertNativeSnapshot(operation, lock);
    await protect(tx);
  };
  const absent = [];
  for (let i = 0; i < manifest.tasks.length; i++) {
    const task = manifest.tasks[i];
    const prior = await intentRefs[i].get();
    let acknowledgement = 'unobserved-reconciled-404';
    if (prior.exists) {
      requireThat(
        resume &&
          prior.data().name === task.name &&
          prior.data().manifestDigest === manifestDigest &&
          prior.data().operationId === operationId &&
          prior.data().taskDigest === proofDigest(task.task) &&
          ['issued', 'absent'].includes(prior.data().status),
        'INTENT_CHANGED'
      );
      // A persistent task after a lost response needs explicit investigation, never an automatic DELETE retry.
      requireThat((await getTask(task.name)) === null, 'ISSUED_DELETE_STILL_PRESENT');
    } else {
      await assertSource();
      validateRetirementInventory(await inventory(), manifest, absent);
      requireThat(same(await getTask(task.name), task.task), 'TASK_METADATA_CHANGED');
      await db.runTransaction(async (tx) => {
        await owned(tx);
        const intent = await tx.get(intentRefs[i]);
        requireThat(!intent.exists, 'INTENT_CHANGED');
        tx.create(intentRefs[i], {
          schemaVersion: 1,
          operationId,
          manifestDigest,
          name: task.name,
          status: 'issued',
          taskDigest: proofDigest(task.task),
          issuedAtMillis: now(),
        });
      });
      await deleteTask(task.name); // exactly one request; no automatic retry in transport or here
      acknowledgement = 'received';
      requireThat((await getTask(task.name)) === null, 'DELETE_ABSENCE_UNPROVEN');
    }
    absent.push(task.name);
    await db.runTransaction(async (tx) => {
      await owned(tx);
      const intent = await tx.get(intentRefs[i]);
      requireThat(
        intent.exists &&
          intent.data().operationId === operationId &&
          intent.data().manifestDigest === manifestDigest &&
          intent.data().name === task.name,
        'INTENT_CHANGED'
      );
      if (intent.data().status !== 'absent')
        tx.update(intentRefs[i], {
          status: 'absent',
          deleteAcknowledgement: acknowledgement,
          absenceObservedAtMillis: now(),
        });
    });
  }
  await assertSource();
  const finalInventory = validateRetirementInventory(await inventory(), manifest, absent);
  const observedAt = now();
  await db.runTransaction(async (tx) => {
    await owned(tx);
    const [audit, ...intents] = await Promise.all([tx.get(auditRef), ...intentRefs.map((r) => tx.get(r))]);
    requireThat(
      !audit.exists &&
        now() >= observedAt &&
        now() - observedAt < 60000 &&
        intents.every(
          (s, i) =>
            s.data()?.status === 'absent' &&
            s.data().name === manifest.tasks[i].name &&
            s.data().manifestDigest === manifestDigest
        ),
      'FINAL_PROOF_CHANGED'
    );
    tx.create(auditRef, {
      schemaVersion: 1,
      operationId,
      action: RETIREMENT_ACTION,
      releaseId: release.releaseId,
      manifestDigest,
      authority,
      evidence,
      retired: absent,
      finalInventoryDigest: proofDigest(finalInventory),
      completedAtMillis: now(),
      providerWrites: 0,
      releaseStateWrites: 0,
      jobWrites: 0,
      queueStateWrites: 0,
    });
    tx.delete(lockRef);
  });
  return {
    operationId,
    releaseId: release.releaseId,
    revision: manifest.revision,
    retired: absent,
    finalInventory,
    auditPath: auditRef.path,
    providerWrites: 0,
    releaseStateWrites: 0,
    jobWrites: 0,
  };
}
