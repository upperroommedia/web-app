import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { writeMediaUploadIntent } from '@upperroom/orchestration/media-artifacts';
import {
  claimNativeYouTubeRender,
  recordOwnedYouTubeRenderCandidate,
} from '../../../process-audio/src/temporal/hetzner-render-claim';
import { readPreparedYouTubeEpisodeInTransaction } from '../../../process-audio/src/temporal/hetzner-acquisition-episode';
import { inspectNativeYouTubeProcess } from '../../../process-audio/src/temporal/hetzner-acquisition-identity';
import { readEligibleYouTubeAcquisition } from '../../../process-audio/src/temporal/hetzner-acquisition-policy';
import { youtubeAcquisitionId } from '../../../process-audio/src/temporal/hetzner-acquisition';

jest.mock('@upperroom/orchestration/media-artifacts', () => ({ writeMediaUploadIntent: jest.fn() }));
jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-store', () => ({
  assertStagingAcquisitionDatabase: jest.fn(),
}));
jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-episode', () => ({
  readPreparedYouTubeEpisodeInTransaction: jest.fn(),
}));
jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-identity', () => ({
  inspectNativeYouTubeProcess: jest.fn(),
}));
jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-policy', () => ({
  readEligibleYouTubeAcquisition: jest.fn(),
}));

test('a committed render claim with a lost acknowledgement never issues a second launch', async () => {
  const ref = {
    projectId: 'urm-app-staging',
    sermonId: 'sermon',
    jobId: 'job',
    requestVersion: '0123456789abcdef',
    revision: 1,
  };
  const episodeId = '00000000-0000-4000-8000-000000000001';
  const processId = process.pid + 1;
  let committed = false;
  const execution = {
    get: () => (committed ? episodeId : undefined),
    ref: { collection: () => ({ doc: () => 'dispatch' }) },
  };
  const stamp = { isEqual: (other: unknown) => other === stamp };
  const tx = {
    get: async (key: string) => ({
      exists: true,
      createTime: stamp,
      updateTime: stamp,
      data: () =>
        key === 'slot'
          ? { operationId: youtubeAcquisitionId(ref), episodeId, authenticationId: null }
          : { schemaVersion: 1, ref, episodeId },
    }),
    create: jest.fn(),
    update: jest.fn(),
  };
  const firestore = {
    collection: () => ({ doc: () => 'slot' }),
    runTransaction: async (run: (value: typeof tx) => Promise<unknown>) => {
      const result = await run(tx);
      if (!committed) {
        committed = true;
        throw new Error('fixture commit ACK lost');
      }
      return result;
    },
  } as unknown as Firestore;
  jest.mocked(readPreparedYouTubeEpisodeInTransaction).mockResolvedValue({
    episode: { id: episodeId, operationId: youtubeAcquisitionId(ref), createdAt: 1 },
    execution,
    root: { get: () => undefined },
  } as unknown as Awaited<ReturnType<typeof readPreparedYouTubeEpisodeInTransaction>>);
  jest.mocked(inspectNativeYouTubeProcess).mockResolvedValue({
    bootId: '00000000-0000-4000-8000-000000000002',
    processId,
    pidNamespace: 'pid:[1]',
    buildId: 'a'.repeat(40),
    startTicks: '10',
  });
  jest.mocked(readEligibleYouTubeAcquisition).mockResolvedValue({
    kind: 'ready',
    payload: { introUrl: 'https://fixture.invalid/intro.mp3' },
  } as unknown as Awaited<ReturnType<typeof readEligibleYouTubeAcquisition>>);
  const options = {
    firestore,
    ref,
    episodeId,
    processId,
    buildId: 'a'.repeat(40),
    auth: {} as Auth,
    verifiedCallerEmail: 'fixture',
    assertFresh: jest.fn(),
  };
  await expect(claimNativeYouTubeRender(options)).rejects.toThrow('fixture commit ACK lost');
  await expect(claimNativeYouTubeRender(options)).resolves.toEqual({ launch: false });
  expect(tx.create).toHaveBeenCalledTimes(1);
  expect(tx.update).toHaveBeenCalledWith(execution.ref, { renderClaim: episodeId });
  expect(writeMediaUploadIntent).toHaveBeenCalledTimes(3);
});

test('a concurrent stop or lost slot authority prevents recording the result of an already-running child', async () => {
  const episodeId = '00000000-0000-4000-8000-000000000001';
  const ref = {
    projectId: 'urm-app-staging',
    sermonId: 'sermon',
    jobId: 'job',
    requestVersion: '0123456789abcdef',
    revision: 1,
  };
  const claim = { owner: { processId: 1 }, startedAt: 10 };
  const stamp = { isEqual: (other: unknown) => other === stamp };
  let stopped = false,
    owned = true;
  jest.mocked(readPreparedYouTubeEpisodeInTransaction).mockResolvedValue({
    episode: { id: episodeId },
    root: { get: (key: string) => key === 'renderStopped' && stopped },
    execution: { get: () => episodeId, ref: { collection: () => ({ doc: (name: string) => name }) } },
  } as unknown as Awaited<ReturnType<typeof readPreparedYouTubeEpisodeInTransaction>>);
  const tx = {
    get: async (key: string) => ({
      exists: true,
      createTime: stamp,
      updateTime: stamp,
      data: () =>
        key === 'claim'
          ? claim
          : owned
          ? { operationId: youtubeAcquisitionId(ref), episodeId, authenticationId: null }
          : undefined,
    }),
    create: jest.fn(),
  };
  const options = {
    firestore: {
      runTransaction: (run: (tx: unknown) => unknown) => run(tx),
      collection: () => ({ doc: () => 'slot' }),
    } as unknown as Firestore,
    auth: {} as Auth,
    ref,
    episodeId,
    verifiedCallerEmail: 'fixture',
    claim,
    candidate: { providerOutcome: 'waiting_auth' } as const,
    signal: new AbortController().signal,
  };
  jest
    .mocked(readEligibleYouTubeAcquisition)
    .mockResolvedValue({ kind: 'ready' } as Awaited<ReturnType<typeof readEligibleYouTubeAcquisition>>);
  stopped = true;
  await expect(recordOwnedYouTubeRenderCandidate(options)).rejects.toThrow('YOUTUBE_RENDER_CLAIM_UNCONFIRMED');
  stopped = false;
  owned = false;
  await expect(recordOwnedYouTubeRenderCandidate(options)).rejects.toThrow(
    'YOUTUBE_RENDER_HOST_RESERVATION_UNCONFIRMED'
  );
  expect(tx.create).not.toHaveBeenCalled();
  owned = true;
  await recordOwnedYouTubeRenderCandidate(options);
  expect(tx.create).toHaveBeenCalledWith('candidate', {
    schemaVersion: 1,
    ref,
    episodeId,
    ...claim,
    providerOutcome: 'waiting_auth',
  });
});
