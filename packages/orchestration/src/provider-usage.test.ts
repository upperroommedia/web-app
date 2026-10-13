import { createHash } from 'node:crypto';
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: (delta: number) => ({ testIncrement: delta }) },
}));
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  extractProviderResources,
  prepareProviderUsageChanges,
  prepareDesiredProviderDeletion,
  prepareDesiredProviderDeletions,
  prepareDesiredProviderDeletionSettlement,
  prepareDesiredProviderDeletionAbort,
  prepareDesiredProviderDeletionZeroEffectsAbort,
  prepareDesiredProviderDeletionPartialStopAbort,
  desiredProviderDeletionPlanId,
  desiredProviderDeletionIntentFingerprint,
  desiredProviderDeletionDocumentFingerprint,
  providerEdgeKey,
  prepareProviderAcknowledgementDisposition,
  providerAcknowledgementFactFingerprint,
  prepareProviderCleanupClaim,
  prepareProviderCleanupSettlement,
  prepareProviderBinding,
  prepareReviewedLegacySoundCloudRetentionBinding,
  prepareProviderBindingRelease,
  PROVIDER_USAGE_CONTROL,
  providerResourceKey,
} from './provider-usage';
function memory() {
  const docs = new Map<string, any>();
  const resolveValue = (path: string, value: any) => ({
    ...value,
    ...(value.referenceCount?.testIncrement !== undefined
      ? { referenceCount: (docs.get(path)?.referenceCount ?? 0) + value.referenceCount.testIncrement }
      : {}),
  });
  let tail = Promise.resolve();
  const snapshot = (path: string): any => ({
    ref: ref(path),
    id: path.split('/').at(-1),
    exists: docs.has(path),
    data: () => docs.get(path),
    get: (key: string) => docs.get(path)?.[key],
  });
  const collection = (path: string): any => ({
    doc: (id: string) => ref(`${path}/${id}`),
    where: (field: string, _operator: string, value: unknown) => query(path, undefined, undefined, [[field, value]]),
    orderBy: (_field: string) => query(path),
  });
  const query = (path: string, limit?: number, cursor?: string, filters: Array<[string, unknown]> = []): any => ({
    isQuery: true,
    path,
    limitCount: limit,
    cursor,
    filters,
    orderBy: () => query(path, limit, cursor, filters),
    where: (field: string, _operator: string, value: unknown) =>
      query(path, limit, cursor, [...filters, [field, value]]),
    limit: (count: number) => query(path, count, cursor, filters),
    startAfter: (after: any) => query(path, limit, after.ref.path, filters),
  });
  const ref = (path: string): any => ({
    path,
    id: path.split('/').at(-1),
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const db = {
    doc: ref,
    collection,
    runTransaction: <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
      const result = tail.then(async () => {
        let writing = false;
        const writes: Array<() => void> = [];
        const tx: any = {
          get: async (r: any) => {
            if (writing) throw Error('READ_AFTER_WRITE');
            if (r.isQuery) {
              const paths = [...docs.keys()]
                .filter(
                  (path) =>
                    path.startsWith(`${r.path}/`) &&
                    !path.slice(r.path.length + 1).includes('/') &&
                    (!r.cursor || path > r.cursor) &&
                    r.filters.every(
                      ([field, value]: [string, unknown]) =>
                        field.split('.').reduce((data: any, key: string) => data?.[key], docs.get(path)) === value
                    )
                )
                .sort()
                .slice(0, r.limitCount);
              return { docs: paths.map(snapshot), size: paths.length, empty: paths.length === 0 };
            }
            return snapshot(r.path);
          },
          getAll: (...references: any[]) => Promise.all(references.map((reference) => tx.get(reference))),
          set: (r: any, value: any, opts: any) => {
            writing = true;
            writes.push(() =>
              docs.set(
                r.path,
                opts?.merge ? { ...docs.get(r.path), ...resolveValue(r.path, value) } : resolveValue(r.path, value)
              )
            );
            return tx;
          },
          create: (r: any, value: any) => {
            writing = true;
            writes.push(() => {
              if (docs.has(r.path)) throw Error('EXISTS');
              docs.set(r.path, value);
            });
            return tx;
          },
          update: (r: any, value: any) => {
            writing = true;
            writes.push(() => docs.set(r.path, { ...docs.get(r.path), ...resolveValue(r.path, value) }));
            return tx;
          },
          delete: (r: any) => {
            writing = true;
            writes.push(() => docs.delete(r.path));
            return tx;
          },
        };
        const value = await fn(tx);
        writes.forEach((write) => write());
        return value;
      });
      tail = result.then(
        () => {},
        () => {}
      );
      return result;
    },
  } as unknown as Firestore;
  docs.set(PROVIDER_USAGE_CONTROL, {
    schemaVersion: 1,
    projectId: 'test',
    epoch: 'epoch',
    status: 'ready',
    releaseId: 'release',
    controlRevision: 1,
  });
  return { docs, db };
}
const resource = { projectId: 'test', provider: 'subsplash' as const, account: 'app:9XTSHD', remoteId: 'image1' };
const proof = { jobId: 'job1', receiptId: 'receipt1', fingerprint: 'fingerprint', receiptRevision: 0 };
const aggregate = `temporalProviderUsage/${providerResourceKey(resource)}/epochs/epoch`;
const seedReceipt = (docs: Map<string, any>) =>
  docs.set('temporalProviderReceipts/receipt1', {
    projectId: 'test',
    jobId: 'job1',
    fingerprint: 'fingerprint',
    revision: 0,
    state: 'confirmed',
    step: 'image-create',
    result: { id: 'image1' },
  });
test('extracts nested canonical membership/images/tags while ignoring local IDs', () => {
  const refs = extractProviderResources('test', 'lists/list/listItems/sermon', {
    id: 'local',
    mediaItem: {
      subsplashId: 'media1',
      images: [{ id: 'localimage', subsplashId: 'image1' }],
      speakers: [{ tagId: 'tag1', images: [{ subsplashId: 'image1' }] }],
      soundCloudTrackId: 'track1',
    },
    physicalPlacement: { subsplashListId: 'list1' },
  });
  expect(refs.map((ref) => ref.remoteId).sort()).toEqual(['image1', 'list1', 'media1', 'tag1', 'track1']);
});
test('batch adds more than 500 canonical references without lost aggregate increments', async () => {
  const { docs, db } = memory();
  for (let start = 0; start < 1200; start += 100)
    await db.runTransaction(async (tx) => {
      const commit = await prepareProviderUsageChanges(
        tx,
        db,
        Array.from({ length: 100 }, (_, i) => ({
          projectId: 'test',
          canonicalPath: `sermons/${start + i}`,
          before: undefined,
          after: { images: [{ subsplashId: 'image1' }] },
        }))
      );
      commit();
    });
  expect(docs.get(aggregate).referenceCount).toBe(1200);
  seedReceipt(docs);
  await db.runTransaction(async (tx) => {
    const claim = await prepareProviderCleanupClaim(tx, db, resource, proof);
    expect(claim.state).toBe('referenced');
    claim.commit();
  });
  expect(docs.get(aggregate).state).toBe('active');
});
test('claim and concurrent new canonical edge serialize at shared resource barrier', async () => {
  const { docs, db } = memory();
  seedReceipt(docs);
  const [claim, edge] = await Promise.allSettled([
    db.runTransaction(async (tx) => {
      const claim = await prepareProviderCleanupClaim(tx, db, resource, proof);
      claim.commit();
      return claim.state;
    }),
    db.runTransaction(async (tx) => {
      (
        await prepareProviderUsageChanges(tx, db, [
          {
            projectId: 'test',
            canonicalPath: 'sermons/new',
            before: undefined,
            after: { images: [{ subsplashId: 'image1' }] },
          },
        ])
      )();
    }),
  ]);
  expect(claim).toMatchObject({ status: 'fulfilled', value: 'reserved' });
  expect(edge.status).toBe('rejected');
  expect(docs.get(aggregate).referenceCount).toBe(0);
});
test('unknown receipt cannot authorize DELETE and unknown DELETE retains reservation indefinitely', async () => {
  const { docs, db } = memory();
  seedReceipt(docs);
  docs.get('temporalProviderReceipts/receipt1').state = 'needs_review';
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderCleanupClaim(tx, db, resource, proof)).commit();
    })
  ).rejects.toThrow('PROOF_INVALID');
  docs.get('temporalProviderReceipts/receipt1').state = 'confirmed';
  await db.runTransaction(async (tx) => {
    (await prepareProviderCleanupClaim(tx, db, resource, proof)).commit();
  });
  docs.get(aggregate).reservedAtMillis = 1;
  await expect(
    db.runTransaction(async (tx) => {
      (
        await prepareProviderUsageChanges(tx, db, [
          { projectId: 'test', canonicalPath: 'images/new', before: undefined, after: { subsplashId: 'image1' } },
        ])
      )();
    })
  ).rejects.toThrow('CLEANUP_RESERVED');
  expect(docs.get(aggregate).state).toBe('reserved');
});
test('confirmed absent creates permanent tombstone; explicit reviewed retain reopens only matching reservation', async () => {
  const { docs, db } = memory();
  seedReceipt(docs);
  await db.runTransaction(async (tx) => {
    (await prepareProviderCleanupClaim(tx, db, resource, proof)).commit();
  });
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderCleanupSettlement(tx, db, resource, { ...proof, jobId: 'other' }, 'reviewed_retain'))();
    })
  ).rejects.toThrow('MISMATCH');
  await db.runTransaction(async (tx) => {
    (await prepareProviderCleanupSettlement(tx, db, resource, proof, 'confirmed_absent'))();
  });
  expect(docs.get(aggregate).state).toBe('deleted');
  await expect(
    db.runTransaction(async (tx) => {
      (
        await prepareProviderUsageChanges(tx, db, [
          { projectId: 'test', canonicalPath: 'images/new', before: undefined, after: { subsplashId: 'image1' } },
        ])
      )();
    })
  ).rejects.toThrow('CLEANUP_RESERVED');
});
test('absence of index readiness or canonical edge divergence fails closed', async () => {
  const { docs, db } = memory();
  await expect(
    db.runTransaction(async (tx) => {
      (
        await prepareProviderUsageChanges(tx, db, [
          { projectId: 'test', canonicalPath: 'images/new', before: { subsplashId: 'image1' }, after: undefined },
        ])
      )();
    })
  ).rejects.toThrow('EDGE_MISMATCH');
  docs.get(PROVIDER_USAGE_CONTROL).status = 'building';
  seedReceipt(docs);
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderCleanupClaim(tx, db, resource, proof)).commit();
    })
  ).rejects.toThrow('NOT_READY');
});
test('adopted existing resource is always retained because selection does not prove exclusive ownership', async () => {
  const { docs, db } = memory();
  seedReceipt(docs);
  docs.get('temporalProviderReceipts/receipt1').adoptionAudit = {
    decision: 'adopt_existing_resource',
    duplicateRiskAcknowledged: true,
  };
  await db.runTransaction(async (tx) => {
    const claim = await prepareProviderCleanupClaim(tx, db, resource, proof);
    expect(claim.state).toBe('referenced');
    claim.commit();
  });
  expect(docs.has(aggregate)).toBe(false);
});

test('external binding reservation prevents DELETE before canonical write and ambiguous effect keeps protection', async () => {
  const { docs, db } = memory();
  seedReceipt(docs);
  const binding = { resource, jobId: 'publisher', bindingId: 'attach-image' };
  await db.runTransaction(async (tx) => {
    (await prepareProviderBinding(tx, db, binding))();
  });
  await db.runTransaction(async (tx) => {
    const claim = await prepareProviderCleanupClaim(tx, db, resource, proof);
    expect(claim.state).toBe('referenced');
    claim.commit();
  });
  expect(docs.get(aggregate).referenceCount).toBe(1);
  await db.runTransaction(async (tx) => {
    (await prepareProviderBindingRelease(tx, db, binding))();
  });
  await db.runTransaction(async (tx) => {
    const claim = await prepareProviderCleanupClaim(tx, db, resource, proof);
    expect(claim.state).toBe('reserved');
    claim.commit();
  });
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderBinding(tx, db, binding))();
    })
  ).rejects.toThrow('CLEANUP_RESERVED');
});

test('incorrect provider account cannot bypass a referenced aggregate', async () => {
  const { docs, db } = memory();
  seedReceipt(docs);
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderCleanupClaim(tx, db, { ...resource, account: 'other-app' }, proof)).commit();
    })
  ).rejects.toThrow('SCOPE_INVALID');
});
test('separate intent and canonical preparations in one transaction accumulate rather than overwrite counts', async () => {
  const { docs, db } = memory();
  await db.runTransaction(async (tx) => {
    const intent = await prepareProviderUsageChanges(tx, db, [
      {
        projectId: 'test',
        canonicalPath: 'durableJobIntents/publisher',
        before: undefined,
        after: { payload: { images: [{ subsplashId: 'image1' }] } },
      },
    ]);
    const canonical = await prepareProviderUsageChanges(tx, db, [
      {
        projectId: 'test',
        canonicalPath: 'sermons/new',
        before: undefined,
        after: { images: [{ subsplashId: 'image1' }] },
      },
    ]);
    intent();
    canonical();
  });
  expect(docs.get(aggregate).referenceCount).toBe(2);
});

function originalAcknowledgement(docs: Map<string, any>) {
  const fact = {
    schemaVersion: 1,
    projectId: 'test',
    jobId: 'job1',
    receiptId: 'originalReceipt',
    step: 'image-create',
    attemptOwner: 'originalAttempt',
    claimRevision: 2,
    payloadFingerprint: 'privatePayload',
    remoteId: 'image1',
    disposition: 'orphaned',
    acknowledgedAtMillis: 100,
  };
  const acknowledgementId = createHash('sha256')
    .update(JSON.stringify([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]))
    .digest('hex');
  docs.set(`temporalProviderAcknowledgements/${acknowledgementId}`, fact);
  return { resource, jobId: 'job1', acknowledgementId, factFingerprint: providerAcknowledgementFactFingerprint(fact) };
}
test('reviewed original acknowledgement retention protects original identity independent of adopted result', async () => {
  const { docs, db } = memory(),
    input = originalAcknowledgement(docs);
  seedReceipt(docs);
  docs.get('temporalProviderReceipts/receipt1').result = { id: 'adoptedOtherImage' };
  await db.runTransaction(async (tx) => {
    (await prepareProviderAcknowledgementDisposition(tx, db, { ...input, decision: 'retain_after_review' }))();
  });
  expect(docs.get(aggregate).referenceCount).toBe(1);
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderAcknowledgementDisposition(tx, db, { ...input, decision: 'cleanup_verified' }))();
    })
  ).rejects.toThrow('RESOURCE_REFERENCED');
});
test('verified original acknowledgement absence tombstones original ID without touching adopted ID', async () => {
  const { docs, db } = memory(),
    input = originalAcknowledgement(docs);
  await db.runTransaction(async (tx) => {
    (await prepareProviderAcknowledgementDisposition(tx, db, { ...input, decision: 'cleanup_verified' }))();
  });
  expect(docs.get(aggregate).state).toBe('deleted');
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderBinding(tx, db, { resource, jobId: 'job2', bindingId: 'bind-original' }))();
    })
  ).rejects.toThrow('CLEANUP_RESERVED');
  await db.runTransaction(async (tx) => {
    (
      await prepareProviderBinding(tx, db, {
        resource: { ...resource, remoteId: 'adoptedOtherImage' },
        jobId: 'job2',
        bindingId: 'bind-adopted',
      })
    )();
  });
});
test('acknowledgement disposition rejects changed fact and rekeyed adopted identity', async () => {
  const { docs, db } = memory(),
    input = originalAcknowledgement(docs);
  await expect(
    db.runTransaction(async (tx) => {
      (
        await prepareProviderAcknowledgementDisposition(tx, db, {
          ...input,
          resource: { ...resource, remoteId: 'adoptedOtherImage' },
          decision: 'cleanup_verified',
        })
      )();
    })
  ).rejects.toThrow('PROOF_INVALID');
  docs.get(`temporalProviderAcknowledgements/${input.acknowledgementId}`).payloadFingerprint = 'changed';
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderAcknowledgementDisposition(tx, db, { ...input, decision: 'retain_after_review' }))();
    })
  ).rejects.toThrow('PROOF_INVALID');
});

function pendingOrphanBinding(input: ReturnType<typeof originalAcknowledgement>) {
  return {
    jobId: createHash('sha256')
      .update(JSON.stringify(['provider-orphan-review', 'test', input.acknowledgementId]))
      .digest('hex'),
    bindingId: `pending-provider-ack:${input.acknowledgementId}`,
  };
}
test('verified orphan absence retires only its exact child pending edge atomically with the original ID tombstone', async () => {
  const { docs, db } = memory(),
    input = originalAcknowledgement(docs),
    pendingBinding = pendingOrphanBinding(input);
  await db.runTransaction(async (tx) => {
    (await prepareProviderBinding(tx, db, { resource, ...pendingBinding }))();
  });
  expect(docs.get(aggregate).referenceCount).toBe(1);
  await db.runTransaction(async (tx) => {
    (
      await prepareProviderAcknowledgementDisposition(tx, db, {
        ...input,
        pendingBinding,
        decision: 'cleanup_verified',
      })
    )();
  });
  expect(docs.get(aggregate)).toMatchObject({ state: 'deleted', referenceCount: 0 });
  expect([...docs.values()].some((value) => value.bindingId === pendingBinding.bindingId)).toBe(false);
});
test('orphan retention swaps pending child edge for permanent original edge without losing counts', async () => {
  const { docs, db } = memory(),
    input = originalAcknowledgement(docs),
    pendingBinding = pendingOrphanBinding(input);
  await db.runTransaction(async (tx) => {
    (await prepareProviderBinding(tx, db, { resource, ...pendingBinding }))();
  });
  await db.runTransaction(async (tx) => {
    (
      await prepareProviderAcknowledgementDisposition(tx, db, {
        ...input,
        pendingBinding,
        decision: 'retain_after_review',
      })
    )();
  });
  expect(docs.get(aggregate).referenceCount).toBe(1);
  expect([...docs.values()].some((value) => value.bindingId === pendingBinding.bindingId)).toBe(false);
  expect([...docs.values()].some((value) => value.bindingId === `retained-orphan:${input.acknowledgementId}`)).toBe(
    true
  );
});
test('arbitrary binding substitution or additional reference refuses orphan retirement', async () => {
  const { docs, db } = memory(),
    input = originalAcknowledgement(docs),
    pendingBinding = pendingOrphanBinding(input);
  await db.runTransaction(async (tx) => {
    (await prepareProviderBinding(tx, db, { resource, ...pendingBinding }))();
  });
  await expect(
    db.runTransaction(async (tx) => {
      (
        await prepareProviderAcknowledgementDisposition(tx, db, {
          ...input,
          pendingBinding: { ...pendingBinding, jobId: 'unrelated' },
          decision: 'cleanup_verified',
        })
      )();
    })
  ).rejects.toThrow('PENDING_BINDING_INVALID');
  await db.runTransaction(async (tx) => {
    (await prepareProviderBinding(tx, db, { resource, jobId: 'another-job', bindingId: 'another-binding' }))();
  });
  await expect(
    db.runTransaction(async (tx) => {
      (
        await prepareProviderAcknowledgementDisposition(tx, db, {
          ...input,
          pendingBinding,
          decision: 'cleanup_verified',
        })
      )();
    })
  ).rejects.toThrow('RESOURCE_REFERENCED');
  expect(docs.get(aggregate)).toMatchObject({ state: 'active', referenceCount: 2 });
});

async function desiredFixture() {
  const memoryDB = memory(),
    { docs, db } = memoryDB,
    jobId = 'desired-job';
  const entity = { type: 'sermon', id: 'own-sermon' };
  const canonical = { id: 'own-sermon', subsplashId: 'image1' };
  const intent = {
    projectId: 'test',
    jobId,
    kind: 'sermon.delete',
    entity,
    generation: 1,
    payload: {
      sermonId: entity.id,
      action: 'delete',
      generation: 1,
      destinations: { soundcloud: true, listIds: [] },
      payload: { sermon: canonical },
    },
  };
  docs.set(`sermons/${entity.id}`, canonical);
  docs.set(`durableJobIntents/${jobId}`, intent);
  docs.set(`durableJobs/${jobId}`, {
    projectId: 'test',
    jobId,
    kind: intent.kind,
    entity,
    generation: 1,
    state: 'running',
    workflowId: 'workflow',
  });
  const planId = createHash('sha256')
    .update(JSON.stringify(['test', jobId, entity.id]))
    .digest('hex');
  docs.set(`temporalSermonDeletionMirrorPlans/${planId}`, {
    schemaVersion: 1,
    projectId: 'test',
    jobId,
    sermonId: entity.id,
    planId,
    generation: 1,
    workflowId: 'workflow',
    intentFingerprint: desiredProviderDeletionIntentFingerprint(intent),
    state: 'prepared',
    originalRoot: canonical,
    frozenProgramDigest: 'f'.repeat(64),
  });
  await db.runTransaction(async (tx) => {
    (
      await prepareProviderUsageChanges(tx, db, [
        { projectId: 'test', canonicalPath: `sermons/${entity.id}`, before: undefined, after: canonical },
        { projectId: 'test', canonicalPath: `durableJobIntents/${jobId}`, before: undefined, after: intent },
      ])
    )();
  });
  return { ...memoryDB, jobId, intent, canonical, input: { resource, jobId, resourceType: 'media' as const } };
}
test('desired DELETE reserves its exact own canonical and immutable intent references without clearing counts', async () => {
  const { docs, db, input, jobId, intent, canonical } = await desiredFixture();
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  expect(docs.get(aggregate)).toMatchObject({ state: 'reserved', referenceCount: 2 });
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderBinding(tx, db, { resource, jobId: 'other', bindingId: 'new-association' }))();
    })
  ).rejects.toThrow('CLEANUP_RESERVED');
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletionSettlement(tx, db, input))();
    })
  ).rejects.toThrow('SETTLEMENT_PENDING');
  await db.runTransaction(async (tx) => {
    (
      await prepareProviderUsageChanges(tx, db, [
        { projectId: 'test', canonicalPath: 'sermons/own-sermon', before: canonical, after: { id: 'own-sermon' } },
      ])
    )();
    tx.set(db.doc('sermons/own-sermon'), { id: 'own-sermon' });
  });
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletionSettlement(tx, db, input))();
  });
  expect(docs.get(aggregate)).toMatchObject({ state: 'deleted', referenceCount: 1 });
  await db.runTransaction(async (tx) => {
    (
      await prepareProviderUsageChanges(tx, db, [
        { projectId: 'test', canonicalPath: `durableJobIntents/${jobId}`, before: intent, after: undefined },
      ])
    )();
  });
  expect(docs.get(aggregate)).toMatchObject({ state: 'deleted', referenceCount: 0 });
});
test('desired DELETE blocks other canonical references, active intents and even own unresolved association bindings', async () => {
  for (const extra of ['canonical', 'intent', 'binding']) {
    const { db, input } = await desiredFixture();
    if (extra === 'binding')
      await db.runTransaction(async (tx) => {
        (await prepareProviderBinding(tx, db, { resource, jobId: input.jobId, bindingId: 'unknown-association' }))();
      });
    else
      await db.runTransaction(async (tx) => {
        const path = extra === 'canonical' ? 'sermons/other' : 'durableJobIntents/other';
        const data = { subsplashId: 'image1' };
        (
          await prepareProviderUsageChanges(tx, db, [
            { projectId: 'test', canonicalPath: path, before: undefined, after: data },
          ])
        )();
        tx.set(db.doc(path), data);
      });
    await expect(
      db.runTransaction(async (tx) => {
        (await prepareDesiredProviderDeletion(tx, db, input)).commit();
      })
    ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
  }
});
test('desired DELETE rejects arbitrary IDs or mutation kinds and survives ambiguous deletion without timeout escape', async () => {
  const { db, docs, input } = await desiredFixture();
  await expect(
    db.runTransaction(async (tx) => {
      (
        await prepareDesiredProviderDeletion(tx, db, { ...input, resource: { ...resource, remoteId: 'arbitrary' } })
      ).commit();
    })
  ).rejects.toThrow('PROOF_INVALID');
  docs.get(`durableJobIntents/${input.jobId}`).kind = 'sermon.publish';
  docs.get(`durableJobs/${input.jobId}`).kind = 'sermon.publish';
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    })
  ).rejects.toThrow('PROOF_INVALID');
  docs.get(`durableJobIntents/${input.jobId}`).kind = 'sermon.delete';
  docs.get(`durableJobs/${input.jobId}`).kind = 'sermon.delete';
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  docs.get(aggregate).reservedAtMillis = 1;
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  expect(docs.get(aggregate)).toMatchObject({ state: 'reserved', referenceCount: 2, reservedAtMillis: 1 });
});
async function desiredEntityFixture(
  kind: string,
  type: string,
  entityId: string,
  inputData: Record<string, unknown>,
  documents: Record<string, any>
) {
  const context = memory(),
    { docs, db } = context,
    jobId = 'entity-delete',
    entity = { type, id: entityId };
  const intent = {
    projectId: 'test',
    jobId,
    kind,
    entity,
    generation: 1,
    payload: {
      kind,
      entity,
      actorUid: 'admin',
      generation: 1,
      payload: { operation: kind === 'speaker.mutate' ? 'delete' : 'delete', input: inputData },
    },
  };
  docs.set(`durableJobIntents/${jobId}`, intent);
  docs.set(`durableJobs/${jobId}`, { projectId: 'test', jobId, kind, entity, generation: 1, state: 'running' });
  Object.entries(documents).forEach(([path, data]) => docs.set(path, data));
  await db.runTransaction(async (tx) => {
    (
      await prepareProviderUsageChanges(
        tx,
        db,
        Object.entries(documents).map(([canonicalPath, after]) => ({
          projectId: 'test',
          canonicalPath,
          before: undefined,
          after,
        }))
      )
    )();
  });
  return { ...context, jobId, intent };
}
test('desired list chain deletion derives ownership and blocks another list overflow reference', async () => {
  const { db, docs, jobId } = await desiredEntityFixture(
    'list.delete',
    'list',
    'root',
    {},
    {
      'lists/root': { subsplashId: 'image1', moreSermonsRef: 'overflow' },
      'lists/child': { subsplashId: 'overflow', rootListId: 'root' },
    }
  );
  const input = { resource, jobId, resourceType: 'list' as const };
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  expect(docs.get(aggregate).state).toBe('reserved');
  const foreign = await desiredEntityFixture(
    'list.delete',
    'list',
    'root',
    {},
    {
      'lists/root': { subsplashId: 'image1' },
      'lists/external': { subsplashId: 'external', manualOverflowTargetSubsplashId: 'image1' },
    }
  );
  await expect(
    foreign.db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, foreign.db, { ...input, jobId: foreign.jobId })).commit();
    })
  ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
});
test('desired series and speaker tag deletion require the exact normalized entity and actually removed speaker references', async () => {
  const series = await desiredEntityFixture(
    'series.delete',
    'series',
    'series1',
    {},
    { 'series/series1': { subsplashId: 'image1' } }
  );
  await series.db.runTransaction(async (tx) => {
    (
      await prepareDesiredProviderDeletion(tx, series.db, { resource, jobId: series.jobId, resourceType: 'series' })
    ).commit();
  });
  const speaker = await desiredEntityFixture(
    'speaker.mutate',
    'speaker',
    'speaker1',
    { speakerId: 'speaker1', deleteAssociatedList: false },
    {
      'speakers/speaker1': { tagId: 'image1' },
      'sermons/with-speaker': { speakers: [{ id: 'speaker1', tagId: 'image1' }] },
    }
  );
  await speaker.db.runTransaction(async (tx) => {
    (
      await prepareDesiredProviderDeletion(tx, speaker.db, { resource, jobId: speaker.jobId, resourceType: 'tag' })
    ).commit();
  });
  const mirror = await desiredEntityFixture(
    'speaker.mutate',
    'speaker',
    'speaker1',
    { speakerId: 'speaker1', deleteAssociatedList: false },
    {
      'speakers/speaker1': { tagId: 'image1' },
      'lists/list/listItems/sermon': { speakers: [{ id: 'speaker1', tagId: 'image1' }] },
    }
  );
  await expect(
    mirror.db.runTransaction(async (tx) => {
      (
        await prepareDesiredProviderDeletion(tx, mirror.db, { resource, jobId: mirror.jobId, resourceType: 'tag' })
      ).commit();
    })
  ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
});

test('desired list mirror removal requires a sealed server projection and unchanged source fingerprint', async () => {
  const path = 'sermons/sermon/sermonLists/root',
    canonical = { id: 'root', subsplashId: 'image1' };
  const { db, docs, jobId, intent } = await desiredEntityFixture(
    'list.delete',
    'list',
    'root',
    {},
    { 'lists/root': { subsplashId: 'image1' }, [path]: canonical }
  );
  const input = { resource, jobId, resourceType: 'list' as const },
    planId = desiredProviderDeletionPlanId(input);
  docs.set(`temporalProviderDesiredDeletionPlans/${planId}`, {
    schemaVersion: 1,
    projectId: 'test',
    jobId,
    resource,
    resourceType: 'list',
    entity: { type: 'list', id: 'root' },
    generation: 1,
    intentFingerprint: desiredProviderDeletionIntentFingerprint(intent),
    method: 'DELETE',
    requestFingerprint: 'a'.repeat(64),
    state: 'prepared',
  });
  docs.set(`temporalProviderDesiredDeletionPlans/${planId}/removals/${providerEdgeKey(path)}`, {
    canonicalPath: path,
    sourceFingerprint: desiredProviderDeletionDocumentFingerprint(canonical),
    after: 'absent',
  });
  docs.get(path).changedAfterFreeze = true;
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    })
  ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
  delete docs.get(path).changedAfterFreeze;
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  expect(docs.get(aggregate).desiredDeletionProof.projectionPlanFingerprint).toMatch(/^[a-f0-9]{64}$/);
  docs.get(`temporalProviderDesiredDeletionPlans/${planId}`).requestFingerprint = 'b'.repeat(64);
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    })
  ).rejects.toThrow('PROOF_INVALID');
});
test('canonical speaker identity takes priority over a shared provider tag and blocks deletion', async () => {
  const { db, jobId } = await desiredEntityFixture(
    'speaker.mutate',
    'speaker',
    'selected',
    { speakerId: 'selected' },
    {
      'speakers/selected': { tagId: 'image1' },
      'sermons/other': { speakers: [{ id: 'different-speaker', tagId: 'image1' }] },
    }
  );
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, { resource, jobId, resourceType: 'tag' })).commit();
    })
  ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
});
test('a same-sermon mirror added after frozen capture blocks the first DELETE until recaptured', async () => {
  const { db, docs, input, jobId } = await desiredFixture(),
    path = 'lists/late/listItems/own-sermon',
    data = { subsplashId: 'image1' };
  await db.runTransaction(async (tx) => {
    (
      await prepareProviderUsageChanges(tx, db, [
        { projectId: 'test', canonicalPath: path, before: undefined, after: data },
      ])
    )();
    tx.set(db.doc(path), data);
  });
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    })
  ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
  const planId = createHash('sha256')
    .update(JSON.stringify(['test', jobId, 'own-sermon']))
    .digest('hex');
  docs.set(`temporalSermonDeletionMirrorPlans/${planId}/rows/${providerEdgeKey(path)}`, {
    canonicalPath: path,
    sourceFingerprint: desiredProviderDeletionDocumentFingerprint(data),
  });
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  expect(docs.get(aggregate).state).toBe('reserved');
});
test('reviewed unverified SC retention converts only its own unsent reservation and preserves another positive provider effect', async () => {
  const { db, docs, input, intent, jobId } = await desiredFixture();
  Object.assign(intent.payload.payload.sermon, { soundCloudTrackId: 'track' });
  const planId = createHash('sha256')
    .update(JSON.stringify(['test', jobId, 'own-sermon']))
    .digest('hex');
  docs.get(`temporalSermonDeletionMirrorPlans/${planId}`).intentFingerprint =
    desiredProviderDeletionIntentFingerprint(intent);
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  const scResource = {
    projectId: 'test',
    provider: 'soundcloud' as const,
    account: 'configured-account',
    remoteId: 'track',
  };
  const scAggregate = `temporalProviderUsage/${providerResourceKey(scResource)}/epochs/epoch`;
  const digest = desiredProviderDeletionDocumentFingerprint;
  const observation = {
    projectId: 'test',
    jobId,
    trackId: 'track',
    originalOwner: 'unverified',
    originalHttpStatus: 404,
    providerMutationSent: false,
  };
  const certificate = {
    schemaVersion: 1,
    projectId: 'test',
    jobId,
    generation: 1,
    workflowId: 'workflow',
    sermonId: 'own-sermon',
    trackId: 'track',
    resource: scResource,
    canonicalDocumentDigest: 'c'.repeat(64),
    intentFingerprint: digest(intent),
    observationDigest: digest(observation),
    originalOwner: 'unverified',
    observedCurrentAccount: 'soundcloud:users:1',
    disposition: 'permanent_retention_without_absence_claim',
  };
  const certificateId = digest(certificate),
    ref = { projectId: 'test', jobId };
  docs.set(`temporalLegacySoundCloudRetentionCertificates/${certificateId}`, certificate);
  docs.set(`temporalLegacySoundCloudRetentionObservations/${jobId}`, observation);
  docs.set(`durableJobCriticalRepairGrants/${jobId}`, {
    schemaVersion: 1,
    ...ref,
    generation: 1,
    workflowId: 'workflow',
    intentFingerprint: digest(intent),
    retentionAcknowledged: true,
    actorUid: 'admin',
    commandId: 'cmd',
    reason: 'Retain unknown owner',
    evidenceReference: 'review',
    sourceCertificateIds: [certificateId],
    operations: [{ kind: 'legacy_soundcloud_retain', certificateId }],
  });
  docs.set(scAggregate, {
    ...scResource,
    epoch: 'epoch',
    state: 'reserved',
    referenceCount: 0,
    desiredDeletionProof: { jobId, resourceType: 'track', generation: 1, intentFingerprint: digest(intent) },
  });
  seedDesiredSession(docs, { jobId }, 'active', 'acknowledged');
  const sessionPath = [...docs.keys()].find(
    (path) => path.startsWith('temporalProviderMutationSessions/') && !path.includes('/requests/')
  )!;
  const requestPath = [...docs.keys()].find((path) => path.startsWith(`${sessionPath}/requests/`))!;
  const sessionId = sessionPath.split('/')[1],
    request = docs.get(requestPath);
  docs.set(`temporalPublishingAcknowledgedProjections/${sessionId}/requestIndex/${providerEdgeKey(request.step)}`, {
    request: {
      step: request.step,
      method: request.method,
      fingerprint: request.fingerprint,
      target: { provider: 'subsplash' },
    },
  });
  const prep = () =>
    db.runTransaction(async (tx) => {
      (await prepareReviewedLegacySoundCloudRetentionBinding(tx, db, { ref, certificateId, resource: scResource }))();
    });
  request.state = 'unknown';
  await expect(prep()).rejects.toThrow('REVIEWED_RETENTION_PROOF_INVALID');
  request.state = 'acknowledged';
  docs.get(scAggregate).desiredDeletionProof.jobId = 'foreign';
  await expect(prep()).rejects.toThrow('REVIEWED_RETENTION_PROOF_INVALID');
  docs.get(scAggregate).desiredDeletionProof.jobId = jobId;
  await prep();
  await prep();
  expect(docs.get(scAggregate).state).toBe('active');
  expect(docs.get(scAggregate).referenceCount).toBe(1);
  expect(docs.get(scAggregate).settlement).toBe('reviewed_retain');
  expect(docs.get(aggregate).state).toBe('reserved');
  expect(docs.get(sessionPath).state).toBe('active');
  expect(request.state).toBe('acknowledged');
});
test('series mirror proof clears only the selected series pointer and preserves media and other row fields', async () => {
  const path = 'lists/list/listItems/sermon';
  const canonical = {
    title: 'Keep',
    mediaItem: {
      subsplashId: 'media',
      seriesId: 'series1',
      subsplashSeriesId: 'image1',
      seriesPublishedToSubsplash: true,
    },
  };
  const { db, docs, jobId, intent } = await desiredEntityFixture(
    'series.delete',
    'series',
    'series1',
    {},
    {
      'series/series1': { subsplashId: 'image1' },
      'series/series1/seriesItems/sermon': { subsplashSeriesId: 'image1' },
      [path]: canonical,
    }
  );
  const input = { resource, jobId, resourceType: 'series' as const },
    planId = desiredProviderDeletionPlanId(input);
  const header = `temporalProviderDesiredDeletionPlans/${planId}`;
  docs.set(header, {
    schemaVersion: 1,
    projectId: 'test',
    jobId,
    resource,
    resourceType: 'series',
    entity: { type: 'series', id: 'series1' },
    generation: 1,
    intentFingerprint: desiredProviderDeletionIntentFingerprint(intent),
    method: 'DELETE',
    requestFingerprint: 'a'.repeat(64),
    state: 'prepared',
  });
  const afterData = {
    title: 'Keep',
    mediaItem: { subsplashId: 'media', seriesId: null, seriesPublishedToSubsplash: false },
  };
  const row = {
    canonicalPath: path,
    sourceFingerprint: desiredProviderDeletionDocumentFingerprint(canonical),
    after: 'resource_removed',
    afterData,
  };
  docs.set(`${header}/removals/${providerEdgeKey(path)}`, {
    ...row,
    afterData: { ...afterData, title: 'Unrelated edit' },
  });
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    })
  ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
  docs.set(`${header}/removals/${providerEdgeKey(path)}`, row);
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  expect(docs.get(aggregate).state).toBe('reserved');
});
function seedDesiredSession(docs: Map<string, any>, input: { jobId: string }, state: string, requestState?: string) {
  const scope = { projectId: 'test', jobId: input.jobId, operation: 'delete-media' },
    sessionId = createHash('sha256')
      .update(JSON.stringify({ jobId: scope.jobId, operation: scope.operation, projectId: scope.projectId }))
      .digest('hex');
  docs.set(`temporalProviderMutationSessions/${sessionId}`, {
    schemaVersion: 1,
    scope,
    state,
    resources: [{ provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: 'image1' }],
  });
  if (requestState) {
    const step = 'delete',
      claim = 'claim',
      stepId = createHash('sha256').update(JSON.stringify(step)).digest('hex');
    docs.set(`temporalProviderMutationSessions/${sessionId}/requests/${stepId}`, {
      step,
      claim,
      fingerprint: 'request',
      executionId: 'execution',
      state: requestState,
    });
    const factId = createHash('sha256')
      .update(JSON.stringify([sessionId, step, claim]))
      .digest('hex');
    docs.set(`temporalProviderMutationFacts/${factId}`, {
      sessionId,
      step,
      claim,
      fingerprint: 'request',
      executionId: 'execution',
      completion: requestState,
      evidence: { transport: 'original_http_response', status: 403, providerCode: 'permission_denied' },
    });
  }
}
test('desired reservation can abort only permanently closed guards with zero or sealed rejected requests', async () => {
  for (const requestState of [undefined, 'rejected_no_effect']) {
    const { db, docs, input } = await desiredFixture();
    await db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    });
    seedDesiredSession(docs, input, 'aborted', requestState);
    await db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletionAbort(tx, db, input))();
    });
    expect(docs.get(aggregate)).toMatchObject({ state: 'active', referenceCount: 2 });
  }
});
test('same-transaction zero-effect guard closure composes with exact reservation abort and preserves all reference counts', async () => {
  const { db, docs, input, canonical } = await desiredFixture();
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  seedDesiredSession(docs, input, 'active');
  const sessionPath = [...docs.keys()].find((path) => path.startsWith('temporalProviderMutationSessions/'))!;
  docs.set('temporalPublishingDeletionReceipts/prepared', {
    projectId: 'test',
    jobId: input.jobId,
    state: 'authorized',
  });
  await db.runTransaction(async (tx) => {
    const proof = {};
    const issued = new WeakMap<object, Transaction>([[proof, tx]]);
    const commit = await prepareDesiredProviderDeletionZeroEffectsAbort(
      tx,
      db,
      input,
      proof,
      async (actualTx, witness, scope) => {
        if (
          issued.get(witness as object) !== actualTx ||
          scope.jobId !== input.jobId ||
          scope.resource.remoteId !== 'image1'
        )
          throw new Error('BAD_CORE_WITNESS');
      }
    );
    commit();
    tx.update(db.doc(sessionPath), { state: 'aborted' });
  });
  expect(docs.get(aggregate).state).toBe('active');
  expect(docs.get(aggregate).referenceCount).toBe(2);
  expect(docs.get('sermons/own-sermon')).toEqual(canonical);
  expect(docs.get(sessionPath).state).toBe('aborted');
});
test('zero-effect reservation abort rejects fabricated witness, any original request, and provider creation or absence evidence', async () => {
  for (const violation of ['forged', 'request', 'create', 'absence']) {
    const { db, docs, input } = await desiredFixture();
    await db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    });
    seedDesiredSession(docs, input, 'active', violation === 'request' ? 'rejected_no_effect' : undefined);
    if (violation === 'create')
      docs.set('temporalProviderReceipts/create', { projectId: 'test', jobId: input.jobId, state: 'confirmed' });
    if (violation === 'absence')
      docs.set('temporalPublishingDeletionReceipts/absence', {
        projectId: 'test',
        jobId: input.jobId,
        state: 'absence_confirmed',
        absenceProof: 'fixed_get',
      });
    await expect(
      db.runTransaction(async (tx) => {
        const proof = {};
        const issuer = new WeakMap<object, Transaction>();
        if (violation !== 'forged') issuer.set(proof, tx);
        const commit = await prepareDesiredProviderDeletionZeroEffectsAbort(
          tx,
          db,
          input,
          proof,
          async (actualTx, witness) => {
            if (issuer.get(witness as object) !== actualTx) throw new Error('BAD_CORE_WITNESS');
          }
        );
        commit();
      })
    ).rejects.toThrow(violation === 'forged' ? 'BAD_CORE_WITNESS' : 'ZERO_ABORT_UNPROVEN');
    expect(docs.get(aggregate).state).toBe('reserved');
    expect(docs.get(aggregate).referenceCount).toBe(2);
  }
});
test('source factual projection may preserve only an existing owned reserved edge, without reopening or adding references', async () => {
  const { db, docs, input, canonical, jobId } = await desiredFixture();
  await db.runTransaction(async (tx) => {
    (await prepareDesiredProviderDeletion(tx, db, input)).commit();
  });
  const after = { ...canonical, published: false },
    change = { projectId: 'test', canonicalPath: 'sermons/own-sermon', before: canonical, after };
  const validate = jest.fn(async () => {}),
    authority = { jobId, sourceProof: { private: 'source' }, validate };
  await expect(
    db.runTransaction(async (tx) => {
      (await prepareProviderUsageChanges(tx, db, [change]))();
    })
  ).rejects.toThrow('CLEANUP_RESERVED');
  await db.runTransaction(async (tx) => {
    (await prepareProviderUsageChanges(tx, db, [change], authority))();
    tx.set(db.doc(change.canonicalPath), after);
  });
  expect(validate).toHaveBeenCalledTimes(1);
  expect(docs.get(aggregate).state).toBe('reserved');
  expect(docs.get(aggregate).referenceCount).toBe(2);
  for (const rejected of [
    { ...change, canonicalPath: 'sermons/new', before: undefined },
    { ...change, after: { ...after, images: [{ subsplashId: 'new-image' }] } },
  ])
    await expect(
      db.runTransaction(async (tx) => {
        (await prepareProviderUsageChanges(tx, db, [rejected], authority))();
      })
    ).rejects.toThrow('CLEANUP_RESERVED');
  await expect(
    db.runTransaction(async (tx) => {
      (
        await prepareProviderUsageChanges(tx, db, [change], {
          ...authority,
          validate: async () => {
            throw new Error('SOURCE_PROOF_CHANGED');
          },
        })
      )();
    })
  ).rejects.toThrow('SOURCE_PROOF_CHANGED');
});
test('partial stop reopens only an original unclaimed or sealed rejected DELETE after actual v2 closure, preserving sibling ACK and counts', async () => {
  for (const outcome of ['unclaimed', 'rejected_no_effect', 'unknown', 'acknowledged', 'resource_not_found', 'open']) {
    const { db, docs, input, jobId } = await desiredFixture();
    await db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    });
    seedDesiredSession(docs, input, 'active', 'acknowledged');
    const sessionPath = [...docs.keys()].find(
        (path) => path.startsWith('temporalProviderMutationSessions/') && !path.includes('/requests/')
      )!,
      sessionId = sessionPath.split('/')[1];
    Object.assign(docs.get(sessionPath), {
      effectsClosed: outcome !== 'open',
      effectsClosedClaimSetDigestVersion: 2,
      effectsClosedClaimSetDigest: 'c'.repeat(64),
      effectsClosedActualRequestCount: outcome === 'unclaimed' ? 1 : 2,
    });
    const root = {
      step: 'root-delete',
      method: 'DELETE',
      fingerprint: 'd'.repeat(64),
      target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: 'image1' },
    };
    const planId = createHash('sha256')
      .update(JSON.stringify(['test', jobId, 'own-sermon']))
      .digest('hex');
    Object.assign(docs.get(`temporalSermonDeletionMirrorPlans/${planId}`), {
      operation: 'delete-media',
      requests: [root],
    });
    docs.set(`temporalPublishingAcknowledgedProjections/${sessionId}/requestIndex/${providerEdgeKey(root.step)}`, {
      request: root,
    });
    if (!['unclaimed', 'open'].includes(outcome)) {
      const request = {
        step: root.step,
        method: 'DELETE',
        fingerprint: root.fingerprint,
        claim: 'rootclaim',
        executionId: 'execution',
        state: outcome === 'resource_not_found' ? 'rejected_no_effect' : outcome,
      };
      docs.set(`${sessionPath}/requests/${providerEdgeKey(root.step)}`, request);
      const factId = createHash('sha256')
        .update(JSON.stringify([sessionId, request.step, request.claim]))
        .digest('hex');
      docs.set(`temporalProviderMutationFacts/${factId}`, {
        ...request,
        sessionId,
        completion: request.state,
        evidence: {
          transport: 'original_http_response',
          status: outcome === 'resource_not_found' ? 404 : 401,
          providerCode: 'rejected',
        },
      });
    }
    const sourceProof = {
      sessionId,
      sourceEvidenceDigest: 'e'.repeat(64),
      originalRequestStep: root.step,
      originalRequestFingerprint: root.fingerprint,
      disposition: outcome === 'unclaimed' || outcome === 'open' ? 'unclaimed' : 'rejected_no_effect',
    };
    const stop = () =>
      db.runTransaction(async (tx) => {
        (await prepareDesiredProviderDeletionPartialStopAbort(tx, db, input, sourceProof, async () => {}))();
      });
    if (['unclaimed', 'rejected_no_effect'].includes(outcome)) {
      await stop();
      await stop();
      expect(docs.get(aggregate).state).toBe('active');
    } else {
      await expect(stop()).rejects.toThrow('PARTIAL_STOP_UNPROVEN');
      expect(docs.get(aggregate).state).toBe('reserved');
    }
    expect(docs.get(aggregate).referenceCount).toBe(2);
    expect(docs.get(sessionPath).state).toBe('active');
  }
});
test('desired abort refuses an active guard, sending/unknown/ACK facts or missing original evidence', async () => {
  for (const [sessionState, requestState] of [
    ['active', undefined],
    ['aborted', 'sending'],
    ['aborted', 'unknown'],
    ['aborted', 'acknowledged'],
  ] as const) {
    const { db, docs, input } = await desiredFixture();
    await db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, input)).commit();
    });
    seedDesiredSession(docs, input, sessionState, requestState);
    await expect(
      db.runTransaction(async (tx) => {
        (await prepareDesiredProviderDeletionAbort(tx, db, input))();
      })
    ).rejects.toThrow('ABORT_UNPROVEN');
    expect(docs.get(aggregate).state).toBe('reserved');
  }
});

test('complete desired DELETE set preparation makes no partial reservation when another target is blocked', async () => {
  const { db, docs, input, canonical, intent } = await desiredFixture();
  const oldCanonical = structuredClone(canonical),
    oldIntent = structuredClone(intent);
  Object.assign(canonical, { soundCloudTrackId: 'track1' });
  Object.assign(intent.payload.payload.sermon, { soundCloudTrackId: 'track1' });
  const foreign = { soundCloudTrackId: 'track1' };
  docs.set('sermons/foreign-track-owner', foreign);
  await db.runTransaction(async (tx) => {
    (
      await prepareProviderUsageChanges(tx, db, [
        { projectId: 'test', canonicalPath: 'sermons/own-sermon', before: oldCanonical, after: canonical },
        { projectId: 'test', canonicalPath: `durableJobIntents/${input.jobId}`, before: oldIntent, after: intent },
        { projectId: 'test', canonicalPath: 'sermons/foreign-track-owner', before: undefined, after: foreign },
      ])
    )();
  });
  await expect(
    db.runTransaction(async (tx) => {
      (
        await prepareDesiredProviderDeletions(tx, db, [
          input,
          {
            resource: { projectId: 'test', provider: 'soundcloud', account: 'configured-account', remoteId: 'track1' },
            jobId: input.jobId,
            resourceType: 'track',
          },
        ])
      )();
    })
  ).rejects.toThrow('DESIRED_DELETION_REFERENCED');
  expect(docs.get(aggregate)).toMatchObject({ state: 'active', referenceCount: 2 });
});
