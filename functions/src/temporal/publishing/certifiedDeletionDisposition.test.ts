import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { acquireCertifiedPublishingDeletionSession, executeCertifiedPublishingDeletion } from './criticalDeletionGuard';
import {
  certifiedDeletionDispositionDigest as digest,
  prepareCertifiedDeletionDisposition,
  validateCertifiedDeletionDisposition,
  CERTIFIED_DELETION_DISPOSITIONS,
} from './certifiedDeletionDisposition';
import {
  providerMutationFingerprint as hash,
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
} from './providerMutationGuard';

function storeFixture() {
  const records = new Map<string, Record<string, any>>();
  const reference = (path: string): any => ({
    path,
    id: path.split('/').at(-1),
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string, states?: string[]): any => ({
    path,
    query: true,
    states,
    doc: (name: string) => reference(`${path}/${name}`),
    where: (_field: string, _operator: string, values: string[]) => collection(path, values),
    limit: () => collection(path, states),
  });
  const snapshot = (ref: any) => ({
    ref,
    id: ref.id,
    exists: records.has(ref.path),
    data: () => records.get(ref.path),
    get: (key: string) => records.get(ref.path)?.[key],
  });
  const runTransaction = async <T>(mutate: (tx: Transaction) => Promise<T>) => {
    const writes: Array<{ kind: string; ref: any; data: any }> = [];
    const read = () => {
      if (writes.length) throw Error('read after write');
    };
    const tx = {
      get: async (ref: any) => {
        read();
        if (!ref.query) return snapshot(ref);
        const docs = [...records.keys()]
          .filter(
            (path) =>
              path.startsWith(`${ref.path}/`) &&
              !path.slice(ref.path.length + 1).includes('/') &&
              (!ref.states || ref.states.includes(records.get(path)!.state))
          )
          .map((path) => snapshot(reference(path)));
        return { docs, size: docs.length, empty: !docs.length };
      },
      getAll: async (...refs: any[]) => {
        read();
        return refs.map(snapshot);
      },
      create: (ref: any, data: any) => writes.push({ kind: 'create', ref, data }),
      set: (ref: any, data: any) => writes.push({ kind: 'set', ref, data }),
      update: (ref: any, data: any) => writes.push({ kind: 'update', ref, data }),
    } as unknown as Transaction;
    const result = await mutate(tx);
    for (const write of writes) {
      if (write.kind === 'create' && records.has(write.ref.path)) throw Error('exists');
      records.set(
        write.ref.path,
        write.kind === 'update' ? { ...records.get(write.ref.path), ...write.data } : write.data
      );
    }
    return result;
  };
  const db = { collection, doc: reference, runTransaction } as unknown as Firestore;
  return { records, db, runTransaction };
}
async function fixture(status = 204) {
  const f = storeFixture(),
    ref = { projectId: 'test', jobId: 'job' },
    certificateId = hash('cert'),
    generation = 1;
  const target = {
    provider: 'subsplash' as const,
    account: 'app:9XTSHD',
    resourceType: 'media',
    resourceId: 'original',
  };
  const scope = { ...ref, operation: 'sermon.delete:original' },
    originalSessionId = hash(scope),
    intentFingerprint = hash('intent');
  const originalRequest = {
    step: 'delete:subsplash:original',
    method: 'DELETE' as const,
    target,
    payload: { id: 'original' },
    fingerprint: hash(['DELETE', { target, body: { id: 'original' } }]),
  };
  f.records.set(`${PROVIDER_MUTATION_SESSIONS}/${originalSessionId}`, {
    schemaVersion: 1,
    scope,
    resources: [target],
    resourceKeys: [hash([ref.projectId, target.provider, target.account, target.resourceId])],
    state: 'aborted',
    abortedAtMillis: 7,
  });
  const fragment = {
    schemaVersion: 1,
    ...ref,
    sessionId: originalSessionId,
    operation: scope.operation,
    intentFingerprint,
    requests: [originalRequest],
    writes: [],
    verifications: [],
    finalFragment: true,
  };
  const pageDigest = digest(fragment),
    projection = `temporalPublishingAcknowledgedProjections/${originalSessionId}`;
  f.records.set(projection, {
    schemaVersion: 2,
    ...ref,
    sessionId: originalSessionId,
    operation: scope.operation,
    intentFingerprint,
    pageCount: 1,
    requestCount: 1,
    chainDigest: hash('chain'),
    completesActivity: false,
    uiStepIds: [],
  });
  f.records.set(`${projection}/requestIndex/${hash(originalRequest.step)}`, {
    request: originalRequest,
    intentFingerprint,
    pageDigest,
    readyPageDigest: pageDigest,
    ready: true,
  });
  f.records.set(`${projection}/pages/${pageDigest}`, fragment);
  const sourceHeader = {
    headerPath: `temporalSermonDeletionMirrorPlans/${hash('header')}`,
    headerDigest: hash('immutable header'),
    sourceProgramDigest: hash('program'),
    intentFingerprint,
    generation,
    workflowId: 'workflow',
  };
  f.records.set(sourceHeader.headerPath, {
    ...ref,
    generation,
    workflowId: sourceHeader.workflowId,
    intentFingerprint,
  });
  const absence = {
    schemaVersion: 1,
    ...ref,
    certificateId,
    generation,
    target,
    state: 'absent',
    originalHttpStatus: 404,
    proof: 'authenticated_fixed_id_get_404_410',
    originalAccount: target.account,
    ownershipConfirmedBeforeDelete: true,
    observationScope: hash('SDK observation'),
  };
  const fixedAbsence = {
    proofPath: `temporalPublishingCriticalDeletionAbsences/${hash('absence')}`,
    proofDigest: digest(absence),
    observationScope: absence.observationScope,
  };
  f.records.set(fixedAbsence.proofPath, absence);
  const operation = {
    kind: 'provider_delete' as const,
    method: 'DELETE' as const,
    provider: 'subsplash' as const,
    resourceType: 'media' as const,
    resourceId: target.resourceId,
    accountId: target.account,
  };
  const authorizeInTransaction = jest.fn(async () => {});
  const lease = await acquireCertifiedPublishingDeletionSession({
    db: f.db,
    ref,
    certificateId,
    generation,
    operations: [operation],
    transactionRunner: f.runTransaction,
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
    executionId: hash('SDK execution'),
    transactionRunner: f.runTransaction,
    authorizeInTransaction,
    sendOriginalDelete: async () => ({ status }),
  });
  const input = {
    ref,
    certificateId,
    generation,
    originalSessionId,
    originalRequest,
    certifiedHandle,
    authorizeInTransaction,
    validateSourceHeaderInTransaction: async () => sourceHeader,
    validateFixedAbsenceInTransaction: async () => fixedAbsence,
  };
  return { ...f, input, sourceHeader, fixedAbsence, projection };
}

describe('qualified original NoSEND certified deletion disposition', () => {
  test.each([200, 204, 404, 410])(
    'original certified %i can prove cleanup without forging the old ACK',
    async (status) => {
      const f = await fixture(status);
      const prepared = await f.runTransaction(async (tx) => {
        const result = await prepareCertifiedDeletionDisposition(tx, f.db, f.input);
        result.commit();
        return result;
      });
      const proof = await f.runTransaction((tx) => validateCertifiedDeletionDisposition(tx, f.db, f.input));
      expect(proof?.kind).toBe('certified_fixed_delete_original_nosend');
      expect(proof?.digest).toBe(prepared.digest);
      expect(proof?.disposition.completion).toBe(status < 400 ? 'acknowledged' : 'rejected_no_effect');
      expect(
        [...f.records.keys()].filter((path) =>
          path.startsWith(`${PROVIDER_MUTATION_SESSIONS}/${f.input.originalSessionId}/requests/`)
        )
      ).toHaveLength(0);
      expect([...f.records.keys()].filter((path) => path.startsWith(`${PROVIDER_MUTATION_FACTS}/`))).toHaveLength(1);
      expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${f.input.originalSessionId}`)?.state).toBe('aborted');
    }
  );
  test.each(['active', 'committed'])('original session %s cannot qualify or release its ownership', async (state) => {
    const f = await fixture();
    f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${f.input.originalSessionId}`)!.state = state;
    await expect(
      f.runTransaction((tx) => prepareCertifiedDeletionDisposition(tx, f.db, f.input))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
    expect([...f.records.keys()].some((path) => path.startsWith(`${CERTIFIED_DELETION_DISPOSITIONS}/`))).toBe(false);
  });
  test.each(['sending', 'unknown', 'acknowledged', 'rejected_no_effect'])(
    'any existing original %s request remains outside zero-request protocol',
    async (state) => {
      const f = await fixture();
      f.records.set(
        `${PROVIDER_MUTATION_SESSIONS}/${f.input.originalSessionId}/requests/${hash(f.input.originalRequest.step)}`,
        { state }
      );
      await expect(
        f.runTransaction((tx) => prepareCertifiedDeletionDisposition(tx, f.db, f.input))
      ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
    }
  );
  test('unsealed original source request cannot qualify', async () => {
    const f = await fixture();
    f.records.get(`${f.projection}/requestIndex/${hash(f.input.originalRequest.step)}`)!.ready = false;
    await expect(
      f.runTransaction((tx) => prepareCertifiedDeletionDisposition(tx, f.db, f.input))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
  });
  test('source generation change cannot qualify', async () => {
    const f = await fixture();
    f.records.get(f.sourceHeader.headerPath)!.generation = 2;
    await expect(
      f.runTransaction((tx) => prepareCertifiedDeletionDisposition(tx, f.db, f.input))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
  });
  test('missing or changed immutable fixed absence proof blocks mint and replay', async () => {
    const f = await fixture();
    await f.runTransaction(async (tx) => {
      const result = await prepareCertifiedDeletionDisposition(tx, f.db, f.input);
      result.commit();
    });
    f.records.get(f.fixedAbsence.proofPath)!.state = 'present';
    await expect(
      f.runTransaction((tx) => validateCertifiedDeletionDisposition(tx, f.db, f.input))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
  });
  test('revoked exact grant cannot mint a disposition', async () => {
    const f = await fixture();
    await expect(
      f.runTransaction((tx) =>
        prepareCertifiedDeletionDisposition(tx, f.db, {
          ...f.input,
          authorizeInTransaction: async () => {
            throw Error('grant revoked');
          },
        })
      )
    ).rejects.toThrow('grant revoked');
  });
  test('certified original fact tampering cannot qualify', async () => {
    const f = await fixture(),
      fact = [...f.records.entries()].find(([path]) => path.startsWith(`${PROVIDER_MUTATION_FACTS}/`))![1];
    fact.claim = 'changed';
    await expect(
      f.runTransaction((tx) => prepareCertifiedDeletionDisposition(tx, f.db, f.input))
    ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  });
  test('unsupported original synchronous status cannot qualify even with matching cached result', async () => {
    const f = await fixture();
    const request = [...f.records.entries()].find(([path]) =>
      path.startsWith(`${PROVIDER_MUTATION_SESSIONS}/${f.input.certifiedHandle.session.id}/requests/`)
    )![1];
    const fact = [...f.records.entries()].find(([path]) => path.startsWith(`${PROVIDER_MUTATION_FACTS}/`))![1];
    request.result = { originalHttpStatus: 202 };
    fact.result = request.result;
    await expect(
      f.runTransaction((tx) => prepareCertifiedDeletionDisposition(tx, f.db, f.input))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
  });
  test.each(['account', 'target', 'generation', 'status', 'certificate', 'scope'])(
    'a freshly hashed but incorrect absence %s proof cannot qualify',
    async (kind) => {
      const f = await fixture(),
        record = f.records.get(f.fixedAbsence.proofPath)!;
      if (kind === 'account') record.originalAccount = 'app:OTHER';
      if (kind === 'target') record.target = { ...record.target, resourceId: 'different' };
      if (kind === 'generation') record.generation = 2;
      if (kind === 'status') record.originalHttpStatus = 200;
      if (kind === 'certificate') record.certificateId = hash('different');
      if (kind === 'scope') record.observationScope = hash('different SDK');
      await expect(
        f.runTransaction((tx) =>
          prepareCertifiedDeletionDisposition(tx, f.db, {
            ...f.input,
            validateFixedAbsenceInTransaction: async () => ({ ...f.fixedAbsence, proofDigest: digest(record) }),
          })
        )
      ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
    }
  );
  test('same source disposition is idempotent and remains a separate private record', async () => {
    const f = await fixture();
    const first = await f.runTransaction(async (tx) => {
      const proof = await prepareCertifiedDeletionDisposition(tx, f.db, f.input);
      proof.commit();
      return proof;
    });
    const again = await f.runTransaction(async (tx) => {
      const proof = await prepareCertifiedDeletionDisposition(tx, f.db, f.input);
      proof.commit();
      return proof;
    });
    expect(again.digest).toBe(first.digest);
    expect([...f.records.keys()].filter((path) => path.startsWith(`${CERTIFIED_DELETION_DISPOSITIONS}/`))).toHaveLength(
      1
    );
  });

  test('a new certified UNKNOWN cannot qualify even when fixed absence is known', async () => {
    const f = await fixture();
    const request = [...f.records.entries()].find(([path]) =>
      path.startsWith(`${PROVIDER_MUTATION_SESSIONS}/${f.input.certifiedHandle.session.id}/requests/`)
    )![1];
    request.state = 'unknown';
    await expect(
      f.runTransaction((tx) => prepareCertifiedDeletionDisposition(tx, f.db, f.input))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
    expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${f.input.certifiedHandle.session.id}`)?.state).toBe('active');
  });
  test('certified ownership must still be held when minting source disposition', async () => {
    const f = await fixture();
    const lock = [...f.records.entries()].find(([path]) => path.startsWith('temporalProviderMutationLocks/'))![1];
    lock.sessionId = hash('other holder');
    await expect(
      f.runTransaction((tx) => prepareCertifiedDeletionDisposition(tx, f.db, f.input))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
  });
  test('a prematurely committed certified session cannot mint missing source disposition', async () => {
    const f = await fixture();
    f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${f.input.certifiedHandle.session.id}`)!.state = 'committed';
    await expect(
      f.runTransaction((tx) => prepareCertifiedDeletionDisposition(tx, f.db, f.input))
    ).rejects.toMatchObject({ code: 'PUBLISHING_CERTIFIED_DELETION_DISPOSITION_REQUIRED' });
  });

  test('restart validates fresh absence while preserving the original immutable disposition digest', async () => {
    const f = await fixture();
    const first = await f.runTransaction(async (tx) => {
      const proof = await prepareCertifiedDeletionDisposition(tx, f.db, f.input);
      proof.commit();
      return proof;
    });
    const proofPath = `temporalPublishingCriticalDeletionAbsences/${hash('new SDK absence')}`;
    const record = { ...f.records.get(f.fixedAbsence.proofPath), observationScope: hash('new SDK observation') };
    f.records.set(proofPath, record);
    const again = await f.runTransaction(async (tx) => {
      const proof = await prepareCertifiedDeletionDisposition(tx, f.db, {
        ...f.input,
        validateFixedAbsenceInTransaction: async () => ({
          proofPath,
          proofDigest: digest(record),
          observationScope: record.observationScope,
        }),
      });
      proof.commit();
      return proof;
    });
    expect(again.digest).toBe(first.digest);
    const stored = f.records.get(`${CERTIFIED_DELETION_DISPOSITIONS}/${first.dispositionId}`)!;
    expect(stored.disposition.fixedAbsence.proofPath).toBe(f.fixedAbsence.proofPath);
  });
});
