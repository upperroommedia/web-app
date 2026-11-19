import { youtubeRenderSlot } from '../../../process-audio/src/temporal/hetzner-render-slot';
import type { Firestore } from 'firebase-admin/firestore';
import { awaitYouTubeRenderDrain } from '../../../process-audio/src/temporal/hetzner-render-drain';

jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-store', () => ({
  YOUTUBE_ACQUISITIONS: 'temporalYouTubeAcquisitions',
  assertStagingAcquisitionDatabase: jest.fn(),
}));
const ref = {
  projectId: 'urm-app-staging',
  jobId: 'job',
  sermonId: 'sermon',
  revision: 1,
  requestVersion: '0123456789abcdef',
};
const owner = { processId: 7, bootId: 'fixture' };
const claim = { ref, episodeId: 'fixture-episode', owner, startedAt: 10 };
const closed = {
  ref,
  episodeId: 'fixture-episode',
  owner,
  close: { processId: 7, closedAt: 20, outcome: 'cancelled', exitCode: null, exitSignal: 'SIGTERM' },
};
function fixture(rows: Record<string, Record<string, unknown>>) {
  const fields: Record<string, unknown> = { renderProtocol: 1, preparedEpisode: claim.episodeId, ref };
  const rootRef = { collection: () => ({ doc: (key: string) => key }) };
  const stamp = { isEqual: (other: unknown) => other === stamp };
  const tx = {
    get: async (key: string) => {
      const data = key === 'root' ? fields : rows[key];
      return {
        exists: !!data,
        createTime: stamp,
        updateTime: stamp,
        get: (field: string) =>
          field.split('.').reduce<unknown>((value, part) => {
            if (!value || typeof value !== 'object') return undefined;
            return (value as Record<string, unknown>)[part];
          }, data),
        ref: key === 'slot' ? key : rootRef,
        data: () => data,
      };
    },
    delete: jest.fn(),
    update: jest.fn((_ref, data: object) => Object.assign(fields, data)),
  };
  const firestore = {
    collection: (name: string) => ({ doc: () => (name === 'temporalYouTubeRenderHosts' ? 'slot' : 'root') }),
    runTransaction: (run: (value: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as Firestore;
  return { firestore, update: tx.update, release: tx.delete };
}

test('cancellation fences new claims and waits for the exact original close', async () => {
  const rows: Record<string, Record<string, unknown>> = { claim, dispatch: {} };
  const { firestore, update } = fixture(rows);
  const input = { firestore, ref, stop: true, polls: 1 };
  await expect(awaitYouTubeRenderDrain(input)).rejects.toMatchObject({ type: 'YOUTUBE_RENDER_DRAIN_PENDING' });
  expect(update).toHaveBeenCalledWith(expect.anything(), { renderStopped: true });
  rows.close = { ...closed, close: { ...closed.close, processId: 8 } };
  await expect(awaitYouTubeRenderDrain(input)).rejects.toMatchObject({ type: 'YOUTUBE_RENDER_DRAIN_PENDING' });
  rows.close = closed;
  await expect(awaitYouTubeRenderDrain(input)).resolves.toBeUndefined();
  expect(update).toHaveBeenCalledTimes(1);
});

test('an uncertain dispatch with no claim only drains after a durable fence', async () => {
  const { firestore, release } = fixture({ dispatch: {}, slot: youtubeRenderSlot(ref, claim.episodeId) });
  await expect(awaitYouTubeRenderDrain({ firestore, ref, stop: false, polls: 1 })).rejects.toMatchObject({
    type: 'YOUTUBE_RENDER_DRAIN_PENDING',
  });
  expect(release).not.toHaveBeenCalled();
  await expect(awaitYouTubeRenderDrain({ firestore, ref, stop: true, polls: 1 })).resolves.toBeUndefined();
  expect(release).toHaveBeenCalledWith('slot');
});

test('fencing an unclaimed dispatch does not release another operation reservation', async () => {
  const slot = youtubeRenderSlot({ ...ref, jobId: 'different-job' }, claim.episodeId);
  const { firestore, release } = fixture({ dispatch: {}, slot });
  await expect(awaitYouTubeRenderDrain({ firestore, ref, stop: true, polls: 1 })).resolves.toBeUndefined();
  expect(release).not.toHaveBeenCalled();
});

test.each([{ closedAt: '20' }, { outcome: 'completed', exitCode: 1, exitSignal: null }, { outcome: 'unconfirmed' }])(
  'the cancellation fence retains custody for an invalid close %p',
  async (patch) => {
    const { firestore, update, release } = fixture({
      claim,
      close: { ...closed, close: { ...closed.close, ...patch } },
    });
    await expect(awaitYouTubeRenderDrain({ firestore, ref, stop: true, polls: 1 })).rejects.toMatchObject({
      type: 'YOUTUBE_RENDER_DRAIN_PENDING',
    });
    expect(update).toHaveBeenCalledWith(expect.anything(), { renderStopped: true });
    expect(release).not.toHaveBeenCalled();
  }
);
