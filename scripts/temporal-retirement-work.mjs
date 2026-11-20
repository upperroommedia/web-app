import { proofDigest } from './temporal-release-runtime.mjs';

const fail = () => {
  throw new Error('TRADITIONAL_RETIREMENT_WORK_UNCONFIRMED');
};

const stagingPublishingRepairJob = 'job-2cdc4bbb473b76b91027c9ee51ce98234f0537fe69f202ba';
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

/** This staging repair left reusable provider ownership records for audit.
 * Exclude only records still bound to its immutable terminal settlement.
 * Any other job, owner, or critical section is still counted. */
async function readSettledStagingPublishingRecords(db, tx, criticalCount, lockCount) {
  const none = { critical: 0, locks: 0 };
  if (!criticalCount && !lockCount) return none;
  const jobId = stagingPublishingRepairJob;
  const audit = await tx.get(db.doc(`temporalPublishingRecoverySettlementAudits/${jobId}`));
  if (!audit.exists || !audit.createTime?.isEqual(audit.updateTime)) return none;
  const data = audit.data();
  if (
    data.schemaVersion !== 1 ||
    data.projectId !== db.projectId ||
    data.jobId !== jobId ||
    !uuid.test(data.operationId ?? '') ||
    !uuid.test(data.runId ?? '') ||
    !/^[1-9][0-9]*$/.test(data.terminalEvent ?? '') ||
    typeof data.recordedAt?.isEqual !== 'function' ||
    data.recordedAt > audit.createTime ||
    typeof data.workflowId !== 'string' ||
    !data.workflowId.startsWith(db.projectId + ':sermon:') ||
    !data.workflowId.endsWith(':' + jobId) ||
    !sha256.test(data.sessionId ?? '') ||
    !sha256.test(data.operatorDigest ?? '') ||
    !sha256.test(data.nativeRoutingDigest ?? '') ||
    data.result?.retainedOwnershipRecordsSettled !== true ||
    data.result?.confirmedRouting !== true ||
    data.result?.repairApplied !== true ||
    data.result?.successfulRepair !== true ||
    data.result?.sessionState !== 'committed' ||
    data.result?.jobState !== 'cancelled' ||
    data.result?.workflowStatus !== 3
  )
    return none;
  const [job, session, critical, routing] = await tx.getAll(
    db.doc(`durableJobs/${jobId}`),
    db.doc(`temporalProviderMutationSessions/${data.sessionId}`),
    db.doc(`durableJobCriticalSections/${jobId}`),
    db.doc(`temporalPublishingRecoveryRoutingReadbacks/${jobId}`)
  );
  if (
    job.get('state') !== 'cancelled' ||
    job.get('projectId') !== db.projectId ||
    job.get('generation') !== 1 ||
    job.get('workflowId') !== data.workflowId ||
    !routing.createTime?.isEqual(routing.updateTime) ||
    routing.get('schemaVersion') !== 1 ||
    routing.get('operationId') !== data.operationId ||
    routing.get('operatorDigest') !== data.operatorDigest ||
    routing.get('projectId') !== db.projectId ||
    routing.get('jobId') !== jobId ||
    routing.get('confirmed') !== true ||
    routing.get('nativeDigest') !== data.nativeRoutingDigest ||
    session.get('schemaVersion') !== 1 ||
    proofDigest(session.get('scope') ?? null) !== data.sessionId ||
    session.get('scope.projectId') !== db.projectId ||
    session.get('scope.jobId') !== jobId ||
    session.get('state') !== 'committed' ||
    session.get('effectsClosed') !== true ||
    session.get('effectsClosedSourceDispositionValidated') !== true ||
    !sha256.test(session.get('canonicalCompletionDigest') ?? '') ||
    !sha256.test(session.get('canonicalCompletionCatalogDigest') ?? '')
  )
    return none;
  const keys = session.get('resourceKeys');
  const resources = session.get('resources');
  if (
    !Array.isArray(resources) ||
    resources.length !== 3 ||
    !resources.every(
      (resource) =>
        resource?.provider === 'subsplash' &&
        typeof resource.account === 'string' &&
        resource.account.length > 0 &&
        typeof resource.resourceId === 'string' &&
        resource.resourceId.length > 0
    ) ||
    !Array.isArray(keys) ||
    keys.length !== 3 ||
    new Set(keys).size !== 3 ||
    !resources.every(
      (resource, index) =>
        proofDigest([db.projectId, resource.provider, resource.account, resource.resourceId]) === keys[index]
    )
  )
    return none;
  // The audit producer read these original documents in its settlement transaction.
  // A document written after that snapshot needs its own proof.
  const coveredByAudit = (record) =>
    record.exists && typeof record.updateTime?.isEqual === 'function' && record.updateTime <= data.recordedAt;
  if (!coveredByAudit(job) || !coveredByAudit(session)) return none;
  const records = await tx.getAll(...keys.map((key) => db.doc(`temporalProviderMutationLocks/${key}`)));
  const owned = records.filter(
    (lock) =>
      coveredByAudit(lock) &&
      lock.get('schemaVersion') === 1 &&
      lock.get('state') === 'held' &&
      lock.get('projectId') === db.projectId &&
      lock.get('jobId') === jobId &&
      lock.get('sessionId') === data.sessionId
  );
  const oldCritical =
    coveredByAudit(critical) &&
    critical.get('schemaVersion') === 1 &&
    critical.get('projectId') === db.projectId &&
    critical.get('jobId') === jobId &&
    critical.get('generation') === 1 &&
    critical.get('workflowId') === data.workflowId;
  if (owned.length > lockCount || (oldCritical && criticalCount < 1)) fail();
  return { critical: Number(oldCritical), locks: owned.length };
}

/** Exhaustive indexed counts avoid loading old job payloads. A terminal
 * dispatch with zero expiry can retain its old token and owner metadata.
 * Temporal separately proves that the original and candidate executions
 * have no pending Tasks. Activity head documents are historical fences. */
export async function readTraditionalRetirementWork(firestore, tx) {
  if (firestore.projectId !== 'urm-app-staging' || firestore.databaseId !== '(default)') fail();
  const count = async (query) => {
    const n = (await tx.get(query.count())).data().count;
    if (!Number.isSafeInteger(n) || n < 0) fail();
    return n;
  };
  const dispatch = async (collection) => {
    const docs = firestore.collection(collection);
    const [total, settled] = await Promise.all([
      count(docs),
      count(docs.where('state', '==', 'dispatched').where('leaseExpiresAt', '==', 0)),
    ]);
    return { total, settled };
  };
  const sessions = firestore.collection('temporalProviderMutationSessions');
  const [outbox, commands, providerSessions, settledSessions, critical, providerLocks, youtubeSlot] = await Promise.all(
    [
      dispatch('durableJobOutbox'),
      dispatch('durableJobCommands'),
      count(sessions),
      count(sessions.where('state', 'in', ['committed', 'aborted'])),
      count(firestore.collection('durableJobCriticalSections')),
      count(firestore.collection('temporalProviderMutationLocks')),
      tx.get(firestore.doc('temporalYouTubeRenderHosts/staging')),
    ]
  );
  if (
    typeof youtubeSlot.exists !== 'boolean' ||
    outbox.settled > outbox.total ||
    commands.settled > commands.total ||
    settledSessions > providerSessions
  )
    fail();
  const retained = await readSettledStagingPublishingRecords(firestore, tx, critical, providerLocks);
  return {
    outbox,
    commands,
    providerSessions,
    settledSessions,
    critical: critical - retained.critical,
    providerLocks: providerLocks - retained.locks,
    youtubeSlot: youtubeSlot.exists,
  };
}

export function assertTraditionalRetirementWorkIdle(work) {
  if (
    work.outbox.total !== work.outbox.settled ||
    work.commands.total !== work.commands.settled ||
    work.providerSessions !== work.settledSessions ||
    work.critical !== 0 ||
    work.providerLocks !== 0 ||
    work.youtubeSlot !== false
  )
    fail();
  return proofDigest(work);
}

/** The paused release still has historical work from earlier builds. Find any
 * candidate work with bounded index lookups rather than paging that archive. */
export async function readReleaseCandidateWork(firestore, tx, buildId) {
  if (
    firestore.projectId !== 'urm-app-staging' ||
    firestore.databaseId !== '(default)' ||
    !/^[a-f0-9]{40}$/.test(buildId ?? '')
  )
    fail();
  const collections = [
    'durableJobOutbox',
    'durableJobCommands',
    'durableJobCriticalSections',
    'durableActivityExecutions',
    'temporalProviderMutationSessions',
    'temporalProviderMutationLocks',
  ];
  const entries = await Promise.all(
    collections.map(async (collection) => {
      const ref = firestore.collection(collection);
      const pages = await Promise.all(
        ['worker.buildId', 'execution.worker.buildId'].map((field) => tx.get(ref.where(field, '==', buildId).limit(2)))
      );
      const docs = new Map();
      for (const page of pages) {
        if (
          !Number.isSafeInteger(page.size) ||
          page.size < 0 ||
          page.size > 1 ||
          !Array.isArray(page.docs) ||
          page.docs.length !== page.size
        )
          fail();
        for (const doc of page.docs) {
          if (typeof doc.ref?.path !== 'string' || !doc.ref.path.startsWith(collection + '/')) fail();
          docs.set(doc.ref.path, doc);
        }
      }
      if (docs.size > 1) fail();
      return [...docs.values()].map((doc) => ({ collection, doc }));
    })
  );
  return entries.flat();
}
