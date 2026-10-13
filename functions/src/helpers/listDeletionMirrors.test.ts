jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'urm-app' } }) },
}));
jest.mock('../temporal/publishing/durableOperationContext', () => ({
  ...jest.requireActual('../temporal/publishing/durableOperationContext'),
  getDurablePublishingJobId: () => mockJobId,
  getPublishingMutationOperation: () => 'delete-all-lists',
  prepareAcknowledgedProjectionPlan: async (_tx: unknown, plan: unknown) => {
    mockPrograms.push(plan);
    return { projectionDigest: 'proof', commit: () => {} };
  },
  runDurableTransaction: (db: { runTransaction: (fn: unknown) => Promise<unknown> }, fn: unknown) => {
    mockFences++;
    return db.runTransaction(fn);
  },
  prepareProviderMutationEffectsClosed: async (tx: any, plan: any) => {
    const guard = jest.requireActual('../temporal/publishing/providerMutationGuard');
    const scope = { projectId: 'urm-app', jobId: mockJobId, operation: plan.operation },
      id = guard.providerMutationFingerprint(scope),
      held = await tx.get({ path: `temporalProviderMutationSessions/${id}` });
    return guard.prepareProviderMutationEffectsClosed(
      tx,
      { db: mockEffectsDb, id, scope, resources: held.get('resources') },
      plan.validateSourceEffects
    );
  },
}));
import type { Firestore } from 'firebase-admin/firestore';
import {
  prepareListDeletionMirrors,
  removeListDeletionMirrors,
  deleteListDeletionCanonicalPage,
  recordListDeletionProviderAbsence,
  validateDeletedListCleanup,
  loadFactualListDeletionCleanup,
  sealListDeletionCompletion,
  validateListDeletionCompletion,
  prepareListRootRemovalCheckpointFromAcknowledgedRepair,
  type ListDeletionMirrorPlan,
  LIST_DELETION_MIRROR_PLANS,
} from './listDeletionMirrors';
import { desiredProviderDeletionPlanId, providerEdgeKey } from '../../../packages/orchestration/src/provider-usage';

let mockJobId: string | undefined;
let mockFences = 0;
let mockPrograms: any[] = [];
let mockEffectsDb: any;
const input = {
  rootListId: 'root',
  firestoreListIds: ['root', 'overflow'],
  remoteListIds: ['remote-root', 'remote-overflow'],
};
type Data = Record<string, any>;
function fakeFirestore() {
  const store = new Map<string, Data>();
  const deletions: string[][] = [];
  let missingIndex = false;
  const doc = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    get: async () => snapshot(path),
    collection: (name: string) => query(`${path}/${name}`, false),
    listCollections: async () =>
      [
        ...new Set(
          [...store.keys()]
            .filter((key) => key.startsWith(`${path}/`))
            .map((key) => key.slice(path.length + 1).split('/')[0])
        ),
      ].map((id) => ({ id })),
  });
  const snapshot = (path: string): any => ({
    id: path.split('/').pop(),
    ref: doc(path),
    exists: store.has(path),
    data: () => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined),
    get: (key: string) =>
      key
        .split('.')
        .reduce(
          (value, part) => value?.[part],
          store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined
        ),
  });
  const query = (
    path: string,
    group: boolean,
    predicates: Array<[string, unknown]> = [],
    cursor = '',
    limit = Infinity
  ): any => ({
    _query: true,
    doc: (id: string) => doc(`${path}/${id}`),
    where: (field: string, operator: string, value: unknown) =>
      query(path, group, [...predicates, [field, operator === 'in' ? { in: value } : value]], cursor, limit),
    orderBy: () => query(path, group, predicates, cursor, limit),
    select: () => query(path, group, predicates, cursor, limit),
    count: () => ({
      _query: true,
      get: async () => {
        const result = await query(path, group, predicates, cursor, limit).get();
        return { data: () => ({ count: result.size }) };
      },
    }),
    limit: (value: number) => query(path, group, predicates, cursor, value),
    startAfter: (value: any) =>
      query(path, group, predicates, typeof value === 'string' ? `${path}/${value}` : value.ref.path, limit),
    get: async () => {
      if (missingIndex && group && predicates.length) throw Object.assign(new Error('missing index'), { code: 9 });
      const paths = [...store.keys()]
        .filter((key) => {
          const parts = key.split('/');
          const member = group
            ? parts[parts.length - 2] === path
            : key.startsWith(`${path}/`) && parts.length === path.split('/').length + 1;
          return (
            member &&
            key > cursor &&
            predicates.every(([field, value]) =>
              value && typeof value === 'object' && 'in' in value
                ? (value as { in: unknown[] }).in.includes(snapshot(key).get(field))
                : snapshot(key).get(field) === value
            )
          );
        })
        .sort()
        .slice(0, limit);
      return { docs: paths.map(snapshot), size: paths.length, empty: paths.length === 0 };
    },
  });
  const db: any = {
    doc,
    collection: (name: string) => query(name, false),
    collectionGroup: (name: string) => query(name, true),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const writes: Array<() => void> = [];
      const deleted: string[] = [];
      let writing = false;
      const tx = {
        get: async (ref: any) => {
          if (writing) throw new Error('Read after write');
          return ref._query ? ref.get() : snapshot(ref.path);
        },
        getAll: async (...refs: any[]) => {
          if (writing) throw new Error('Read after write');
          return refs.map((ref) => snapshot(ref.path));
        },
        create: (ref: any, data: Data) => {
          writing = true;
          writes.push(() => {
            if (store.has(ref.path)) throw new Error('Already exists');
            store.set(ref.path, structuredClone(data));
          });
        },
        update: (ref: any, data: Data) => {
          writing = true;
          writes.push(() => store.set(ref.path, { ...store.get(ref.path), ...structuredClone(data) }));
        },
        set: (ref: any, data: Data) => {
          writing = true;
          writes.push(() => store.set(ref.path, structuredClone(data)));
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
  };
  store.set('lists/root', { rootListId: 'root', subsplashId: 'remote-root', moreSermonsRef: 'remote-overflow' });
  store.set('lists/overflow', { rootListId: 'root', subsplashId: 'remote-overflow' });
  const entity = { type: 'list', id: 'root' };
  const intent = {
    projectId: 'urm-app',
    jobId: 'job-1',
    kind: 'list.delete',
    entity,
    generation: 1,
    actorUid: 'publisher',
    payload: { kind: 'list.delete', entity, payload: { operation: 'delete', input: { listId: 'root' } } },
  };
  store.set('durableJobIntents/job-1', intent);
  store.set('durableJobs/job-1', { ...intent, state: 'running', workflowId: 'workflow-1' });
  return {
    db: db as Firestore,
    store,
    deletions,
    setMissingIndex: () => {
      missingIndex = true;
    },
  };
}

async function completedProviderDeletes(
  h: ReturnType<typeof fakeFirestore>,
  plan: ListDeletionMirrorPlan,
  state = 'acknowledged'
) {
  if (!plan.jobId) return;
  const { providerMutationFingerprint: hash } = await import('../temporal/publishing/providerMutationGuard');
  const { publishingMutationRequestFingerprint } = await import('../temporal/publishing/durableOperationContext');
  const { providerPayloadFingerprint } = await import('../temporal/publishing/providerReceipts');
  const scope = { projectId: plan.projectId, jobId: plan.jobId, operation: 'delete-all-lists' };
  const sessionId = hash(scope),
    resources = plan.remoteListIds.map((resourceId) => ({
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: 'list',
      resourceId,
    }));
  const resourceKeys = resources.map((target) =>
    hash([plan.projectId, target.provider, target.account, target.resourceId])
  );
  h.store.set(`temporalProviderMutationSessions/${sessionId}`, {
    schemaVersion: 1,
    scope,
    resources,
    resourceKeys,
    state: 'active',
  });
  resourceKeys.forEach((key) => h.store.set(`temporalProviderMutationLocks/${key}`, { sessionId, state: 'held' }));
  mockEffectsDb = h.db;
  for (const target of resources) {
    const step = `delete-logical-list:${target.resourceId}:${providerPayloadFingerprint({ id: target.resourceId })}`;
    const fingerprint = publishingMutationRequestFingerprint({
      method: 'DELETE',
      target,
      payload: { id: target.resourceId },
    });
    const request = {
      step,
      method: 'DELETE',
      fingerprint,
      state,
      claim: 'original-claim',
      executionId: 'original-execution',
      result: null,
    };
    h.store.set(`temporalProviderMutationSessions/${sessionId}/requests/${hash(step)}`, request);
    h.store.set(`temporalProviderMutationFacts/${hash([sessionId, step, request.claim])}`, {
      ...request,
      sessionId,
      completion: state,
      ...(state === 'rejected_no_effect'
        ? { evidence: { transport: 'original_http_response', status: 404, providerCode: 'resource_not_found' } }
        : {}),
    });
  }
  const header = h.store.get(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
  const { acknowledgedProjectionDigest: digest } = await import('../temporal/publishing/criticalAcknowledgedRepair');
  const planned = resources.map((target) => ({
    step: `delete-logical-list:${target.resourceId}:${providerPayloadFingerprint({ id: target.resourceId })}`,
    method: 'DELETE',
    target,
    fingerprint: publishingMutationRequestFingerprint({ method: 'DELETE', target, payload: { id: target.resourceId } }),
    payload: { id: target.resourceId },
  }));
  const page = { requests: planned, finalFragment: true };
  const pageDigest = digest(page);
  h.store.set(`temporalPublishingAcknowledgedProjections/${sessionId}`, {
    schemaVersion: 2,
    ...scope,
    sessionId,
    intentFingerprint: header.intentFingerprint,
    pageCount: 1,
    requestCount: resources.length,
    chainDigest: digest([]),
    completesActivity: false,
    uiStepIds: [],
  });
  h.store.set(`temporalPublishingAcknowledgedProjections/${sessionId}/pages/${pageDigest}`, page);
  for (const request of planned)
    h.store.set(`temporalPublishingAcknowledgedProjections/${sessionId}/requestIndex/${hash(request.step)}`, {
      request,
      ready: true,
      intentFingerprint: header.intentFingerprint,
      pageDigest,
      readyPageDigest: pageDigest,
    });
  await recordListDeletionProviderAbsence(h.db, plan);
}

describe('logical list deletion mirrors', () => {
  beforeEach(() => {
    mockJobId = 'job-1';
    mockFences = 0;
    mockPrograms = [];
  });
  it('freezes all owned mirrors beyond 501, including legacy missing-field rows, without pruning before HTTP', async () => {
    const h = fakeFirestore();
    for (let i = 0; i < 650; i++)
      h.store.set(
        `sermons/${i.toString().padStart(4, '0')}/sermonLists/root`,
        i % 2 ? {} : { id: 'root', subsplashId: 'remote-root' }
      );
    h.store.set('sermons/spoof/sermonLists/foreign', { id: 'root', subsplashId: 'remote-root' });
    h.store.set('tenants/x/sermonLists/root', { id: 'root', subsplashId: 'remote-root' });
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    expect(h.deletions).toEqual([]);
    expect(
      [...h.store.keys()].filter((path) => path.includes(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}/rows/`))
    ).toHaveLength(652);
    expect(mockPrograms[0].requests).toHaveLength(2);
    expect(mockPrograms.reduce((sum, program) => sum + program.writes.length, 0)).toBe(652);
    expect(mockPrograms.every((program) => program.writes.length <= 64)).toBe(true);
    expect(mockPrograms[mockPrograms.length - 1]).toMatchObject({
      writes: [],
      verifications: [],
      finalFragment: true,
      completesActivity: false,
    });
    expect(mockPrograms.slice(0, -1).every((program) => program.finalFragment === false)).toBe(true);
    expect(mockPrograms[0].verifications.every((value: any) => value.expectedState === 'absent')).toBe(true);
    await removeListDeletionMirrors(h.db, plan);
    expect(h.deletions.flat()).toHaveLength(650);
    expect(h.deletions.every((chunk) => chunk.length <= 64)).toBe(true);
    expect(h.store.has('sermons/spoof/sermonLists/foreign')).toBe(true);
    expect(h.store.has('tenants/x/sermonLists/root')).toBe(true);
    expect(mockFences).toBeGreaterThan(10);
  });
  it('writes removal proofs under each actual referenced provider resource only', async () => {
    const h = fakeFirestore();
    const path = 'sermons/sermon/sermonLists/root';
    h.store.set(path, {
      id: 'root',
      subsplashId: 'remote-root',
      physicalPlacement: { subsplashListId: 'remote-overflow' },
    });
    h.store.set('sermons/local/sermonLists/root', {});
    await prepareListDeletionMirrors(h.db, input);
    for (const remoteId of input.remoteListIds) {
      const id = desiredProviderDeletionPlanId({
        resource: { projectId: 'urm-app', provider: 'subsplash', account: 'app:9XTSHD', remoteId },
        jobId: 'job-1',
        resourceType: 'list',
      });
      const base = `temporalProviderDesiredDeletionPlans/${id}`;
      expect(h.store.get(base)).toMatchObject({
        schemaVersion: 1,
        entity: { type: 'list', id: 'root' },
        generation: 1,
        state: 'prepared',
        method: 'DELETE',
      });
      expect(h.store.get(`${base}/removals/${providerEdgeKey(path)}`)).toMatchObject({
        canonicalPath: path,
        after: 'absent',
      });
      expect(h.store.has(`${base}/removals/${providerEdgeKey('sermons/local/sermonLists/root')}`)).toBe(false);
    }
  });
  it('streams more than 2,000 original deletion writes into bounded preclaim fragments', async () => {
    const h = fakeFirestore();
    for (let i = 0; i < 2200; i++) h.store.set(`sermons/${i.toString().padStart(4, '0')}/sermonLists/root`, {});
    await prepareListDeletionMirrors(h.db, input);
    expect(mockPrograms.reduce((sum, program) => sum + program.writes.length, 0)).toBe(2202);
    expect(mockPrograms.every((program) => program.writes.length <= 64)).toBe(true);
    expect(h.deletions).toEqual([]);
  });
  it('blocks unsupported descendant collections before any canonical pruning', async () => {
    const h = fakeFirestore();
    h.store.set('lists/root/privateNotes/note', { value: 'unknown projection' });
    await expect(prepareListDeletionMirrors(h.db, input)).rejects.toThrow('DESCENDANT_PROGRAM_REQUIRED');
    expect(h.deletions).toEqual([]);
    expect(mockPrograms).toEqual([]);
  });
  it('fails closed when a captured membership changes and skips already missing rows on retry', async () => {
    const h = fakeFirestore();
    const first = 'sermons/a/sermonLists/root',
      changed = 'sermons/b/sermonLists/root';
    h.store.set(first, { value: 'before' });
    h.store.set(changed, { value: 'before' });
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    h.store.delete(first);
    h.store.set(changed, { value: 'after' });
    await expect(removeListDeletionMirrors(h.db, plan)).rejects.toThrow('PROOF_INVALID');
    expect(h.store.has(changed)).toBe(true);
    h.store.set(changed, { value: 'before' });
    await removeListDeletionMirrors(h.db, plan);
    await removeListDeletionMirrors(h.db, plan);
    expect(h.store.has(changed)).toBe(false);
  });
  it('uses the frozen plan rather than adopting changed rows on a provider retry', async () => {
    const h = fakeFirestore();
    const path = 'sermons/a/sermonLists/root';
    h.store.set(path, { value: 'before' });
    const first = await prepareListDeletionMirrors(h.db, input);
    h.store.set(path, { value: 'after' });
    await expect(prepareListDeletionMirrors(h.db, input)).rejects.toThrow('PROOF_INVALID');
    await expect(removeListDeletionMirrors(h.db, first)).rejects.toThrow('PROOF_INVALID');
  });
  it('falls back to the complete scan when optional collection-group indexes are absent', async () => {
    const h = fakeFirestore();
    h.setMissingIndex();
    h.store.set('sermons/a/sermonLists/root', { id: 'root', subsplashId: 'remote-root' });
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    await removeListDeletionMirrors(h.db, plan);
    expect(h.store.has('sermons/a/sermonLists/root')).toBe(false);
  });
  it('rejects forged chain IDs even if a mirror contains copied matching metadata', async () => {
    const h = fakeFirestore();
    await expect(
      prepareListDeletionMirrors(h.db, { ...input, firestoreListIds: [...input.firestoreListIds, 'foreign'] })
    ).rejects.toThrow('PROOF_INVALID');
    expect(h.deletions).toEqual([]);
  });
  it('deletes only preclaimed unchanged canonical children and rejects a late new child', async () => {
    const h = fakeFirestore(),
      path = 'lists/root/listItems/sermon';
    h.store.set(path, { title: 'before' });
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    h.store.set(path, { title: 'after' });
    await expect(deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc(path)])).rejects.toThrow('PROOF_INVALID');
    h.store.set('lists/root/listItems/new', {});
    await expect(deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/root/listItems/new')])).rejects.toThrow(
      'PROOF_INVALID'
    );
    h.store.set(path, { title: 'before' });
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc(path)]);
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc(path)]);
    expect(h.store.has(path)).toBe(false);
    expect(h.store.has('lists/root/listItems/new')).toBe(true);
  });
  it('cleans frozen sermon mirrors after canonical roots are gone while still requiring original private authority', async () => {
    const h = fakeFirestore(),
      path = 'sermons/a/sermonLists/root';
    h.store.set(path, {});
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/root'), h.db.doc('lists/overflow')]);
    await removeListDeletionMirrors(h.db, plan);
    expect(h.store.has(path)).toBe(false);
    h.store.set(path, {});
    h.store.get('durableJobIntents/job-1')!.generation = 2;
    h.store.get('durableJobs/job-1')!.generation = 2;
    await expect(removeListDeletionMirrors(h.db, plan)).rejects.toThrow('PROOF_INVALID');
    expect(h.store.has(path)).toBe(true);
  });
  it('supports post-DELETE legacy cleanup without creating private durable plans', async () => {
    mockJobId = undefined;
    const h = fakeFirestore();
    h.store.set('sermons/a/sermonLists/overflow', {});
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    expect([...h.store.keys()].some((path) => path.startsWith(LIST_DELETION_MIRROR_PLANS))).toBe(false);
    expect(h.deletions).toEqual([]);
    await removeListDeletionMirrors(h.db, plan);
    expect(h.store.has('sermons/a/sermonLists/overflow')).toBe(false);
    expect(mockFences).toBe(0);
  });
  it('atomically binds root removal to its original intent and rejects a different activity or workflow', async () => {
    const h = fakeFirestore();
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan, 'rejected_no_effect');
    const intent = h.store.get('durableJobIntents/job-1')!;
    const execution = {
      workflowId: 'workflow-1',
      runId: 'run',
      activityId: '1',
      activityType: 'executePublishingEntityActivity',
      scheduledAt: 1,
      attempt: 1,
    };
    await expect(validateDeletedListCleanup(h.db, intent as any, execution)).rejects.toThrow('PROOF_INVALID');
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/root')]);
    await expect(validateDeletedListCleanup(h.db, intent as any, execution)).resolves.toEqual({ ownerId: 'publisher' });
    await expect(
      validateDeletedListCleanup(h.db, intent as any, { ...execution, activityType: 'maintenance' })
    ).rejects.toThrow('PROOF_INVALID');
    await expect(
      validateDeletedListCleanup(h.db, intent as any, { ...execution, workflowId: 'other' })
    ).rejects.toThrow('PROOF_INVALID');
  });
  it('fresh GET evidence cannot release an unknown original DELETE', async () => {
    const h = fakeFirestore();
    const plan = await prepareListDeletionMirrors(h.db, input);
    await expect(completedProviderDeletes(h, plan, 'unknown')).rejects.toThrow();
    await expect(deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/root')])).rejects.toThrow(
      'PROOF_INVALID'
    );
    expect(h.store.has('lists/root')).toBe(true);
  });

  it('binds the checkpoint to the requested overflow entity rather than a different physical root', async () => {
    const h = fakeFirestore();
    const intent = h.store.get('durableJobIntents/job-1')!;
    intent.entity = { type: 'list', id: 'overflow' };
    intent.payload.entity = intent.entity;
    intent.payload.payload.input.listId = 'overflow';
    h.store.set('durableJobs/job-1', { ...intent, state: 'running', workflowId: 'workflow-1' });
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/root')]);
    expect(h.store.get(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`)?.rootRemoval).toBeUndefined();
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/overflow')]);
    const execution = {
      workflowId: 'workflow-1',
      runId: 'run',
      activityId: '1',
      activityType: 'cleanupCancelledPublishingEntity',
      scheduledAt: 1,
      attempt: 1,
    };
    await expect(validateDeletedListCleanup(h.db, intent as any, execution)).resolves.toEqual({ ownerId: 'publisher' });
  });
  it('captures local-only deletion and rejects roots removed without the atomic checkpoint', async () => {
    const h = fakeFirestore();
    h.store.set('lists/root', {});
    h.store.delete('lists/overflow');
    const plan = await prepareListDeletionMirrors(h.db, {
      rootListId: 'root',
      firestoreListIds: ['root'],
      remoteListIds: [],
    });
    await recordListDeletionProviderAbsence(h.db, plan);
    const intent = h.store.get('durableJobIntents/job-1')!;
    const execution = {
      workflowId: 'workflow-1',
      runId: 'run',
      activityId: '1',
      activityType: 'executePublishingEntityActivity',
      scheduledAt: 1,
      attempt: 1,
    };
    h.store.delete('lists/root');
    await expect(validateDeletedListCleanup(h.db, intent as any, execution)).rejects.toThrow('PROOF_INVALID');
    h.store.set('lists/root', {});
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/root')]);
    await expect(validateDeletedListCleanup(h.db, intent as any, execution)).resolves.toEqual({ ownerId: 'publisher' });
  });

  it('resumes factual canonical cleanup after root removal without provider replay, then seals final completion', async () => {
    const h = fakeFirestore();
    h.store.set('lists/overflow/listItems/item', { id: 'item' });
    h.store.set('sermons/a/sermonLists/root', { id: 'root' });
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/root')]);
    const intent = h.store.get('durableJobIntents/job-1')!;
    const loaded = await loadFactualListDeletionCleanup(h.db, { projectId: 'urm-app', jobId: 'job-1' }, intent as any);
    expect(loaded.plan).toEqual(plan);
    expect(loaded.remainingCanonicalRefs.map((ref) => ref.path).sort()).toEqual([
      'lists/overflow',
      'lists/overflow/listItems/item',
    ]);
    await expect(h.db.runTransaction((tx) => validateListDeletionCompletion(tx, h.db, plan))).rejects.toThrow(
      'PROOF_INVALID'
    );
    await expect(sealListDeletionCompletion(h.db, plan)).rejects.toThrow('PROOF_INVALID');
    await removeListDeletionMirrors(h.db, plan);
    await deleteListDeletionCanonicalPage(h.db, plan, loaded.remainingCanonicalRefs);
    await sealListDeletionCompletion(h.db, plan);
    await h.db.runTransaction((tx) => validateListDeletionCompletion(tx, h.db, plan));
    const repeated = await loadFactualListDeletionCleanup(
      h.db,
      { projectId: 'urm-app', jobId: 'job-1' },
      intent as any
    );
    expect(repeated.remainingCanonicalRefs).toEqual([]);
    await sealListDeletionCompletion(h.db, plan);
    expect(h.store.get(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`)?.completion.inventoryCount).toBe(4);
  });
  it('rejects mismatched intent scope, missing inventory proof, changed generation, and new uncaptured children after root removal', async () => {
    const h = fakeFirestore();
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/root')]);
    const intent = h.store.get('durableJobIntents/job-1')!;
    await expect(
      loadFactualListDeletionCleanup(h.db, { projectId: 'urm-app', jobId: 'wrong' }, intent as any)
    ).rejects.toThrow('PROOF_INVALID');
    const header = h.store.get(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`)!,
      digest = header.inventoryDigest;
    delete header.inventoryDigest;
    await expect(
      loadFactualListDeletionCleanup(h.db, { projectId: 'urm-app', jobId: 'job-1' }, intent as any)
    ).rejects.toThrow('PROOF_INVALID');
    header.inventoryDigest = digest;
    h.store.get('durableJobs/job-1')!.generation = 2;
    await expect(
      loadFactualListDeletionCleanup(h.db, { projectId: 'urm-app', jobId: 'job-1' }, intent as any)
    ).rejects.toThrow('PROOF_INVALID');
    h.store.get('durableJobs/job-1')!.generation = 1;
    h.store.set('lists/overflow/listItems/new', { id: 'new' });
    await expect(
      loadFactualListDeletionCleanup(h.db, { projectId: 'urm-app', jobId: 'job-1' }, intent as any)
    ).rejects.toThrow('PROOF_INVALID');
  });
  it('critical ACK repair constructs missing absence checkpoint and root removal atomically; unknown cannot use matching GET', async () => {
    const h = fakeFirestore();
    const plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    const { providerMutationFingerprint: hash } = await import('../temporal/publishing/providerMutationGuard');
    const { acknowledgedProjectionDigest: digest } = await import('../temporal/publishing/criticalAcknowledgedRepair');
    const scope = { projectId: 'urm-app', jobId: 'job-1', operation: 'delete-all-lists' },
      sessionId = hash(scope),
      source = h.store.get(`temporalPublishingAcknowledgedProjections/${sessionId}`)!;
    const header = h.store.get(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
    delete header.providerAbsence;
    for (const path of [...h.store.keys()])
      if (path.startsWith(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}/providerAbsences/`)) h.store.delete(path);
    const requests = mockPrograms[0].requests,
      inputProof = {
        ref: { projectId: 'urm-app', jobId: 'job-1' },
        sessionId,
        listId: 'root',
        projectionDigest: digest(source),
        requests,
        acknowledgedSteps: requests.map((request: any) => request.step),
        observations: plan.remoteListIds.map((resourceId) => ({
          provider: 'subsplash' as const,
          account: 'app:9XTSHD',
          resourceType: 'list' as const,
          resourceId,
          state: 'absent' as const,
        })),
      };
    const claimed = h.store.get(`temporalProviderMutationSessions/${sessionId}/requests/${hash(requests[0].step)}`)!;
    claimed.state = 'unknown';
    await expect(
      h.db.runTransaction((tx) => prepareListRootRemovalCheckpointFromAcknowledgedRepair(tx, h.db, inputProof))
    ).rejects.toThrow();
    expect(h.store.has('lists/root')).toBe(true);
    expect(header.rootRemoval).toBeUndefined();
    claimed.state = 'acknowledged';
    await h.db.runTransaction(async (tx) => {
      const commit = await prepareListRootRemovalCheckpointFromAcknowledgedRepair(tx, h.db, inputProof);
      tx.delete(h.db.doc('lists/root'));
      commit();
    });
    const intent = h.store.get('durableJobIntents/job-1')!;
    expect(
      (await loadFactualListDeletionCleanup(h.db, inputProof.ref, intent as any)).remainingCanonicalRefs.map(
        (ref) => ref.path
      )
    ).toEqual(['lists/overflow']);
  });

  it('real READY candidate plus paged verified absences mints the list root checkpoint; READY alone never proves absence', async () => {
    const h = fakeFirestore(),
      plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    const guard = await import('../temporal/publishing/providerMutationGuard'),
      source = await import('../temporal/publishing/criticalAcknowledgedRepair'),
      compiler = await import('../temporal/publishing/acknowledgedRepairCandidate');
    const scope = { projectId: 'urm-app', jobId: 'job-1', operation: 'delete-all-lists' },
      sessionId = guard.providerMutationFingerprint(scope),
      held = h.store.get(`temporalProviderMutationSessions/${sessionId}`)!,
      session = { db: h.db, id: sessionId, scope, resources: held.resources };
    const claims = [...h.store.entries()].filter(
      ([path]) =>
        path.startsWith(`temporalProviderMutationSessions/${sessionId}/requests/`) ||
        path.startsWith('temporalProviderMutationFacts/')
    );
    for (const [path] of claims) h.store.delete(path);
    for (const path of [...h.store.keys()])
      if (
        path === `temporalPublishingAcknowledgedProjections/${sessionId}` ||
        path.startsWith(`temporalPublishingAcknowledgedProjections/${sessionId}/`)
      )
        h.store.delete(path);
    for (const program of mockPrograms)
      await h.db.runTransaction(async (tx) => {
        const prepared = await source.prepareAcknowledgedProjectionPlan(tx, session, program);
        prepared.commit();
      });
    for (const [path, value] of claims) h.store.set(path, value);
    const header = h.store.get(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
    delete header.providerAbsence;
    for (const path of [...h.store.keys()])
      if (path.startsWith(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}/providerAbsences/`)) h.store.delete(path);
    const ref = { projectId: 'urm-app', jobId: 'job-1' },
      store = {
        commitCurrent: async <T>(_ref: unknown, mutate: (tx: any) => Promise<T>) => h.db.runTransaction(mutate),
      };
    let candidate = await compiler.compileAcknowledgedRepairCandidatePage(h.db, ref, sessionId, store);
    for (let page = 0; candidate.state !== 'ready' && page < 100; page++)
      candidate = await compiler.compileAcknowledgedRepairCandidatePage(h.db, ref, sessionId, store);
    expect(candidate.state).toBe('ready');
    const checkpoint = {
      ref,
      sessionId,
      listId: 'root',
      projectionDigest: candidate.sourceRootDigest,
      candidateId: candidate.candidateId,
      candidateDigest: candidate.candidateDigest!,
      observationScope: 'certificate/sdk/current',
    };
    await expect(
      h.db.runTransaction((tx) => prepareListRootRemovalCheckpointFromAcknowledgedRepair(tx, h.db, checkpoint))
    ).rejects.toThrow();
    expect(h.store.has('lists/root')).toBe(true);
    expect(header.rootRemoval).toBeUndefined();
    const operation = {
      kind: 'acknowledged_projection' as const,
      sessionId,
      projectionDigest: candidate.sourceRootDigest,
    };
    for (let page = 0; h.store.has('lists/root') && page < 100; page++) {
      const required = await h.db.runTransaction((tx) =>
        source.readAcknowledgedRepairRequiredVerifications(tx, h.db, ref, operation, {
          observationScope: checkpoint.observationScope,
        })
      );
      const observations = required.verifications.map((verification) => ({
        provider: verification.provider,
        account: verification.account,
        resourceType: verification.resourceType,
        resourceId: verification.resourceId,
        state: 'absent' as const,
      }));
      await h.db.runTransaction((tx) =>
        source.commitAcknowledgedRepair(tx, h.db, ref, operation, observations, {
          observationScope: checkpoint.observationScope,
        })
      );
    }
    expect(h.store.has('lists/root')).toBe(false);
    expect(h.store.get(`temporalProviderMutationSessions/${sessionId}`)?.effectsClosed).toBe(true);
    expect(h.store.get(`temporalProviderMutationSessions/${sessionId}`)?.state).toBe('active');
    const persisted = h.store.get(`${LIST_DELETION_MIRROR_PLANS}/${plan.planId}`)!;
    expect(persisted.providerAbsence.candidateId).toBe(candidate.candidateId);
    expect(persisted.providerAbsence.programId).toMatch(/^[a-f0-9]{64}$/);
    const intent = h.store.get('durableJobIntents/job-1')!;
    expect(
      (await loadFactualListDeletionCleanup(h.db, ref, intent as any)).remainingCanonicalRefs.map((ref) => ref.path)
    ).toEqual(['lists/overflow']);
  });

  it('cannot mint transport closure retroactively after root removal', async () => {
    const h = fakeFirestore(),
      plan = await prepareListDeletionMirrors(h.db, input);
    await completedProviderDeletes(h, plan);
    await deleteListDeletionCanonicalPage(h.db, plan, [h.db.doc('lists/root')]);
    const guard = await import('../temporal/publishing/providerMutationGuard'),
      source = await import('../temporal/publishing/criticalAcknowledgedRepair'),
      scope = { projectId: 'urm-app', jobId: 'job-1', operation: 'delete-all-lists' },
      sessionId = guard.providerMutationFingerprint(scope),
      held = h.store.get(`temporalProviderMutationSessions/${sessionId}`)!;
    expect(held.effectsClosed).toBe(true);
    held.effectsClosed = false;
    const ref = { projectId: 'urm-app', jobId: 'job-1' },
      intent = h.store.get('durableJobIntents/job-1')!,
      requests = mockPrograms[0].requests;
    await expect(loadFactualListDeletionCleanup(h.db, ref, intent as any)).rejects.toThrow('PROOF_INVALID');
    await expect(
      h.db.runTransaction((tx) =>
        prepareListRootRemovalCheckpointFromAcknowledgedRepair(tx, h.db, {
          ref,
          sessionId,
          listId: 'root',
          projectionDigest: source.acknowledgedProjectionDigest(
            h.store.get(`temporalPublishingAcknowledgedProjections/${sessionId}`)
          ),
          requests,
          acknowledgedSteps: requests.map((request: any) => request.step),
          observations: plan.remoteListIds.map((resourceId) => ({
            provider: 'subsplash' as const,
            account: 'app:9XTSHD',
            resourceType: 'list' as const,
            resourceId,
            state: 'absent' as const,
          })),
        })
      )
    ).rejects.toThrow('PROOF_INVALID');
    expect(h.store.get(`temporalProviderMutationSessions/${sessionId}`)?.effectsClosed).toBe(false);
    expect(h.store.has('lists/root')).toBe(false);
  });
});
