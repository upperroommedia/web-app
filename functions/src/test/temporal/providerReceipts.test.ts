jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: {} }));
import type { Transaction } from 'firebase-admin/firestore';
import {
  runCriticalPublishingRepair,
  runDurablePublishingOperation,
} from '../../temporal/publishing/durableOperationContext';
import {
  executeProviderCreate,
  providerPayloadFingerprint,
  ProviderReceipt,
  ProviderReceiptStore,
  providerReceiptId,
  resolveProviderReceipt,
  isProviderReceiptExplicitlyRetained,
  inferProviderReceiptScope,
  listProviderReceiptsForJob,
} from '../../temporal/publishing/providerReceipts';

const memoryStore = (transaction?: Transaction) => {
  const records = new Map<string, ProviderReceipt>();
  const store: ProviderReceiptStore = {
    async update(id, fn) {
      const next = await fn(records.get(id), transaction);
      if (next.record) records.set(id, next.record);
      return next.value;
    },
  };
  return { records, store };
};
const options = { operationKey: 'sermon-1:generation-1', step: 'track', payload: { title: 'Sermon', tags: ['tag'] } };

describe('durable provider creation receipts', () => {
  it('fingerprints nested object keys canonically and preserves array order', () => {
    expect(providerPayloadFingerprint({ b: { d: 1, c: 2 }, a: undefined })).toEqual(
      providerPayloadFingerprint({ b: { c: 2, d: 1 } })
    );
    expect(providerPayloadFingerprint([1, 2])).not.toEqual(providerPayloadFingerprint([2, 1]));
  });
  it('records executing before the POST and replays confirmed IDs without another POST', async () => {
    const { records, store } = memoryStore();
    const execute = jest.fn(async () => {
      expect(records.get(providerReceiptId(options.operationKey, options.step))?.state).toBe('executing');
      return { id: 'remote-1' };
    });
    expect(await executeProviderCreate({ ...options, store, execute })).toEqual({ id: 'remote-1' });
    expect(await executeProviderCreate({ ...options, store, execute })).toEqual({ id: 'remote-1' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('refuses an operation key with changed immutable payload', async () => {
    const { store } = memoryStore();
    const execute = jest.fn(async () => ({ id: 'remote-1' }));
    await executeProviderCreate({ ...options, store, execute });
    await expect(
      executeProviderCreate({ ...options, payload: { title: 'Changed' }, store, execute })
    ).rejects.toMatchObject({ details: { reason: 'PROVIDER_PAYLOAD_CHANGED' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('blocks replay after a response gap rather than duplicating creation', async () => {
    const { records, store } = memoryStore();
    const execute = jest.fn(async () => {
      throw new Error('response lost');
    });
    await expect(executeProviderCreate({ ...options, store, execute })).rejects.toMatchObject({
      details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' },
    });
    expect(records.get(providerReceiptId(options.operationKey, options.step))?.state).toBe('needs_review');
    await expect(executeProviderCreate({ ...options, store, execute })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('blocks retry after process death leaves executing persisted', async () => {
    const { records, store } = memoryStore();
    records.set(providerReceiptId(options.operationKey, options.step), {
      ...options,
      fingerprint: providerPayloadFingerprint(options.payload),
      state: 'executing',
      updatedAtMillis: 0,
      owner: 'dead-process',
    });
    const execute = jest.fn(async () => ({ id: 'duplicate' }));
    await expect(executeProviderCreate({ ...options, store, execute })).rejects.toMatchObject({
      details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' },
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it('restarts a prepared receipt safely because no POST has started', async () => {
    const { records, store } = memoryStore();
    records.set(providerReceiptId(options.operationKey, options.step), {
      ...options,
      fingerprint: providerPayloadFingerprint(options.payload),
      state: 'prepared',
      updatedAtMillis: 0,
    });
    expect(await executeProviderCreate({ ...options, store, execute: async () => ({ id: 'remote' }) })).toEqual({
      id: 'remote',
    });
  });
  it('fails closed when persisting a successful POST result fails', async () => {
    const memory = memoryStore();
    let failConfirmation = true;
    const store: ProviderReceiptStore = {
      update: (id, fn) =>
        memory.store.update(id, async (existing) => {
          const next = await fn(existing);
          if (next.record?.state === 'confirmed' && failConfirmation) {
            failConfirmation = false;
            throw new Error('db unavailable');
          }
          return next;
        }),
    };
    const execute = jest.fn(async () => ({ id: 'already-created' }));
    await expect(executeProviderCreate({ ...options, store, execute })).rejects.toMatchObject({
      details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' },
    });
    await expect(executeProviderCreate({ ...options, store, execute })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('replays a confirmed result before reopening any source streams', async () => {
    const { store } = memoryStore();
    const execute = jest.fn(async () => ({ id: 'remote' }));
    await executeProviderCreate({ ...options, store, execute });
    const prepare = jest.fn(async () => {
      throw new Error('Old source was removed');
    });
    expect(await executeProviderCreate({ ...options, store, execute, prepare })).toEqual({ id: 'remote' });
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('keeps a failed safe preparation prepared and safely retries it later', async () => {
    const { records, store } = memoryStore();
    const execute = jest.fn(async () => ({ id: 'remote' }));
    const prepare = jest
      .fn()
      .mockRejectedValueOnce(new Error('Storage temporarily unavailable'))
      .mockResolvedValue(undefined);
    await expect(executeProviderCreate({ ...options, store, execute, prepare })).rejects.toThrow(
      'Storage temporarily unavailable'
    );
    expect(records.get(providerReceiptId(options.operationKey, options.step))?.state).toBe('prepared');
    expect(execute).not.toHaveBeenCalled();
    expect(await executeProviderCreate({ ...options, store, execute, prepare })).toEqual({ id: 'remote' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not prepare sources for an unresolved receipt', async () => {
    const { records, store } = memoryStore();
    const id = providerReceiptId(options.operationKey, options.step);
    records.set(id, {
      operationKey: options.operationKey,
      step: options.step,
      fingerprint: providerPayloadFingerprint(options.payload),
      state: 'needs_review',
      updatedAtMillis: 0,
    });
    const prepare = jest.fn(async () => undefined);
    const execute = jest.fn(async () => ({ id: 'duplicate' }));
    await expect(executeProviderCreate({ ...options, store, execute, prepare })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('prevents concurrent invocations from issuing duplicate POSTs', async () => {
    const { store } = memoryStore();
    let finish!: (value: { id: string }) => void;
    const execute = jest.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finish = resolve;
        })
    );
    const first = executeProviderCreate({ ...options, store, execute });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await expect(executeProviderCreate({ ...options, store, execute })).rejects.toMatchObject({
      details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' },
    });
    finish({ id: 'only-one' });
    await first;
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('privileged provider receipt resolution', () => {
  const unresolved = (transaction?: Transaction) => {
    const memory = memoryStore(transaction);
    const id = providerReceiptId(options.operationKey, options.step);
    memory.records.set(id, {
      operationKey: options.operationKey,
      step: options.step,
      fingerprint: providerPayloadFingerprint(options.payload),
      intentPayload: options.payload,
      state: 'needs_review',
      owner: 'original-owner',
      revision: 2,
      updatedAtMillis: 1,
    });
    return { ...memory, id };
  };
  it('adopts only after verifier returns the provider result, then replays it', async () => {
    const { store, records, id } = unresolved();
    const verify = jest.fn(async () => ({ id: 'verified-remote' }));
    await resolveProviderReceipt({
      receiptId: id,
      actorUid: 'admin',
      store,
      resolution: { type: 'adopt', remoteId: 'verified-remote' },
      verifyRemoteResource: verify,
      verifyAuthoritativeAbsence: async () => false,
    });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ state: 'needs_review' }), 'verified-remote');
    expect(records.get(id)).toMatchObject({
      state: 'confirmed',
      result: { id: 'verified-remote' },
      resolvedBy: 'admin',
      revision: 3,
    });
    const create = jest.fn(async () => ({ id: 'duplicate' }));
    expect(await executeProviderCreate({ ...options, store, execute: create })).toEqual({ id: 'verified-remote' });
    expect(create).not.toHaveBeenCalled();
  });
  it('does not reset a receipt based on unproven absence', async () => {
    const { store, records, id } = unresolved();
    await expect(
      resolveProviderReceipt({
        receiptId: id,
        actorUid: 'admin',
        store,
        resolution: { type: 'prove_absence' },
        verifyRemoteResource: async () => undefined,
        verifyAuthoritativeAbsence: async () => false,
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(records.get(id)?.state).toBe('needs_review');
  });
  it('rejects a changed receipt revision after verification begins', async () => {
    const { store, records, id } = unresolved();
    await expect(
      resolveProviderReceipt({
        receiptId: id,
        actorUid: 'admin',
        store,
        resolution: { type: 'adopt', remoteId: 'remote' },
        verifyRemoteResource: async () => {
          const receipt = records.get(id)!;
          records.set(id, { ...receipt, owner: 'new-owner', revision: 3 });
          return { id: 'remote' };
        },
        verifyAuthoritativeAbsence: async () => false,
      })
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(records.get(id)?.state).toBe('needs_review');
  });
  it('leaves receipt unchanged when remote verification rejects', async () => {
    const { store, records, id } = unresolved();
    await expect(
      resolveProviderReceipt({
        receiptId: id,
        actorUid: 'admin',
        store,
        resolution: { type: 'adopt', remoteId: 'wrong-account' },
        verifyRemoteResource: async () => {
          throw new Error('ownership mismatch');
        },
        verifyAuthoritativeAbsence: async () => false,
      })
    ).rejects.toThrow('ownership mismatch');
    expect(records.get(id)?.state).toBe('needs_review');
  });
  it('replays a resolution command without another provider GET and rejects changed selection', async () => {
    const { store, id } = unresolved();
    const verify = jest.fn(async () => ({ id: 'remote' }));
    const resolution = { type: 'adopt' as const, remoteId: 'remote' };
    const input = {
      receiptId: id,
      actorUid: 'admin',
      commandId: 'command-1',
      store,
      resolution,
      verifyRemoteResource: verify,
      verifyAuthoritativeAbsence: async () => false,
    };
    await resolveProviderReceipt(input);
    await resolveProviderReceipt(input);
    expect(verify).toHaveBeenCalledTimes(1);
    await expect(
      resolveProviderReceipt({ ...input, resolution: { type: 'adopt', remoteId: 'different' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('refuses to resolve an executing receipt while its original attempt may be active', async () => {
    const { store, records, id } = unresolved();
    records.set(id, { ...records.get(id)!, state: 'executing', updatedAtMillis: Date.now() });
    const verify = jest.fn(async () => ({ id: 'remote' }));
    await expect(
      resolveProviderReceipt({
        receiptId: id,
        actorUid: 'admin',
        store,
        resolution: { type: 'adopt', remoteId: 'remote' },
        verifyRemoteResource: verify,
        verifyAuthoritativeAbsence: async () => false,
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(verify).not.toHaveBeenCalled();
  });
  it('fails closed when a required atomic generation guard cannot be provided by the store', async () => {
    const { store, records, id } = unresolved();
    await expect(
      resolveProviderReceipt({
        receiptId: id,
        actorUid: 'admin',
        store,
        resolution: { type: 'adopt', remoteId: 'remote' },
        verifyRemoteResource: async () => ({ id: 'remote' }),
        verifyAuthoritativeAbsence: async () => false,
        assertCurrentInTransaction: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(records.get(id)?.state).toBe('needs_review');
  });
  it('runs final command commit after receipt verification and before confirmation', async () => {
    const transaction = {} as Transaction;
    const { store, records, id } = unresolved(transaction);
    const order: string[] = [];
    await resolveProviderReceipt({
      receiptId: id,
      actorUid: 'admin',
      store,
      resolution: { type: 'adopt', remoteId: 'remote' },
      verifyRemoteResource: async () => {
        order.push('verify');
        return { id: 'remote' };
      },
      verifyAuthoritativeAbsence: async () => false,
      assertCurrentInTransaction: async (tx) => {
        expect(tx).toBe(transaction);
        order.push('fence');
      },
      onResolutionCommit: async (tx) => {
        expect(tx).toBe(transaction);
        expect(records.get(id)?.state).toBe('needs_review');
        order.push('command');
      },
    });
    expect(order).toEqual(['verify', 'fence', 'command']);
    expect(records.get(id)?.state).toBe('confirmed');
  });
  it('does not confirm receipt when atomic command preparation or commit fails', async () => {
    const { store, records, id } = unresolved({} as Transaction);
    await expect(
      resolveProviderReceipt({
        receiptId: id,
        actorUid: 'admin',
        store,
        resolution: { type: 'adopt', remoteId: 'remote' },
        verifyRemoteResource: async () => ({ id: 'remote' }),
        verifyAuthoritativeAbsence: async () => false,
        onResolutionCommit: async () => {
          throw new Error('Resume command unavailable');
        },
      })
    ).rejects.toThrow('Resume command unavailable');
    expect(records.get(id)?.state).toBe('needs_review');
  });
});

describe('qualified provider receipt retention queries', () => {
  it('extracts exact project/job identity and preserves legacy keys without inferring ownership', () => {
    expect(inferProviderReceiptScope('durable:urm-app:job-abc:sermon-id:audio:image:wide')).toEqual({
      projectId: 'urm-app',
      jobId: 'job-abc',
    });
    expect(inferProviderReceiptScope('legacy:urm-app:job-abc')).toBeUndefined();
    expect(() => inferProviderReceiptScope('durable:urm-app:bad/job:audio')).toThrow();
    expect(() => inferProviderReceiptScope('durable:urm-app:job-abc:')).toThrow();
  });
  it('writes project/job fields before a qualified provider creation begins', async () => {
    const { store, records } = memoryStore();
    const operationKey = 'durable:urm-app:job-abc:audio';
    await executeProviderCreate({
      ...options,
      operationKey,
      store,
      execute: async () => {
        expect(records.get(providerReceiptId(operationKey, options.step))).toMatchObject({
          projectId: 'urm-app',
          jobId: 'job-abc',
          state: 'executing',
        });
        return { id: 'remote' };
      },
    });
  });
  it('completely paginates 605 qualified receipts instead of imposing a job count ceiling', async () => {
    const ref = { projectId: 'urm-app', jobId: 'job-abc' };
    const docs = Array.from({ length: 605 }, (_, index) => {
      const operationKey = `durable:${ref.projectId}:${ref.jobId}:media-${index}`;
      const receipt: ProviderReceipt = {
        ...ref,
        operationKey,
        step: 'audio-create',
        fingerprint: 'payload',
        state: 'confirmed',
        result: `audio-${index}`,
        updatedAtMillis: 0,
      };
      return { id: providerReceiptId(operationKey, receipt.step), data: () => receipt };
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
    const query = { where: jest.fn(), orderBy: jest.fn(), limit: jest.fn(), startAfter: jest.fn(), get: jest.fn() };
    for (const method of [query.where, query.orderBy, query.limit, query.startAfter]) method.mockReturnValue(query);
    query.get.mockResolvedValueOnce({ docs: docs.slice(0, 400) }).mockResolvedValueOnce({ docs: docs.slice(400) });
    const db = { collection: jest.fn().mockReturnValue(query) } as unknown as Parameters<
      typeof listProviderReceiptsForJob
    >[1];
    const result = await listProviderReceiptsForJob(ref, db);
    expect(result).toHaveLength(605);
    expect(new Set(result.map((proof) => proof.receiptId)).size).toBe(605);
    expect(query.where.mock.calls).toEqual([
      ['projectId', '==', ref.projectId],
      ['jobId', '==', ref.jobId],
    ]);
    expect(query.limit).toHaveBeenCalledWith(400);
    expect(query.get).toHaveBeenCalledTimes(2);
    expect(query.startAfter).toHaveBeenCalledWith(docs[399]);
  });
  it('fails closed if a returned receipt does not match the requested immutable job routing', async () => {
    const operationKey = 'durable:urm-app:foreign-job:audio';
    const receipt: ProviderReceipt = {
      projectId: 'urm-app',
      jobId: 'job-abc',
      operationKey,
      step: 'audio',
      fingerprint: 'payload',
      state: 'confirmed',
      updatedAtMillis: 0,
    };
    const query = {
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
      get: jest
        .fn()
        .mockResolvedValue({ docs: [{ id: providerReceiptId(operationKey, 'audio'), data: () => receipt }] }),
    };
    for (const method of [query.where, query.orderBy, query.limit]) method.mockReturnValue(query);
    const db = { collection: jest.fn().mockReturnValue(query) } as unknown as Parameters<
      typeof listProviderReceiptsForJob
    >[1];
    await expect(listProviderReceiptsForJob({ projectId: 'urm-app', jobId: 'job-abc' }, db)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});

describe('already confirmed cancellation cleanup review', () => {
  const setupConfirmed = () => {
    const transaction = {} as Transaction;
    const { records, store } = memoryStore(transaction);
    const scope = { projectId: 'staging', jobId: 'job-1' };
    const operationKey = 'durable:staging:job-1:publishing';
    const id = providerReceiptId(operationKey, 'subsplash-audio');
    const adoptionAudit = {
      decision: 'adopt_existing_resource' as const,
      duplicateRiskAcknowledged: true as const,
      evidenceReference: 'review/log-1',
      reason: 'Authorize only cancellation cleanup of the known resource.',
    };
    const receipt: ProviderReceipt = {
      operationKey,
      ...scope,
      step: 'subsplash-audio',
      fingerprint: providerPayloadFingerprint({ title: 'Sermon' }),
      intentPayload: { title: 'Sermon' },
      state: 'confirmed',
      result: 'audio-1',
      owner: 'original-attempt',
      revision: 2,
      updatedAtMillis: 10,
    };
    records.set(id, receipt);
    const options = {
      receiptId: id,
      actorUid: 'admin-1',
      commandId: 'cleanup-1',
      cleanupOnly: true,
      expectedJobRef: scope,
      resolution: { type: 'adopt' as const, remoteId: 'audio-1' },
      adoptionAudit,
      store,
      assertCurrentInTransaction: jest.fn(async () => {}),
      onResolutionCommit: jest.fn(async () => {}),
      verifyRemoteResource: jest.fn(async () => 'audio-1'),
      verifyAuthoritativeAbsence: jest.fn(async () => false),
    };
    return { records, receipt, id, options };
  };
  test('atomically grants cleanup review while preserving original confirmed result and ownership evidence', async () => {
    const { records, receipt, id, options } = setupConfirmed();
    await resolveProviderReceipt(options);
    expect(options.onResolutionCommit).toHaveBeenCalledTimes(1);
    expect(records.get(id)).toMatchObject({
      ...receipt,
      revision: 3,
      cleanupReview: { actorUid: 'admin-1', commandId: 'cleanup-1', audit: options.adoptionAudit },
    });
    expect(records.get(id)?.adoptionAudit).toBeUndefined();
    expect(records.get(id)?.resolutionCommandId).toBeUndefined();
  });
  test('rejects selecting a different ID or a foreign operation before provider verification', async () => {
    const { options } = setupConfirmed();
    await expect(
      resolveProviderReceipt({ ...options, resolution: { type: 'adopt', remoteId: 'different' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(
      resolveProviderReceipt({ ...options, expectedJobRef: { projectId: 'production', jobId: 'job-1' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(options.verifyRemoteResource).not.toHaveBeenCalled();
  });
  test('wrong provider association, late receipt changes and failed atomic command leave evidence unchanged', async () => {
    const { records, receipt, id, options } = setupConfirmed();
    options.verifyRemoteResource.mockResolvedValueOnce('wrong-account-resource');
    await expect(resolveProviderReceipt(options)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(records.get(id)).toEqual(receipt);
    options.verifyRemoteResource.mockImplementationOnce(async () => {
      records.set(id, { ...receipt, revision: 4 });
      return 'audio-1';
    });
    await expect(resolveProviderReceipt(options)).rejects.toMatchObject({ code: 'aborted' });
    expect(options.onResolutionCommit).not.toHaveBeenCalled();
    records.set(id, receipt);
    options.onResolutionCommit.mockRejectedValueOnce(new Error('command write rejected'));
    await expect(resolveProviderReceipt(options)).rejects.toThrow('command write rejected');
    expect(records.get(id)).toEqual(receipt);
  });
  test('does not upgrade previously adopted resources into exclusive creation ownership', async () => {
    const { records, receipt, id, options } = setupConfirmed();
    const existingAudit = {
      ...options.adoptionAudit,
      reason: 'Original POST was unknown; intentionally associate selected resource.',
    };
    records.set(id, { ...receipt, adoptionAudit: existingAudit, resolutionCommandId: 'old-adoption' });
    await resolveProviderReceipt(options);
    expect(records.get(id)).toMatchObject({
      adoptionAudit: existingAudit,
      resolutionCommandId: 'old-adoption',
      result: 'audio-1',
    });
  });
  test('explicit same-resource retention seals exact ID, payload fingerprint and receipt revision without granting deletion ownership', async () => {
    const { records, receipt, id, options } = setupConfirmed();
    await resolveProviderReceipt({
      ...options,
      adoptionAudit: { ...options.adoptionAudit, decision: 'retain_existing_resource' },
    });
    const retained = records.get(id)!;
    expect(retained.cleanupReview).toMatchObject({
      retainedResourceId: 'audio-1',
      providerReceiptFingerprint: receipt.fingerprint,
      currentReceiptRevision: 3,
      audit: { decision: 'retain_existing_resource' },
    });
    expect(isProviderReceiptExplicitlyRetained(retained, 'audio-1')).toBe(true);
    expect(isProviderReceiptExplicitlyRetained({ ...retained, revision: 4 }, 'audio-1')).toBe(false);
    expect(isProviderReceiptExplicitlyRetained(retained, 'different')).toBe(false);
    expect(retained.owner).toBe(receipt.owner);
    expect(retained.result).toBe(receipt.result);
  });
});

describe('reserved durable provider key authority', () => {
  it('rejects a forged qualified legacy key before accessing Firestore or dispatching a POST', async () => {
    const execute = jest.fn(async () => ({ id: 'must-not-create' }));
    await expect(
      executeProviderCreate({
        operationKey: 'durable:urm-app:other-job:fake-step',
        step: 'audio',
        payload: {},
        execute,
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a job identity different from the active trusted context', async () => {
    const execute = jest.fn(async () => ({ id: 'must-not-create' }));
    await expect(
      runDurablePublishingOperation('worker-job', () =>
        executeProviderCreate({
          operationKey: 'durable:urm-app:other-job:fake-step',
          step: 'audio',
          payload: {},
          execute,
        })
      )
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('immutable executing provider account binding', () => {
  it('captures the safe prepared account identity before the first POST', async () => {
    const { records, store } = memoryStore();
    let account: { provider: 'soundcloud'; account: string } | undefined;
    await executeProviderCreate({
      ...options,
      step: 'soundcloud-track',
      store,
      prepare: async () => {
        account = { provider: 'soundcloud', account: 'soundcloud:users:42' };
      },
      getProviderAccount: () => account,
      execute: async () => {
        expect(records.get(providerReceiptId(options.operationKey, 'soundcloud-track'))).toMatchObject({
          state: 'executing',
          providerAccount: { provider: 'soundcloud', account: 'soundcloud:users:42' },
        });
        return { trackIdentifier: 'soundcloud:tracks:123' };
      },
    });
    expect(records.get(providerReceiptId(options.operationKey, 'soundcloud-track'))?.providerAccount).toEqual(account);
  });
});

test('an uncertain shared image cannot be adopted to resume PUT even when a verifier offers a signed slot', async () => {
  const { records, store } = memoryStore();
  const id = providerReceiptId(options.operationKey, 'image-create');
  records.set(id, {
    operationKey: options.operationKey,
    step: 'image-create',
    fingerprint: providerPayloadFingerprint(options.payload),
    intentPayload: options.payload,
    state: 'needs_review',
    updatedAtMillis: 0,
  });
  const verifyRemoteResource = jest.fn(async () => ({
    id: 'shared-image',
    uploadUrl: 'https://provider.example/signed',
  }));
  await expect(
    resolveProviderReceipt({
      receiptId: id,
      actorUid: 'admin1',
      resolution: { type: 'adopt', remoteId: 'shared-image' },
      store,
      verifyRemoteResource,
      verifyAuthoritativeAbsence: async () => false,
    })
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(verifyRemoteResource).not.toHaveBeenCalled();
  expect(records.get(id)?.state).toBe('needs_review');
});

it('rejects every provider allocation in dedicated critical-repair scope before receipt preparation or HTTP', async () => {
  const { records, store } = memoryStore(),
    execute = jest.fn(),
    prepare = jest.fn();
  await expect(
    runCriticalPublishingRepair('job', () =>
      executeProviderCreate({
        operationKey: 'durable:test:job:create',
        step: 'subsplash-media-item',
        payload: { title: 'Never created' },
        store,
        prepare,
        execute,
      })
    )
  ).rejects.toMatchObject({ code: 'permission-denied' });
  expect(records.size).toBe(0);
  expect(prepare).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
