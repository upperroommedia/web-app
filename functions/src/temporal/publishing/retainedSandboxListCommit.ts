import type { DocumentSnapshot, Firestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  createDurableJobStore,
  durableActivityDrainKey,
  type DurableActivityExecution,
} from '../../../../packages/orchestration/src/job-store';
import {
  assertMatchingSandboxProfile,
  assertSandboxCatalogReady,
  sandboxProfileDocumentPath,
  STAGING_SANDBOX_PROFILE,
} from '../../providerSandbox/profile';
import { sandboxResourceKey } from '../../providerSandbox/store';
import { acknowledgedProjectionDigest as digest } from './acknowledgedProjectionDigest';
import {
  ACKNOWLEDGED_PROJECTION_PLANS,
  bindListRowId,
  matchesAcknowledgedProviderValue,
  readAcknowledgedProjectionFragments,
  type FrozenProjectionWrite,
  validateWrite,
} from './criticalAcknowledgedRepair';
import {
  providerMutationFingerprint,
  providerMutationResourceKey,
  PROVIDER_MUTATION_FACTS,
  PROVIDER_MUTATION_LOCKS,
  PROVIDER_MUTATION_SESSIONS,
  type ProviderMutationResource,
} from './providerMutationGuard';
import { isStagingSandboxDatabase } from '../../providerSandbox/database';

/** The issuer must join this immutable drain to the original blocked native
 * Activity and verify that the same workflow has no pending Activities. */
export interface SandboxListCommitReview {
  sessionId: string;
  workflowId: string;
  generation: number;
  expectedRevision: number;
  certificateId: string;
  drainId: string;
  drainDigest: string;
}

type SandboxListWrite = {
  provider: 'subsplash';
  family: 'lists' | 'list-rows';
  id: string;
  revision: number;
  deleted: false;
};

interface RetainedSandboxListProjection {
  path: string;
  baselineDigest: string;
  patch: Record<string, unknown>;
}

function fail(): never {
  throw new Error('RETAINED_SANDBOX_LIST_COMMIT_UNCONFIRMED');
}

const key = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const frozen = (value: DocumentSnapshot): boolean =>
  value.exists && value.createTime?.isEqual(value.updateTime!) === true;
const after = (left: Timestamp, right: Timestamp): boolean =>
  left.seconds > right.seconds || (left.seconds === right.seconds && left.nanoseconds > right.nanoseconds);
const isSandboxListWrite = (value: unknown): value is SandboxListWrite => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<SandboxListWrite>;
  return (
    row.provider === 'subsplash' &&
    (row.family === 'lists' || row.family === 'list-rows') &&
    key(row.id) &&
    typeof row.revision === 'number' &&
    Number.isSafeInteger(row.revision) &&
    row.revision > 0 &&
    row.deleted === false
  );
};

async function readListProjection(
  tx: Transaction,
  db: Firestore,
  writes: FrozenProjectionWrite[],
  currentRows: DocumentSnapshot[],
  listId: string,
  requestStep: string
): Promise<RetainedSandboxListProjection[]> {
  const roots = writes.filter((write) => /^lists\/[A-Za-z0-9_-]{1,200}$/.test(write.path));
  if (roots.length !== 1 || writes.length > 401 || new Set(writes.map(({ path }) => path)).size !== writes.length)
    return fail();
  const root = roots[0];
  const logicalListId = root.path.split('/')[1];
  if (
    root.patch.count !== currentRows.length ||
    root.patch.logicalCount !== currentRows.length ||
    Object.keys(root.patch).some((field) => !['count', 'logicalCount'].includes(field))
  )
    return fail();
  const items = new Set<string>();
  const mirrors = new Set<string>();
  for (const write of writes) {
    validateWrite(write);
    const [collection, parent, child, document, ...rest] = write.path.split('/');
    const listItem = collection === 'lists' && parent === logicalListId && child === 'listItems' && key(document);
    const membership = collection === 'sermons' && key(parent) && child === 'sermonLists' && document === logicalListId;
    if (
      (write.path !== root.path && !listItem && !membership) ||
      rest.length ||
      (write.mode !== undefined && write.mode !== 'update') ||
      write.expectedExists === false ||
      write.deleteFields?.length ||
      write.requiredAnySteps?.length ||
      write.requiredSteps?.length !== 1 ||
      write.requiredSteps[0] !== requestStep
    )
      return fail();
    if (listItem || membership) {
      const requiredFields = ['uploadStatus.status', 'uploadStatus.listItemId'];
      const allowedFields = listItem ? [...requiredFields, 'physicalPlacement', 'position'] : requiredFields;
      if (
        write.patch['uploadStatus.status'] !== 'UPLOADED' ||
        Object.keys(write.patch).some((field) => !allowedFields.includes(field))
      )
        return fail();
      if (listItem) {
        const placement = write.patch.physicalPlacement as Record<string, unknown> | undefined;
        if (
          !placement ||
          placement.firestoreListId !== logicalListId ||
          placement.subsplashListId !== listId ||
          placement.overflowDepth !== 0 ||
          placement.position !== write.patch.position ||
          Object.keys(placement).some(
            (field) => !['firestoreListId', 'subsplashListId', 'overflowDepth', 'position', 'listItemId'].includes(field)
          )
        )
          return fail();
        items.add(document);
      } else mirrors.add(parent);
    }
  }
  if (digest([...items].sort()) !== digest([...mirrors].sort())) return fail();
  const baselines = await tx.getAll(...writes.map(({ path }) => db.doc(path)));
  if (baselines[writes.indexOf(root)].get('subsplashId') !== listId) return fail();
  return writes.map((write, index) => {
    const baseline = baselines[index];
    if (
      !baseline.exists ||
      !Object.entries(write.expectedFields).every(([field, expected]) => {
        const value = baseline.get(field);
        return value !== undefined && digest(value) === digest(expected);
      }) ||
      (write.expectedDocumentDigest && digest(baseline.data()) !== write.expectedDocumentDigest) ||
      write.absentFields?.some((field) => baseline.get(field) !== undefined)
    )
      return fail();
    const patch = { ...write.patch };
    for (const binding of write.listRowBindings ?? []) {
      if (binding.requestStep !== requestStep || binding.listId !== listId) return fail();
      const candidates = currentRows.filter((row) => row.get('body._embedded.media-item.id') === binding.mediaId);
      if (candidates.length !== 1) return fail();
      const rowId = candidates[0].get('body.id');
      if (!key(rowId) || candidates[0].get('id') !== rowId) return fail();
      bindListRowId(patch, binding, rowId, write.mode);
    }
    return { path: write.path, baselineDigest: digest(baseline.data()), patch };
  });
}

/** Evidence of one committed simulator PATCH, separate from an original
 * provider acknowledgement. This function has no authority to write. */
export async function readRetainedSandboxListCommit(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  review: SandboxListCommitReview
) {
  if (
    !isStagingSandboxDatabase(db, ref.projectId) ||
    !key(ref.jobId) ||
    !sha(review.sessionId) ||
    !sha(review.certificateId) ||
    !sha(review.drainId) ||
    !sha(review.drainDigest) ||
    !Number.isSafeInteger(review.generation) ||
    review.generation < 1 ||
    !Number.isSafeInteger(review.expectedRevision) ||
    review.expectedRevision < 1
  )
    return fail();
  const scope = { ...ref, operation: `publishing:${ref.jobId}:lists:publish:all` };
  if (providerMutationFingerprint(scope) !== review.sessionId) return fail();
  const intent = await createDurableJobStore({ firestore: db, projectId: ref.projectId }).assertCurrentInTransaction(
    tx,
    ref
  );
  const sandbox = db.doc(sandboxProfileDocumentPath(STAGING_SANDBOX_PROFILE));
  const held = db.doc(`${PROVIDER_MUTATION_SESSIONS}/${review.sessionId}`);
  const [[job, session, drain, marker, cancel], claims, journal, catalogue] = await Promise.all([
    tx.getAll(
      db.doc(`durableJobs/${ref.jobId}`),
      held,
      db.doc(`durableActivityDrains/${review.drainId}`),
      sandbox,
      db.doc(`durableJobCancellationIntents/${ref.jobId}`)
    ),
    tx.get(held.collection('requests').limit(2)),
    tx.get(sandbox.collection('requests').where('jobId', '==', ref.jobId).limit(101)),
    readAcknowledgedProjectionFragments(tx, db, ref, review.sessionId, 0, 1),
  ]);
  const execution = drain.get('execution') as DurableActivityExecution | undefined;
  const resources = session.get('resources') as ProviderMutationResource[] | undefined;
  const intentProfile = (intent.payload as { providerExecution?: unknown }).providerExecution;
  assertSandboxCatalogReady(STAGING_SANDBOX_PROFILE, marker.data());
  assertMatchingSandboxProfile(STAGING_SANDBOX_PROFILE, intentProfile);
  if (
    job.get('projectId') !== ref.projectId ||
    job.get('jobId') !== ref.jobId ||
    job.get('kind') !== 'sermon.publish' ||
    job.get('generation') !== review.generation ||
    intent.generation !== review.generation ||
    job.get('workflowId') !== review.workflowId ||
    job.get('revision') !== review.expectedRevision ||
    job.get('state') !== 'needs_attention' ||
    job.get('attention.stepId') !== 'lists' ||
    job.get('attention.resolutionKind') !== 'critical_repair' ||
    job.get('attention.certificateId') !== review.certificateId ||
    digest(job.get('providerExecution')) !== digest(intentProfile) ||
    job.get('providerExecution.scenario') !== 'success' ||
    cancel.exists ||
    !frozen(drain) ||
    drain.get('projectId') !== ref.projectId ||
    drain.get('jobId') !== ref.jobId ||
    drain.get('state') !== 'drained' ||
    drain.get('source') !== 'worker_settled' ||
    !execution ||
    execution.workflowId !== review.workflowId ||
    execution.activityType !== 'applyPublishingLists' ||
    durableActivityDrainKey(ref.projectId, ref.jobId, execution) !== review.drainId ||
    digest(drain.data()) !== review.drainDigest ||
    session.get('state') !== 'active' ||
    session.get('effectsClosed') === true ||
    digest(session.get('scope')) !== digest(scope) ||
    !Array.isArray(resources) ||
    resources.length < 2 ||
    resources.length > 16 ||
    resources.some(
      (r) => r.provider !== 'subsplash' || r.account !== 'app:9XTSHD' || r.resourceType !== 'list' || !key(r.resourceId)
    ) ||
    claims.size !== 1 ||
    journal.size > 100 ||
    catalogue.root.operation !== scope.operation ||
    catalogue.root.intentFingerprint !== digest(intent) ||
    catalogue.root.pageCount !== 1 ||
    catalogue.root.requestCount !== 1 ||
    catalogue.root.completesActivity ||
    catalogue.fragments[0]?.plan.requests.length !== 1
  )
    return fail();
  const resourceKeys = resources.map((r) => providerMutationResourceKey(scope, r)).sort();
  const storedKeys = session.get('resourceKeys') as string[] | undefined;
  if (
    !Array.isArray(storedKeys) ||
    new Set(resourceKeys).size !== resources.length ||
    digest(resourceKeys) !== digest([...storedKeys].sort())
  )
    return fail();
  const locks = await tx.getAll(...resourceKeys.map((id) => db.doc(`${PROVIDER_MUTATION_LOCKS}/${id}`)));
  if (
    locks.some(
      (lock) =>
        lock.get('state') !== 'held' ||
        lock.get('projectId') !== ref.projectId ||
        lock.get('jobId') !== ref.jobId ||
        lock.get('sessionId') !== review.sessionId
    )
  )
    return fail();
  const [claim] = claims.docs;
  const [fragment] = catalogue.fragments;
  const [request] = fragment.plan.requests;
  const target = request.target;
  const step = claim.get('step');
  const claimToken = claim.get('claim');
  const executionId = providerMutationFingerprint([
    execution.workflowId,
    execution.runId,
    execution.activityId,
    execution.scheduledAt,
    execution.attempt,
    execution.worker?.instanceId ?? null,
  ]);
  if (
    !target ||
    !resources.some((r) => digest(r) === digest(target)) ||
    !key(claimToken) ||
    claim.id !== providerMutationFingerprint(step) ||
    claim.get('state') !== 'unknown' ||
    claim.get('executionId') !== executionId ||
    request.step !== step ||
    request.method !== 'PATCH' ||
    claim.get('method') !== request.method ||
    request.fingerprint !== claim.get('fingerprint') ||
    catalogue.root.chainDigest !== digest([digest([]), fragment.index, fragment.digest]) ||
    request.fingerprint !== providerMutationFingerprint([request.method, { target, body: request.payload }])
  )
    return fail();
  const factId = providerMutationFingerprint([review.sessionId, step, claimToken]);
  const plan = db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${review.sessionId}`);
  const [fact, page, pointer] = await tx.getAll(
    db.doc(`${PROVIDER_MUTATION_FACTS}/${factId}`),
    plan.collection('pages').doc(fragment.digest),
    plan.collection('fragments').doc(String(fragment.index).padStart(16, '0'))
  );
  if (
    fact.exists ||
    !frozen(page) ||
    !frozen(pointer) ||
    pointer.get('digest') !== fragment.digest ||
    after(page.createTime!, claim.createTime) ||
    after(pointer.createTime!, claim.createTime)
  )
    return fail();

  const writes = journal.docs.filter((row) => {
    const path = row.get('path');
    return (
      typeof path === 'string' &&
      /^\/builder\/v1\/(lists|list-rows)(?:\/|$)/.test(path) &&
      !['GET', 'HEAD'].includes(row.get('method'))
    );
  });
  const [commit] = writes;
  if (
    writes.length !== 1 ||
    !frozen(commit) ||
    commit.get('schemaVersion') !== 1 ||
    commit.get('profileId') !== STAGING_SANDBOX_PROFILE.profileId ||
    commit.get('jobId') !== ref.jobId ||
    commit.get('scopeKey') !== providerMutationFingerprint([ref.jobId, 'subsplash']) ||
    commit.get('provider') !== 'subsplash' ||
    commit.get('path') !== `/builder/v1/lists/${target.resourceId}` ||
    commit.get('method') !== 'PATCH' ||
    commit.get('outcome') !== 'acknowledged' ||
    commit.get('fault') !== 'success' ||
    after(claim.createTime, commit.createTime) ||
    after(commit.createTime, claim.updateTime)
  )
    return fail();

  const writesForCommit: unknown = commit.get('resources');
  const expectedRows = (request.payload as { _embedded?: { 'list-rows'?: unknown } })?._embedded?.['list-rows'];
  if (
    !Array.isArray(writesForCommit) ||
    !writesForCommit.every(isSandboxListWrite) ||
    !Array.isArray(expectedRows) ||
    !expectedRows.length ||
    expectedRows.length > 200 ||
    writesForCommit.length !== expectedRows.length + 1
  )
    return fail();
  const listWrite = writesForCommit.filter((row) => row.family === 'lists');
  if (listWrite.length !== 1 || listWrite[0].id !== target.resourceId) return fail();
  const writeIds = writesForCommit.map((row) => sandboxResourceKey(row.provider, row.family, row.id));
  if (new Set(writeIds).size !== writeIds.length) return fail();
  const resourceCollection = sandbox.collection('resources');
  const [snapshots, currentRows] = await Promise.all([
    tx.getAll(...writeIds.map((id) => resourceCollection.doc(id))),
    tx.get(
      resourceCollection
        .where('provider', '==', 'subsplash')
        .where('family', '==', 'list-rows')
        .where('body._embedded.source-list.id', '==', target.resourceId)
        .limit(401)
    ),
  ]);
  if (
    currentRows.size > 400 ||
    snapshots.some((snap, index) => {
      const source = writesForCommit[index];
      return (
        !snap.exists ||
        !snap.updateTime?.isEqual(commit.createTime) ||
        snap.get('id') !== source.id ||
        snap.get('provider') !== source.provider ||
        snap.get('family') !== source.family ||
        snap.get('revision') !== source.revision ||
        snap.get('deleted') !== source.deleted
      );
    })
  )
    return fail();
  const current = currentRows.docs.filter((row) => row.get('deleted') === false);
  const liveKeys = current.map((row) => row.id).sort();
  const rowKeys = writeIds.filter((_, index) => writesForCommit[index].family === 'list-rows').sort();
  if (
    digest(liveKeys) !== digest(rowKeys) ||
    !matchesAcknowledgedProviderValue(expectedRows, current.map((row) => row.get('body')))
  )
    return fail();
  const canonicalProjection = await readListProjection(
    tx,
    db,
    fragment.plan.writes,
    current,
    target.resourceId,
    request.step
  );
  return {
    ...ref,
    review,
    resourceKeys,
    physicalListId: target.resourceId,
    requestFingerprint: request.fingerprint,
    claimDigest: digest(claim.data()),
    catalogueDigest: fragment.digest,
    journalId: commit.id,
    journalDigest: digest(commit.data()),
    writtenResourcesDigest: digest(snapshots.map((snapshot) => [snapshot.id, snapshot.data()])),
    canonicalProjection,
  };
}
