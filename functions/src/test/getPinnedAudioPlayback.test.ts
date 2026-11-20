import { generateKeyPairSync } from 'node:crypto';
import { Storage, type Bucket } from '@google-cloud/storage';
import type { Firestore } from 'firebase-admin/firestore';
import { mediaArtifactId } from '@upperroom/orchestration/media-artifacts';
import { resolvePinnedAudioPlayback } from '../../../functions-media/src/getPinnedAudioPlayback';

jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: {} }));

const generation = '90071992547409931';
const ref = {
  jobId: 'original-job',
  projectId: 'urm-app-staging',
  sermonId: 'sermon',
  version: 'a'.repeat(16),
};
const path = `workflow-audio/${ref.sermonId}/${ref.version}/final-11111111-1111-4111-8111-111111111111.mp3`;

function fixture() {
  const artifact = {
    generation,
    path,
    projectId: ref.projectId,
    sermonId: ref.sermonId,
    ownerJobId: ref.jobId,
    status: 'retained',
  };
  const sermon = {
    uploaderId: 'owner',
    audioArtifacts: {
      finalPath: path,
      finalGeneration: generation,
      jobId: ref.jobId,
      requestVersion: ref.version,
    },
  };
  const projectId = ref.projectId;
  const documents = {
    'sermons/sermon': sermon,
    [`temporalMediaArtifacts/${mediaArtifactId(projectId, path)}`]: artifact,
  };
  const firestore = {
    projectId,
    collection: (collection: string) => ({ doc: (id: string) => `${collection}/${id}` }),
    runTransaction: async (fn: any) =>
      fn({
        get: async (key: keyof typeof documents) => ({
          exists: Object.hasOwn(documents, key),
          get: (field: string) => field.split('.').reduce<any>((value, part) => value?.[part], documents[key]),
        }),
      }),
  } as unknown as Firestore;
  const metadata = { generation, bucket: 'urm-app-staging.firebasestorage.app', name: path, contentType: 'audio/mpeg' };
  const sign = jest.fn(async (_options: any) => ['https://fixture.invalid/pinned.mp3']);
  const file = jest.fn(() => ({ getMetadata: async () => [metadata], getSignedUrl: sign }));
  const bucket = { name: metadata.bucket, file } as unknown as Bucket;
  const request = (uid = 'owner', role = 'uploader') => ({
    auth: { uid, token: { role } as any, rawToken: 'controlled' },
    data: { sermonId: ref.sermonId, generation },
  });
  return {
    artifact,
    sermon,
    metadata,
    sign,
    file,
    request,
    resolve: (input = request()) => resolvePinnedAudioPlayback(input, firestore, bucket, projectId),
  };
}

test('current owner and publisher can obtain a URL signed for the exact decimal generation', async () => {
  const f = fixture();
  await expect(f.resolve()).resolves.toEqual({ url: 'https://fixture.invalid/pinned.mp3' });
  await expect(f.resolve(f.request('publisher', 'publisher'))).resolves.toBeDefined();
  expect(f.file).toHaveBeenCalledWith(path);
  expect(f.sign).toHaveBeenCalledWith(
    expect.objectContaining({
      version: 'v4',
      action: 'read',
      queryParams: { generation },
    })
  );
});

test('stale client, unrelated user, changed Storage generation and wrong owner cannot sign', async () => {
  const f = fixture();
  await expect(f.resolve(f.request('foreign', 'uploader'))).rejects.toMatchObject({ code: 'permission-denied' });
  await expect(f.resolve({ ...f.request(), data: { sermonId: 'sermon', generation: '3' } })).rejects.toMatchObject({
    code: 'failed-precondition',
  });
  f.metadata.generation = '3';
  await expect(f.resolve()).rejects.toMatchObject({ code: 'failed-precondition' });
  f.metadata.generation = generation;
  f.artifact.ownerJobId = 'another-job';
  await expect(f.resolve()).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(f.sign).not.toHaveBeenCalled();
});

test('a selection changed while signing is withheld', async () => {
  const f = fixture();
  f.sign.mockImplementationOnce(async () => {
    f.sermon.audioArtifacts.finalGeneration = '3';
    return ['https://fixture.invalid/pinned.mp3'];
  });
  await expect(f.resolve()).rejects.toMatchObject({ code: 'failed-precondition' });
});

test('the Storage SDK signs the generation without rounding its decimal representation', async () => {
  const f = fixture();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const file = new Storage({
    credentials: {
      client_email: 'playback-fixture@example.invalid',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
  })
    .bucket(f.metadata.bucket)
    .file(path);
  f.sign.mockImplementationOnce((options) => file.getSignedUrl(options));
  const { url } = await f.resolve();
  expect(new URL(url).searchParams.get('generation')).toBe(generation);
});
