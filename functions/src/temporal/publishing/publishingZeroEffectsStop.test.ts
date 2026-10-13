import type { Firestore, Transaction } from 'firebase-admin/firestore';
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { firestore: () => ({}) } }));
import {
  preparePublishingZeroEffectsStop,
  runPublishingZeroEffectsStop,
  validatePublishingZeroEffectsStopEvidence,
  PUBLISHING_ZERO_EFFECTS_STOPS,
} from './publishingZeroEffectsStop';
import { sermonDeletionMirrorPlanId, SERMON_DELETION_MIRROR_PLANS } from '../../helpers/sermonDeletionMirrors';
import { acknowledgedProjectionDigest as digest, ACKNOWLEDGED_PROJECTION_PLANS } from './criticalAcknowledgedRepair';
import { criticalRepairCatalogDigest, CRITICAL_REPAIR_SOURCE_CATALOGS } from './criticalRepairCatalog';
import {
  providerMutationFingerprint,
  providerMutationClaimSetSeed,
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_LOCKS,
} from './providerMutationGuard';
import {
  desiredProviderDeletionDocumentFingerprint,
  PROVIDER_USAGE_COLLECTION,
  PROVIDER_USAGE_CONTROL,
  providerResourceKey,
} from '../../../../packages/orchestration/src/provider-usage';
import { mediaReferenceId } from '../../../../packages/orchestration/src/media-artifacts';
const ref = { projectId: 'project', jobId: 'delete-job' },
  getField = (value: any, path: string): any => path.split('.').reduce((current, key) => current?.[key], value);
function fixture() {
  const records = new Map<string, any>(),
    writes: Array<() => void> = [];
  let writing = false;
  const doc = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    collection: (name: string) => query(`${path}/${name}`),
  });
  const snapshot = (path: string): any => ({
    exists: records.has(path),
    id: path.split('/').pop(),
    ref: doc(path),
    data: () => records.get(path),
    get: (field: string) => getField(records.get(path), field),
  });
  function query(path: string, filters: Array<[string, string, unknown]> = [], max = Infinity, after?: string): any {
    return {
      doc: (id: string) => doc(`${path}/${id}`),
      where: (key: string, op: string, value: unknown) => query(path, [...filters, [key, op, value]], max, after),
      limit: (count: number) => query(path, filters, count, after),
      orderBy: () => query(path, filters, max, after),
      startAfter: (cursor: any) => query(path, filters, max, cursor.ref.path),
      count: () => ({ aggregate: () => ({ data: () => ({ count: query(path, filters, max, after).fetch().size }) }) }),
      fetch: () => {
        const docs = [...records.keys()]
          .filter(
            (key) =>
              key.startsWith(path + '/') &&
              key.split('/').length === path.split('/').length + 1 &&
              (!after || key > after) &&
              filters.every(([field, op, value]) =>
                op === 'in'
                  ? (value as unknown[]).includes(getField(records.get(key), field))
                  : getField(records.get(key), field) === value
              )
          )
          .sort()
          .slice(0, max)
          .map(snapshot);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }
  const tx = {
    get: async (target: any) => {
      if (writing) throw Error('read after write');
      return target.aggregate ? target.aggregate() : target.fetch ? target.fetch() : snapshot(target.path);
    },
    getAll: async (...refs: any[]) => {
      if (writing) throw Error('read after write');
      return refs.map((target) => snapshot(target.path));
    },
    create: (target: any, data: any) => {
      writing = true;
      writes.push(() => {
        if (records.has(target.path)) throw Error('exists');
        records.set(target.path, { ...data });
      });
    },
    set: (target: any, data: any, options?: any) => {
      writing = true;
      writes.push(() => records.set(target.path, { ...(options?.merge ? records.get(target.path) : {}), ...data }));
    },
    update: (target: any, data: any) => {
      writing = true;
      writes.push(() => {
        const current = { ...records.get(target.path) };
        for (const [field, value] of Object.entries(data)) {
          if ((value as any)?.constructor?.name === 'DeleteTransform') delete current[field];
          else current[field] = value;
        }
        records.set(target.path, current);
      });
    },
    delete: (target: any) => {
      writing = true;
      writes.push(() => records.delete(target.path));
    },
  } as unknown as Transaction;
  const db = { doc, collection: query } as unknown as Firestore;
  const commitCurrent = async (_ref: any, run: (tx: Transaction) => Promise<void>) => {
    writing = false;
    writes.length = 0;
    try {
      await run(tx);
      for (const write of writes) write();
    } finally {
      writing = false;
      writes.length = 0;
    }
  };
  const originalRoot = {
      id: 'sermon',
      title: 'Published original',
      subsplashId: 'media-1',
      audioArtifacts: { finalPath: 'audio/original' },
    },
    planId = sermonDeletionMirrorPlanId(ref, 'sermon'),
    operation = 'durable:project:delete-job:sermon:delete',
    scope = { ...ref, operation },
    sessionId = providerMutationFingerprint(scope),
    target = { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media-1' },
    resourceKey = providerMutationFingerprint([ref.projectId, target.provider, target.account, target.resourceId]);
  const intent = {
      schemaVersion: 1,
      ...ref,
      kind: 'sermon.delete',
      generation: 1,
      actorUid: 'original-actor',
      createdAt: 10,
      publishingSourceProtocol: 'publishing-source-catalog-v1',
      entity: { type: 'sermon', id: 'sermon' },
      payload: { sermonId: 'sermon', action: 'delete', generation: 1 },
    },
    job = { ...intent, state: 'needs_attention', workflowId: 'workflow', revision: 4, createdAt: 10 },
    critical = { ...ref, generation: 1, workflowId: 'workflow', reasonCode: 'DELETE_PLANNING' };
  const frozen = {
    schemaVersion: 2,
    ...ref,
    sessionId,
    operation,
    intentFingerprint: digest(intent),
    pageCount: 1,
    requestCount: 1,
    chainDigest: 'a'.repeat(64),
    completesActivity: false,
    uiStepIds: ['delete-plan'],
  };
  const header = {
    schemaVersion: 1,
    ...ref,
    sermonId: 'sermon',
    planId,
    generation: 1,
    workflowId: 'workflow',
    operation,
    state: 'prepared',
    intentFingerprint: desiredProviderDeletionDocumentFingerprint(intent),
    originalRoot,
    originalRootDigest: digest(originalRoot),
    pointerClearRootDigest: 'b'.repeat(64),
    sourceParentRef: ref,
    sourceStepIds: ['delete-plan'],
    requests: [{ step: 'delete:subsplash:media-1', method: 'DELETE', fingerprint: 'c'.repeat(64), target }],
    verifications: [{ ...target, expectedState: 'absent' }],
    frozenProgramDigest: digest(frozen),
    immutableCanonicalCatalogDigest: 'd'.repeat(64),
    canonicalPageCount: 3,
    canonicalChainDigest: 'e'.repeat(64),
  };
  const catalogBody = {
    schemaVersion: 1,
    ...ref,
    generation: 1,
    workflowId: 'workflow',
    intentDigest: criticalRepairCatalogDigest(intent),
    producerProtocol: 'publishing-source-catalog-v1',
    sourceProgramChainDigest: 'f'.repeat(64),
    count: 0,
    revision: 0,
    sealed: true,
    criticalDigest: criticalRepairCatalogDigest(critical),
    acceptedUserCancellation: false,
  };
  records.set('durableJobIntents/delete-job', intent);
  records.set('durableJobs/delete-job', job);
  records.set('durableJobCriticalSections/delete-job', critical);
  records.set(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/delete-job`, {
    ...catalogBody,
    sealDigest: criticalRepairCatalogDigest(catalogBody),
  });
  records.set('sermons/sermon', originalRoot);
  records.set(`${SERMON_DELETION_MIRROR_PLANS}/${planId}`, header);
  records.set(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`, {
    schemaVersion: 1,
    scope,
    resources: [target],
    resourceKeys: [resourceKey],
    state: 'active',
  });
  records.set(`${PROVIDER_MUTATION_LOCKS}/${resourceKey}`, { state: 'held', sessionId });
  records.set(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`, frozen);
  records.set(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}/requestIndex/request`, {
    ready: true,
    intentFingerprint: frozen.intentFingerprint,
  });
  records.set('temporalMediaState/sermon', { projectId: ref.projectId, deletionParentRef: ref });
  records.set('temporalMediaDeletionEffects/delete-job', {
    projectId: ref.projectId,
    deletionEffectsStarted: true,
    startedAt: 9,
  });
  const artifactId = '1'.repeat(64),
    artifactPath = `temporalMediaArtifacts/${artifactId}`,
    referencePath = `${artifactPath}/references/${mediaReferenceId('canonical', 'sermon', 'final')}`;
  records.set('temporalMediaCanonicalRefs/sermon', { projectId: ref.projectId, artifactIds: { final: artifactId } });
  records.set(artifactPath, {
    projectId: ref.projectId,
    sermonId: 'sermon',
    status: 'retained',
    path: 'audio/original',
  });
  records.set(referencePath, {
    projectId: ref.projectId,
    type: 'canonical',
    jobId: 'sermon',
    slot: 'final',
    state: 'active',
    createdAt: 1,
  });
  records.set('lists/list/listItems/row', { sermonId: 'sermon', title: 'Published original' });
  const resource = {
      projectId: ref.projectId,
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      remoteId: 'media-1',
    },
    aggregatePath = `${PROVIDER_USAGE_COLLECTION}/${providerResourceKey(resource)}/epochs/current`;
  records.set(PROVIDER_USAGE_CONTROL, {
    schemaVersion: 1,
    projectId: ref.projectId,
    epoch: 'current',
    status: 'ready',
  });
  records.set(aggregatePath, {
    state: 'reserved',
    referenceCount: 2,
    desiredDeletionProof: {
      jobId: ref.jobId,
      generation: 1,
      resourceType: 'media',
      intentFingerprint: desiredProviderDeletionDocumentFingerprint(intent),
    },
  });
  const authorizeInTransaction = jest.fn(async () => {}),
    deps = { firestore: db, commitCurrent, authorizeInTransaction };
  async function granted() {
    let source: Awaited<ReturnType<typeof preparePublishingZeroEffectsStop>> | undefined;
    await commitCurrent(ref, async (transaction) => {
      source = await preparePublishingZeroEffectsStop(transaction, db, { ref, expectedRevision: 4 });
      source.commit();
    });
    records.set('durableJobCriticalRepairGrants/delete-job', {
      schemaVersion: 1,
      ...ref,
      generation: 1,
      workflowId: 'workflow',
      actorUid: 'admin',
      commandId: 'command',
      certificateId: '2'.repeat(64),
      intentFingerprint: digest(intent),
      operations: [source!.operation],
      sourceEvidenceDigests: [source!.sourceEvidenceDigest],
    });
    return source!;
  }
  return {
    records,
    db,
    tx,
    deps,
    granted,
    header,
    planId,
    sessionId,
    originalRoot,
    aggregatePath,
    artifactPath,
    referencePath,
    headerPath: `${SERMON_DELETION_MIRROR_PLANS}/${planId}`,
  };
}
test('zero-effect stop composes real opaque core abort and index abort in one transaction, preserving all content and artifacts', async () => {
  const f = fixture(),
    source = await f.granted(),
    root = f.records.get('sermons/sermon'),
    artifact = f.records.get(f.artifactPath),
    reference = f.records.get(f.referencePath),
    mirror = f.records.get('lists/list/listItems/row');
  const result = await runPublishingZeroEffectsStop(ref, source.operation, f.deps);
  expect(result).toMatchObject({
    state: 'completed',
    mode: 'partial_stop',
    providerEffects: 'not_started',
    contentPreserved: true,
  });
  expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${f.sessionId}`)).toMatchObject({
    state: 'aborted',
    effectsClosed: true,
    effectsClosedClaimSetDigestVersion: 2,
    effectsClosedActualRequestCount: 0,
    effectsClosedClaimSetDigest: providerMutationClaimSetSeed(f.sessionId),
    sourceZeroEffectsValidated: true,
  });
  expect(f.records.get(f.aggregatePath)).toMatchObject({ state: 'active', referenceCount: 2 });
  expect(f.records.get('temporalMediaState/sermon')).not.toHaveProperty('deletionParentRef');
  expect(f.records.has('temporalMediaDeletionEffects/delete-job')).toBe(false);
  expect(f.records.get('sermons/sermon')).toEqual(root);
  expect(f.records.get(f.artifactPath)).toEqual(artifact);
  expect(f.records.get(f.referencePath)).toEqual(reference);
  expect(f.records.get('lists/list/listItems/row')).toEqual(mirror);
  expect(f.records.get(f.headerPath)).toEqual(f.header);
  expect(f.records.get(`${PUBLISHING_ZERO_EFFECTS_STOPS}/${f.planId}`).state).toBe('stopped');
  expect(f.deps.authorizeInTransaction).toHaveBeenCalledTimes(1);
  await validatePublishingZeroEffectsStopEvidence(f.tx, f.db, ref, source.sourceEvidence);
  await expect(runPublishingZeroEffectsStop(ref, source.operation, f.deps)).resolves.toMatchObject({
    mode: 'partial_stop',
  });
});
test.each(['sending', 'unknown', 'acknowledged', 'acknowledged_unprojectable', 'rejected_no_effect'])(
  'ANY original %s request prevents a zero-effects certificate',
  async (state) => {
    const f = fixture();
    f.records.set(`${PROVIDER_MUTATION_SESSIONS}/${f.sessionId}/requests/claimed`, { state });
    await expect(f.granted()).rejects.toThrow();
    expect(f.records.get('sermons/sermon')).toEqual(f.originalRoot);
  }
);
test.each([
  'unsealed',
  'protocol',
  'root',
  'root-removal',
  'header-state',
  'running-media',
  'released-artifacts',
  'inactive-reference',
  'create-receipt',
  'unready-program',
])('rejects source gap %s before certificate or content writes', async (gap) => {
  const f = fixture();
  if (gap === 'unsealed') f.records.get(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/delete-job`).sealed = false;
  if (gap === 'protocol') f.records.get('durableJobIntents/delete-job').publishingSourceProtocol = 'legacy';
  if (gap === 'root') f.records.set('sermons/sermon', { ...f.originalRoot, title: 'Edited' });
  if (gap === 'root-removal') Object.assign(f.header, { rootRemoval: {} });
  if (gap === 'header-state') f.header.state = 'preparing';
  if (gap === 'running-media') f.records.get('temporalMediaState/sermon').runningRef = { jobId: 'media-job' };
  if (gap === 'released-artifacts')
    Object.assign(f.records.get('temporalMediaCanonicalRefs/sermon'), { deletionJobId: ref.jobId, releasedAt: 11 });
  if (gap === 'inactive-reference') f.records.get(f.referencePath).state = 'released';
  if (gap === 'create-receipt') f.records.set('temporalProviderReceipts/create', { ...ref, state: 'prepared' });
  if (gap === 'unready-program')
    f.records.get(`${ACKNOWLEDGED_PROJECTION_PLANS}/${f.sessionId}/requestIndex/request`).ready = false;
  await expect(f.granted()).rejects.toThrow();
  expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${f.sessionId}`).state).toBe('active');
});
test('fresh admin revocation prevents every stop write', async () => {
  const f = fixture(),
    source = await f.granted();
  f.deps.authorizeInTransaction.mockRejectedValueOnce(Error('admin revoked'));
  await expect(runPublishingZeroEffectsStop(ref, source.operation, f.deps)).rejects.toThrow('admin revoked');
  expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${f.sessionId}`).state).toBe('active');
  expect(f.records.get(f.aggregatePath).state).toBe('reserved');
  expect(f.records.has('temporalMediaDeletionEffects/delete-job')).toBe(true);
});
test('stale grant or changed provider identity cannot stop the original job', async () => {
  const f = fixture(),
    source = await f.granted();
  f.records.get('durableJobCriticalRepairGrants/delete-job').generation = 2;
  await expect(runPublishingZeroEffectsStop(ref, source.operation, f.deps)).rejects.toThrow();
  expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${f.sessionId}`).state).toBe('active');
});
test('a later different deletion owner is never cleared by an old stop certificate', async () => {
  const f = fixture(),
    source = await f.granted();
  f.records.get('temporalMediaState/sermon').deletionParentRef = { projectId: ref.projectId, jobId: 'other-delete' };
  await expect(runPublishingZeroEffectsStop(ref, source.operation, f.deps)).rejects.toThrow();
  expect(f.records.get('temporalMediaState/sermon').deletionParentRef.jobId).toBe('other-delete');
});
test('reservation failure rolls back core abort and media clearing together', async () => {
  const f = fixture(),
    source = await f.granted();
  f.records.get(f.aggregatePath).desiredDeletionProof.generation = 2;
  await expect(runPublishingZeroEffectsStop(ref, source.operation, f.deps)).rejects.toThrow();
  expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${f.sessionId}`).state).toBe('active');
  expect(f.records.get('temporalMediaState/sermon').deletionParentRef).toEqual(ref);
});
test('cancellation must be the exact certified cleanup intent', async () => {
  const f = fixture(),
    source = await f.granted();
  f.records.get('durableJobs/delete-job').state = 'cancel_requested';
  await expect(runPublishingZeroEffectsStop(ref, source.operation, f.deps)).rejects.toThrow();
  f.records.set('durableJobCancellationIntents/delete-job', {
    ...ref,
    generation: 1,
    workflowId: 'workflow',
    purpose: 'critical_repair_cleanup',
    certificateId: '2'.repeat(64),
  });
  await expect(runPublishingZeroEffectsStop(ref, source.operation, f.deps)).resolves.toMatchObject({
    mode: 'partial_stop',
  });
});
