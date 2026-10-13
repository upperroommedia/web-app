import { normalizeUploadSource, verifyUploadObject } from './sourceSessions';
import type { Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
const fingerprint = { algorithm: 'sha256-chunks-v1', chunkBytes: 4194304, value: 'a'.repeat(64) };
const input = {
  sermon: { title: 'Sermon', uploaderId: 'attacker', subsplashId: 'remote' },
  source: { type: 'file', name: 'recording.mp3', size: 123, lastModified: 1000, fingerprint },
  trimStart: 0,
  duration: 60,
};
const db = { collection: jest.fn(() => ({ doc: jest.fn((id: string) => ({ id })) })) } as unknown as Firestore;
describe('durable upload source admission', () => {
  it('derives immutable server path and canonical identity rather than trusting provider identifiers', () => {
    const plan = normalizeUploadSource(input, 'owner', 'job-123', db);
    expect(plan.sermon.uploaderId).toBe('owner');
    expect(plan.sermon.subsplashId).toBeUndefined();
    expect(plan.sourceUpload?.storagePath).toBe('durable-upload-sources/owner/job-123/source');
  });
  it('rejects missing content fingerprint and unsafe YouTube hosts', () => {
    expect(() =>
      normalizeUploadSource({ ...input, source: { ...input.source, fingerprint: undefined } }, 'owner', 'job-123', db)
    ).toThrow();
    expect(() =>
      normalizeUploadSource(
        { ...input, source: { type: 'youtube', url: 'https://youtube.com.evil.invalid/watch?v=123' } },
        'owner',
        'job-123',
        db
      )
    ).toThrow();
  });
  it('pins a specific object generation with exact size and metadata', async () => {
    const descriptor = normalizeUploadSource(input, 'owner', 'job-123', db).sourceUpload!;
    const getMetadata = jest.fn().mockResolvedValue([
      {
        generation: '99',
        size: '123',
        metadata: { durableJobId: 'job-123', fingerprint: JSON.stringify(fingerprint) },
      },
    ]);
    const file = jest.fn(() => ({ getMetadata }));
    const bucket = { file } as unknown as Bucket;
    await expect(
      verifyUploadObject(bucket, { actorUid: 'owner', sourceUpload: descriptor }, 'job-123', {
        storagePath: descriptor.storagePath,
        generation: '99',
      })
    ).resolves.toBe('99');
    expect(file).toHaveBeenCalledWith(descriptor.storagePath, { generation: '99' });
    getMetadata.mockResolvedValue([
      {
        generation: '100',
        size: '123',
        metadata: { durableJobId: 'job-123', fingerprint: JSON.stringify(fingerprint) },
      },
    ]);
    await expect(
      verifyUploadObject(bucket, { actorUid: 'owner', sourceUpload: descriptor }, 'job-123', {
        storagePath: descriptor.storagePath,
        generation: '99',
      })
    ).rejects.toThrow();
  });
  it('rejects an unreserved object without reading storage', async () => {
    const descriptor = normalizeUploadSource(input, 'owner', 'job-123', db).sourceUpload!;
    const file = jest.fn();
    await expect(
      verifyUploadObject({ file } as unknown as Bucket, { actorUid: 'owner', sourceUpload: descriptor }, 'job-123', {
        storagePath: 'another/object',
        generation: '99',
      })
    ).rejects.toThrow();
    expect(file).not.toHaveBeenCalled();
  });
});
