jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'urm-app' } }) },
}));
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { prepareListDeletionReady, readListDeletionReadyCompletion, LIST_DELETION_READY } from './listDeletionReady';
import { LIST_DELETION_MIRROR_PLANS, type ListDeletionMirrorPlan } from './listDeletionMirrors';
import {
  acknowledgedProjectionDigest as hash,
  ACKNOWLEDGED_PROJECTION_PLANS,
} from '../temporal/publishing/criticalAcknowledgedRepair';
import {
  providerMutationFingerprint,
  providerMutationClaimSetSeed,
  providerMutationClaimSetFold,
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
  type ProviderMutationClosedEvidenceSeal,
} from '../temporal/publishing/providerMutationGuard';
import { providerPayloadFingerprint } from '../temporal/publishing/providerReceipts';
import { publishingMutationRequestFingerprint } from '../temporal/publishing/durableOperationContext';
import {
  desiredProviderDeletionIntentFingerprint,
  desiredProviderDeletionDocumentFingerprint,
} from '../../../packages/orchestration/src/provider-usage';
const ref = { projectId: 'urm-app', jobId: 'job' };
type Data = Record<string, any>;
function fakeFirestore() {
  const store = new Map<string, Data>();
  const deletions: string[][] = [];
  const requestLimits: number[] = [];
  const writePaths: string[] = [];
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
    get: (key: string) => {
      const value = key.split('.').reduce((current, part) => current?.[part], store.get(path));
      return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    },
  });
  const query = (
    path: string,
    group: boolean,
    predicates: Array<[string, string, unknown]> = [],
    cursor = '',
    limit = Infinity
  ): any => ({
    _query: true,
    doc: (id: string) => doc(`${path}/${id}`),
    where: (field: string, operator: string, value: unknown) =>
      query(path, group, [...predicates, [field, operator, value]], cursor, limit),
    orderBy: () => query(path, group, predicates, cursor, limit),
    limit: (value: number) => query(path, group, predicates, cursor, value),
    startAfter: (value: any) =>
      query(path, group, predicates, typeof value === 'string' ? `${path}/${value}` : value.ref.path, limit),
    count: () => ({
      _aggregate: true,
      pathPrefix: path + '/',
      countValue: () =>
        [...store.keys()].filter(
          (key) => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1
        ).length,
    }),
    get: async () => {
      if (path.endsWith('/requests') && limit !== Infinity) requestLimits.push(limit);
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
            predicates.every(([field, operator, value]) =>
              operator === 'in' && Array.isArray(value)
                ? value.includes(snapshot(key).get(field))
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
          return ref._aggregate
            ? { data: () => ({ count: ref.countValue() }) }
            : ref._query
            ? ref.get()
            : snapshot(ref.path);
        },
        getAll: async (...refs: any[]) => {
          if (writing) throw new Error('Read after write');
          return refs.map((ref) => snapshot(ref.path));
        },
        create: (ref: any, data: Data) => {
          writePaths.push(ref.path);
          writing = true;
          writes.push(() => {
            if (store.has(ref.path)) throw new Error('Already exists');
            store.set(ref.path, structuredClone(data));
          });
        },
        set: (ref: any, data: Data) => {
          writePaths.push(ref.path);
          writing = true;
          writes.push(() => store.set(ref.path, JSON.parse(JSON.stringify(data))));
        },
        update: (ref: any, data: Data) => {
          writePaths.push(ref.path);
          writing = true;
          writes.push(() => store.set(ref.path, { ...store.get(ref.path), ...structuredClone(data) }));
        },
        delete: (ref: any) => {
          writePaths.push(ref.path);
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
  return {
    db: db as Firestore,
    store,
    deletions,
    requestLimits,
    writePaths,
    setMissingIndex: () => {
      missingIndex = true;
    },
  };
}

function fixture(requestCount = 65, rowCount = 601) {
  const h = fakeFirestore(),
    plan: ListDeletionMirrorPlan = {
      ...ref,
      planId: 'plan',
      rootListId: 'root',
      firestoreListIds: ['root'],
      remoteListIds: Array.from({ length: requestCount }, (_, i) => `remote-${i}`),
    };
  const intent = {
    ...ref,
    actorUid: 'actor',
    kind: 'list.delete',
    generation: 1,
    entity: { type: 'list', id: 'root' },
    payload: {},
  };
  const operation = 'delete-list',
    scope = { ...ref, operation },
    sessionId = providerMutationFingerprint(scope),
    resources = plan.remoteListIds.map((resourceId) => ({
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: 'list',
      resourceId,
    }));
  h.store.set('durableJobIntents/job', intent);
  h.store.set('durableJobs/job', { ...intent, workflowId: 'workflow' });
  const header: Data = {
    ...ref,
    actorUid: 'actor',
    workflowId: 'workflow',
    entity: intent.entity,
    generation: 1,
    state: 'prepared',
    operation,
    plan,
    intentFingerprint: desiredProviderDeletionIntentFingerprint(intent),
    scopeFingerprint: desiredProviderDeletionDocumentFingerprint(plan),
    inventoryRevision: 1,
  };
  const headerDigest = hash({
    projectId: header.projectId,
    jobId: header.jobId,
    entity: header.entity,
    generation: header.generation,
    actorUid: header.actorUid,
    workflowId: header.workflowId,
    intentFingerprint: header.intentFingerprint,
    scopeFingerprint: header.scopeFingerprint,
    operation: header.operation,
  });
  let inventoryDigest = hash([]);
  for (let i = 0; i < rowCount; i++) {
    const id = String(i).padStart(16, '0'),
      row = {
        canonicalPath: i ? 'lists/root/listItems/item-' + i : 'lists/root',
        sourceFingerprint: hash(['row', i]),
        kind: 'canonical',
      };
    h.store.set(`${LIST_DELETION_MIRROR_PLANS}/plan/rows/${id}`, row);
    inventoryDigest = hash([inventoryDigest, id, row]);
    h.store.set(`${LIST_DELETION_MIRROR_PLANS}/plan/completedRows/${id}`, {
      canonicalPath: row.canonicalPath,
      rowDigest: hash(row),
      inventoryDigest: 'later',
      headerDigest,
    });
  }
  for (const [path, data] of h.store) if (path.includes('/completedRows/')) data.inventoryDigest = inventoryDigest;
  const original: Data[] = [];
  for (const target of resources) {
    const payload = { id: target.resourceId },
      step = `delete-logical-list:${target.resourceId}:${providerPayloadFingerprint(payload)}`,
      fingerprint = publishingMutationRequestFingerprint({ method: 'DELETE', target, payload }),
      request = { step, method: 'DELETE', target, payload, fingerprint };
    const page = {
      schemaVersion: 1,
      ...ref,
      sessionId,
      operation,
      intentFingerprint: hash(intent),
      requests: [request],
      writes: [],
      verifications: [],
      finalFragment: true,
    };
    const pageDigest = hash(page);
    h.store.set(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}/pages/${pageDigest}`, page);
    h.store.set(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}/requestIndex/${providerMutationFingerprint(step)}`, {
      request,
      pageDigest,
      readyPageDigest: pageDigest,
      ready: true,
      intentFingerprint: hash(intent),
    });
    const data = {
      step,
      method: 'DELETE',
      fingerprint,
      claim: 'claim-' + target.resourceId,
      executionId: 'execution-' + target.resourceId,
      state: 'acknowledged',
      result: null,
    };
    original.push({ requestId: providerMutationFingerprint(step), ...data });
    h.store.set(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}/requests/${providerMutationFingerprint(step)}`, data);
    h.store.set(`${PROVIDER_MUTATION_FACTS}/${providerMutationFingerprint([sessionId, step, data.claim])}`, {
      sessionId,
      step,
      fingerprint,
      claim: data.claim,
      executionId: data.executionId,
      completion: 'acknowledged',
      result: null,
    });
  }
  const projection = {
    schemaVersion: 2,
    ...ref,
    sessionId,
    operation,
    intentFingerprint: hash(intent),
    pageCount: requestCount,
    requestCount,
    chainDigest: hash('chain'),
    completesActivity: false,
    uiStepIds: [],
  };
  h.store.set(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`, projection);
  header.inventoryDigest = inventoryDigest;
  header.inventoryCount = rowCount;
  header.providerAbsence = {
    headerDigest,
    sourceRootDigest: hash(projection),
    sessionId,
    absenceDigest: hash('fixed absent'),
    localOnly: false,
  };
  header.rootRemoval = {
    entityId: 'root',
    headerDigest,
    inventoryDigest,
    providerAbsenceDigest: hash(header.providerAbsence),
  };
  header.completion = {
    inventoryDigest,
    inventoryCount: rowCount,
    headerDigest,
    providerAbsenceDigest: hash(header.providerAbsence),
    rootRemovalDigest: hash(header.rootRemoval),
  };
  h.store.set(`${LIST_DELETION_MIRROR_PLANS}/plan`, header);
  let claimSetDigest = providerMutationClaimSetSeed(sessionId);
  for (const claim of original.sort((a, b) => a.requestId.localeCompare(b.requestId)))
    claimSetDigest = providerMutationClaimSetFold(claimSetDigest, {
      requestId: claim.requestId,
      step: claim.step,
      method: 'DELETE',
      fingerprint: claim.fingerprint,
      claim: claim.claim,
      executionId: claim.executionId,
      state: 'acknowledged',
    });
  const session = { db: h.db, id: sessionId, scope, resources };
  h.store.set(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`, {
    scope,
    resources,
    state: 'active',
    effectsClosed: true,
    effectsClosedClaimSetDigestVersion: 2,
    effectsClosedClaimSetDigest: claimSetDigest,
    effectsClosedActualRequestCount: requestCount,
  });
  const seal: ProviderMutationClosedEvidenceSeal = {
    sessionId,
    claimSetDigest,
    claimSetDigestVersion: 2,
    actualRequestCount: requestCount,
    sourceDispositionValidated: true,
  };
  let commits = 0;
  const runner = {
    commitCurrent: async <T>(_ref: typeof ref, fn: (tx: Transaction) => Promise<T>): Promise<T> => {
      commits++;
      return (h.db as any).runTransaction(fn);
    },
  };
  return {
    ...h,
    plan,
    session,
    seal,
    header,
    runner,
    commits: () => commits,
    read: () =>
      (h.db as any).runTransaction((tx: Transaction) => readListDeletionReadyCompletion(tx, h.db, plan, session, seal)),
  };
}

describe('independent bounded list deletion completion', () => {
  it('streams 65 original claims and 601 completed inventory rows and returns actual structured proof', async () => {
    const h = fixture();
    await prepareListDeletionReady(h.db, ref, h.plan, h.runner);
    const proof = await h.read();
    expect(proof).toMatchObject({
      closedClaimSetDigest: h.seal.claimSetDigest,
      originalRequestCount: 65,
      expectedCanonicalPageCount: 601,
      completedCanonicalPageCount: 601,
    });
    expect(h.commits()).toBe(22);
    expect(h.requestLimits.every((limit) => limit <= 32)).toBe(true);
    expect(h.writePaths.every((path) => path.startsWith(LIST_DELETION_READY + '/'))).toBe(true);
  });
  it('rejects a forged completed row and never emits READY', async () => {
    const h = fixture(2, 2);
    h.store.get(`${LIST_DELETION_MIRROR_PLANS}/plan/completedRows/0000000000000001`)!.rowDigest = hash('forged');
    await expect(prepareListDeletionReady(h.db, ref, h.plan, h.runner)).rejects.toThrow(
      'LIST_DELETION_READY_PROOF_INVALID'
    );
    expect(
      [...h.store]
        .filter(([path]) => path.startsWith(LIST_DELETION_READY + '/'))
        .every(([, row]) => row.phase !== 'ready')
    ).toBe(true);
  });
  it('rejects an original unknown claim even when core closure exists', async () => {
    const h = fixture(2, 2),
      request = [...h.store].find(([path]) =>
        path.startsWith(`${PROVIDER_MUTATION_SESSIONS}/${h.session.id}/requests/`)
      )![1];
    request.state = 'unknown';
    await expect(prepareListDeletionReady(h.db, ref, h.plan, h.runner)).rejects.toThrow();
  });
  it('checks every canonical row is actually absent instead of trusting completion metadata', async () => {
    const h = fixture(2, 2);
    h.store.set('lists/root/listItems/item-1', { title: 'still present' });
    await expect(prepareListDeletionReady(h.db, ref, h.plan, h.runner)).rejects.toThrow(
      'LIST_DELETION_READY_PROOF_INVALID'
    );
  });
  it('does not copy a different core checksum into independent READY', async () => {
    const h = fixture(2, 2);
    await prepareListDeletionReady(h.db, ref, h.plan, h.runner);
    h.seal.claimSetDigest = hash('changed close');
    await expect(h.read()).rejects.toThrow('LIST_DELETION_READY_PROOF_INVALID');
  });
  it('revalidates immutable intent generation at final settlement', async () => {
    const h = fixture(2, 2);
    await prepareListDeletionReady(h.db, ref, h.plan, h.runner);
    h.store.get('durableJobIntents/job')!.generation = 2;
    await expect(h.read()).rejects.toThrow('LIST_DELETION_READY_PROOF_INVALID');
  });
  it('does not continue compiling after the current SDK fence is revoked', async () => {
    const h = fixture(33, 2);
    let calls = 0;
    const runner = {
      commitCurrent: async <T>(_ref: typeof ref, fn: (tx: Transaction) => Promise<T>): Promise<T> => {
        if (++calls > 1) throw new Error('SDK_REVOKED');
        return (h.db as any).runTransaction(fn);
      },
    };
    await expect(prepareListDeletionReady(h.db, ref, h.plan, runner)).rejects.toThrow('SDK_REVOKED');
    expect(
      [...h.store]
        .filter(([path]) => path.startsWith(LIST_DELETION_READY + '/'))
        .every(([, row]) => row.phase !== 'ready')
    ).toBe(true);
  });
  it('allows only the committed completion boolean transition without invalidating historical proof', async () => {
    const h = fixture(2, 2);
    await prepareListDeletionReady(h.db, ref, h.plan, h.runner);
    h.store.get(`${PROVIDER_MUTATION_SESSIONS}/${h.session.id}`)!.state = 'committed';
    h.store.get(`${ACKNOWLEDGED_PROJECTION_PLANS}/${h.session.id}`)!.completesActivity = true;
    expect(await h.read()).toMatchObject({ originalRequestCount: 2 });
    h.store.get(`${ACKNOWLEDGED_PROJECTION_PLANS}/${h.session.id}`)!.chainDigest = hash('changed');
    await expect(h.read()).rejects.toThrow('LIST_DELETION_READY_PROOF_INVALID');
  });
});
