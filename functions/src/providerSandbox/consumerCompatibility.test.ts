/** Consumer/engine protocol proof only. Locks and create receipts execute callbacks;
 * this does not claim durable admission, receipt CAS, or deployed provider proof. */
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import type { SandboxResource } from './types';

const mockInitialMode = process.env.STAGING_PROVIDER_MODE;
const mockResources = new Map<string, SandboxResource>();
const mockOperations: Array<{ provider: string; method: string; path: string; context?: unknown }> = [];
let mockClock = 1000;
const mockKey = (provider: string, family: string, id: string) => JSON.stringify([provider, family, id]);
const mockAudio = Buffer.alloc(44 + 16000);
mockAudio.write('RIFF', 0);
mockAudio.writeUInt32LE(mockAudio.length - 8, 4);
mockAudio.write('WAVEfmt ', 8);
mockAudio.writeUInt32LE(16, 16);
mockAudio.writeUInt16LE(1, 20);
mockAudio.writeUInt16LE(1, 22);
mockAudio.writeUInt32LE(8000, 24);
mockAudio.writeUInt32LE(16000, 28);
mockAudio.writeUInt16LE(2, 32);
mockAudio.writeUInt16LE(16, 34);
mockAudio.write('data', 36);
mockAudio.writeUInt32LE(16000, 40);
type StoredAsset = { bytes: Buffer; metadata: Record<string, any> };
const mockAssets = new Map<string, StoredAsset>();
const mockDocuments = new Map<string, Record<string, any>>();
const mockTransactionReads: string[] = [];
const mockSnapshot = (path: string, documents = mockDocuments) => ({
  exists: documents.has(path),
  data: () => {
    const value = documents.get(path);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  },
  get: (field: string) => field.split('.').reduce<any>((current, key) => current?.[key], documents.get(path)),
});
const mockReference = (path: string): any => ({
  path,
  id: path.split('/').pop(),
  collection: (name: string) => mockCollection(path + '/' + name),
  get: async () => mockSnapshot(path),
});
const mockCollection = (path: string): any => ({ path, doc: (id: string) => mockReference(path + '/' + id) });
const mockFirestore = {
  doc: mockReference,
  collection: mockCollection,
  runTransaction: async <T>(work: (tx: any) => Promise<T>): Promise<T> => {
    const staged = new Map([...mockDocuments].map(([path, value]) => [path, JSON.parse(JSON.stringify(value))]));
    let writesStarted = false;
    const result = await work({
      get: async (ref: { path: string }) => {
        if (writesStarted) throw new Error('Firestore transaction read after write');
        mockTransactionReads.push(ref.path);
        return mockSnapshot(ref.path, staged);
      },
      create: (ref: { path: string }, value: Record<string, any>) => {
        writesStarted = true;
        if (staged.has(ref.path)) throw new Error('Firestore create precondition failed');
        staged.set(ref.path, JSON.parse(JSON.stringify(value)));
      },
      update: (ref: { path: string }, value: Record<string, any>) => {
        writesStarted = true;
        if (!staged.has(ref.path)) throw new Error('Firestore update precondition failed');
        staged.set(ref.path, { ...staged.get(ref.path), ...JSON.parse(JSON.stringify(value)) });
      },
    });
    mockDocuments.clear();
    for (const [path, value] of staged) mockDocuments.set(path, value);
    return result;
  },
};
let mockGeneration = 100;
const mockReadStream = jest.fn((bytes: Buffer, _options?: unknown) =>
  Readable.from([Buffer.from(bytes.subarray(0, 44)), Buffer.from(bytes.subarray(44))])
);
const mockDownload = jest.fn(async (bytes: Buffer, { start, end }: { start: number; end: number }) => [
  Buffer.from(bytes.subarray(start, end + 1)),
]);
const mockWrites = jest.fn();
const mockBucket = {
  name: 'urm-app-staging.firebasestorage.app',
  file: jest.fn((path: string, options?: { generation?: string }) => {
    const stored = () => {
      const asset = mockAssets.get(path);
      if (!asset || (options?.generation && options.generation !== asset.metadata.generation))
        throw Object.assign(new Error('Storage object/generation not found: ' + path), { code: 404 });
      return asset;
    };
    return {
      name: path,
      bucket: { name: 'urm-app-staging.firebasestorage.app' },
      getMetadata: jest.fn(async () => [JSON.parse(JSON.stringify(stored().metadata))]),
      createReadStream: (readOptions: unknown) => mockReadStream(stored().bytes, readOptions),
      download: (downloadOptions: { start: number; end: number }) => mockDownload(stored().bytes, downloadOptions),
      createWriteStream: (writeOptions: Record<string, any>) => {
        mockWrites(path, writeOptions);
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
          final(callback) {
            if (writeOptions.preconditionOpts?.ifGenerationMatch !== 0 || mockAssets.has(path)) {
              callback(Object.assign(new Error('Storage create precondition failed'), { code: 412 }));
              return;
            }
            const bytes = Buffer.concat(chunks);
            mockAssets.set(path, {
              bytes,
              metadata: { ...writeOptions.metadata, generation: String(++mockGeneration), size: String(bytes.length) },
            });
            callback();
          },
        });
      },
    };
  }),
};
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    app: () => ({ options: { projectId: 'urm-app-staging' } }),
    firestore: () => mockFirestore,
    storage: () => ({
      bucket: (name: string) => {
        expect(name).toBe(mockBucket.name);
        return mockBucket;
      },
    }),
  },
}));
jest.mock('./store', () => ({
  ...jest.requireActual('./store'),
  runSandboxOperation: async (
    _profile: unknown,
    operation: { provider: string; method: string; path: string; context?: unknown },
    work: Function
  ) => {
    mockOperations.push(operation);
    const staged = new Map([...mockResources].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]));
    const store = {
      now: mockClock,
      // Native store identity checks include tombstones and pending writes.
      hasIdentity: async (provider: string, family: string, id: string) => staged.has(mockKey(provider, family, id)),
      get: async (provider: string, family: string, id: string, optional = false) => {
        const value = staged.get(mockKey(provider, family, id));
        if (!value || value.deleted) {
          if (optional) return undefined;
          throw Object.assign(new Error('not found'), { response: { status: 404 } });
        }
        return JSON.parse(JSON.stringify(value));
      },
      list: async (provider: string, family: string, filters: Record<string, string> = {}) =>
        [...staged.values()].filter(
          (value) =>
            value.provider === provider &&
            value.family === family &&
            !value.deleted &&
            Object.entries(filters).every(
              ([field, expected]) => field.split('.').reduce<any>((current, key) => current?.[key], value) === expected
            )
        ),
      put: (resource: SandboxResource) =>
        staged.set(mockKey(resource.provider, resource.family, resource.id), JSON.parse(JSON.stringify(resource))),
    };
    const result = await work(store, undefined);
    mockResources.clear();
    for (const [key, value] of staged) mockResources.set(key, value);
    return result;
  },
}));
jest.mock('../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: string[], work: () => Promise<unknown>) => work(),
}));
jest.mock('../temporal/publishing/providerReceipts', () => ({
  executeProviderCreate: async ({
    prepare,
    execute,
  }: {
    prepare?: () => Promise<unknown>;
    execute: () => Promise<unknown>;
  }) => {
    await prepare?.();
    return execute();
  },
  providerReceiptId: (operation: string, step: string) => `${operation}:${step}`,
  listProviderAcknowledgementsForJob: async () => [],
  sameResourceAcknowledgementProvesReceipt: () => false,
}));
jest.mock('../temporal/publishing/durableOperationContext', () => ({
  getDurablePublishingJobId: () => 'consumer-protocol-job',
  getPublishingSourceStepIds: () => ['subsplash-upload', 'soundcloud-upload'],
  isFactualPublishingCleanup: () => false,
  reserveDurableProviderBindings: async () => undefined,
}));
jest.mock('./oauth', () => ({
  verifySandboxSoundCloudAccessToken: async (_profile: unknown, token: string) => {
    if (token !== 'synthetic-consumer-access') throw new Error('Synthetic OAuth token required');
    return { id: '9000000000001', id_str: '9000000000001', urn: 'soundcloud:users:9000000000001' };
  },
}));
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const raw = jest.fn(() => {
    throw new Error('LIVE NETWORK FORBIDDEN');
  });
  Object.assign(raw, actual.default ?? actual, {
    request: jest.fn(() => {
      throw new Error('LIVE NETWORK FORBIDDEN');
    }),
    get: jest.fn(() => {
      throw new Error('LIVE NETWORK FORBIDDEN');
    }),
    post: jest.fn(() => {
      throw new Error('LIVE NETWORK FORBIDDEN');
    }),
    put: jest.fn(() => {
      throw new Error('LIVE NETWORK FORBIDDEN');
    }),
    delete: jest.fn(() => {
      throw new Error('LIVE NETWORK FORBIDDEN');
    }),
    patch: jest.fn(() => {
      throw new Error('LIVE NETWORK FORBIDDEN');
    }),
    head: jest.fn(() => {
      throw new Error('LIVE NETWORK FORBIDDEN');
    }),
    options: jest.fn(() => {
      throw new Error('LIVE NETWORK FORBIDDEN');
    }),
    create: jest.fn(() => {
      throw new Error('RAW NETWORK CLIENT FORBIDDEN');
    }),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  });
  return { ...actual, __esModule: true, default: raw };
});
jest.mock('form-data', () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw new Error('MULTIPART AUDIO MUST NOT BE CONSTRUCTED');
  }),
}));

import rawAxios from 'axios';
import FormData from 'form-data';
import { uploadToSubsplashDomain, type UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '../uploadToSubsplash';
import { authenticateSubsplash, createAxiosConfig } from '../subsplashUtils';
import { isSubsplashMediaPlayable } from '../temporal/publishing/providerReadiness';
import { prepareMultipartUpload, updateTrack } from '../soundcloudClient';
import { probeStageAsset } from './assets';
import { getProviderExecutionProfile } from './profile';
import { assertSandboxAssetPreparation } from './store';
import { durableEntityKey } from '@upperroom/orchestration/job-store';
import type { Bucket } from '@google-cloud/storage';

beforeEach(() => {
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  mockResources.clear();
  mockOperations.length = 0;
  mockDocuments.clear();
  mockTransactionReads.length = 0;
  const profile = {
    schemaVersion: 1,
    projectId: 'urm-app-staging',
    mode: 'sandbox',
    profileId: 'urm-app-staging-publishing-v1',
    version: 1,
    namespace: 'urm-app-staging-publishing-v1',
  };
  const providerExecution = { mode: 'sandbox', profileId: profile.profileId, version: 1, scenario: 'success' };
  const jobId = 'consumer-protocol-job',
    generation = 3,
    kind = 'sermon.publish' as const,
    entity = { type: 'sermon' as const, id: 'sermon-fixture' };
  mockDocuments.set('_providerSandbox/' + profile.profileId, {
    state: 'ready',
    profile,
    catalogImportId: 'consumer-fixture',
    sourceDigest: 'a'.repeat(64),
    resourceCount: 1,
    fixture: {
      bucket: mockBucket.name,
      path: 'audio/consumer.wav',
      generation: '100',
      size: mockAudio.length,
      sha256: createHash('sha256').update(mockAudio).digest('hex'),
      durationSeconds: 1,
      contentType: 'audio/wav',
    },
  });
  mockDocuments.set('durableJobIntents/' + jobId, {
    schemaVersion: 1,
    projectId: profile.projectId,
    jobId,
    generation,
    kind,
    entity,
    payload: { providerExecution },
  });
  mockDocuments.set('durableJobs/' + jobId, {
    schemaVersion: 1,
    projectId: profile.projectId,
    jobId,
    generation,
    kind,
    entity,
    state: 'running',
    providerExecution,
  });
  mockDocuments.set('durableJobEntities/' + durableEntityKey(profile.projectId, entity, kind), {
    generation,
    activeJobId: jobId,
  });

  mockClock = 1000;
  jest.clearAllMocks();
  mockAssets.clear();
  mockGeneration = 100;
  mockAssets.set('audio/consumer.wav', {
    bytes: Buffer.from(mockAudio),
    metadata: {
      generation: '100',
      size: String(mockAudio.length),
      contentType: 'audio/wav',
      metadata: { duration: '1' },
    },
  });
  mockResources.set(mockKey('soundcloud', 'accounts', '9000000000001'), {
    schemaVersion: 1,
    provider: 'soundcloud',
    family: 'accounts',
    id: '9000000000001',
    revision: 1,
    deleted: false,
    body: { id: '9000000000001', id_str: '9000000000001', urn: 'soundcloud:users:9000000000001' },
    createdAtMillis: mockClock,
    updatedAtMillis: mockClock,
  });
});
afterEach(() => {
  for (const transport of [
    rawAxios,
    rawAxios.request,
    rawAxios.get,
    rawAxios.post,
    rawAxios.put,
    rawAxios.delete,
    rawAxios.patch,
    rawAxios.head,
    rawAxios.options,
    rawAxios.create,
  ])
    expect(transport).not.toHaveBeenCalled();
  expect(FormData).not.toHaveBeenCalled();
  expect(mockTransactionReads).toEqual(
    expect.arrayContaining([
      '_providerSandbox/urm-app-staging-publishing-v1',
      'durableJobIntents/consumer-protocol-job',
      'durableJobs/consumer-protocol-job',
      'durableJobEntities/' +
        durableEntityKey('urm-app-staging', { type: 'sermon', id: 'sermon-fixture' }, 'sermon.publish'),
    ])
  );
  const preparations = [...mockDocuments]
    .filter(([path]) => path.startsWith('_providerSandbox/urm-app-staging-publishing-v1/preparedAssets/'))
    .map(([, value]) => value);
  expect(preparations).toHaveLength(1);
  expect(preparations[0]).toMatchObject({
    projectId: 'urm-app-staging',
    jobId: 'consumer-protocol-job',
    generation: 3,
    state: 'retained',
    target: { generation: '101', sha256: sourceHash() },
  });
});
afterAll(() => {
  if (mockInitialMode === undefined) delete process.env.STAGING_PROVIDER_MODE;
  else process.env.STAGING_PROVIDER_MODE = mockInitialMode;
});
const sourceHash = () => createHash('sha256').update(mockAudio).digest('hex');
async function assertIndependentPrivateCopy(resource: SandboxResource) {
  expect(resource.origin).toMatchObject({ path: 'audio/consumer.wav', generation: '100', sha256: sourceHash() });
  expect(resource.source!.path).toMatch(/^_providerSandbox\/urm-app-staging-publishing-v1\/media\/[^/]+\/asset$/);
  const copied = mockAssets.get(resource.source!.path)!;
  expect(copied.bytes).toEqual(mockAudio);
  expect(copied.bytes).not.toBe(mockAssets.get('audio/consumer.wav')!.bytes);
  expect(copied.metadata).toMatchObject({
    cacheControl: 'private, no-store',
    metadata: { originPath: 'audio/consumer.wav', originGeneration: '100', originSha256: sourceHash() },
  });
  expect(mockWrites).toHaveBeenCalledWith(
    resource.source!.path,
    expect.objectContaining({
      resumable: false,
      validation: 'crc32c',
      preconditionOpts: { ifGenerationMatch: 0 },
    })
  );
  // Delete the origin: subsequent private-object reads must still return the copied bytes.
  mockAssets.delete('audio/consumer.wav');
  const profile = getProviderExecutionProfile();
  if (profile.mode !== 'sandbox') throw new Error('Expected sandbox profile');
  const probe = await probeStageAsset(profile, resource.source!, 1024);
  expect(probe.size).toBe(mockAudio.length);
  expect(probe).toMatchObject({
    ok: true,
    contentType: 'audio/wav',
    sha256: createHash('sha256').update(mockAudio.subarray(0, 1024)).digest('hex'),
  });
}
it('real Subsplash upload/auth/config/facade emits compatible relationships and readiness after genuine measured source processing', async () => {
  const input: UPLOAD_TO_SUBSPLASH_INCOMING_DATA = {
    operationKey: 'consumer-subsplash',
    lockKey: 'sermon-fixture',
    title: 'Original sermon title',
    subtitle: 'Original subtitle',
    speakers: [],
    topics: ['Grace'],
    autoPublish: true,
    audioTitle: 'Original audio',
    audioUrl: 'https://storage.googleapis.com/urm-app-staging.firebasestorage.app/audio/consumer.wav?generation=100',
    description: 'Original summary',
    images: [],
    date: new Date('2026-10-14T00:00:00Z'),
  };
  const original = JSON.stringify(input);
  const profile = getProviderExecutionProfile();
  if (profile.mode !== 'sandbox') throw new Error('Expected staging sandbox');
  const entityPath =
    'durableJobEntities/' +
    durableEntityKey(profile.projectId, { type: 'sermon', id: 'sermon-fixture' }, 'sermon.publish');
  const currentEntity = mockDocuments.get(entityPath)!;
  mockDocuments.set(entityPath, { ...currentEntity, generation: currentEntity.generation + 1 });
  await expect(
    assertSandboxAssetPreparation(profile, { jobId: 'consumer-protocol-job', sourceStepIds: ['subsplash-upload'] })
  ).rejects.toThrow('superseded');
  expect(mockWrites).not.toHaveBeenCalled();
  mockDocuments.set(entityPath, currentEntity);
  const markerPath = '_providerSandbox/' + profile.profileId,
    currentMarker = mockDocuments.get(markerPath)!;
  mockDocuments.set(markerPath, { ...currentMarker, state: 'importing' });
  await expect(
    assertSandboxAssetPreparation(profile, { jobId: 'consumer-protocol-job', sourceStepIds: ['subsplash-upload'] })
  ).rejects.toMatchObject({ code: 'PROVIDER_SANDBOX_CATALOG_NOT_READY' });
  expect(mockWrites).not.toHaveBeenCalled();
  mockDocuments.set(markerPath, currentMarker);
  const token = await authenticateSubsplash();
  expect(token).toBe('provider-sandbox:urm-app-staging-publishing-v1:subsplash');
  expect(createAxiosConfig('https://core.subsplash.com/files/v1/audios', token, 'GET').headers).toEqual(
    expect.objectContaining({ Authorization: `Bearer ${token}` })
  );
  const commitCreatedMedia = jest.fn();
  const result = (await uploadToSubsplashDomain(input, {
    readExistingMedia: async () => undefined,
    commitCreatedMedia,
  })) as { id: string };
  expect(result.id).toEqual(expect.any(String));
  expect(commitCreatedMedia).toHaveBeenCalledWith(result);
  const media = mockResources.get(mockKey('subsplash', 'media-items', result.id))!;
  expect(media.body).toMatchObject({
    title: input.title,
    subtitle: input.subtitle,
    summary: input.description,
    tags: ['topic:Grace'],
    app_key: '9XTSHD',
  });
  const topic = [...mockResources.values()].find(
    (resource) => resource.family === 'tags' && resource.body.title === 'Grace'
  )!;
  expect(topic.body.type).toBe('topic');
  const tagging = [...mockResources.values()].find((resource) => resource.family === 'taggings')!;
  expect(tagging.body._embedded.tag.id).toBe(topic.id);
  expect(tagging.body._embedded['media-item'].id).toBe(media.id);
  const audioId = media.body._embedded.audio.id;
  const audio = mockResources.get(mockKey('subsplash', 'audios', audioId))!;
  const transcode = [...mockResources.values()].find((resource) => resource.family === 'jobs')!;
  expect(transcode.body._embedded.audio.id).toBe(audioId);
  expect(audio.source).toMatchObject({
    bucket: mockBucket.name,
    path: expect.stringMatching(/^_providerSandbox\/urm-app-staging-publishing-v1\/media\/[^/]+\/asset$/),
    generation: '101',
    size: mockAudio.length,
    sha256: sourceHash(),
    durationSeconds: 1,
    contentType: 'audio/wav',
  });
  await assertIndependentPrivateCopy(audio);
  expect(await isSubsplashMediaPlayable(result.id)).toBe(false);
  mockClock += 1000;
  expect(await isSubsplashMediaPlayable(result.id)).toBe(true);
  expect(mockReadStream).toHaveBeenCalledWith(expect.any(Buffer), { validation: 'crc32c' });
  expect(mockDownload).toHaveBeenCalledWith(expect.any(Buffer), { start: 0, end: 1023, validation: false });
  expect(JSON.stringify(input)).toBe(original);
  expect(mockOperations.filter((operation) => operation.method === 'POST').map((operation) => operation.path)).toEqual([
    '/files/v1/audios',
    '/transcoder/v1/jobs',
    '/media/v1/media-items',
  ]);
  for (const operation of mockOperations.filter((operation) => operation.method === 'POST'))
    expect(operation.context).toMatchObject({
      jobId: 'consumer-protocol-job',
      sourceStepIds: ['subsplash-upload', 'soundcloud-upload'],
    });
});
it('real SoundCloud prepared upload/update uses structured staged assets, preserves metadata and never constructs multipart audio', async () => {
  const params = {
    bucket: mockBucket as unknown as Bucket,
    audioStoragePath: 'audio/consumer.wav',
    title: 'Original track',
    tags: ['A phrase', 'Grace'],
    description: 'Original description',
    providerMetadata: { sharing: 'private', genre: 'Speech', downloadable: false },
  };
  const prepared = await prepareMultipartUpload(params);
  expect(mockResources.size).toBe(1);
  const result = await prepared.post('synthetic-consumer-access');
  expect(result.trackIdentifier).toMatch(/^soundcloud:tracks:[0-9]+$/);
  const id = result.trackIdentifier.replace('soundcloud:tracks:', '');
  const before = mockResources.get(mockKey('soundcloud', 'tracks', id))!;
  expect(before.body).toMatchObject({
    title: params.title,
    description: params.description,
    sharing: 'private',
    genre: 'Speech',
    downloadable: false,
    tag_list: '"A phrase" Grace',
    user: { id: '9000000000001' },
  });
  expect(before.source).toMatchObject({ generation: '101', sha256: sourceHash(), size: mockAudio.length });
  await assertIndependentPrivateCopy(before);
  const updated = await updateTrack('synthetic-consumer-access', result.trackIdentifier, {
    title: 'Updated track',
    tags: ['Updated phrase'],
  });
  expect(updated?.trackIdentifier).toBe(result.trackIdentifier);
  const after = mockResources.get(mockKey('soundcloud', 'tracks', id))!;
  expect(after.body).toMatchObject({
    title: 'Updated track',
    tag_list: '"Updated phrase"',
    description: params.description,
    sharing: 'private',
    genre: 'Speech',
    downloadable: false,
    urn: before.body.urn,
    user: before.body.user,
  });
  expect(after.source).toEqual(before.source);
  expect(after.revision).toBe(before.revision + 1);
  await expect(prepared.post('synthetic-consumer-access')).rejects.toThrow('only be posted once');
  prepared.dispose();
  expect(mockOperations.map((operation) => [operation.method, operation.path])).toEqual([
    ['POST', '/tracks'],
    ['PUT', `/tracks/${encodeURIComponent(result.trackIdentifier)}`],
  ]);
});
