import { webcrypto } from 'node:crypto';
import type { DurableJob } from '@upperroom/contracts/temporal';

const calls = new Map<string, jest.Mock>();
const storage = new Map<string, string>();
const auth = { currentUser: { uid: 'u1' } };
jest.mock('../../firebase/firebase', () => ({
  __esModule: true,
  default: { options: { projectId: 'test-project' } },
  isDevelopment: true,
}));
jest.mock('../../firebase/auth', () => ({
  __esModule: true,
  default: auth,
  onAuthStateChanged: () => () => undefined,
}));
jest.mock('../../utils/createFunction', () => ({
  createFunctionV2: (name: string) => {
    if (!calls.has(name)) calls.set(name, jest.fn());
    return calls.get(name);
  },
  isRetryableCallableTransportError: (error: { code?: string }) => error.code === 'functions/unavailable',
}));
import {
  submitDurableIntent,
  submitDurableCommand,
  getPendingCreationId,
  forgetPendingCreationId,
  DurableAdmissionUnknownError,
  recoverPendingDurableRequests,
} from '../../utils/durableJobs';

import { buildStableUploadPayload, getUploadAdmissionIdentity } from '../../utils/uploadAdmissionIdentity';
import type { Sermon } from '../../types/SermonTypes';

const input = {
  kind: 'sermon.publish' as const,
  entity: { type: 'sermon' as const, id: 's1' },
  payload: { destinations: { listIds: ['l1'] } },
};
describe('durable admission transport boundaries', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          get length() {
            return storage.size;
          },
          key: (index: number) => [...storage.keys()][index] ?? null,
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
      },
      configurable: true,
    });
  });
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true });
    calls.clear();
    storage.clear();
  });
  const call = (name: string) => {
    if (!calls.has(name)) calls.set(name, jest.fn());
    return calls.get(name)!;
  };
  it('recovers a response lost after server acceptance by querying the exact request', async () => {
    call('submitDurableJob').mockRejectedValue({ code: 'functions/unavailable' });
    call('getDurableJobReceipt').mockResolvedValue({ jobId: 'j1', admissionState: 'accepted' });
    await expect(submitDurableIntent(input)).resolves.toMatchObject({ jobId: 'j1' });
    const request = call('submitDurableJob').mock.calls[0][0];
    expect(call('getDurableJobReceipt')).toHaveBeenCalledWith({ requestId: request.requestId });
  });
  it('reuses the same request through uncertainty and stores only opaque identity', async () => {
    call('submitDurableJob').mockRejectedValue({ code: 'functions/unavailable' });
    call('getDurableJobReceipt').mockResolvedValue(null);
    await expect(submitDurableIntent(input)).rejects.toBeInstanceOf(DurableAdmissionUnknownError);
    await expect(submitDurableIntent(input)).rejects.toBeInstanceOf(DurableAdmissionUnknownError);
    expect(call('submitDurableJob').mock.calls[0][0].requestId).toBe(
      call('submitDurableJob').mock.calls[1][0].requestId
    );
    for (const [key, value] of storage) {
      expect(key).not.toContain('destinations');
      expect(value).toMatch(/^[\da-f-]{36}$/);
    }
  });
  it('creation identity survives reload uncertainty and is released only after acceptance', async () => {
    const payload = { title: 'Series', images: [] };
    const first = await getPendingCreationId('series.create', payload);
    expect(await getPendingCreationId('series.create', { images: [], title: 'Series' })).toBe(first);
    await forgetPendingCreationId('series.create', payload);
    expect(await getPendingCreationId('series.create', payload)).not.toBe(first);
  });
  it('reuses exact upload identity despite regenerated draft IDs and timestamps after reload', async () => {
    const source = { type: 'youtube', url: 'https://youtube.com/watch?v=private-source' };
    const draft = {
      id: 'random-first',
      title: 'Title',
      dateMillis: new Date(2026, 9, 12, 10).getTime(),
      createdAtMillis: 123,
      editedAtMillis: 456,
      images: [{ id: 'image', downloadLink: 'https://private-token' }],
      speakers: [{ id: 'speaker', sermonCount: 1 }],
    } as unknown as Sermon;
    const first = buildStableUploadPayload(draft, [], 0, source);
    const restored = buildStableUploadPayload(
      {
        ...draft,
        id: 'random-next',
        createdAtMillis: 999,
        editedAtMillis: 999,
        dateMillis: new Date(2026, 9, 12, 11).getTime(),
      },
      [],
      0,
      source
    );
    expect(restored).toEqual(first);
    const identity = await getUploadAdmissionIdentity(first);
    expect(await getUploadAdmissionIdentity(restored)).toBe(identity);
    call('submitDurableJob').mockRejectedValue({ code: 'functions/unavailable' });
    call('getDurableJobReceipt').mockResolvedValue(null);
    for (const payload of [first, restored]) {
      await expect(
        submitDurableIntent({
          kind: 'upload.create',
          entity: { type: 'sermon', id: identity },
          requestId: identity,
          payload,
        })
      ).rejects.toBeInstanceOf(DurableAdmissionUnknownError);
    }
    expect(call('submitDurableJob').mock.calls[0][0]).toEqual(call('submitDurableJob').mock.calls[1][0]);
    const record = [...storage.entries()].find(([key]) => key.startsWith('urm:upload-admission:'))!;
    expect(record[1]).not.toContain('private-token');
    expect(record[1]).not.toContain('private-source');
    expect(JSON.parse(record[1]).metadata.sermon.images).toEqual([{ id: 'image' }]);
  });
  it('recovers accepted upload hints without replaying their payload and releases creation identity', async () => {
    const payload = buildStableUploadPayload({ title: 'Recovery', dateMillis: 0 } as Sermon, [], 0, {
      type: 'file',
      name: 'audio.mp3',
      size: 123,
      fingerprint: { value: 'hash' },
    });
    const identity = await getUploadAdmissionIdentity(payload);
    call('getDurableJobReceipt').mockResolvedValue({ jobId: 'accepted-upload' });
    expect(await recoverPendingDurableRequests()).toMatchObject({
      receipts: [{ jobId: 'accepted-upload' }],
      uncertain: 0,
    });
    expect(call('submitDurableJob')).not.toHaveBeenCalled();
    expect(await getUploadAdmissionIdentity(payload)).not.toBe(identity);
  });
  it('allocates a fresh same-payload publish identity after the prior admission was confirmed', async () => {
    call('submitDurableJob').mockResolvedValue({ jobId: 'accepted-job' });
    await submitDurableIntent(input);
    await submitDurableIntent(input);
    expect(call('submitDurableJob').mock.calls[0][0].requestId).not.toBe(
      call('submitDurableJob').mock.calls[1][0].requestId
    );
  });
  it('keeps one uncertain source-retry identity and releases it only after accepted proof', async () => {
    const payload = {
      ...buildStableUploadPayload({ title: 'Retry', dateMillis: 0 } as Sermon, [], 0, {
        type: 'youtube',
        url: 'https://youtube.com/watch?v=private-retry',
      }),
      retryOfJobId: 'original-source-job',
    };
    const first = await getUploadAdmissionIdentity(payload);
    expect(await getUploadAdmissionIdentity(payload)).toBe(first);
    call('getDurableJobReceipt').mockResolvedValue({ jobId: 'accepted-retry' });
    await recoverPendingDurableRequests();
    expect(await getUploadAdmissionIdentity(payload)).not.toBe(first);
    for (const [key, value] of storage)
      if (key.startsWith('urm:upload-admission:')) expect(value).not.toContain('private-retry');
  });
  it('passes source-backed explicit identities without allocating new ones', async () => {
    call('submitDurableJob').mockResolvedValue({ jobId: 'image-job' });
    await submitDurableIntent({ ...input, requestId: 'source-request' });
    expect(call('submitDurableJob')).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'source-request' }));
  });
  it('fences commands with revision and checks current capabilities', async () => {
    const job: DurableJob = {
      schemaVersion: 1,
      jobId: 'j1',
      projectId: 'test-project',
      kind: 'audio.process',
      entity: input.entity,
      workflowId: 'wf',
      generation: 2,
      revision: 13,
      requestedBy: 'u1',
      requestId: 'r1',
      state: 'running',
      createdAt: 1,
      updatedAt: 2,
      steps: [],
      actions: ['cancel'],
    };
    call('commandDurableJob').mockResolvedValue({ state: 'accepted' });
    await submitDurableCommand(job, 'cancel');
    expect(call('commandDurableJob')).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 13, jobId: 'j1', action: 'cancel' })
    );
    await expect(submitDurableCommand(job, 'retry')).rejects.toThrow('no longer available');
    expect(call('commandDurableJob')).toHaveBeenCalledTimes(1);
  });
  it('reuses the exact completion request ID after its response is lost', async () => {
    const job: DurableJob = {
      schemaVersion: 1,
      jobId: 'awaiting-upload',
      projectId: 'test-project',
      kind: 'upload.create',
      entity: input.entity,
      workflowId: 'wf-source',
      generation: 1,
      revision: 7,
      requestedBy: 'u1',
      requestId: 'upload-request',
      state: 'awaiting_source',
      createdAt: 1,
      updatedAt: 2,
      steps: [],
      actions: ['resume_upload'],
    };
    const resolution = { storagePath: 'immutable/source', generation: '123' };
    call('commandDurableJob')
      .mockRejectedValueOnce({ code: 'functions/unavailable' })
      .mockResolvedValueOnce({ state: 'already_accepted' });
    await expect(submitDurableCommand(job, 'resume_upload', resolution)).rejects.toMatchObject({
      code: 'functions/unavailable',
    });
    await submitDurableCommand(job, 'resume_upload', resolution);
    expect(call('commandDurableJob').mock.calls[1][0]).toEqual(call('commandDurableJob').mock.calls[0][0]);
  });
});
