import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
const mockEvents: string[] = [];
jest.mock('../../../../packages/orchestration/src/provider-usage', () => ({
  ...jest.requireActual('../../../../packages/orchestration/src/provider-usage'),
  prepareReviewedLegacySoundCloudRetentionBinding: jest.fn(async () => () => mockEvents.push('retain')),
}));
jest.mock('./providerMutationGuard', () => ({
  ...jest.requireActual('./providerMutationGuard'),
  validateProviderMutationOriginalCompletion: jest.fn(),
}));
import {
  prepareReviewedLegacySoundCloudRetentionBinding,
  PROVIDER_USAGE_CONTROL,
  PROVIDER_USAGE_COLLECTION,
  providerResourceKey,
  providerEdgeKey,
  desiredProviderDeletionDocumentFingerprint,
} from '../../../../packages/orchestration/src/provider-usage';
import { acknowledgedProjectionDigest } from './criticalAcknowledgedRepair';
import { sermonDeletionMirrorPlanId, SERMON_DELETION_MIRROR_PLANS } from '../../helpers/sermonDeletionMirrors';
import { runDurablePublishingOperation } from './durableOperationContext';
import { providerMutationFingerprint } from './providerMutationGuard';
import {
  prepareLegacySoundCloudInitialMissingObservation,
  prepareLegacySoundCloudRetention,
  prepareLegacySoundCloudRetentionProjection,
  LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS,
  LEGACY_SOUNDCLOUD_RETENTION_CERTIFICATES,
  validateLegacySoundCloudRetentionDisposition,
  readLegacySoundCloudRetentionStepAuthority,
} from './legacySoundCloudRetention';
const ref = { projectId: 'project', jobId: 'job' };
const field = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined,
      value
    );
function fixture() {
  const data = new Map<string, Record<string, unknown>>();
  const intent = {
    ...ref,
    kind: 'sermon.unpublish',
    generation: 1,
    entity: { type: 'sermon', id: 'sermon' },
    payload: {
      sermonId: 'sermon',
      generation: 1,
      action: 'unpublish',
      destinations: { soundcloud: true },
      payload: { sermon: { id: 'sermon', soundCloudTrackId: 'track' } },
    },
  };
  data.set('durableJobIntents/job', intent);
  data.set('durableJobs/job', { ...intent, workflowId: 'workflow', revision: 4, state: 'needs_attention' });
  data.set('sermons/sermon', {
    id: 'sermon',
    soundCloudTrackId: 'track',
    title: 'Preserve',
    status: { soundCloud: 'UPLOADED', subsplash: 'UPLOADED' },
  });
  const reference = (path: string): any => ({
    path,
    id: path.split('/').at(-1),
    collection: (name: string) => query(`${path}/${name}`),
  });
  const snapshot = (path: string): any => ({
    id: path.split('/').at(-1),
    ref: reference(path),
    exists: data.has(path),
    data: () => data.get(path),
    get: (name: string) => field(data.get(path), name),
  });
  const query = (path: string, filters: Array<[string, unknown]> = [], limit = Infinity, cursor = ''): any => ({
    path,
    doc: (id: string) => reference(`${path}/${id}`),
    where: (key: string, _op: string, value: unknown) => query(path, [...filters, [key, value]], limit, cursor),
    orderBy: () => query(path, filters, limit, cursor),
    limit: (value: number) => query(path, filters, value, cursor),
    startAfter: (last: { ref: { path: string } }) => query(path, filters, limit, last.ref.path),
    fetch: () => {
      const docs = [...data.keys()]
        .filter(
          (key) =>
            key.startsWith(`${path}/`) &&
            key.split('/').length === path.split('/').length + 1 &&
            key > cursor &&
            filters.every(([fieldPath, value]) => field(data.get(key), fieldPath) === value)
        )
        .sort()
        .slice(0, limit)
        .map(snapshot);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  const tx = {
    get: async (target: any) => (target.fetch ? target.fetch() : snapshot(target.path)),
    getAll: async (...targets: Array<{ path: string }>) => targets.map((target) => snapshot(target.path)),
    create: (target: { path: string }, value: Record<string, unknown>) => {
      mockEvents.push('create');
      data.set(target.path, value);
    },
    update: (target: { path: string }, value: Record<string, unknown>) => {
      mockEvents.push(target.path === 'sermons/sermon' ? 'detach' : 'update');
      const next = { ...data.get(target.path) };
      for (const [key, fieldValue] of Object.entries(value)) {
        if (fieldValue instanceof FieldValue && fieldValue.isEqual(FieldValue.delete())) delete next[key];
        else if (key === 'status.soundCloud')
          next.status = { ...(next.status as Record<string, unknown>), soundCloud: fieldValue };
        else next[key] = fieldValue;
      }
      data.set(target.path, next);
    },
  };
  const db = { doc: reference, collection: query };
  return { data, db: db as unknown as Firestore, tx: tx as unknown as Transaction };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.length = 0;
});
async function observed(f: ReturnType<typeof fixture>) {
  const observation = await runDurablePublishingOperation(
    'job',
    () =>
      prepareLegacySoundCloudInitialMissingObservation(f.tx, f.db, {
        ref,
        requestedTrackId: 'track',
        originalHttpStatus: 404,
        observedCurrentAccount: 'soundcloud:users:123',
      }),
    undefined,
    { getSourceStepIds: () => ['provider-write'] }
  );
  observation.commit();
  mockEvents.length = 0;
}
function grant(f: ReturnType<typeof fixture>, prepared: Awaited<ReturnType<typeof prepareLegacySoundCloudRetention>>) {
  f.data.set('durableJobCriticalRepairGrants/job', {
    schemaVersion: 1,
    ...ref,
    generation: prepared.certificate.generation,
    workflowId: prepared.certificate.workflowId,
    intentFingerprint: prepared.certificate.intentFingerprint,
    retentionAcknowledged: true,
    sourceCertificateIds: [prepared.certificateId],
    certificateId: 'c'.repeat(64),
    actorUid: 'admin',
    commandId: 'command',
    reason: 'Retain legacy remote resource without asserting ownership',
    evidenceReference: 'review:ticket',
    operations: [{ kind: 'legacy_soundcloud_retain', certificateId: prepared.certificateId }],
  });
}
it('source certificate is read-only, fixed-ID and never claims absence or original account ownership', async () => {
  const f = fixture();
  await observed(f);
  const prepared = await prepareLegacySoundCloudRetention(f.tx, f.db, { ref, expectedRevision: 4 });
  expect(mockEvents).toEqual([]);
  expect(prepared.certificate).toMatchObject({
    trackId: 'track',
    originalOwner: 'unverified',
    observedCurrentAccount: 'soundcloud:users:123',
    disposition: 'permanent_retention_without_absence_claim',
    resource: { provider: 'soundcloud', account: 'configured-account', remoteId: 'track' },
  });
  expect(JSON.stringify(prepared.certificate)).not.toMatch(/absenceConfirmed|acknowledged|DELETE/);
  prepared.commit();
  expect(f.data.has(`${LEGACY_SOUNDCLOUD_RETENTION_CERTIFICATES}/${prepared.digest}`)).toBe(true);
});
it('requires source-recorded original GET404 and refuses user-supplied unrelated IDs or accounts', async () => {
  const f = fixture();
  await expect(prepareLegacySoundCloudRetention(f.tx, f.db, { ref })).rejects.toThrow();
  await expect(
    prepareLegacySoundCloudInitialMissingObservation(f.tx, f.db, {
      ref,
      requestedTrackId: 'foreign',
      originalHttpStatus: 404,
      observedCurrentAccount: 'soundcloud:users:123',
    })
  ).rejects.toThrow();
  await expect(
    prepareLegacySoundCloudInitialMissingObservation(f.tx, f.db, {
      ref,
      requestedTrackId: 'track',
      originalHttpStatus: 404,
      observedCurrentAccount: 'foreign-account',
    })
  ).rejects.toThrow();
  await expect(
    prepareLegacySoundCloudInitialMissingObservation(f.tx, f.db, {
      ref,
      requestedTrackId: 'track',
      originalHttpStatus: 410 as 404,
      observedCurrentAccount: 'soundcloud:users:123',
    })
  ).rejects.toThrow();
});
it.each(['sending', 'unknown', 'acknowledged_unprojectable'])(
  'never overrides active mutable request %s',
  async (state) => {
    const f = fixture();
    const scope = { ...ref, operation: 'mutate' },
      sessionId = providerMutationFingerprint(scope);
    f.data.set(`temporalProviderMutationSessions/${sessionId}`, {
      schemaVersion: 1,
      scope,
      state: 'active',
      resources: [],
    });
    f.data.set(`temporalProviderMutationSessions/${sessionId}/requests/request`, {
      state,
      step: 'mutation',
      method: 'PATCH',
      fingerprint: 'f'.repeat(64),
    });
    await expect(observed(f)).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_UNSETTLED_RPC');
    expect(f.data.has(`${LEGACY_SOUNDCLOUD_RETENTION_OBSERVATIONS}/job`)).toBe(false);
  }
);
it('rejects original executing provider creation and previously bound SoundCloud deletion ownership', async () => {
  const f = fixture();
  f.data.set('temporalProviderReceipts/receipt', { ...ref, state: 'executing', step: 'soundcloud-track' });
  await expect(observed(f)).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_UNSETTLED_CREATE');
  f.data.delete('temporalProviderReceipts/receipt');
  f.data.set('temporalPublishingDeletionReceipts/deletion', { ...ref, provider: 'soundcloud' });
  await expect(observed(f)).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_ORIGINAL_OWNER_BOUND');
});
it('prepares permanent independent retention before local detachment inside fresh authorized commit', async () => {
  const f = fixture();
  await observed(f);
  const prepared = await prepareLegacySoundCloudRetention(f.tx, f.db, { ref });
  prepared.commit();
  grant(f, prepared);
  mockEvents.length = 0;
  const authorize = jest.fn(async () => {
    mockEvents.push('authorize');
  });
  const projection = await prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
    ref,
    certificateId: prepared.certificateId,
    authorize,
  });
  expect(mockEvents).toEqual(['authorize']);
  expect(prepareReviewedLegacySoundCloudRetentionBinding).toHaveBeenCalledWith(f.tx, f.db, {
    ref,
    certificateId: prepared.certificateId,
    resource: prepared.certificate.resource,
  });
  projection.commit();
  expect(mockEvents).toEqual(['authorize', 'retain', 'detach', 'create']);
  expect(f.data.get('sermons/sermon')?.title).toBe('Preserve');
  expect(f.data.get('sermons/sermon')?.soundCloudTrackId).toBeUndefined();
  expect(f.data.get('sermons/sermon')?.status).toEqual({ soundCloud: 'NOT_UPLOADED', subsplash: 'UPLOADED' });
});
it('blocks stale canonical identity or denied fresh administrator authority', async () => {
  const f = fixture();
  await observed(f);
  const prepared = await prepareLegacySoundCloudRetention(f.tx, f.db, { ref });
  prepared.commit();
  grant(f, prepared);
  mockEvents.length = 0;
  await expect(
    prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
      ref,
      certificateId: prepared.certificateId,
      authorize: async () => {
        throw Error('admin revoked');
      },
    })
  ).rejects.toThrow('admin revoked');
  expect(prepareReviewedLegacySoundCloudRetentionBinding).not.toHaveBeenCalled();
  f.data.set('sermons/sermon', { ...f.data.get('sermons/sermon'), soundCloudTrackId: 'changed' });
  await expect(
    prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
      ref,
      certificateId: prepared.certificateId,
      authorize: async () => {},
    })
  ).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_CANONICAL_CHANGED');
});

it('replays an already projected retention without recreating or detaching a newly changed resource', async () => {
  const f = fixture();
  await observed(f);
  const prepared = await prepareLegacySoundCloudRetention(f.tx, f.db, { ref });
  prepared.commit();
  grant(f, prepared);
  const first = await prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
    ref,
    certificateId: prepared.certificateId,
    authorize: async () => {},
  });
  first.commit();
  mockEvents.length = 0;
  const replay = await prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
    ref,
    certificateId: prepared.certificateId,
    authorize: async () => {},
  });
  replay.commit();
  expect(mockEvents).toEqual(['retain']);
  f.data.set('sermons/sermon', { ...f.data.get('sermons/sermon'), soundCloudTrackId: 'new-track' });
  await expect(
    prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
      ref,
      certificateId: prepared.certificateId,
      authorize: async () => {},
    })
  ).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_CANONICAL_CHANGED');
});

it('unrelated canonical edits do not invalidate the fixed SoundCloud identity certificate', async () => {
  const f = fixture();
  await observed(f);
  f.data.set('sermons/sermon', { ...f.data.get('sermons/sermon'), title: 'Updated unrelated title', numberOfLists: 8 });
  const prepared = await prepareLegacySoundCloudRetention(f.tx, f.db, { ref });
  prepared.commit();
  grant(f, prepared);
  const projection = await prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
    ref,
    certificateId: prepared.certificateId,
    authorize: async () => {},
  });
  projection.commit();
  expect(f.data.get('sermons/sermon')?.title).toBe('Updated unrelated title');
});
it('requires explicit current administrator retention acknowledgement and evidence in the atomic grant', async () => {
  const f = fixture();
  await observed(f);
  const prepared = await prepareLegacySoundCloudRetention(f.tx, f.db, { ref });
  prepared.commit();
  grant(f, prepared);
  f.data.set('durableJobCriticalRepairGrants/job', {
    ...f.data.get('durableJobCriticalRepairGrants/job'),
    retentionAcknowledged: false,
  });
  await expect(
    prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
      ref,
      certificateId: prepared.certificateId,
      authorize: async () => {},
    })
  ).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_OPERATOR_REVIEW_REQUIRED');
  expect(prepareReviewedLegacySoundCloudRetentionBinding).not.toHaveBeenCalled();
});
it('rejects a prior SDK allocation owner even when the current job has never sent a request', async () => {
  const f = fixture();
  f.data.set(`temporalPublishingAllocations/${providerMutationFingerprint(['project', 'sermon', 'soundcloud'])}`, {
    state: 'bound',
    remoteId: 'track',
    ownerJobId: 'previous',
  });
  await expect(observed(f)).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_ORIGINAL_OWNER_BOUND');
});

it('allows cancel_requested only through the explicit matching administrator critical-cleanup grant', async () => {
  const f = fixture();
  await observed(f);
  const prepared = await prepareLegacySoundCloudRetention(f.tx, f.db, { ref });
  prepared.commit();
  grant(f, prepared);
  f.data.set('durableJobs/job', { ...f.data.get('durableJobs/job'), state: 'cancel_requested' });
  await expect(prepareLegacySoundCloudRetention(f.tx, f.db, { ref })).rejects.toThrow();
  await expect(
    prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
      ref,
      certificateId: prepared.certificateId,
      authorize: async () => {},
    })
  ).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_REVIEWED_CLEANUP_REQUIRED');
  f.data.set('durableJobCancellationIntents/job', {
    ...ref,
    generation: 1,
    workflowId: 'workflow',
    purpose: 'user_cancellation',
    certificateId: 'c'.repeat(64),
  });
  await expect(
    prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
      ref,
      certificateId: prepared.certificateId,
      authorize: async () => {},
    })
  ).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_REVIEWED_CLEANUP_REQUIRED');
  f.data.set('durableJobCancellationIntents/job', {
    ...f.data.get('durableJobCancellationIntents/job'),
    purpose: 'critical_repair_cleanup',
  });
  const allowed = await prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
    ref,
    certificateId: prepared.certificateId,
    authorize: async () => {},
  });
  allowed.commit();
  expect(f.data.get('sermons/sermon')?.soundCloudTrackId).toBeUndefined();
});
it('refuses an actual SoundCloud send even if its original response is known', async () => {
  const f = fixture(),
    scope = { ...ref, operation: 'mutate' },
    sessionId = providerMutationFingerprint(scope),
    step = 'soundcloud-metadata',
    fingerprint = 'f'.repeat(64);
  f.data.set(`temporalProviderMutationSessions/${sessionId}`, {
    schemaVersion: 1,
    scope,
    state: 'active',
    resources: [],
  });
  f.data.set(`temporalProviderMutationSessions/${sessionId}/requests/request`, {
    state: 'acknowledged',
    step,
    method: 'PUT',
    fingerprint,
  });
  f.data.set(
    `temporalPublishingAcknowledgedProjections/${sessionId}/requestIndex/${providerMutationFingerprint(step)}`,
    { request: { step, method: 'PUT', fingerprint, target: { provider: 'soundcloud', resourceId: 'track' } } }
  );
  await expect(observed(f)).rejects.toThrow('LEGACY_SOUNDCLOUD_RETENTION_PROVIDER_REQUEST_ALREADY_SENT');
});

async function retainedFixture(deleting = false) {
  const f = fixture();
  if (deleting) {
    const intent = {
      ...f.data.get('durableJobIntents/job'),
      kind: 'sermon.delete',
      payload: {
        sermonId: 'sermon',
        generation: 1,
        action: 'delete',
        payload: { sermon: { id: 'sermon', soundCloudTrackId: 'track' } },
      },
    };
    f.data.set('durableJobIntents/job', intent);
    f.data.set('durableJobs/job', { ...f.data.get('durableJobs/job'), kind: 'sermon.delete' });
  }
  const originalRoot = { ...f.data.get('sermons/sermon') };
  if (deleting) {
    const planId = sermonDeletionMirrorPlanId(ref, 'sermon');
    f.data.set(`${SERMON_DELETION_MIRROR_PLANS}/${planId}`, {
      schemaVersion: 1,
      ...ref,
      planId,
      sermonId: 'sermon',
      generation: 1,
      workflowId: 'workflow',
      sourceStepIds: ['provider-write'],
      sourceParentRef: ref,
      intentFingerprint: desiredProviderDeletionDocumentFingerprint(f.data.get('durableJobIntents/job')),
      originalRoot,
      originalRootDigest: acknowledgedProjectionDigest(originalRoot),
      requests: [],
      verifications: [],
    });
  }
  await observed(f);
  const prepared = await prepareLegacySoundCloudRetention(f.tx, f.db, { ref });
  prepared.commit();
  grant(f, prepared);
  (
    await prepareLegacySoundCloudRetentionProjection(f.tx, f.db, {
      ref,
      certificateId: prepared.certificateId,
      authorize: async () => {},
    })
  ).commit();
  f.data.set(PROVIDER_USAGE_CONTROL, { schemaVersion: 1, projectId: 'project', epoch: 'epoch', status: 'ready' });
  const resource = prepared.certificate.resource,
    aggregate = `${PROVIDER_USAGE_COLLECTION}/${providerResourceKey(resource)}/epochs/epoch`;
  const canonicalPath = `providerBindings/retention:${prepared.certificateId}/permanent-legacy-soundcloud`,
    edge = `${aggregate}/edges/${providerEdgeKey(canonicalPath)}`;
  f.data.set(aggregate, { ...resource, epoch: 'epoch', referenceCount: 1, state: 'active' });
  f.data.set(edge, {
    projectId: 'project',
    canonicalPath,
    jobId: `retention:${prepared.certificateId}`,
    bindingId: 'permanent-legacy-soundcloud',
    state: 'pending_effect',
  });
  return { ...f, prepared, aggregate, edge, originalRoot };
}
it('only reviewed permanent retention qualifies no-send source evidence and proof remains stable with other references', async () => {
  const f = await retainedFixture(),
    proof = await validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref, trackId: 'track' });
  expect(proof).toEqual({
    certificateId: f.prepared.certificateId,
    sealedProofDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  f.data.set(f.aggregate, { ...f.data.get(f.aggregate), referenceCount: 12 });
  expect(await validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref, trackId: 'track' })).toEqual(proof);
  expect(await validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref, trackId: 'unrelated' })).toBeUndefined();
});
it('GET404 alone is not retention disposition evidence', async () => {
  const f = fixture();
  await observed(f);
  expect(await validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref, trackId: 'track' })).toBeUndefined();
});
it.each(['missing edge', 'revoked acknowledgement', 'missing root', 'unknown send'])(
  'does not qualify retained source with %s',
  async (mode) => {
    const f = await retainedFixture();
    if (mode === 'missing edge') f.data.delete(f.edge);
    if (mode === 'revoked acknowledgement')
      f.data.set('durableJobCriticalRepairGrants/job', {
        ...f.data.get('durableJobCriticalRepairGrants/job'),
        retentionAcknowledged: false,
      });
    if (mode === 'missing root') f.data.delete('sermons/sermon');
    if (mode === 'unknown send') {
      const scope = { ...ref, operation: 'mutate' },
        sessionId = providerMutationFingerprint(scope);
      f.data.set(`temporalProviderMutationSessions/${sessionId}`, { scope, state: 'active', resources: [] });
      f.data.set(`temporalProviderMutationSessions/${sessionId}/requests/request`, { state: 'unknown' });
    }
    await expect(validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref, trackId: 'track' })).rejects.toThrow();
  }
);

it('qualifies missing-root continuation only with the original captured root checkpoint', async () => {
  const f = await retainedFixture(true),
    proof = await validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref, trackId: 'track' });
  const planId = sermonDeletionMirrorPlanId(ref, 'sermon'),
    intentFingerprint = desiredProviderDeletionDocumentFingerprint(f.data.get('durableJobIntents/job'));
  const pointerCleared = {
    ...f.originalRoot,
    status: { ...(f.originalRoot.status as object), soundCloud: 'NOT_UPLOADED' },
  } as Record<string, unknown>;
  delete pointerCleared.soundCloudTrackId;
  const rootSourceDigest = acknowledgedProjectionDigest(pointerCleared);
  f.data.set(`${SERMON_DELETION_MIRROR_PLANS}/${planId}`, {
    schemaVersion: 1,
    ...ref,
    planId,
    sermonId: 'sermon',
    generation: 1,
    workflowId: 'workflow',
    state: 'root_removed',
    intentFingerprint,
    originalRoot: f.originalRoot,
    originalRootDigest: acknowledgedProjectionDigest(f.originalRoot),
    pointerClearRootDigest: rootSourceDigest,
    requests: [{ target: { provider: 'soundcloud' } }],
    rootRemoval: {
      schemaVersion: 1,
      generation: 1,
      workflowId: 'workflow',
      intentFingerprint,
      rootSourceDigest,
      originalEvidenceDigest: 'e'.repeat(64),
    },
  });
  f.data.delete('sermons/sermon');
  expect(await validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref, trackId: 'track' })).toEqual(proof);
  const path = `${SERMON_DELETION_MIRROR_PLANS}/${planId}`;
  f.data.set(path, {
    ...f.data.get(path),
    rootRemoval: { ...(f.data.get(path)?.rootRemoval as object), rootSourceDigest: 'f'.repeat(64) },
  });
  await expect(validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref, trackId: 'track' })).rejects.toThrow();
});

it('retention step authority comes only from the original observed SDK parent and pinned delete header', async () => {
  const f = await retainedFixture(true),
    certificate = f.prepared.certificate;
  expect(await readLegacySoundCloudRetentionStepAuthority(f.tx, f.db, ref, certificate)).toEqual({
    sourceParentRef: ref,
    sourceStepIds: ['provider-write'],
  });
  const path = certificate.mirrorStepEvidence!.path;
  f.data.set(path, { ...f.data.get(path), sourceStepIds: ['unrecorded-new-step'] });
  await expect(readLegacySoundCloudRetentionStepAuthority(f.tx, f.db, ref, certificate)).rejects.toThrow();
});
it('retention disposition ignores mutable additional caller header fields when hashing exact parent reference', async () => {
  const f = await retainedFixture(),
    expandedRef = { ...ref, state: 'prepared', cursor: 0 };
  const before = await validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref: expandedRef, trackId: 'track' });
  expandedRef.state = 'completed';
  expandedRef.cursor = 42;
  expect(
    await validateLegacySoundCloudRetentionDisposition(f.tx, f.db, { ref: expandedRef, trackId: 'track' })
  ).toEqual(before);
});
