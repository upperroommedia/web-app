import { createPublishingMediaDependency } from './publishingDependency';
import { mediaArtifactId, mediaReferenceId } from '../../../packages/orchestration/src/media-artifacts';

test('publishing leases its admitted source after canonical final advances', async () => {
  const projectId = 'project';
  const oldPath = 'workflow-audio/sermon/old/final.mp3';
  const oldId = mediaArtifactId(projectId, oldPath);
  const newId = mediaArtifactId(projectId, 'workflow-audio/sermon/new/final.mp3');
  const records = new Map<string, any>([
    [`temporalMediaArtifacts/${oldId}`, { projectId, sermonId: 'sermon', path: oldPath, status: 'retained' }],
    ['temporalMediaCanonicalRefs/sermon', { artifactIds: { final: newId } }],
  ]);
  const collection = (path: string): any => ({
    doc: (id: string) => ({
      path: `${path}/${id}`,
      collection: (child: string) => collection(`${path}/${id}/${child}`),
    }),
  });
  const db: any = {
    collection,
    runTransaction: async (run: (tx: any) => Promise<unknown>) =>
      run({
        get: async (ref: any) => ({
          exists: records.has(ref.path),
          data: () => records.get(ref.path),
          get: (field: string) => field.split('.').reduce((value, key) => value?.[key], records.get(ref.path)),
        }),
        set: (ref: any, value: any) => records.set(ref.path, value),
      }),
  };
  const factory = createPublishingMediaDependency({
    firestore: db,
    bucket: {} as any,
    projectId,
    loadIntent: async () => ({ sermonId: 'sermon' } as any),
    assertCurrent: async () => {},
    assertCurrentInTransaction: async () => {},
    admitMedia: async () => {
      throw new Error('Unused');
    },
  });
  const ref = { projectId, jobId: 'publishing' };
  await factory.leasePublishingAudio(ref, 'sermon', oldPath);
  expect(
    records.has(`temporalMediaArtifacts/${oldId}/references/${mediaReferenceId('publishing_job', ref.jobId)}`)
  ).toBe(true);
  expect(records.has(`temporalMediaPublishingLeases/publishing/artifacts/${newId}`)).toBe(false);
  records.get(`temporalMediaArtifacts/${oldId}`).status = 'deleting';
  await expect(factory.leasePublishingAudio(ref, 'sermon', oldPath)).rejects.toThrow('unavailable');
  await expect(factory.leasePublishingAudio(ref, 'sermon', 'workflow-audio/another/old/final.mp3')).rejects.toThrow(
    'owned'
  );
});
