import { executeCanonicalYouTubeAcquisition } from './hetzner-acquisition-driver';
import { Router } from 'express';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore, DocumentSnapshot } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import { authenticateNativeMediaCaller } from '../legacyMediaIngress';
import { youtubeAcquisitionId, validateAcquiredYouTubeSource } from './hetzner-acquisition';
import { readEligibleYouTubeAcquisition } from './hetzner-acquisition-policy';
import {
  assertStagingAcquisitionDatabase,
  readYouTubeAcquisitionOperation,
  YOUTUBE_ACQUISITIONS,
} from './hetzner-acquisition-store';
import type { MediaJobRef } from './types';

const ORIGIN = 'https://yt-worker-staging.upperroommedia.org';
const unavailable = () => new Error('YOUTUBE_ACQUISITION_UNAVAILABLE');
/** Actual host readback, not a producer. The mutation endpoint stays denied until
 * shared legacy/native resource admission, helper bootstrap and drain are proven.
 * In particular GET never claims work, renews authority or launches a process. */
export function createHetznerAcquisitionRouter(o: { firestore: Firestore; auth: Auth; bucket: Bucket }) {
  const router = Router();
  router.all('/:operationId', async (request, response) => {
    if (o.auth.app.options.projectId !== 'urm-app-staging') {
      response.status(404).json({ error: 'Unavailable.' });
      return;
    }
    const operationId = request.params.operationId;
    if (
      !/^ytacq-[a-f0-9]{64}$/.test(operationId) ||
      Object.keys(request.query).length ||
      !['GET', 'POST'].includes(request.method)
    ) {
      response.status(400).json({ error: 'Invalid acquisition request.' });
      return;
    }
    const wall = Date.now(),
      mono = performance.now();
    const birth = new AbortController();
    const disconnected = () => birth.abort();
    response.once('close', disconnected);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fresh = () => {
      if (Date.now() - wall > 5000 || Date.now() < wall || performance.now() - mono > 5000) throw unavailable();
    };
    const work = async () => {
      assertStagingAcquisitionDatabase(o.firestore);
      if (o.bucket.name !== 'urm-app-staging.firebasestorage.app') throw unavailable();
      const target = o.firestore.doc(`${YOUTUBE_ACQUISITIONS}/${operationId}`);
      const original = await target.get();
      fresh();
      const ref = original.get('ref') as MediaJobRef;
      if (youtubeAcquisitionId(ref) !== operationId) throw unavailable();
      const initial = readYouTubeAcquisitionOperation(original.data(), ref);
      await authenticateNativeMediaCaller(request.headers.authorization, {
        audiences: [ORIGIN],
        serviceAccountEmails: [initial.preparedBy.serviceAccount],
      });
      fresh();
      if (request.method === 'POST') {
        if (
          !request.body ||
          Object.keys(request.body).sort().join(',') !== 'operationId,ref' ||
          request.body.operationId !== operationId ||
          youtubeAcquisitionId(request.body.ref) !== operationId
        )
          throw unavailable();
        // This reaches the canonical fixed resource gate, which remains denied.
        // No HTTP body can supply an authorization flag or helper executable.
        await executeCanonicalYouTubeAcquisition({
          firestore: o.firestore,
          auth: o.auth,
          ref,
          verifiedCallerEmail: initial.preparedBy.serviceAccount,
          startSignal: birth.signal,
        });
        return undefined;
      }
      if (request.body !== undefined && Object.keys(request.body).length) throw unavailable();
      const inspect = async () =>
        o.firestore.runTransaction(async (tx) => {
          const current = await tx.get(target);
          fresh();
          if (!sameStamp(original, current)) throw unavailable();
          const record = readYouTubeAcquisitionOperation(current.data(), ref);
          const eligibility = await readEligibleYouTubeAcquisition({
            firestore: o.firestore,
            auth: o.auth,
            transaction: tx,
            ref,
          });
          fresh();
          // A canonical stop/source is not a remote process-drain proof.
          if (eligibility.kind !== 'ready') throw unavailable();
          return record;
        });
      const current = await inspect();
      fresh();
      if (current.status === 'source') {
        if (current.result?.kind !== 'source') throw unavailable();
        const artifact = validateAcquiredYouTubeSource(ref, current.result.artifact);
        const [metadata] = await o.bucket.file(artifact.path).getMetadata();
        fresh();
        if (
          metadata.name !== artifact.path ||
          metadata.bucket !== o.bucket.name ||
          metadata.generation !== artifact.generation ||
          Number(metadata.size) !== artifact.bytes ||
          metadata.crc32c !== artifact.crc32c ||
          metadata.metadata?.jobId !== ref.jobId ||
          metadata.metadata?.requestVersion !== ref.requestVersion ||
          metadata.metadata?.operationId !== operationId
        )
          throw unavailable();
        await inspect();
        fresh();
        return { status: 'ready', operationId, artifact };
      }
      await inspect();
      fresh();
      return { status: current.status === 'prepared' ? 'missing' : current.status, operationId };
    };
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            birth.abort();
            reject(unavailable());
          }, 5000);
        }),
      ]);
      fresh();
      if (!result) response.status(503).json({ error: 'Acquisition execution is not enabled.' });
      else response.json(result);
    } catch {
      if (!response.headersSent) response.status(503).json({ error: 'Acquisition readback is unavailable.' });
    } finally {
      if (timer) clearTimeout(timer);
      response.removeListener('close', disconnected);
      birth.abort();
    }
  });
  return router;
}
function sameStamp(a: DocumentSnapshot, b: DocumentSnapshot): boolean {
  return (
    a.exists &&
    b.exists &&
    !!a.createTime &&
    !!b.createTime &&
    !!a.updateTime &&
    !!b.updateTime &&
    a.createTime.isEqual(b.createTime) &&
    a.updateTime.isEqual(b.updateTime)
  );
}
