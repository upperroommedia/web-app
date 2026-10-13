import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  acquireProviderMutationSession as acquire,
  executeProviderMutationOnce as execute,
  commitProviderMutationSession as commit,
  abortUnsentProviderMutationSession as abort,
  PROVIDER_MUTATION_FACTS,
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint,
  providerMutationClaimSetSeed,
  providerMutationClaimSetFold,
  prepareProviderMutationEffectsClosed,
  prepareZeroEffectsProviderMutationAbort,
  assertProviderMutationZeroEffectsProof,
  prepareProviderMutationEffectsClosedFromReadyEvidence,
  prepareProviderMutationSessionCommitFromClosedEvidence,
  abortProvablyUnsentProviderMutationSessionsForJob,
  assertProviderMutationResourcesSettled,
  type ProviderMutationSession,
} from './providerMutationGuard';
const emulator = process.env.FIRESTORE_EMULATOR_HOST?.endsWith(':18081') ? describe : describe.skip;
emulator('shared provider mutation durable serialization actual Firestore', () => {
  const nonce = randomUUID(),
    projectId = process.env.GCLOUD_PROJECT ?? 'urm-app';
  const app = initializeApp({ projectId }, `mutation-guard-${nonce}`),
    db = getFirestore(app);
  const fence: () => Promise<void> = async () => undefined;
  let caseNonce: string;
  beforeEach(() => {
    caseNonce = randomUUID();
  });
  afterAll(async () => {
    await deleteApp(app);
  });
  async function session(resourceId: string, jobId: string, resourceType = 'list'): Promise<ProviderMutationSession> {
    return acquire({
      db,
      scope: { projectId, jobId: `${caseNonce}-${jobId}`, operation: 'membership' },
      resources: [
        { provider: 'subsplash', account: 'app:9XTSHD', resourceType, resourceId: `${caseNonce}-${resourceId}` },
      ],
      assertCurrentInTransaction: fence,
    });
  }
  async function patch(
    s: ProviderMutationSession,
    send: () => Promise<{ completion: 'acknowledged'; result: string }>,
    assertCurrentInTransaction = fence
  ) {
    return execute({
      session: s,
      step: 'membership-patch',
      method: 'PATCH',
      payload: { items: ['A'] },
      executionId: 'run/activity/attempt-1',
      assertCurrentInTransaction,
      send,
    });
  }
  test('lost ACK never expires, same owner cannot resend and another job cannot enter', async () => {
    const a = await session('unknown', 'A'),
      send = jest.fn(async () => {
        throw Error('lost ACK');
      });
    await expect(patch(a, send)).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
      mutationSessionId: a.id,
    });
    await expect(patch(a, send)).rejects.toThrow('UNRESOLVED');
    expect(send).toHaveBeenCalledTimes(1);
    await expect(session('unknown', 'B')).rejects.toThrow('UNRESOLVED');
    await expect(commit({ session: a, assertCurrentInTransaction: fence, mutate: async () => {} })).rejects.toThrow(
      'UNRESOLVED'
    );
    await expect(abort({ session: a, assertCurrentInTransaction: fence })).rejects.toThrow('UNRESOLVED');
  });
  test('original positive ACK holds until canonical commit; stale A cannot clobber B afterwards', async () => {
    const a = await session('ack', 'A'),
      send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: 'remote-A' }));
    await patch(a, send);
    await expect(session('ack', 'B')).rejects.toThrow('UNRESOLVED');
    await expect(patch(a, send)).resolves.toBe('remote-A');
    expect(send).toHaveBeenCalledTimes(1);
    const canonical = db.doc(`mutationGuardTest/${nonce}`);
    await commit({
      session: a,
      assertCurrentInTransaction: fence,
      mutate: async (tx) => {
        tx.set(canonical, { value: 'A' });
      },
    });
    const b = await session('ack', 'B');
    await patch(b, async () => ({ completion: 'acknowledged', result: 'remote-B' }));
    await commit({
      session: b,
      assertCurrentInTransaction: fence,
      mutate: async (tx) => {
        tx.set(canonical, { value: 'B' });
      },
    });
    await commit({
      session: a,
      assertCurrentInTransaction: fence,
      mutate: async (tx) => {
        tx.set(canonical, { value: 'late-A' });
      },
    });
    expect((await canonical.get()).get('value')).toBe('B');
    await canonical.delete();
  });
  test('actor revocation after send preserves positive original completion without granting canonical authority', async () => {
    const a = await session('revoked', 'A');
    let revoked = false;
    const current = async () => {
      if (revoked) throw Error('actor revoked');
    };
    await patch(
      a,
      async () => {
        revoked = true;
        return { completion: 'acknowledged', result: 'remote' };
      },
      current
    );
    expect((await db.collection(PROVIDER_MUTATION_FACTS).where('sessionId', '==', a.id).get()).size).toBe(1);
    await expect(commit({ session: a, assertCurrentInTransaction: current, mutate: async () => {} })).rejects.toThrow(
      'actor revoked'
    );
    await expect(session('revoked', 'B')).rejects.toThrow('UNRESOLVED');
  });
  test('unsent preflight may release; conservative resource aliases exclude type', async () => {
    const a = await session('alias', 'A', 'list');
    await expect(session('alias', 'B', 'series')).rejects.toThrow('UNRESOLVED');
    await abort({ session: a, assertCurrentInTransaction: fence });
    await expect(session('alias', 'B', 'series')).resolves.toBeDefined();
  });
  test('documented original rejection releases; unknown rejection cannot release', async () => {
    const a = await session('reject', 'A');
    await expect(
      execute({
        session: a,
        step: 'patch',
        method: 'PATCH',
        payload: {},
        executionId: 'execution',
        assertCurrentInTransaction: fence,
        send: async () => ({
          completion: 'rejected_no_effect',
          evidence: { transport: 'original_http_response', status: 400, providerCode: 'documented-no-mutation' },
        }),
      })
    ).rejects.toThrow('REJECTED_NO_EFFECT');
    await abort({ session: a, assertCurrentInTransaction: fence });
    await expect(session('reject', 'B')).resolves.toBeDefined();
  });
  test('all-resource acquisition fails atomically without leaving a partial lock', async () => {
    const a = await session('held', 'A');
    await expect(
      acquire({
        db,
        scope: { projectId, jobId: `${caseNonce}-B`, operation: 'batch' },
        resources: [
          ...a.resources,
          { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'list', resourceId: `${caseNonce}-free` },
        ],
        assertCurrentInTransaction: fence,
      })
    ).rejects.toThrow('UNRESOLVED');
    await expect(session('free', 'C')).resolves.toBeDefined();
  });
  test('oversized or credential-bearing provider response preserves original ACK but remains quarantined', async () => {
    const a = await session('unsafe-result', 'A');
    await expect(
      execute({
        session: a,
        step: 'patch',
        method: 'PATCH',
        payload: {},
        executionId: 'execution',
        assertCurrentInTransaction: fence,
        send: async () => ({
          completion: 'acknowledged',
          result: { id: 'remote', config: { headers: { Authorization: 'secret' } } },
        }),
      })
    ).rejects.toThrow('RESULT_REPAIR_REQUIRED');
    const facts = await db.collection(PROVIDER_MUTATION_FACTS).where('sessionId', '==', a.id).get();
    expect(facts.docs[0].get('completion')).toBe('acknowledged');
    expect(facts.docs[0].get('resultUnavailable')).toBe(true);
    expect(JSON.stringify(facts.docs[0].data())).not.toContain('secret');
    await expect(commit({ session: a, assertCurrentInTransaction: fence, mutate: async () => {} })).rejects.toThrow(
      'UNRESOLVED'
    );
  });
  test('unknown earlier step prohibits starting a different mutable step', async () => {
    const a = await session('whole-session', 'A');
    await expect(
      patch(a, async () => {
        throw Error('lost');
      })
    ).rejects.toThrow('UNRESOLVED');
    const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: 'remote' }));
    await expect(
      execute({
        session: a,
        step: 'another-step',
        method: 'PATCH',
        payload: { other: true },
        executionId: 'new-epoch',
        assertCurrentInTransaction: fence,
        send,
      })
    ).rejects.toThrow('UNRESOLVED');
    expect(send).not.toHaveBeenCalled();
  });

  test('one logical operation cannot expand its immutable resource set after acquisition', async () => {
    const a = await session('original-set', 'A');
    await expect(
      acquire({
        db,
        scope: a.scope,
        resources: [
          ...a.resources,
          { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'list', resourceId: `${caseNonce}-extra` },
        ],
        assertCurrentInTransaction: fence,
      })
    ).rejects.toThrow('UNRESOLVED');
    await expect(session('extra', 'B')).resolves.toBeDefined();
  });

  test('601-resource plan settles with 200 canonical mirrors without rewriting every resource lock', async () => {
    const resources = Array.from({ length: 601 }, (_, i) => ({
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      resourceType: 'list',
      resourceId: `${caseNonce}-large-${i}`,
    }));
    const a = await acquire({
      db,
      scope: { projectId, jobId: `${caseNonce}-A`, operation: 'large-membership' },
      resources,
      assertCurrentInTransaction: fence,
    });
    await patch(a, async () => ({ completion: 'acknowledged', result: 'remote' }));
    await commit({
      session: a,
      assertCurrentInTransaction: fence,
      mutate: async (tx) => {
        for (let i = 0; i < 200; i++) tx.set(db.doc(`mutationGuardTest/${caseNonce}/mirrors/${i}`), { value: 'A' });
      },
    });
    await expect(assertProviderMutationResourcesSettled({ db, projectId, resources })).resolves.toBeUndefined();
    await expect(
      acquire({
        db,
        scope: { projectId, jobId: `${caseNonce}-B`, operation: 'large-membership' },
        resources,
        assertCurrentInTransaction: fence,
      })
    ).resolves.toBeDefined();
  }, 30000);

  test('an unknown request after 405 acknowledged records still blocks the next send with an indexed sparse query', async () => {
    const a = await session('sparse', 'A');
    const requests = db.collection(PROVIDER_MUTATION_SESSIONS).doc(a.id).collection('requests');
    const batch = db.batch();
    for (let i = 0; i < 405; i++) {
      const step = `ack-${i}`;
      batch.create(requests.doc(providerMutationFingerprint(step)), {
        step,
        state: 'acknowledged',
        method: 'PATCH',
        claim: `claim-${i}`,
        executionId: 'original-execution',
        fingerprint: providerMutationFingerprint(['PATCH', { i }]),
        result: 'remote',
      });
    }
    const step = 'unknown-after-405';
    batch.create(requests.doc(providerMutationFingerprint(step)), {
      step,
      state: 'unknown',
      method: 'PATCH',
      claim: 'uncertain-claim',
      executionId: 'original-execution',
      fingerprint: providerMutationFingerprint(['PATCH', { unknown: true }]),
    });
    await batch.commit();
    const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: 'remote' }));
    await expect(patch(a, send)).rejects.toMatchObject({
      code: 'PROVIDER_MUTATION_UNRESOLVED',
      mutationSessionId: a.id,
    });
    expect(send).not.toHaveBeenCalled();
  });
  test('drained cancellation aborts only unsent sessions and retains known or uncertain effects', async () => {
    const unsent = await session('cancel-unsent', 'A'),
      unknown = await session('cancel-unknown', 'B'),
      ack = await session('cancel-ack', 'C');
    await expect(
      patch(unknown, async () => {
        throw Error('lost');
      })
    ).rejects.toThrow('UNRESOLVED');
    await patch(ack, async () => ({ completion: 'acknowledged', result: 'remote' }));
    const runner = <T>(mutate: (transaction: import('firebase-admin/firestore').Transaction) => Promise<T>) =>
      db.runTransaction(mutate);
    await expect(
      abortProvablyUnsentProviderMutationSessionsForJob(db, { projectId, jobId: unsent.scope.jobId }, runner)
    ).resolves.toEqual([]);
    const remainingUnknown = await abortProvablyUnsentProviderMutationSessionsForJob(
        db,
        { projectId, jobId: unknown.scope.jobId },
        runner
      ),
      remainingAck = await abortProvablyUnsentProviderMutationSessionsForJob(
        db,
        { projectId, jobId: ack.scope.jobId },
        runner
      );
    expect(remainingUnknown.map((item) => item.sessionId)).toEqual([unknown.id]);
    expect(remainingAck.map((item) => item.sessionId)).toEqual([ack.id]);
  });

  test('effects closure blocks all new HTTP claims while original ACK replay and owned canonical cleanup continue', async () => {
    const a = await session('effects-close', 'A'),
      send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: 'remote' }));
    await patch(a, send);
    const sourceProof = async () => ({
      sourceProgramDigest: providerMutationFingerprint('frozen-delete-program'),
      expectedRequestSteps: ['membership-patch'],
      qualifiedNoSendSteps: [],
    });
    await db.runTransaction(async (tx) => {
      const close = await prepareProviderMutationEffectsClosed(tx, a, sourceProof);
      close.commit();
    });
    expect((await db.collection(PROVIDER_MUTATION_SESSIONS).doc(a.id).get()).get('state')).toBe('active');
    await expect(patch(a, send)).resolves.toBe('remote');
    expect(send).toHaveBeenCalledTimes(1);
    const newSend = jest.fn(async () => ({ completion: 'acknowledged' as const, result: 'new' }));
    await expect(
      execute({
        session: a,
        step: 'late-new-step',
        method: 'PATCH',
        payload: {},
        executionId: 'new-SDK-epoch',
        assertCurrentInTransaction: fence,
        send: newSend,
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
    expect(newSend).not.toHaveBeenCalled();
    await expect(session('effects-close', 'B')).rejects.toThrow('UNRESOLVED');
    await db.runTransaction(async (tx) => {
      expect((await prepareProviderMutationEffectsClosed(tx, a, sourceProof)).alreadyClosed).toBe(true);
    });
    await commit({
      session: a,
      assertCurrentInTransaction: fence,
      mutate: async (tx) => {
        tx.set(db.doc(`mutationGuardTest/${caseNonce}`), { cleanupComplete: true });
      },
    });
    await expect(session('effects-close', 'B')).resolves.toBeDefined();
  });
  test('unknown effects cannot be sealed by a source disposition callback', async () => {
    const a = await session('close-unknown', 'A');
    await expect(
      patch(a, async () => {
        throw Error('lost');
      })
    ).rejects.toThrow('UNRESOLVED');
    const sourceValidator = jest.fn(async () => undefined);
    await expect(
      db.runTransaction(async (tx) => {
        (await prepareProviderMutationEffectsClosed(tx, a, sourceValidator)).commit();
      })
    ).rejects.toThrow('UNRESOLVED');
    expect(sourceValidator).not.toHaveBeenCalled();
    expect((await db.collection(PROVIDER_MUTATION_SESSIONS).doc(a.id).get()).get('effectsClosed')).toBeUndefined();
  });
  test('qualified initial NoSEND closure retains ownership until canonical completion and cannot be aborted as unsent', async () => {
    const a = await session('close-no-send', 'A');
    await db.runTransaction(async (tx) => {
      (
        await prepareProviderMutationEffectsClosed(tx, a, async () => ({
          sourceProgramDigest: providerMutationFingerprint('source-proved-legacy-retention'),
          expectedRequestSteps: ['retain-legacy-track'],
          qualifiedNoSendSteps: ['retain-legacy-track'],
        }))
      ).commit();
    });
    await expect(abort({ session: a, assertCurrentInTransaction: fence })).rejects.toThrow('UNRESOLVED');
    const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: 'remote' }));
    await expect(
      execute({
        session: a,
        step: 'retain-legacy-track',
        method: 'DELETE',
        payload: {},
        executionId: 'late-worker',
        assertCurrentInTransaction: fence,
        send,
      })
    ).rejects.toThrow('UNRESOLVED');
    expect(send).not.toHaveBeenCalled();
    await expect(session('close-no-send', 'B')).rejects.toThrow('UNRESOLVED');
    await commit({ session: a, assertCurrentInTransaction: fence, mutate: async () => {} });
    await expect(session('close-no-send', 'B')).resolves.toBeDefined();
  });

  test('original completion and metadata-only wakeup commit atomically after all routing reads', async () => {
    const a = await session('wake-atomic', 'A'),
      wake = db.doc(`mutationGuardWake/${caseNonce}`),
      route = db.doc(`mutationGuardWakeRouting/${caseNonce}`);
    await route.set({ generation: 1 });
    let factId: string | undefined;
    await execute({
      session: a,
      step: 'wake-step',
      method: 'PATCH',
      payload: {},
      executionId: 'original-execution',
      assertCurrentInTransaction: fence,
      send: async () => ({ completion: 'acknowledged', result: 'remote' }),
      prepareEvidenceWakeup: async (tx, _session, fact) => {
        factId = fact.factId;
        expect((await tx.get(route)).get('generation')).toBe(1);
        expect((await tx.get(wake)).exists).toBe(false);
        return () => {
          tx.create(wake, { signal: 'publishingEvidenceAvailable', sessionId: a.id, factId: fact.factId });
        };
      },
    });
    await db.runTransaction(async (tx) => {
      const [fact, request, wakeup] = await tx.getAll(
        db.collection(PROVIDER_MUTATION_FACTS).doc(factId!),
        db
          .collection(PROVIDER_MUTATION_SESSIONS)
          .doc(a.id)
          .collection('requests')
          .doc(providerMutationFingerprint('wake-step')),
        wake
      );
      expect(fact.get('completion')).toBe('acknowledged');
      expect(request.get('state')).toBe('acknowledged');
      expect(wakeup.get('factId')).toBe(fact.id);
    });
  });
  test('stale generation and revoked actor preserve original fact without publishing a wakeup', async () => {
    const a = await session('wake-stale', 'A'),
      wake = db.doc(`mutationGuardWake/${caseNonce}`),
      route = db.doc(`mutationGuardWakeRouting/${caseNonce}`);
    await route.set({ generation: 1 });
    let current = true,
      factId: string | undefined;
    const currentFence = jest.fn(async () => {
      if (!current) throw Error('revoked or stale');
    });
    await execute({
      session: a,
      step: 'wake-stale-step',
      method: 'PATCH',
      payload: {},
      executionId: 'original-execution',
      assertCurrentInTransaction: currentFence,
      send: async () => {
        current = false;
        await route.set({ generation: 2 });
        return { completion: 'acknowledged', result: 'remote' };
      },
      prepareEvidenceWakeup: async (tx, _session, fact) => {
        factId = fact.factId;
        if ((await tx.get(route)).get('generation') !== 1) return undefined;
        return () => {
          tx.create(wake, { factId: fact.factId });
        };
      },
    });
    expect(currentFence).toHaveBeenCalledTimes(1);
    expect((await db.collection(PROVIDER_MUTATION_FACTS).doc(factId!).get()).get('completion')).toBe('acknowledged');
    expect((await wake.get()).exists).toBe(false);
  });
  test('failed wakeup write cannot publish a partial acknowledgement or overwrite an existing command', async () => {
    const a = await session('wake-failed', 'A'),
      wake = db.doc(`mutationGuardWake/${caseNonce}`);
    await wake.set({ existing: true });
    let factId: string | undefined;
    const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: 'remote' }));
    await expect(
      execute({
        session: a,
        step: 'wake-failed-step',
        method: 'PATCH',
        payload: {},
        executionId: 'original-execution',
        assertCurrentInTransaction: fence,
        send,
        prepareEvidenceWakeup: async (_tx, _session, fact) => {
          factId = fact.factId;
          return () => {
            _tx.create(wake, { factId: fact.factId });
          };
        },
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.collection(PROVIDER_MUTATION_FACTS).doc(factId!).get()).exists).toBe(false);
    expect((await wake.get()).data()).toEqual({ existing: true });
    expect(
      (
        await db
          .collection(PROVIDER_MUTATION_SESSIONS)
          .doc(a.id)
          .collection('requests')
          .doc(providerMutationFingerprint('wake-failed-step'))
          .get()
      ).get('state')
    ).toBe('unknown');
  });

  test('bounded factual final settlement retains ownership until immutable source canonical completion', async () => {
    const a = await session('bounded-final', 'A');
    await patch(a, async () => ({ completion: 'acknowledged', result: 'remote' }));
    const original = await db
      .collection(PROVIDER_MUTATION_SESSIONS)
      .doc(a.id)
      .collection('requests')
      .doc(providerMutationFingerprint('membership-patch'))
      .get();
    const independentlyCompiled = providerMutationClaimSetFold(providerMutationClaimSetSeed(a.id), {
      requestId: original.id,
      step: original.get('step'),
      method: original.get('method'),
      fingerprint: original.get('fingerprint'),
      claim: original.get('claim'),
      executionId: original.get('executionId'),
      state: original.get('state'),
    });
    await db.runTransaction(async (tx) => {
      const prepared = await prepareProviderMutationEffectsClosed(tx, a, async () => undefined);
      prepared.commit();
    });
    const source = db.doc(`mutationGuardCanonicalCompletion/${caseNonce}`);
    await source.set({
      catalog: providerMutationFingerprint('catalog'),
      closedClaimSetDigest: independentlyCompiled,
      originalRequestCount: 1,
      complete: false,
      generation: 1,
    });
    const settle = async (current = true) =>
      db.runTransaction(async (tx) => {
        if (!current) throw Error('stale SDK');
        const prepared = await prepareProviderMutationSessionCommitFromClosedEvidence(
          tx,
          a,
          async (tx, _session, _seal) => {
            const fact = await tx.get(source);
            if (!fact.exists || fact.get('complete') !== true || fact.get('generation') !== 1)
              throw Error('canonical incomplete');
            return {
              closedClaimSetDigest: fact.get('closedClaimSetDigest'),
              originalRequestCount: fact.get('originalRequestCount'),
              immutableCatalogDigest: fact.get('catalog'),
              canonicalCompletionDigest: providerMutationFingerprint(fact.data()),
              expectedCanonicalPageCount: 2,
              completedCanonicalPageCount: 2,
            };
          }
        );
        prepared.commit();
      });
    await expect(settle()).rejects.toThrow('canonical incomplete');
    await expect(session('bounded-final', 'B')).rejects.toThrow('UNRESOLVED');
    await source.update({ complete: true });
    await expect(settle(false)).rejects.toThrow('stale SDK');
    await expect(session('bounded-final', 'B')).rejects.toThrow('UNRESOLVED');
    await settle();
    await expect(session('bounded-final', 'B')).resolves.toBeDefined();
  });
  test('unexpected unknown after original closure blocks bounded settlement before source proof', async () => {
    const a = await session('bounded-unknown', 'A');
    await db.runTransaction(async (tx) => {
      const prepared = await prepareProviderMutationEffectsClosed(tx, a, async () => undefined);
      prepared.commit();
    });
    await db
      .collection(PROVIDER_MUTATION_SESSIONS)
      .doc(a.id)
      .collection('requests')
      .doc('unexpected')
      .set({ state: 'unknown' });
    const validator = jest.fn(async () => {
      throw Error('must never reach source');
    });
    await expect(
      db.runTransaction((tx) => prepareProviderMutationSessionCommitFromClosedEvidence(tx, a, validator))
    ).rejects.toThrow('UNRESOLVED');
    expect(validator).not.toHaveBeenCalled();
    await expect(session('bounded-unknown', 'B')).rejects.toThrow('UNRESOLVED');
  });

  test('bounded READY original evidence closes admission atomically without releasing resources', async () => {
    const a = await session('bounded-close', 'A');
    await patch(a, async () => ({ completion: 'acknowledged', result: 'remote' }));
    const original = await db
      .collection(PROVIDER_MUTATION_SESSIONS)
      .doc(a.id)
      .collection('requests')
      .doc(providerMutationFingerprint('membership-patch'))
      .get();
    const chain = providerMutationClaimSetFold(providerMutationClaimSetSeed(a.id), {
      requestId: original.id,
      step: original.get('step'),
      method: original.get('method'),
      fingerprint: original.get('fingerprint'),
      claim: original.get('claim'),
      executionId: original.get('executionId'),
      state: original.get('state'),
    });
    const ready = db.doc(`mutationGuardReadyClosure/${caseNonce}`);
    await ready.set({
      program: providerMutationFingerprint('full-private-program'),
      claimSetDigest: chain,
      actualCount: 1,
      expectedCount: 2,
      qualifiedNoSend: true,
    });
    const close = () =>
      db.runTransaction(async (tx) => {
        const prepared = await prepareProviderMutationEffectsClosedFromReadyEvidence(tx, a, async (tx) => {
          const proof = await tx.get(ready);
          if (!proof.get('qualifiedNoSend')) throw Error('source coverage missing');
          return {
            sourceProgramDigest: proof.get('program'),
            expectedRequestCount: proof.get('expectedCount'),
            actualRequestCount: proof.get('actualCount'),
            claimSetDigest: proof.get('claimSetDigest'),
            claimSetDigestVersion: 2,
          };
        });
        prepared.commit();
      });
    await ready.update({ actualCount: 2 });
    await expect(close()).rejects.toThrow('UNRESOLVED');
    expect((await db.collection(PROVIDER_MUTATION_SESSIONS).doc(a.id).get()).get('effectsClosed')).toBeUndefined();
    await ready.update({ actualCount: 1 });
    await close();
    await close();
    expect((await db.collection(PROVIDER_MUTATION_SESSIONS).doc(a.id).get()).get('state')).toBe('active');
    await expect(session('bounded-close', 'B')).rejects.toThrow('UNRESOLVED');
    const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: 'remote-new' }));
    await expect(
      execute({
        session: a,
        step: 'new-step',
        method: 'PATCH',
        payload: {},
        executionId: 'new-sdk',
        assertCurrentInTransaction: fence,
        send,
      })
    ).rejects.toThrow('UNRESOLVED');
    expect(send).not.toHaveBeenCalled();
  });
  test('bounded READY closure refuses unknown original RPC before invoking source proof', async () => {
    const a = await session('bounded-close-unknown', 'A');
    await expect(
      patch(a, async () => {
        throw Error('lost RPC');
      })
    ).rejects.toThrow('UNRESOLVED');
    const source = jest.fn(async () => {
      throw Error('must never reach source');
    });
    await expect(
      db.runTransaction((tx) => prepareProviderMutationEffectsClosedFromReadyEvidence(tx, a, source))
    ).rejects.toThrow('UNRESOLVED');
    expect(source).not.toHaveBeenCalled();
    await expect(session('bounded-close-unknown', 'B')).rejects.toThrow('UNRESOLVED');
  });

  test('job unsent cleanup preserves an exact certified preflight session across restart without releasing its lock', async () => {
    const preserved = await session('preserved-certified', 'A');
    const other = await acquire({
      db,
      scope: { ...preserved.scope, operation: 'abandoned-original' },
      resources: [{ ...preserved.resources[0], resourceId: `${caseNonce}-abandoned-original` }],
      assertCurrentInTransaction: fence,
    });
    const runner = <T>(mutate: (tx: FirebaseFirestore.Transaction) => Promise<T>) => db.runTransaction(mutate);
    const remaining = await abortProvablyUnsentProviderMutationSessionsForJob(
      db,
      { projectId, jobId: preserved.scope.jobId },
      runner,
      { preserveSessionIds: [preserved.id] }
    );
    expect(remaining.map((record) => record.sessionId)).toEqual([preserved.id]);
    expect((await db.collection(PROVIDER_MUTATION_SESSIONS).doc(other.id).get()).get('state')).toBe('aborted');
    await expect(session('preserved-certified', 'B')).rejects.toThrow('UNRESOLVED');
    await expect(
      abortProvablyUnsentProviderMutationSessionsForJob(db, { projectId, jobId: preserved.scope.jobId }, runner, {
        preserveSessionIds: ['not-a-session-id'],
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_ID_INVALID' });
  });

  test('zero-effect guard abort and source cleanup share one transaction-bound authority', async () => {
    const a = await session('zero-composed', 'A'),
      source = db.doc(`mutationGuardZeroSource/${caseNonce}`),
      canonical = db.doc(`mutationGuardZeroCanonical/${caseNonce}`);
    await source.set({ digest: providerMutationFingerprint('sealed-empty-source'), zero: true });
    await canonical.set({ blocked: true });
    const stop = () =>
      db.runTransaction(async (tx) => {
        const prepared = await prepareZeroEffectsProviderMutationAbort(tx, a, async (tx) => {
          const proof = await tx.get(source);
          if (proof.get('zero') !== true) throw Error('source zero missing');
          return { sourceProgramDigest: proof.get('digest') };
        });
        assertProviderMutationZeroEffectsProof(tx, prepared.proof, {
          projectId,
          jobId: a.scope.jobId,
          sessionId: a.id,
        });
        await tx.get(canonical);
        tx.update(canonical, { blocked: false });
        prepared.commit();
      });
    await source.update({ zero: false });
    await expect(stop()).rejects.toThrow('source zero missing');
    expect((await canonical.get()).get('blocked')).toBe(true);
    await expect(session('zero-composed', 'B')).rejects.toThrow('UNRESOLVED');
    await source.update({ zero: true });
    await stop();
    expect((await canonical.get()).get('blocked')).toBe(false);
    expect((await db.collection(PROVIDER_MUTATION_SESSIONS).doc(a.id).get()).get('sourceZeroEffectsValidated')).toBe(
      true
    );
    await expect(session('zero-composed', 'B')).resolves.toBeDefined();
  });
  test('zero-effect guard never aborts a claimed original request including acknowledged or rejected requests', async () => {
    const a = await session('zero-claimed', 'A');
    await patch(a, async () => ({ completion: 'acknowledged', result: 'remote' }));
    const source = jest.fn(async () => ({ sourceProgramDigest: providerMutationFingerprint('not-zero') }));
    await expect(db.runTransaction((tx) => prepareZeroEffectsProviderMutationAbort(tx, a, source))).rejects.toThrow(
      'UNRESOLVED'
    );
    expect(source).not.toHaveBeenCalled();
    await expect(session('zero-claimed', 'B')).rejects.toThrow('UNRESOLVED');
  });
});
