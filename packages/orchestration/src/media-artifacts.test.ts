import { Firestore, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import {
  assertMediaArtifactBucket,
  createMediaUploadRecord,
  mediaArtifactId,
  mediaRecoveryArtifactRecord,
  mediaReferenceId,
  MEDIA_RETENTION_MS,
  writeMediaUploadIntent,
} from './media-artifacts';

const projectId = 'urm-app-staging';
const releaseId = '13330954-291f-4a64-bb46-516339a61c91';
const operationId = '4f69a3b8-75bb-4ad6-adf4-3bb67cccb0d0';
const bucketName = 'urm-app-staging-mr-' + releaseId.replaceAll('-', '');
const registry = { releaseId, operationId, bucketName };
const requestVersion = '0123456789abcdef';
const jobId = 'media-recovery-' + operationId;
const path = 'workflow-audio/' + jobId + '/' + requestVersion + '/source-f0de878f-51e1-4146-a6d3-1cbd14ffb67c.wav';
const input = { projectId, jobId, sermonId: jobId, path, createdAt: 1000 };
const db = new Firestore({ projectId });
const id = mediaArtifactId(projectId, path);
const referenceId = mediaReferenceId('media_job', jobId);

function recordingTransaction() {
  const writes: { method: string; path: string; record: object }[] = [];
  const write = (method: string) => (ref: DocumentReference, record: object) => {
    writes.push({ method, path: ref.path, record });
  };
  return { writes, tx: { create: write('create'), set: write('set') } as unknown as Transaction };
}

function expectedRows(base: string, jobIndex: string, custody: object) {
  return [
    {
      method: 'create',
      path: base,
      record: {
        ...custody,
        projectId,
        sermonId: jobId,
        path,
        ownerJobId: jobId,
        generation: null,
        status: 'uploading',
        createdAt: 1000,
        eligibleAfter: 1000 + MEDIA_RETENTION_MS,
      },
    },
    {
      method: 'create',
      path: base + '/references/' + referenceId,
      record: { ...custody, projectId, type: 'media_job', jobId, state: 'active', createdAt: 1000 },
    },
    { method: 'set', path: jobIndex, record: { ...custody, artifactId: id } },
  ];
}

test('ordinary registry preserves the historical recovery job artifact and its references', () => {
  const { tx, writes } = recordingTransaction();
  expect(writeMediaUploadIntent(tx, db, input)).toBe(id);
  expect(writes).toEqual(
    expectedRows('temporalMediaArtifacts/' + id, 'temporalMediaJobArtifacts/' + jobId + '/artifacts/' + id, {})
  );
});

test('private artifact writes and its retained receipt resolve to the operation-specific registry', () => {
  const { tx, writes } = recordingTransaction();
  const art = createMediaUploadRecord(tx, db, input, { registry, requestVersion, bucketName });
  const root = '_control/temporalMediaRecoveryArtifacts-' + operationId;
  expect(art.path).toBe(root + '/artifacts/' + id);
  expect(art.path).toBe(mediaRecoveryArtifactRecord(db, registry, path).path);
  expect(writes).toEqual(expectedRows(art.path, root + '/jobs/' + jobId + '/artifacts/' + id, registry));
});

test('the default bucket and diagnostic registry cannot be cross-wired', () => {
  expect(() => assertMediaArtifactBucket(projectId, 'urm-app-staging.firebasestorage.app')).not.toThrow();
  expect(() => assertMediaArtifactBucket(projectId, bucketName)).toThrow();
  expect(() => assertMediaArtifactBucket(projectId, 'urm-app-staging.firebasestorage.app', registry)).toThrow();
  expect(() => assertMediaArtifactBucket('urm-app', bucketName, registry)).toThrow();
});

test('rejects another job, version or artifact stage before any registration write', () => {
  for (const changed of [
    { ...input, jobId: 'other' },
    { ...input, sermonId: 'other' },
    { ...input, path: path.replace(requestVersion, 'fedcba9876543210') },
    { ...input, path: path.replace('/source-', '/final-') },
    { ...input, path: path.replace('.wav', '.mp3') },
  ]) {
    const { tx, writes } = recordingTransaction();
    expect(() => createMediaUploadRecord(tx, db, changed, { registry, requestVersion, bucketName })).toThrow();
    expect(writes).toEqual([]);
  }
});
