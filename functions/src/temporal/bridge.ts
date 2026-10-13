import { createHash } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import {
  createDurableJobStore,
  durableEntityKey,
  withProviderIndexedTransaction,
} from '../../../packages/orchestration/src/job-store';
import {
  isDurableJobKind,
  isDurableJobTerminal,
  type DurableAdmissionRequest,
  type DurableAdmissionReceipt,
  type DurableEntityRef,
  type DurableJobKind,
  type DurableJobRef,
  type DurableWorkflowDispatch,
} from '@upperroom/contracts/temporal';
import { assertAdmissionReleaseInTransaction, TEMPORAL_RELEASE_CONTROL_PATH } from './releaseControl';
import {
  normalizeUploadSource,
  normalizeUploadSourceRetry,
  verifyUploadObject,
  type UploadSourceRetryPlan,
} from './sourceSessions';
import type { createMediaAdmission } from '../../../functions-media/src/temporal/admission';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';

import { entityLabel } from './displayLabel';
export { entityLabel } from './displayLabel';
export const temporalProjectId = (): string =>
  firebaseAdmin.app().options.projectId ??
  process.env.GCLOUD_PROJECT ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  (() => {
    throw new Error('Firebase project is required.');
  })();
export { isDomainTemporalEnabled } from './ownership';
import { isDomainTemporalEnabled } from './ownership';
export { domainForKind } from './ownership';
import { domainForKind, domainForIntent } from './ownership';
const db = () => firebaseAdmin.firestore();
const stable = (value: unknown): string => JSON.stringify(canonical(value));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  return value;
}
export const admissionKey = (uid: string, requestId: string) =>
  createHash('sha256')
    .update(stable([temporalProjectId(), uid, requestId]))
    .digest('hex');
export const durableInputFingerprint = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');
const requestHash = (request: DurableAdmissionRequest) => durableInputFingerprint(request);
function validateRequest(request: DurableAdmissionRequest): void {
  if (
    !request ||
    !isDurableJobKind(request.kind) ||
    typeof request.requestId !== 'string' ||
    !request.requestId.trim() ||
    request.requestId.length > 200 ||
    !request.entity ||
    typeof request.entity.id !== 'string' ||
    request.entity.id.length > 200 ||
    request.entity.id.includes('/') ||
    !['sermon', 'list', 'series', 'speaker', 'image', 'user', 'mail', 'bundle', 'maintenance'].includes(
      request.entity.type
    ) ||
    !request.payload ||
    Array.isArray(request.payload) ||
    typeof request.payload !== 'object' ||
    Buffer.byteLength(stable(request)) > 100000
  )
    throw new HttpsError('invalid-argument', 'Invalid durable request.');
  if (
    request.expectedGeneration !== undefined &&
    (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 0)
  )
    throw new HttpsError('invalid-argument', 'Invalid generation.');
  const expectedType =
    request.kind.startsWith('sermon.') || request.kind === 'audio.process' || request.kind === 'upload.create'
      ? 'sermon'
      : request.kind.startsWith('list.')
      ? 'list'
      : request.kind.startsWith('series.')
      ? 'series'
      : request.kind === 'speaker.mutate'
      ? 'speaker'
      : request.kind.startsWith('image.')
      ? 'image'
      : request.kind === 'maintenance.run'
      ? 'maintenance'
      : undefined;
  if (expectedType && request.entity.type !== expectedType)
    throw new HttpsError('invalid-argument', 'Operation entity type is invalid.');
}
export async function getServerDurableJobReceipt(
  actorUid: string,
  requestId: string
): Promise<DurableAdmissionReceipt | null> {
  const actor = await firebaseAdmin.auth().getUser(actorUid);
  if (actor.disabled) throw new HttpsError('permission-denied', 'Account is disabled.');
  if (typeof requestId !== 'string' || requestId.length > 200)
    throw new HttpsError('invalid-argument', 'Invalid request ID.');
  const data = (await db().collection('durableAdmissionReceipts').doc(admissionKey(actorUid, requestId)).get()).data();
  if (!data) return null;
  if (data.actorUid !== actorUid || data.projectId !== temporalProjectId())
    throw new HttpsError('permission-denied', 'Receipt is not available.');
  return data.receipt as DurableAdmissionReceipt;
}
async function authorizeEntity(entity: DurableEntityRef, role: string, uid: string): Promise<void> {
  const collection = {
    sermon: 'sermons',
    list: 'lists',
    series: 'series',
    speaker: 'speakers',
    image: 'images',
    user: 'users',
    mail: 'mail',
    bundle: 'metadata',
    maintenance: 'metadata',
  }[entity.type];
  if (!collection) throw new HttpsError('invalid-argument', 'Invalid entity.');
  const snapshot = await db().collection(collection).doc(entity.id).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Entity no longer exists.');
  if (
    role !== 'admin' &&
    ((entity.type === 'sermon' && snapshot.get('uploaderId') !== uid) ||
      (entity.type === 'series' && snapshot.get('ownerId') !== uid))
  )
    throw new HttpsError('permission-denied', 'You cannot change this entity.');
}
async function mediaBumpers(subtitle: string): Promise<{ introUrl: string; outroUrl: string }> {
  const bucket = firebaseAdmin.storage().bucket();
  const select = async (kind: 'intro' | 'outro') => {
    const specific = `${kind}s/${subtitle}_${kind}.mp3`;
    return subtitle && !subtitle.includes('/') && (await bucket.file(specific).exists())[0]
      ? specific
      : `${kind}s/default_${kind}.mp3`;
  };
  const [introUrl, outroUrl] = await Promise.all([select('intro'), select('outro')]);
  return { introUrl, outroUrl };
}
export async function admitMedia(
  payload: Parameters<ReturnType<typeof createMediaAdmission>>[0]['payload'],
  actorUid: string,
  requestId: string,
  expectedSourceGeneration?: string,
  sourceUploadJobId?: string,
  onlyIfMissing?: boolean,
  publicInputHash?: string,
  parentJobRef?: DurableJobRef
) {
  const store = createDurableJobStore({ firestore: db(), projectId: temporalProjectId() });
  const { createMediaAdmission } = await import('../../../functions-media/src/temporal/admission');
  const admit = createMediaAdmission({
    firestore: db(),
    bucket: firebaseAdmin.storage().bucket(),
    projectId: temporalProjectId(),
    coordinatorTaskQueue: 'urm-orchestration',
    mediaTaskQueue: 'urm-media',
    assertParentCurrentInTransaction: (tx, parent) => store.assertCurrentInTransaction(tx, parent),
    assertAdmissionReleaseInTransaction: (tx, continuation) =>
      assertAdmissionReleaseInTransaction(tx, db(), 'audio.process', { continuation }),
    async assertLegacyDrained(sermonId) {
      const [request, lock, deferred] = await Promise.all([
        firebaseAdmin.database().ref(`processAudioRequests/${sermonId}`).get(),
        firebaseAdmin.database().ref(`processAudioLocks/${sermonId}`).get(),
        firebaseAdmin.database().ref(`processAudioQueues/youtube/deferred/${sermonId}`).get(),
      ]);
      const record = request.val();
      if (
        record?.queuedTaskId ||
        record?.runningRequestId ||
        record?.nextPayload ||
        record?.deferredAt ||
        lock.exists() ||
        deferred.exists()
      )
        throw new HttpsError(
          'failed-precondition',
          'Previous audio processing must finish before Temporal takes ownership.'
        );
    },
    enqueueInTransaction: (tx, input) =>
      store.createInTransaction(tx, {
        ...input,
        dispatch: { ...input.dispatch, signal: { ...input.dispatch.signal, args: { ...input.dispatch.signal.args } } },
      }),
  });
  return admit({
    payload,
    actorUid,
    requestId,
    ...(expectedSourceGeneration ? { expectedSourceGeneration } : {}),
    ...(sourceUploadJobId ? { sourceUploadJobId } : {}),
    ...(onlyIfMissing ? { onlyIfMissing } : {}),
    ...(publicInputHash ? { publicInputHash } : {}),
    ...(parentJobRef ? { parentJobRef } : {}),
  });
}
/** Only trusted server code calls this function. Client facade supplies verified auth UID. */
export async function submitServerDurableJob(args: {
  kind: DurableJobKind;
  entity: DurableEntityRef;
  actorUid: string;
  requestId: string;
  payload: Record<string, unknown>;
  expectedGeneration?: number;
  continuation?: boolean;
  expectedReleaseControl?: { releaseId: string; revision: number };
}): Promise<DurableAdmissionReceipt> {
  if (args.kind === 'provider.orphan_review')
    throw new HttpsError(
      'permission-denied',
      'Provider review cases can only be created from verified server acknowledgements.'
    );
  const request: DurableAdmissionRequest = {
    kind: args.kind,
    entity: { type: args.entity.type, id: args.entity.id },
    requestId: args.requestId,
    payload: args.payload,
    ...(args.expectedGeneration === undefined ? {} : { expectedGeneration: args.expectedGeneration }),
  };
  validateRequest(request);
  const projectId = temporalProjectId(),
    key = admissionKey(args.actorUid, args.requestId),
    hash = requestHash(request),
    receiptDoc = db().collection('durableAdmissionReceipts').doc(key),
    ref = { jobId: `job-${key.slice(0, 48)}`, projectId };
  if (!args.actorUid.startsWith('system:')) {
    const currentActor = await firebaseAdmin.auth().getUser(args.actorUid);
    if (currentActor.disabled) throw new HttpsError('permission-denied', 'Account is disabled.');
  }
  const old = await receiptDoc.get();
  if (old.exists) {
    if (old.get('inputHash') !== hash)
      throw new HttpsError('already-exists', 'This request ID was already used for different input.');
    return old.get('receipt') as DurableAdmissionReceipt;
  }
  if (!isDomainTemporalEnabled(domainForIntent(args.kind, args.payload)))
    throw new HttpsError('failed-precondition', 'This operation has not moved to Temporal yet.');
  const internalBundle = args.actorUid === 'system:firebase-event' && args.kind === 'bundle.regenerate';
  const internalCleanup =
    args.actorUid === 'system:maintenance' &&
    args.kind === 'maintenance.run' &&
    args.payload.operation === 'media_artifacts_cleanup';
  const internal = internalBundle || internalCleanup;
  const actor = internal ? undefined : await firebaseAdmin.auth().getUser(args.actorUid);
  if (actor?.disabled) throw new HttpsError('permission-denied', 'Account is disabled.');
  const role = String(actor?.customClaims?.role ?? '');
  let entity: DurableEntityRef = { type: args.entity.type, id: args.entity.id },
    payload = args.payload,
    reserve: ((tx: Transaction, ref: DurableJobRef) => void | Promise<void>) | undefined,
    clientResult: Record<string, unknown> | undefined,
    sourceUpload: DurableAdmissionReceipt['sourceUpload'],
    uploadRetry: UploadSourceRetryPlan | undefined,
    workflowType: string;
  if (
    ['invite.create', 'invite.resend', 'invite.claim', 'role.resolve', 'role.assign', 'speaker.resolve'].includes(
      args.kind
    )
  ) {
    const { normalizeAccountAdmission } = await import('./accounts/admission');
    const plan = await normalizeAccountAdmission(request, args.actorUid);
    entity = plan.entity;
    payload = plan.payload as unknown as Record<string, unknown>;
    reserve = plan.reserve;
    clientResult = plan.clientResult;
    workflowType = 'accountsWorkflow';
  } else if (args.kind === 'upload.create') {
    if (!['admin', 'publisher', 'uploader'].includes(role))
      throw new HttpsError('permission-denied', 'Upload permission required.');
    if (payload.retryOfJobId !== undefined) {
      uploadRetry = await normalizeUploadSourceRetry(payload, args.actorUid, ref.jobId, projectId, db(), {
        actorRole: role,
      });
      entity = { type: 'sermon', id: uploadRetry.sermon.id, ...entityLabel(uploadRetry.sermon.title) };
      payload = uploadRetry.payload;
      reserve = uploadRetry.reserve;
      sourceUpload = uploadRetry.sourceUpload;
      clientResult = { sermonId: entity.id, retryOfJobId: args.payload.retryOfJobId };
      workflowType = 'uploadSourceAdmission';
    } else {
      const { normalizeCanonicalPublishingPatch } = await import('./publishing/intent');
      const rawSermon = payload.sermon as Record<string, unknown>;
      const canonicalMedia = await normalizeCanonicalPublishingPatch({
        patch: {
          ...(rawSermon.speakers ? { speakers: rawSermon.speakers } : {}),
          ...(rawSermon.images ? { images: rawSermon.images } : {}),
          ...(rawSermon.topics ? { topics: rawSermon.topics } : {}),
        },
        firestore: db(),
      });
      payload = { ...payload, sermon: { ...rawSermon, ...canonicalMedia } };
      const plan = normalizeUploadSource(payload, args.actorUid, ref.jobId, db(), { actorRole: role });
      entity = { type: 'sermon', id: plan.sermon.id, ...entityLabel(plan.sermon.title) };
      payload = plan.payload;
      reserve = plan.reserve;
      sourceUpload = plan.sourceUpload;
      if (
        payload.listIds !== undefined &&
        (!Array.isArray(payload.listIds) ||
          payload.listIds.length > 200 ||
          payload.listIds.some((id) => typeof id !== 'string' || !id || id.includes('/')))
      )
        throw new HttpsError('invalid-argument', 'Invalid selected lists.');
      for (const id of (payload.listIds ?? []) as string[])
        await authorizeEntity({ type: 'list', id }, role, args.actorUid);
      workflowType = 'uploadSourceAdmission';
      if (plan.sermon.seriesId)
        await authorizeEntity({ type: 'series', id: plan.sermon.seriesId }, role, args.actorUid);
    }
  } else if (args.kind.startsWith('sermon.')) {
    await authorizeEntity(entity, role, args.actorUid);
    const sermon = (await db().collection('sermons').doc(entity.id).get()).data() as Sermon;
    const { normalizePublishingIntent, normalizeCanonicalPublishingPatch } = await import('./publishing/intent');
    if (args.kind === 'sermon.update' && payload.patch)
      payload = {
        ...payload,
        patch: await normalizeCanonicalPublishingPatch({
          patch: payload.patch as Record<string, unknown>,
          firestore: db(),
        }),
      };
    payload = normalizePublishingIntent(
      { kind: args.kind, payload, generation: 1 },
      { ...sermon, id: entity.id },
      { uid: args.actorUid, role }
    ) as unknown as Record<string, unknown>;
    entity = { ...entity, ...entityLabel(sermon.title) };
    workflowType = 'publishingWorkflow';
    const selections = payload.destinations as { listIds?: string[]; seriesId?: string };
    for (const id of selections.listIds ?? []) await authorizeEntity({ type: 'list', id }, role, args.actorUid);
    if (selections.seriesId && (args.kind !== 'sermon.update' || selections.seriesId !== sermon.seriesId))
      await authorizeEntity({ type: 'series', id: selections.seriesId }, role, args.actorUid);
  } else if (args.kind === 'maintenance.run' && payload.operation === 'media_artifacts_cleanup') {
    if (role !== 'admin' && !internalCleanup)
      throw new HttpsError('permission-denied', 'Admin permission is required for media retention review.');
    const { normalizeMediaCleanupInput } = await import('../../../functions-media/src/temporal/artifactCleanupInput');
    try {
      payload = normalizeMediaCleanupInput(payload) as unknown as Record<string, unknown>;
    } catch {
      throw new HttpsError('invalid-argument', 'Invalid media retention policy.');
    }
    entity = { type: 'maintenance', id: 'media_artifacts_cleanup' };
    workflowType = 'MediaArtifactCleanup';
  } else if (args.kind === 'bundle.regenerate') {
    if (!internal && role !== 'admin') throw new HttpsError('permission-denied', 'Admin permission required.');
    const { normalizeBundleAdmission } = await import('./bundles/admission');
    payload = normalizeBundleAdmission(request);
    entity = { type: 'bundle', id: String(payload.bundleType) };
    workflowType = 'bundlesWorkflow';
  } else if (args.kind === 'image.ingest' || args.kind === 'image.delete') {
    if (!['admin', 'publisher', 'uploader'].includes(role))
      throw new HttpsError('permission-denied', 'Upload permission required.');
    if (args.kind === 'image.delete' && !['admin', 'publisher'].includes(role))
      throw new HttpsError('permission-denied', 'Admin permission required.');
    const { normalizeImageAdmission } = await import('./images/admission');
    const image = await normalizeImageAdmission({
      kind: args.kind,
      entityId: entity.id,
      requestId: args.requestId,
      payload,
      actorUid: args.actorUid,
      imagesBucket: process.env.IMAGES_BUCKET ?? firebaseAdmin.storage().bucket().name,
      firestore: db(),
      storage: firebaseAdmin.storage().bucket().storage,
    });
    entity = { type: 'image', id: image.imageId, ...entityLabel(image.name) };
    payload = image as unknown as Record<string, unknown>;
    workflowType = args.kind === 'image.delete' ? 'ImageDelete' : 'ImageIngest';
  } else if (args.kind === 'audio.process') {
    if (!['admin', 'publisher', 'uploader'].includes(role))
      throw new HttpsError('permission-denied', 'Upload permission required.');
    await authorizeEntity(entity, role, args.actorUid);
    const canonical = (await db().collection('sermons').doc(entity.id).get()).data() as Sermon;
    const source = canonical.audioArtifacts?.sourcePath
      ? { storageFilePath: canonical.audioArtifacts.sourcePath }
      : canonical.youtubeUrl
      ? { youtubeUrl: canonical.youtubeUrl }
      : { storageFilePath: `sermons/${entity.id}` };
    const bumpers = await mediaBumpers(canonical.subtitle);
    const media = await admitMedia(
      {
        id: entity.id,
        startTime: Number(payload.startTime),
        duration: Number(payload.duration),
        ...source,
        ...bumpers,
      },
      args.actorUid,
      args.requestId,
      undefined,
      undefined,
      false,
      hash
    );
    const job = await createDurableJobStore({ firestore: db(), projectId }).loadJob(media.ref);
    const receipt: DurableAdmissionReceipt = {
      jobId: job.jobId,
      projectId,
      requestId: args.requestId,
      admissionState: 'queued',
      generation: job.generation,
      revision: job.revision,
    };
    await db().runTransaction(async (tx) => {
      const duplicate = await tx.get(receiptDoc);
      if (duplicate.exists) {
        if (duplicate.get('inputHash') !== hash) throw new HttpsError('already-exists', 'Request ID already used.');
        return;
      }
      tx.create(receiptDoc, { actorUid: args.actorUid, projectId, inputHash: hash, receipt, createdAt: Date.now() });
    });
    return receipt;
  } else {
    if (
      [
        'provider.orphan_review',
        'series.sync_metadata',
        'search.sync',
        'search.backfill',
        'email.deliver',
        'youtube.authRecovery',
      ].includes(args.kind)
    )
      throw new HttpsError('permission-denied', 'Only trusted event admission may start this operation.');
    if (
      !['admin', 'publisher'].includes(role) ||
      (args.kind === 'maintenance.run' && role !== 'admin') ||
      (args.kind === 'speaker.mutate' && role !== 'admin')
    )
      throw new HttpsError('permission-denied', 'Publishing permission required.');
    if (
      !args.kind.endsWith('.create') &&
      args.kind !== 'maintenance.run' &&
      !(args.kind === 'speaker.mutate' && payload.operation === 'create')
    )
      await authorizeEntity(entity, role, args.actorUid);
    const { normalizePublishingEntityAdmission } = await import('./publishing/entityMutations');
    payload = (await normalizePublishingEntityAdmission({
      kind: args.kind,
      entity,
      payload,
      actorUid: args.actorUid,
      role,
    })) as unknown as Record<string, unknown>;
    workflowType = args.kind === 'maintenance.run' ? 'maintenanceWorkflow' : 'publishingEntityWorkflow';
  }
  if (['list', 'series', 'speaker', 'image'].includes(entity.type) && !entity.label) {
    const collection = { list: 'lists', series: 'series', speaker: 'speakers', image: 'images' }[
      entity.type as 'list' | 'series' | 'speaker' | 'image'
    ];
    const canonicalEntity = (await db().collection(collection).doc(entity.id).get()).data();
    const normalizedInput = payload.input as Record<string, unknown> | undefined;
    const desiredName =
      payload.operation === 'create'
        ? normalizedInput?.title ??
          normalizedInput?.name ??
          (normalizedInput?.speaker as { name?: unknown } | undefined)?.name
        : undefined;
    entity = { ...entity, ...entityLabel(canonicalEntity?.name ?? canonicalEntity?.title ?? desiredName) };
  }
  const entityDoc = db().collection('durableJobEntities').doc(durableEntityKey(projectId, entity, args.kind));
  const receipt = await db().runTransaction(async (transaction) =>
    withProviderIndexedTransaction(
      transaction,
      db(),
      projectId,
      async (tx) => {
        const [dedupe, previous] = await Promise.all([tx.get(receiptDoc), tx.get(entityDoc)]);
        if (dedupe.exists) {
          if (dedupe.get('inputHash') !== hash) throw new HttpsError('already-exists', 'Request ID already used.');
          return dedupe.get('receipt') as DurableAdmissionReceipt;
        }
        await assertAdmissionReleaseInTransaction(tx, db(), args.kind, {
          continuation: args.continuation === true && internalBundle,
          domain: domainForIntent(args.kind, payload),
        });
        if (args.expectedReleaseControl) {
          if (
            !internal ||
            typeof args.expectedReleaseControl.releaseId !== 'string' ||
            !Number.isSafeInteger(args.expectedReleaseControl.revision)
          )
            throw new HttpsError(
              'permission-denied',
              'Release identity fencing is reserved for trusted bootstrap jobs.'
            );
          const currentControl = await tx.get(db().doc(TEMPORAL_RELEASE_CONTROL_PATH));
          if (
            currentControl.get('releaseId') !== args.expectedReleaseControl.releaseId ||
            currentControl.get('revision') !== args.expectedReleaseControl.revision
          )
            throw new HttpsError('aborted', 'The release changed before bootstrap admission.');
        }
        let previousActive = false;
        if (previous.exists) {
          const active = await tx.get(db().collection('durableJobs').doc(previous.get('activeJobId')));
          previousActive = active.exists && !isDurableJobTerminal(active.get('state'));
          if (previousActive && args.kind !== 'bundle.regenerate')
            throw new HttpsError('aborted', 'An operation is already active for this entity.');
        }
        const previousGeneration = Number(previous.get('generation') ?? 0);
        if (args.expectedGeneration !== undefined && args.expectedGeneration !== previousGeneration)
          throw new HttpsError('aborted', 'Entity changed; refresh and retry.');
        if (uploadRetry) {
          const prepared = await uploadRetry.prepare(tx);
          if (prepared.alreadyComplete) {
            const complete: DurableAdmissionReceipt = {
              jobId: args.payload.retryOfJobId as string,
              projectId,
              requestId: args.requestId,
              admissionState: 'queued',
              revision: prepared.originalRevision,
              generation: prepared.originalGeneration,
              clientResult: { alreadyComplete: true, sermonId: entity.id },
            };
            tx.create(receiptDoc, {
              actorUid: args.actorUid,
              projectId,
              inputHash: hash,
              receipt: complete,
              createdAt: Date.now(),
            });
            return complete;
          }
        }
        const generation = previousGeneration + 1;
        if (args.kind.startsWith('sermon.')) payload = { ...payload, generation };
        if (args.kind.startsWith('sermon.')) {
          const current = await tx.get(db().collection('sermons').doc(entity.id));
          const admitted = (payload.payload as { sermon?: Sermon })?.sermon;
          if (!current.exists || Number(current.get('editedAtMillis') ?? 0) !== Number(admitted?.editedAtMillis ?? 0))
            throw new HttpsError(
              'aborted',
              'This sermon changed while the request was being saved. Refresh and try again.'
            );
          if (args.kind === 'sermon.publish') {
            const selected = (payload.destinations as { seriesId?: string }).seriesId;
            if (selected) {
              const series = await tx.get(db().doc(`series/${selected}`));
              if (!series.exists || (role !== 'admin' && series.get('ownerId') !== args.actorUid))
                throw new HttpsError('permission-denied', 'The selected series changed before admission.');
              const members = await tx.get(
                series.ref.collection('seriesItems').where('publishedToSubsplash', '==', true).limit(501)
              );
              if (members.size > 500)
                throw new HttpsError('failed-precondition', 'The selected series needs bounded reconciliation first.');
              const ids = members.docs
                .map((doc) => doc.get('sermonSubsplashId'))
                .filter((id): id is string => typeof id === 'string' && !!id);
              const expectedPublishedMembershipHash = [...new Set(ids)].sort().join('|') || 'empty';
              const frozen = payload.payload as Record<string, unknown>;
              const { publishedItemOrder: _clientOrder, ...safeFrozen } = frozen;
              payload = { ...payload, payload: { ...safeFrozen, expectedPublishedMembershipHash } };
            }
          }
          if (args.kind === 'sermon.update') {
            const { assertPublishingContentUpdateAllocationsSettled } = await import('./publishing/allocationBarrier');
            try {
              await assertPublishingContentUpdateAllocationsSettled(tx, db(), { ref, sermonId: entity.id });
            } catch (error) {
              if ((error as { code?: string }).code === 'PUBLISHING_PROVIDER_ALLOCATION_PENDING')
                throw new HttpsError(
                  'aborted',
                  'A provider allocation is still being confirmed for this sermon. Finish or review that operation before editing.'
                );
              throw error;
            }
            const memberships = await tx.get(current.ref.collection('sermonLists').limit(501));
            if (memberships.size > 500)
              throw new HttpsError(
                'failed-precondition',
                'This sermon needs a bounded membership reconciliation before editing.'
              );
            const privatePayload = (payload.payload ?? {}) as Record<string, unknown>;
            const previousListIds = memberships.docs.map((doc) => doc.id);
            const publishedListIds = memberships.docs
              .filter((doc) => doc.get('uploadStatus.status') === 'UPLOADED')
              .map((doc) => doc.id);
            const previousSeriesId =
              typeof current.get('seriesId') === 'string' && current.get('seriesId')
                ? (current.get('seriesId') as string)
                : null;
            const previousSeriesRow = previousSeriesId
              ? await tx.get(db().doc(`series/${previousSeriesId}/seriesItems/${entity.id}`))
              : undefined;
            const destinations = {
              ...(payload.destinations as { listIds: string[]; seriesId?: string; soundcloud: boolean }),
            };
            const clientDestinations = args.payload.destinations as { listIds?: unknown } | undefined;
            if (args.payload.listIds === undefined && clientDestinations?.listIds === undefined)
              destinations.listIds = previousListIds;
            const selectedListIds = [...new Set(destinations.listIds)];
            const desiredIds = new Set(selectedListIds),
              removed = previousListIds.filter((id) => !desiredIds.has(id));
            if (
              privatePayload.hasMembershipSelection === true &&
              removed.length * 3 + selectedListIds.length * 2 + 4 > 450
            )
              throw new HttpsError(
                'invalid-argument',
                'This membership change is too large for one edit. Use bounded list actions before editing the sermon.'
              );
            const selectedDocs = await Promise.all(selectedListIds.map((id) => tx.get(db().doc(`lists/${id}`))));
            if (selectedDocs.some((doc) => !doc.exists))
              throw new HttpsError('failed-precondition', 'A selected list no longer exists.');
            const desiredSeriesId =
              typeof privatePayload.desiredSeriesId === 'string' ? privatePayload.desiredSeriesId : null;
            const targetSeries = desiredSeriesId ? await tx.get(db().doc(`series/${desiredSeriesId}`)) : undefined;
            if (
              targetSeries &&
              (!targetSeries.exists ||
                (privatePayload.hasMembershipSelection === true &&
                  desiredSeriesId !== previousSeriesId &&
                  role !== 'admin' &&
                  targetSeries.get('ownerId') !== args.actorUid))
            )
              throw new HttpsError('permission-denied', 'The selected series is unavailable to this account.');
            const targetItems = targetSeries
              ? await tx.get(
                  targetSeries.ref.collection('seriesItems').where('publishedToSubsplash', '==', true).limit(501)
                )
              : undefined;
            if (targetItems && targetItems.size > 500)
              throw new HttpsError(
                'failed-precondition',
                'The target series needs a bounded reconciliation before this edit.'
              );
            const targetPublishedIds = (targetItems?.docs ?? [])
              .map((doc) => doc.get('sermonSubsplashId'))
              .filter((id): id is string => typeof id === 'string' && !!id);
            const expectedTargetHash = [...new Set(targetPublishedIds)].sort().join('|') || 'empty';
            const previousMembershipHash = durableInputFingerprint({
              lists: memberships.docs
                .map((doc) => ({
                  id: doc.id,
                  publishGeneration: doc.get('publishGeneration') ?? 0,
                  uploadStatus: doc.get('uploadStatus') ?? { status: 'NOT_UPLOADED' },
                }))
                .sort((a, b) => a.id.localeCompare(b.id)),
              previousSeriesId,
              previousSeriesPublished: previousSeriesRow?.get('publishedToSubsplash') === true,
            });
            const { publishedItemOrder: _clientOrder, ...safePrivatePayload } = privatePayload;
            payload = {
              ...payload,
              destinations: { ...destinations, listIds: selectedListIds },
              payload: {
                ...safePrivatePayload,
                previousListIds,
                publishedListIds,
                previousSeriesId,
                previousSeriesPublished: previousSeriesRow?.get('publishedToSubsplash') === true,
                selectedLists: selectedDocs.map((doc) => ({ ...doc.data(), id: doc.id })),
                previousMembershipHash,
                ...(desiredSeriesId ? { expectedPublishedMembershipHash: expectedTargetHash } : {}),
              },
            };
            if (Buffer.byteLength(JSON.stringify(payload)) > 750000)
              throw new HttpsError(
                'invalid-argument',
                'Selected metadata exceeds the safe admission size. Choose fewer destinations.'
              );
          }
        }
        const createdAt = Date.now(),
          dispatch: DurableWorkflowDispatch = {
            ref,
            workflowType,
            workflowId: `${projectId}:${entity.type}:${entity.id}:${ref.jobId}`,
            taskQueue: args.kind.startsWith('image.') ? 'urm-images' : 'urm-orchestration',
          };
        if (workflowType === 'MediaArtifactCleanup') dispatch.startArgs = { ref };
        if (args.kind === 'bundle.regenerate') {
          dispatch.workflowId = `bundle:${projectId}:${entity.id}`;
          dispatch.signal = { name: 'requestBundleRegeneration', args: ref };
        }
        const store = createDurableJobStore({ firestore: db(), projectId });
        const admission = {
          ref,
          kind: args.kind,
          entity,
          actorUid: args.actorUid,
          payload,
          requestId: args.requestId,
          generation,
          dispatch,
          initialState: args.kind === 'upload.create' ? ('awaiting_source' as const) : ('queued' as const),
          createdAt,
        };
        const writeUsage = await store.prepareCreateInTransaction(tx, admission);
        if (reserve) await reserve(tx, ref);
        if (previousActive && args.kind === 'bundle.regenerate')
          tx.update(db().collection('durableJobs').doc(previous.get('activeJobId')), {
            state: 'superseded',
            revision: FieldValue.increment(1),
            actions: [],
            finishedAt: Date.now(),
            updatedAt: Date.now(),
          });
        writeUsage();
        store.createInTransaction(tx, admission);
        const next: DurableAdmissionReceipt = {
          ...ref,
          requestId: args.requestId,
          admissionState: args.kind === 'upload.create' ? 'awaiting_source' : 'queued',
          revision: 1,
          generation,
          ...(sourceUpload ? { sourceUpload } : {}),
          ...(clientResult ? { clientResult } : {}),
        };
        if (sourceUpload)
          tx.update(db().collection('durableJobs').doc(ref.jobId), { result: { sourceUpload, sermonId: entity.id } });
        tx.create(receiptDoc, { actorUid: args.actorUid, projectId, inputHash: hash, receipt: next, createdAt });
        return next;
      },
      { excludeCanonicalPaths: [`durableJobIntents/${ref.jobId}`] }
    )
  );
  if (args.kind === 'upload.create' && !sourceUpload && receipt.clientResult?.alreadyComplete !== true)
    await confirmUploadSource(args.actorUid, receipt.jobId, {});
  return receipt;
}
export async function confirmUploadSource(
  actorUid: string,
  jobId: string,
  resolution: Record<string, unknown>
): Promise<DurableJobRef> {
  const ref = { jobId, projectId: temporalProjectId() },
    sessionDoc = db().collection('durableUploadSessions').doc(jobId),
    session = (await sessionDoc.get()).data();
  if (!session || session.actorUid !== actorUid || session.projectId !== ref.projectId)
    throw new HttpsError('permission-denied', 'Upload session is unavailable.');
  if (session.mediaJobRef) return session.mediaJobRef as DurableJobRef;
  const actor = await firebaseAdmin.auth().getUser(actorUid);
  if (actor.disabled || !['admin', 'publisher', 'uploader'].includes(String(actor.customClaims?.role)))
    throw new HttpsError('permission-denied', 'Upload permission changed.');
  const current = (await db().collection('durableJobs').doc(jobId).get()).data();
  if (!current || ['cancelled', 'cancel_requested'].includes(current.state) || session.state === 'cancelled')
    throw new HttpsError('aborted', 'Upload was cancelled.');
  const generation = session.sourceUpload
    ? await verifyUploadObject(
        firebaseAdmin.storage().bucket(),
        session as Parameters<typeof verifyUploadObject>[1],
        jobId,
        resolution
      )
    : undefined;
  const input = session.payload;
  const sermon = (await db().collection('sermons').doc(session.sermonId).get()).data() as Sermon;
  const bumpers = await mediaBumpers(sermon.subtitle);
  const media = await admitMedia(
    {
      id: session.sermonId,
      startTime: input.trimStart,
      duration: input.duration,
      ...bumpers,
      ...(session.sourceUpload
        ? { storageFilePath: session.sourceUpload.storagePath }
        : { youtubeUrl: input.source.url }),
    },
    actorUid,
    `upload-source:${jobId}`,
    generation,
    jobId
  );
  return media.ref;
}
export async function awaitDurableJobResult(
  ref: DurableJobRef,
  options: { actorUid: string; timeoutMs?: number }
): Promise<{ state: string; result?: Record<string, unknown> }> {
  const job = await createDurableJobStore({ firestore: db(), projectId: temporalProjectId() }).loadJob(ref);
  if (job.requestedBy !== options.actorUid) throw new HttpsError('permission-denied', 'Job result is unavailable.');
  return { state: job.state, ...(job.result ? { result: job.result } : {}) };
}

/** Event triggers only; never exported as a callable. Caller supplies a fixed workflow descriptor. */
export async function enqueueSystemJob(input: {
  kind: DurableJobKind;
  entity: DurableEntityRef;
  payload: Record<string, unknown>;
  eventId: string;
  dispatch: Omit<DurableWorkflowDispatch, 'ref'>;
}): Promise<DurableAdmissionReceipt> {
  if (
    ![
      'series.sync_metadata',
      'image.ingest',
      'image.delete',
      'search.sync',
      'search.backfill',
      'email.deliver',
      'bundle.regenerate',
      'youtube.authRecovery',
    ].includes(input.kind)
  )
    throw new HttpsError('invalid-argument', 'Unsupported system event.');
  if (!isDomainTemporalEnabled(domainForKind(input.kind)))
    throw new HttpsError('failed-precondition', 'Temporal event admission is not enabled.');
  const entity: DurableEntityRef = { type: input.entity.type, id: input.entity.id };
  const collection = (
    { sermon: 'sermons', list: 'lists', series: 'series', speaker: 'speakers', image: 'images' } as Partial<
      Record<DurableEntityRef['type'], string>
    >
  )[entity.type];
  if (collection) {
    const canonicalEntity = (await db().collection(collection).doc(entity.id).get()).data();
    Object.assign(entity, entityLabel(canonicalEntity?.title ?? canonicalEntity?.name));
  }
  const actorUid = 'system:firebase-event',
    requestId = input.eventId,
    projectId = temporalProjectId(),
    key = admissionKey(actorUid, `${input.kind}:${requestId}`),
    ref = { jobId: `job-${key.slice(0, 48)}`, projectId },
    receiptDoc = db().collection('durableAdmissionReceipts').doc(key),
    entityDoc = db().collection('durableJobEntities').doc(durableEntityKey(projectId, entity, input.kind)),
    hash = createHash('sha256').update(stable(input)).digest('hex');
  return db().runTransaction(async (tx) => {
    const [duplicate, entityState] = await Promise.all([tx.get(receiptDoc), tx.get(entityDoc)]);
    if (duplicate.exists) {
      if (duplicate.get('inputHash') !== hash) throw new HttpsError('already-exists', 'Event identity changed.');
      return duplicate.get('receipt') as DurableAdmissionReceipt;
    }
    await assertAdmissionReleaseInTransaction(tx, db(), input.kind);
    const previousJob = entityState.exists
      ? await tx.get(db().collection('durableJobs').doc(entityState.get('activeJobId')))
      : undefined;
    const replacingActive = previousJob?.exists && !isDurableJobTerminal(previousJob.get('state'));
    const convergent = ['search.sync', 'series.sync_metadata', 'bundle.regenerate'].includes(input.kind);
    if (replacingActive && !convergent) throw new HttpsError('aborted', 'An operation already owns this resource.');
    const generation = Number(entityState.get('generation') ?? 0) + 1,
      createdAt = Date.now();
    const dispatch = { ...input.dispatch, ref };
    const store = createDurableJobStore({ firestore: db(), projectId });
    const admission = {
      ref,
      kind: input.kind,
      entity,
      actorUid,
      payload: input.payload,
      requestId,
      generation,
      dispatch,
      createdAt,
    };
    const writeUsage = await store.prepareCreateInTransaction(tx, admission);
    if (replacingActive && previousJob)
      tx.update(previousJob.ref, {
        state: 'superseded',
        revision: FieldValue.increment(1),
        actions: [],
        finishedAt: Date.now(),
        updatedAt: Date.now(),
      });
    if (replacingActive && previousJob && ['search.sync', 'series.sync_metadata'].includes(input.kind)) {
      tx.create(db().collection('durableJobCommands').doc(`supersede-${ref.jobId}`), {
        schemaVersion: 1,
        projectId,
        jobId: previousJob.id,
        workflowId: previousJob.get('workflowId'),
        action: 'cancel',
        cancellationReason: 'superseded',
        actorUid: 'system:firebase-event',
        state: 'pending',
        attempt: 0,
        nextAttemptAt: 0,
        leaseExpiresAt: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    writeUsage();
    store.createInTransaction(tx, admission);
    const receipt: DurableAdmissionReceipt = { ...ref, requestId, admissionState: 'queued', revision: 1, generation };
    tx.create(receiptDoc, { actorUid, projectId, inputHash: hash, receipt, createdAt });
    return receipt;
  });
}
