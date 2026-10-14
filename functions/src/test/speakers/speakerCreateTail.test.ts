import type { Firestore } from 'firebase-admin/firestore';
const mockRows = new Map<string, Record<string, any>>();
const mockEvents: string[] = [];
let mockRevoke = false;
const mockSnapshot = (path: string) => ({
  exists: mockRows.has(path),
  data: () => mockRows.get(path),
  get: (field: string) => field.split('.').reduce((v, k) => v?.[k], mockRows.get(path)),
});
const mockRef = (path: string): any => ({ path, id: path.split('/').pop(), get: async () => mockSnapshot(path) });
const mockTx: any = {
  get: async (ref: any) => mockSnapshot(ref.path),
  set: (ref: any, row: any) => {
    mockEvents.push('set:' + ref.path);
    mockRows.set(ref.path, row);
  },
  update: (ref: any, row: any) => mockRows.set(ref.path, { ...mockRows.get(ref.path), ...row }),
  create: (ref: any, row: any) => mockRows.set(ref.path, row),
};
const mockDb: any = {
  doc: mockRef,
  collection: (name: string) => ({
    doc: (id: string) => mockRef(name + '/' + id),
    withConverter() {
      return this;
    },
    get: async () => ({ docs: [] }),
  }),
};
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb, app: () => ({ options: { projectId: 'urm-app' } }) },
}));
jest.mock('../../temporal/publishing/durableOperationContext', () => ({
  getDurablePublishingJobId: () => 'job',
  getPublishingMutationOperation: () => 'speaker-plan',
  isDurablePublishingOperation: () => true,
  runDurableTransaction: async (_db: any, fn: any) => {
    if (mockRevoke) throw Error('ACTOR_REVOKED');
    return fn(mockTx);
  },
  prepareProviderMutationPlanCommit: async () => ({
    alreadyCommitted: false,
    commit: () => mockEvents.push('settled'),
  }),
}));
jest.mock('../../temporal/publishing/providerReceipts', () => ({
  ...jest.requireActual('../../temporal/publishing/providerReceipts'),
  executeProviderCreate: jest.fn(async (input: any) => {
    mockEvents.push('primitive:' + input.step);
    const actual = jest.requireActual('../../temporal/publishing/providerReceipts'),
      path = actual.PROVIDER_RECEIPTS_COLLECTION + '/' + actual.providerReceiptId(input.operationKey, input.step),
      prior = mockRows.get(path);
    if (prior?.state === 'confirmed') return prior.result;
    await input.prepare?.();
    const result = await input.execute();
    mockRows.set(path, {
      operationKey: input.operationKey,
      step: input.step,
      projectId: 'urm-app',
      jobId: 'job',
      providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
      fingerprint: actual.providerPayloadFingerprint(input.payload),
      state: 'confirmed',
      result,
    });
    return result;
  }),
}));
jest.mock('../../temporal/publishing/providerAssociations', () => ({ reserveSubsplashAssociation: jest.fn() }));
jest.mock('../../helpers/subsplashImageRefs', () => ({ repairMismatchedSubsplashImageRefs: jest.fn() }));
jest.mock('../../firestoreDataConverter', () => ({
  firestoreAdminListConverter: {},
  firestoreAdminSpeakerConverter: {},
}));
jest.mock('../../createNewSubsplashList', () => ({ createNewSubsplashList: jest.fn() }));
jest.mock('../../helpers/listOverflowChain', () => ({ buildRootListMetadata: jest.fn() }));
jest.mock('../../locks/withSubsplashLocks', () => ({ withSubsplashLocks: async (_key: any, fn: any) => fn() }));
jest.mock('../../locks/withIdempotency', () => ({ withIdempotency: async (_key: any, fn: any) => fn() }));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: async () => 'token',
  createAxiosConfig: (url: string, _token: string, method: string, data: any) => ({ url, method, data }),
}));
jest.mock('axios', () => ({ __esModule: true, default: jest.fn(), isAxiosError: () => false }));
import axios from 'axios';
import {
  createSpeakerMutation,
  completeConfirmedSpeakerCreate,
  validateSpeakerCreateTailCheckpoint,
  type SpeakerCreateTailCheckpoint,
} from '../../speakers/speakerMutations';
import {
  providerPayloadFingerprint as fp,
  providerReceiptId,
  PROVIDER_RECEIPTS_COLLECTION,
  executeProviderCreate,
} from '../../temporal/publishing/providerReceipts';
import { acknowledgedProjectionDigest as digest } from '../../temporal/publishing/criticalAcknowledgedRepair';
import { repairMismatchedSubsplashImageRefs } from '../../helpers/subsplashImageRefs';
import type { CreateSpeakerCallableInputType } from '../../speakers/createSpeakerTypes';
function fixture(list = false) {
  const image = {
    id: 'square',
    type: 'square' as const,
    subsplashId: 'remote-square',
    downloadLink: 'https://example.test/image',
  };
  const input = {
    operationKey: 'original',
    speaker: { name: 'Name', images: [image] },
    ...(list ? { createSpeakerList: true } : {}),
  } as CreateSpeakerCallableInputType;
  const raw = {
    schemaVersion: 1 as const,
    projectId: 'urm-app',
    jobId: 'job',
    generation: 1,
    workflowId: 'workflow',
    speakerId: 'speaker',
    operationKey: input.operationKey!,
    inputFingerprint: fp(input),
    images: [image],
    desiredSpeaker: {
      id: 'speaker',
      name: 'Name',
      shortDescription: '',
      description: '',
      images: [image],
      sermonCount: 0,
      ...(list ? { listId: 'list' } : {}),
    },
    tagPayload: { title: 'Name', squareImage: image },
    originalExists: false,
    originalDocumentDigest: digest(null),
    ...(list
      ? {
          listPayload: { title: 'Name' },
          desiredList: { id: 'list', name: 'Name', images: [image], count: 0 },
          originalListDocumentDigest: digest(null),
        }
      : {}),
  };
  const checkpoint = { ...raw, checkpointDigest: digest(raw) } as SpeakerCreateTailCheckpoint;
  const statePath = 'temporalPublishingSpeakerCreationState/' + providerReceiptId('job', 'speaker');
  mockRows.set(statePath, { ...checkpoint, state: 'captured' });
  mockRows.set('durableJobs/job', { generation: 1, workflowId: 'workflow' });
  const receipt = (stage: 'speaker-tag-create' | 'list-create', result: any) => {
    const key = 'original:' + (stage === 'speaker-tag-create' ? 'create-speaker-tag' : 'create-speaker-list');
    mockRows.set(PROVIDER_RECEIPTS_COLLECTION + '/' + providerReceiptId(key, stage), {
      operationKey: key,
      step: stage,
      projectId: 'urm-app',
      jobId: 'job',
      providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
      fingerprint: fp(stage === 'speaker-tag-create' ? checkpoint.tagPayload : checkpoint.listPayload),
      state: 'confirmed',
      result,
    });
  };
  receipt('speaker-tag-create', { tagId: 'tag' });
  jest.mocked(axios).mockImplementation(async (config: any) => {
    mockEvents.push(config.method + ':' + config.url);
    if (config.method === 'POST') return { status: 201, data: { id: 'remote-list' } };
    if (config.url.includes('/tags/'))
      return {
        status: 200,
        data: {
          id: 'tag',
          app_key: '9XTSHD',
          type: 'speaker',
          title: 'Name',
          _embedded: { 'square-image': { id: 'remote-square' } },
        },
      };
    return {
      status: 200,
      data: {
        id: 'remote-list',
        app_key: '9XTSHD',
        title: 'Name',
        _embedded: { images: [{ id: 'remote-square', type: 'square' }] },
      },
    };
  });
  const run = () =>
    completeConfirmedSpeakerCreate(
      input,
      { tagId: 'tag' },
      { checkpoint, speakerId: 'speaker', firestore: mockDb as Firestore, commitCurrent: async (fn) => fn(mockTx) }
    );
  return { input, checkpoint, run, statePath, receipt };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockRows.clear();
  mockEvents.length = 0;
  mockRevoke = false;
});
it('resumes confirmed tag through only the original remaining list primitive and guarded canonical commit', async () => {
  const f = fixture(true);
  expect(await f.run()).toMatchObject({ speakerId: 'speaker', listSubsplashId: 'remote-list' });
  expect(executeProviderCreate).toHaveBeenCalledTimes(1);
  expect(mockEvents.filter((v) => v.startsWith('POST:'))).toEqual(['POST:https://core.subsplash.com/builder/v1/lists']);
  expect(repairMismatchedSubsplashImageRefs).not.toHaveBeenCalled();
  expect(mockEvents.at(-1)).toBe('settled');
});
it('confirmed original list skips all allocation POSTs', async () => {
  const f = fixture(true);
  f.receipt('list-create', { listId: 'remote-list' });
  await f.run();
  expect(executeProviderCreate).not.toHaveBeenCalled();
  expect(mockEvents.some((v) => v.startsWith('POST:'))).toBe(false);
});
it('completed replay preserves derived count and performs no HTTP or canonical write', async () => {
  const f = fixture();
  mockRows.set(f.statePath, { ...f.checkpoint, state: 'completed', tagId: 'tag' });
  mockRows.set('speakers/speaker', {
    ...f.checkpoint.desiredSpeaker,
    tagId: 'tag',
    sermonCount: 17,
    extra: 'preserve',
  });
  expect(await f.run()).toMatchObject({ speaker: { sermonCount: 17 } });
  expect(axios).not.toHaveBeenCalled();
  expect(mockEvents).toEqual([]);
});
it('changed canonical base refuses remaining provider allocations', async () => {
  const f = fixture(true);
  mockRows.set('speakers/speaker', { name: 'Other' });
  await expect(f.run()).rejects.toThrow('original speaker create');
  expect(axios).not.toHaveBeenCalled();
  expect(executeProviderCreate).not.toHaveBeenCalled();
});
it('wrong fixed tag account refuses the remaining list POST', async () => {
  const f = fixture(true);
  jest
    .mocked(axios)
    .mockResolvedValue({ status: 200, data: { id: 'tag', app_key: 'OTHER', type: 'speaker', title: 'Name' } });
  await expect(f.run()).rejects.toThrow();
  expect(executeProviderCreate).not.toHaveBeenCalled();
});
it('original tag receipt remains required even when selected list is confirmed', async () => {
  const f = fixture(true);
  f.receipt('list-create', { listId: 'remote-list' });
  mockRows.delete(
    PROVIDER_RECEIPTS_COLLECTION + '/' + providerReceiptId('original:create-speaker-tag', 'speaker-tag-create')
  );
  await expect(f.run()).rejects.toThrow();
  expect(axios).not.toHaveBeenCalled();
});
it('checkpoint tampering fails before any provider action', async () => {
  const f = fixture();
  f.checkpoint.desiredSpeaker.name = 'Changed';
  expect(() => validateSpeakerCreateTailCheckpoint(f.checkpoint, f.input, 'speaker')).toThrow();
  await expect(f.run()).rejects.toThrow();
  expect(axios).not.toHaveBeenCalled();
});
it('canonical race before final commit cannot overwrite the changed row', async () => {
  const f = fixture();
  jest.mocked(axios).mockImplementation(async () => {
    mockRows.set('speakers/speaker', { name: 'Concurrent' });
    return {
      status: 200,
      data: {
        id: 'tag',
        app_key: '9XTSHD',
        type: 'speaker',
        title: 'Name',
        _embedded: { 'square-image': { id: 'remote-square' } },
      },
    };
  });
  await expect(f.run()).rejects.toThrow();
  expect(mockRows.get('speakers/speaker')).toEqual({ name: 'Concurrent' });
  expect(mockEvents).not.toContain('settled');
});

it('captures resolved image program before original tag POST, then retries without image repair or repeated POST', async () => {
  const f = fixture(true);
  mockRows.clear();
  const input = { ...f.input, operationKey: 'durable:urm-app:job:speaker-create' };
  mockRows.set('durableJobs/job', { projectId: 'urm-app', jobId: 'job', generation: 1, workflowId: 'workflow' });
  mockRows.set('durableJobIntents/job', { generation: 1, kind: 'speaker.mutate', entity: { id: 'speaker' } });
  jest.mocked(repairMismatchedSubsplashImageRefs).mockImplementation(async (images: any) => {
    mockEvents.push('images-resolved');
    return images;
  });
  jest.mocked(axios).mockImplementation(async (config: any) => {
    mockEvents.push(config.method + ':' + config.url);
    if (config.method === 'POST' && config.url.includes('/tags/')) {
      const checkpoint = mockRows.get('temporalPublishingSpeakerCreationState/' + providerReceiptId('job', 'speaker'));
      expect(checkpoint?.state).toBe('captured');
      expect(checkpoint?.tagPayload.squareImage.subsplashId).toBe('remote-square');
      return { status: 201, data: { id: 'tag' } };
    }
    if (config.method === 'POST') return { status: 201, data: { id: 'remote-list' } };
    return config.url.includes('/tags/')
      ? {
          status: 200,
          data: {
            id: 'tag',
            app_key: '9XTSHD',
            type: 'speaker',
            title: 'Name',
            _embedded: { 'square-image': { id: 'remote-square' } },
          },
        }
      : {
          status: 200,
          data: {
            id: 'remote-list',
            app_key: '9XTSHD',
            title: 'Name',
            _embedded: { images: [{ id: 'remote-square', type: 'square' }] },
          },
        };
  });
  await createSpeakerMutation(input, { speakerId: 'speaker' });
  const originalPosts = mockEvents.filter((e) => e.startsWith('POST:'));
  expect(originalPosts).toHaveLength(2);
  expect(mockEvents[0]).toBe('images-resolved');
  expect(repairMismatchedSubsplashImageRefs).toHaveBeenCalledTimes(1);
  mockEvents.length = 0;
  await createSpeakerMutation(input, { speakerId: 'speaker' });
  expect(mockEvents.some((e) => e.startsWith('POST:'))).toBe(false);
  expect(repairMismatchedSubsplashImageRefs).toHaveBeenCalledTimes(1);
});
it('fresh actor revocation before checkpoint commit prevents tag POST', async () => {
  const f = fixture();
  mockRows.clear();
  mockRows.set('durableJobs/job', { projectId: 'urm-app', jobId: 'job', generation: 1, workflowId: 'workflow' });
  mockRows.set('durableJobIntents/job', { generation: 1, kind: 'speaker.mutate', entity: { id: 'speaker' } });
  mockRevoke = true;
  await expect(
    createSpeakerMutation({ ...f.input, operationKey: 'durable:urm-app:job:speaker-create' }, { speakerId: 'speaker' })
  ).rejects.toThrow('ACTOR_REVOKED');
  expect(axios).not.toHaveBeenCalled();
});
