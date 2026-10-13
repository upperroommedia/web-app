jest.mock('../temporal/publishing/criticalAcknowledgedRepair', () => ({
  ...jest.requireActual('../temporal/publishing/criticalAcknowledgedRepair'),
  assertAcknowledgedRepairCandidateVerificationSeal: jest.fn(),
}));
jest.mock('../temporal/publishing/providerMutationGuard', () => ({
  ...jest.requireActual('../temporal/publishing/providerMutationGuard'),
  prepareProviderMutationEffectsClosedFromReadyEvidence: jest.fn(),
}));
jest.mock('./sermonDeletionDestinations', () => ({
  readSermonDeletionDestinationProgramInTransaction: jest.fn(),
  validateSermonDeletionDestinationCompletion: jest.fn(),
}));
jest.mock('../temporal/publishing/legacySoundCloudRetention', () => ({
  validateLegacySoundCloudRetentionDisposition: jest.fn(async () => undefined),
}));
import { createHash } from 'node:crypto';
jest.mock('./seriesHelpers', () => ({
  getSeriesSubtitleFromPublishedCount: (count: number) => `${count} part series`,
}));
jest.mock('../temporal/publishing/durableOperationContext', () => ({
  ...jest.requireActual('../temporal/publishing/durableOperationContext'),
  getDurablePublishingJobId: () => 'job',
  getPublishingSourceStepIds: () => ['delete-providers'],
  getPublishingMutationOperation: () => 'delete-providers',
  isCriticalPublishingRepair: () => false,
  runDurableTransaction: (db: { runTransaction: (fn: unknown) => Promise<unknown> }, fn: unknown) =>
    mockUseRealDurableTransaction
      ? jest.requireActual('../temporal/publishing/durableOperationContext').runDurableTransaction(db, fn)
      : db.runTransaction(fn),
  prepareAcknowledgedProjectionPlan: async (_tx: unknown, plan: unknown) => ({
    projectionDigest: 'digest',
    commit: () => mockPrograms.push(plan),
  }),
}));
import type { Firestore } from 'firebase-admin/firestore';
import type { DurableActivityExecution, DurableJobIntent } from '@upperroom/orchestration/job-store';
import {
  prepareSermonDeletionMirrors,
  readSermonDeletionCertifiedSourceHeaderInTransaction,
  validateSermonDeletionCertifiedEffectsForClosing,
  assertSermonDeletionCountReadInTransaction,
  validateSermonDeletionCompletion,
  validateSermonDeletionEffectsForClosing,
  loadSermonDeletionMirrorPlan,
  sermonDeletionMirrorPlanId,
  readSermonDeletionRootMutationTargetsPage,
  readSermonDeletionCanonicalInventoryPage,
  validateSermonDeletionCanonicalInventoryPage,
  readSermonDeletionCanonicalCompletionSummary,
  removeSermonDeletionMirrors,
  validateDeletedSermonCleanup,
  prepareSermonRootRemovalCheckpointFromAcknowledgedRepair,
  SERMON_DELETION_MIRROR_PLANS,
} from './sermonDeletionMirrors';
import {
  prepareProviderMutationEffectsClosedFromReadyEvidence,
  providerMutationFingerprint as hash,
} from '../temporal/publishing/providerMutationGuard';
import {
  assertAcknowledgedRepairCandidateVerificationSeal,
  acknowledgedProjectionDigest,
} from '../temporal/publishing/criticalAcknowledgedRepair';
import {
  readSermonDeletionDestinationProgramInTransaction,
  validateSermonDeletionDestinationCompletion,
} from './sermonDeletionDestinations';
import { validateLegacySoundCloudRetentionDisposition } from '../temporal/publishing/legacySoundCloudRetention';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import type {
  FrozenProjectionRequest,
  FrozenProviderVerification,
} from '../temporal/publishing/criticalAcknowledgedRepair';
let mockUseRealDurableTransaction = false;
let mockPrograms: any[] = [];
const ref = { projectId: 'test-project', jobId: 'job' };
function fixture(remote = false) {
  const clone = (value: any) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const store = new Map<string, Record<string, any>>(),
    deletions: string[][] = [];
  const getField = (data: any, field: string) => field.split('.').reduce((value, key) => value?.[key], data);
  const doc = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    collection: (name: string) => query(`${path}/${name}`),
    get: async () => snapshot(path),
  });
  const snapshot = (path: string): any => ({
    id: path.split('/').pop(),
    ref: doc(path),
    exists: store.has(path),
    data: () => clone(store.get(path)),
    get: (field: string) => getField(store.get(path), field),
  });
  const query = (
    path: string,
    group = false,
    predicates: Array<[string, string, unknown]> = [],
    cursor = '',
    limit = Infinity,
    count = false
  ): any => ({
    _query: true,
    doc: (id: string) => doc(`${path}/${id}`),
    where: (field: string, op: string, value: unknown) =>
      query(path, group, [...predicates, [field, op, value]], cursor, limit, count),
    orderBy: () => query(path, group, predicates, cursor, limit, count),
    limit: (size: number) => query(path, group, predicates, cursor, size, count),
    startAfter: (snapshot: any) =>
      query(
        path,
        group,
        predicates,
        typeof snapshot === 'string' ? `${path}/${snapshot}` : snapshot.ref.path,
        limit,
        count
      ),
    count: () => query(path, group, predicates, cursor, limit, true),
    get: async () => {
      const paths = [...store.keys()]
        .filter((key) => {
          const parts = key.split('/');
          return (
            (group
              ? parts[parts.length - 2] === path
              : key.startsWith(`${path}/`) && parts.length === path.split('/').length + 1) &&
            key > cursor &&
            predicates.every(([field, op, value]) =>
              op === 'in'
                ? (value as unknown[]).includes(getField(store.get(key), field))
                : getField(store.get(key), field) === value
            )
          );
        })
        .sort()
        .slice(0, limit);
      return count
        ? { data: () => ({ count: paths.length }) }
        : { docs: paths.map(snapshot), size: paths.length, empty: !paths.length };
    },
  });
  const db = {
    doc,
    collection: (name: string) => query(name),
    collectionGroup: (name: string) => query(name, true),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const writes: Array<() => void> = [],
        deleted: string[] = [];
      let writing = false;
      const tx = {
        get: async (ref: any) => {
          if (writing) throw Error('read after write');
          return ref._query ? ref.get() : snapshot(ref.path);
        },
        getAll: async (...refs: any[]) => {
          if (writing) throw Error('read after write');
          return refs.map((ref) => snapshot(ref.path));
        },
        create: (ref: any, data: any) => {
          writing = true;
          writes.push(() => {
            if (store.has(ref.path)) throw Error('already exists');
            store.set(ref.path, clone(data));
          });
        },
        set: (ref: any, data: any, options?: { merge?: boolean }) => {
          writing = true;
          writes.push(() =>
            store.set(ref.path, options?.merge ? { ...store.get(ref.path), ...clone(data) } : clone(data))
          );
        },
        update: (ref: any, data: any) => {
          writing = true;
          writes.push(() => store.set(ref.path, { ...store.get(ref.path), ...clone(data) }));
        },
        delete: (ref: any) => {
          writing = true;
          deleted.push(ref.path);
          writes.push(() => store.delete(ref.path));
        },
      };
      const result = await fn(tx);
      writes.forEach((write) => write());
      if (deleted.length) deletions.push(deleted);
      return result;
    },
  } as unknown as Firestore;
  const root = {
    id: 'sermon',
    title: 'Original',
    uploaderId: 'uploader',
    status: { subsplash: uploadStatus.UPLOADED },
    ...(remote ? { subsplashId: 'media' } : {}),
  };
  const intent: DurableJobIntent<unknown> = {
    schemaVersion: 1,
    ...ref,
    kind: 'sermon.delete',
    entity: { type: 'sermon', id: 'sermon' },
    actorUid: 'publisher',
    generation: 1,
    createdAt: 1,
    payload: {
      sermonId: 'sermon',
      action: 'delete',
      generation: 1,
      payload: { sermon: root },
      destinations: { listIds: [], soundcloud: false },
    },
  };
  store.set('sermons/sermon', root);
  store.set('durableJobIntents/job', intent);
  store.set('durableJobs/job', { ...intent, state: 'running', workflowId: 'workflow' });
  const target = { provider: 'subsplash' as const, account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media' },
    payload = { id: 'media' };
  const request: FrozenProjectionRequest = {
    step: 'delete:subsplash:media',
    method: 'DELETE',
    target,
    payload,
    fingerprint: hash(['DELETE', { target, body: payload }]),
  };
  const verification: FrozenProviderVerification = {
    ...target,
    resourceType: 'media',
    expectedState: 'absent',
    expectedProviderFields: {},
  };
  const input = {
    ref,
    sermonId: 'sermon',
    operation: 'delete-providers',
    requests: remote ? [request] : [],
    verifications: remote ? [verification] : [],
  };
  const original = (state = 'committed') => {
    const scope = { ...ref, operation: 'delete-providers' },
      sessionId = hash(scope);
    store.set(`temporalProviderMutationSessions/${sessionId}`, { state, scope, resources: [target] });
    store.set(`temporalProviderMutationSessions/${sessionId}/requests/${hash(request.step)}`, {
      step: request.step,
      method: 'DELETE',
      fingerprint: request.fingerprint,
      state: 'acknowledged',
      claim: 'claim',
      executionId: 'exec',
      result: null,
    });
    store.set(`temporalProviderMutationFacts/${hash([sessionId, request.step, 'claim'])}`, {
      sessionId,
      step: request.step,
      fingerprint: request.fingerprint,
      claim: 'claim',
      executionId: 'exec',
      completion: 'acknowledged',
      result: null,
    });
    const journalId = createHash('sha256')
      .update(JSON.stringify([ref.projectId, ref.jobId, 'subsplash', 'media']))
      .digest('hex');
    store.set(`temporalPublishingDeletionReceipts/${journalId}`, {
      ...ref,
      sermonId: 'sermon',
      provider: 'subsplash',
      remoteId: 'media',
      originalAccount: 'app:9XTSHD',
      state: 'absence_confirmed',
      absenceProof: 'authenticated_fixed_id_get_404_410',
      ownershipConfirmedBeforeDelete: true,
    });
    return sessionId;
  };
  return { db, store, deletions, intent, input, request, original };
}
const proof = { assertOriginalProviderEffects: async () => {} };
beforeEach(() => {
  mockPrograms = [];
  mockUseRealDurableTransaction = false;
  jest.mocked(assertAcknowledgedRepairCandidateVerificationSeal).mockReset();
  jest.mocked(prepareProviderMutationEffectsClosedFromReadyEvidence).mockReset();
  jest.mocked(readSermonDeletionDestinationProgramInTransaction).mockReset();
  jest.mocked(validateSermonDeletionDestinationCompletion).mockReset();
  jest.mocked(validateLegacySoundCloudRetentionDisposition).mockReset().mockResolvedValue(undefined);
});
test('605 memberships and missing-field mirror caches capture completely without deleting before provider effects', async () => {
  const f = fixture();
  for (let i = 0; i < 605; i++) {
    f.store.set(`sermons/sermon/sermonLists/l${i}`, {});
    f.store.set(`lists/l${i}/listItems/sermon`, {});
  }
  f.store.set('lists/foreign/listItems/other', { id: 'sermon' });
  f.store.set('tenants/t/listItems/sermon', { id: 'sermon' });
  const plan = await prepareSermonDeletionMirrors(f.db, f.input);
  expect(
    [...f.store.keys()].filter((path) => path.startsWith(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}/rows/`))
  ).toHaveLength(1210);
  expect(f.deletions).toHaveLength(0);
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(f.deletions[0]).toEqual(['sermons/sermon']);
  expect(f.deletions.slice(1).every((chunk) => chunk.length <= 64)).toBe(true);
  expect(f.store.has('lists/foreign/listItems/other')).toBe(true);
  expect(f.store.has('tenants/t/listItems/sermon')).toBe(true);
});
test('published physical count is preserved; local and series counters derive actual surviving rows', async () => {
  const f = fixture();
  f.store.set('lists/local', { count: 99 });
  f.store.set('lists/local/listItems/sermon', {});
  f.store.set('lists/local/listItems/other', {});
  f.store.set('lists/published', { subsplashId: 'remote-list', count: 7, logicalCount: 7 });
  f.store.set('lists/published/listItems/sermon', { uploadStatus: { status: uploadStatus.NOT_UPLOADED } });
  f.store.set('series/series', { itemCount: 99, publishedItemCount: 88 });
  f.store.set('series/series/seriesItems/sermon', { publishedToSubsplash: true });
  f.store.set('series/series/seriesItems/other', { publishedToSubsplash: true });
  f.store.set('series/series/seriesItems/draft', { publishedToSubsplash: false });
  const plan = await prepareSermonDeletionMirrors(f.db, f.input);
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(f.store.get('lists/local')?.count).toBe(1);
  expect(f.store.get('lists/published')).toMatchObject({ count: 7, logicalCount: 7 });
  expect(f.store.get('series/series')).toMatchObject({
    itemCount: 2,
    publishedItemCount: 1,
    subtitle: '1 part series',
  });
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(f.store.get('series/series')?.itemCount).toBe(2);
});
test('root source accepts only exact original ACK provider pointer clearing and no other metadata edits', async () => {
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input);
  f.original();
  f.store.set('sermons/sermon', {
    id: 'sermon',
    title: 'Changed',
    uploaderId: 'uploader',
    status: { subsplash: uploadStatus.NOT_UPLOADED },
  });
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow('PROOF_INVALID');
  expect(f.store.has('sermons/sermon')).toBe(true);
  f.store.get('sermons/sermon')!.title = 'Original';
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(f.store.has('sermons/sermon')).toBe(false);
});
test('root first frozen fragment and every complete 64-row source page precede final request seal', async () => {
  const f = fixture(true);
  for (let i = 0; i < 605; i++) f.store.set(`lists/l${i}/listItems/sermon`, {});
  await prepareSermonDeletionMirrors(f.db, f.input);
  expect(mockPrograms[0].writes.map((write: any) => write.path)).toEqual(['sermons/sermon']);
  expect(mockPrograms[1].writes.map((write: any) => write.path)).toEqual(['sermons/sermon']);
  expect(mockPrograms[1].writes[0].expectedDocumentDigest).not.toBe(mockPrograms[0].writes[0].expectedDocumentDigest);
  expect(
    mockPrograms.slice(1, -1).every((program) => program.writes.length <= 64 && program.finalFragment === false)
  ).toBe(true);
  expect(mockPrograms.at(-1)).toMatchObject({ writes: [], finalFragment: true });
});
test('GET-like flag or unknown executing claim never replaces original DELETE completion', async () => {
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input);
  const id = f.original('active');
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow('PROOF_INVALID');
  f.store.get(`temporalProviderMutationSessions/${id}`)!.state = 'committed';
  f.store.get(`temporalProviderMutationSessions/${id}/requests/${hash(f.request.step)}`)!.state = 'unknown';
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow();
  expect(f.store.has('sermons/sermon')).toBe(true);
});
test('missing root authorizes only exact workflow/generation frozen cleanup activities', async () => {
  const f = fixture(),
    plan = await prepareSermonDeletionMirrors(f.db, f.input);
  await removeSermonDeletionMirrors(f.db, plan, proof);
  const execution: DurableActivityExecution = {
    workflowId: 'workflow',
    runId: 'run',
    activityId: 'activity',
    activityType: 'commitPublishingProjection',
    scheduledAt: 1,
    attempt: 1,
  };
  await expect(validateDeletedSermonCleanup(f.db, f.intent, execution)).resolves.toEqual({ uploaderId: 'uploader' });
  await expect(
    validateDeletedSermonCleanup(f.db, f.intent, { ...execution, activityType: 'deletePublishingProviders' })
  ).rejects.toThrow('PROOF_INVALID');
  await expect(validateDeletedSermonCleanup(f.db, f.intent, { ...execution, workflowId: 'other' })).rejects.toThrow(
    'PROOF_INVALID'
  );
});
test('ACK repair records root checkpoint atomically before root deletion while original session remains held', async () => {
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  const frozen = { schemaVersion: 2, projectId: ref.projectId, jobId: ref.jobId, sessionId };
  f.store.set(`temporalPublishingAcknowledgedProjections/${sessionId}`, frozen);
  f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!.frozenProgramDigest =
    acknowledgedProjectionDigest(frozen);
  await f.db.runTransaction(async (tx) => {
    const commit = await prepareSermonRootRemovalCheckpointFromAcknowledgedRepair(tx, f.db, {
      ref,
      sessionId,
      sermonId: 'sermon',
      projectionDigest: acknowledgedProjectionDigest(frozen),
      requests: [f.request],
      acknowledgedSteps: [f.request.step],
    });
    commit();
    tx.delete(f.db.doc('sermons/sermon'));
  });
  f.store.get(`temporalProviderMutationSessions/${sessionId}`)!.state = 'committed';
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)?.state).toBe('completed');
});

test('observed absence without original namespace ownership never permits canonical removal', async () => {
  const f = fixture(true);
  const plan = await prepareSermonDeletionMirrors(f.db, f.input);
  const scope = { ...ref, operation: 'delete-providers' };
  const sessionId = hash(scope);
  f.store.set(`temporalProviderMutationSessions/${sessionId}`, {
    state: 'committed',
    scope,
    resources: [f.request.target],
  });
  const { createHash } = await import('node:crypto');
  const journalId = createHash('sha256')
    .update(JSON.stringify([ref.projectId, ref.jobId, 'subsplash', 'media']))
    .digest('hex');
  const path = `temporalPublishingDeletionReceipts/${journalId}`;
  f.store.set(path, {
    ...ref,
    sermonId: 'sermon',
    provider: 'subsplash',
    remoteId: 'media',
    originalAccount: 'app:9XTSHD',
    state: 'absence_confirmed',
    absenceProof: 'authenticated_fixed_id_get_404_410',
  });
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow('PROOF_INVALID');
  expect(f.store.has('sermons/sermon')).toBe(true);
  f.store.get(path)!.ownershipConfirmedBeforeDelete = true;
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(f.store.has('sermons/sermon')).toBe(false);
});

function installSealedProgram(f: ReturnType<typeof fixture>, plan: { planId: string }, sessionId: string) {
  const intentFingerprint = acknowledgedProjectionDigest(f.intent),
    page = {
      schemaVersion: 1,
      ...ref,
      sessionId,
      operation: 'delete-providers',
      intentFingerprint,
      requests: [f.request],
      writes: [],
      verifications: [f.input.verifications[0]],
      finalFragment: true,
      completesActivity: false,
    };
  const pageDigest = acknowledgedProjectionDigest(page),
    root = {
      schemaVersion: 2,
      ...ref,
      sessionId,
      operation: 'delete-providers',
      intentFingerprint,
      pageCount: 1,
      requestCount: 1,
      chainDigest: acknowledgedProjectionDigest([pageDigest]),
      completesActivity: false,
      uiStepIds: [],
    };
  f.store.set(`temporalPublishingAcknowledgedProjections/${sessionId}`, root);
  f.store.set(`temporalPublishingAcknowledgedProjections/${sessionId}/pages/${pageDigest}`, page);
  f.store.set(`temporalPublishingAcknowledgedProjections/${sessionId}/requestIndex/${hash(f.request.step)}`, {
    request: f.request,
    intentFingerprint,
    pageDigest,
    readyPageDigest: pageDigest,
    ready: true,
  });
  f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!.frozenProgramDigest =
    acknowledgedProjectionDigest(root);
}

test('effects close validates the sealed full source program and holds active session through root-first cleanup', async () => {
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  installSealedProgram(f, plan, sessionId);
  const closing = await f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan));
  expect(closing).toMatchObject({ expectedRequestSteps: [f.request.step], qualifiedNoSendSteps: [] });
  const session = f.store.get(`temporalProviderMutationSessions/${sessionId}`)!;
  session.effectsClosed = true;
  session.effectsClosedSourceProgramDigest = closing.sourceProgramDigest;
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(session.state).toBe('active');
  expect(f.store.has('sermons/sermon')).toBe(false);
  await expect(loadSermonDeletionMirrorPlan(f.db, ref, 'sermon')).resolves.toEqual(plan);
  await expect(
    validateDeletedSermonCleanup(f.db, f.intent, {
      workflowId: 'workflow',
      runId: 'run',
      activityId: 'activity',
      activityType: 'releasePublishingAudio',
      scheduledAt: 1,
      attempt: 1,
    })
  ).resolves.toEqual({ uploaderId: 'uploader' });
});

test('effects close rejects unknown claims and an unsealed or changed source program', async () => {
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  installSealedProgram(f, plan, sessionId);
  const request = f.store.get(`temporalProviderMutationSessions/${sessionId}/requests/${hash(f.request.step)}`)!;
  request.state = 'unknown';
  await expect(f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan))).rejects.toThrow();
  request.state = 'acknowledged';
  const index = f.store.get(
    `temporalPublishingAcknowledgedProjections/${sessionId}/requestIndex/${hash(f.request.step)}`
  )!;
  index.ready = false;
  await expect(f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan))).rejects.toThrow();
  index.ready = true;
  f.store.get(`temporalPublishingAcknowledgedProjections/${sessionId}`)!.pageCount = 2;
  await expect(f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan))).rejects.toThrow();
});

test('effects close qualifies owned no-send only from exact immutable scoped namespace checkpoint', async () => {
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  installSealedProgram(f, plan, sessionId);
  f.store.delete(`temporalProviderMutationSessions/${sessionId}/requests/${hash(f.request.step)}`);
  const { createHash } = await import('node:crypto');
  const journalId = createHash('sha256')
    .update(JSON.stringify([ref.projectId, ref.jobId, 'subsplash', 'media']))
    .digest('hex');
  const journal = {
    ...ref,
    sermonId: 'sermon',
    provider: 'subsplash',
    remoteId: 'media',
    originalAccount: 'app:9XTSHD',
    state: 'absence_confirmed',
    absenceProof: 'authenticated_fixed_id_get_404_410',
    ownershipConfirmedBeforeDelete: false,
  };
  f.store.set(`temporalPublishingDeletionReceipts/${journalId}`, journal);
  await expect(f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan))).rejects.toThrow();
  journal.ownershipConfirmedBeforeDelete = true;
  await expect(
    f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan))
  ).resolves.toMatchObject({ expectedRequestSteps: [f.request.step], qualifiedNoSendSteps: [f.request.step] });
  journal.originalAccount = 'app:foreign';
  await expect(f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan))).rejects.toThrow();
});

test('original positive DELETE ACK requires exact owned fixed absence proof before effects close or root removal', async () => {
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original();
  installSealedProgram(f, plan, sessionId);
  const journalId = createHash('sha256')
      .update(JSON.stringify([ref.projectId, ref.jobId, 'subsplash', 'media']))
      .digest('hex'),
    path = `temporalPublishingDeletionReceipts/${journalId}`,
    journal = f.store.get(path)!;
  f.store.delete(path);
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow();
  await expect(f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan))).rejects.toThrow();
  f.store.set(path, { ...journal, originalAccount: 'app:foreign' });
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow();
  f.store.set(path, journal);
  await removeSermonDeletionMirrors(f.db, plan, proof);
  journal.updatedAtMillis = 123;
  journal.bookkeepingPhase = 'later';
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).resolves.toBeUndefined();
});

test('legacy SoundCloud no-send requires explicit sealed retention instead of a current-account missing response', async () => {
  const f = fixture(),
    root = f.store.get('sermons/sermon')!;
  root.soundCloudTrackId = 'legacy-track';
  root.status.soundCloud = uploadStatus.UPLOADED;
  const target = {
      provider: 'soundcloud' as const,
      account: 'soundcloud:users:123',
      resourceType: 'track',
      resourceId: 'legacy-track',
    },
    payload = { id: 'legacy-track' };
  const request: FrozenProjectionRequest = {
    step: 'delete:soundcloud:legacy-track',
    method: 'DELETE',
    target,
    payload,
    fingerprint: hash(['DELETE', { target, body: payload }]),
  };
  const verification: FrozenProviderVerification = {
    ...target,
    resourceType: 'track',
    expectedState: 'absent',
    expectedProviderFields: {},
  };
  const input = { ...f.input, requests: [request], verifications: [verification] },
    plan = await prepareSermonDeletionMirrors(f.db, input),
    scope = { ...ref, operation: 'delete-providers' },
    sessionId = hash(scope);
  f.store.set(`temporalProviderMutationSessions/${sessionId}`, { state: 'active', scope, resources: [target] });
  installSealedProgram({ ...f, request, input } as unknown as ReturnType<typeof fixture>, plan, sessionId);
  await expect(f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan))).rejects.toThrow();
  jest
    .mocked(validateLegacySoundCloudRetentionDisposition)
    .mockResolvedValue({ certificateId: 'a'.repeat(64), sealedProofDigest: 'b'.repeat(64) });
  const close = await f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan));
  expect(close.qualifiedNoSendSteps).toEqual([request.step]);
  expect(validateLegacySoundCloudRetentionDisposition).toHaveBeenLastCalledWith(expect.anything(), f.db, {
    ref: expect.objectContaining(ref),
    trackId: 'legacy-track',
  });
  const session = f.store.get(`temporalProviderMutationSessions/${sessionId}`)!;
  session.effectsClosed = true;
  session.effectsClosedSourceProgramDigest = close.sourceProgramDigest;
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(f.store.has('sermons/sermon')).toBe(false);
});

it('requires the completed private mirror checkpoint for cross-activity final settlement', async () => {
  const f = fixture(),
    plan = await prepareSermonDeletionMirrors(f.db, f.input);
  await expect(f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan))).rejects.toThrow();
  await removeSermonDeletionMirrors(f.db, plan, proof);
  await expect(f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan))).resolves.toBeUndefined();
  const header = f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
  header.state = 'root_removed';
  await expect(f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan))).rejects.toThrow();
});

function destinationFixture(count = 1) {
  const f = fixture(true),
    destinationProgram = {
      ...ref,
      sermonId: 'sermon',
      planId: sermonDeletionMirrorPlanId(ref, 'sermon'),
      digest: 'd'.repeat(64),
    };
  const requests: FrozenProjectionRequest[] = Array.from({ length: count }, (_, index) => {
    const target = {
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        resourceType: 'list-row',
        resourceId: `row-${index}`,
      },
      payload = { id: target.resourceId, listId: 'remote-list' };
    return {
      step: `sermon-delete-row:remote-list:${target.resourceId}`,
      method: 'DELETE' as const,
      target,
      payload,
      fingerprint: hash(['DELETE', { target, body: payload }]),
    };
  });
  const countWrites = [
    { path: 'lists/published', expectedFields: { subsplashId: 'remote-list' }, patch: { count: 0, logicalCount: 0 } },
  ];
  jest.mocked(readSermonDeletionDestinationProgramInTransaction).mockResolvedValue({
    operation: 'delete-providers',
    mediaId: 'media',
    requests,
    verifications: requests.map((request) => ({
      ...request.target!,
      resourceType: 'list-row' as const,
      expectedState: 'absent' as const,
      expectedProviderFields: {},
    })),
    countWrites,
  });
  jest
    .mocked(validateSermonDeletionDestinationCompletion)
    .mockResolvedValue({ evidenceDigest: 'e'.repeat(64), countWrites });
  const destinationPath = `${SERMON_DELETION_MIRROR_PLANS}/${destinationProgram.planId}/destinationPlan/header`;
  f.store.set(destinationPath, {
    schemaVersion: 1,
    ...ref,
    sermonId: 'sermon',
    generation: 1,
    intentDigest: acknowledgedProjectionDigest(f.intent),
    operation: 'delete-providers',
    mediaId: 'media',
    digest: destinationProgram.digest,
    requestCount: requests.length,
  });
  requests.forEach((request, index) =>
    f.store.set(`${destinationPath}/requests/${String(index).padStart(10, '0')}`, { request })
  );
  f.store.set('lists/published', { subsplashId: 'remote-list', count: 1, logicalCount: 1 });
  f.store.set('lists/published/listItems/sermon', {});
  const acknowledge = (sessionId: string, request: FrozenProjectionRequest) => {
    f.store.set(`temporalProviderMutationSessions/${sessionId}/requests/${hash(request.step)}`, {
      step: request.step,
      method: request.method,
      fingerprint: request.fingerprint,
      state: 'acknowledged',
      claim: 'claim',
      executionId: 'exec',
      result: null,
    });
    f.store.set(`temporalProviderMutationFacts/${hash([sessionId, request.step, 'claim'])}`, {
      sessionId,
      step: request.step,
      fingerprint: request.fingerprint,
      claim: 'claim',
      executionId: 'exec',
      completion: 'acknowledged',
      result: null,
    });
  };
  return { ...f, input: { ...f.input, destinationProgram }, requests, acknowledge, destinationProgram };
}

test('605 remote destination requests freeze complete bounded pages without expanding the mirror header', async () => {
  const f = destinationFixture(605),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    header = f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
  expect(header.requests).toEqual([f.request]);
  expect(header.destinationProgram).toEqual(f.destinationProgram);
  expect(mockPrograms.every((page) => page.requests.length <= 64 && page.writes.length <= 64)).toBe(true);
  const sealed = new Set(
    mockPrograms
      .filter((page) => page.finalFragment === true)
      .flatMap((page) => page.requests.map((request: any) => request.step))
  );
  expect(sealed.size).toBe(606);
  expect(mockPrograms.slice(0, 2).every((page) => page.writes[0].path === 'sermons/sermon')).toBe(true);
  expect(mockPrograms.find((page) => page.writes.some((write: any) => write.path === 'lists/published'))).toMatchObject(
    { finalFragment: false }
  );
  expect(f.store.get('lists/published')?.count).toBe(1);
  expect(f.deletions).toHaveLength(0);
});

test('root deletion and final published counts require every exact destination ACK and immutable completion', async () => {
  const f = destinationFixture(),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original();
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow();
  expect(f.store.has('sermons/sermon')).toBe(true);
  f.acknowledge(sessionId, f.requests[0]);
  jest
    .mocked(validateSermonDeletionDestinationCompletion)
    .mockRejectedValueOnce(new Error('remote membership count proof missing'));
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow('count proof missing');
  expect(f.store.has('sermons/sermon')).toBe(true);
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(f.deletions[0]).toEqual(['sermons/sermon']);
  expect(f.store.get('lists/published')).toMatchObject({ count: 0, logicalCount: 0 });
  f.store.get('lists/published')!.count = 99;
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(f.store.get('lists/published')?.count).toBe(99);
});

function installDestinationSealedProgram(
  f: ReturnType<typeof destinationFixture>,
  plan: { planId: string },
  sessionId: string
) {
  installSealedProgram(f, plan, sessionId);
  const intentFingerprint = acknowledgedProjectionDigest(f.intent),
    page = {
      schemaVersion: 1,
      ...ref,
      sessionId,
      operation: 'delete-providers',
      intentFingerprint,
      requests: f.requests,
      writes: [],
      verifications: [],
      finalFragment: true,
      completesActivity: false,
    },
    pageDigest = acknowledgedProjectionDigest(page);
  f.store.set(`temporalPublishingAcknowledgedProjections/${sessionId}/pages/${pageDigest}`, page);
  for (const request of f.requests)
    f.store.set(`temporalPublishingAcknowledgedProjections/${sessionId}/requestIndex/${hash(request.step)}`, {
      request,
      intentFingerprint,
      pageDigest,
      readyPageDigest: pageDigest,
      ready: true,
    });
  const root = f.store.get(`temporalPublishingAcknowledgedProjections/${sessionId}`)!;
  root.requestCount += f.requests.length;
  root.pageCount = 2;
  root.chainDigest = acknowledgedProjectionDigest([root.chainDigest, pageDigest]);
  f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!.frozenProgramDigest =
    acknowledgedProjectionDigest(root);
}

test('full destination closure and final active release require all original facts, absent mirrors, and exact settled counts', async () => {
  const f = destinationFixture(),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  f.acknowledge(sessionId, f.requests[0]);
  installDestinationSealedProgram(f, plan, sessionId);
  const close = await f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan));
  expect(close.expectedRequestSteps).toEqual([f.request.step, f.requests[0].step].sort());
  expect(close.qualifiedNoSendSteps).toEqual([]);
  const session = f.store.get(`temporalProviderMutationSessions/${sessionId}`)!;
  session.effectsClosed = true;
  session.effectsClosedSourceProgramDigest = close.sourceProgramDigest;
  await removeSermonDeletionMirrors(f.db, plan, proof);
  await expect(f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan))).resolves.toBeUndefined();
  f.store.set('lists/published/listItems/sermon', {});
  await expect(f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan))).rejects.toThrow();
  f.store.delete('lists/published/listItems/sermon');
  f.store.get('lists/published')!.count = 88;
  await expect(f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan))).rejects.toThrow();
  f.store.get('lists/published')!.count = 0;
  session.state = 'committed';
  f.store.get('lists/published')!.count = 99;
  await expect(f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan))).resolves.toBeUndefined();
});

test('count completion cannot change the original frozen destination projection', async () => {
  const f = destinationFixture(),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original();
  f.acknowledge(sessionId, f.requests[0]);
  jest.mocked(validateSermonDeletionDestinationCompletion).mockResolvedValue({
    evidenceDigest: 'e'.repeat(64),
    countWrites: [
      {
        path: 'lists/published',
        expectedFields: { subsplashId: 'remote-list' },
        patch: { count: 777, logicalCount: 777 },
      },
    ],
  });
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow();
  expect(f.store.has('sermons/sermon')).toBe(true);
  expect(f.store.get('lists/published')?.count).toBe(1);
});

test('root verification compiler reads complete source targets in bounded authenticated pages', async () => {
  const f = destinationFixture(65),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  installDestinationSealedProgram(f, plan, sessionId);
  const targets: string[] = [],
    steps: string[] = [],
    digests = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await f.db.runTransaction((tx) =>
      readSermonDeletionRootMutationTargetsPage(tx, f.db, { ref, sermonId: 'sermon', cursor, limit: 32 })
    );
    expect(page.targets.length).toBeLessThanOrEqual(32);
    expect(page.sourceRequestCount).toBe(66);
    page.targets.forEach((record) => {
      targets.push(record.target.resourceId);
      steps.push(record.requestStep);
    });
    digests.add(page.sourceProgramDigest);
    cursor = page.nextCursor;
  } while (cursor);
  expect(targets).toHaveLength(66);
  expect(new Set(steps).size).toBe(66);
  expect(digests.size).toBe(1);
  expect(targets).toContain('media');
  const sourcePath = `${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}/destinationPlan/header/requests/0000000000`;
  f.store.get(sourcePath)!.request.payload.id = 'foreign-row';
  await expect(
    f.db.runTransaction((tx) =>
      readSermonDeletionRootMutationTargetsPage(tx, f.db, { ref, sermonId: 'sermon', limit: 32 })
    )
  ).rejects.toThrow();
});

test('source canonical catalogue and idempotent page completions prove real bounded cleanup', async () => {
  const f = fixture();
  for (let i = 0; i < 65; i++) f.store.set(`lists/l${i}/listItems/sermon`, {});
  const plan = await prepareSermonDeletionMirrors(f.db, f.input);
  const before = await f.db.runTransaction((tx) =>
    readSermonDeletionCanonicalInventoryPage(tx, f.db, { ref, sermonId: 'sermon', limit: 32 })
  );
  expect(before.pages[0].page.kind).toBe('root');
  expect(before.expectedCanonicalPageCount).toBe(4);
  expect(before.pages.slice(1).every((record) => record.page.kind === 'mirrors' && record.page.rows.length <= 32)).toBe(
    true
  );
  await expect(
    f.db.runTransaction((tx) =>
      validateSermonDeletionCanonicalInventoryPage(tx, f.db, {
        ref,
        sermonId: 'sermon',
        index: 1,
        digest: before.pages[1].digest,
      })
    )
  ).resolves.toEqual({ complete: false });
  await removeSermonDeletionMirrors(f.db, plan, proof);
  const summary = await f.db.runTransaction((tx) => readSermonDeletionCanonicalCompletionSummary(tx, f.db, plan));
  expect(summary).toMatchObject({
    immutableCatalogDigest: before.immutableCatalogDigest,
    expectedCanonicalPageCount: 4,
    completedCanonicalPageCount: 4,
  });
  for (const record of before.pages)
    await expect(
      f.db.runTransaction((tx) =>
        validateSermonDeletionCanonicalInventoryPage(tx, f.db, {
          ref,
          sermonId: 'sermon',
          index: record.index,
          digest: record.digest,
        })
      )
    ).resolves.toMatchObject({ complete: true, completionDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const completions = [...f.store.keys()].filter((path) => path.includes(`${plan.planId}/canonicalPageCompletions/`));
  expect(completions).toHaveLength(4);
  const original = summary.canonicalCompletionDigest;
  await removeSermonDeletionMirrors(f.db, plan, proof);
  expect(
    (await f.db.runTransaction((tx) => readSermonDeletionCanonicalCompletionSummary(tx, f.db, plan)))
      .canonicalCompletionDigest
  ).toBe(original);
});

test('bounded final source summary is bound to the original closed seal and real completed page catalogue', async () => {
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  installSealedProgram(f, plan, sessionId);
  const close = await f.db.runTransaction((tx) => validateSermonDeletionEffectsForClosing(tx, f.db, plan));
  const session = f.store.get(`temporalProviderMutationSessions/${sessionId}`)!;
  session.effectsClosed = true;
  session.effectsClosedSourceProgramDigest = close.sourceProgramDigest;
  session.effectsClosedClaimSetDigest = 'c'.repeat(64);
  session.effectsClosedClaimSetDigestVersion = 2;
  session.effectsClosedActualRequestCount = 1;
  const seal = {
    sessionId,
    claimSetDigest: 'c'.repeat(64),
    claimSetDigestVersion: 2 as const,
    actualRequestCount: 1,
    sourceDispositionValidated: true as const,
    sourceProgramDigest: close.sourceProgramDigest,
    expectedRequestCount: 1,
  };
  await expect(f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan, seal))).rejects.toThrow();
  await removeSermonDeletionMirrors(f.db, plan, proof);
  const summary = await f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan, seal));
  expect(summary).toMatchObject({
    closedClaimSetDigest: 'c'.repeat(64),
    originalRequestCount: 1,
    expectedCanonicalPageCount: 1,
    completedCanonicalPageCount: 1,
    immutableCatalogDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    canonicalCompletionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await expect(
    f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan, { ...seal, actualRequestCount: 2 }))
  ).rejects.toThrow();
  f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!.canonicalCompletion.completedCanonicalPageCount = 0;
  await expect(f.db.runTransaction((tx) => validateSermonDeletionCompletion(tx, f.db, plan, seal))).rejects.toThrow();
});

test('candidate root checkpoint requires the actual full-program current witness and closes effects atomically', async () => {
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  installSealedProgram(f, plan, sessionId);
  const header = f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
  const currentSeal = { opaque: true },
    witness = { candidateId: 'a'.repeat(64), candidateDigest: 'b'.repeat(64), observationScope: 'scope', currentSeal };
  const verified = {
    programId: 'd'.repeat(64),
    programSealDigest: 'e'.repeat(64),
    seal: currentSeal,
    terminalClaimSetDigest: 'c'.repeat(64),
    originalRequestCount: 1,
  };
  jest.mocked(assertAcknowledgedRepairCandidateVerificationSeal).mockResolvedValue(verified);
  jest
    .mocked(prepareProviderMutationEffectsClosedFromReadyEvidence)
    .mockImplementation(async (tx, session, validate) => {
      const proof = await validate(tx, session);
      expect(proof).toMatchObject({ claimSetDigest: 'c'.repeat(64), actualRequestCount: 1, expectedRequestCount: 1 });
      return {
        alreadyClosed: false,
        commit: () =>
          tx.update(f.db.doc(`temporalProviderMutationSessions/${sessionId}`), {
            effectsClosed: true,
            effectsClosedSourceProgramDigest: proof.sourceProgramDigest,
          }),
      };
    });
  await expect(
    f.db.runTransaction((tx) =>
      prepareSermonRootRemovalCheckpointFromAcknowledgedRepair(tx, f.db, {
        ref,
        sessionId,
        sermonId: 'sermon',
        projectionDigest: header.frozenProgramDigest,
        candidateVerification: { ...witness, currentSeal: undefined },
      })
    )
  ).rejects.toThrow();
  expect(prepareProviderMutationEffectsClosedFromReadyEvidence).not.toHaveBeenCalled();
  await f.db.runTransaction(async (tx) => {
    const commit = await prepareSermonRootRemovalCheckpointFromAcknowledgedRepair(tx, f.db, {
      ref,
      sessionId,
      sermonId: 'sermon',
      projectionDigest: header.frozenProgramDigest,
      candidateVerification: witness,
    });
    expect(f.store.has('sermons/sermon')).toBe(true);
    commit();
    tx.delete(f.db.doc('sermons/sermon'));
  });
  const saved = f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
  expect(saved.rootRemoval.candidateVerification).toEqual({
    candidateId: witness.candidateId,
    candidateDigest: witness.candidateDigest,
    observationScope: 'scope',
    programId: verified.programId,
    programSealDigest: verified.programSealDigest,
  });
  expect(saved.rootRemoval.candidateVerification.currentSeal).toBeUndefined();
  expect(f.store.get(`temporalProviderMutationSessions/${sessionId}`)?.effectsClosed).toBe(true);
  expect(f.store.has(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}/canonicalPageCompletions/000000000000`)).toBe(
    true
  );
  expect(assertAcknowledgedRepairCandidateVerificationSeal).toHaveBeenCalledWith(
    expect.anything(),
    f.db,
    expect.objectContaining({
      currentSeal,
      sourceProgramExpectation: { sourceProgramDigest: expect.stringMatching(/^[a-f0-9]{64}$/), sourceRequestCount: 1 },
    })
  );
});

test('606-step candidate root pins the whole original destination catalogue and rejects missing or changed count proof', async () => {
  const f = destinationFixture(605),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  installDestinationSealedProgram(f, plan, sessionId);
  const header = f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
  const witness = {
    candidateId: 'a'.repeat(64),
    candidateDigest: 'b'.repeat(64),
    observationScope: 'scope',
    currentSeal: { opaque: true },
  };
  jest.mocked(assertAcknowledgedRepairCandidateVerificationSeal).mockResolvedValue({
    programId: 'd'.repeat(64),
    programSealDigest: 'e'.repeat(64),
    seal: witness.currentSeal,
    terminalClaimSetDigest: 'c'.repeat(64),
    originalRequestCount: 606,
  });
  jest
    .mocked(prepareProviderMutationEffectsClosedFromReadyEvidence)
    .mockImplementation(async (tx, session, validate) => {
      const closing = await validate(tx, session);
      expect(closing).toMatchObject({ expectedRequestCount: 606, actualRequestCount: 606 });
      return { alreadyClosed: false, commit: () => {} };
    });
  const run = () =>
    f.db.runTransaction(async (tx) => {
      const commit = await prepareSermonRootRemovalCheckpointFromAcknowledgedRepair(tx, f.db, {
        ref,
        sessionId,
        sermonId: 'sermon',
        projectionDigest: header.frozenProgramDigest,
        candidateVerification: witness,
      });
      commit();
      tx.delete(f.db.doc('sermons/sermon'));
    });
  jest
    .mocked(validateSermonDeletionDestinationCompletion)
    .mockRejectedValueOnce(new Error('fixed count proof missing'));
  await expect(run()).rejects.toThrow('fixed count proof missing');
  jest.mocked(validateSermonDeletionDestinationCompletion).mockResolvedValueOnce({
    evidenceDigest: 'e'.repeat(64),
    countWrites: [
      {
        path: 'lists/published',
        expectedFields: { subsplashId: 'remote-list' },
        patch: { count: 99, logicalCount: 99 },
      },
    ],
  });
  await expect(run()).rejects.toThrow('SERMON_DELETION_MIRROR_PROOF_INVALID');
  expect(f.store.has('sermons/sermon')).toBe(true);
  expect(prepareProviderMutationEffectsClosedFromReadyEvidence).not.toHaveBeenCalled();
  await run();
  expect(assertAcknowledgedRepairCandidateVerificationSeal).toHaveBeenLastCalledWith(
    expect.anything(),
    f.db,
    expect.objectContaining({
      sourceProgramExpectation: {
        sourceRequestCount: 606,
        sourceProgramDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
  );
  expect(f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)?.rootRemoval.destinationEvidenceDigest).toBe(
    'e'.repeat(64)
  );
});

test('derivative fixed count reads require unique original destination membership and its frozen count page', async () => {
  const f = destinationFixture(),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    sessionId = f.original('active');
  installDestinationSealedProgram(f, plan, sessionId);
  const base = `${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`,
    nodes = `${base}/destinationPlan/header/nodes`;
  f.store.set(`${nodes}/0000000000`, {
    path: 'lists/published',
    rootPath: 'lists/published',
    listId: 'remote-list',
    sourceDigest: 'a'.repeat(64),
    remainingDigest: 'b'.repeat(64),
  });
  const input = {
    ref,
    sermonId: 'sermon',
    sessionId,
    sourceRootDigest: f.store.get(base)!.frozenProgramDigest,
    resourceType: 'list' as const,
    resourceId: 'remote-list',
    account: 'app:9XTSHD' as const,
  };
  await expect(
    f.db.runTransaction((tx) => assertSermonDeletionCountReadInTransaction(tx, f.db, input))
  ).resolves.toBeUndefined();
  await expect(
    f.db.runTransaction((tx) =>
      assertSermonDeletionCountReadInTransaction(tx, f.db, { ...input, resourceId: 'foreign' })
    )
  ).rejects.toThrow();
  f.store.set(`${nodes}/0000000001`, { ...f.store.get(`${nodes}/0000000000`) });
  await expect(
    f.db.runTransaction((tx) => assertSermonDeletionCountReadInTransaction(tx, f.db, input))
  ).rejects.toThrow();
  f.store.delete(`${nodes}/0000000001`);
  const authority = f.store.get(`${base}/countReadTargets/${hash(['list', 'remote-list'])}`)!;
  authority.writeDigest = 'f'.repeat(64);
  await expect(
    f.db.runTransaction((tx) => assertSermonDeletionCountReadInTransaction(tx, f.db, input))
  ).rejects.toThrow();
});

test('distinct certified deletion preserves original aborted-zero state and pins real new ACK, absence, closure and canonical completion', async () => {
  const { acquireCertifiedPublishingDeletionSession, executeCertifiedPublishingDeletion } = await import(
    '../temporal/publishing/criticalDeletionGuard'
  );
  const { prepareCertifiedDeletionDisposition, certifiedDeletionDispositionDigest } = await import(
    '../temporal/publishing/certifiedDeletionDisposition'
  );
  const { prepareProviderMutationEffectsClosed, prepareProviderMutationSessionCommitFromClosedEvidence } = await import(
    '../temporal/publishing/providerMutationGuard'
  );
  const f = fixture(true),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    scope = { ...ref, operation: 'delete-providers' },
    originalSessionId = hash(scope),
    target = f.request.target!;
  f.store.set(`temporalProviderMutationSessions/${originalSessionId}`, {
    schemaVersion: 1,
    state: 'aborted',
    abortedAtMillis: 7,
    scope,
    resources: [target],
    resourceKeys: [hash([ref.projectId, target.provider, target.account, target.resourceId])],
  });
  installSealedProgram(f, plan, originalSessionId);
  const certificateId = hash('cert'),
    generation = 1,
    operation = {
      kind: 'provider_delete' as const,
      method: 'DELETE' as const,
      provider: 'subsplash' as const,
      resourceType: 'media' as const,
      resourceId: 'media',
      accountId: 'app:9XTSHD',
    };
  const authorizeInTransaction = async () => {};
  const lease = await acquireCertifiedPublishingDeletionSession({
    db: f.db,
    ref,
    certificateId,
    generation,
    operations: [operation],
    transactionRunner: (fn) => f.db.runTransaction(fn),
    authorizeInTransaction,
    validateCompletePlanInTransaction: async () => {},
  });
  const certifiedHandle = await executeCertifiedPublishingDeletion({
    db: f.db,
    ref,
    certificateId,
    generation,
    operation,
    lease,
    executionId: hash('actual-sdk'),
    transactionRunner: (fn) => f.db.runTransaction(fn),
    authorizeInTransaction,
    sendOriginalDelete: async () => ({ status: 204 }),
  });
  const absence = {
    schemaVersion: 1,
    ...ref,
    certificateId,
    generation,
    target,
    state: 'absent',
    originalHttpStatus: 404,
    originalAccount: 'app:9XTSHD',
    ownershipConfirmedBeforeDelete: true,
    proof: 'authenticated_fixed_id_get_404_410',
    observationScope: hash('fixed-observation'),
  };
  const fixedAbsence = {
    proofPath: `temporalPublishingCriticalDeletionAbsences/${hash('fixed-absence')}`,
    proofDigest: certifiedDeletionDispositionDigest(absence),
    observationScope: absence.observationScope,
  };
  f.store.set(fixedAbsence.proofPath, absence);
  await f.db.runTransaction(async (tx) => {
    const disposition = await prepareCertifiedDeletionDisposition(tx, f.db, {
      ref,
      certificateId,
      generation,
      originalSessionId,
      originalRequest: f.request,
      certifiedHandle,
      authorizeInTransaction,
      validateSourceHeaderInTransaction: (inner, originalRequest) =>
        readSermonDeletionCertifiedSourceHeaderInTransaction(inner, f.db, {
          ref,
          sermonId: 'sermon',
          originalSessionId,
          originalRequest,
        }),
      validateFixedAbsenceInTransaction: async () => fixedAbsence,
    });
    disposition.commit();
  });
  await expect(removeSermonDeletionMirrors(f.db, plan, proof)).rejects.toThrow();
  const sourceHeaderBefore = await f.db.runTransaction((tx) =>
    readSermonDeletionCertifiedSourceHeaderInTransaction(tx, f.db, {
      ref,
      sermonId: 'sermon',
      originalSessionId,
      originalRequest: f.request,
    })
  );
  const session = lease.session;
  await f.db.runTransaction(async (tx) => {
    const closure = await prepareProviderMutationEffectsClosed(tx, session, (inner) =>
      validateSermonDeletionCertifiedEffectsForClosing(inner, f.db, { plan, session })
    );
    closure.commit();
  });
  await removeSermonDeletionMirrors(f.db, plan, proof);
  const header = f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
  expect(header.rootRemoval.certifiedDeletion).toMatchObject({ originalSessionId, certifiedSessionId: session.id });
  expect(f.store.get(`temporalProviderMutationSessions/${originalSessionId}`)?.state).toBe('aborted');
  expect(
    [...f.store.keys()].filter((path) =>
      path.startsWith(`temporalProviderMutationSessions/${originalSessionId}/requests/`)
    )
  ).toHaveLength(0);
  await f.db.runTransaction(async (tx) => {
    const final = await prepareProviderMutationSessionCommitFromClosedEvidence(tx, session, (inner, _session, seal) =>
      validateSermonDeletionCompletion(inner, f.db, plan, seal)
    );
    final.commit();
  });
  expect(f.store.get(`temporalProviderMutationSessions/${session.id}`)?.state).toBe('committed');
  await expect(
    f.db.runTransaction((tx) =>
      readSermonDeletionCertifiedSourceHeaderInTransaction(tx, f.db, {
        ref,
        sermonId: 'sermon',
        originalSessionId,
        originalRequest: f.request,
      })
    )
  ).resolves.toEqual(sourceHeaderBefore);
  f.store.get(fixedAbsence.proofPath)!.originalAccount = 'app:foreign';
  await expect(
    f.db.runTransaction((tx) => validateSermonDeletionCertifiedEffectsForClosing(tx, f.db, { plan, session }))
  ).rejects.toThrow();
  expect(header.canonicalCompletion.originalRequestCount).toBe(1);
  expect(f.store.has('sermons/sermon')).toBe(false);
});

test('certified source cannot silently qualify original destination RPCs or count projections from root absence', async () => {
  const f = destinationFixture(),
    plan = await prepareSermonDeletionMirrors(f.db, f.input),
    originalSessionId = hash({ ...ref, operation: 'delete-providers' });
  installDestinationSealedProgram(f, plan, originalSessionId);
  await expect(
    f.db.runTransaction((tx) =>
      readSermonDeletionCertifiedSourceHeaderInTransaction(tx, f.db, {
        ref,
        sermonId: 'sermon',
        originalSessionId,
        originalRequest: f.request,
      })
    )
  ).rejects.toThrow('SERMON_DELETION_MIRROR_PROOF_INVALID');
  expect(f.store.has('sermons/sermon')).toBe(true);
  expect(f.store.get('lists/published')?.count).toBe(1);
});

test('full critical repair keeps new deletion ownership through cleanup and restarts without duplicating the DELETE', async () => {
  const { repairPublishingCritical, criticalRepairDigest } = await import('../temporal/publishing/criticalRepair');
  const { prepareProviderMutationSessionCommitFromClosedEvidence } = await import(
    '../temporal/publishing/providerMutationGuard'
  );
  const { providerResourceKey, providerEdgeKey } = await import('../../../packages/orchestration/src/provider-usage');
  const f = fixture(true);
  f.store.set('sermons/sermon/sermonLists/local', { local: true });
  f.store.set('lists/local/listItems/sermon', { local: true });
  f.store.set('lists/local', { count: 1 });
  const plan = await prepareSermonDeletionMirrors(f.db, f.input),
    scope = { ...ref, operation: 'delete-providers' },
    originalSessionId = hash(scope),
    target = f.request.target!;
  f.store.set(`temporalProviderMutationSessions/${originalSessionId}`, {
    schemaVersion: 1,
    state: 'aborted',
    abortedAtMillis: 7,
    scope,
    resources: [target],
    resourceKeys: [hash([ref.projectId, target.provider, target.account, target.resourceId])],
  });
  installSealedProgram(f, plan, originalSessionId);
  const journalId = createHash('sha256')
    .update(JSON.stringify([ref.projectId, ref.jobId, 'subsplash', 'media']))
    .digest('hex');
  f.store.set(`temporalPublishingDeletionReceipts/${journalId}`, {
    ...ref,
    sermonId: 'sermon',
    provider: 'subsplash',
    remoteId: 'media',
    originalAccount: 'app:9XTSHD',
    state: 'authorized',
    ownershipConfirmedBeforeDelete: true,
  });
  f.store.set('testAuthority/grant', { active: true });
  f.store.set('_control/temporalProviderUsage', {
    schemaVersion: 1,
    projectId: ref.projectId,
    status: 'ready',
    epoch: 'test-epoch',
  });
  const resource = {
      projectId: ref.projectId,
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      remoteId: 'media',
    },
    indexPath = `temporalProviderUsage/${providerResourceKey(resource)}/epochs/test-epoch`;
  f.store.set(indexPath, {
    state: 'reserved',
    referenceCount: 1,
    desiredDeletionProof: {
      jobId: ref.jobId,
      resourceType: 'media',
      intentFingerprint: acknowledgedProjectionDigest(f.intent),
    },
  });
  f.store.set(`${indexPath}/edges/${providerEdgeKey('durableJobIntents/job')}`, {
    projectId: ref.projectId,
    canonicalPath: 'durableJobIntents/job',
  });
  const operation = {
    kind: 'provider_delete' as const,
    method: 'DELETE' as const,
    provider: 'subsplash' as const,
    resourceType: 'media' as const,
    resourceId: 'media',
    accountId: 'app:9XTSHD',
  };
  const certificate = {
    schemaVersion: 1 as const,
    ...ref,
    generation: 1,
    workflowId: 'workflow',
    acceptedUserCancellation: false,
    intentFingerprint: acknowledgedProjectionDigest(f.intent),
    criticalFingerprint: 'b'.repeat(64),
    operations: [operation],
    sourceEvidenceDigests: [],
  };
  const certificateId = criticalRepairDigest(certificate),
    events: string[] = [],
    send = jest.fn(async () => {
      events.push('DELETE');
      return { status: 204 };
    });
  let scopeId = hash('actual-first-sdk-scope');
  const deps = {
    firestore: f.db,
    loadCertificate: async () => certificate,
    getRepairObservationScope: async () => scopeId,
    prepareFinalSettlement: prepareProviderMutationSessionCommitFromClosedEvidence,
    authorizeOperation: async () => {
      if (f.store.get('testAuthority/grant')?.active !== true) throw Error('grant revoked');
      events.push('authorize');
    },
    authorizeCertifiedDeletionInTransaction: async (tx: any, _operation: unknown, phase: string) => {
      const grant = await tx.get(f.db.doc('testAuthority/grant'));
      if (grant.get('active') !== true) throw Error('grant revoked');
      events.push(`authority:${phase}`);
    },
    commitCurrent: async (_ref: unknown, mutate: any) => {
      const active = [...f.store.entries()].find(
        ([path, value]) =>
          /^temporalProviderMutationSessions\/[a-f0-9]{64}$/.test(path) &&
          value.state === 'active' &&
          String(value.scope?.operation).startsWith('critical-fixed-delete:')
      );
      if (active) {
        const lock = f.store.get(
          `temporalProviderMutationLocks/${hash([ref.projectId, target.provider, target.account, target.resourceId])}`
        );
        expect(lock).toMatchObject({ state: 'held', sessionId: active[0].split('/')[1] });
        events.push(`locked:${f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)?.state}`);
      }
      await f.db.runTransaction(async (tx) => {
        const grant = await tx.get(f.db.doc('testAuthority/grant'));
        if (grant.get('active') !== true) throw Error('grant revoked');
        await mutate(tx);
      });
    },
    prepareDeleteProvider: async () => send,
    readProvider: async () => {
      events.push('fixed GET');
      return { state: 'absent' as const, providerId: 'media', accountId: 'app:9XTSHD', originalHttpStatus: 404 };
    },
  };
  mockUseRealDurableTransaction = true;
  const result = await repairPublishingCritical(ref, certificateId, deps);
  expect(result.state).toBe('completed');
  expect(send).toHaveBeenCalledTimes(1);
  const header = f.store.get(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`)!,
    certifiedSessionId = header.rootRemoval.certifiedDeletion.certifiedSessionId;
  expect(f.store.get(`temporalProviderMutationSessions/${originalSessionId}`)?.state).toBe('aborted');
  expect(
    [...f.store.keys()].filter((path) =>
      path.startsWith(`temporalProviderMutationSessions/${originalSessionId}/requests/`)
    )
  ).toHaveLength(0);
  expect(f.store.get(`temporalProviderMutationSessions/${certifiedSessionId}`)?.state).toBe('committed');
  expect(f.store.get(indexPath)?.state).toBe('deleted');
  expect(f.store.has('sermons/sermon')).toBe(false);
  expect(f.store.has('sermons/sermon/sermonLists/local')).toBe(false);
  expect(f.store.has('lists/local/listItems/sermon')).toBe(false);
  expect(f.store.get('lists/local')?.count).toBe(0);
  expect(header.canonicalCompletion).toMatchObject({ expectedCanonicalPageCount: 2, completedCanonicalPageCount: 2 });
  expect(f.deletions[0]).toEqual(['sermons/sermon']);
  const readCount = events.filter((event) => event === 'fixed GET').length;
  scopeId = hash('new-sdk-retry-scope');
  await expect(repairPublishingCritical(ref, certificateId, deps)).resolves.toMatchObject({
    state: 'completed',
    settledMutationSessionIds: [certifiedSessionId],
    readsCompleted: 0,
    deletesCompleted: 0,
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(events.filter((event) => event === 'fixed GET')).toHaveLength(readCount);
  f.store.get('testAuthority/grant')!.active = false;
  await expect(repairPublishingCritical(ref, certificateId, deps)).rejects.toThrow('grant revoked');
  expect(send).toHaveBeenCalledTimes(1);
  expect(events).toContain('authority:claim');
  expect(events).toContain('locked:prepared');
  expect(events).toContain('locked:root_removed');
  expect(events).toContain('locked:completed');
});
