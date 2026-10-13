import { createHash } from 'node:crypto';
import { type Transaction, type Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import type { DurableAdmissionReceipt, DurableJobRef } from '@upperroom/contracts/temporal';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';
import { durableEntityKey } from '../../../packages/orchestration/src/job-store';
import { isDurableJobTerminal } from '@upperroom/contracts/temporal';

export interface UploadSourcePlan {
  sermon: Sermon;
  payload: Record<string, unknown>;
  sourceUpload?: NonNullable<DurableAdmissionReceipt['sourceUpload']>;
  reserve(tx: Transaction, ref: DurableJobRef): Promise<void>;
}
export interface UploadSourceRetryPlan extends UploadSourcePlan {
  prepare(tx: Transaction): Promise<{ alreadyComplete: boolean; originalRevision: number; originalGeneration: number }>;
}
/** A source retry derives its canonical identity solely from a prior private admission. */
export async function normalizeUploadSourceRetry(
  input: Record<string, unknown>,
  actorUid: string,
  jobId: string,
  projectId: string,
  db: Firestore,
  options: { actorRole?: string } = {}
): Promise<UploadSourceRetryPlan> {
  const originalId = input.retryOfJobId;
  if (typeof originalId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(originalId))
    invalid('Invalid original source job.');
  const intentRef = db.doc(`durableJobIntents/${originalId}`),
    sessionRef = db.doc(`durableUploadSessions/${originalId}`);
  const [originalIntent, originalSession] = await Promise.all([intentRef.get(), sessionRef.get()]);
  if (
    originalIntent.get('kind') !== 'upload.create' ||
    originalIntent.get('projectId') !== projectId ||
    originalIntent.get('actorUid') !== actorUid ||
    originalSession.get('actorUid') !== actorUid ||
    originalSession.get('projectId') !== projectId
  )
    throw new HttpsError('permission-denied', 'The original upload does not belong to this account.');
  const prior = originalIntent.get('payload') as Record<string, unknown>,
    sermonId = prior?.sermonId;
  if (typeof sermonId !== 'string' || sermonId.includes('/') || originalSession.get('sermonId') !== sermonId)
    throw new HttpsError('failed-precondition', 'The original upload identity is unavailable.');
  const canonicalRef = db.doc(`sermons/${sermonId}`),
    canonical = (await canonicalRef.get()).data() as Sermon | undefined;
  if (!canonical || canonical.uploaderId !== actorUid)
    throw new HttpsError('failed-precondition', 'The admitted sermon is no longer available to this account.');
  const fresh = normalizeUploadSource({ ...input, sermon: canonical, listIds: [] }, actorUid, jobId, db, options);
  const oldDescriptor = originalSession.get('sourceUpload') as UploadSourcePlan['sourceUpload'];
  const fileIdentity = (file: NonNullable<UploadSourcePlan['sourceUpload']>['expectedFile']) => [
    file.name,
    file.size,
    file.lastModified,
    file.fingerprint?.algorithm,
    file.fingerprint?.chunkBytes,
    file.fingerprint?.value,
  ];
  if (
    input.trimStart !== prior.trimStart ||
    input.duration !== prior.duration ||
    (oldDescriptor
      ? !fresh.sourceUpload ||
        JSON.stringify(fileIdentity(fresh.sourceUpload.expectedFile)) !==
          JSON.stringify(fileIdentity(oldDescriptor.expectedFile))
      : fresh.sourceUpload ||
        (fresh.payload.source as { url?: string }).url !== (prior.source as { url?: string })?.url)
  )
    throw new HttpsError('failed-precondition', 'A source retry must use the original file or URL and audio range.');
  const payload = { ...fresh.payload, sermonId, retryOfJobId: originalId };
  const entity = { type: 'sermon' as const, id: sermonId };
  return {
    sermon: { ...canonical, id: sermonId },
    payload,
    sourceUpload: fresh.sourceUpload,
    async prepare(tx) {
      const [intent, session, original, sermon, sourceHead, audioHead, publishingHead, mediaState] = await Promise.all([
        tx.get(intentRef),
        tx.get(sessionRef),
        tx.get(db.doc(`durableJobs/${originalId}`)),
        tx.get(canonicalRef),
        tx.get(db.doc(`durableJobEntities/${durableEntityKey(projectId, entity, 'upload.create')}`)),
        tx.get(db.doc(`durableJobEntities/${durableEntityKey(projectId, entity, 'audio.process')}`)),
        tx.get(db.doc(`durableJobEntities/${durableEntityKey(projectId, entity, 'sermon.publish')}`)),
        tx.get(db.doc(`temporalMediaState/${sermonId}`)),
      ]);
      if (
        !sermon.exists ||
        sermon.get('uploaderId') !== actorUid ||
        intent.get('actorUid') !== actorUid ||
        intent.get('projectId') !== projectId ||
        intent.get('kind') !== 'upload.create' ||
        intent.get('payload.sermonId') !== sermonId ||
        session.get('actorUid') !== actorUid ||
        session.get('sermonId') !== sermonId ||
        original.get('projectId') !== projectId ||
        original.get('requestedBy') !== actorUid ||
        sourceHead.get('activeJobId') !== originalId
      )
        throw new HttpsError('aborted', 'The original source ownership changed. Refresh before retrying.');
      if (
        sermon.get('subsplashId') ||
        sermon.get('soundCloudTrackId') ||
        ['UPLOADED', 'PROCESSING'].includes(sermon.get('status.subsplash')) ||
        ['UPLOADED', 'PROCESSING'].includes(sermon.get('status.soundCloud')) ||
        mediaState.get('deletionParentRef')
      )
        throw new HttpsError(
          'failed-precondition',
          'Published sermons or pending deletion cannot start a source retry.'
        );
      const heads = [audioHead, publishingHead].filter((head) => head.exists);
      const jobs = await Promise.all(heads.map((head) => tx.get(db.doc(`durableJobs/${head.get('activeJobId')}`))));
      if (jobs.some((job) => !job.exists || !isDurableJobTerminal(job.get('state'))))
        throw new HttpsError(
          'aborted',
          'Another operation still owns this sermon. Resume or review it before retrying.'
        );
      if (publishingHead.exists && jobs[heads.indexOf(publishingHead)]?.get('state') !== 'succeeded')
        throw new HttpsError(
          'failed-precondition',
          'A prior publishing attempt needs a completed review before this source can be retried.'
        );
      const mediaRef = session.get('mediaJobRef') as DurableJobRef | undefined;
      if (mediaRef) {
        const media = await tx.get(db.doc(`durableJobs/${mediaRef.jobId}`));
        const alreadyComplete =
          original.get('state') === 'succeeded' &&
          media.get('state') === 'succeeded' &&
          mediaRef.projectId === projectId &&
          audioHead.get('activeJobId') === mediaRef.jobId &&
          sermon.get('status.audioStatus') === 'PROCESSED' &&
          Boolean(sermon.get('audioArtifacts'));
        if (!alreadyComplete)
          throw new HttpsError(
            'failed-precondition',
            'This source was already admitted for audio processing. Continue its audio task instead of uploading again.'
          );
        return {
          alreadyComplete,
          originalRevision: original.get('revision'),
          originalGeneration: original.get('generation'),
        };
      }
      if (
        !['failed', 'cancelled', 'superseded'].includes(original.get('state')) ||
        audioHead.exists ||
        mediaState.exists
      )
        throw new HttpsError(
          'failed-precondition',
          'Source retry requires a finished source-only task with no processing ownership.'
        );
      if (sermon.get('sourceStartTime') !== prior.trimStart || sermon.get('trimDurationSeconds') !== prior.duration)
        throw new HttpsError('aborted', 'The canonical audio selection changed after this source admission.');
      return {
        alreadyComplete: false,
        originalRevision: original.get('revision'),
        originalGeneration: original.get('generation'),
      };
    },
    async reserve(tx, ref) {
      tx.update(canonicalRef, { 'status.audioStatus': 'PENDING', 'status.message': 'Waiting for the source upload.' });
      tx.create(db.doc(`durableUploadSessions/${ref.jobId}`), {
        actorUid,
        projectId,
        sermonId,
        state: fresh.sourceUpload ? 'awaiting_source' : 'ready',
        createdAt: Date.now(),
        payload,
        ...(fresh.sourceUpload ? { sourceUpload: fresh.sourceUpload } : {}),
      });
    },
  };
}
const invalid = (message: string): never => {
  throw new HttpsError('invalid-argument', message);
};
export function normalizeUploadSource(
  input: Record<string, unknown>,
  actorUid: string,
  jobId: string,
  db: Firestore,
  options: { actorRole?: string } = {}
): UploadSourcePlan {
  const raw = input.sermon as Partial<Sermon>;
  const source = input.source as Record<string, unknown> | undefined;
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 500 || !source)
    invalid('A title and source are required.');
  const trimStart = input.trimStart;
  const duration = input.duration;
  if (
    typeof trimStart !== 'number' ||
    !Number.isFinite(trimStart) ||
    trimStart < 0 ||
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 86400
  )
    invalid('A valid audio range is required.');
  const sermonId = `upload-${createHash('sha256').update(jobId).digest('hex').slice(0, 40)}`;
  const now = Date.now();
  const sermon: Sermon = {
    id: sermonId,
    title: raw.title!.trim(),
    description: typeof raw.description === 'string' ? raw.description.slice(0, 50000) : '',
    subtitle: typeof raw.subtitle === 'string' ? raw.subtitle.slice(0, 1000) : '',
    speakers: Array.isArray(raw.speakers) ? raw.speakers.slice(0, 50) : [],
    topics: Array.isArray(raw.topics) ? raw.topics.filter((x) => typeof x === 'string').slice(0, 100) : [],
    images: Array.isArray(raw.images) ? raw.images.slice(0, 20) : [],
    dateMillis: typeof raw.dateMillis === 'number' && Number.isFinite(raw.dateMillis) ? raw.dateMillis : now,
    sourceStartTime: trimStart as number,
    durationSeconds: duration as number,
    trimDurationSeconds: duration as number,
    createdAtMillis: now,
    editedAtMillis: now,
    uploaderId: actorUid,
    status: { audioStatus: 'PENDING', subsplash: 'NOT_UPLOADED', soundCloud: 'NOT_UPLOADED' } as Sermon['status'],
  };
  if (typeof raw.seriesId === 'string' && /^[^/]{1,200}$/.test(raw.seriesId)) sermon.seriesId = raw.seriesId;
  let sourceUpload: UploadSourcePlan['sourceUpload'];
  if (source!.type === 'file') {
    const fingerprint = source!.fingerprint as
      | { algorithm?: unknown; chunkBytes?: unknown; value?: unknown }
      | undefined;
    if (
      typeof source!.name !== 'string' ||
      source!.name.length > 255 ||
      typeof source!.size !== 'number' ||
      !Number.isSafeInteger(source!.size) ||
      source!.size <= 0 ||
      source!.size > 20 * 1024 * 1024 * 1024 ||
      typeof source!.lastModified !== 'number' ||
      !Number.isFinite(source!.lastModified)
    )
      invalid('Invalid source file.');
    if (
      !fingerprint ||
      fingerprint.algorithm !== 'sha256-chunks-v1' ||
      fingerprint.chunkBytes !== 4194304 ||
      typeof fingerprint.value !== 'string' ||
      !/^[a-f0-9]{64}$/.test(fingerprint.value)
    )
      invalid('A valid source fingerprint is required.');
    sourceUpload = {
      storagePath: `durable-upload-sources/${actorUid}/${jobId}/source`,
      expectedFile: {
        name: source!.name as string,
        size: source!.size as number,
        lastModified: source!.lastModified as number,
        fingerprint: fingerprint as { algorithm: string; chunkBytes: number; value: string },
      },
      jobRevision: 1,
    };
  } else if (source!.type === 'youtube') {
    if (typeof source!.url !== 'string' || source!.url.length > 2048) invalid('Invalid YouTube source.');
    let url: URL;
    try {
      url = new URL(source!.url as string);
    } catch {
      return invalid('Invalid YouTube source.');
    }
    if (
      url.protocol !== 'https:' ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)
    )
      invalid('Invalid YouTube source.');
    sermon.youtubeUrl = url.toString();
  } else invalid('Unsupported source type.');
  const payload = {
    sermonId,
    trimStart,
    duration,
    listIds: input.listIds ?? [],
    source: source!.type === 'youtube' ? { type: 'youtube', url: sermon.youtubeUrl } : { type: 'file' },
    ...(sourceUpload ? { sourceUpload } : {}),
  };
  return {
    sermon,
    payload,
    sourceUpload,
    async reserve(tx, ref) {
      const listIds = [...new Set((input.listIds ?? []) as string[])];
      if (listIds.length > 100) invalid('Select at most 100 lists.');
      const lists = await Promise.all(listIds.map((id) => tx.get(db.collection('lists').doc(id))));
      if (
        lists.some(
          (list) =>
            !list.exists ||
            list.get('isMoreSermonsList') === true ||
            (list.get('rootListId') && list.get('rootListId') !== list.id)
        )
      )
        throw new HttpsError('failed-precondition', 'A selected list no longer exists.');
      const seriesRef = sermon.seriesId ? db.collection('series').doc(sermon.seriesId) : undefined;
      const series = seriesRef ? await tx.get(seriesRef) : undefined;
      if (seriesRef && !series?.exists)
        throw new HttpsError('failed-precondition', 'Selected series no longer exists.');
      if (seriesRef && options.actorRole !== 'admin' && series?.get('ownerId') !== actorUid)
        throw new HttpsError('permission-denied', 'The selected series changed ownership before upload admission.');
      const latest = seriesRef
        ? await tx.get(seriesRef.collection('seriesItems').orderBy('position', 'desc').limit(1))
        : undefined;
      sermon.numberOfLists = lists.length;
      sermon.numberOfListsUploadedTo = 0;
      tx.create(db.collection('sermons').doc(sermonId), sermon);
      for (const list of lists) {
        const local = { ...list.data(), id: list.id };
        tx.create(list.ref.collection('listItems').doc(sermonId), { ...sermon, _durableMembershipJobId: ref.jobId });
        tx.create(db.collection('sermons').doc(sermonId).collection('sermonLists').doc(list.id), {
          ...local,
          uploadStatus: { status: 'NOT_UPLOADED' },
          publishGeneration: 0,
          _durableMembershipJobId: ref.jobId,
        });
        tx.update(list.ref, {
          count: Number(list.get('count') ?? 0) + 1,
          logicalCount: Number(list.get('logicalCount') ?? list.get('count') ?? 0) + 1,
          updatedAtMillis: now,
        });
      }
      if (seriesRef && series) {
        const last = Number(latest?.docs[0]?.get('position') ?? 0);
        tx.create(seriesRef.collection('seriesItems').doc(sermonId), {
          id: sermonId,
          position: last + 1,
          publishedToSubsplash: false,
          sermonSubsplashId: null,
          addedAt: new Date(now),
          _durableMembershipJobId: ref.jobId,
        });
        tx.update(seriesRef, { itemCount: Number(series.get('itemCount') ?? 0) + 1, updatedAt: new Date(now) });
      }
      tx.create(db.collection('durableUploadSessions').doc(ref.jobId), {
        actorUid,
        projectId: ref.projectId,
        sermonId,
        state: sourceUpload ? 'awaiting_source' : 'ready',
        createdAt: now,
        payload,
        ...(sourceUpload ? { sourceUpload } : {}),
      });
    },
  };
}
export async function verifyUploadObject(
  bucket: Bucket,
  session: { actorUid: string; sourceUpload: NonNullable<DurableAdmissionReceipt['sourceUpload']> },
  jobId: string,
  resolution: Record<string, unknown>
): Promise<string> {
  if (
    resolution.storagePath !== session.sourceUpload.storagePath ||
    typeof resolution.generation !== 'string' ||
    !/^[0-9]+$/.test(resolution.generation)
  )
    throw new HttpsError('failed-precondition', 'Upload source does not match this job.');
  const [metadata] = await bucket
    .file(session.sourceUpload.storagePath, { generation: resolution.generation })
    .getMetadata();
  const expected = session.sourceUpload.expectedFile;
  let fingerprint: unknown;
  try {
    fingerprint = JSON.parse(String(metadata.metadata?.fingerprint ?? 'null'));
  } catch {
    fingerprint = null;
  }
  if (
    String(metadata.generation) !== resolution.generation ||
    Number(metadata.size) !== expected.size ||
    metadata.metadata?.durableJobId !== jobId ||
    JSON.stringify(fingerprint) !== JSON.stringify(expected.fingerprint)
  )
    throw new HttpsError('failed-precondition', 'Uploaded bytes do not match the reserved source.');
  return resolution.generation;
}
