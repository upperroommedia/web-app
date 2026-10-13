import { randomUUID, createHash } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  prepareProviderUsageChanges,
  prepareDesiredProviderDeletion,
  prepareDesiredProviderDeletionSettlement,
  prepareProviderCleanupClaim,
  prepareProviderCleanupSettlement,
  prepareProviderBinding,
  prepareProviderAcknowledgementDisposition,
  providerAcknowledgementFactFingerprint,
  providerResourceKey,
  providerEdgeKey,
  desiredProviderDeletionIntentFingerprint,
  desiredProviderDeletionDocumentFingerprint,
  PROVIDER_USAGE_CONTROL,
} from './provider-usage';

/** Run only through the dedicated firebase.test.json harness; never target the live dev stack. */
const describeWithEmulator = process.env.FIRESTORE_EMULATOR_HOST?.endsWith(':18081') ? describe : describe.skip;
describeWithEmulator('provider usage authoritative Firestore transactions', () => {
  const projectId = process.env.GCLOUD_PROJECT ?? 'urm-app';
  const nonce = randomUUID(),
    epoch = `provider-proof-${nonce}`;
  const app = initializeApp({ projectId }, `provider-index-${nonce}`),
    db = getFirestore(app);
  const marker = db.doc(PROVIDER_USAGE_CONTROL);
  let oldMarker: Record<string, unknown> | undefined;
  beforeAll(async () => {
    oldMarker = (await marker.get()).data();
    await marker.set({ schemaVersion: 1, projectId, epoch, status: 'ready', releaseId: 'test', controlRevision: 1 });
  });
  afterAll(async () => {
    if (oldMarker) await marker.set(oldMarker);
    else await marker.delete();
    await deleteApp(app);
  });
  const setup = async () => {
    const remoteId = `provider-${randomUUID()}`,
      jobId = `job-${randomUUID()}`,
      receiptId = `receipt-${randomUUID()}`;
    const resource = { projectId, provider: 'subsplash' as const, account: 'app:9XTSHD', remoteId };
    const proof = { jobId, receiptId, fingerprint: 'fingerprint', receiptRevision: 0 };
    await db
      .collection('temporalProviderReceipts')
      .doc(receiptId)
      .set({
        projectId,
        jobId,
        step: 'image-create',
        fingerprint: 'fingerprint',
        state: 'confirmed',
        revision: 0,
        result: { id: remoteId },
      });
    return {
      resource,
      proof,
      aggregate: db.doc(`temporalProviderUsage/${providerResourceKey(resource)}/epochs/${epoch}`),
    };
  };
  test('concurrent DELETE claim and canonical image association share a serializable barrier', async () => {
    const { resource, proof, aggregate } = await setup(),
      canonical = db.doc(`sermons/provider-${randomUUID()}`);
    const results = await Promise.allSettled([
      db.runTransaction(async (tx) => {
        const claim = await prepareProviderCleanupClaim(tx, db, resource, proof);
        claim.commit();
        return claim.state;
      }),
      db.runTransaction(async (tx) => {
        const previous = await tx.get(canonical);
        const next = { images: [{ subsplashId: resource.remoteId }] };
        const commit = await prepareProviderUsageChanges(tx, db, [
          { projectId, canonicalPath: canonical.path, before: previous.data(), after: next },
        ]);
        commit();
        tx.set(canonical, next);
      }),
    ]);
    const state = (await aggregate.get()).data()!;
    if (state.state === 'reserved') {
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'reserved' });
      expect(results[1].status).toBe('rejected');
      expect((await canonical.get()).exists).toBe(false);
    } else {
      expect(state.referenceCount).toBe(1);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'referenced' });
      expect(results[1].status).toBe('fulfilled');
    }
  });
  test('canonical reference count remains exact above 500 documents with batched writes', async () => {
    const { resource, proof, aggregate } = await setup();
    for (let start = 0; start < 600; start += 50)
      await db.runTransaction(async (tx) => {
        const changes = Array.from({ length: 50 }, (_, i) => ({
          projectId,
          canonicalPath: `sermons/${resource.remoteId}-${start + i}`,
          before: undefined,
          after: { images: [{ subsplashId: resource.remoteId }] },
        }));
        const commit = await prepareProviderUsageChanges(tx, db, changes);
        commit();
        for (const change of changes) tx.create(db.doc(change.canonicalPath), change.after);
      });
    expect((await aggregate.get()).get('referenceCount')).toBe(600);
    await db.runTransaction(async (tx) => {
      const claim = await prepareProviderCleanupClaim(tx, db, resource, proof);
      expect(claim.state).toBe('referenced');
      claim.commit();
    });
  });
  test('binding request cannot race a cleanup claim; deletion tombstone survives worker restart', async () => {
    const { resource, proof, aggregate } = await setup();
    await db.runTransaction(async (tx) => {
      (await prepareProviderCleanupClaim(tx, db, resource, proof)).commit();
    });
    await expect(
      db.runTransaction(async (tx) => {
        (await prepareProviderBinding(tx, db, { resource, jobId: 'another', bindingId: 'bind' }))();
      })
    ).rejects.toThrow('CLEANUP_RESERVED');
    expect((await aggregate.get()).get('state')).toBe('reserved');
    await db.runTransaction(async (tx) => {
      (await prepareProviderCleanupSettlement(tx, db, resource, proof, 'confirmed_absent'))();
    });
    await expect(
      db.runTransaction(async (tx) => {
        (await prepareProviderBinding(tx, db, { resource, jobId: 'another', bindingId: 'bind' }))();
      })
    ).rejects.toThrow('CLEANUP_RESERVED');
    expect((await aggregate.get()).get('state')).toBe('deleted');
  });
  test('private intent and canonical writes in one transaction preserve both reference counts', async () => {
    const { resource, aggregate } = await setup();
    await db.runTransaction(async (tx) => {
      const intent = await prepareProviderUsageChanges(tx, db, [
        {
          projectId,
          canonicalPath: `durableJobIntents/${resource.remoteId}`,
          before: undefined,
          after: { payload: { images: [{ subsplashId: resource.remoteId }] } },
        },
      ]);
      const canonical = await prepareProviderUsageChanges(tx, db, [
        {
          projectId,
          canonicalPath: `sermons/${resource.remoteId}`,
          before: undefined,
          after: { images: [{ subsplashId: resource.remoteId }] },
        },
      ]);
      intent();
      canonical();
    });
    expect((await aggregate.get()).get('referenceCount')).toBe(2);
  });
  test('original ACK review swaps or retires its exact pending child binding in real Firestore', async () => {
    for (const decision of ['retain_after_review', 'cleanup_verified'] as const) {
      const { resource, proof, aggregate } = await setup();
      const fact = {
        schemaVersion: 1,
        projectId,
        jobId: proof.jobId,
        receiptId: proof.receiptId,
        step: 'image-create',
        attemptOwner: 'original',
        claimRevision: 1,
        payloadFingerprint: proof.fingerprint,
        remoteId: resource.remoteId,
        disposition: 'orphaned',
        acknowledgedAtMillis: 1,
      };
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const acknowledgementId = digest([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]);
      await db.collection('temporalProviderAcknowledgements').doc(acknowledgementId).set(fact);
      const pendingBinding = {
        jobId: digest(['provider-orphan-review', projectId, acknowledgementId]),
        bindingId: `pending-provider-ack:${acknowledgementId}`,
      };
      await db.runTransaction(async (tx) => {
        (await prepareProviderBinding(tx, db, { resource, ...pendingBinding }))();
      });
      await db.runTransaction(async (tx) => {
        (
          await prepareProviderAcknowledgementDisposition(tx, db, {
            resource,
            jobId: proof.jobId,
            acknowledgementId,
            factFingerprint: providerAcknowledgementFactFingerprint(fact),
            decision,
            pendingBinding,
          })
        )();
      });
      expect((await aggregate.get()).get('referenceCount')).toBe(decision === 'retain_after_review' ? 1 : 0);
      expect((await aggregate.get()).get('state')).toBe(decision === 'retain_after_review' ? 'active' : 'deleted');
      expect((await aggregate.collection('edges').where('bindingId', '==', pendingBinding.bindingId).get()).empty).toBe(
        true
      );
    }
  });
  const desiredSetup = async () => {
    const { resource, proof, aggregate } = await setup();
    const jobId = proof.jobId,
      sermonId = `delete-${randomUUID()}`,
      entity = { type: 'sermon', id: sermonId },
      canonical = { id: sermonId, subsplashId: resource.remoteId };
    const intent = {
      projectId,
      jobId,
      kind: 'sermon.delete',
      entity,
      generation: 1,
      payload: {
        sermonId,
        action: 'delete',
        generation: 1,
        destinations: { soundcloud: true, listIds: [] },
        payload: { sermon: canonical },
      },
    };
    await db.doc(`durableJobs/${jobId}`).set({
      projectId,
      jobId,
      kind: 'sermon.delete',
      entity,
      generation: 1,
      state: 'running',
      workflowId: 'workflow',
    });
    await db.doc(`durableJobIntents/${jobId}`).set(intent);
    await db.doc(`sermons/${sermonId}`).set(canonical);
    const planId = createHash('sha256')
      .update(JSON.stringify([projectId, jobId, sermonId]))
      .digest('hex');
    await db.doc(`temporalSermonDeletionMirrorPlans/${planId}`).set({
      schemaVersion: 1,
      projectId,
      jobId,
      sermonId,
      planId,
      generation: 1,
      workflowId: 'workflow',
      intentFingerprint: desiredProviderDeletionIntentFingerprint(intent),
      originalRoot: canonical,
      state: 'prepared',
      frozenProgramDigest: 'f'.repeat(64),
    });
    await db.runTransaction(async (tx) => {
      (
        await prepareProviderUsageChanges(tx, db, [
          { projectId, canonicalPath: `durableJobIntents/${jobId}`, before: undefined, after: intent },
          { projectId, canonicalPath: `sermons/${sermonId}`, before: undefined, after: canonical },
        ])
      )();
    });
    return {
      resource,
      aggregate,
      jobId,
      sermonId,
      intent,
      canonical,
      input: { resource, jobId, resourceType: 'media' as const },
    };
  };
  test('desired DELETE and concurrent new association contend on the same serializable reservation', async () => {
    const { resource, aggregate, input } = await desiredSetup();
    const results = await Promise.allSettled([
      db.runTransaction(async (tx) => {
        (await prepareDesiredProviderDeletion(tx, db, input)).commit();
      }),
      db.runTransaction(async (tx) => {
        (
          await prepareProviderBinding(tx, db, { resource, jobId: 'another-publisher', bindingId: 'new-association' })
        )();
      }),
    ]);
    const current = (await aggregate.get()).data()!;
    if (current.state === 'reserved') {
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(current.referenceCount).toBe(2);
    } else {
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      expect(current.referenceCount).toBe(3);
    }
  });
  test('a completed same-sermon mirror introduced after capture blocks DELETE until exact ledger recapture', async () => {
    const { resource, input, jobId, sermonId } = await desiredSetup();
    const path = `lists/late-${resource.remoteId}/listItems/${sermonId}`,
      data = { subsplashId: resource.remoteId };
    await db.runTransaction(async (tx) => {
      (
        await prepareProviderUsageChanges(tx, db, [{ projectId, canonicalPath: path, before: undefined, after: data }])
      )();
      tx.set(db.doc(path), data);
    });
    await expect(
      db.runTransaction(async (tx) => {
        (await prepareDesiredProviderDeletion(tx, db, input)).commit();
      })
    ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
    const planId = createHash('sha256')
      .update(JSON.stringify([projectId, jobId, sermonId]))
      .digest('hex');
    await db
      .doc(`temporalSermonDeletionMirrorPlans/${planId}/rows/${providerEdgeKey(path)}`)
      .set({ canonicalPath: path, sourceFingerprint: desiredProviderDeletionDocumentFingerprint(data) });
    await db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    });
  });
  test('desired DELETE cannot discard another active intent or a permanent reviewed retention', async () => {
    for (const foreign of ['intent', 'retention']) {
      const { resource, input } = await desiredSetup();
      if (foreign === 'retention')
        await db.runTransaction(async (tx) => {
          (
            await prepareProviderBinding(tx, db, {
              resource,
              jobId: 'retention-owner',
              bindingId: 'retained-existing:proof',
            })
          )();
        });
      else
        await db.runTransaction(async (tx) => {
          const path = `durableJobIntents/other-${randomUUID()}`;
          (
            await prepareProviderUsageChanges(tx, db, [
              { projectId, canonicalPath: path, before: undefined, after: { subsplashId: resource.remoteId } },
            ])
          )();
          tx.set(db.doc(path), { subsplashId: resource.remoteId });
        });
      await expect(
        db.runTransaction(async (tx) => {
          (await prepareDesiredProviderDeletion(tx, db, input)).commit();
        })
      ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
    }
  });
  test('desired DELETE pages more than 500 owned mirror edges and settles only after real canonical retirement', async () => {
    const { resource, aggregate, input, jobId, sermonId, intent, canonical } = await desiredSetup();
    const mirrors = Array.from({ length: 550 }, (_, i) => ({
      projectId,
      canonicalPath: `lists/${resource.remoteId}-${i}/listItems/${sermonId}`,
      before: undefined,
      after: { id: sermonId, type: 'sermon', subsplashId: resource.remoteId },
    }));
    for (let offset = 0; offset < mirrors.length; offset += 50)
      await db.runTransaction(async (tx) => {
        const chunk = mirrors.slice(offset, offset + 50);
        (await prepareProviderUsageChanges(tx, db, chunk))();
        for (const row of chunk) tx.set(db.doc(row.canonicalPath), row.after);
        const planId = createHash('sha256')
          .update(JSON.stringify([projectId, jobId, sermonId]))
          .digest('hex');
        for (const row of chunk)
          tx.set(db.doc(`temporalSermonDeletionMirrorPlans/${planId}/rows/${providerEdgeKey(row.canonicalPath)}`), {
            canonicalPath: row.canonicalPath,
            sourceFingerprint: desiredProviderDeletionDocumentFingerprint(row.after),
          });
      });
    await db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    });
    expect((await aggregate.get()).get('referenceCount')).toBe(552);
    await expect(
      db.runTransaction(async (tx) => {
        (await prepareDesiredProviderDeletionSettlement(tx, db, input))();
      })
    ).rejects.toThrow('SETTLEMENT_PENDING');
    const changes = [
      ...mirrors.map((row) => ({ ...row, before: row.after, after: undefined })),
      { projectId, canonicalPath: `sermons/${sermonId}`, before: canonical, after: undefined },
    ];
    for (let offset = 0; offset < changes.length; offset += 50)
      await db.runTransaction(async (tx) => {
        const chunk = changes.slice(offset, offset + 50);
        (await prepareProviderUsageChanges(tx, db, chunk))();
        for (const row of chunk) tx.delete(db.doc(row.canonicalPath));
      });
    await db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletionSettlement(tx, db, input))();
    });
    expect((await aggregate.get()).get('state')).toBe('deleted');
    expect((await aggregate.get()).get('referenceCount')).toBe(1);
    await db.runTransaction(async (tx) => {
      (
        await prepareProviderUsageChanges(tx, db, [
          { projectId, canonicalPath: `durableJobIntents/${jobId}`, before: intent, after: undefined },
        ])
      )();
    });
    expect((await aggregate.get()).get('referenceCount')).toBe(0);
  });
});
