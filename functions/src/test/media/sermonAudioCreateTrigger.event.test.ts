import sermonAudioCreateTrigger, {
  enqueueInitialSermonAudio,
} from '../../../../functions-media/src/sermonAudioCreateTrigger';
import { Sermon, sermonStatusType } from '@upperroom/shared/types/SermonTypes';
import { logger } from 'firebase-functions/v2';

// Captured emulator no-op event: protobuf DocumentEventData contains only an empty
// updateMask, with neither a created document nor an old document. The actual SDK
// decoder must participate in this regression, rather than mocking snapshot.data().
const emptyCreateEvent = () => ({
  specversion: '1.0',
  type: 'google.cloud.firestore.document.v1.created',
  source: '//firestore.googleapis.com/projects/urm-app/databases/(default)',
  id: 'synthetic-empty-create',
  time: '2026-10-13T00:14:28Z',
  subject: 'documents/sermons/synthetic-empty-create',
  document: 'sermons/synthetic-empty-create',
  project: 'urm-app',
  database: '(default)',
  namespace: '(default)',
  datacontenttype: 'application/protobuf',
  data: Buffer.from([26, 0]),
});

const invokeEmptyCreate = () =>
  sermonAudioCreateTrigger(emptyCreateEvent() as Parameters<typeof sermonAudioCreateTrigger>[0]);

describe('initial audio create event decoding', () => {
  const previousEmulator = process.env.FUNCTIONS_EMULATOR;
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousEmulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = previousEmulator;
  });

  it('ignores the captured phantom emulator create without queue or storage work', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    await expect(invokeEmptyCreate()).resolves.toBeUndefined();
  });

  it('rejects a missing production create document so delivery remains retryable', async () => {
    delete process.env.FUNCTIONS_EMULATOR;
    await expect(invokeEmptyCreate()).rejects.toThrow('Created sermon event has no document');
  });

  it('keeps Temporal-owned pending audio out of the legacy queue', async () => {
    const dependencies = { fileExists: jest.fn(), getDownloadUrl: jest.fn(), enqueue: jest.fn() };
    const sermon = {
      status: { audioStatus: sermonStatusType.PENDING },
      activeDurableJobs: { upload: { jobId: 'source-owner' } },
    } as unknown as Sermon;
    await expect(enqueueInitialSermonAudio('source-owner', sermon, dependencies)).resolves.toEqual({
      action: 'skipped',
      reason: 'not_pending',
    });
    expect(dependencies.fileExists).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('decodes a real create payload and observes its Temporal owner', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const event = {
      ...emptyCreateEvent(),
      datacontenttype: 'application/json',
      data: {
        value: {
          name: 'projects/urm-app/databases/(default)/documents/sermons/synthetic-empty-create',
          createTime: '2026-10-13T00:14:28Z',
          updateTime: '2026-10-13T00:14:28Z',
          fields: {
            status: { mapValue: { fields: { audioStatus: { stringValue: sermonStatusType.PENDING } } } },
            activeDurableJobs: { mapValue: { fields: { upload: { stringValue: 'source-owner' } } } },
          },
        },
      },
    };
    await expect(
      sermonAudioCreateTrigger(event as Parameters<typeof sermonAudioCreateTrigger>[0])
    ).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith('Reconciled initial sermon audio queue request', {
      sermonId: 'synthetic-empty-create',
      action: 'skipped',
      reason: 'not_pending',
    });
  });

  it('keeps a valid pending storage source failure retryable', async () => {
    const dependencies = {
      fileExists: jest.fn(async () => false),
      getDownloadUrl: jest.fn(async () => 'https://storage.example.test/bumper'),
      enqueue: jest.fn(),
    };
    const sermon = {
      status: { audioStatus: sermonStatusType.PENDING },
      subtitle: '',
      sourceStartTime: 0,
      trimDurationSeconds: 30,
    } as Sermon;
    await expect(enqueueInitialSermonAudio('pending-source', sermon, dependencies)).rejects.toThrow(
      'Initial sermon audio source is not available for pending-source'
    );
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });
});
