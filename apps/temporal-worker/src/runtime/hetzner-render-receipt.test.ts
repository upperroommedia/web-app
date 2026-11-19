import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { readPreparedYouTubeEpisodeInTransaction } from '../../../process-audio/src/temporal/hetzner-acquisition-episode';
import type { Bucket } from '@google-cloud/storage';
import {
  adoptYouTubeRender,
  readYouTubeRenderReceipt,
} from '../../../process-audio/src/temporal/hetzner-render-receipt';
import { youtubeRenderOutput } from '../../../process-audio/src/temporal/hetzner-render-output';

jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-episode', () => ({
  readPreparedYouTubeEpisodeInTransaction: jest.fn(),
}));

const ref = {
  projectId: 'urm-app-staging',
  sermonId: 'sermon',
  jobId: 'job',
  requestVersion: '0123456789abcdef',
  revision: 1,
};
const episodeId = '00000000-0000-4000-8000-000000000001';
const output = youtubeRenderOutput(ref, episodeId);
const owner = { processId: 12, startTicks: '1' };
const identity = { schemaVersion: 1, ref, episodeId, owner, startedAt: 2 };
const audio = { path: output.processed, bytes: 128, crc32c: 'AAAAAA==', generation: '12', duration: 30 };

const source = { ...audio, path: output.source, duration: 180 };

function receiptFixture(
  mode:
    | 'pending'
    | 'valid'
    | 'different-candidate'
    | 'foreign-owner'
    | 'archive'
    | 'mixed'
    | 'never-claimed'
    | 'unclaimed-ipc',
  stopped: () => boolean = () => false
) {
  const neverClaimed = mode === 'never-claimed' || mode === 'unclaimed-ipc';
  const snapshot = (data: Record<string, unknown> | undefined, revision: number) => {
    const stamp = { revision, isEqual: (other?: { revision: number }) => other?.revision === revision };
    return {
      exists: !!data,
      get: (key: string) =>
        key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], data),
      createTime: stamp,
      updateTime: stamp,
    };
  };
  const candidate = snapshot(
    {
      ...identity,
      ...(mode !== 'archive' ? { source, processed: audio, final: audio } : {}),
      ...(mode === 'archive' || mode === 'mixed' ? { providerOutcome: 'waiting_archive' } : {}),
    },
    1
  );
  const tx = {
    get: async (name: string) => {
      if (neverClaimed)
        return snapshot(
          name === 'close'
            ? {
                ...identity,
                close: { processId: owner.processId, closedAt: 3, outcome: 'failed' },
                ipcAttempted: mode === 'unclaimed-ipc',
                neverClaimed: true,
                candidateVersion: null,
              }
            : undefined,
          2
        );
      if (name === 'claim')
        return snapshot(
          {
            ...identity,
            operationId: output.metadata.operationId,
            sourcePath: output.source,
            processedPath: output.processed,
            mergedPath: null,
          },
          1
        );
      if (name === 'candidate') return candidate;
      return snapshot(
        mode === 'pending'
          ? undefined
          : {
              ...identity,
              owner: mode === 'foreign-owner' ? { processId: 18 } : owner,
              close: { processId: 12, closedAt: 3, exitCode: 0, exitSignal: null, outcome: 'completed' },
              ipcAttempted: true,
              candidateVersion: mode === 'different-candidate' ? { revision: 2 } : candidate.updateTime,
            },
        2
      );
    },
  } as unknown as Transaction;
  jest.mocked(readPreparedYouTubeEpisodeInTransaction).mockResolvedValue({
    episode: { id: episodeId, operationId: output.metadata.operationId, createdAt: 1 },
    root: { get: (key: string) => key === 'renderStopped' && stopped() },
    execution: {
      get: () => (neverClaimed ? undefined : episodeId),
      ref: { collection: () => ({ doc: (name: string) => name }) },
    },
  } as unknown as Awaited<ReturnType<typeof readPreparedYouTubeEpisodeInTransaction>>);
  return tx;
}

function fixture(mode: Parameters<typeof receiptFixture>[0], expectedEpisodeId = episodeId) {
  return readYouTubeRenderReceipt(receiptFixture(mode), {
    firestore: {} as Firestore,
    ref,
    verifiedCallerEmail: 'fixture',
    episodeId: expectedEpisodeId,
  });
}

test('candidate stays pending until original parent closure', async () => {
  await expect(fixture('pending')).resolves.toEqual({ kind: 'running' });
});
test('only the selected candidate from the original execution becomes readable', async () => {
  await expect(fixture('valid')).resolves.toEqual({
    kind: 'rendered',
    episodeId,
    merged: false,
    source,
    processed: audio,
    final: audio,
  });
});
test('the drained provider outcome remains distinct from publishable audio', async () => {
  await expect(fixture('archive')).resolves.toEqual({ kind: 'waiting_archive', episodeId });
});
test.each(['different-candidate', 'foreign-owner', 'mixed'] as const)('rejects %s', async (mode) => {
  await expect(fixture(mode)).rejects.toThrow('YOUTUBE_RENDER_RECEIPT_UNCONFIRMED');
});

test('an observation from a previous episode cannot see the successor receipt', async () => {
  await expect(fixture('valid', '00000000-0000-4000-8000-000000000002')).rejects.toThrow(
    'YOUTUBE_RENDER_RECEIPT_UNCONFIRMED'
  );
});

test('only an immutable never-IPC closure makes an unclaimed render terminal', async () => {
  await expect(fixture('never-claimed')).resolves.toEqual({ kind: 'failed' });
  await expect(fixture('unclaimed-ipc')).rejects.toThrow('YOUTUBE_RENDER_RECEIPT_UNCONFIRMED');
});

test('adoption rechecks the stop fence after Storage verification, with original closure still observable', async () => {
  let stopped = false;
  const tx = receiptFixture('valid', () => stopped);
  let transactions = 0;
  const firestore = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    runTransaction: async (run: (tx: Transaction) => Promise<unknown>) => {
      transactions++;
      return run(tx);
    },
  } as unknown as Firestore;
  const getMetadata = jest.fn(async (path: string) => {
    stopped = true;
    return [
      {
        bucket: 'urm-app-staging.firebasestorage.app',
        name: path,
        size: audio.bytes,
        generation: audio.generation,
        crc32c: audio.crc32c,
        metadata: output.metadata,
        contentType: path === source.path ? 'application/octet-stream' : 'audio/mpeg',
      },
    ];
  });
  const file = jest.fn((path: string) => ({ getMetadata: () => getMetadata(path) }));
  const bucket = { name: 'urm-app-staging.firebasestorage.app', file } as unknown as Bucket;
  const options = {
    firestore,
    bucket,
    ref,
    episodeId,
    verifiedCallerEmail: 'fixture',
    signal: new AbortController().signal,
    assertCurrent: jest.fn(),
  };
  await expect(adoptYouTubeRender(options)).rejects.toThrow('YOUTUBE_RENDER_RECEIPT_UNCONFIRMED');
  expect(transactions).toBe(2);
  expect(getMetadata).toHaveBeenCalledTimes(2);
  expect(file.mock.calls).toEqual([
    [source.path, { generation: source.generation }],
    [audio.path, { generation: audio.generation }],
  ]);
  expect(options.assertCurrent).not.toHaveBeenCalled();
  await expect(readYouTubeRenderReceipt(tx, options)).resolves.toMatchObject({ kind: 'rendered', episodeId });
});
