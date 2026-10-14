import { createHash } from 'node:crypto';
import {
  computeProcessAudioRequestVersion,
  normalizeProcessAudioRequest,
} from '@upperroom/contracts/processAudioQueue';
import { legacyMediaAdmissionId } from '@upperroom/orchestration/legacy-media-execution';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { prepareLegacyMediaAdmission, withLegacyMediaExecution } from '@upperroom/orchestration/legacy-media-execution';

// Synthetic native server snapshots deliberately advance server readTime beyond
// grace. Actual object/canonical/lease commits are covered by the emulator suite;
// this unit fixture never represents an hour elapsed in a live environment.
function fixture() {
  const cutoff = new Timestamp(1000, 123),
    created = new Timestamp(900, 456),
    now = new Timestamp(9000, 789);
  const payload = { id: 'original', storageFilePath: 'sermons/original', startTime: 0, duration: 20 };
  const rows = new Map<string, { data: Record<string, any>; created: Timestamp }>();
  const seed = (path: string, data: Record<string, any>) => rows.set(path, { data, created });
  seed('_control/temporalRelease', {
    schemaVersion: 1,
    revision: 1,
    releaseId: 'source-test',
    admission: 'paused',
    domains: { media: { owner: 'legacy', admission: 'paused' } },
    legacyAdmissionCutoff: cutoff,
  });
  seed('_control/temporalReleaseState', {
    mode: 'initial-cutover',
    releaseId: 'source-test',
    legacySettlingCutoff: cutoff,
    compatibilityVerifiedAt: cutoff,
    legacySettlingGraceSeconds: 3600,
    maximumLegacyExecutionSeconds: 3600,
  });
  seed('sermons/original', {
    uploaderId: 'owner',
    sourceStartTime: 0,
    trimDurationSeconds: 20,
    status: { audioStatus: 'PENDING' },
  });
  seed('legacyAdmissionLeases/original-source-lease', {
    schemaVersion: 1,
    leaseId: 'original-source-lease',
    projectId: 'project',
    domain: 'media',
    actorUid: 'system:firebase-event',
    operation: 'sermonaudiocreatetrigger',
    state: 'active',
    effectsStarted: true,
    legacySourceSermonId: 'original',
    legacySourceOwnerUid: 'owner',
  });
  const field = (data: any, path: string): any => path.split('.').reduce((value, key) => value?.[key], data);
  const materialize = (value: any): any => {
    if (value instanceof Timestamp) return value;
    if (value instanceof FieldValue) return now;
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, materialize(v)]));
    return value;
  };
  const doc = (path: string) => ({ path, id: path.split('/').at(-1)! });
  const snapshot = (ref: ReturnType<typeof doc>) => ({
    ref,
    id: ref.id,
    exists: rows.has(ref.path),
    createTime: rows.get(ref.path)?.created,
    readTime: now,
    data: () => rows.get(ref.path)?.data,
    get: (path: string) => field(rows.get(ref.path)?.data, path),
  });
  const db = {
    doc,
    runTransaction: async (callback: any) =>
      callback({
        get: async (ref: ReturnType<typeof doc>) => snapshot(ref),
        create: (ref: ReturnType<typeof doc>, data: Record<string, any>) => {
          if (rows.has(ref.path)) throw new Error('exists');
          rows.set(ref.path, { data: materialize(data), created: now });
        },
        update: (ref: ReturnType<typeof doc>, data: Record<string, any>) =>
          Object.assign(rows.get(ref.path)!.data, materialize(data)),
      }),
  } as unknown as Firestore;
  const source = {
    kind: 'storage' as const,
    bucket: 'owned-bucket',
    path: 'sermons/original',
    generation: '123456789',
    timeCreated: '1970-01-01T00:10:00.000000000Z',
  };
  return {
    rows,
    payload,
    source,
    input: { firestore: db, projectId: 'project', payload },
    sourceInput: {
      firestore: db,
      projectId: 'project',
      payload,
      sourceLeaseId: 'original-source-lease',
      originalStorageSource: source,
      configuredSourceBucket: 'owned-bucket',
    },
  };
}
it('allows only typed original pending source to create its first proof and finish after the settling deadline', async () => {
  const f = fixture();
  await prepareLegacyMediaAdmission(f.sourceInput);
  await withLegacyMediaExecution({ ...f.input, taskId: 'original-task' }, async (source) => {
    expect(source).toEqual(f.source);
  });
  await withLegacyMediaExecution({ ...f.input, taskId: 'original-task', operation: 'execute' }, async (source) => {
    expect(source).toEqual(f.source);
  });
  expect([...f.rows].filter(([path]) => path.startsWith('legacyMediaSourceAdmissions/'))).toHaveLength(1);
  f.rows.get('sermons/original')!.data.status.audioStatus = 'PROCESSED';
  await expect(
    withLegacyMediaExecution({ ...f.input, taskId: 'original-task', operation: 'execute' }, async () => undefined)
  ).rejects.toThrow('no longer pending');
});
it('keeps ordinary new legacy dispatch expired without original source authority', async () => {
  const f = fixture();
  await expect(prepareLegacyMediaAdmission(f.input)).rejects.toThrow('window has ended');
});
it.each(['wrong-owner', 'new-canonical', 'wrong-path', 'later-object', 'changed-generation'])(
  'rejects late source privilege for %s',
  async (bad) => {
    const f = fixture();
    if (bad === 'wrong-owner') f.rows.get('sermons/original')!.data.uploaderId = 'foreign';
    if (bad === 'new-canonical') f.rows.get('sermons/original')!.created = new Timestamp(1001, 0);
    if (bad === 'wrong-path') f.sourceInput.originalStorageSource = { ...f.source, path: 'sermons/foreign' };
    if (bad === 'later-object')
      f.sourceInput.originalStorageSource = { ...f.source, timeCreated: '1970-01-01T00:15:01.000000000Z' };
    if (bad === 'changed-generation') {
      await prepareLegacyMediaAdmission(f.sourceInput);
      f.sourceInput.originalStorageSource = { ...f.source, generation: '987654321' };
    }
    await expect(prepareLegacyMediaAdmission(f.sourceInput)).rejects.toThrow();
  }
);

it('a protected task admitted before cutoff can first dispatch and execute after grace without renewing admission', async () => {
  const f = fixture(),
    proofAt = new Timestamp(950, 123),
    id = legacyMediaAdmissionId(f.payload);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(normalizeProcessAudioRequest(f.payload)))
    .digest('hex');
  f.rows.set(`legacyMediaAdmissions/${id}`, {
    created: proofAt,
    data: {
      schemaVersion: 1,
      projectId: 'project',
      sermonId: f.payload.id,
      requestVersion: computeProcessAudioRequestVersion(f.payload),
      payloadFingerprint: fingerprint,
      admittedBefore: proofAt,
      sermonCreateTime: f.rows.get('sermons/original')!.created,
      uploaderId: 'owner',
      canonicalYouTubeUrl: null,
    },
  });
  await prepareLegacyMediaAdmission({
    ...f.input,
    originalStorageSource: f.source,
    configuredSourceBucket: f.source.bucket,
  });
  await withLegacyMediaExecution({ ...f.input, taskId: 'accepted-original' }, async (source) =>
    expect(source).toEqual(f.source)
  );
  await withLegacyMediaExecution({ ...f.input, taskId: 'accepted-original', operation: 'execute' }, async (source) =>
    expect(source).toEqual(f.source)
  );
  expect(f.rows.get(`legacyMediaAdmissions/${id}`)!.created).toEqual(proofAt);
  f.rows.get('sermons/original')!.data.youtubeUrl = 'https://www.youtube.com/watch?v=new-source';
  await expect(
    withLegacyMediaExecution({ ...f.input, taskId: 'accepted-original', operation: 'execute' }, async () => undefined)
  ).rejects.toThrow();
});
