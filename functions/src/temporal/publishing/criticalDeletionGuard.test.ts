import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  createCertifiedPublishingDeletionGuard,
  acquireCertifiedPublishingDeletionSession,
  executeCertifiedPublishingDeletion,
  prepareCertifiedPublishingDeletionEffectsClosed,
  prepareCertifiedPublishingDeletionFinalSettlement,
} from './criticalDeletionGuard';
import {
  providerMutationFingerprint,
  PROVIDER_MUTATION_FACTS,
  PROVIDER_MUTATION_SESSIONS,
} from './providerMutationGuard';

function fixture() {
  type Data = Record<string, any>;
  const records = new Map<string, Data>();
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
    const writes: Array<{ kind: string; ref: any; data: Data }> = [];
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
      create: (ref: any, data: Data) => writes.push({ kind: 'create', ref, data }),
      set: (ref: any, data: Data) => writes.push({ kind: 'set', ref, data }),
      update: (ref: any, data: Data) => writes.push({ kind: 'update', ref, data }),
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
  const authorizeInTransaction = jest.fn(async () => {});
  const input = {
    db,
    ref: { projectId: 'test', jobId: 'job' },
    certificateId: providerMutationFingerprint('cert'),
    generation: 1,
    operation: {
      kind: 'provider_delete' as const,
      method: 'DELETE' as const,
      provider: 'subsplash' as const,
      resourceType: 'media' as const,
      resourceId: 'original',
      accountId: 'app:9XTSHD',
    },
    executionId: 'sdk-execution',
    transactionRunner: runTransaction,
    authorizeInTransaction,
  };
  return { records, input, runTransaction, authorizeInTransaction };
}

async function execute(
  input: Parameters<typeof executeCertifiedPublishingDeletion>[0] extends infer I ? Omit<I & {}, 'lease'> : never
) {
  const lease = await acquireCertifiedPublishingDeletionSession({
    ...input,
    operations: [input.operation],
    validateCompletePlanInTransaction: async () => {},
  });
  return executeCertifiedPublishingDeletion({ ...input, lease });
}

describe('certified fixed deletion guard with real original fact storage', () => {
  test.each([200, 204, 404, 410])('original %i seals actual fact and replay never sends again', async (status) => {
    const f = fixture(),
      sendOriginalDelete = jest.fn(async () => ({ status }));
    const first = await execute({ ...f.input, sendOriginalDelete });
    expect(first.completion).toBe(status < 400 ? 'acknowledged' : 'rejected_no_effect');
    const facts = [...f.records.entries()].filter(([path]) => path.startsWith(`${PROVIDER_MUTATION_FACTS}/`));
    expect(facts).toHaveLength(1);
    expect(facts[0][1].completion).toBe(first.completion);
    if (status >= 400)
      expect(facts[0][1].evidence).toEqual({
        transport: 'original_http_response',
        status,
        providerCode: 'fixed_resource_absent',
      });
    expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${first.session.id}`)?.state).toBe('active');
    const replay = await execute({ ...f.input, executionId: 'next-sdk-execution', sendOriginalDelete });
    expect(replay.completion).toBe(first.completion);
    expect(sendOriginalDelete).toHaveBeenCalledTimes(1);
  });
  test('lost original response remains unknown and retries never send or mint evidence', async () => {
    const f = fixture(),
      sendOriginalDelete = jest.fn(async () => {
        throw Error('network lost');
      });
    await expect(execute({ ...f.input, sendOriginalDelete })).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
    });
    await expect(execute({ ...f.input, sendOriginalDelete })).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
    });
    expect(sendOriginalDelete).toHaveBeenCalledTimes(1);
    expect([...f.records.values()].some((data) => data.state === 'unknown')).toBe(true);
    expect([...f.records.keys()].some((path) => path.startsWith(`${PROVIDER_MUTATION_FACTS}/`))).toBe(false);
  });
  test.each([202, 400, 500])('unsupported original %i leaves unknown rather than acknowledgement', async (status) => {
    const f = fixture();
    await expect(execute({ ...f.input, sendOriginalDelete: async () => ({ status }) })).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
    });
    expect([...f.records.values()].some((data) => data.state === 'unknown')).toBe(true);
  });
  test('revoked authority prevents any transport', async () => {
    const f = fixture(),
      sendOriginalDelete = jest.fn();
    await expect(
      execute({
        ...f.input,
        authorizeInTransaction: async () => {
          throw Error('grant revoked');
        },
        sendOriginalDelete,
      })
    ).rejects.toThrow('grant revoked');
    expect(sendOriginalDelete).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
  });
  test('absence closes transport without releasing resource; only source EOF settles', async () => {
    const f = fixture(),
      handle = await execute({ ...f.input, sendOriginalDelete: async () => ({ status: 204 }) });
    const validateFixedAbsence = jest.fn(async () => {});
    await f.runTransaction(async (tx) => {
      const close = await prepareCertifiedPublishingDeletionEffectsClosed(tx, handle, {
        authorizeInTransaction: f.authorizeInTransaction,
        validateFixedAbsence,
      });
      close.commit();
    });
    const record = f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${handle.session.id}`)!;
    expect(record.effectsClosed).toBe(true);
    expect(record.state).toBe('active');
    await expect(
      f.runTransaction((tx) =>
        prepareCertifiedPublishingDeletionFinalSettlement(tx, handle, {
          authorizeInTransaction: f.authorizeInTransaction,
          validateSourceCompletion: async () => {
            throw Error('canonical EOF missing');
          },
        })
      )
    ).rejects.toThrow('canonical EOF missing');
    expect(record.state).toBe('active');
    await f.runTransaction(async (tx) => {
      const final = await prepareCertifiedPublishingDeletionFinalSettlement(tx, handle, {
        authorizeInTransaction: f.authorizeInTransaction,
        validateSourceCompletion: async (_tx, _session, seal) => ({
          closedClaimSetDigest: seal.claimSetDigest,
          originalRequestCount: 1,
          immutableCatalogDigest: providerMutationFingerprint('private catalog'),
          canonicalCompletionDigest: providerMutationFingerprint('private canonical EOF'),
          expectedCanonicalPageCount: 2,
          completedCanonicalPageCount: 2,
        }),
      });
      final.commit();
    });
    expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${handle.session.id}`)?.state).toBe('committed');
    expect(validateFixedAbsence).toHaveBeenCalledTimes(1);
  });
  test('tampered original no-effect fact cannot replay or send', async () => {
    const f = fixture(),
      sendOriginalDelete = jest.fn(async () => ({ status: 404 }));
    await execute({ ...f.input, sendOriginalDelete });
    const fact = [...f.records.entries()].find(([path]) => path.startsWith(`${PROVIDER_MUTATION_FACTS}/`))![1];
    fact.evidence.status = 400;
    await expect(execute({ ...f.input, sendOriginalDelete })).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
    });
    expect(sendOriginalDelete).toHaveBeenCalledTimes(1);
  });
  test('all certificate targets lock before first send and prefix ACK cannot close admission', async () => {
    const f = fixture();
    const second = { ...f.input.operation, resourceId: 'second' };
    const validateCompletePlanInTransaction = jest.fn(async () => {});
    const lease = await acquireCertifiedPublishingDeletionSession({
      ...f.input,
      operations: [f.input.operation, second],
      validateCompletePlanInTransaction,
    });
    const first = await executeCertifiedPublishingDeletion({
      ...f.input,
      lease,
      sendOriginalDelete: async () => {
        expect([...f.records.values()].filter((record) => record.state === 'held')).toHaveLength(2);
        return { status: 204 };
      },
    });
    await expect(
      f.runTransaction((tx) =>
        prepareCertifiedPublishingDeletionEffectsClosed(tx, first, {
          authorizeInTransaction: f.authorizeInTransaction,
          validateFixedAbsence: async () => {},
        })
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
    const last = await executeCertifiedPublishingDeletion({
      ...f.input,
      operation: second,
      lease,
      sendOriginalDelete: async () => ({ status: 404 }),
    });
    expect(last.session.id).toBe(first.session.id);
    await f.runTransaction(async (tx) => {
      const closure = await prepareCertifiedPublishingDeletionEffectsClosed(tx, last, {
        authorizeInTransaction: f.authorizeInTransaction,
        validateFixedAbsence: async () => {},
      });
      closure.commit();
    });
    expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${last.session.id}`)?.effectsClosedActualRequestCount).toBe(2);
    expect(validateCompletePlanInTransaction).toHaveBeenCalledTimes(1);
  });
  test('complete-plan authority failure acquires no partial lock', async () => {
    const f = fixture();
    await expect(
      acquireCertifiedPublishingDeletionSession({
        ...f.input,
        operations: [f.input.operation],
        validateCompletePlanInTransaction: async () => {
          throw Error('certificate target omitted');
        },
      })
    ).rejects.toThrow('certificate target omitted');
    expect(f.records.size).toBe(0);
  });

  test('another certificate cannot claim a resource while factual cleanup still owns it', async () => {
    const f = fixture();
    await execute({ ...f.input, sendOriginalDelete: async () => ({ status: 204 }) });
    const sendOriginalDelete = jest.fn(async () => ({ status: 204 }));
    await expect(
      execute({ ...f.input, certificateId: providerMutationFingerprint('other certificate'), sendOriginalDelete })
    ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
    expect(sendOriginalDelete).not.toHaveBeenCalled();
  });
  test('revocation after full-set acquisition blocks the actual request claim', async () => {
    const f = fixture();
    const lease = await acquireCertifiedPublishingDeletionSession({
      ...f.input,
      operations: [f.input.operation],
      validateCompletePlanInTransaction: async () => {},
    });
    const sendOriginalDelete = jest.fn(async () => ({ status: 204 }));
    await expect(
      executeCertifiedPublishingDeletion({
        ...f.input,
        lease,
        authorizeInTransaction: async () => {
          throw Error('SDK execution revoked');
        },
        sendOriginalDelete,
      })
    ).rejects.toThrow('SDK execution revoked');
    expect(sendOriginalDelete).not.toHaveBeenCalled();
    expect([...f.records.keys()].some((path) => path.includes('/requests/'))).toBe(false);
  });

  test('repair adapter distinguishes source reads and closure from new DELETE authorization', async () => {
    const f = fixture(),
      phases: string[] = [];
    let allowNewDelete = true;
    const controller = await createCertifiedPublishingDeletionGuard({
      ref: f.input.ref,
      certificateId: f.input.certificateId,
      generation: f.input.generation,
      firestore: f.input.db,
      commitCurrent: async (_ref, mutate) => {
        await f.runTransaction(mutate);
      },
      getRepairObservationScope: async () => providerMutationFingerprint('private SDK attempt'),
      readCompleteDeleteSet: async () => [f.input.operation],
      validateCompleteDeleteSetInTransaction: async (_tx, operations) => {
        expect(operations).toEqual([f.input.operation]);
      },
      authorizeCertifiedDeletionInTransaction: async (_tx, _op, phase) => {
        phases.push(phase);
        if (phase === 'claim' && !allowNewDelete) throw Error('new effects closed');
      },
    });
    const sendOriginalDelete = jest.fn(async () => ({ status: 204 }));
    allowNewDelete = false;
    await expect(controller!.execute(f.input.operation, sendOriginalDelete)).rejects.toThrow('new effects closed');
    expect(phases).toEqual(['acquire', 'replay', 'claim']);
    expect(sendOriginalDelete).not.toHaveBeenCalled();
    allowNewDelete = true;
    await controller!.execute(f.input.operation, sendOriginalDelete);
    allowNewDelete = false;
    await controller!.execute(f.input.operation, sendOriginalDelete);
    await f.runTransaction(async (tx) => {
      const closed = await controller!.prepareEffectsClosed(tx, async () => {});
      closed.commit();
    });
    expect(sendOriginalDelete).toHaveBeenCalledTimes(1);
    expect(phases.at(-1)).toBe('close');
  });

  test('source effects closure forwards the immutable source disposition program digest intact', async () => {
    const f = fixture(),
      handle = await execute({ ...f.input, sendOriginalDelete: async () => ({ status: 204 }) });
    const sourceProgramDigest = providerMutationFingerprint('private source-qualified disposition program');
    const actual = [...f.records.entries()].find(([path]) =>
      path.startsWith(`${PROVIDER_MUTATION_SESSIONS}/${handle.session.id}/requests/`)
    )![1];
    await f.runTransaction(async (tx) => {
      const closure = await prepareCertifiedPublishingDeletionEffectsClosed(tx, handle, {
        authorizeInTransaction: f.authorizeInTransaction,
        validateFixedAbsence: async () => ({
          sourceProgramDigest,
          expectedRequestSteps: [actual.step],
          qualifiedNoSendSteps: [],
        }),
      });
      closure.commit();
    });
    expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${handle.session.id}`)?.effectsClosedSourceProgramDigest).toBe(
      sourceProgramDigest
    );
  });
  test.each(['extra', 'missing', 'duplicate', 'nosend', 'digest'])(
    'source proof cannot expand, omit, or invent lease coverage: %s',
    async (kind) => {
      const f = fixture(),
        handle = await execute({ ...f.input, sendOriginalDelete: async () => ({ status: 204 }) });
      const actual = [...f.records.entries()].find(([path]) =>
        path.startsWith(`${PROVIDER_MUTATION_SESSIONS}/${handle.session.id}/requests/`)
      )![1];
      const proof = {
        sourceProgramDigest: providerMutationFingerprint('private program'),
        expectedRequestSteps: [actual.step] as string[],
        qualifiedNoSendSteps: [] as string[],
      };
      if (kind === 'extra') proof.expectedRequestSteps.push('different');
      if (kind === 'missing') proof.expectedRequestSteps = [];
      if (kind === 'duplicate') proof.expectedRequestSteps.push(actual.step);
      if (kind === 'nosend') proof.qualifiedNoSendSteps.push(actual.step);
      if (kind === 'digest') proof.sourceProgramDigest = 'caller description';
      await expect(
        f.runTransaction((tx) =>
          prepareCertifiedPublishingDeletionEffectsClosed(tx, handle, {
            authorizeInTransaction: f.authorizeInTransaction,
            validateFixedAbsence: async () => proof,
          })
        )
      ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
      expect(f.records.get(`${PROVIDER_MUTATION_SESSIONS}/${handle.session.id}`)?.effectsClosed).toBeUndefined();
    }
  );
});
