import { mediaArtifactProtection, normalizeMediaCleanupInput } from './artifactCleanup';
import {
  MEDIA_RETENTION_MS,
  prepareMediaReference,
  prepareMediaReferenceRelease,
} from '../../../packages/orchestration/src/media-artifacts';

const now = 200 * 86400000;
const record = {
  projectId: 'p',
  sermonId: 's',
  path: 'workflow-audio/s/version/source.mp3',
  generation: '7',
  createdAt: 0,
  eligibleAfter: MEDIA_RETENTION_MS,
  status: 'retained' as const,
};
const policy = { projectId: 'p', now, retentionMs: MEDIA_RETENTION_MS, hasActiveReference: false };
test('dry-run is default and backup retention cannot be shortened', () => {
  expect(normalizeMediaCleanupInput({ operation: 'media_artifacts_cleanup' })).toEqual({
    operation: 'media_artifacts_cleanup',
    dryRun: true,
    retentionDays: 90,
    maxPages: 20,
  });
  expect(() => normalizeMediaCleanupInput({ operation: 'media_artifacts_cleanup', retentionDays: 89 })).toThrow();
  expect(() => normalizeMediaCleanupInput({ operation: 'media_artifacts_cleanup', maxPages: 101 })).toThrow();
});
test('current sources, active provider fetches and backup restore windows always protect old artifacts', () => {
  expect(mediaArtifactProtection(record, { ...policy, hasActiveReference: true })).toBe('ACTIVE_REFERENCE');
  expect(mediaArtifactProtection({ ...record, backupProtectedUntil: now + 1 }, policy)).toBe('BACKUP_RESTORE_HOLD');
  expect(mediaArtifactProtection({ ...record, lastReferenceReleasedAt: now - 86400000 }, policy)).toBe(
    'RETENTION_WINDOW'
  );
  expect(mediaArtifactProtection(record, policy)).toBeNull();
  expect(mediaArtifactProtection(record, { ...policy, projectId: 'other' })).toBe('PROJECT_MISMATCH');
});
test('a deleting generation rejects new leases; a released reference restarts the full restore window', async () => {
  const writes: any[] = [];
  let stored = { ...record, status: 'deleting' as string };
  const document: any = { collection: () => ({ doc: () => document }) };
  const db: any = { collection: () => ({ doc: () => document }) };
  const tx: any = {
    get: async () => ({ exists: true, data: () => stored, get: (key: string) => stored[key as keyof typeof stored] }),
    set: (_ref: any, value: any) => writes.push(value),
    update: (_ref: any, value: any) => writes.push(value),
  };
  await expect(
    prepareMediaReference(tx, db, {
      artifactId: 'a',
      projectId: 'p',
      type: 'publishing_job',
      id: 'job',
      createdAt: now,
    })
  ).rejects.toThrow();
  expect(writes).toEqual([]);
  stored = { ...record, status: 'retained' };
  const release = await prepareMediaReferenceRelease(tx, db, {
    artifactId: 'a',
    projectId: 'p',
    type: 'publishing_job',
    id: 'job',
    releasedAt: now,
  });
  expect(writes).toEqual([]);
  release();
  expect(writes[1]).toEqual({ lastReferenceReleasedAt: now, eligibleAfter: now + MEDIA_RETENTION_MS });
});
