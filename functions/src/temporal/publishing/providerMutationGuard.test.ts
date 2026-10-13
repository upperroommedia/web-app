import { FieldValue, type Firestore, type Transaction, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  providerMutationFingerprint,
  providerMutationClaimSetSeed,
  providerMutationClaimSetFold,
  assertProviderMutationByteBudgets,
  PROVIDER_MUTATION_DOCUMENT_BYTE_BUDGET,
  PROVIDER_MUTATION_REQUEST_BYTE_BUDGET,
  acquireProviderMutationSession,
  prepareProviderMutationEffectsClosed,
  prepareZeroEffectsProviderMutationAbort,
  assertProviderMutationZeroEffectsProof,
  prepareProviderMutationEffectsClosedFromReadyEvidence,
  prepareProviderMutationSessionCommitFromClosedEvidence,
  executeProviderMutationOnce,
  validateProviderMutationOriginalCompletion,
  type ProviderMutationSession,
} from './providerMutationGuard';

describe('provider mutation original completion batching', () => {
  function fixture(count: number) {
    const sessionId = providerMutationFingerprint('session');
    const db = {
      collection: (collection: string) => ({ doc: (id: string) => ({ path: `${collection}/${id}` }) }),
    } as unknown as Firestore;
    const session: ProviderMutationSession = {
      db,
      id: sessionId,
      scope: { projectId: 'test', jobId: 'job', operation: 'membership' },
      resources: [],
    };
    const facts = new Map<string, Record<string, unknown>>();
    const requests = Array.from({ length: count }, (_, i) => {
      const step = `request-${i}`,
        claim = `claim-${i}`,
        result = { id: `remote-${i}` };
      const record = {
        step,
        claim,
        result,
        state: 'acknowledged',
        fingerprint: providerMutationFingerprint(['PATCH', { id: i }]),
        executionId: `execution-${i}`,
      };
      const path = `temporalProviderMutationFacts/${providerMutationFingerprint([sessionId, step, claim])}`;
      facts.set(path, { ...record, sessionId, completion: 'acknowledged' });
      return { id: providerMutationFingerprint(step), data: () => record } as unknown as QueryDocumentSnapshot;
    });
    const getAll = jest.fn(async (...refs: Array<{ path: string }>) =>
      refs
        .map((ref) => ({ ref, exists: facts.has(ref.path), get: (field: string) => facts.get(ref.path)?.[field] }))
        .reverse()
    );
    const get = jest.fn();
    const tx = { getAll, get } as unknown as Transaction;
    return { session, requests, facts, tx, getAll, get };
  }
  test('605 receipts use four bounded fact reads and tolerate response ordering', async () => {
    const f = fixture(605);
    await expect(validateProviderMutationOriginalCompletion(f.tx, f.session, f.requests)).resolves.toBeUndefined();
    expect(f.getAll.mock.calls.map((call) => call.length)).toEqual([200, 200, 200, 5]);
    expect(f.get).not.toHaveBeenCalled();
  });
  test('a changed fact in a later batch still blocks settlement', async () => {
    const f = fixture(405);
    const record = [...f.facts.values()][250];
    record.executionId = 'different-execution';
    await expect(validateProviderMutationOriginalCompletion(f.tx, f.session, f.requests)).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
      mutationSessionId: f.session.id,
    });
    expect(f.getAll).toHaveBeenCalledTimes(2);
  });
  test('a missing original fact never passes as completed', async () => {
    const f = fixture(1);
    f.facts.clear();
    await expect(validateProviderMutationOriginalCompletion(f.tx, f.session, f.requests)).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
    });
  });
  test('new step reads only the indexed unsettled states with limit one', async () => {
    const scope = { projectId: 'test', jobId: 'job', operation: 'metadata' },
      resource = { provider: 'subsplash' as const, account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media' };
    const id = providerMutationFingerprint(scope),
      resourceKey = providerMutationFingerprint([
        scope.projectId,
        resource.provider,
        resource.account,
        resource.resourceId,
      ]);
    const where = jest.fn(),
      limit = jest.fn();
    const query = { where, limit };
    where.mockReturnValue(query);
    limit.mockReturnValue(query);
    const requestCollection = { doc: (requestId: string) => ({ path: `requests/${requestId}` }), where };
    const sessionRef = { path: `sessions/${id}`, collection: () => requestCollection };
    const db = {
      collection: () => ({ doc: () => sessionRef }),
      runTransaction: async (mutate: (tx: Transaction) => Promise<unknown>) => mutate(tx),
    } as unknown as Firestore;
    const tx = {
      get: jest.fn(async (ref: unknown) =>
        ref === sessionRef
          ? {
              data: () => ({
                schemaVersion: 1,
                scope,
                resourceKeys: [resourceKey],
                resources: [resource],
                state: 'active',
              }),
            }
          : ref === query
          ? { empty: false }
          : { data: () => undefined }
      ),
      getAll: jest.fn(async () => [{ get: (field: string) => (field === 'sessionId' ? id : 'held') }]),
    } as unknown as Transaction;
    const session: ProviderMutationSession = { db, id, scope, resources: [resource] },
      send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: 'remote' }));
    await expect(
      executeProviderMutationOnce({
        session,
        step: 'new-step',
        method: 'PATCH',
        payload: {},
        executionId: 'execution',
        assertCurrentInTransaction: async () => {},
        send,
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
    expect(where).toHaveBeenCalledWith('state', 'in', ['sending', 'unknown', 'acknowledged_unprojectable']);
    expect(limit).toHaveBeenCalledWith(1);
    expect(send).not.toHaveBeenCalled();
  });

  test('Date payloads match ISO wire JSON without colliding across distinct timestamps', () => {
    const a = new Date('2026-10-12T10:00:00.000Z'),
      b = new Date('2026-10-12T10:00:01.000Z');
    expect(providerMutationFingerprint({ publishedAt: a })).toBe(
      providerMutationFingerprint({ publishedAt: a.toISOString() })
    );
    expect(providerMutationFingerprint({ publishedAt: a })).not.toBe(providerMutationFingerprint({ publishedAt: b }));
  });
  test('opaque payloads and invalid dates are rejected instead of collapsing to empty objects', () => {
    for (const value of [
      new Map([['id', 'one']]),
      new Set(['one']),
      FieldValue.delete(),
      new Date('invalid'),
      { nested: new Map() },
    ])
      expect(() => providerMutationFingerprint(value)).toThrow('PROVIDER_MUTATION_PAYLOAD_INVALID');
  });

  test('document encoding estimate accepts the byte boundary and rejects one extra byte of content', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');
    const length = Math.floor((PROVIDER_MUTATION_DOCUMENT_BYTE_BUDGET - 2048) / 4) - overhead;
    const document = { path: 'session/test', data: { value: 'x'.repeat(length) } };
    expect(assertProviderMutationByteBudgets([document]).largestDocumentBytes).toBe(
      PROVIDER_MUTATION_DOCUMENT_BYTE_BUDGET
    );
    expect(() => assertProviderMutationByteBudgets([{ ...document, data: { value: 'x'.repeat(length + 1) } }])).toThrow(
      'PROVIDER_MUTATION_PLAN_TOO_LARGE'
    );
    expect(() => assertProviderMutationByteBudgets([{ ...document, data: { value: 'é'.repeat(length) } }])).toThrow(
      'PROVIDER_MUTATION_PLAN_TOO_LARGE'
    );
  });
  test('aggregate request budget rejects oversized atomic plans even when every document fits', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');
    const length = Math.floor((PROVIDER_MUTATION_DOCUMENT_BYTE_BUDGET - 2048) / 4) - overhead;
    const document = { path: 'session/test', data: { value: 'x'.repeat(length) } };
    expect(assertProviderMutationByteBudgets(Array.from({ length: 8 }, () => document)).requestBytes).toBeLessThan(
      PROVIDER_MUTATION_REQUEST_BYTE_BUDGET
    );
    expect(() => assertProviderMutationByteBudgets(Array.from({ length: 9 }, () => document))).toThrow(
      'PROVIDER_MUTATION_PLAN_TOO_LARGE'
    );
  });
  test('oversized original resource descriptors are rejected before opening a transaction or effects', async () => {
    const runTransaction = jest.fn();
    const db = { runTransaction } as unknown as Firestore;
    const resources = Array.from({ length: 601 }, (_, i) => ({
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: 'media',
      resourceId: `${i}-${'x'.repeat(990)}`,
    }));
    await expect(
      acquireProviderMutationSession({
        db,
        scope: { projectId: 'test', jobId: 'job', operation: 'metadata' },
        resources,
        assertCurrentInTransaction: async () => {},
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_PLAN_TOO_LARGE' });
    expect(runTransaction).not.toHaveBeenCalled();
  });

  function closureFixture() {
    const scope = { projectId: 'test', jobId: 'job', operation: 'delete' },
      resource = { provider: 'subsplash' as const, account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media' },
      id = providerMutationFingerprint(scope);
    const aggregation = { aggregate: true };
    const query = { where: () => query, limit: () => query, count: () => aggregation };
    const target = { path: `sessions/${id}`, collection: () => query };
    const db = { collection: () => ({ doc: () => target }) } as unknown as Firestore;
    const record: Record<string, unknown> = {
      schemaVersion: 1,
      scope,
      resources: [resource],
      resourceKeys: [
        providerMutationFingerprint([scope.projectId, resource.provider, resource.account, resource.resourceId]),
      ],
      state: 'active',
    };
    const update = jest.fn();
    const tx = {
      get: jest.fn(async (ref: unknown) =>
        ref === target
          ? { data: () => record, get: (key: string) => record[key] }
          : ref === aggregation
          ? { data: () => ({ count: 0 }) }
          : { docs: [], size: 0, empty: true }
      ),
      getAll: jest.fn(async () => [{ get: (key: string) => (key === 'sessionId' ? id : 'held') }]),
      update,
    } as unknown as Transaction;
    const session: ProviderMutationSession = { db, id, scope, resources: [resource] };
    return { session, tx, record, update };
  }
  test('NoSEND requires full source-validated expected-step coverage before sealing', async () => {
    const f = closureFixture();
    await expect(
      prepareProviderMutationEffectsClosed(f.tx, f.session, async () => ({
        sourceProgramDigest: providerMutationFingerprint('program'),
        expectedRequestSteps: ['unclaimed-delete'],
        qualifiedNoSendSteps: [],
      }))
    ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
    expect(f.update).not.toHaveBeenCalled();
  });
  test('effects closure returns a read-phase closure retaining active ownership', async () => {
    const f = closureFixture();
    const prepared = await prepareProviderMutationEffectsClosed(f.tx, f.session, async () => ({
      sourceProgramDigest: providerMutationFingerprint('program'),
      expectedRequestSteps: ['legacy-retention'],
      qualifiedNoSendSteps: ['legacy-retention'],
    }));
    expect(prepared.alreadyClosed).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
    prepared.commit();
    expect(f.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ effectsClosed: true }));
    expect(f.update.mock.calls[0][1]).not.toHaveProperty('state');
  });
  test('a source verifier rejection cannot create an effects-closed marker', async () => {
    const f = closureFixture();
    await expect(
      prepareProviderMutationEffectsClosed(f.tx, f.session, async () => {
        throw Error('qualified source evidence missing');
      })
    ).rejects.toThrow('qualified source evidence missing');
    expect(f.update).not.toHaveBeenCalled();
  });

  test('evidence wake preparation reads before writes and publishes only with the original completion', async () => {
    type Stored = Record<string, unknown>;
    const records = new Map<string, Stored>(),
      scope = { projectId: 'test', jobId: 'job', operation: 'metadata' },
      resource = { provider: 'subsplash' as const, account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media' },
      id = providerMutationFingerprint(scope);
    const resourceKey = providerMutationFingerprint([
      scope.projectId,
      resource.provider,
      resource.account,
      resource.resourceId,
    ]);
    const collection = (path: string, states?: string[]): any => ({
      path,
      query: true,
      states,
      doc: (name: string) => reference(`${path}/${name}`),
      where: (_field: string, _operator: string, values: string[]) => collection(path, values),
      limit: () => collection(path, states),
    });
    const reference = (path: string): any => ({
      path,
      id: path.split('/').at(-1),
      collection: (name: string) => collection(`${path}/${name}`),
    });
    const snapshot = (ref: any) => ({
      ref,
      id: ref.id,
      exists: records.has(ref.path),
      data: () => records.get(ref.path),
      get: (field: string) => records.get(ref.path)?.[field],
    });
    const db = {
      doc: reference,
      collection,
      runTransaction: async (mutate: (tx: Transaction) => Promise<unknown>) => {
        const writes: Array<{ kind: string; ref: any; data: Stored }> = [];
        const assertRead = () => {
          if (writes.length) throw Error('read after write');
        };
        const tx = {
          get: async (ref: any) => {
            assertRead();
            if (!ref.query) return snapshot(ref);
            const docs = [...records.keys()]
              .filter(
                (path) =>
                  path.startsWith(`${ref.path}/`) &&
                  !path.slice(ref.path.length + 1).includes('/') &&
                  (!ref.states || ref.states.includes(records.get(path)!.state as string))
              )
              .map((path) => snapshot(reference(path)));
            return { docs, size: docs.length, empty: !docs.length };
          },
          getAll: async (...refs: any[]) => {
            assertRead();
            return refs.map(snapshot);
          },
          create: (ref: any, data: Stored) => writes.push({ kind: 'create', ref, data }),
          update: (ref: any, data: Stored) => writes.push({ kind: 'update', ref, data }),
        } as unknown as Transaction;
        const result = await mutate(tx);
        const next = new Map(records);
        for (const write of writes) {
          if (write.kind === 'create' && next.has(write.ref.path)) throw Error('existing');
          next.set(
            write.ref.path,
            write.kind === 'update' ? { ...next.get(write.ref.path), ...write.data } : write.data
          );
        }
        records.clear();
        for (const [key, value] of next) records.set(key, value);
        return result;
      },
    } as unknown as Firestore;
    records.set(`temporalProviderMutationSessions/${id}`, {
      schemaVersion: 1,
      scope,
      resourceKeys: [resourceKey],
      resources: [resource],
      state: 'active',
    });
    records.set(`temporalProviderMutationLocks/${resourceKey}`, { sessionId: id, state: 'held' });
    records.set('routing/current', { generation: 1 });
    const session: ProviderMutationSession = { db, id, scope, resources: [resource] },
      fence = jest.fn(async () => {});
    let evidenceId: string | undefined;
    await executeProviderMutationOnce({
      session,
      step: 'patch',
      method: 'PATCH',
      payload: {},
      executionId: 'execution',
      assertCurrentInTransaction: fence,
      send: async () => ({ completion: 'acknowledged', result: 'remote' }),
      prepareEvidenceWakeup: async (tx, _session, fact) => {
        evidenceId = fact.factId;
        expect((await tx.get(db.doc('routing/current'))).get('generation')).toBe(1);
        return () => {
          tx.create(reference('wake/current'), { factId: fact.factId, signal: 'publishingEvidenceAvailable' });
        };
      },
    });
    expect(fence).toHaveBeenCalledTimes(1);
    expect(records.get(`temporalProviderMutationFacts/${evidenceId}`)?.completion).toBe('acknowledged');
    expect(
      records.get(`temporalProviderMutationSessions/${id}/requests/${providerMutationFingerprint('patch')}`)?.state
    ).toBe('acknowledged');
    expect(records.get('wake/current')).toEqual({ factId: evidenceId, signal: 'publishingEvidenceAvailable' });
  });

  function boundedFixture() {
    const f = closureFixture();
    Object.assign(f.record, {
      effectsClosed: true,
      effectsClosedSourceDispositionValidated: true,
      effectsClosedActualRequestCount: 0,
      effectsClosedClaimSetDigestVersion: 2,
      effectsClosedClaimSetDigest: providerMutationClaimSetSeed(f.session.id),
    });
    const proof = {
      closedClaimSetDigest: f.record.effectsClosedClaimSetDigest as string,
      originalRequestCount: 0,
      immutableCatalogDigest: providerMutationFingerprint('catalog'),
      canonicalCompletionDigest: providerMutationFingerprint('canonical'),
      expectedCanonicalPageCount: 2,
      completedCanonicalPageCount: 2,
    };
    return { ...f, proof };
  }
  test('bounded final settlement validates exact original seal and source canonical EOF before writes', async () => {
    const f = boundedFixture(),
      validator = jest.fn(async () => f.proof);
    const prepared = await prepareProviderMutationSessionCommitFromClosedEvidence(f.tx, f.session, validator);
    expect(validator).toHaveBeenCalledWith(
      f.tx,
      f.session,
      expect.objectContaining({ actualRequestCount: 0, claimSetDigest: f.proof.closedClaimSetDigest })
    );
    expect(f.update).not.toHaveBeenCalled();
    prepared.commit();
    expect(f.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: 'committed', canonicalCompletionDigest: f.proof.canonicalCompletionDigest })
    );
    expect((f.tx.get as jest.Mock).mock.calls).toHaveLength(3);
  });
  test.each(['digest', 'count', 'pages', 'catalog', 'unsealed'] as const)(
    'bounded settlement rejects %s without releasing ownership',
    async (kind) => {
      const f = boundedFixture();
      if (kind === 'digest') f.proof.closedClaimSetDigest = providerMutationFingerprint('other');
      if (kind === 'count') f.proof.originalRequestCount = 1;
      if (kind === 'pages') f.proof.completedCanonicalPageCount = 1;
      if (kind === 'catalog') f.proof.immutableCatalogDigest = '';
      if (kind === 'unsealed') delete f.record.effectsClosedActualRequestCount;
      await expect(
        prepareProviderMutationSessionCommitFromClosedEvidence(f.tx, f.session, async () => f.proof)
      ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
      expect(f.update).not.toHaveBeenCalled();
    }
  );
  test('missing private READY catalog cannot be replaced with a boolean completion assertion', async () => {
    const f = boundedFixture();
    await expect(
      prepareProviderMutationSessionCommitFromClosedEvidence(f.tx, f.session, async () => {
        throw Error('private READY missing');
      })
    ).rejects.toThrow('private READY missing');
    expect(f.update).not.toHaveBeenCalled();
  });

  test('version2 terminal claim chain has independent bounded pages and detects original field changes', () => {
    const id = providerMutationFingerprint('session'),
      seed = providerMutationClaimSetSeed(id);
    const rows = Array.from({ length: 65 }, (_, i) => ({
      requestId: providerMutationFingerprint(i),
      step: `step${i}`,
      method: 'PATCH',
      fingerprint: providerMutationFingerprint(['PATCH', i]),
      claim: `claim${i}`,
      executionId: 'original',
      state: 'acknowledged' as const,
    })).sort((a, b) => a.requestId.localeCompare(b.requestId));
    const full = rows.reduce(providerMutationClaimSetFold, seed);
    let paged = seed;
    for (let i = 0; i < rows.length; i += 32) paged = rows.slice(i, i + 32).reduce(providerMutationClaimSetFold, paged);
    expect(paged).toBe(full);
    expect(rows.slice(1).reduce(providerMutationClaimSetFold, seed)).not.toBe(full);
    expect(
      rows.map((row, i) => (i === 32 ? { ...row, claim: 'other' } : row)).reduce(providerMutationClaimSetFold, seed)
    ).not.toBe(full);
    expect(() => providerMutationClaimSetFold(seed, { ...rows[0], state: 'unknown' as never })).toThrow('UNRESOLVED');
  });
  test('legacy unversioned closure cannot authorize bounded final settlement', async () => {
    const f = boundedFixture();
    delete f.record.effectsClosedClaimSetDigestVersion;
    await expect(
      prepareProviderMutationSessionCommitFromClosedEvidence(f.tx, f.session, async () => f.proof)
    ).rejects.toThrow('UNRESOLVED');
    expect(f.update).not.toHaveBeenCalled();
  });

  test('bounded READY closure validates independent catalogue count and zero-claim seed, retaining active locks', async () => {
    const f = closureFixture(),
      proof = {
        sourceProgramDigest: providerMutationFingerprint('ready-program'),
        expectedRequestCount: 2,
        actualRequestCount: 0,
        claimSetDigest: providerMutationClaimSetSeed(f.session.id),
        claimSetDigestVersion: 2 as const,
      };
    const prepared = await prepareProviderMutationEffectsClosedFromReadyEvidence(f.tx, f.session, async () => proof);
    expect(f.update).not.toHaveBeenCalled();
    prepared.commit();
    expect(f.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        effectsClosed: true,
        effectsClosedActualRequestCount: 0,
        effectsClosedExpectedRequestCount: 2,
        effectsClosedClaimSetDigestVersion: 2,
      })
    );
    expect(f.update.mock.calls[0][1]).not.toHaveProperty('state');
  });
  test.each(['count', 'digest', 'version', 'coverage'] as const)(
    'bounded READY closure rejects %s before closure writes',
    async (kind) => {
      const f = closureFixture(),
        proof = {
          sourceProgramDigest: providerMutationFingerprint('ready-program'),
          expectedRequestCount: 2,
          actualRequestCount: 0,
          claimSetDigest: providerMutationClaimSetSeed(f.session.id),
          claimSetDigestVersion: 2 as const,
        };
      if (kind === 'count') proof.actualRequestCount = 1;
      if (kind === 'digest') proof.claimSetDigest = providerMutationFingerprint('fake');
      if (kind === 'version') proof.claimSetDigestVersion = 1 as never;
      if (kind === 'coverage') proof.expectedRequestCount = -1;
      await expect(
        prepareProviderMutationEffectsClosedFromReadyEvidence(f.tx, f.session, async () => proof)
      ).rejects.toThrow('UNRESOLVED');
      expect(f.update).not.toHaveBeenCalled();
    }
  );

  test('zero-effect stop authority is transaction-bound and source-validated before any write', async () => {
    const f = closureFixture();
    const prepared = await prepareZeroEffectsProviderMutationAbort(f.tx, f.session, async () => ({
      sourceProgramDigest: providerMutationFingerprint('sealed-zero-source'),
    }));
    expect(f.update).not.toHaveBeenCalled();
    expect(() => assertProviderMutationZeroEffectsProof(f.tx, prepared.proof, f.session.scope)).not.toThrow();
    expect(() => assertProviderMutationZeroEffectsProof({} as Transaction, prepared.proof, f.session.scope)).toThrow(
      'UNRESOLVED'
    );
    expect(() =>
      assertProviderMutationZeroEffectsProof(f.tx, prepared.proof, { ...f.session.scope, jobId: 'other' })
    ).toThrow('UNRESOLVED');
    expect(() => assertProviderMutationZeroEffectsProof(f.tx, {} as never, f.session.scope)).toThrow('UNRESOLVED');
    prepared.commit();
    expect(f.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        state: 'aborted',
        sourceZeroEffectsValidated: true,
        effectsClosedActualRequestCount: 0,
      })
    );
  });
  test('zero-effect stop cannot use a failed source catalogue assertion or ambiguous closure', async () => {
    const f = closureFixture();
    await expect(
      prepareZeroEffectsProviderMutationAbort(f.tx, f.session, async () => {
        throw Error('partial canonical cleanup');
      })
    ).rejects.toThrow('partial canonical cleanup');
    expect(f.update).not.toHaveBeenCalled();
    Object.assign(f.record, {
      effectsClosed: true,
      effectsClosedActualRequestCount: 0,
      effectsClosedClaimSetDigest: providerMutationClaimSetSeed(f.session.id),
    });
    await expect(
      prepareZeroEffectsProviderMutationAbort(f.tx, f.session, async () => ({
        sourceProgramDigest: providerMutationFingerprint('catalog'),
      }))
    ).rejects.toThrow('UNRESOLVED');
    expect(f.update).not.toHaveBeenCalled();
  });
});
