import { executeRenderAuthentication } from './hetzner-render-auth-driver';
import { readPreparedRenderAuthentication } from './hetzner-render-authentication';
import { executeCanonicalYouTubeRender } from './hetzner-render-driver';
import { readYouTubeRenderReceipt } from './hetzner-render-receipt';
import { assertReleasedYouTubeEpisode, readAcquisitionExecution } from './hetzner-acquisition-episode';
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
  validateYouTubeAcquisitionSourceReceipt,
  validateYouTubeAcquisitionNativeClose,
  YOUTUBE_ACQUISITIONS,
} from './hetzner-acquisition-store';
import type { MediaJobRef } from './types';

import {
  readYouTubeRenderHeadTarget,
  readYouTubeRenderTarget,
  stagingYouTubeRenderOrigins,
  type YouTubeRenderTarget,
} from './youtube-render-target';
const unavailable = () => new Error('YOUTUBE_ACQUISITION_UNAVAILABLE');
/** Render mutations require explicit staging activation. The earlier
 * acquisition-only path retains its separate resource gate. GET only observes. */
export function createHetznerAcquisitionRouter(o: {
  firestore: Firestore;
  auth: Auth;
  bucket: Bucket;
  renderEnabled: boolean;
  renderTarget?: YouTubeRenderTarget;
  runtimeId?: string;
}) {
  const renderTarget = readYouTubeRenderTarget(o.renderTarget);
  const origin = stagingYouTubeRenderOrigins[renderTarget];
  const router = Router();
  router.all(
    ['/:operationId/render/:episodeId', '/:operationId/render/authentication/:authenticationId'],
    async (request, response) => {
      if (o.auth.app.options.projectId !== 'urm-app-staging' || !o.renderEnabled) {
        response.status(404).json({ error: 'Unavailable.' });
        return;
      }
      const { operationId } = request.params;
      const { authenticationId, episodeId } = request.params as Record<string, string | undefined>;
      if (renderTarget === 'moses' && authenticationId !== undefined) {
        response.status(404).json({ error: 'Unavailable.' });
        return;
      }
      const attemptId = authenticationId ?? episodeId;
      if (
        typeof operationId !== 'string' ||
        !/^ytacq-[a-f0-9]{64}$/.test(operationId) ||
        typeof attemptId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(attemptId) ||
        Object.keys(request.query).length ||
        !['GET', 'POST'].includes(request.method)
      ) {
        response.status(400).json({ error: 'Invalid render request.' });
        return;
      }
      const birth = new AbortController();
      const disconnect = () => birth.abort();
      response.once('close', disconnect);
      const wall = Date.now(),
        mono = performance.now();
      const fresh = () => {
        birth.signal.throwIfAborted();
        if (Date.now() < wall || Date.now() - wall >= 5000 || performance.now() - mono >= 5000) throw unavailable();
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = async () => {
        assertStagingAcquisitionDatabase(o.firestore);
        if (o.bucket.name !== 'urm-app-staging.firebasestorage.app') throw unavailable();
        const original = await o.firestore.doc(`${YOUTUBE_ACQUISITIONS}/${operationId}`).get();
        if (readYouTubeRenderHeadTarget(original) !== renderTarget) throw unavailable();
        const ref = original.get('ref') as MediaJobRef;
        if (youtubeAcquisitionId(ref) !== operationId) throw unavailable();
        const delegation = readYouTubeAcquisitionOperation(original.data(), ref);
        const verifiedCallerEmail = delegation.preparedBy.serviceAccount;
        await authenticateNativeMediaCaller(request.headers.authorization, {
          audiences: [origin],
          serviceAccountEmails: [verifiedCallerEmail],
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
          let started!: (value: 'running') => void;
          const acknowledged = new Promise<'running'>((resolve) => {
            started = resolve;
          });
          const options = {
            ...o,
            ref,
            verifiedCallerEmail,
            startSignal: birth.signal,
            assertStartFresh: fresh,
            onStarted: () => started('running'),
          };
          const execution = (
            authenticationId
              ? executeRenderAuthentication({ ...options, id: authenticationId })
              : executeCanonicalYouTubeRender({ ...options, episodeId: attemptId })
          ).then((kind) => (kind === 'already-claimed' ? ('running' as const) : kind));
          // The original parent retains the running execution after an IPC ACK.
          // A close failure stays unresolved in the journal and never becomes a new grant.
          const status = await Promise.race([acknowledged, execution]);
          if (status !== 'running') throw unavailable();
          return { status, operationId };
        }
        if (request.body !== undefined && Object.keys(request.body).length) throw unavailable();
        if (authenticationId) {
          const status = await o.firestore.runTransaction(
            async (tx) => {
              const { intent, completion } = await readPreparedRenderAuthentication(tx, {
                ...o,
                ref,
                verifiedCallerEmail,
                id: authenticationId,
              });
              if (completion.exists) return completion.get('status') as 'ready' | 'failed';
              return (await tx.get(intent.ref.collection('facts').doc('claim'))).exists ? 'running' : 'missing';
            },
            { maxAttempts: 1 }
          );
          return { status, operationId };
        }
        const receipt = await o.firestore.runTransaction(
          (tx) => readYouTubeRenderReceipt(tx, { ...o, ref, verifiedCallerEmail, episodeId: attemptId }),
          { maxAttempts: 1 }
        );
        return { status: receipt.kind, operationId };
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
        response.json(result);
      } catch {
        if (!response.headersSent) response.status(503).json({ error: 'Render readback is unavailable.' });
      } finally {
        if (timer) clearTimeout(timer);
        response.removeListener('close', disconnect);
        birth.abort();
      }
    }
  );
  router.all('/:operationId', async (request, response) => {
    if (o.auth.app.options.projectId !== 'urm-app-staging' || renderTarget !== 'hetzner') {
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
      if (readYouTubeRenderHeadTarget(original) !== renderTarget) throw unavailable();
      const ref = original.get('ref') as MediaJobRef;
      if (youtubeAcquisitionId(ref) !== operationId) throw unavailable();
      const initial = readYouTubeAcquisitionOperation(original.data(), ref);
      await authenticateNativeMediaCaller(request.headers.authorization, {
        audiences: [origin],
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
          birthDeadline: { wall, monotonic: mono },
        });
        return undefined;
      }
      if (request.body !== undefined && Object.keys(request.body).length) throw unavailable();
      let originalExecution: DocumentSnapshot | undefined;
      const inspect = async () =>
        o.firestore.runTransaction(async (tx) => {
          const current = await tx.get(target);
          fresh();
          if (!sameStamp(original, current)) throw unavailable();
          const execution = await readAcquisitionExecution(tx, current);
          if (originalExecution && !sameStamp(originalExecution, execution)) throw unavailable();
          originalExecution ??= execution;
          const record = readYouTubeAcquisitionOperation(execution.data(), ref);
          if (record.unclaimedClose !== undefined) throw unavailable();
          const eligibility = await readEligibleYouTubeAcquisition({
            firestore: o.firestore,
            auth: o.auth,
            transaction: tx,
            ref,
          });
          fresh();
          if (record.nativeClose) {
            const saved = await tx.get(execution.ref.collection('nativeClose').doc('original'));
            fresh();
            if (!saved.exists || !saved.createTime?.isEqual(saved.updateTime!)) throw unavailable();
            validateYouTubeAcquisitionNativeClose(record, ref, saved.data());
            await assertReleasedYouTubeEpisode(tx, execution);
          }
          // A canonical stop/source is not a remote process-drain proof.
          if (eligibility.kind !== 'ready') throw unavailable();
          return record;
        });
      const current = await inspect();
      fresh();
      if (current.status === 'source') {
        if (current.result?.kind !== 'source') throw unavailable();
        // Helper settlement precedes helper exit; it is not parent CLOSE proof.
        // Never expose an artifact until the original parent confirmed its drain.
        if (!current.nativeClose) return { status: 'running', operationId };
        validateYouTubeAcquisitionSourceReceipt(current, ref, current.result.artifact);
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
      const status =
        current.status === 'prepared'
          ? 'missing'
          : current.status === 'running' || !current.nativeClose
          ? 'running'
          : current.status;
      if (current.nativeClose && current.nativeClose.outcome !== 'completed') throw unavailable();
      return { status, operationId };
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
