import { webcrypto, createHash } from 'node:crypto';
import uploadFile, { fingerprintAudioFile, transferAudioSource } from './uploadFile';
import { getDocFromServer } from '../firebase/firestore';
import { uploadBytesResumable, getMetadata } from '../firebase/storage';
import { getUploadAdmissionIdentity, forgetUploadAdmissionIdentity } from './uploadAdmissionIdentity';
import { submitDurableIntent, submitDurableCommand } from './durableJobs';
import type { DurableJob, DurableAdmissionReceipt } from '@upperroom/contracts/temporal';
import type { Sermon } from '../types/SermonTypes';

jest.mock('../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  doc: jest.fn(),
  getDocFromServer: jest.fn(),
}));
jest.mock('../firebase/storage', () => ({
  __esModule: true,
  default: {},
  ref: (_storage: unknown, fullPath: string) => ({ fullPath }),
  uploadBytesResumable: jest.fn(),
  getMetadata: jest.fn(),
}));
jest.mock('./durableJobs', () => ({ submitDurableIntent: jest.fn(), submitDurableCommand: jest.fn() }));
jest.mock('../firebase/auth', () => ({ __esModule: true, default: { currentUser: { uid: 'uploader-1' } } }));
jest.mock('../firebase/firebase', () => ({
  __esModule: true,
  default: { options: { projectId: 'test' } },
  isDevelopment: true,
}));
jest.mock('./uploadAdmissionIdentity', () => ({
  ...jest.requireActual('./uploadAdmissionIdentity'),
  getUploadAdmissionIdentity: jest.fn(async () => 'stable-upload-target'),
  forgetUploadAdmissionIdentity: jest.fn(async () => undefined),
}));

const receipt: DurableAdmissionReceipt = {
  jobId: 'job-1',
  projectId: 'test',
  requestId: 'request-1',
  admissionState: 'awaiting_source',
  generation: 1,
  revision: 1,
};
const job = (extra: Partial<DurableJob> = {}): DurableJob => ({
  ...receipt,
  schemaVersion: 1,
  kind: 'upload.create',
  entity: { type: 'sermon', id: 'sermon-1' },
  workflowId: 'workflow-1',
  requestedBy: 'uploader-1',
  state: 'awaiting_source',
  createdAt: 1,
  updatedAt: 1,
  steps: [],
  actions: ['resume_upload'],
  ...extra,
});
const snapshot = (value: DurableJob) => ({ exists: () => true, data: () => value });
const file = () => new File(['abc'], 'sermon.mp3', { type: 'audio/mpeg', lastModified: 170 });
const sermon = { id: 'sermon-1', trimDurationSeconds: 10, images: [] } as unknown as Sermon;

beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(getUploadAdmissionIdentity).mockReset().mockResolvedValue('stable-upload-target');
  jest.mocked(submitDurableIntent).mockResolvedValue(receipt);
  jest
    .mocked(getDocFromServer)
    .mockReset()
    .mockResolvedValue(snapshot(job({ state: 'queued', actions: [] })) as never);
  jest
    .mocked(getMetadata)
    .mockReset()
    .mockRejectedValueOnce({ code: 'storage/object-not-found' })
    .mockResolvedValue({
      generation: '123',
      size: 3,
      customMetadata: { durableJobId: 'job-1', fingerprint: JSON.stringify(await fingerprintAudioFile(file())) },
    } as Awaited<ReturnType<typeof getMetadata>>);
  jest.mocked(uploadBytesResumable).mockImplementation(
    () =>
      ({
        on: (
          _event: string,
          progress: (value: { bytesTransferred: number; totalBytes: number }) => void,
          _error: unknown,
          complete: () => void
        ) => {
          progress({ bytesTransferred: 3, totalBytes: 3 });
          complete();
        },
      } as unknown as ReturnType<typeof uploadBytesResumable>)
  );
});

it('admits YouTube once without uploading bytes or claiming processing finished', async () => {
  const progress = jest.fn();
  await uploadFile({
    audioSource: { type: 'YoutubeUrl', source: 'https://www.youtube.com/watch?v=test' },
    sermon,
    sermonList: [],
    trimStart: 0,
    setUploadProgress: progress,
  });
  expect(submitDurableIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'upload.create',
      payload: expect.objectContaining({ source: { type: 'youtube', url: 'https://www.youtube.com/watch?v=test' } }),
    })
  );
  expect(uploadBytesResumable).not.toHaveBeenCalled();
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: 'Request saved. Follow audio processing in Activity.' })
  );
});

it('returns the canonical server sermon ID instead of the browser draft UUID', async () => {
  jest
    .mocked(getDocFromServer)
    .mockResolvedValue(
      snapshot(
        job({ state: 'queued', actions: [], entity: { type: 'sermon', id: 'canonical-server-sermon' } })
      ) as never
    );
  const result = await uploadFile({
    audioSource: { type: 'YoutubeUrl', source: 'https://www.youtube.com/watch?v=test' },
    sermon: { ...sermon, id: 'ephemeral-browser-uuid' },
    sermonList: [],
    trimStart: 0,
    setUploadProgress: jest.fn(),
  });
  expect(result.sermonId).toBe('canonical-server-sermon');
  expect(submitDurableIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: 'stable-upload-target',
      entity: { type: 'sermon', id: 'stable-upload-target' },
    })
  );
});

it('uses the saved source path and fresh revision when confirming a completed file', async () => {
  const source = file();
  const fingerprint = await fingerprintAudioFile(source);
  const first = job({
    result: {
      sourceUpload: {
        storagePath: 'source/job-1/audio',
        expectedFile: { name: source.name, size: source.size, lastModified: source.lastModified, fingerprint },
        jobRevision: 1,
      },
    },
  });
  const current = { ...first, revision: 9 };
  jest
    .mocked(getDocFromServer)
    .mockResolvedValueOnce(snapshot(first) as never)
    .mockResolvedValueOnce(snapshot(current) as never);
  const admitted = jest.fn();
  await uploadFile({
    audioSource: { type: 'File', source: { file: source, name: 'sermon', preview: '' } },
    sermon,
    sermonList: [],
    trimStart: 0,
    setUploadProgress: jest.fn(),
    onAdmission: admitted,
  });
  expect(admitted).toHaveBeenCalledWith(receipt);
  expect(uploadBytesResumable).toHaveBeenCalledWith(
    { fullPath: 'source/job-1/audio' },
    source,
    expect.objectContaining({ customMetadata: { durableJobId: 'job-1', fingerprint: JSON.stringify(fingerprint) } })
  );
  expect(submitDurableCommand).toHaveBeenCalledWith(current, 'resume_upload', {
    storagePath: 'source/job-1/audio',
    generation: '123',
  });
});

it('rejects a reselected file whose content changed even when its name, size and time match', async () => {
  const original = file();
  const waiting = job({
    result: {
      sourceUpload: {
        storagePath: 'source/job-1/audio',
        expectedFile: {
          name: original.name,
          size: original.size,
          lastModified: original.lastModified,
          fingerprint: await fingerprintAudioFile(original),
        },
        jobRevision: 1,
      },
    },
  });
  const wrong = new File(['xyz'], original.name, { lastModified: original.lastModified });
  await expect(transferAudioSource(waiting, wrong, jest.fn())).rejects.toThrow('different content');
  expect(uploadBytesResumable).not.toHaveBeenCalled();
  expect(submitDurableCommand).not.toHaveBeenCalled();
});

it('resolves a lost completion response to the existing job without another admission or file transfer', async () => {
  jest.mocked(getDocFromServer).mockResolvedValue(snapshot(job({ state: 'queued', actions: [] })) as never);
  await uploadFile({
    audioSource: { type: 'File', source: { file: file(), name: 'sermon', preview: '' } },
    sermon,
    sermonList: [],
    trimStart: 0,
    setUploadProgress: jest.fn(),
    receipt,
  });
  expect(submitDurableIntent).not.toHaveBeenCalled();
  expect(uploadBytesResumable).not.toHaveBeenCalled();
  expect(submitDurableCommand).not.toHaveBeenCalled();
});

it('retains the admitted request when completion confirmation fails', async () => {
  const source = file();
  const waiting = job({
    result: {
      sourceUpload: {
        storagePath: 'source/job-1/audio',
        expectedFile: {
          name: source.name,
          size: source.size,
          lastModified: source.lastModified,
          fingerprint: await fingerprintAudioFile(source),
        },
        jobRevision: 1,
      },
    },
  });
  jest.mocked(getDocFromServer).mockResolvedValue(snapshot(waiting) as never);
  jest
    .mocked(submitDurableCommand)
    .mockRejectedValueOnce(new Error('Connection interrupted; check the saved request.'));
  const admitted = jest.fn();
  const progress = jest.fn();
  await expect(
    uploadFile({
      audioSource: { type: 'File', source: { file: source, name: 'sermon', preview: '' } },
      sermon,
      sermonList: [],
      trimStart: 0,
      setUploadProgress: progress,
      onAdmission: admitted,
    })
  ).rejects.toThrow('Connection interrupted');
  expect(admitted).toHaveBeenCalledWith(receipt);
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ error: true }));
});

it('fingerprints bytes on both sides of chunk boundaries with bounded chunk hashing', async () => {
  const first = new Uint8Array(4 * 1024 * 1024).fill(7);
  const last = new Uint8Array([1, 2, 3]);
  const source = new File([first, last], 'large.mp3');
  const expected = createHash('sha256')
    .update(Buffer.concat([createHash('sha256').update(first).digest(), createHash('sha256').update(last).digest()]))
    .digest('hex');
  expect(await fingerprintAudioFile(source)).toEqual({
    algorithm: 'sha256-chunks-v1',
    chunkBytes: first.length,
    value: expected,
  });
  const different = new File([first, new Uint8Array([1, 2, 4])], 'large.mp3');
  expect((await fingerprintAudioFile(different)).value).not.toBe(expected);
});

it('confirms an existing immutable matching source without attempting an overwrite', async () => {
  const source = file();
  const fingerprint = await fingerprintAudioFile(source);
  const waiting = job({
    result: {
      sourceUpload: {
        storagePath: 'source/job-1/audio',
        expectedFile: { name: source.name, size: source.size, lastModified: source.lastModified, fingerprint },
        jobRevision: 1,
      },
    },
  });
  jest
    .mocked(getMetadata)
    .mockReset()
    .mockResolvedValue({
      generation: '123',
      size: source.size,
      customMetadata: { durableJobId: 'job-1', fingerprint: JSON.stringify(fingerprint) },
    } as Awaited<ReturnType<typeof getMetadata>>);
  jest.mocked(getDocFromServer).mockResolvedValue(snapshot(waiting) as never);
  await transferAudioSource(waiting, source, jest.fn());
  expect(uploadBytesResumable).not.toHaveBeenCalled();
  expect(submitDurableCommand).toHaveBeenCalledWith(waiting, 'resume_upload', {
    storagePath: 'source/job-1/audio',
    generation: '123',
  });
});

it('recovers a lost upload acknowledgement by verifying the immutable source', async () => {
  const source = file();
  const fingerprint = await fingerprintAudioFile(source);
  const waiting = job({
    result: {
      sourceUpload: {
        storagePath: 'source/job-1/audio',
        expectedFile: { name: source.name, size: source.size, lastModified: source.lastModified, fingerprint },
        jobRevision: 1,
      },
    },
  });
  jest.mocked(getDocFromServer).mockResolvedValue(snapshot(waiting) as never);
  jest.mocked(uploadBytesResumable).mockImplementationOnce(
    () =>
      ({
        on: (_event: unknown, _progress: unknown, error: (value: unknown) => void) =>
          error({ code: 'storage/unauthorized' }),
      } as unknown as ReturnType<typeof uploadBytesResumable>)
  );
  await transferAudioSource(waiting, source, jest.fn());
  expect(uploadBytesResumable).toHaveBeenCalledTimes(1);
  expect(submitDurableCommand).toHaveBeenCalledWith(waiting, 'resume_upload', {
    storagePath: 'source/job-1/audio',
    generation: '123',
  });
});

it.each(['storage/unauthorized', 'storage/unknown', 'storage/retry-limit-exceeded'])(
  'never starts a transfer when checking the immutable source fails with %s',
  async (code) => {
    const source = file();
    const waiting = job({
      result: {
        sourceUpload: {
          storagePath: 'source/job-1/audio',
          expectedFile: {
            name: source.name,
            size: source.size,
            lastModified: source.lastModified,
            fingerprint: await fingerprintAudioFile(source),
          },
          jobRevision: 1,
        },
      },
    });
    jest.mocked(getMetadata).mockReset().mockRejectedValue({ code });
    await expect(transferAudioSource(waiting, source, jest.fn())).rejects.toThrow('saved source could not be checked');
    expect(uploadBytesResumable).not.toHaveBeenCalled();
    expect(submitDurableCommand).not.toHaveBeenCalled();
  }
);

it.each(['size', 'owner', 'fingerprint', 'generation'])(
  'preserves an existing object with mismatched %s instead of replacing or confirming it',
  async (field) => {
    const source = file();
    const fingerprint = await fingerprintAudioFile(source);
    const waiting = job({
      result: {
        sourceUpload: {
          storagePath: 'source/job-1/audio',
          expectedFile: { name: source.name, size: source.size, lastModified: source.lastModified, fingerprint },
          jobRevision: 1,
        },
      },
    });
    const metadata = {
      generation: field === 'generation' ? '' : '123',
      size: field === 'size' ? 999 : source.size,
      customMetadata: {
        durableJobId: field === 'owner' ? 'different-job' : waiting.jobId,
        fingerprint: field === 'fingerprint' ? 'different-content' : JSON.stringify(fingerprint),
      },
    };
    jest
      .mocked(getMetadata)
      .mockReset()
      .mockResolvedValue(metadata as Awaited<ReturnType<typeof getMetadata>>);
    await expect(transferAudioSource(waiting, source, jest.fn())).rejects.toThrow('saved source differs');
    expect(uploadBytesResumable).not.toHaveBeenCalled();
    expect(submitDurableCommand).not.toHaveBeenCalled();
  }
);

it('reselects after a lost completion command without uploading again and reuses the same source generation', async () => {
  const source = file();
  const fingerprint = await fingerprintAudioFile(source);
  const waiting = job({
    result: {
      sourceUpload: {
        storagePath: 'source/job-1/audio',
        expectedFile: { name: source.name, size: source.size, lastModified: source.lastModified, fingerprint },
        jobRevision: 1,
      },
    },
  });
  jest
    .mocked(getMetadata)
    .mockReset()
    .mockResolvedValue({
      generation: '123',
      size: source.size,
      customMetadata: { durableJobId: waiting.jobId, fingerprint: JSON.stringify(fingerprint) },
    } as Awaited<ReturnType<typeof getMetadata>>);
  jest.mocked(getDocFromServer).mockResolvedValue(snapshot(waiting) as never);
  jest.mocked(submitDurableCommand).mockRejectedValueOnce(new Error('Completion response lost')).mockResolvedValueOnce({
    jobId: waiting.jobId,
    projectId: waiting.projectId,
    requestId: 'completion',
    acceptedRevision: waiting.revision,
    state: 'accepted',
  });
  await expect(transferAudioSource(waiting, source, jest.fn())).rejects.toThrow('Completion response lost');
  await transferAudioSource(waiting, source, jest.fn());
  expect(uploadBytesResumable).not.toHaveBeenCalled();
  expect(submitDurableCommand).toHaveBeenNthCalledWith(1, waiting, 'resume_upload', {
    storagePath: 'source/job-1/audio',
    generation: '123',
  });
  expect(submitDurableCommand).toHaveBeenNthCalledWith(2, waiting, 'resume_upload', {
    storagePath: 'source/job-1/audio',
    generation: '123',
  });
});

it('explicit retry admits a fresh source job for the same server canonical sermon rather than replaying the old receipt', async () => {
  jest.mocked(getUploadAdmissionIdentity).mockResolvedValueOnce('fresh-retry-request');
  jest.mocked(submitDurableIntent).mockResolvedValueOnce({
    ...receipt,
    jobId: 'source-retry',
    requestId: 'fresh-retry-request',
    clientResult: { sermonId: 'sermon-1', retryOfJobId: 'job-1' },
  });
  jest
    .mocked(getDocFromServer)
    .mockResolvedValueOnce(snapshot(job({ jobId: 'source-retry', state: 'queued', actions: [] })) as never);
  const onAdmission = jest.fn();
  const result = await uploadFile({
    receipt,
    retryOfJobId: 'job-1',
    audioSource: { type: 'YoutubeUrl', source: 'https://www.youtube.com/watch?v=test' },
    sermon,
    sermonList: [],
    trimStart: 0,
    setUploadProgress: jest.fn(),
    onAdmission,
  });
  expect(submitDurableIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: 'fresh-retry-request',
      payload: expect.objectContaining({ retryOfJobId: 'job-1' }),
    })
  );
  expect(result).toMatchObject({ jobId: 'source-retry', sermonId: 'sermon-1' });
  expect(onAdmission.mock.calls.every(([accepted]) => accepted.jobId === 'source-retry')).toBe(true);
  expect(forgetUploadAdmissionIdentity).toHaveBeenCalledWith(
    'fresh-retry-request',
    expect.objectContaining({ retryOfJobId: 'job-1' })
  );
  expect(uploadBytesResumable).not.toHaveBeenCalled();
});
it('already-complete proof returns the factual canonical sermon without reading a cancelled job or transferring bytes', async () => {
  jest
    .mocked(submitDurableIntent)
    .mockResolvedValueOnce({ ...receipt, clientResult: { alreadyComplete: true, sermonId: 'saved-processed-sermon' } });
  const result = await uploadFile({
    receipt,
    retryOfJobId: 'job-1',
    audioSource: { type: 'File', source: { file: file(), preview: 'blob:retry-source' } },
    sermon,
    sermonList: [],
    trimStart: 0,
    setUploadProgress: jest.fn(),
  });
  expect(result).toMatchObject({ alreadyComplete: true, sermonId: 'saved-processed-sermon' });
  expect(getDocFromServer).not.toHaveBeenCalled();
  expect(uploadBytesResumable).not.toHaveBeenCalled();
  expect(getMetadata).not.toHaveBeenCalled();
});
it('rejected fresh source retry keeps the original receipt and source intact without byte transfer', async () => {
  jest
    .mocked(submitDurableIntent)
    .mockRejectedValueOnce(new Error('This saved sermon is published; edit its audio from the sermon page.'));
  const originalReceipt = { ...receipt };
  const originalSource = { type: 'YoutubeUrl' as const, source: 'https://www.youtube.com/watch?v=test' };
  const onAdmission = jest.fn();
  await expect(
    uploadFile({
      receipt: originalReceipt,
      retryOfJobId: 'job-1',
      audioSource: originalSource,
      sermon,
      sermonList: [],
      trimStart: 0,
      setUploadProgress: jest.fn(),
      onAdmission,
    })
  ).rejects.toThrow('published');
  expect(originalReceipt).toEqual(receipt);
  expect(originalSource.source).toBe('https://www.youtube.com/watch?v=test');
  expect(onAdmission).not.toHaveBeenCalled();
  expect(forgetUploadAdmissionIdentity).not.toHaveBeenCalled();
  expect(uploadBytesResumable).not.toHaveBeenCalled();
});
