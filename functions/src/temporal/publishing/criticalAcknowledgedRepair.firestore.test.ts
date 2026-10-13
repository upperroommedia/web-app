import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  acquireProviderMutationSession,
  executeProviderMutationOnce,
  providerMutationFingerprint,
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
  PROVIDER_MUTATION_LOCKS,
} from './providerMutationGuard';
import {
  prepareAcknowledgedProjectionPlan,
  prepareAcknowledgedRepair,
  commitAcknowledgedRepair,
  ACKNOWLEDGED_PROJECTION_PLANS,
  ACKNOWLEDGED_PROJECTION_PROGRESS,
  acknowledgedProjectionDigest,
  readAcknowledgedRepairRequiredVerifications,
} from './criticalAcknowledgedRepair';

import { compileAcknowledgedRepairCandidatePage, ACKNOWLEDGED_REPAIR_CANDIDATES } from './acknowledgedRepairCandidate';

const emulator = process.env.FIRESTORE_EMULATOR_HOST?.endsWith(':18081') ? describe : describe.skip;
emulator('acknowledged critical projection actual Firestore roundtrip', () => {
  let app: App, db: Firestore;
  beforeAll(() => {
    app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'urm-app' }, `ack-repair-${randomUUID()}`);
    db = getFirestore(app);
  });
  afterAll(async () => {
    await deleteApp(app);
  });
  test('Date plan survives SDK serialization; original ACK after actor revocation repairs only under fresh admin fence', async () => {
    const nonce = randomUUID(),
      projectId = app.options.projectId!,
      ref = { projectId, jobId: `ack-repair-${nonce}` },
      sermon = db.doc(`sermons/ack-repair-${nonce}`),
      intent = db.doc(`durableJobIntents/${ref.jobId}`),
      date = new Date('2026-10-12T10:30:00.123Z');
    const scope = { ...ref, operation: 'metadata' },
      resource = {
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        resourceType: 'media' as const,
        resourceId: `ack-repair-${nonce}`,
      };
    const admitted = {
      ...ref,
      kind: 'sermon.publish',
      generation: 1,
      entity: { type: 'sermon', id: sermon.id },
      payload: { patch: { title: 'New title', date } },
    };
    await intent.set(admitted);
    await db.doc(`durableJobs/${ref.jobId}`).set({ ...admitted, state: 'needs_attention' });
    await sermon.set({ title: 'Old title', subsplashId: resource.resourceId });
    const session = await acquireProviderMutationSession({
      db,
      scope,
      resources: [resource],
      assertCurrentInTransaction: async () => undefined,
    });
    const payload = { title: 'New title' },
      fingerprint = providerMutationFingerprint(['PATCH', { target: resource, body: payload }]);
    let revoked = false;
    const originalFence = async () => {
      if (revoked) throw Error('actor revoked');
    };
    try {
      await db.runTransaction(async (tx) => {
        await originalFence();
        const frozen = await prepareAcknowledgedProjectionPlan(tx, session, {
          requests: [{ step: 'metadata', method: 'PATCH', fingerprint, target: resource, payload }],
          writes: [
            {
              path: sermon.path,
              expectedFields: { subsplashId: resource.resourceId },
              patch: { title: 'New title', date },
            },
          ],
          verifications: [
            {
              provider: 'subsplash',
              account: 'app:9XTSHD',
              resourceType: 'media',
              resourceId: resource.resourceId,
              expectedProviderFields: payload,
            },
          ],
          uiStepIds: ['metadata'],
        });
        frozen.commit();
      });
      const requestIndex = await db
        .doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/requestIndex/${providerMutationFingerprint('metadata')}`)
        .get();
      const persisted = await db
        .doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/pages/${requestIndex.get('pageDigest')}`)
        .get();
      expect(acknowledgedProjectionDigest(persisted.get('writes')[0].patch.date)).toBe(
        acknowledgedProjectionDigest(date)
      );
      const send = jest.fn(async () => {
        revoked = true;
        return { completion: 'acknowledged' as const, result: { updated: true } };
      });
      await executeProviderMutationOnce({
        session,
        step: 'metadata',
        method: 'PATCH',
        payload: { target: resource, body: payload },
        executionId: 'original-run/activity-1/attempt-1',
        assertCurrentInTransaction: originalFence,
        send,
      });
      await expect(
        db.runTransaction(async (tx) => {
          await originalFence();
          tx.update(sermon, { title: 'New title' });
        })
      ).rejects.toThrow('actor revoked');
      let adminCurrent = false,
        sdkCurrent = true;
      const freshFence = async () => {
        if (!adminCurrent) throw Error('fresh admin authority required');
        if (!sdkCurrent) throw Error('current SDK execution required');
      };
      const compile = () =>
        compileAcknowledgedRepairCandidatePage(db, ref, session.id, {
          commitCurrent: (_ref, mutate) =>
            db.runTransaction(async (tx) => {
              await freshFence();
              return mutate(tx);
            }),
        });
      await expect(compile()).rejects.toThrow('fresh admin authority required');
      adminCurrent = true;
      sdkCurrent = false;
      await expect(compile()).rejects.toThrow('current SDK execution required');
      sdkCurrent = true;
      let ready = false;
      for (let page = 0; page < 100; page++) {
        if ((await compile()).state === 'ready') {
          ready = true;
          break;
        }
      }
      expect(ready).toBe(true);
      const prepared = await db.runTransaction(async (tx) => {
        await freshFence();
        return prepareAcknowledgedRepair(tx, db, ref, session.id);
      });
      adminCurrent = false;
      const commit = () =>
        db.runTransaction(async (tx) => {
          await freshFence();
          await readAcknowledgedRepairRequiredVerifications(tx, db, ref, prepared.operation, {
            observationScope: 'fresh-admin/certificate-original/sdk-current',
          });
          return commitAcknowledgedRepair(
            tx,
            db,
            ref,
            prepared.operation,
            [{ ...resource, state: 'present', body: payload }],
            { observationScope: 'fresh-admin/certificate-original/sdk-current' }
          );
        });
      await expect(commit()).rejects.toThrow('fresh admin authority required');
      expect((await sermon.get()).get('title')).toBe('Old title');
      adminCurrent = true;
      sdkCurrent = false;
      await expect(commit()).rejects.toThrow('current SDK execution required');
      sdkCurrent = true;
      let projected = 0,
        finished = false;
      for (let page = 0; page < 100; page++) {
        const result = await commit();
        projected += result.writesCompleted;
        if (result.needsContinuation) {
          expect((await db.doc(`${PROVIDER_MUTATION_SESSIONS}/${session.id}`).get()).get('state')).toBe('active');
          continue;
        }
        expect(result.settledUiStepIds).toEqual(['metadata']);
        finished = true;
        break;
      }
      expect(projected).toBe(1);
      expect(finished).toBe(true);
      expect((await sermon.get()).get('title')).toBe('New title');
      expect((await sermon.get()).get('date').toMillis()).toBe(date.getTime());
      expect((await db.doc(`${PROVIDER_MUTATION_SESSIONS}/${session.id}`).get()).get('state')).toBe('committed');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      const facts = await db.collection(PROVIDER_MUTATION_FACTS).where('sessionId', '==', session.id).get();
      for (const fact of facts.docs) await fact.ref.delete();
      const candidates = await db
        .collection(ACKNOWLEDGED_REPAIR_CANDIDATES)
        .where('projectId', '==', projectId)
        .where('jobId', '==', ref.jobId)
        .get();
      for (const candidate of candidates.docs) await db.recursiveDelete(candidate.ref);
      await Promise.all([
        db.recursiveDelete(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${session.id}`)),
        db.recursiveDelete(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}`)),
        db.recursiveDelete(db.doc(`${ACKNOWLEDGED_PROJECTION_PROGRESS}/${session.id}`)),
      ]);
      await Promise.all([
        sermon.delete(),
        intent.delete(),
        db.doc(`durableJobs/${ref.jobId}`).delete(),
        db
          .doc(
            `${PROVIDER_MUTATION_LOCKS}/${providerMutationFingerprint([
              projectId,
              resource.provider,
              resource.account,
              resource.resourceId,
            ])}`
          )
          .delete(),
      ]);
    }
  });
});
