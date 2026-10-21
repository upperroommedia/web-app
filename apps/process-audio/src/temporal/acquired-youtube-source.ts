import { assertReleasedYouTubeEpisode, readAcquisitionExecution } from './hetzner-acquisition-episode';
import { isDeepStrictEqual as same } from 'node:util';
import { stat } from 'node:fs/promises';
import type { Bucket } from '@google-cloud/storage';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { ApplicationFailure } from '@temporalio/common';
import { MEDIA_ARTIFACTS, mediaArtifactId, prepareMediaReference } from '@upperroom/orchestration/media-artifacts';
import { validateAcquiredYouTubeSource, youtubeAcquisitionId, type AcquiredYouTubeSource } from './hetzner-acquisition';
import {
  YOUTUBE_ACQUISITIONS,
  validateYouTubeAcquisitionSourceReceipt,
  validateYouTubeAcquisitionNativeClose,
} from './hetzner-acquisition-store';
import { downloadMediaStream } from './native';
import type { MediaJobRef } from './types';
const fail = (): never => {
  throw ApplicationFailure.nonRetryable('Acquired media source cannot be verified.', 'INVALID_MEDIA_ARTIFACT');
};
/** Consume the host's existing immutable object. No copy or second upload.
 * Host receipts are inputs; current object bytes and native media duration are
 * independently checked before the real Activity's canonical transaction. */
export async function consumeAcquiredYouTubeSource(o: {
  db: Firestore;
  bucket: Bucket;
  ref: MediaJobRef;
  source: AcquiredYouTubeSource;
  destination: string;
  signal: AbortSignal;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
}) {
  const ref = Object.freeze({ ...o.ref }),
    source = validateAcquiredYouTubeSource(ref, o.source),
    operationId = youtubeAcquisitionId(ref);
  const attempt = /\/source-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.bin$/.exec(
    source.path
  )?.[1];
  if (!attempt) fail();
  const current = async () => {
    o.signal.throwIfAborted();
    const [m] = await o.bucket.file(source.path).getMetadata();
    o.signal.throwIfAborted();
    if (
      m.bucket !== o.bucket.name ||
      m.name !== source.path ||
      m.generation !== source.generation ||
      String(m.size) !== String(source.bytes) ||
      m.crc32c !== source.crc32c ||
      m.metadata?.jobId !== ref.jobId ||
      m.metadata?.requestVersion !== ref.requestVersion ||
      m.metadata?.operationId !== operationId ||
      m.metadata?.attemptId !== attempt
    )
      fail();
  };
  await current();
  await downloadMediaStream(
    o.bucket.file(source.path, { generation: source.generation }).createReadStream({ validation: 'crc32c' }),
    o.destination,
    o.signal,
    source.bytes
  );
  o.signal.throwIfAborted();
  if ((await stat(o.destination)).size !== source.bytes) fail();
  return async (duration: number) => {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) fail();
    await current();
    const artifact = { path: source.path, generation: source.generation, duration };
    await o.db.runTransaction(async (tx) => {
      o.signal.throwIfAborted();
      const requestRef = o.db.doc(`temporalMediaRequests/${ref.jobId}`),
        hostRef = o.db.doc(`${YOUTUBE_ACQUISITIONS}/${operationId}`),
        assetRef = o.db.doc(`${MEDIA_ARTIFACTS}/${mediaArtifactId(ref.projectId, source.path)}`);
      const delegation = await tx.get(hostRef);
      const host = await readAcquisitionExecution(tx, delegation);
      const [request, upload, asset, close] = await Promise.all([
        tx.get(requestRef),
        tx.get(host.ref.collection('uploads').doc(attempt!)),
        tx.get(assetRef),
        tx.get(host.ref.collection('nativeClose').doc('original')),
      ]);
      if (!close.exists || !close.createTime?.isEqual(close.updateTime!)) fail();
      validateYouTubeAcquisitionNativeClose(host.data(), ref, close.data());
      await assertReleasedYouTubeEpisode(tx, host);
      const owner = validateYouTubeAcquisitionSourceReceipt(host.data(), ref, source);
      await o.assertCurrent(tx, ref);
      o.signal.throwIfAborted();
      if (
        !same(request.get('ref'), ref) ||
        host.get('operationId') !== operationId ||
        !same(host.get('ref'), ref) ||
        host.get('status') !== 'source' ||
        host.get('result.kind') !== 'source' ||
        !same(validateAcquiredYouTubeSource(ref, host.get('result.artifact')), source) ||
        host.get('activeUpload') !== attempt ||
        upload.get('state') !== 'retained' ||
        !same(validateAcquiredYouTubeSource(ref, upload.get('receipt')), source) ||
        !same(owner, upload.get('owner')) ||
        !asset.exists ||
        asset.get('projectId') !== ref.projectId ||
        asset.get('ownerJobId') !== ref.jobId ||
        asset.get('sermonId') !== ref.sermonId ||
        asset.get('path') !== source.path ||
        !['uploading', 'retained'].includes(asset.get('status')) ||
        (asset.get('generation') !== null && asset.get('generation') !== source.generation)
      )
        fail();
      const existing = request.get('artifacts.source');
      if (existing !== undefined) {
        if (
          existing.path !== artifact.path ||
          existing.generation !== artifact.generation ||
          !Number.isFinite(existing.duration) ||
          Math.abs(existing.duration - duration) > 0.001
        )
          fail();
        return;
      }
      const attach = await prepareMediaReference(tx, o.db, {
        artifactId: assetRef.id,
        projectId: ref.projectId,
        type: 'media_job',
        id: ref.jobId,
        createdAt: Date.now(),
      });
      o.signal.throwIfAborted();
      tx.update(assetRef, { generation: source.generation, status: 'retained' });
      tx.update(requestRef, { 'artifacts.source': artifact });
      attach();
    });
  };
}
