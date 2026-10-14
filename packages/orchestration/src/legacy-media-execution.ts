import { createHash, randomUUID } from 'node:crypto';
import { FieldValue, type Firestore, type DocumentSnapshot, type Timestamp } from 'firebase-admin/firestore';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import {
  computeProcessAudioRequestVersion,
  normalizeProcessAudioRequest,
} from '@upperroom/contracts/processAudioQueue';

export class LegacyMediaFenceError extends Error {
  readonly code = 'LEGACY_MEDIA_FENCED';
}
function reject(message: string): never {
  throw new LegacyMediaFenceError(message);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const legacyMediaAdmissionId = (payload: AddIntroOutroInputType) =>
  hash(`${payload.id}:${computeProcessAudioRequestVersion(payload)}`);
const fingerprint = (payload: AddIntroOutroInputType) => hash(JSON.stringify(normalizeProcessAudioRequest(payload)));
const timestamp = (value: unknown): value is Timestamp => {
  const t = value as Timestamp | undefined;
  return (
    !!t &&
    Number.isSafeInteger(t.seconds) &&
    Number.isSafeInteger(t.nanoseconds) &&
    t.nanoseconds >= 0 &&
    t.nanoseconds < 1e9
  );
};
const beforeOrEqual = (a: Timestamp, b: Timestamp) =>
  a.seconds < b.seconds || (a.seconds === b.seconds && a.nanoseconds <= b.nanoseconds);

/** Only Firestore readTime and native timestamps authorize the settling window. */
export function assertLegacyMediaWindow(control: DocumentSnapshot, release: DocumentSnapshot): void {
  assertMediaWindow(control, release, false);
}
function assertMediaWindow(control: DocumentSnapshot, release: DocumentSnapshot, originalSourcePending: boolean): void {
  if (!control.exists) return; // Before the first controlled migration, legacy remains the owner.
  const c = control.data()!;
  if (
    c.schemaVersion !== 1 ||
    typeof c.releaseId !== 'string' ||
    !c.releaseId ||
    !Number.isSafeInteger(c.revision) ||
    c.revision < 1 ||
    c.domains?.media?.owner !== 'legacy'
  )
    reject('Legacy media no longer owns this operation.');
  if (!['open', 'paused'].includes(c.admission) || !['open', 'paused'].includes(c.domains.media.admission))
    reject('Media release control is malformed.');
  if (!Object.prototype.hasOwnProperty.call(c, 'legacyAdmissionCutoff')) {
    const checkpoint = release.data();
    const phase = checkpoint?.phase === 'paused-for-recovery' ? checkpoint.pausedFrom : checkpoint?.phase;
    if (
      checkpoint?.mode === 'durable-upgrade' ||
      Object.prototype.hasOwnProperty.call(checkpoint ?? {}, 'legacySettlingCutoff') ||
      Object.prototype.hasOwnProperty.call(checkpoint ?? {}, 'compatibilityVerifiedAt') ||
      (phase && !['freezing-ui', 'ui-frozen'].includes(phase))
    )
      reject('Legacy settling authority is incomplete.');
  } else {
    const cutoff = c.legacyAdmissionCutoff;
    const state = release.data();
    const grace = state?.legacySettlingGraceSeconds;
    if (
      !timestamp(cutoff) ||
      !timestamp(state?.legacySettlingCutoff) ||
      !timestamp(state?.compatibilityVerifiedAt) ||
      !beforeOrEqual(cutoff, state!.compatibilityVerifiedAt) ||
      !beforeOrEqual(state!.compatibilityVerifiedAt, cutoff) ||
      !beforeOrEqual(cutoff, state!.legacySettlingCutoff) ||
      !beforeOrEqual(state!.legacySettlingCutoff, cutoff) ||
      state?.mode !== 'initial-cutover' ||
      state?.releaseId !== c.releaseId ||
      !Number.isSafeInteger(grace) ||
      grace < 3600 ||
      grace > 86400 ||
      !Number.isSafeInteger(state.maximumLegacyExecutionSeconds) ||
      state.maximumLegacyExecutionSeconds < 540 ||
      grace < state.maximumLegacyExecutionSeconds ||
      !timestamp(control.readTime)
    )
      reject('Legacy settling authority is incomplete.');
    const deadlineSeconds = cutoff.seconds + grace;
    if (
      !originalSourcePending &&
      (control.readTime.seconds > deadlineSeconds ||
        (control.readTime.seconds === deadlineSeconds && control.readTime.nanoseconds >= cutoff.nanoseconds))
    )
      reject('The legacy settling window has ended.');
  }
}
function assertProof(
  proof: DocumentSnapshot,
  payload: AddIntroOutroInputType,
  control: DocumentSnapshot,
  projectId: string
) {
  const p = proof.data();
  if (
    !proof.exists ||
    p?.schemaVersion !== 1 ||
    p.projectId !== projectId ||
    p.sermonId !== payload.id ||
    p.requestVersion !== computeProcessAudioRequestVersion(payload) ||
    p.payloadFingerprint !== fingerprint(payload) ||
    !timestamp(proof.createTime) ||
    !timestamp(p.admittedBefore) ||
    !beforeOrEqual(p.admittedBefore, proof.createTime)
  )
    reject('An immutable server admission is required.');
  const cutoff = control.get('legacyAdmissionCutoff');
  if (cutoff && (!timestamp(cutoff) || !timestamp(p!.admittedBefore) || !beforeOrEqual(p!.admittedBefore, cutoff)))
    reject('This request was not admitted before the compatibility cutoff.');
}
export type LegacyOriginalSource =
  | { kind: 'storage'; bucket: string; path: string; generation: string; timeCreated: string }
  | { kind: 'youtube'; url: string };
export type LegacyOriginalStorageSource = Extract<LegacyOriginalSource, { kind: 'storage' }>;

/** GCS timestamps can have less precision than Firestore. Compare the end of
 * the reported precision interval, never silently floor a later object to ms. */
function storageCreationUpperBound(value: unknown): { seconds: number; nanoseconds: number } {
  if (typeof value !== 'string') reject('Original object creation time is required.');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) reject('Original object creation time is malformed.');
  const seconds = Date.parse(`${match[1]}Z`) / 1000;
  const fraction = match[2] ?? '';
  const nanoseconds = Number(fraction.padEnd(9, '0')) + 10 ** (9 - fraction.length) - 1;
  if (!Number.isSafeInteger(seconds) || new Date(seconds * 1000).toISOString().slice(0, 19) !== match[1])
    reject('Original object creation time is malformed.');
  return { seconds, nanoseconds };
}
function originalSourceRecord(input: LegacyMediaExecutionInput, canonical: DocumentSnapshot) {
  const { payload } = input;
  if (
    !['PENDING', 'PROCESSING'].includes(canonical.get('status.audioStatus')) ||
    canonical.get('uploaderId') !== input.originalSourceOwnerUid ||
    canonical.get('sourceStartTime') !== payload.startTime ||
    canonical.get('trimDurationSeconds') !== payload.duration
  )
    reject('Original source is no longer pending with the admitted owner and selection.');
  let source: LegacyOriginalSource;
  if ('youtubeUrl' in payload) {
    if (canonical.get('youtubeUrl')?.trim() !== payload.youtubeUrl) reject('Original YouTube selection changed.');
    source = { kind: 'youtube', url: payload.youtubeUrl };
  } else {
    if (canonical.get('youtubeUrl')?.trim()) reject('Original source kind changed.');
    const object = input.originalStorageSource;
    if (
      !object ||
      !input.configuredSourceBucket ||
      object.bucket !== input.configuredSourceBucket ||
      object.kind !== 'storage' ||
      Object.keys(object).sort().join(',') !== 'bucket,generation,kind,path,timeCreated' ||
      object.path !== `sermons/${payload.id}` ||
      object.path !== payload.storageFilePath ||
      !/^[1-9][0-9]{0,30}$/.test(object.generation) ||
      !Number.isSafeInteger(Number(object.generation))
    )
      reject('The original owned storage object generation is required.');
    const createdUpper = storageCreationUpperBound(object.timeCreated);
    if (!canonical.createTime || !beforeOrEqual(createdUpper as Timestamp, canonical.createTime))
      reject('The current object was not completed before the original canonical admission.');
    source = object;
  }
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    sermonId: payload.id,
    requestVersion: computeProcessAudioRequestVersion(payload),
    payloadFingerprint: fingerprint(payload),
    sermonCreateTime: canonical.createTime,
    uploaderId: input.originalSourceOwnerUid!,
    source,
    sourceStartTime: payload.startTime,
    trimDurationSeconds: payload.duration,
  };
}
function validateOriginalSource(
  authority: DocumentSnapshot,
  input: LegacyMediaExecutionInput,
  canonical: DocumentSnapshot,
  control: DocumentSnapshot
): LegacyOriginalSource | undefined {
  if (!authority.exists) return undefined;
  const a = authority.data()!;
  if (
    a.schemaVersion !== 1 ||
    a.projectId !== input.projectId ||
    a.sermonId !== input.payload.id ||
    a.requestVersion !== computeProcessAudioRequestVersion(input.payload) ||
    a.payloadFingerprint !== fingerprint(input.payload) ||
    !timestamp(a.sermonCreateTime) ||
    !canonical.createTime?.isEqual(a.sermonCreateTime) ||
    !a.uploaderId ||
    !['PENDING', 'PROCESSING'].includes(canonical.get('status.audioStatus'))
  )
    reject('Original source authority is invalid or no longer pending.');
  const cutoff = control.get('legacyAdmissionCutoff');
  if (cutoff && (!timestamp(cutoff) || !beforeOrEqual(a.sermonCreateTime, cutoff)))
    reject('Original source was admitted after cutoff.');
  // Reuse the exact same selection/object validation for stored, immutable authority.
  const expected = originalSourceRecord(
    {
      ...input,
      originalSourceOwnerUid: a.uploaderId,
      originalStorageSource: a.source?.kind === 'storage' ? a.source : undefined,
      configuredSourceBucket: a.source?.kind === 'storage' ? a.source.bucket : undefined,
    },
    canonical
  );
  if (
    JSON.stringify(expected.source) !== JSON.stringify(a.source) ||
    expected.sourceStartTime !== a.sourceStartTime ||
    expected.trimDurationSeconds !== a.trimDurationSeconds
  )
    reject('Original source authority selection changed.');
  return expected.source;
}
function acceptedTaskPending(
  proof: DocumentSnapshot,
  input: LegacyMediaExecutionInput,
  canonical: DocumentSnapshot,
  control: DocumentSnapshot
): boolean {
  if (!proof.exists || !timestamp(proof.createTime)) return false;
  const cutoff = control.get('legacyAdmissionCutoff');
  if (
    !timestamp(cutoff) ||
    !beforeOrEqual(proof.createTime, cutoff) ||
    !canonical.createTime?.isEqual(proof.get('sermonCreateTime')) ||
    !['PENDING', 'PROCESSING'].includes(canonical.get('status.audioStatus')) ||
    canonical.get('sourceStartTime') !== input.payload.startTime ||
    canonical.get('trimDurationSeconds') !== input.payload.duration ||
    typeof proof.get('uploaderId') !== 'string' ||
    !proof.get('uploaderId') ||
    proof.get('uploaderId') !== canonical.get('uploaderId') ||
    proof.get('canonicalYouTubeUrl') === undefined ||
    proof.get('canonicalYouTubeUrl') !== (canonical.get('youtubeUrl')?.trim() || null)
  )
    return false;
  if ('youtubeUrl' in input.payload && canonical.get('youtubeUrl')?.trim() !== input.payload.youtubeUrl) return false;
  assertProof(proof, input.payload, control, input.projectId);
  return true;
}
function taskStorageSource(
  input: LegacyMediaExecutionInput,
  canonical: DocumentSnapshot,
  before: Timestamp
): LegacyOriginalStorageSource | undefined {
  if ('youtubeUrl' in input.payload) return undefined;
  const object = input.originalStorageSource;
  if (!object) return undefined;
  const allowed = [
    `sermons/${input.payload.id}`,
    `processed-sermons/${input.payload.id}`,
    `intro-outro-sermons/${input.payload.id}`,
    canonical.get('audioArtifacts.sourcePath'),
    canonical.get('audioArtifacts.processedPath'),
    canonical.get('audioArtifacts.finalPath'),
  ];
  if (
    !input.configuredSourceBucket ||
    object.bucket !== input.configuredSourceBucket ||
    object.path !== input.payload.storageFilePath ||
    !allowed.includes(object.path) ||
    object.kind !== 'storage' ||
    Object.keys(object).sort().join(',') !== 'bucket,generation,kind,path,timeCreated' ||
    !/^[1-9][0-9]{0,30}$/.test(object.generation) ||
    !Number.isSafeInteger(Number(object.generation)) ||
    !beforeOrEqual(storageCreationUpperBound(object.timeCreated) as Timestamp, before)
  )
    reject('The task source object does not match its original server admission.');
  return object;
}
export interface LegacyMediaExecutionInput {
  firestore: Firestore;
  projectId: string;
  payload: AddIntroOutroInputType;
  taskId?: string;
  operation?: 'dispatch' | 'execute';
  /** Server callback settlement, never a client-supplied success flag. */
  hasUncertainOutcome?: () => boolean;
  /** Actual active caller lease; never an arbitrary client request ID. */
  sourceLeaseId?: string;
  existingAdmissionOnly?: true;
  originalStorageSource?: LegacyOriginalStorageSource;
  configuredSourceBucket?: string;
  originalSourceOwnerUid?: string;
}

/** New admissions are recorded before dispatch, including requests deferred behind a running task. */
export async function prepareLegacyMediaAdmission(input: LegacyMediaExecutionInput): Promise<void> {
  const { firestore: db, payload } = input;
  if (!input.projectId || !/^[A-Za-z0-9_-]+$/.test(payload.id))
    reject('A canonical project and sermon ID are required.');
  await db.runTransaction(async (tx) => {
    const [control, state, usage, proof, source, canonical, originalAuthority, taskSourceAuthority] = await Promise.all(
      [
        tx.get(db.doc('_control/temporalRelease')),
        tx.get(db.doc('_control/temporalReleaseState')),
        tx.get(db.doc('_control/temporalProviderUsage')),
        tx.get(db.doc(`legacyMediaAdmissions/${legacyMediaAdmissionId(payload)}`)),
        input.sourceLeaseId ? tx.get(db.doc(`legacyAdmissionLeases/${input.sourceLeaseId}`)) : Promise.resolve(null),
        tx.get(db.doc(`sermons/${payload.id}`)),
        tx.get(db.doc(`legacyMediaSourceAdmissions/${legacyMediaAdmissionId(payload)}`)),
        tx.get(db.doc(`legacyMediaTaskSourceAdmissions/${legacyMediaAdmissionId(payload)}`)),
      ]
    );
    if (
      !canonical.exists ||
      !timestamp(canonical.createTime) ||
      canonical.get('activeDurableJobs.audio') ||
      canonical.get('activeDurableJobs.upload')
    )
      reject('Canonical sermon is absent or owned by a durable task.');
    if (typeof canonical.get('uploaderId') !== 'string' || !canonical.get('uploaderId'))
      reject('Canonical source owner is required.');
    if (input.existingAdmissionOnly && !proof.exists) reject('Existing immutable task admission is required.');
    let original = validateOriginalSource(originalAuthority, input, canonical, control);
    let newAuthority: ReturnType<typeof originalSourceRecord> | undefined;
    if (input.sourceLeaseId) {
      if (
        !source?.exists ||
        source.get('schemaVersion') !== 1 ||
        source.get('state') !== 'active' ||
        source.get('effectsStarted') !== true ||
        source.get('domain') !== 'media' ||
        source.get('projectId') !== input.projectId ||
        source.get('leaseId') !== input.sourceLeaseId ||
        source.get('actorUid') !== 'system:firebase-event' ||
        source.get('operation') !== 'sermonaudiocreatetrigger' ||
        source.get('legacySourceSermonId') !== payload.id ||
        source.get('legacySourceOwnerUid') !== canonical.get('uploaderId') ||
        canonical.get('status.audioStatus') !== 'PENDING'
      )
        reject('An actual tracked initial source lease is required.');
      newAuthority = originalSourceRecord(
        { ...input, originalSourceOwnerUid: source.get('legacySourceOwnerUid') },
        canonical
      );
      const cutoff = control.get('legacyAdmissionCutoff');
      if (cutoff && (!timestamp(cutoff) || !beforeOrEqual(canonical.createTime, cutoff)))
        reject('Source was created after the cutoff.');
      if (originalAuthority.exists && JSON.stringify(newAuthority.source) !== JSON.stringify(original))
        reject('The original source generation cannot be replaced.');
      original = newAuthority.source;
    }
    const accepted = acceptedTaskPending(proof, input, canonical, control);
    assertMediaWindow(control, state, Boolean(original) || accepted);
    if (
      usage.get('releaseId') === control.get('releaseId') &&
      ['building', 'ready'].includes(usage.get('status')) &&
      control.get('admission') === 'paused'
    )
      reject('Provider usage verification freezes legacy media.');
    if (
      !proof.exists &&
      control.exists &&
      (control.get('admission') !== 'open' || control.get('domains.media.admission') !== 'open') &&
      !newAuthority
    )
      reject('New legacy media admissions are paused.');
    if (proof.exists) assertProof(proof, payload, control, input.projectId);
    const captured = taskStorageSource(input, canonical, proof.createTime ?? control.readTime);
    if (
      captured &&
      taskSourceAuthority.exists &&
      (taskSourceAuthority.get('payloadFingerprint') !== fingerprint(payload) ||
        JSON.stringify(taskSourceAuthority.get('source')) !== JSON.stringify(captured))
    )
      reject('The original task source generation cannot be replaced.');
    if (captured && !taskSourceAuthority.exists)
      tx.create(taskSourceAuthority.ref, {
        schemaVersion: 1,
        projectId: input.projectId,
        admissionId: proof.ref.id,
        payloadFingerprint: fingerprint(payload),
        sermonCreateTime: canonical.createTime,
        uploaderId: canonical.get('uploaderId'),
        source: captured,
      });
    if (newAuthority && !originalAuthority.exists)
      tx.create(originalAuthority.ref, { ...newAuthority, sourceLeaseId: input.sourceLeaseId });
    if (proof.exists) return;
    const admittedBefore: Timestamp | FieldValue = newAuthority ? canonical.createTime : FieldValue.serverTimestamp();
    tx.create(proof.ref, {
      schemaVersion: 1,
      projectId: input.projectId,
      sermonId: payload.id,
      requestVersion: computeProcessAudioRequestVersion(payload),
      payloadFingerprint: fingerprint(payload),
      admittedBefore,
      sermonCreateTime: canonical.createTime,
      uploaderId: canonical.get('uploaderId'),
      canonicalYouTubeUrl: canonical.get('youtubeUrl')?.trim() || null,
    });
  });
}

/** Same journal/schema used by the permanent release drain; uncertain effects remain visible. */
export async function withLegacyMediaExecution<T>(
  input: LegacyMediaExecutionInput,
  callback: (originalSource?: LegacyOriginalSource) => Promise<T>
): Promise<T> {
  const { firestore: db, payload, projectId } = input;
  if (!projectId || !/^[A-Za-z0-9_-]+$/.test(payload.id)) reject('A canonical project and sermon ID are required.');
  const leaseId = `legacy-${randomUUID()}`;
  const lease = db.doc(`legacyAdmissionLeases/${leaseId}`);
  const proofRef = db.doc(`legacyMediaAdmissions/${legacyMediaAdmissionId(payload)}`);
  const admittedSource = await db.runTransaction(async (tx) => {
    const [control, state, usage, proof, task, canonical, originalAuthority, taskSourceAuthority] = await Promise.all([
      tx.get(db.doc('_control/temporalRelease')),
      tx.get(db.doc('_control/temporalReleaseState')),
      tx.get(db.doc('_control/temporalProviderUsage')),
      tx.get(proofRef),
      input.taskId ? tx.get(db.doc(`legacyMediaTasks/${hash(input.taskId)}`)) : Promise.resolve(null),
      tx.get(db.doc(`sermons/${payload.id}`)),
      tx.get(db.doc(`legacyMediaSourceAdmissions/${legacyMediaAdmissionId(payload)}`)),
      tx.get(db.doc(`legacyMediaTaskSourceAdmissions/${legacyMediaAdmissionId(payload)}`)),
    ]);
    const original = validateOriginalSource(originalAuthority, input, canonical, control);
    const accepted = acceptedTaskPending(proof, input, canonical, control);
    assertMediaWindow(control, state, Boolean(original) || accepted);
    assertProof(proof, payload, control, input.projectId);
    const incarnation = proof.get('sermonCreateTime');
    if (
      !canonical.exists ||
      !timestamp(canonical.createTime) ||
      !timestamp(incarnation) ||
      !beforeOrEqual(canonical.createTime, incarnation) ||
      !beforeOrEqual(incarnation, canonical.createTime) ||
      canonical.get('activeDurableJobs.audio') ||
      canonical.get('activeDurableJobs.upload')
    )
      reject('Canonical sermon incarnation or ownership changed.');
    if (
      usage.get('releaseId') === control.get('releaseId') &&
      ['building', 'ready'].includes(usage.get('status')) &&
      control.get('admission') === 'paused'
    )
      reject('Provider usage verification freezes legacy media.');
    if (
      input.operation === 'execute' &&
      (!input.taskId ||
        !task?.exists ||
        task.get('taskId') !== input.taskId ||
        task.get('admissionId') !== proofRef.id ||
        task.get('payloadFingerprint') !== fingerprint(payload))
    )
      reject('The dispatched task does not match its immutable admission.');
    if (
      task?.exists &&
      (task.get('taskId') !== input.taskId ||
        task.get('admissionId') !== proofRef.id ||
        task.get('payloadFingerprint') !== fingerprint(payload))
    )
      reject('Task ID is already bound to another admission.');
    const now = Date.now(); // Diagnostic only; never authorizes cutoff or ownership.
    tx.create(lease, {
      schemaVersion: 1,
      leaseId,
      projectId,
      domain: 'media',
      actorUid: 'system:process-audio',
      operation: input.operation === 'execute' ? 'native-audio-task' : 'legacy-audio-dispatch',
      state: 'active',
      acquiredAt: now,
      heartbeatAt: now,
      diagnosticExpiresAt: now + 60000,
      releaseRevision: Number(control.get('revision') ?? 0),
      effectsStarted: true,
    });
    if (input.taskId && !task?.exists && input.operation !== 'execute') {
      const taskRef = db.doc(`legacyMediaTasks/${hash(input.taskId)}`);
      // Every task binding is immutable. Same request retries may reuse the exact task ID.
      tx.create(taskRef, {
        schemaVersion: 1,
        taskId: input.taskId,
        admissionId: proofRef.id,
        payloadFingerprint: fingerprint(payload),
      });
    }
    let pinned = original;
    if (taskSourceAuthority.exists) {
      if (
        taskSourceAuthority.get('schemaVersion') !== 1 ||
        taskSourceAuthority.get('projectId') !== projectId ||
        taskSourceAuthority.get('admissionId') !== proof.id ||
        taskSourceAuthority.get('payloadFingerprint') !== fingerprint(payload) ||
        !canonical.createTime?.isEqual(taskSourceAuthority.get('sermonCreateTime')) ||
        taskSourceAuthority.get('uploaderId') !== canonical.get('uploaderId')
      )
        reject('Immutable task source authority changed.');
      const stored = taskSourceAuthority.get('source') as LegacyOriginalStorageSource;
      const source = taskStorageSource(
        { ...input, originalStorageSource: stored, configuredSourceBucket: stored?.bucket },
        canonical,
        proof.createTime!
      );
      if (original && JSON.stringify(source) !== JSON.stringify(original)) reject('Original source bindings disagree.');
      pinned = source;
    }
    const cutoff = control.get('legacyAdmissionCutoff');
    const grace = state.get('legacySettlingGraceSeconds');
    const expired =
      timestamp(cutoff) &&
      (control.readTime.seconds > cutoff.seconds + grace ||
        (control.readTime.seconds === cutoff.seconds + grace && control.readTime.nanoseconds >= cutoff.nanoseconds));
    if (expired && 'storageFilePath' in payload && !pinned)
      reject('Original task storage generation must be bound before execution.');
    return pinned;
  });
  let failed = false;
  const timer = setInterval(() => {
    void db
      .runTransaction(async (tx) => {
        const current = await tx.get(lease);
        if (current.get('state') !== 'active') reject('Legacy execution lease changed.');
        tx.update(lease, { heartbeatAt: Date.now(), diagnosticExpiresAt: Date.now() + 60000 });
      })
      .catch(() => {
        /* Never expiry-steal or hide an uncertain active lease. */
      });
  }, 15000);
  timer.unref();
  try {
    const result = await callback(admittedSource);
    if (input.hasUncertainOutcome?.()) throw new Error('Legacy media effects were not fully settled.');
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    clearInterval(timer);
    await db.runTransaction(async (tx) => {
      const current = await tx.get(lease);
      if (current.get('state') !== 'active') reject('Legacy execution lease changed before settlement.');
      tx.update(lease, {
        state: failed ? 'needs_attention' : 'completed',
        outcome: failed ? 'unknown' : 'succeeded',
        completedAt: Date.now(),
        heartbeatAt: Date.now(),
        ...(failed ? { errorCode: 'NATIVE_MEDIA_EXECUTION_FAILED' } : {}),
      });
    });
  }
}
