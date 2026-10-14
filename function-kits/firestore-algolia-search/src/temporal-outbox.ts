import { createHash } from 'node:crypto';
import stagingSearch from './staging-search.json';
import type { Firestore } from 'firebase-admin/firestore';

export const temporalSearchEnabled = () => process.env.TASK_ORCHESTRATOR_SEARCH === 'temporal';
export async function assertLegacySearchOwnership(
  db: Firestore,
  transaction?: import('firebase-admin/firestore').Transaction,
  continuation = false
): Promise<void> {
  const reference = db.doc('_control/temporalRelease');
  const snapshot = transaction ? await transaction.get(reference) : await reference.get();
  if (!snapshot.exists) return;
  const control = snapshot.data();
  const domain = control?.domains?.search;
  if (control?.schemaVersion !== 1 || domain?.owner !== 'legacy')
    throw new Error('Search execution belongs to a different release owner');
  if (!continuation && (control.admission !== 'open' || domain.admission !== 'open'))
    throw new Error('New search admissions are paused');
}

/** Standalone deployable kit: wire-compatible admission; no workspace runtime import. */
export async function enqueueSearchIntent(
  db: Firestore,
  input: {
    projectId: string;
    instanceId: string;
    requestId: string;
    documentPath?: string;
    previousObjectId?: string;
    /** Authored only by the Firestore document event handler, never task/HTTP input. */
    documentEventContinuation?: boolean;
    appId?: string;
  }
): Promise<void> {
  if (!input.projectId || !input.instanceId)
    throw new Error('Search Temporal project/instance configuration is missing');
  const kind = input.documentPath ? 'search.sync' : 'search.backfill';
  const jobId = createHash('sha256')
    .update(JSON.stringify([input.projectId, input.instanceId, input.requestId, kind]))
    .digest('hex');
  const ref = { projectId: input.projectId, jobId };
  const entity = {
    type: 'maintenance',
    id: createHash('sha256')
      .update(`${input.instanceId}:${input.documentPath ?? 'backfill'}`)
      .digest('hex'),
  };
  const entityKey = createHash('sha256')
    .update(JSON.stringify([input.projectId, entity.type, entity.id, 'search']))
    .digest('hex');
  const job = db.collection('durableJobs').doc(jobId);
  const entityRef = db.collection('durableJobEntities').doc(entityKey);
  await db.runTransaction(async (tx) => {
    const [existing, entitySnapshot] = await Promise.all([tx.get(job), tx.get(entityRef)]);
    if (existing.exists) return;
    const control = (await tx.get(db.doc('_control/temporalRelease'))).data();
    const domain = control?.domains?.search;
    if (
      !control ||
      control.schemaVersion !== 1 ||
      !Number.isSafeInteger(control.revision) ||
      control.revision < 1 ||
      domain?.owner !== 'temporal'
    )
      throw new Error('Search Temporal release ownership is unavailable');
    const instance = stagingSearch.instances.find(row => row.instanceId === input.instanceId);
    const documentSegments = input.documentPath?.split('/');
    const pausedDocumentContinuation = input.documentEventContinuation === true &&
      input.projectId === stagingSearch.projectId && input.appId === stagingSearch.appId &&
      (control.projectId === undefined || control.projectId === stagingSearch.projectId) &&
      instance !== undefined && documentSegments?.length === 2 &&
      documentSegments[0] === instance.collectionPath && !!documentSegments[1] &&
      !['.', '..'].includes(documentSegments[1]) &&
      ['open', 'paused'].includes(control.admission) && ['open', 'paused'].includes(domain.admission);
    if ((control.admission !== 'open' || domain.admission !== 'open') && !pausedDocumentContinuation)
      throw new Error('New search admissions are paused');
    const generation = Number(entitySnapshot.data()?.generation ?? 0) + 1;
    const createdAt = Date.now();
    const workflowId = `search:${input.projectId}:${jobId}`;
    const payload = {
      instanceId: input.instanceId,
      ...(input.documentPath ? { documentPath: input.documentPath } : {}),
      ...(input.previousObjectId ? { previousObjectId: input.previousObjectId } : {}),
    };
    const dispatch = {
      workflowType: input.documentPath ? 'SearchDocument' : 'SearchBackfill',
      workflowId,
      taskQueue: 'urm-search',
      ref,
      ...(!input.documentPath ? { startArgs: { ref } } : {}),
    };
    tx.create(job, {
      ...ref,
      schemaVersion: 1,
      kind,
      entity,
      workflowId,
      generation,
      revision: 1,
      requestedBy: 'system:search',
      requestId: input.requestId,
      state: 'queued',
      createdAt,
      updatedAt: createdAt,
      steps: [],
      actions: [],
    });
    tx.create(db.collection('durableJobIntents').doc(jobId), {
      ...ref,
      schemaVersion: 1,
      kind,
      entity,
      actorUid: 'system:search',
      payload,
      generation,
      createdAt,
    });
    tx.create(db.collection('durableJobOutbox').doc(jobId), {
      ...ref,
      schemaVersion: 1,
      dispatch,
      state: 'pending',
      attempt: 0,
      nextAttemptAt: 0,
      leaseExpiresAt: 0,
      createdAt,
      updatedAt: createdAt,
    });
    tx.set(entityRef, {
      schemaVersion: 1,
      projectId: input.projectId,
      entity,
      scope: 'search',
      generation,
      activeJobId: jobId,
      updatedAt: createdAt,
    });
  });
}
