import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  acquireProviderMutationSession,
  executeProviderMutationOnce,
  PROVIDER_MUTATION_SESSIONS,
  providerMutationClaimSetSeed,
} from './providerMutationGuard';
import {
  prepareAcknowledgedProjectionPlan,
  acknowledgedProjectionDigest as digest,
  ACKNOWLEDGED_PROJECTION_PLANS,
} from './criticalAcknowledgedRepair';
import {
  prepareCriticalRepairCatalogSourceSeal,
  assertV1PublishingSourceProducerBarrier,
  assertCriticalRepairCatalogClaimAllowed,
  CRITICAL_REPAIR_SOURCE_CATALOGS,
} from './criticalRepairCatalog';
import { runDurablePublishingOperation, publishingMutationRequestFingerprint } from './durableOperationContext';
import { prepareSermonDeletionMirrors, SERMON_DELETION_MIRROR_PLANS } from '../../helpers/sermonDeletionMirrors';
import {
  preparePublishingZeroEffectsStop,
  runPublishingZeroEffectsStop,
  PUBLISHING_ZERO_EFFECTS_STOPS,
} from './publishingZeroEffectsStop';
import {
  prepareProviderUsageChanges,
  prepareDesiredProviderDeletion,
  providerResourceKey,
  PROVIDER_USAGE_COLLECTION,
  PROVIDER_USAGE_CONTROL,
} from '../../../../packages/orchestration/src/provider-usage';
import {
  mediaArtifactId,
  prepareMediaReference,
  mediaReferenceId,
} from '../../../../packages/orchestration/src/media-artifacts';

// Only firebase.test.json's loopback Firestore port and configured test project can execute this suite.
const configuredProject = (() => {
  try {
    return process.env.FIREBASE_CONFIG?.trim().startsWith('{')
      ? JSON.parse(process.env.FIREBASE_CONFIG).projectId
      : process.env.GCLOUD_PROJECT;
  } catch {
    return undefined;
  }
})();
const enabled =
  /^(127\.0\.0\.1|localhost):18081$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') &&
  configuredProject === 'urm-app' &&
  process.env.GCLOUD_PROJECT === 'urm-app';
const firestoreSuite = enabled ? describe : describe.skip;
firestoreSuite('published deletion zero-effects stop actual Firestore composition', () => {
  let app: App, db: Firestore, oldControl: Record<string, unknown> | undefined;
  const suiteNonce = randomUUID(),
    epoch = `zero-stop-${suiteNonce}`,
    ownedPaths = new Set<string>();
  beforeAll(async () => {
    app = initializeApp({ projectId: configuredProject }, `zero-stop-${suiteNonce}`);
    db = getFirestore(app);
    oldControl = (await db.doc(PROVIDER_USAGE_CONTROL).get()).data();
    await db.doc(PROVIDER_USAGE_CONTROL).set({
      schemaVersion: 1,
      projectId: configuredProject,
      epoch,
      status: 'ready',
      releaseId: 'zero-stop-test',
      controlRevision: 1,
    });
  });
  afterAll(async () => {
    for (const path of ownedPaths) await db.recursiveDelete(db.doc(path));
    if (oldControl) await db.doc(PROVIDER_USAGE_CONTROL).set(oldControl);
    else await db.doc(PROVIDER_USAGE_CONTROL).delete();
    await deleteApp(app);
  });
  const own = (path: string) => {
    ownedPaths.add(path);
    return db.doc(path);
  };
  async function fixture() {
    const nonce = randomUUID(),
      projectId = app.options.projectId!,
      ref = { projectId, jobId: `zero-stop-${nonce}` },
      sermonId = `zero-stop-${nonce}`,
      listId = `zero-list-${nonce}`,
      seriesId = `zero-series-${nonce}`,
      workflowId = `workflow-${nonce}`,
      remoteId = `media-${nonce}`;
    const root = own(`sermons/${sermonId}`),
      list = own(`lists/${listId}`),
      series = own(`series/${seriesId}`),
      listItem = db.doc(`${list.path}/listItems/${sermonId}`),
      seriesItem = db.doc(`${series.path}/seriesItems/${sermonId}`),
      membership = db.doc(`${root.path}/sermonLists/${listId}`);
    const original = {
      id: sermonId,
      title: 'Published original',
      subsplashId: remoteId,
      editedAtMillis: 1,
      status: { subsplash: 'UPLOADED' },
      audioArtifacts: { finalPath: `audio/${nonce}` },
    };
    const mirrored = {
        id: sermonId,
        sermonId,
        sermonSubsplashId: remoteId,
        title: original.title,
        uploadStatus: { status: 'UPLOADED', listItemId: `row-${nonce}` },
      },
      seriesMirrored = {
        id: sermonId,
        sermonId,
        sermonSubsplashId: remoteId,
        title: original.title,
        publishedToSubsplash: true,
      };
    const intent = {
      schemaVersion: 1,
      ...ref,
      kind: 'sermon.delete',
      entity: { type: 'sermon', id: sermonId },
      actorUid: 'original-publisher',
      generation: 1,
      createdAt: 100,
      publishingSourceProtocol: 'publishing-source-catalog-v1',
      payload: {
        sermonId,
        action: 'delete',
        generation: 1,
        payload: { sermon: original },
        destinations: { listIds: [], soundcloud: false },
      },
    };
    const authority = own(`zeroStopTestAuthorities/${nonce}`),
      job = own(`durableJobs/${ref.jobId}`),
      privateIntent = own(`durableJobIntents/${ref.jobId}`);
    const seed = db.batch();
    seed.set(root, original);
    seed.set(list, { id: listId, name: 'Managed list', itemCount: 1 });
    seed.set(series, { id: seriesId, name: 'Managed series', itemCount: 1, publishedItemCount: 1 });
    seed.set(listItem, mirrored);
    seed.set(seriesItem, seriesMirrored);
    seed.set(membership, {
      id: listId,
      sermonSubsplashId: remoteId,
      uploadStatus: { status: 'UPLOADED', listItemId: `row-${nonce}` },
    });
    seed.set(privateIntent, intent);
    seed.set(job, { ...intent, requestedBy: intent.actorUid, workflowId, state: 'needs_attention', revision: 4 });
    seed.set(authority, { adminActive: true, sdkEpoch: 1, generation: 1, workflowId });
    seed.set(own(`durableJobCriticalSections/${ref.jobId}`), {
      ...ref,
      generation: 1,
      workflowId,
      reasonCode: 'DELETE_PLANNING',
    });
    seed.set(own(`temporalMediaState/${sermonId}`), { projectId, deletionParentRef: ref });
    seed.set(own(`temporalMediaDeletionEffects/${ref.jobId}`), {
      projectId,
      deletionEffectsStarted: true,
      startedAt: 99,
    });
    await seed.commit();
    const fresh = async (tx: Transaction) => {
      const [actor, current] = await Promise.all([tx.get(authority), tx.get(job)]);
      if (
        actor.get('adminActive') !== true ||
        actor.get('sdkEpoch') !== 1 ||
        current.get('generation') !== 1 ||
        current.get('workflowId') !== workflowId
      )
        throw Error('fresh administrator/SDK/generation fence changed');
    };
    const commitCurrent = async (_ref: unknown, write: (tx: Transaction) => Promise<void>) =>
      db.runTransaction(async (tx) => {
        await fresh(tx);
        await write(tx);
      });
    const resource = { projectId, provider: 'subsplash' as const, account: 'app:9XTSHD', remoteId },
      target = {
        provider: resource.provider,
        account: resource.account,
        resourceType: 'media' as const,
        resourceId: remoteId,
      },
      operation = `durable:${projectId}:${ref.jobId}:${sermonId}:delete`;
    const session = await acquireProviderMutationSession({
      db,
      scope: { ...ref, operation },
      resources: [target],
      assertCurrentInTransaction: fresh,
    });
    own(`${PROVIDER_MUTATION_SESSIONS}/${session.id}`);
    const step = `delete:subsplash:${remoteId}`,
      body = { id: remoteId },
      request = {
        step,
        method: 'DELETE' as const,
        target,
        payload: body,
        fingerprint: publishingMutationRequestFingerprint({ method: 'DELETE', target, payload: body }),
      },
      verification = { ...target, expectedState: 'absent' as const, expectedProviderFields: {}, requiredSteps: [step] };
    // Actual source capture creates the complete immutable mirror/catalogue and preclaim frozen pages.
    const plan = await runDurablePublishingOperation(
      ref.jobId,
      () =>
        prepareSermonDeletionMirrors(db, {
          ref,
          sermonId,
          operation,
          requests: [request],
          verifications: [verification],
        }),
      (write) => commitCurrent(ref, write),
      {
        getSourceStepIds: () => ['delete-plan'],
        prepareAcknowledgedProjectionPlan: async (tx, input) => {
          if (input.operation !== operation) throw Error('wrong original program');
          return prepareAcknowledgedProjectionPlan(tx, session, input);
        },
      }
    );
    own(`${SERMON_DELETION_MIRROR_PLANS}/${plan.planId}`);
    own(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}`);
    own(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/${ref.jobId}`);
    own(`${PUBLISHING_ZERO_EFFECTS_STOPS}/${plan.planId}`);
    await db.runTransaction(async (tx) => {
      (
        await prepareCriticalRepairCatalogSourceSeal(tx, db, ref, (transaction) =>
          assertV1PublishingSourceProducerBarrier(transaction, db, ref)
        )
      ).commit();
    });
    const artifactId = mediaArtifactId(projectId, original.audioArtifacts.finalPath),
      artifact = own(`temporalMediaArtifacts/${artifactId}`),
      canonicalRefs = own(`temporalMediaCanonicalRefs/${sermonId}`);
    await artifact.set({
      projectId,
      sermonId,
      path: original.audioArtifacts.finalPath,
      status: 'retained',
      createdAt: 1,
      eligibleAfter: 999999,
    });
    await db.runTransaction(async (tx) => {
      const attach = await prepareMediaReference(tx, db, {
        artifactId,
        projectId,
        type: 'canonical',
        id: sermonId,
        slot: 'final',
        createdAt: 1,
      });
      tx.set(canonicalRefs, { projectId, artifactIds: { final: artifactId } });
      attach();
    });
    const changes = [
      { canonicalPath: privateIntent.path, after: intent },
      { canonicalPath: root.path, after: original },
      { canonicalPath: listItem.path, after: mirrored },
      { canonicalPath: seriesItem.path, after: seriesMirrored },
      { canonicalPath: membership.path, after: (await membership.get()).data() },
    ];
    await db.runTransaction(async (tx) => {
      (
        await prepareProviderUsageChanges(
          tx,
          db,
          changes.map((change) => ({ ...change, projectId, before: undefined }))
        )
      )();
    });
    const aggregateRoot = own(`${PROVIDER_USAGE_COLLECTION}/${providerResourceKey(resource)}`),
      aggregate = aggregateRoot.collection('epochs').doc(epoch);
    await db.runTransaction(async (tx) => {
      (await prepareDesiredProviderDeletion(tx, db, { resource, jobId: ref.jobId, resourceType: 'media' })).commit();
    });
    let source: Awaited<ReturnType<typeof preparePublishingZeroEffectsStop>> | undefined;
    const prepare = async () => {
      await commitCurrent(ref, async (tx) => {
        source = await preparePublishingZeroEffectsStop(tx, db, { ref, expectedRevision: 4 });
        source.commit();
      });
      return source!;
    };
    const grant = async () => {
      const prepared = await prepare();
      await own(`durableJobCriticalRepairGrants/${ref.jobId}`).set({
        schemaVersion: 1,
        ...ref,
        generation: 1,
        workflowId,
        actorUid: 'fresh-admin',
        commandId: `command-${nonce}`,
        certificateId: digest({ nonce }),
        intentFingerprint: digest(intent),
        operations: [prepared.operation],
        sourceEvidenceDigests: [prepared.sourceEvidenceDigest],
      });
      return prepared;
    };
    const preservedRefs = [
      root,
      list,
      series,
      listItem,
      seriesItem,
      membership,
      artifact,
      artifact.collection('references').doc(mediaReferenceId('canonical', sermonId, 'final')),
      canonicalRefs,
    ];
    const snapshotPreserved = async () =>
      Promise.all(preservedRefs.map(async (doc) => ({ path: doc.path, data: (await doc.get()).data() })));
    const mutateOriginal = (send: () => Promise<{ completion: 'acknowledged'; result: { deleted: true } }>) =>
      executeProviderMutationOnce({
        session,
        step,
        method: 'DELETE',
        payload: { target, body },
        executionId: `original-sdk-${nonce}`,
        assertCurrentInTransaction: async () => {},
        send,
      });
    return {
      ref,
      session,
      step,
      operation,
      plan,
      prepare,
      grant,
      aggregate,
      snapshotPreserved,
      mutateOriginal,
      media: db.doc(`temporalMediaState/${sermonId}`),
      planning: db.doc(`temporalMediaDeletionEffects/${ref.jobId}`),
      dependencies: { firestore: db, commitCurrent, authorizeInTransaction: async (tx: Transaction) => fresh(tx) },
    };
  }
  async function unchangedPending(f: Awaited<ReturnType<typeof fixture>>, preserved: unknown) {
    expect(await f.snapshotPreserved()).toEqual(preserved);
    expect((await db.doc(`${PROVIDER_MUTATION_SESSIONS}/${f.session.id}`).get()).get('state')).toBe('active');
    expect((await f.aggregate.get()).get('state')).toBe('reserved');
    expect((await f.media.get()).get('deletionParentRef')).toEqual(f.ref);
    expect((await f.planning.get()).get('deletionEffectsStarted')).toBe(true);
  }
  test('actual preclaim source program stops atomically with core/index proofs while all canonical data and artifacts remain', async () => {
    const f = await fixture(),
      before = await f.snapshotPreserved(),
      count = (await f.aggregate.get()).get('referenceCount'),
      source = await f.grant();
    expect((await db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${f.plan.planId}`).get()).get('state')).toBe('prepared');
    expect((await db.doc(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/${f.ref.jobId}`).get()).get('sealed')).toBe(true);
    await expect(db.runTransaction((tx) => assertCriticalRepairCatalogClaimAllowed(tx, db, f.ref))).rejects.toThrow();
    expect(
      (await db.doc(`${PROVIDER_MUTATION_SESSIONS}/${f.session.id}`).collection('requests').count().get()).data().count
    ).toBe(0);
    expect(await runPublishingZeroEffectsStop(f.ref, source.operation, f.dependencies)).toMatchObject({
      state: 'completed',
      mode: 'partial_stop',
      providerEffects: 'not_started',
      contentPreserved: true,
    });
    const closed = await db.doc(`${PROVIDER_MUTATION_SESSIONS}/${f.session.id}`).get();
    expect(closed.data()).toMatchObject({
      state: 'aborted',
      effectsClosed: true,
      effectsClosedClaimSetDigestVersion: 2,
      effectsClosedActualRequestCount: 0,
      effectsClosedClaimSetDigest: providerMutationClaimSetSeed(f.session.id),
      sourceZeroEffectsValidated: true,
    });
    expect((await f.aggregate.get()).data()).toMatchObject({
      state: 'active',
      referenceCount: count,
      desiredDeletionAbort: { jobId: f.ref.jobId, proof: 'source_zero_effects_original_guard' },
    });
    expect((await f.media.get()).get('deletionParentRef')).toBeUndefined();
    expect((await f.planning.get()).exists).toBe(false);
    expect(await f.snapshotPreserved()).toEqual(before);
    expect((await db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${f.plan.planId}`).get()).get('rootRemoval')).toBeUndefined();
    const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: { deleted: true as const } }));
    await expect(f.mutateOriginal(send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  }, 30000);
  test.each(['acknowledged', 'unknown'] as const)(
    'actual original %s transport blocks zero stop and preserves all pending state',
    async (state) => {
      const f = await fixture(),
        before = await f.snapshotPreserved(),
        source = await f.grant();
      if (state === 'acknowledged')
        await f.mutateOriginal(async () => ({ completion: 'acknowledged', result: { deleted: true } }));
      else
        await expect(
          f.mutateOriginal(async () => {
            throw Error('lost original HTTP response');
          })
        ).rejects.toThrow();
      await expect(runPublishingZeroEffectsStop(f.ref, source.operation, f.dependencies)).rejects.toThrow();
      await expect(f.prepare()).rejects.toThrow();
      await unchangedPending(f, before);
      expect((await db.doc(`${PUBLISHING_ZERO_EFFECTS_STOPS}/${f.plan.planId}`).get()).get('state')).toBe('prepared');
    },
    30000
  );
  test('an original claim appearing after certification blocks the whole stop transaction', async () => {
    const f = await fixture(),
      before = await f.snapshotPreserved(),
      source = await f.grant();
    let entered!: () => void, continueStop!: () => void, requestSent!: () => void, finishSend!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      stopGate = new Promise<void>((resolve) => {
        continueStop = resolve;
      }),
      sentGate = new Promise<void>((resolve) => {
        requestSent = resolve;
      }),
      sendGate = new Promise<void>((resolve) => {
        finishSend = resolve;
      });
    const stop = runPublishingZeroEffectsStop(f.ref, source.operation, {
      ...f.dependencies,
      authorizeInTransaction: async (tx, ref, op) => {
        await f.dependencies.authorizeInTransaction(tx);
        entered();
        await stopGate;
        void ref;
        void op;
      },
    });
    await enteredGate;
    const original = f.mutateOriginal(async () => {
      requestSent();
      await sendGate;
      return { completion: 'acknowledged', result: { deleted: true } };
    });
    await sentGate;
    continueStop();
    try {
      await expect(stop).rejects.toThrow();
      await unchangedPending(f, before);
    } finally {
      finishSend();
      await original;
    }
    expect((await db.doc(`${PUBLISHING_ZERO_EFFECTS_STOPS}/${f.plan.planId}`).get()).get('state')).toBe('prepared');
  }, 30000);
});
