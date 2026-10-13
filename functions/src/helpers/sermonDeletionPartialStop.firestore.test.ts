import { randomUUID, createHash } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  acquireProviderMutationSession,
  executeProviderMutationOnce,
  PROVIDER_MUTATION_SESSIONS,
} from '../temporal/publishing/providerMutationGuard';
import {
  prepareAcknowledgedProjectionPlan,
  acknowledgedProjectionDigest as digest,
  ACKNOWLEDGED_PROJECTION_PLANS,
} from '../temporal/publishing/criticalAcknowledgedRepair';
import {
  prepareCriticalRepairCatalogSourceAppend,
  prepareCriticalRepairCatalogSourceSeal,
  assertV1PublishingSourceProducerBarrier,
  CRITICAL_REPAIR_SOURCE_CATALOGS,
} from '../temporal/publishing/criticalRepairCatalog';
import {
  runDurablePublishingOperation,
  publishingMutationRequestFingerprint,
} from '../temporal/publishing/durableOperationContext';
import { prepareSermonDeletionMirrors, SERMON_DELETION_MIRROR_PLANS } from './sermonDeletionMirrors';
import {
  compileSermonDeletionPartialStopPage,
  prepareSermonDeletionPartialStop,
  runSermonDeletionPartialStop,
  validateSermonDeletionPartialStopRead,
  prepareSermonDeletionPartialStopUnclaimedReservation,
  validatePartialStopReservedCanonicalReference,
  type SermonDeletionPartialStopOperation,
  SERMON_DELETION_PARTIAL_STOPS,
} from './sermonDeletionPartialStop';
import {
  compileAcknowledgedRepairCandidatePage,
  ACKNOWLEDGED_REPAIR_CANDIDATES,
} from '../temporal/publishing/acknowledgedRepairCandidate';
import {
  prepareProviderUsageChanges,
  prepareDesiredProviderDeletion,
  providerResourceKey,
  PROVIDER_USAGE_COLLECTION,
  PROVIDER_USAGE_CONTROL,
} from '../../../packages/orchestration/src/provider-usage';
import { withProviderIndexedTransaction } from '../../../packages/orchestration/src/provider-transaction';
import {
  mediaArtifactId,
  prepareMediaReference,
  mediaReferenceId,
} from '../../../packages/orchestration/src/media-artifacts';

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
firestoreSuite('acknowledged-prefix sermon deletion factual partial stop actual Firestore', () => {
  let app: App, db: Firestore, oldControl: Record<string, unknown> | undefined;
  const suiteNonce = randomUUID(),
    epoch = `partial-stop-${suiteNonce}`,
    ownedPaths = new Set<string>();
  beforeAll(async () => {
    app = initializeApp({ projectId: configuredProject }, `partial-stop-${suiteNonce}`);
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
    let canonicalRetryTriggered = false,
      forceCanonicalRetry = false;
    let partialOperation: SermonDeletionPartialStopOperation | undefined;
    const observations: Array<{ state: string; closed: boolean; rootMediaPresent: boolean }> = [];
    let sessionRef: ReturnType<Firestore['doc']> | undefined;
    const nonce = randomUUID(),
      projectId = app.options.projectId!,
      ref = { projectId, jobId: `zero-stop-${nonce}` },
      sermonId = `zero-stop-${nonce}`,
      listId = `zero-list-${nonce}`,
      seriesId = `zero-series-${nonce}`,
      workflowId = `workflow-${nonce}`,
      remoteId = `media-${nonce}`,
      trackId = `track-${nonce}`;
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
      soundCloudTrackId: trackId,
      soundCloudTrackUrl: 'https://synthetic.invalid/original',
      soundCloudPublication: { published: true },
      editedAtMillis: 1,
      status: { subsplash: 'UPLOADED', soundCloud: 'UPLOADED' },
      audioArtifacts: { finalPath: `audio/${nonce}` },
    };
    const mirrored = {
        id: sermonId,
        sermonId,
        sermonSubsplashId: remoteId,
        title: original.title,
        mediaItem: { soundCloudTrackId: trackId, status: { soundCloud: 'UPLOADED' } },
        uploadStatus: { status: 'UPLOADED', listItemId: `row-${nonce}` },
      },
      seriesMirrored = {
        id: sermonId,
        sermonId,
        sermonSubsplashId: remoteId,
        title: original.title,
        mediaItem: { soundCloudTrackId: trackId, status: { soundCloud: 'UPLOADED' } },
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
    seed.set(job, {
      ...intent,
      requestedBy: intent.actorUid,
      workflowId,
      state: 'needs_attention',
      revision: 4,
      steps: [{ id: 'delete-plan', state: 'blocked' }],
    });
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
    const commitCurrent = async <T>(_ref: unknown, write: (tx: Transaction) => Promise<T>): Promise<T> =>
      db.runTransaction(async (actual) => {
        await fresh(actual);
        if (sessionRef) {
          const [held, currentRoot] = await Promise.all([actual.get(sessionRef), actual.get(root)]);
          observations.push({
            state: held.get('state'),
            closed: held.get('effectsClosed') === true,
            rootMediaPresent: Boolean(currentRoot.get('subsplashId')),
          });
        }
        return withProviderIndexedTransaction(
          actual,
          db,
          projectId,
          async (recording) => {
            let canonicalTouched = false;
            const observed = new Proxy(recording, {
              get(target, property) {
                const value = Reflect.get(target, property, target);
                if (typeof value !== 'function') return value;
                if (property === 'update' || property === 'set' || property === 'create')
                  return (...args: any[]) => {
                    if (args[0]?.path === root.path) canonicalTouched = true;
                    value.apply(target, args);
                    return observed;
                  };
                return value.bind(target);
              },
            });
            const output = await write(observed);
            if (forceCanonicalRetry && canonicalTouched && !canonicalRetryTriggered) {
              canonicalRetryTriggered = true;
              throw Object.assign(Error('force one actual Firestore ABORTED transaction retry'), { code: 10 });
            }
            return output;
          },
          {
            beforeCommit: fresh,
            ...(partialOperation
              ? {
                  reservedProjection: {
                    jobId: ref.jobId,
                    sourceProof: partialOperation,
                    validate: async (tx, proof, { change, resource }) => {
                      if (proof !== partialOperation || !partialOperation)
                        throw Error('wrong source retained-reference authority');
                      await validatePartialStopReservedCanonicalReference(
                        tx,
                        db,
                        ref,
                        partialOperation,
                        change,
                        resource
                      );
                    },
                  },
                }
              : {}),
          }
        );
      });
    const resource = { projectId, provider: 'subsplash' as const, account: 'app:9XTSHD', remoteId },
      target = {
        provider: resource.provider,
        account: resource.account,
        resourceType: 'media' as const,
        resourceId: remoteId,
      },
      operation = `durable:${projectId}:${ref.jobId}:${sermonId}:delete`,
      trackResource = { projectId, provider: 'soundcloud' as const, account: 'configured-account', remoteId: trackId },
      trackTarget = {
        provider: 'soundcloud' as const,
        account: 'soundcloud:users:42',
        resourceType: 'track' as const,
        resourceId: trackId,
      };
    const session = await acquireProviderMutationSession({
      db,
      scope: { ...ref, operation },
      resources: [target, trackTarget],
      assertCurrentInTransaction: fresh,
    });
    sessionRef = own(`${PROVIDER_MUTATION_SESSIONS}/${session.id}`);
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
    const trackStep = `delete:soundcloud:${trackId}`,
      trackBody = { id: trackId },
      trackRequest = {
        step: trackStep,
        method: 'DELETE' as const,
        target: trackTarget,
        payload: trackBody,
        fingerprint: publishingMutationRequestFingerprint({
          method: 'DELETE',
          target: trackTarget,
          payload: trackBody,
        }),
      },
      trackVerification = {
        ...trackTarget,
        expectedState: 'absent' as const,
        expectedProviderFields: {},
        requiredSteps: [trackStep],
      };
    // Actual source capture creates the complete immutable mirror/catalogue and preclaim frozen pages.
    const plan = await runDurablePublishingOperation(
      ref.jobId,
      () =>
        prepareSermonDeletionMirrors(db, {
          ref,
          sermonId,
          operation,
          requests: [request, trackRequest],
          verifications: [verification, trackVerification],
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
    // Original authenticated ownership metadata is source-captured before the guarded DELETE.
    const journalId = createHash('sha256')
        .update(JSON.stringify([projectId, ref.jobId, 'subsplash', remoteId]))
        .digest('hex'),
      journal = own(`temporalPublishingDeletionReceipts/${journalId}`),
      journalData = {
        ...ref,
        sermonId,
        provider: 'subsplash',
        remoteId,
        originalAccount: 'app:9XTSHD',
        authorizedAtMillis: 101,
        ownershipConfirmedBeforeDelete: true,
        sourceStepIds: ['delete-plan'],
        sourceParentRef: ref,
        state: 'authorized',
      };
    await commitCurrent(ref, async (tx) => {
      const enroll = await prepareCriticalRepairCatalogSourceAppend(tx, db, ref, {
        sourcePath: journal.path,
        source: journalData,
      });
      tx.create(journal, journalData);
      enroll.commit();
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
    const trackAggregateRoot = own(`${PROVIDER_USAGE_COLLECTION}/${providerResourceKey(trackResource)}`),
      trackAggregate = trackAggregateRoot.collection('epochs').doc(epoch);
    const aggregateRoot = own(`${PROVIDER_USAGE_COLLECTION}/${providerResourceKey(resource)}`),
      aggregate = aggregateRoot.collection('epochs').doc(epoch);
    await db.runTransaction(async (tx) => {
      const media = await prepareDesiredProviderDeletion(tx, db, { resource, jobId: ref.jobId, resourceType: 'media' }),
        track = await prepareDesiredProviderDeletion(tx, db, {
          resource: trackResource,
          jobId: ref.jobId,
          resourceType: 'track',
        });
      media.commit();
      track.commit();
    });
    const compile = async () => {
      let candidateReady = false;
      for (let i = 0; i < 100; i++) {
        const result = await compileAcknowledgedRepairCandidatePage(db, ref, session.id, { commitCurrent });
        if (result.state === 'ready') {
          candidateReady = true;
          own(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${result.candidateId}`);
          break;
        }
      }
      if (!candidateReady) throw Error('actual source candidate never READY');
      let ready = false;
      for (let i = 0; i < 100; i++) {
        const result = await compileSermonDeletionPartialStopPage(db, ref, session.id, { commitCurrent });
        own(`${SERMON_DELETION_PARTIAL_STOPS}/${result.operation.planId}`);
        if (result.state === 'ready') {
          ready = true;
          break;
        }
      }
      if (!ready) throw Error('actual partial-stop source never READY');
    };
    const seal = async () =>
      db.runTransaction(async (tx) => {
        (
          await prepareCriticalRepairCatalogSourceSeal(tx, db, ref, (transaction) =>
            assertV1PublishingSourceProducerBarrier(transaction, db, ref)
          )
        ).commit();
      });
    const grant = async () => {
      await seal();
      await compile();
      const prepared = await db.runTransaction((tx) =>
        prepareSermonDeletionPartialStop(tx, db, { ref, expectedRevision: 4 })
      );
      partialOperation = prepared.operation;
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
        sourceEvidenceDigests: [prepared.sourceEvidence.digest],
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
        assertCurrentInTransaction: fresh,
        send,
      });
    const mutateTrackUnknown = () =>
      executeProviderMutationOnce({
        session,
        step: trackStep,
        method: 'DELETE',
        payload: { target: trackTarget, body: trackBody },
        executionId: `original-sc-${nonce}`,
        assertCurrentInTransaction: fresh,
        send: async () => {
          throw Error('uncertain original SoundCloud DELETE');
        },
      });
    return {
      ref,
      session,
      step,
      operation,
      plan,
      grant,
      seal,
      compile,
      aggregate,
      trackAggregate,
      snapshotPreserved,
      mutateOriginal,
      mutateTrackUnknown,
      observations,
      root,
      seriesItem,
      canonicalRefs,
      artifact,
      enableCanonicalRetry: () => {
        forceCanonicalRetry = true;
      },
      retryTriggered: () => canonicalRetryTriggered,
      media: db.doc(`temporalMediaState/${sermonId}`),
      planning: db.doc(`temporalMediaDeletionEffects/${ref.jobId}`),
      dependencies: (op: Awaited<ReturnType<typeof prepareSermonDeletionPartialStop>>['operation']) => ({
        firestore: db,
        commitCurrent,
        authorizeInTransaction: async (tx: Transaction) => fresh(tx),
        authorizeRead: async (read: Parameters<typeof validateSermonDeletionPartialStopRead>[4]) => {
          await db.runTransaction((tx) => validateSermonDeletionPartialStopRead(tx, db, ref, op, read));
        },
        readProvider: jest.fn(async (read: { provider: string; resourceId: string; accountId: string }) => {
          if (read.provider !== 'subsplash' || read.resourceId !== remoteId)
            throw Error('unclaimed target must never be read as completion');
          return {
            state: 'absent' as const,
            providerId: read.resourceId,
            accountId: read.accountId,
            originalHttpStatus: 404,
          };
        }),
        prepareUnclaimedReservationDisposition: prepareSermonDeletionPartialStopUnclaimedReservation,
      }),
    };
  }
  test('known actual media DELETE repairs only its factual prefix; unclaimed SC/root/audio survive and the original session stays owned through every page', async () => {
    const f = await fixture();
    await f.mutateOriginal(async () => ({ completion: 'acknowledged', result: { deleted: true } }));
    const preserved = await f.snapshotPreserved(),
      trackCount = (await f.trackAggregate.get()).get('referenceCount'),
      source = await f.grant(),
      deps = f.dependencies(source.operation);
    f.enableCanonicalRetry();
    const result = await runSermonDeletionPartialStop(f.ref, source.operation, deps);
    expect(result).toMatchObject({
      state: 'completed',
      mode: 'partial_stop',
      contentPreserved: true,
      sessionId: f.session.id,
    });
    expect(f.retryTriggered()).toBe(true);
    const root = (await f.root.get()).data()!;
    expect(root.subsplashId).toBeUndefined();
    expect(root.soundCloudTrackId).toBeDefined();
    expect(root.soundCloudTrackUrl).toBe('https://synthetic.invalid/original');
    expect(root.status).toMatchObject({ subsplash: 'NOT_UPLOADED', soundCloud: 'UPLOADED' });
    expect(root.audioArtifacts).toEqual(preserved[0].data!.audioArtifacts);
    expect((await f.seriesItem.get()).get('sermonSubsplashId')).toBeUndefined();
    expect((await f.seriesItem.get()).get('publishedToSubsplash')).toBe(false);
    expect((await f.seriesItem.get()).get('mediaItem.soundCloudTrackId')).toBe(root.soundCloudTrackId);
    expect((await f.canonicalRefs.get()).data()).toEqual(preserved.at(-1)!.data);
    expect((await f.artifact.get()).data()).toEqual(preserved.find((row) => row.path === f.artifact.path)!.data);
    expect((await f.aggregate.get()).data()).toMatchObject({ state: 'deleted', referenceCount: 1 });
    expect((await f.trackAggregate.get()).data()).toMatchObject({ state: 'active', referenceCount: trackCount });
    expect((await db.doc(`${PROVIDER_MUTATION_SESSIONS}/${f.session.id}`).get()).data()).toMatchObject({
      state: 'committed',
      effectsClosed: true,
      effectsClosedClaimSetDigestVersion: 2,
      effectsClosedActualRequestCount: 1,
    });
    expect(
      f.observations.some((observed) => observed.state === 'active' && observed.closed && !observed.rootMediaPresent)
    ).toBe(true);
    expect(deps.readProvider).toHaveBeenCalledTimes(1);
    expect((await f.media.get()).get('deletionParentRef')).toBeUndefined();
    expect((await f.planning.get()).exists).toBe(false);
    expect((await db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${f.plan.planId}`).get()).get('rootRemoval')).toBeUndefined();
    expect((await db.doc(`${SERMON_DELETION_PARTIAL_STOPS}/${source.operation.planId}`).get()).get('state')).toBe(
      'completed'
    );
  }, 60000);
  test('a real unknown SC request blocks original candidate compilation and every factual/index disposition', async () => {
    const f = await fixture();
    await f.mutateOriginal(async () => ({ completion: 'acknowledged', result: { deleted: true } }));
    await expect(f.mutateTrackUnknown()).rejects.toThrow();
    const preserved = await f.snapshotPreserved(),
      mediaAggregate = (await f.aggregate.get()).data(),
      trackAggregate = (await f.trackAggregate.get()).data();
    await f.seal();
    await expect(f.compile()).rejects.toThrow();
    expect(await f.snapshotPreserved()).toEqual(preserved);
    expect((await f.aggregate.get()).data()).toEqual(mediaAggregate);
    expect((await f.trackAggregate.get()).data()).toEqual(trackAggregate);
    expect((await db.doc(`${PROVIDER_MUTATION_SESSIONS}/${f.session.id}`).get()).get('state')).toBe('active');
    expect((await f.media.get()).get('deletionParentRef')).toEqual(f.ref);
    expect((await f.planning.get()).get('deletionEffectsStarted')).toBe(true);
  }, 60000);
});
