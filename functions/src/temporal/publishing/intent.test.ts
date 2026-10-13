import { normalizePublishingIntent } from './intent';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';
const sermon = {
  id: 's1',
  uploaderId: 'owner',
  title: 'Original',
  subtitle: 'sub',
  description: 'desc',
  speakers: [],
  topics: [],
  images: [],
  dateMillis: 1,
  seriesId: 'series1',
  audioArtifacts: { finalPath: 'immutable/job/audio.mp3' },
} as unknown as Sermon;
describe('publishing admission snapshot', () => {
  it('ignores client provider IDs and uses canonical immutable audio artifact', () => {
    const intent = normalizePublishingIntent(
      {
        kind: 'sermon.publish',
        generation: 2,
        payload: { subsplashId: 'attacker', destinations: { listIds: ['l1', 'l1'], soundcloud: true } },
      },
      sermon,
      { uid: 'publisher', role: 'publisher' }
    );
    expect(intent.destinations.listIds).toEqual(['l1']);
    expect(intent.payload.audioStoragePath).toBe('immutable/job/audio.mp3');
    expect(intent.payload).not.toHaveProperty('subsplashId');
  });
  it('rejects an unrelated series and invalid selection shape', () => {
    expect(() =>
      normalizePublishingIntent(
        { kind: 'sermon.publish', generation: 1, payload: { destinations: { seriesId: 'other' } } },
        sermon,
        { uid: 'admin', role: 'admin' }
      )
    ).toThrow('does not match');
    expect(() =>
      normalizePublishingIntent(
        { kind: 'sermon.publish', generation: 1, payload: { destinations: { listIds: ['invalid/path'] } } },
        sermon,
        { uid: 'admin', role: 'admin' }
      )
    ).toThrow('invalid');
  });
  it('snapshots metadata patch without permitting provider/status rewrites', () => {
    const intent = normalizePublishingIntent(
      {
        kind: 'sermon.update',
        generation: 1,
        payload: { patch: { title: 'Updated', subsplashId: 'fake', status: { soundCloud: 'UPLOADED' } } },
      },
      sermon,
      { uid: 'admin', role: 'admin' }
    );
    expect(intent.payload.patch).toEqual({ title: 'Updated' });
    expect((intent.payload.sermon as Sermon).title).toBe('Updated');
    expect(sermon.title).toBe('Original');
  });
  it('permits own unpublished uploader metadata but rejects publishing', () => {
    expect(() =>
      normalizePublishingIntent(
        { kind: 'sermon.update', generation: 1, payload: { patch: { title: 'Updated' } } },
        sermon,
        { uid: 'owner', role: 'uploader' }
      )
    ).not.toThrow();
    expect(() =>
      normalizePublishingIntent({ kind: 'sermon.publish', generation: 1, payload: {} }, sermon, {
        uid: 'owner',
        role: 'uploader',
      })
    ).toThrow('permission');
  });
  it('permits deletion of an owned unpublished sermon but requires publisher permission for provider cleanup', () => {
    expect(() =>
      normalizePublishingIntent({ kind: 'sermon.delete', generation: 1, payload: {} }, sermon, {
        uid: 'owner',
        role: 'uploader',
      })
    ).not.toThrow();
    expect(() =>
      normalizePublishingIntent(
        { kind: 'sermon.delete', generation: 1, payload: {} },
        { ...sermon, subsplashId: 'remote' },
        { uid: 'owner', role: 'uploader' }
      )
    ).toThrow('permission');
  });
  it('reconciles nested membership selections and discards client provider ordering', () => {
    const intent = normalizePublishingIntent(
      {
        kind: 'sermon.update',
        generation: 1,
        payload: {
          patch: { title: 'Updated' },
          destinations: { listIds: ['new'], seriesId: 'new-series' },
          publishedItemOrder: ['client-provider-id'],
          expectedPublishedMembershipHash: 'forged',
        },
      },
      sermon,
      { uid: 'admin', role: 'admin' }
    );
    expect(intent.payload.hasMembershipSelection).toBe(true);
    expect(intent.payload.desiredSeriesId).toBe('new-series');
    expect(intent.payload.patch).toEqual({ title: 'Updated', seriesId: 'new-series' });
    expect(intent.payload.publishedItemOrder).toBeUndefined();
    expect(intent.payload.expectedPublishedMembershipHash).toBeUndefined();
  });
  it('requires an explicit SoundCloud audio replacement decision for an existing track', () => {
    const published = { ...sermon, soundCloudTrackId: 'old-track' } as Sermon;
    expect(() =>
      normalizePublishingIntent(
        { kind: 'sermon.update', generation: 1, payload: { patch: {}, processAudio: { startTime: 0, duration: 10 } } },
        published,
        { uid: 'admin', role: 'admin' }
      )
    ).toThrow('SoundCloud');
    const intent = normalizePublishingIntent(
      {
        kind: 'sermon.update',
        generation: 1,
        payload: { patch: {}, processAudio: { startTime: 0, duration: 10, soundcloudPolicy: 'keep_existing_audio' } },
      },
      published,
      { uid: 'admin', role: 'admin' }
    );
    expect(intent.payload.processAudio).toEqual({
      startTime: 0,
      duration: 10,
      soundcloudPolicy: 'keep_existing_audio',
    });
  });
  it('rejects stale edit drafts while accepting the stable legacy timestamp sentinel', () => {
    expect(() =>
      normalizePublishingIntent(
        { kind: 'sermon.update', generation: 1, payload: { patch: {}, expectedEditedAtMillis: 1 } },
        sermon,
        { uid: 'admin', role: 'admin' }
      )
    ).toThrow('Refresh');
    expect(() =>
      normalizePublishingIntent(
        { kind: 'sermon.update', generation: 1, payload: { patch: {}, expectedEditedAtMillis: 0 } },
        sermon,
        { uid: 'admin', role: 'admin' }
      )
    ).not.toThrow();
  });
  it('preserves mixed destination removals as one durable intent', () => {
    const intent = normalizePublishingIntent(
      {
        kind: 'sermon.publish',
        generation: 1,
        payload: { destinations: { listIds: ['add'] }, removals: { listIds: ['remove'], soundcloud: true } },
      },
      sermon,
      { uid: 'admin', role: 'admin' }
    );
    expect(intent.payload.removals).toEqual({ listIds: ['remove'], soundcloud: true });
  });
});

describe('canonical reference hydration', () => {
  it('discards client URLs and provider IDs and snapshots canonical image data', async () => {
    const { normalizeCanonicalPublishingPatch } = await import('./intent');
    const firestore = {
      collection: jest.fn().mockReturnValue({ doc: jest.fn().mockImplementation((id) => ({ id })) }),
      getAll: jest.fn().mockResolvedValue([
        {
          id: 'image1',
          exists: true,
          data: () => ({
            downloadLink: 'https://trusted.invalid/file',
            subsplashId: 'canonical-remote',
            type: 'square',
          }),
        },
      ]),
    };
    const patch = await normalizeCanonicalPublishingPatch({
      patch: { images: [{ id: 'image1', downloadLink: 'http://127.0.0.1/private', subsplashId: 'attacker' }] },
      firestore: firestore as unknown as Parameters<typeof normalizeCanonicalPublishingPatch>[0]['firestore'],
    });
    expect(patch.images).toEqual([
      { id: 'image1', downloadLink: 'https://trusted.invalid/file', subsplashId: 'canonical-remote', type: 'square' },
    ]);
  });
  it('rejects missing references rather than using client fallback metadata', async () => {
    const { normalizeCanonicalPublishingPatch } = await import('./intent');
    const firestore = {
      collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue({}) }),
      getAll: jest.fn().mockResolvedValue([{ id: 'missing', exists: false }]),
    };
    await expect(
      normalizeCanonicalPublishingPatch({
        patch: { speakers: [{ id: 'missing', name: 'untrusted' }] },
        firestore: firestore as unknown as Parameters<typeof normalizeCanonicalPublishingPatch>[0]['firestore'],
      })
    ).rejects.toThrow('unavailable');
  });
  it('bounds speakers and rejects duplicate images before database calls', async () => {
    const { normalizeCanonicalPublishingPatch } = await import('./intent');
    const firestore = {} as Parameters<typeof normalizeCanonicalPublishingPatch>[0]['firestore'];
    await expect(
      normalizeCanonicalPublishingPatch({ patch: { speakers: ['a', 'b', 'c', 'd'].map((id) => ({ id })) }, firestore })
    ).rejects.toThrow('3');
    await expect(
      normalizeCanonicalPublishingPatch({ patch: { images: [{ id: 'same' }, { id: 'same' }] }, firestore })
    ).rejects.toThrow('Duplicate');
  });
});
