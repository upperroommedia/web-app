import { Context } from '@temporalio/activity';
import type { Firestore } from 'firebase-admin/firestore';
import {
  recordNativeYouTubeArchiveWait,
  recordNativeYouTubeRenderArchiveWait,
} from '../../../process-audio/src/temporal/hetzner-acquisition-episode';
import { createRuntimeYouTubeArchiveWaitRecorder } from './hetzner-media';
import type { WorkerWitness } from './worker-witness';
jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-episode', () => ({
  prepareNativeYouTubeEpisode: jest.fn(),
  recordNativeYouTubeArchiveWait: jest.fn(),
  recordNativeYouTubeRenderArchiveWait: jest.fn(),
}));
const ref = {
  projectId: 'urm-app-staging',
  jobId: 'owned-archive',
  sermonId: 'owned-sermon',
  revision: 1,
  requestVersion: 'a'.repeat(16),
};
const value = { attempt: 1, scheduledAt: 1, dueAt: 1800001 };
// Controlled Context/witness/transport; this tests the real source boundary,
// not actual SDK identity, Cloud Run image or native archive acceptance.
const lookup = jest.fn(async () => ({ exists: true, get: (_key: string): unknown => undefined }));
const actor = jest.fn(async () => undefined);
const cancellation = new AbortController();
beforeEach(() => {
  jest.clearAllMocks();
  lookup.mockResolvedValue({ exists: true, get: () => undefined });
  actor.mockResolvedValue(undefined);
  jest.mocked(recordNativeYouTubeArchiveWait).mockResolvedValue(undefined);
  jest.spyOn(Context, 'current').mockReturnValue({
    info: {
      activityType: 'projectMediaWaiting',
      activityId: 'projection',
      attempt: 1,
      workflowExecution: { workflowId: 'workflow', runId: 'run' },
    },
    cancellationSignal: cancellation.signal,
  } as Context);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
const setup = () =>
  createRuntimeYouTubeArchiveWaitRecorder({
    projectId: 'urm-app-staging',
    firestore: { doc: () => ({ get: lookup }) } as unknown as Firestore,
    witness: {
      buildId: 'a'.repeat(40),
      cloudRun: { projectId: 'urm-app-staging', region: 'us-central1' },
    } as WorkerWitness,
    assertCurrent: actor,
  })!;
test.each(['lookup', 'transaction', 'actor'])(
  'archive boundary strips private SDK %s errors from Activity failure',
  async (mode) => {
    const sentinel = 'PRIVATE_IDENTITY_REQUEST_SENTINEL';
    if (mode === 'lookup') lookup.mockRejectedValueOnce(new Error(sentinel));
    else if (mode === 'transaction')
      jest.mocked(recordNativeYouTubeArchiveWait).mockRejectedValueOnce(new Error(sentinel));
    else {
      actor.mockRejectedValueOnce(new Error(sentinel));
      jest.mocked(recordNativeYouTubeArchiveWait).mockImplementationOnce(async (o) => {
        await o.assertCurrent({} as never, ref);
      });
    }
    await expect(setup()(ref, value)).rejects.toMatchObject({
      type: 'YOUTUBE_ARCHIVE_WAIT_UNCONFIRMED',
      message: 'YouTube archive wait cannot be verified.',
      cause: undefined,
    });
  }
);
test('original archive lookup deadline survives real event-loop starvation before recorder entry', async () => {
  lookup.mockImplementationOnce(async () => {
    const start = performance.now();
    while (performance.now() - start < 5100) {
      /* real blocked event loop */
    }
    return { exists: true, get: () => undefined };
  });
  await expect(setup()(ref, value)).rejects.toMatchObject({ type: 'YOUTUBE_ARCHIVE_WAIT_UNCONFIRMED' });
  expect(recordNativeYouTubeArchiveWait).not.toHaveBeenCalled();
});

test('never-settling original lookup is bounded without entering actor or recorder', async () => {
  jest.useFakeTimers();
  lookup.mockImplementationOnce(() => new Promise(() => undefined));
  const pending = setup()(ref, value);
  const observed = expect(pending).rejects.toMatchObject({ type: 'YOUTUBE_ARCHIVE_WAIT_UNCONFIRMED' });
  await jest.advanceTimersByTimeAsync(5001);
  await observed;
  expect(actor).not.toHaveBeenCalled();
  expect(recordNativeYouTubeArchiveWait).not.toHaveBeenCalled();
});
test('ordinary local delegation absence leaves the native archive recorder unused', async () => {
  lookup.mockResolvedValueOnce({ exists: false });
  await setup()(ref, value);
  expect(actor).not.toHaveBeenCalled();
  expect(recordNativeYouTubeArchiveWait).not.toHaveBeenCalled();
});
test('native cancellation reason survives sanitizing boundary', async () => {
  const ctrl = new AbortController(),
    reason = new Error('CONTROLLED_NATIVE_CANCELLATION');
  jest.spyOn(Context, 'current').mockReturnValue({
    info: {
      activityType: 'projectMediaWaiting',
      activityId: 'projection',
      attempt: 1,
      workflowExecution: { workflowId: 'workflow', runId: 'run' },
    },
    cancellationSignal: ctrl.signal,
  } as Context);
  jest.mocked(recordNativeYouTubeArchiveWait).mockImplementationOnce(async () => {
    ctrl.abort(reason);
    throw Error('PRIVATE_UNRELATED');
  });
  await expect(setup()(ref, value)).rejects.toBe(reason);
});

test('native cancellation during stalled initial lookup retains its original reason', async () => {
  jest.useFakeTimers();
  const ctrl = new AbortController(),
    reason = new Error('CONTROLLED_LOOKUP_CANCELLATION');
  jest.spyOn(Context, 'current').mockReturnValue({ cancellationSignal: ctrl.signal } as Context);
  lookup.mockImplementationOnce(() => new Promise(() => undefined));
  const pending = setup()(ref, value);
  const observed = expect(pending).rejects.toBe(reason);
  await jest.advanceTimersByTimeAsync(100);
  ctrl.abort(reason);
  await jest.advanceTimersByTimeAsync(4901);
  await observed;
  expect(actor).not.toHaveBeenCalled();
  expect(recordNativeYouTubeArchiveWait).not.toHaveBeenCalled();
});

test('a render delegation records its timer against the render close path', async () => {
  lookup.mockResolvedValueOnce({ exists: true, get: (key) => (key === 'renderProtocol' ? 1 : undefined) });
  jest.mocked(recordNativeYouTubeRenderArchiveWait).mockResolvedValueOnce(undefined);
  await setup()(ref, value);
  expect(recordNativeYouTubeRenderArchiveWait).toHaveBeenCalledWith(expect.objectContaining({ ref, wait: value }));
  expect(recordNativeYouTubeArchiveWait).not.toHaveBeenCalled();
});
