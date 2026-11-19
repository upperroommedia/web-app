import {
  reserveYouTubeRenderDispatch,
  retainedYouTubeRenderSlot,
  youtubeRenderSlot,
} from '../../../process-audio/src/temporal/hetzner-render-slot';
import { awaitYouTubeRenderDrain } from '../../../process-audio/src/temporal/hetzner-render-drain';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { Bucket } from '@google-cloud/storage';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { WorkerWitness } from './worker-witness';
import type { MediaJobRef, MediaArchiveWait } from '../../../process-audio/src/temporal/types';
import {
  createHetznerAcquisitionClient,
  createHetznerAcquisitionTransport,
} from '../../../process-audio/src/temporal/hetzner-acquisition';
import {
  prepareNativeYouTubeEpisode,
  recordNativeYouTubeArchiveWait,
  recordNativeYouTubeRenderArchiveWait,
  readPreparedYouTubeEpisodeInTransaction,
} from '../../../process-audio/src/temporal/hetzner-acquisition-episode';
import { waitForYouTubeRender } from '../../../process-audio/src/temporal/hetzner-render-client';
import { adoptYouTubeRender } from '../../../process-audio/src/temporal/hetzner-render-receipt';
import {
  authorizeRenderAuthenticationDispatch,
  prepareRenderAuthentication,
  readReadyRenderAuthentication,
} from '../../../process-audio/src/temporal/hetzner-render-authentication';
const fail = (): never => {
  throw ApplicationFailure.nonRetryable(
    'YouTube acquisition binding is unavailable.',
    'YOUTUBE_ACQUISITION_BINDING_REQUIRED'
  );
};
interface RuntimeYouTubeBinding {
  projectId: string;
  firestore: Firestore;
  witness?: WorkerWitness;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
}

function runtimeBinding(o: RuntimeYouTubeBinding, expected: 'hetzner-v1' | 'hetzner-render-v1') {
  const mode = process.env.TEMPORAL_MEDIA_YOUTUBE_ACQUISITION;
  if (mode === undefined) return undefined;
  if (
    (mode !== 'hetzner-v1' && mode !== 'hetzner-render-v1') ||
    o.projectId !== 'urm-app-staging' ||
    process.env.TEMPORAL_WORKER_HOSTING !== 'cloud-run'
  )
    return fail();
  if (mode !== expected) return undefined;
  return async (
    ref: MediaJobRef,
    signal: AbortSignal,
    archiveResume?: MediaArchiveWait,
    authenticationGeneration?: string
  ) => {
    signal.throwIfAborted();
    const { caller, invocation } = invocationBinding(o, 'acquireMedia');
    const episodeId = await prepareNativeYouTubeEpisode({
      archiveResume,
      ...(expected === 'hetzner-render-v1' ? { render: true as const, authenticationGeneration } : {}),
      invocation,
      firestore: o.firestore,
      ref,
      caller,
      assertCurrent: async (tx, bound) => {
        signal.throwIfAborted();
        await o.assertCurrent(tx, bound);
        signal.throwIfAborted();
      },
    });
    signal.throwIfAborted();
    return { caller, episodeId };
  };
}

function invocationBinding(o: RuntimeYouTubeBinding, type: 'acquireMedia' | 'recoverMediaAuthentication') {
  const w = o.witness,
    cloud = w?.cloudRun;
  if (
    !w ||
    !cloud ||
    cloud.projectId !== o.projectId ||
    cloud.region !== 'us-central1' ||
    cloud.serviceAccount !== `tw-m-${w.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com` ||
    !/^[a-f0-9]{40}$/.test(w.buildId) ||
    !cloud.instanceId
  )
    return fail();
  const info = Context.current().info;
  if (info.activityType !== type || !info.workflowExecution) return fail();
  return {
    caller: { buildId: w.buildId, serviceAccount: cloud.serviceAccount, instanceId: cloud.instanceId },
    invocation: {
      workflowId: info.workflowExecution.workflowId,
      runId: info.workflowExecution.runId,
      activityId: info.activityId,
      attempt: info.attempt,
    },
  };
}

export function createRuntimeYouTubeAcquisition(o: RuntimeYouTubeBinding) {
  const bind = runtimeBinding(o, 'hetzner-v1');
  if (!bind) return undefined;
  let client: ReturnType<typeof createHetznerAcquisitionClient> | undefined;
  return async (ref: MediaJobRef, signal: AbortSignal, archiveResume?: MediaArchiveWait) => {
    await bind(ref, signal, archiveResume);
    client ??= createHetznerAcquisitionClient({
      request: createHetznerAcquisitionTransport(o.projectId),
      heartbeat: () => Context.current().heartbeat({ stage: 'youtube-acquisition' }),
    });
    return client.acquire(ref, signal);
  };
}

async function observeRenderUntilCancelled<T>(
  o: RuntimeYouTubeBinding,
  ref: MediaJobRef,
  signal: AbortSignal,
  wait: () => Promise<T>
) {
  try {
    return await wait();
  } catch (error) {
    if (signal.aborted) {
      const context = Context.current();
      await awaitYouTubeRenderDrain({
        firestore: o.firestore,
        ref,
        stop: true,
        heartbeat: () => context.heartbeat({ stage: 'youtube-render-drain' }),
      });
      signal.throwIfAborted();
    }
    throw error;
  }
}
export function createRuntimeYouTubeRender(o: RuntimeYouTubeBinding & { bucket: Bucket }) {
  const bind = runtimeBinding(o, 'hetzner-render-v1');
  if (!bind) return undefined;
  return async (
    ref: MediaJobRef,
    signal: AbortSignal,
    archiveResume?: MediaArchiveWait,
    authenticationGeneration?: string
  ) => {
    const { caller, episodeId } = await bind(ref, signal, archiveResume, authenticationGeneration);
    const verifiedCallerEmail = caller.serviceAccount;
    const transport = createHetznerAcquisitionTransport(o.projectId, { episodeId });
    const context = Context.current();
    const heartbeat = () => context.heartbeat({ stage: 'youtube-render' });
    const completed = await observeRenderUntilCancelled(o, ref, signal, () =>
      waitForYouTubeRender({
        ref,
        signal,
        request: transport,
        heartbeat,
        authorizeDispatch: () =>
          reserveYouTubeRenderDispatch({
            firestore: o.firestore,
            signal,
            assertCurrent: (tx) => o.assertCurrent(tx, ref),
            read: async (tx) => {
              const { episode, execution, root } = await readPreparedYouTubeEpisodeInTransaction(tx, {
                ...o,
                ref,
                verifiedCallerEmail,
                render: true,
              });
              if (episode.id !== episodeId) return fail();
              return {
                dispatch: await tx.get(execution.ref.collection('render').doc('dispatch')),
                body: { schemaVersion: 1, ref, episodeId: episode.id },
                slot: youtubeRenderSlot(ref, episode.id),
                transferFrom: episode.predecessor?.authenticationGeneration
                  ? retainedYouTubeRenderSlot(ref, episode.predecessor.id, episode.predecessor.authenticationGeneration)
                  : undefined,
                active: root.get('renderStopped') !== true && execution.get('renderClaim') === undefined,
              };
            },
          }),
      })
    );
    if (completed === 'cancelled') return { kind: 'cancelled' } as const;
    const result = await adoptYouTubeRender({ ...o, ref, signal, verifiedCallerEmail, episodeId });
    if (result.kind !== completed) return fail();
    if (result.kind === 'waiting_auth')
      return { kind: 'waiting_auth', recoveryGeneration: null, hostBound: true } as const;
    if (result.kind === 'waiting_archive') return { kind: 'waiting_archive', hostBound: true } as const;
    if (result.kind === 'restricted') return { kind: 'restricted' } as const;
    if (result.kind !== 'rendered') return fail();
    return { kind: 'ready', hostBound: true } as const;
  };
}

export function createRuntimeYouTubeRenderAuthentication(o: RuntimeYouTubeBinding) {
  if (!runtimeBinding(o, 'hetzner-render-v1')) return undefined;
  return async (ref: MediaJobRef) => {
    const context = Context.current(),
      signal = context.cancellationSignal;
    const { caller, invocation } = invocationBinding(o, 'recoverMediaAuthentication');
    const id = await prepareRenderAuthentication({ ...o, ref, caller, invocation, signal });
    const verifiedCallerEmail = caller.serviceAccount;
    const request = createHetznerAcquisitionTransport(o.projectId, { authenticationId: id });
    const completed = await observeRenderUntilCancelled(o, ref, signal, () =>
      waitForYouTubeRender({
        ref,
        signal,
        request,
        authentication: true,
        maxPolls: 65,
        heartbeat: () => context.heartbeat({ stage: 'youtube-authentication' }),
        authorizeDispatch: () => authorizeRenderAuthenticationDispatch({ ...o, ref, id, signal, verifiedCallerEmail }),
      })
    );
    if (completed === 'failed' || completed === 'busy') return { ready: false, generation: null };
    if (completed !== 'ready') return fail();
    const result = await o.firestore.runTransaction(
      async (tx) => {
        const ready = await readReadyRenderAuthentication(tx, { ...o, ref, verifiedCallerEmail });
        await o.assertCurrent(tx, ref);
        signal.throwIfAborted();
        return ready;
      },
      { maxAttempts: 1 }
    );
    if (!result || result.generation !== id) return fail();
    if (!result.retainedSlot) return { ready: false, generation: null };
    return { ready: true, generation: result.generation };
  };
}

/** The existing projection Activity records archive intent before the native
 * Workflow timer. Local/traditional jobs with no remote delegation are unchanged.
 * HTTP and the host cannot call this native projection entrypoint. */
export function createRuntimeYouTubeArchiveWaitRecorder(o: {
  projectId: string;
  firestore: Firestore;
  witness?: WorkerWitness;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
}) {
  if (o.projectId !== 'urm-app-staging') return undefined;
  return async (ref: MediaJobRef, wait: MediaArchiveWait) => {
    const wall = Date.now(),
      mono = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined, context: Context | undefined;
    const fresh = () => {
      if (Date.now() < wall || Date.now() - wall >= 5000 || performance.now() - mono >= 5000)
        throw new Error('ARCHIVE_OBSERVATION_EXPIRED');
    };
    const work = async () => {
      context = Context.current();
      context.cancellationSignal.throwIfAborted();
      const { youtubeAcquisitionId } = await import('../../../process-audio/src/temporal/hetzner-acquisition');
      const root = await o.firestore.doc(`temporalYouTubeAcquisitions/${youtubeAcquisitionId(ref)}`).get();
      fresh();
      if (!root.exists) return;
      context.cancellationSignal.throwIfAborted();
      const info = context.info,
        w = o.witness;
      if (
        !info.workflowExecution ||
        info.activityType !== 'projectMediaWaiting' ||
        !w?.cloudRun ||
        w.cloudRun.projectId !== o.projectId ||
        w.cloudRun.region !== 'us-central1' ||
        !/^[a-f0-9]{40}$/.test(w.buildId)
      )
        return fail();
      const record =
        root.get('renderProtocol') === 1 ? recordNativeYouTubeRenderArchiveWait : recordNativeYouTubeArchiveWait;
      await record({
        firestore: o.firestore,
        ref,
        wait,
        sourceBuildId: w.buildId,
        invocation: {
          workflowId: info.workflowExecution.workflowId,
          runId: info.workflowExecution.runId,
          activityId: info.activityId,
          attempt: info.attempt,
        },
        assertCurrent: async (tx, bound) => {
          fresh();
          context!.cancellationSignal.throwIfAborted();
          await o.assertCurrent(tx, bound);
          fresh();
          context!.cancellationSignal.throwIfAborted();
        },
      });
      fresh();
      context.cancellationSignal.throwIfAborted();
    };
    try {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ARCHIVE_OBSERVATION_EXPIRED')), 5000);
        }),
      ]);
      fresh();
    } catch {
      if (context?.cancellationSignal.aborted) context.cancellationSignal.throwIfAborted();
      throw ApplicationFailure.create({
        message: 'YouTube archive wait cannot be verified.',
        type: 'YOUTUBE_ARCHIVE_WAIT_UNCONFIRMED',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
